// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// SPDX-License-Identifier: MPL-2.0
//
// Portions adapted from NectarLink, core/nectarlink-core/src/localsend.rs and transfer.rs
// (https://github.com/thtbee/nectarlink, commit a1a7d885, MPL-2.0),
// Copyright (C) 2026 The NectarLink contributors: the self-signed certificate written as DER, the
// certificate fingerprint check on every connection, the refusal to move a known HTTPS device to
// HTTP, the upload session rules (one token per file, the body exactly the offered size, only the
// sender cancels) and the file name rules. Rewritten in Kotlin by the TwinDesk authors,
// Copyright (C) 2026 inukaasith; changes from the original: no plain HTTP, every discovered device
// is checked over TLS before it is listed as verified, the hash is taken while the bytes arrive, our
// certificate is shown on the connections we make and a sender is the certificate it showed.
//
// The protocol is LocalSend Protocol v2.2 (https://github.com/localsend/protocol, MIT, Copyright (c)
// 2022-2024 Tien Do Nam). No LocalSend code is used. TwinDesk is not affiliated with LocalSend.
//
// The transport core for files with LocalSend-compatible apps, the same as shared/localsend/core.js
// on the computers. Nothing of Android is used here (java.net, javax.net.ssl, org.json), so it also
// runs on a plain JVM; LocalSend.kt is the phone around it (the switch, Downloads, the question).
//
// What it does not speak, and says so (LsPeer.why): "plain" a device with encryption off (HTTP),
// "v1" protocol v1, "newer" a major version after 2. Not here: the browser download API (section 5)
// and the address scan of section 3.2 (a device is added by its address instead: probe()).
package com.twindesk.android

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.BindException
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager

class LsException(val code: String, message: String = code) : IOException(message)

// A device as it says it is. verified: its certificate was seen at that address and is that fingerprint.
data class LsPeer(
    val id: String, val alias: String, val deviceModel: String, val deviceType: String, val fingerprint: String,
    val ip: String, val port: Int, val protocol: String, val version: String, val why: String,
    val verified: Boolean = false, val seen: Long = System.currentTimeMillis(),
) {
    val supported: Boolean get() = why.isEmpty()
}

// What a device asks to send. fingerprint: the certificate it showed on that connection ("" when it
// showed none: then verified is false and nobody knows which device it is). known: the person here
// took files from that certificate's device, or sent it files, before. imitates: its name is that
// of another device, a known one or one proven on this network. The name is its own word always.
data class LsOffer(
    val id: String, val ip: String, val alias: String, val deviceModel: String, val fingerprint: String, val known: Boolean,
    val names: List<String>, val files: Int, val total: Long, val text: String, val at: Long = System.currentTimeMillis(),
    val verified: Boolean = false, val imitates: Boolean = false,
)

// state: waiting (for the other person) | running | done | declined | cancelled | failed (error says why).
data class LsTransfer(
    val id: String, val incoming: Boolean, val peer: String, val ip: String, val names: List<String>, val files: Int,
    val total: Long, val done: Long, val state: String, val error: String = "", val arrived: Int = 0,
    val saved: List<String> = emptyList(), val at: Long = System.currentTimeMillis(),
) {
    val live: Boolean get() = state == "waiting" || state == "running"
}

// One file to send: its name (folders with "/"), its size and how to read it.
class LsSource(val name: String, val size: Long, val type: String, val sha256: String = "", val open: () -> InputStream)

// Where accepted files go. The names it gets are already safe (Ls.splitName).
interface LsSink {
    fun free(): Long // bytes free there, or -1 when it can't be known
    fun open(session: String, folder: List<String>, name: String, type: String): LsOut
}

interface LsOut {
    val out: OutputStream
    fun commit(): String // the file is whole: keep it; → where it is
    fun discard()
}

interface LsEvents {
    fun changed()
    fun offer(o: LsOffer)
    fun offerEnd(id: String, accepted: Boolean, why: String)
    fun transfer(t: LsTransfer)
}

class LsOptions(
    var port: Int = Ls.PORT, var bind: String? = null, var multicast: Boolean = true,
    var deviceModel: String = "", var deviceType: String = "mobile",
    var approvalMs: Long = 60_000, var cooldownMs: Long = 10_000,
    var allow: (InetAddress) -> Boolean = Ls::isLocalAddress,
    var allowLocal: (InetAddress) -> Boolean = Ls::isLocalAddress, // which of this device's own addresses take connections
    var log: (String) -> Unit = {}, // what went wrong, for the app's log: never file contents or tokens
)

object Ls {
    const val PORT = 53317
    const val GROUP = "224.0.0.167"
    const val VERSION = "2.2"
    const val API = "/api/localsend/v2"

    const val ANSWER_WAIT_MS = 120_000 // how long we wait for the other side's person
    const val CONNECT_MS = 6000
    const val IO_MS = 30_000 // no byte either way for this long: the connection is dropped
    const val SESSION_IDLE_MS = 10 * 60_000L
    const val ANNOUNCE_S = 30L
    const val PEER_TTL_MS = 150_000L
    const val VERIFY_EVERY_MS = 5000L
    const val PROGRESS_MS = 150L
    const val MAX_JSON = 4 * 1024 * 1024
    const val MAX_SMALL_JSON = 64 * 1024
    const val MAX_FILES = 5000
    const val MAX_DEPTH = 32
    const val MAX_NAME_BYTES = 200
    const val MAX_PEERS = 64
    const val MAX_PENDING = 3
    const val MAX_OFFERING = 2 // per address: offers still being read
    const val MAX_KNOWN = 256 // devices remembered as ones the person here exchanged files with
    const val MAX_SESSIONS = 4
    const val MAX_CONNECTIONS = 64
    const val MAX_CONNECTIONS_PER_IP = 12
    const val MAX_VERIFYING = 8
    const val SPACE_MARGIN = 64L * 1024 * 1024
    val DEVICE_TYPES = listOf("mobile", "desktop", "web", "headless", "server")

    private val random = SecureRandom()
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f]")
    // Characters that reorder or hide text: with them a name reads as another one ("fdp.exe" shown
    // as "exe.pdf", or a name that only looks like a known device's).
    private val HIDDEN = Regex("[\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]")
    private val UNSEEN = Regex("[\\p{C}\\p{Z}]")
    private val FORBIDDEN = Regex("[<>:\"|?*]")
    private val RESERVED = Regex("^(CON|PRN|AUX|NUL|COM\\d|LPT\\d)$")
    private val FP = Regex("^[0-9a-fA-F]{64}$")

    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    fun fingerprintOf(der: ByteArray): String = hex(sha256(der))
    fun isFp(s: String?): Boolean = s != null && FP.matches(s)
    fun token(): String = ByteArray(18).also { random.nextBytes(it) }.let(::hex)
    fun clip(v: String?, n: Int): String = (v ?: "").replace(CONTROL, " ").replace(HIDDEN, "").trim().take(n)
    // What two names that read the same have in common: no case, no spaces, nothing invisible.
    fun skeleton(v: String?): String = java.text.Normalizer.normalize(v ?: "", java.text.Normalizer.Form.NFKC).replace(UNSEEN, "").lowercase(Locale.ROOT)

    // Only the networks LocalSend is for: private, link-local, carrier NAT (a tailnet) and this device.
    fun isLocalAddress(addr: InetAddress): Boolean {
        val b = (addr as? Inet4Address)?.address ?: return false
        val a = b[0].toInt() and 0xff
        val c = b[1].toInt() and 0xff
        return a == 10 || a == 127 || (a == 172 && c in 16..31) || (a == 192 && c == 168) || (a == 169 && c == 254) || (a == 100 && c in 64..127)
    }

    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8).size

    // One path segment as it may be stored on a phone or a computer.
    fun cleanSegment(raw: String): String {
        var s = java.text.Normalizer.normalize(raw, java.text.Normalizer.Form.NFC).replace(CONTROL, "_").replace(HIDDEN, "_").replace(FORBIDDEN, "_").replace('/', '_').trim().trimEnd('.', ' ')
        if (s.isEmpty() || s == "." || s == "..") return ""
        if (utf8(s) > MAX_NAME_BYTES) { // the end (the extension) is what's kept
            val dot = s.lastIndexOf('.')
            val ext = if (dot > 0 && s.length - dot <= 16) s.substring(dot) else ""
            var stem = s.substring(0, s.length - ext.length)
            while (stem.isNotEmpty() && utf8(stem + ext) > MAX_NAME_BYTES) stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1))
            s = (stem + ext).trimEnd('.', ' ').ifEmpty { "file" }
        }
        if (RESERVED.matches(s.substringBefore('.').trim().uppercase(Locale.ROOT))) s = "_$s"
        return s
    }

    // A LocalSend fileName ("holiday/day 1/a.jpg", or with backslashes) → its folders and its name.
    // Never a path that leaves the folder: ".", ".." and empty segments are gone.
    fun splitName(raw: String?): Pair<List<String>, String> {
        val parts = (raw ?: "").replace('\\', '/').split('/').map(::cleanSegment).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return emptyList<String>() to "file"
        return parts.dropLast(1).take(MAX_DEPTH) to parts.last()
    }

    // What a version string means to us: "" (we speak it), or why not.
    fun versionWhy(v: String): String = when (v.substringBefore('.').toIntOrNull()) {
        2 -> ""
        1 -> "v1"
        else -> "newer"
    }

    fun peerId(fingerprint: String, ip: String, port: Int): String =
        hex(sha256("twindesk-localsend:v2:${fingerprint.ifEmpty { "$ip:$port" }}".toByteArray(Charsets.UTF_8))).take(32)

    fun str(o: JSONObject, k: String): String = if (o.isNull(k)) "" else o.optString(k, "")

    // What a device says about itself (an announce, /register, /info, prepare-upload's info) as a
    // peer, or null when it isn't usable. Nothing here is proven: `verified` is set by the TLS check.
    fun peerFrom(dto: JSONObject?, ip: String, fallbackPort: Int = PORT): LsPeer? {
        if (dto == null) return null
        val alias = clip(str(dto, "alias"), 64)
        if (alias.isEmpty()) return null
        val protocol = if (str(dto, "protocol").lowercase(Locale.ROOT) == "http") "http" else "https"
        val port = dto.optInt("port", 0).takeIf { it in 1..65535 } ?: fallbackPort
        // Over HTTPS the fingerprint is the certificate's hash; over HTTP it's any string the device made up.
        val said = str(dto, "fingerprint")
        if (protocol == "https" && !isFp(said)) return null
        val fingerprint = if (protocol == "https") said.lowercase(Locale.ROOT) else clip(said, 128)
        val version = clip(str(dto, "version"), 16).ifEmpty { "2.0" }
        val why = if (protocol == "http") "plain" else versionWhy(version)
        return LsPeer(peerId(fingerprint, ip, port), alias, clip(str(dto, "deviceModel"), 64), str(dto, "deviceType").takeIf { it in DEVICE_TYPES } ?: "desktop", fingerprint, ip, port, protocol, version, why)
    }

    // Whether `update` would move a device known to speak HTTPS to plain HTTP. An unauthenticated
    // announce claiming its name mustn't do that.
    fun downgrades(known: LsPeer?, update: LsPeer): Boolean = update.protocol == "http" && known != null && known.protocol == "https"

    fun parse(body: ByteArray): JSONObject? = runCatching { JSONObject(String(body, Charsets.UTF_8)) }.getOrNull()
}

// ---- The identity: a self-signed certificate; its SHA-256 is the LocalSend fingerprint ----

class LsIdentity(val key: PrivateKey, val cert: X509Certificate) {
    val fingerprint: String = Ls.fingerprintOf(cert.encoded)

    companion object {
        private fun len(n: Int): ByteArray = when {
            n < 0x80 -> byteArrayOf(n.toByte())
            n <= 0xff -> byteArrayOf(0x81.toByte(), n.toByte())
            else -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
        }
        private fun tlv(tag: Int, body: ByteArray): ByteArray = byteArrayOf(tag.toByte()) + len(body.size) + body
        private fun seq(vararg items: ByteArray): ByteArray = tlv(0x30, items.fold(ByteArray(0)) { a, b -> a + b })
        private fun utc(ms: Long): ByteArray =
            tlv(0x17, SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms)).toByteArray(Charsets.US_ASCII))
        private fun certOf(der: ByteArray) = CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as X509Certificate

        // ECDSA P-256, X.509 v3, CN=TwinDesk, ten years.
        fun make(now: Long = System.currentTimeMillis()): LsIdentity {
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            val serial = ByteArray(16).also { SecureRandom().nextBytes(it) }
            serial[0] = (serial[0].toInt() and 0x7f).toByte()
            if (serial[0].toInt() == 0) serial[0] = 1
            val sigAlg = seq(tlv(0x06, byteArrayOf(0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x04, 0x03, 0x02))) // ecdsa-with-SHA256
            val name = seq(tlv(0x31, seq(tlv(0x06, byteArrayOf(0x55, 0x04, 0x03)), tlv(0x0c, "TwinDesk".toByteArray(Charsets.UTF_8))))) // CN
            val day = 24 * 3600 * 1000L
            val validity = seq(utc(now - day), utc(now + 3650 * day))
            val tbs = seq(tlv(0xa0, tlv(0x02, byteArrayOf(2))), tlv(0x02, serial), sigAlg, name, validity, name, pair.public.encoded)
            val sig = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(tbs); sign() }
            return LsIdentity(pair.private, certOf(seq(tbs, sigAlg, tlv(0x03, byteArrayOf(0) + sig))))
        }

        // The saved identity (dir/localsend-identity.json, the app's own files), a new one when it's
        // missing, broken or within a month of running out. A new one is a new device to the others.
        fun load(dir: File): LsIdentity {
            val file = File(dir, "localsend-identity.json")
            runCatching {
                val o = JSONObject(file.readText())
                val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Ls.unhex(o.getString("key"))))
                val cert = certOf(Ls.unhex(o.getString("cert")))
                // The key is the certificate's: what one signs, the other checks.
                val probe = ByteArray(32).also { SecureRandom().nextBytes(it) }
                val sig = Signature.getInstance("SHA256withECDSA").run { initSign(key); update(probe); sign() }
                val ok = Signature.getInstance("SHA256withECDSA").run { initVerify(cert.publicKey); update(probe); verify(sig) }
                if (ok && cert.notAfter.time - System.currentTimeMillis() > 30L * 24 * 3600 * 1000) return LsIdentity(key, cert)
            }
            val id = make()
            runCatching {
                dir.mkdirs()
                val tmp = File(dir, "localsend-identity.json.tmp")
                tmp.writeText(JSONObject().put("key", Ls.hex(id.key.encoded)).put("cert", Ls.hex(id.cert.encoded)).toString())
                tmp.setReadable(false, false); tmp.setWritable(false, false)
                tmp.setReadable(true, true); tmp.setWritable(true, true)
                if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
            }
            return id
        }
    }
}

// ---- HTTP, as little of it as the protocol needs ----

private fun readLine(inp: InputStream, max: Int): String? {
    val b = ByteArrayOutputStream()
    while (true) {
        val c = inp.read()
        if (c < 0) return if (b.size() == 0) null else throw EOFException()
        if (c == '\n'.code) break
        if (b.size() >= max) throw IOException("line too long")
        b.write(c)
    }
    return b.toString("ISO-8859-1").trimEnd('\r')
}

// The first line and the headers (names in lower case), or null when nothing came.
private fun readHead(inp: InputStream): Pair<String, Map<String, String>>? {
    val first = readLine(inp, 8192) ?: return null
    val headers = HashMap<String, String>()
    var total = first.length
    while (true) {
        val line = readLine(inp, 8192) ?: throw EOFException()
        if (line.isEmpty()) break
        total += line.length
        if (total > 32768 || headers.size > 100) throw IOException("headers")
        val i = line.indexOf(':')
        if (i > 0) headers[line.substring(0, i).trim().lowercase(Locale.ROOT)] = line.substring(i + 1).trim()
    }
    return first to headers
}

private class LimitedIn(private val src: InputStream, private var left: Long) : InputStream() {
    override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (left <= 0) return -1
        val n = src.read(b, off, minOf(len.toLong(), left).toInt())
        if (n < 0) throw EOFException("the body ended early")
        left -= n
        return n
    }
}

private class ChunkedIn(private val src: InputStream) : InputStream() {
    private var left = 0L
    private var done = false
    override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (done) return -1
        if (left == 0L) {
            val size = (readLine(src, 1024) ?: throw EOFException()).substringBefore(';').trim().toLongOrNull(16)
            if (size == null || size < 0) throw IOException("chunk")
            if (size == 0L) {
                while (true) { val t = readLine(src, 8192) ?: break; if (t.isEmpty()) break }
                done = true
                return -1
            }
            left = size
        }
        val n = src.read(b, off, minOf(len.toLong(), left).toInt())
        if (n < 0) throw EOFException("the body ended early")
        left -= n
        if (left == 0L) readLine(src, 16) // the line end after a chunk
        return n
    }
}

private fun bodyOf(inp: InputStream, headers: Map<String, String>): InputStream =
    if (headers["transfer-encoding"]?.lowercase(Locale.ROOT)?.contains("chunked") == true) ChunkedIn(inp)
    else LimitedIn(inp, headers["content-length"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0)

private fun readAll(inp: InputStream, max: Int): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(16384)
    while (true) {
        val n = inp.read(buf)
        if (n < 0) break
        if (out.size() + n > max) throw LsException("big", "too long")
        out.write(buf, 0, n)
    }
    return out.toByteArray()
}

private fun queryOf(target: String): Map<String, String> {
    val q = target.substringAfter('?', "")
    if (q.isEmpty()) return emptyMap()
    return q.split('&').mapNotNull { kv ->
        val k = kv.substringBefore('=')
        runCatching { URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(kv.substringAfter('=', ""), "UTF-8") }.getOrNull()
    }.toMap()
}

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

private val REASONS = mapOf(200 to "OK", 400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden", 404 to "Not Found", 409 to "Conflict", 422 to "Unprocessable Entity", 429 to "Too Many Requests", 500 to "Internal Server Error", 507 to "Insufficient Storage")

private class HttpRes(val status: Int, val body: ByteArray, val fingerprint: String)

// ---- The node ----

class LocalSendCore(
    private val dir: File, private val alias: () -> String, private val sink: LsSink, private val events: LsEvents,
    private val opts: LsOptions = LsOptions(),
) {
    val identity = LsIdentity.load(dir)
    val fingerprint: String get() = identity.fingerprint
    @Volatile var running = false; private set
    @Volatile var receiving = false; private set // our server has the port (else another app here receives)
    @Volatile var port = opts.port; private set
    @Volatile var error = ""; private set

    private class InFile(val id: String, val folder: List<String>, val name: String, val size: Long, val type: String, val sha256: String, val text: String) {
        val token = Ls.token()
        var state = "waiting" // waiting | uploading | done
    }
    private class Session(val id: String, val ip: String, val files: Map<String, InFile>, val alias: String, val names: List<String>, val total: Long) {
        val done = AtomicLong(0)
        val saved = ArrayList<String>()
        val sockets = HashSet<Socket>()
        @Volatile var cancelled = false
        @Volatile var active = System.currentTimeMillis()
        @Volatile var last = 0L
        val at = System.currentTimeMillis()
        val transferId = "in-$id"
    }
    private class Pending(val offer: LsOffer) {
        val latch = CountDownLatch(1)
        @Volatile var accepted = false
        @Volatile var why = ""
    }
    private class Out(val id: String, val peer: LsPeer, val names: List<String>, val files: Int, @Volatile var total: Long) {
        val done = AtomicLong(0)
        @Volatile var state = "waiting"
        @Volatile var cancelled = false
        @Volatile var socket: Socket? = null
        @Volatile var last = 0L
        val at = System.currentTimeMillis()
    }

    private val lock = Any()
    private val peers = LinkedHashMap<String, LsPeer>()
    private val offers = LinkedHashMap<String, Pending>()
    private val sessions = LinkedHashMap<String, Session>()
    private val outs = LinkedHashMap<String, Out>()
    private val verifiedAt = HashMap<String, Long>()
    private val cooldown = HashMap<String, Long>()
    private val offering = HashMap<String, Int>() // address -> offers of it still being read
    private val knownBefore = LinkedHashMap<String, Pair<String, Long>>() // fingerprint -> its name and when: exchanged files with before
    private val life = Any() // a start and a stop, one after the other
    private val verifying = AtomicInteger(0)
    private val connections = AtomicInteger(0)
    private val perIp = HashMap<String, Int>() // address -> its open connections
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "td-localsend").apply { isDaemon = true } }
    private var ticker: ScheduledExecutorService? = null
    private var server: SSLServerSocket? = null
    private var udp: MulticastSocket? = null
    private val group: InetAddress by lazy { InetAddress.getByName(Ls.GROUP) }

    fun info(announce: Boolean? = null): JSONObject = JSONObject()
        .put("alias", Ls.clip(alias(), 64).ifEmpty { "TwinDesk" }).put("version", Ls.VERSION)
        .put("deviceModel", opts.deviceModel).put("deviceType", opts.deviceType)
        .put("fingerprint", fingerprint).put("port", port).put("protocol", "https").put("download", false)
        .also { if (announce != null) it.put("announce", announce) }

    fun peers(): List<LsPeer> = synchronized(lock) { peers.values.sortedWith(compareBy({ it.alias.lowercase(Locale.ROOT) }, { it.ip })) }
    fun offers(): List<LsOffer> = synchronized(lock) { offers.values.map { it.offer } }

    // ---- start and stop ----

    // Opens the sockets: not on the main thread. A stop() that comes meanwhile waits and then closes
    // what was opened (it used to find nothing to close yet, and the port stayed open).
    fun start() {
        synchronized(life) {
            synchronized(lock) {
                if (running) return
                running = true
                error = ""
            }
            listen()
            if (opts.multicast) openUdp()
            ticker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "td-localsend-tick").apply { isDaemon = true } }.also { t ->
                t.scheduleWithFixedDelay({ runCatching { expire(); announce() } }, Ls.ANNOUNCE_S, Ls.ANNOUNCE_S, TimeUnit.SECONDS)
                for (ms in listOf(100L, 500L, 2000L)) t.schedule({ runCatching { announce() } }, ms, TimeUnit.MILLISECONDS) // one multicast packet is easily lost
            }
        }
        events.changed()
    }

    fun stop() {
        synchronized(life) {
            synchronized(lock) {
                if (!running) return
                running = false
                receiving = false
            }
            ticker?.shutdownNow()
            ticker = null
            runCatching { udp?.close() }
            udp = null
            runCatching { server?.close() }
            server = null
        }
        for (id in synchronized(lock) { offers.keys.toList() }) answer(id, false)
        for (s in synchronized(lock) { sessions.values.toList() }) endSession(s, "cancelled")
        for (id in synchronized(lock) { outs.keys.toList() }) cancel(id)
        synchronized(lock) { peers.clear() }
        events.changed()
    }

    // Our certificate: as the server, and on the connections we make (a device that asks who is
    // sending gets it; LocalSend 1.17 and later take nothing from a sender without one).
    private val keys = object : X509ExtendedKeyManager() {
        private val chain = arrayOf(identity.cert)
        private fun ours(keyType: String?) = keyType == null || keyType == "EC" || keyType == "EC_EC" || keyType == "ECDSA" // ours is an EC key
        private fun forType(keyType: String?) = if (ours(keyType)) "ls" else null
        private fun forTypes(keyTypes: Array<out String>?) = if (keyTypes == null || keyTypes.any(::ours)) "ls" else null
        override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?) = forType(keyType)
        override fun chooseEngineServerAlias(keyType: String?, issuers: Array<out Principal>?, engine: SSLEngine?) = forType(keyType)
        override fun chooseClientAlias(keyTypes: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = forTypes(keyTypes)
        override fun chooseEngineClientAlias(keyTypes: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = forTypes(keyTypes)
        override fun getCertificateChain(alias: String?) = chain
        override fun getPrivateKey(alias: String?) = identity.key
        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf("ls")
        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf("ls")
    }

    private fun serverContext(): SSLContext {
        // A sender is asked for its certificate. It is self-signed by design, so there is no chain to
        // check: TLS has checked that the sender holds its key, and which device it is, is its hash
        // (serve). That says who is asking, never that it is to be trusted.
        val anyone = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) { if (chain.isNullOrEmpty()) throw CertificateException("no certificate") }
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        return SSLContext.getInstance("TLS").apply { init(arrayOf(keys), arrayOf(anyone), null) }
    }

    private fun listen() {
        try {
            val ss = serverContext().serverSocketFactory.createServerSocket() as SSLServerSocket
            ss.reuseAddress = true
            ss.wantClientAuth = true // asked for, not demanded: a sender without one is heard as a device nobody can name
            ss.bind(opts.bind?.let { InetSocketAddress(InetAddress.getByName(it), opts.port) } ?: InetSocketAddress(opts.port), 50)
            server = ss
            port = ss.localPort
            receiving = true
            Thread({
                while (running) {
                    val s = try { ss.accept() as SSLSocket } catch (e: IOException) { break }
                    // The port is open on every network this device is on; a connection that came in on
                    // an address that isn't a local one (a public one) is closed before a byte of it is read.
                    if (s.localAddress?.let(opts.allowLocal) != true) { runCatching { s.close() }; continue }
                    // One address can't hold every connection (and so keep everyone else out).
                    val from = s.inetAddress?.hostAddress ?: ""
                    val room = synchronized(perIp) {
                        val n = perIp[from] ?: 0
                        if (connections.get() >= Ls.MAX_CONNECTIONS || n >= Ls.MAX_CONNECTIONS_PER_IP) false else { perIp[from] = n + 1; true }
                    }
                    if (!room) { runCatching { s.close() }; continue }
                    connections.incrementAndGet()
                    pool.execute {
                        try { serve(s) } finally {
                            connections.decrementAndGet()
                            synchronized(perIp) { val n = (perIp[from] ?: 1) - 1; if (n <= 0) perIp.remove(from) else perIp[from] = n }
                        }
                    }
                }
            }, "td-localsend-accept").apply { isDaemon = true }.start()
        } catch (e: IOException) {
            // The port is someone's (the LocalSend app on this phone): it receives, we still find and send.
            receiving = false
            error = if (e is BindException) "port" else (e.message ?: "error")
        }
    }

    // ---- discovery ----

    private fun interfaces(): List<NetworkInterface> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { ni ->
            runCatching { ni.isUp && !ni.isLoopback && ni.supportsMulticast() && ni.inetAddresses.toList().any { it is Inet4Address } }.getOrDefault(false)
        }
    }.getOrDefault(emptyList())

    private val joined = HashSet<String>()

    private fun openUdp() {
        try {
            val s = MulticastSocket(null as java.net.SocketAddress?)
            s.reuseAddress = true
            s.bind(InetSocketAddress(Ls.PORT))
            udp = s
            synchronized(joined) { joined.clear() }
            join()
            Thread({
                val buf = ByteArray(8192)
                while (running) {
                    val p = DatagramPacket(buf, buf.size)
                    try { s.receive(p) } catch (e: IOException) { break }
                    if (p.length >= buf.size) continue
                    val text = String(p.data, p.offset, p.length, Charsets.UTF_8)
                    runCatching { heard(text, p.address) }
                }
            }, "td-localsend-udp").apply { isDaemon = true }.start()
        } catch (e: IOException) { /* no discovery by itself: devices are added by address */ }
    }

    private fun join() {
        val s = udp ?: return
        for (ni in interfaces()) synchronized(joined) {
            if (joined.add(ni.name)) runCatching { s.joinGroup(InetSocketAddress(group, Ls.PORT), ni) }.onFailure { joined.remove(ni.name) }
        }
    }

    // Says we're here on every network. The others answer with /register.
    fun announce() {
        val s = udp ?: return
        if (!running) return
        join()
        val msg = info(receiving).toString().toByteArray(Charsets.UTF_8)
        for (ni in interfaces()) runCatching {
            s.networkInterface = ni
            s.send(DatagramPacket(msg, msg.size, group, Ls.PORT))
        }
    }

    // A datagram as it arrived (tests hand one in the same way).
    fun heard(text: String, from: InetAddress) {
        if (!running || !opts.allow(from)) return
        val dto = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (Ls.str(dto, "fingerprint") == fingerprint) return
        val peer = Ls.peerFrom(dto, from.hostAddress ?: return) ?: return
        heard(peer, dto.optBoolean("announce", false) || dto.optBoolean("announcement", false))
    }

    // A device said it's at this address (an announce, or /register from it). It's listed as it says;
    // then its certificate is checked, which also tells it about us.
    private fun heard(peer: LsPeer, announce: Boolean) {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val known = peers[peer.id]
            if (Ls.downgrades(known, peer)) return
            if (!peer.supported) { upsert(peer); return }
            // A device that was proven keeps what was proven of it (its name too): a datagram is
            // anyone's. The check below is what brings a new name or address, from the device itself.
            if (known == null || !known.verified) upsert(peer)
            val key = "${peer.ip}:${peer.port}"
            if (now - (verifiedAt[key] ?: 0) < Ls.VERIFY_EVERY_MS) return
            if (verifying.get() >= Ls.MAX_VERIFYING) return // a flood of announces opens only so many connections
            verifiedAt[key] = now
            if (verifiedAt.size > 1024) verifiedAt.clear()
        }
        verifying.incrementAndGet()
        pool.execute {
            try { verify(peer.ip, peer.port, peer.fingerprint) } catch (e: Exception) {
                // No server there (a device that only sends), or it isn't that device: the multicast answer.
                if (announce && receiving) runCatching {
                    val msg = info(false).toString().toByteArray(Charsets.UTF_8)
                    udp?.send(DatagramPacket(msg, msg.size, group, Ls.PORT))
                }
            } finally { verifying.decrementAndGet() }
        }
    }

    // Asks ip:port who it is over TLS (POST /register when we receive, so it learns of us; else GET
    // /info). fingerprint: what it must be; null: whatever its certificate is.
    private fun verify(ip: String, port: Int, fingerprint: String?): LsPeer {
        val register = receiving
        val res = request(ip, port, fingerprint, if (register) "POST" else "GET", "${Ls.API}/${if (register) "register" else "info"}",
            body = if (register) info().toString().toByteArray(Charsets.UTF_8) else null, type = if (register) "application/json" else "")
        val dto = (if (res.status in 200..299) Ls.parse(res.body) else null) ?: throw LsException("answer", "HTTP ${res.status}")
        // What it is, is what its certificate is: the fingerprint in the body counts for nothing.
        dto.put("fingerprint", res.fingerprint).put("protocol", "https")
        val said = Ls.peerFrom(dto, ip, port) ?: throw LsException("answer", "not a device")
        if (said.fingerprint == this.fingerprint) throw LsException("answer", "this device")
        val peer = said.copy(port = port, id = Ls.peerId(said.fingerprint, ip, port), verified = true) // the port that answered
        synchronized(lock) { upsert(peer) }
        return peer
    }

    // Add a device by its address (the network doesn't carry multicast). Throws LsException:
    // "address", "unreachable", "fingerprint", "plain" (it answers without encryption, which we don't speak).
    fun probe(host: String, port: Int = Ls.PORT): LsPeer {
        val ip = host.trim()
        if (!Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(ip) || ip.split('.').any { it.toInt() > 255 } || port !in 1..65535) throw LsException("address") // never a name to look up
        val addr = runCatching { InetAddress.getByName(ip) }.getOrNull()
        if (addr == null || !opts.allow(addr)) throw LsException("address")
        try {
            return verify(ip, port, null)
        } catch (e: LsException) {
            if (e.code != "unreachable") throw e
            val plain = runCatching {
                Socket().use { s ->
                    s.connect(InetSocketAddress(addr, port), 3000)
                    s.soTimeout = 3000
                    s.getOutputStream().write("GET ${Ls.API}/info HTTP/1.1\r\nHost: $ip:$port\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
                    (readLine(s.getInputStream(), 256) ?: "").let { it.startsWith("HTTP/1.") && it.contains(" 200") }
                }
            }.getOrDefault(false)
            throw if (plain) LsException("plain", "that device has encryption off") else e
        }
    }

    // (lock held)
    private fun upsert(peer: LsPeer) {
        if (peer.fingerprint.isNotEmpty() && peer.fingerprint == fingerprint) return
        val known = peers[peer.id]
        if (Ls.downgrades(known, peer)) return
        if (known == null && peers.size >= Ls.MAX_PEERS) {
            // Full of claims: one that was never proven makes room for a device that was.
            val claim = if (peer.verified) peers.values.firstOrNull { !it.verified } else null
            peers.remove(claim?.id ?: return)
        }
        if (known != null && known.verified && !peer.verified) return // what's proven isn't replaced by what's said
        peers[peer.id] = peer
        if (known == null || known.copy(seen = peer.seen) != peer) pool.execute { events.changed() }
    }

    private fun expire() {
        val now = System.currentTimeMillis()
        var gone = false
        val idle = synchronized(lock) {
            gone = peers.values.removeAll { now - it.seen > Ls.PEER_TTL_MS }
            cooldown.values.removeAll { it < now }
            sessions.values.filter { now - it.active > Ls.SESSION_IDLE_MS }
        }
        for (s in idle) endSession(s, "cancelled")
        if (gone) events.changed()
    }

    // ---- the server ----

    private fun reply(out: OutputStream, status: Int, json: JSONObject? = null) {
        val body = json?.toString()?.toByteArray(Charsets.UTF_8)
        val head = StringBuilder("HTTP/1.1 $status ${REASONS[status] ?: "Error"}\r\nConnection: close\r\n")
        if (body != null) head.append("Content-Type: application/json\r\n")
        head.append("Content-Length: ${body?.size ?: 0}\r\n\r\n")
        out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        if (body != null) out.write(body)
        out.flush()
    }
    private fun msg(text: String) = JSONObject().put("message", text)

    // One request on one connection.
    private fun serve(sock: SSLSocket) {
        try {
            sock.soTimeout = 10_000
            sock.startHandshake()
            sock.soTimeout = Ls.IO_MS
            // The certificate it showed on this connection, as its fingerprint, or "" when it showed none.
            val cert = runCatching { Ls.fingerprintOf(sock.session.peerCertificates[0].encoded) }.getOrDefault("")
            val inp = BufferedInputStream(sock.inputStream, 65536)
            val out = BufferedOutputStream(sock.outputStream, 16384)
            val (first, headers) = readHead(inp) ?: return
            val parts = first.split(' ')
            if (parts.size < 2) return
            val method = parts[0]
            val target = parts[1]
            val path = target.substringBefore('?')
            val from = sock.inetAddress
            val ip = from.hostAddress ?: return
            var drain = true
            try {
                if (!running || !opts.allow(from)) return reply(out, 403, msg("Not from this network"))
                if (headers["expect"]?.lowercase(Locale.ROOT) == "100-continue") { out.write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray(Charsets.ISO_8859_1)); out.flush() }
                val body = bodyOf(inp, headers)
                when ("$method $path") {
                    "GET ${Ls.API}/info" -> reply(out, 200, info())
                    "POST ${Ls.API}/register" -> {
                        val dto = runCatching { Ls.parse(readAll(body, Ls.MAX_SMALL_JSON)) }.getOrNull()
                        // A sender that showed a certificate is that device: it can't register another one's fingerprint.
                        if (dto != null && Ls.str(dto, "fingerprint") != fingerprint) Ls.peerFrom(dto, ip)?.let { if (cert.isEmpty() || it.protocol != "https" || cert == it.fingerprint) heard(it, false) }
                        reply(out, 200, info())
                    }
                    "POST ${Ls.API}/prepare-upload" -> prepare(sock, inp, body, out, ip, cert) { drain = false }
                    "POST ${Ls.API}/upload" -> upload(sock, headers, body, out, ip, queryOf(target))
                    "POST ${Ls.API}/cancel" -> {
                        // Only the sender cancels its session. Anyone else gets the same answer, so it
                        // doesn't learn which sessions exist.
                        val s = synchronized(lock) { sessions[queryOf(target)["sessionId"] ?: ""] }
                        if (s != null && s.ip == ip) endSession(s, "cancelled")
                        reply(out, 200)
                    }
                    else -> reply(out, 404, msg("Not found"))
                }
            } catch (e: LsException) {
                opts.log("$method $path: $e")
                runCatching { reply(out, if (e.code == "big") 400 else 500, msg("error")) }
            }
            // What it still sends is read for a moment, so the answer isn't lost with a reset. (Not
            // after a question: its watcher is still reading, and closing the socket below ends it.)
            if (drain) runCatching { sock.soTimeout = 500; val junk = ByteArray(8192); var n = 0; while (n < 262144) { val r = inp.read(junk); if (r < 0) break; n += r } }
        } catch (e: Exception) { /* it hung up, or it wasn't TLS */ } finally { runCatching { sock.close() } }
    }

    private class Offered(val info: JSONObject, val files: List<InFile>, val total: Long)

    // The offer in a prepare-upload request, or null when it was answered here as not one.
    private fun offered(body: InputStream, out: OutputStream): Offered? {
        val bad = { reply(out, 400, msg("Invalid body")); null }
        val dto = runCatching { Ls.parse(readAll(body, Ls.MAX_JSON)) }.getOrNull() ?: return bad()
        val list = dto.optJSONObject("files")
        val infoDto = dto.optJSONObject("info")
        if (list == null || infoDto == null || list.length() == 0 || list.length() > Ls.MAX_FILES) return bad()
        val files = ArrayList<InFile>()
        val ids = HashSet<String>()
        var total = 0L
        for (key in list.keys()) {
            val f = list.optJSONObject(key) ?: return bad()
            val id = Ls.str(f, "id").ifEmpty { key }
            val fileName = Ls.str(f, "fileName")
            val size = f.opt("size")?.toString()?.takeIf { Regex("^\\d{1,15}$").matches(it) }?.toLong() // a whole number of bytes, nothing else
            if (id.length > 256 || !ids.add(id) || fileName.isEmpty() || fileName.length > 4096 || size == null) return bad()
            val (folder, name) = Ls.splitName(fileName)
            total += size
            val type = Ls.clip(Ls.str(f, "fileType"), 128)
            val sha = Ls.str(f, "sha256")
            files.add(InFile(id, folder, name, size, type, if (Ls.isFp(sha)) sha.lowercase(Locale.ROOT) else "",
                if (type.startsWith("text/")) Ls.clip(Ls.str(f, "preview"), 2000) else "")) // a message: shown with the question
        }
        files.sortBy { (it.folder + it.name).joinToString("/") }
        val free = runCatching { sink.free() }.getOrDefault(-1)
        if (free in 0 until total + Ls.SPACE_MARGIN) { reply(out, 507, msg("Not enough space")); return null }
        return Offered(infoDto, files, total)
    }

    // (lock held) Why this address isn't asked about now (the status to answer with), or 0.
    private fun refused(ip: String): Int = when {
        (cooldown[ip] ?: 0) > System.currentTimeMillis() -> 429
        offers.size >= Ls.MAX_PENDING || offers.values.any { it.offer.ip == ip } -> 429
        sessions.size >= Ls.MAX_SESSIONS -> 409
        else -> 0
    }

    // (lock held) Whether another device the person here knows, or one proven on this network, has
    // this name: a name is free to take, so the question says when it is someone else's.
    private fun imitates(alias: String, fingerprint: String): Boolean {
        val name = Ls.skeleton(alias)
        if (name.isEmpty()) return false
        return knownBefore.any { it.key != fingerprint && Ls.skeleton(it.value.first) == name } ||
            peers.values.any { it.verified && it.fingerprint != fingerprint && Ls.skeleton(it.alias) == name }
    }

    // An offer: nothing is written and no token is given until the person here says yes.
    // cert: the certificate the sender showed on this connection ("" for none). It is who the
    // sender is, and nothing it says is: not the fingerprint in its offer, not its address.
    private fun prepare(sock: SSLSocket, inp: InputStream, body: InputStream, out: OutputStream, ip: String, cert: String, watched: () -> Unit) {
        fun no(status: Int) = reply(out, status, msg(if (status == 409) "Blocked by another session" else if (status == 403) "Rejected" else "Too many requests"))
        // Looked at before the offer is read (a sender that's refused uploads nothing) and again
        // under the same lock that lists it: of offers that arrive together only the first is asked about.
        val early = synchronized(lock) {
            val n = offering[ip] ?: 0
            (refused(ip).takeIf { it != 0 } ?: if (n >= Ls.MAX_OFFERING) 429 else 0).also { if (it == 0) offering[ip] = n + 1 }
        }
        if (early != 0) return no(early)
        val o = (try { offered(body, out) } finally {
            synchronized(lock) { val n = (offering[ip] ?: 1) - 1; if (n > 0) offering[ip] = n else offering.remove(ip) }
        }) ?: return
        val files = o.files
        val total = o.total
        val alias = Ls.clip(Ls.str(o.info, "alias"), 64).ifEmpty { ip }
        val names = files.map { it.folder.firstOrNull() ?: it.name }.distinct()
        var pending: Pending? = null
        val late = synchronized(lock) {
            val status = if (!running) 403 else refused(ip)
            if (status == 0) {
                val offer = LsOffer(Ls.token(), ip, alias, Ls.clip(Ls.str(o.info, "deviceModel"), 64), cert, cert.isNotEmpty() && knownBefore.containsKey(cert),
                    names, files.size, total, if (files.size == 1) files[0].text else "", verified = cert.isNotEmpty(), imitates = imitates(alias, cert))
                pending = Pending(offer).also { offers[offer.id] = it }
            }
            status
        }
        val asked = pending ?: return no(late)
        val offer = asked.offer
        events.offer(offer)
        // The person may take a minute; the sender that gives up meanwhile ends its question.
        sock.soTimeout = 0
        watched()
        pool.execute { val gone = try { inp.read() < 0 } catch (e: IOException) { true }; if (gone) answer(offer.id, false, "gone") }
        if (!asked.latch.await(opts.approvalMs, TimeUnit.MILLISECONDS)) answer(offer.id, false, "timeout")
        asked.latch.await()
        sock.soTimeout = Ls.IO_MS
        if (!asked.accepted || !running) {
            // After a no, that address waits before it may ask again (a sender that gave up itself doesn't).
            if (asked.why != "gone") synchronized(lock) { cooldown[ip] = System.currentTimeMillis() + opts.cooldownMs }
            return no(403)
        }
        val session = Session(Ls.token(), ip, files.associateBy { it.id }, offer.alias, names, total)
        synchronized(lock) {
            if (sessions.size >= Ls.MAX_SESSIONS) return no(409)
            sessions[session.id] = session
        }
        remember(cert, alias) // the person here said yes to this device
        events.transfer(snapshot(session, "running"))
        val tokens = JSONObject()
        for (f in files) tokens.put(f.id, f.token)
        reply(out, 200, JSONObject().put("sessionId", session.id).put("files", tokens))
    }

    // A device the person here took files from or sent files to: known from now on, by its
    // certificate (dir/localsend-known.json, the app's own files: fingerprint -> { alias, at }).
    private fun remember(fingerprint: String, alias: String) {
        if (!Ls.isFp(fingerprint)) return
        synchronized(lock) {
            knownBefore.remove(fingerprint)
            knownBefore[fingerprint] = Ls.clip(alias, 64) to System.currentTimeMillis()
            while (knownBefore.size > Ls.MAX_KNOWN) knownBefore.remove(knownBefore.keys.first()) // the one longest ago
            runCatching {
                val o = JSONObject()
                for ((fp, v) in knownBefore) o.put(fp, JSONObject().put("alias", v.first).put("at", v.second))
                dir.mkdirs()
                val tmp = File(dir, "localsend-known.json.tmp")
                tmp.writeText(o.toString())
                tmp.setReadable(false, false); tmp.setWritable(false, false)
                tmp.setReadable(true, true); tmp.setWritable(true, true)
                val file = File(dir, "localsend-known.json")
                if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
            }
        }
    }

    init {
        runCatching {
            val o = JSONObject(File(dir, "localsend-known.json").readText())
            val read = o.keys().asSequence().mapNotNull { fp -> o.optJSONObject(fp)?.takeIf { Regex("^[0-9a-f]{64}$").matches(fp) }?.let { fp to (Ls.str(it, "alias").take(64) to it.optLong("at")) } }
            for ((fp, v) in read.sortedBy { it.second.second }.toList().takeLast(Ls.MAX_KNOWN)) knownBefore[fp] = v
        }
    }

    // The person's answer to an offer. → whether there was such an offer.
    fun answer(id: String, accept: Boolean, why: String = ""): Boolean {
        val p = synchronized(lock) { offers.remove(id) } ?: return false
        p.accepted = accept
        p.why = if (accept) "" else why.ifEmpty { "declined" }
        p.latch.countDown()
        events.offerEnd(id, accept, p.why)
        return true
    }

    private fun upload(sock: SSLSocket, headers: Map<String, String>, body: InputStream, out: OutputStream, ip: String, q: Map<String, String>) {
        val sid = q["sessionId"].orEmpty()
        val fid = q["fileId"].orEmpty()
        val tok = q["token"].orEmpty()
        if (sid.isEmpty() || fid.isEmpty() || tok.isEmpty()) return reply(out, 400, msg("Missing parameters"))
        var session: Session? = null
        var f: InFile? = null
        var mismatch = false
        synchronized(lock) {
            val s = sessions[sid]
            val x = s?.files?.get(fid)
            // The same answer for no session, another address, a wrong token and a file already here.
            if (s == null || x == null || s.ip != ip || x.state != "waiting" || !MessageDigest.isEqual(tok.toByteArray(Charsets.UTF_8), x.token.toByteArray(Charsets.UTF_8))) return@synchronized
            // The body must be exactly the size that was offered and accepted: more could fill the
            // storage, less is a broken file.
            val declared = headers["content-length"]?.toLongOrNull()
            if (declared != null && declared != x.size) { mismatch = true; return@synchronized }
            x.state = "uploading"
            s.active = System.currentTimeMillis()
            s.sockets.add(sock)
            session = s
            f = x
        }
        if (mismatch) return reply(out, 400, msg("Size mismatch"))
        val s = session ?: return reply(out, 403, msg("Invalid token or IP address"))
        val file = f!!
        var got = 0L
        var counted = 0L // what of it the progress already shows
        var dest: LsOut? = null
        try {
            dest = sink.open(s.id, file.folder, file.name, file.type)
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(65536)
            while (true) {
                if (s.cancelled) throw LsException("cancelled")
                val n = body.read(buf)
                if (n < 0) break
                got += n
                if (got > file.size) throw LsException("size", "more than was offered")
                md.update(buf, 0, n)
                dest.out.write(buf, 0, n)
                s.active = System.currentTimeMillis()
                s.done.addAndGet(n.toLong())
                counted += n
                progress(s)
            }
            if (got != file.size) throw LsException("size", "less than was offered")
            if (file.sha256.isNotEmpty() && Ls.hex(md.digest()) != file.sha256) throw LsException("integrity")
            dest.out.flush()
            val all = synchronized(lock) {
                if (s.cancelled || !sessions.containsKey(s.id)) throw LsException("cancelled")
                val where = dest.commit()
                file.state = "done"
                s.sockets.remove(sock)
                if (file.folder.isEmpty() || s.saved.isEmpty()) s.saved.add(where)
                s.files.values.all { it.state == "done" }
            }
            if (all) endSession(s, "done")
            reply(out, 200)
        } catch (e: Exception) {
            opts.log("upload: $e")
            runCatching { dest?.discard() }
            s.done.addAndGet(-counted)
            val live = synchronized(lock) {
                s.sockets.remove(sock)
                if (file.state == "uploading") file.state = "waiting" // the sender may send this file again
                sessions.containsKey(s.id)
            }
            if (live && counted > 0) events.transfer(snapshot(s, "running")) // what was shown of it is taken back
            val code = (e as? LsException)?.code ?: "io"
            reply(out, if (!live) 409 else if (code == "size") 400 else if (code == "integrity") 422 else 500,
                msg(if (!live) "Cancelled" else if (code == "size") "Size mismatch" else if (code == "integrity") "Checksum mismatch" else "Upload interrupted"))
        }
    }

    private fun snapshot(s: Session, state: String): LsTransfer {
        val arrived = s.files.values.count { it.state == "done" }
        return LsTransfer(s.transferId, true, s.alias, s.ip, s.names, s.files.size, s.total, if (state == "done") s.total else s.done.get(), state,
            arrived = arrived, saved = synchronized(lock) { s.saved.toList() }, at = s.at)
    }

    private fun progress(s: Session) {
        val now = System.currentTimeMillis()
        if (now - s.last < Ls.PROGRESS_MS) return
        s.last = now
        events.transfer(snapshot(s, "running"))
    }

    private fun endSession(s: Session, state: String) {
        val open = synchronized(lock) {
            if (sessions.remove(s.id) == null) return
            s.cancelled = state != "done"
            s.sockets.toList()
        }
        if (state != "done") for (x in open) runCatching { x.close() } // what's arriving stops now
        events.transfer(snapshot(s, state))
    }

    // ---- the client side: every connection is TLS and its certificate is checked first ----

    // One request. body, or stream + length. Nothing is written before the certificate is the one
    // expected (fingerprint null: any, the caller compares what the device then says); the check is
    // in the handshake, so a device that isn't the expected one doesn't get our certificate either.
    private fun request(
        ip: String, port: Int, fingerprint: String?, method: String, path: String, body: ByteArray? = null, stream: InputStream? = null, length: Long = 0,
        type: String = "", waitMs: Int = Ls.IO_MS, max: Int = Ls.MAX_SMALL_JSON, out: Out? = null, onSent: ((Int) -> Unit)? = null,
    ): HttpRes {
        var got = ""
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("no clients")
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                got = Ls.fingerprintOf((chain?.firstOrNull() ?: throw CertificateException("no certificate")).encoded)
                if (fingerprint != null && got != fingerprint.lowercase(Locale.ROOT)) throw CertificateException("the certificate is not that device's")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val raw = Socket()
        out?.socket = raw
        try {
            if (out?.cancelled == true) throw LsException("cancelled")
            try { raw.connect(InetSocketAddress(InetAddress.getByName(ip), port), Ls.CONNECT_MS) } catch (e: IOException) { throw LsException("unreachable", e.message ?: "unreachable") }
            val s = SSLContext.getInstance("TLS").apply { init(arrayOf(keys), arrayOf(trust), null) }.socketFactory.createSocket(raw, ip, port, true) as SSLSocket
            s.soTimeout = Ls.CONNECT_MS
            try { s.startHandshake() } catch (e: IOException) {
                var c: Throwable? = e
                while (c != null && c !is CertificateException) c = c.cause
                throw if (c != null) LsException("fingerprint", "the certificate is not that device's") else LsException("unreachable", e.message ?: "unreachable")
            }
            if (got.isEmpty() || (fingerprint != null && got != fingerprint.lowercase(Locale.ROOT))) throw LsException("fingerprint")
            s.soTimeout = waitMs
            val o = BufferedOutputStream(s.outputStream, 65536)
            val head = StringBuilder("$method $path HTTP/1.1\r\nHost: $ip:$port\r\nConnection: close\r\n")
            if (type.isNotEmpty()) head.append("Content-Type: $type\r\n")
            if (method == "POST") head.append("Content-Length: ${body?.size?.toLong() ?: length}\r\n")
            head.append("\r\n")
            o.write(head.toString().toByteArray(Charsets.ISO_8859_1))
            if (body != null) o.write(body)
            if (stream != null) {
                val buf = ByteArray(65536)
                var sent = 0L
                while (sent < length) {
                    val n = try { stream.read(buf, 0, minOf(buf.size.toLong(), length - sent).toInt()) } catch (e: IOException) { throw LsException("read", e.message ?: "read") }
                    // Fewer bytes than promised (the file changed under us): the request can't be finished honestly.
                    if (n < 0) throw LsException("read", "the file changed while it was sent")
                    o.write(buf, 0, n)
                    sent += n
                    onSent?.invoke(n)
                }
            }
            o.flush()
            val inp = BufferedInputStream(s.inputStream, 16384)
            var status: Int
            var headers: Map<String, String>
            while (true) {
                val (first, h) = readHead(inp) ?: throw LsException("unreachable", "no answer")
                status = first.split(' ').getOrNull(1)?.toIntOrNull() ?: throw LsException("answer", "not HTTP")
                headers = h
                if (status != 100) break
            }
            val bodyIn: InputStream = when {
                status == 204 || status == 304 -> LimitedIn(inp, 0)
                headers["transfer-encoding"]?.lowercase(Locale.ROOT)?.contains("chunked") == true -> ChunkedIn(inp)
                headers["content-length"] != null -> LimitedIn(inp, headers["content-length"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0)
                else -> inp // until it closes
            }
            val data = try { readAll(bodyIn, max) } catch (e: LsException) { throw LsException("answer", "the answer is too long") }
            return HttpRes(status, data, got)
        } catch (e: LsException) {
            throw if (out?.cancelled == true) LsException("cancelled") else e
        } catch (e: SocketTimeoutException) {
            throw if (out?.cancelled == true) LsException("cancelled") else LsException("timeout", "no answer")
        } catch (e: IOException) {
            throw if (out?.cancelled == true) LsException("cancelled") else LsException("unreachable", e.message ?: "unreachable")
        } finally {
            runCatching { raw.close() }
            out?.socket = null
        }
    }

    // ---- sending ----

    private fun snapshot(o: Out, error: String = "") = LsTransfer(o.id, false, o.peer.alias, o.peer.ip, o.names, o.files, o.total, if (o.state == "done") o.total else o.done.get(), o.state, error, at = o.at)

    // Files to a device that was found. pin: the PIN that device asks for. → the transfer's id; its
    // states arrive as transfer events. Throws LsException: "peer", "empty", or why it isn't supported.
    fun send(peerId: String, sources: List<LsSource>, pin: String? = null): String {
        val peer = synchronized(lock) { peers[peerId] } ?: throw LsException("peer", "that device is gone")
        if (!peer.supported) throw LsException(peer.why, "that device is not supported")
        val list = sources.take(Ls.MAX_FILES)
        if (list.isEmpty()) throw LsException("empty", "nothing to send")
        val names = list.map { Ls.splitName(it.name).let { (folder, name) -> folder.firstOrNull() ?: name } }.distinct()
        val o = Out("out-${Ls.token()}", peer, names, list.size, list.sumOf { it.size })
        synchronized(lock) { outs[o.id] = o }
        events.transfer(snapshot(o))
        pool.execute {
            var error = ""
            o.state = try { run(o, list, pin); "done" } catch (e: Exception) {
                error = (e as? LsException)?.code ?: "failed"
                if (error == "cancelled" || o.cancelled) "cancelled" else if (error == "declined") "declined" else "failed"
            }
            synchronized(lock) { outs.remove(o.id) }
            events.transfer(snapshot(o, if (o.state == "failed") error else ""))
        }
        return o.id
    }

    private fun run(o: Out, list: List<LsSource>, pin: String?) {
        val peer = o.peer
        val files = JSONObject()
        val ids = ArrayList<String>()
        list.forEachIndexed { i, f ->
            val id = "f$i"
            ids.add(id)
            val (folder, name) = Ls.splitName(f.name)
            files.put(id, JSONObject().put("id", id).put("fileName", (folder + name).joinToString("/")).put("size", f.size).put("fileType", f.type.ifEmpty { "application/octet-stream" })
                .also { if (Ls.isFp(f.sha256)) it.put("sha256", f.sha256.lowercase(Locale.ROOT)) })
        }
        val q = if (!pin.isNullOrEmpty()) "?pin=${enc(pin)}" else ""
        val res = request(peer.ip, peer.port, peer.fingerprint, "POST", "${Ls.API}/prepare-upload$q",
            body = JSONObject().put("info", info()).put("files", files).toString().toByteArray(Charsets.UTF_8), type = "application/json", waitMs = Ls.ANSWER_WAIT_MS, max = Ls.MAX_JSON, out = o)
        when (res.status) {
            204 -> return // it has them, or needs none
            401 -> throw LsException("pin", "that device asks for a PIN")
            403 -> throw LsException("declined")
            409 -> throw LsException("busy", "that device is busy with another transfer")
            429 -> throw LsException("rate", "that device asks to wait")
        }
        val ok = (if (res.status == 200) Ls.parse(res.body) else null) ?: throw LsException("answer", "HTTP ${res.status}")
        val sid = Ls.str(ok, "sessionId")
        val tokens = ok.optJSONObject("files")
        if (sid.isEmpty() || tokens == null) throw LsException("answer", "HTTP ${res.status}")
        o.state = "running"
        events.transfer(snapshot(o))
        try {
            list.forEachIndexed { i, f ->
                val tok = Ls.str(tokens, ids[i])
                if (tok.isEmpty()) { o.total -= f.size; return@forEachIndexed } // it took only some of them
                val target = "${Ls.API}/upload?sessionId=${enc(sid)}&fileId=${enc(ids[i])}&token=${enc(tok)}"
                val up = (if (f.size > 0) f.open() else null).use { src ->
                    request(peer.ip, peer.port, peer.fingerprint, "POST", target, stream = src, length = f.size, type = "application/octet-stream", waitMs = Ls.IO_MS * 2, out = o) { n ->
                        o.done.addAndGet(n.toLong())
                        val now = System.currentTimeMillis()
                        if (now - o.last >= Ls.PROGRESS_MS) { o.last = now; events.transfer(snapshot(o)) }
                    }
                }
                if (up.status == 422) throw LsException("integrity", "a file arrived changed")
                if (up.status !in 200..299) throw LsException("answer", "HTTP ${up.status}")
            }
        } catch (e: Exception) {
            // The other side is told, so it doesn't keep waiting for the rest.
            runCatching { request(peer.ip, peer.port, peer.fingerprint, "POST", "${Ls.API}/cancel?sessionId=${enc(sid)}", waitMs = 5000) }
            throw e
        }
        remember(peer.fingerprint, peer.alias) // files went to it: a device the person here knows
    }

    // Stops a transfer of ours (the other side is told), or an arriving one.
    fun cancel(id: String): Boolean {
        val o = synchronized(lock) { outs[id] }
        if (o != null) {
            o.cancelled = true
            runCatching { o.socket?.close() }
            return true
        }
        val s = synchronized(lock) { sessions.values.firstOrNull { it.transferId == id } } ?: return false
        endSession(s, "cancelled")
        return true
    }
}
