// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's side of the session: a WSS client with the computer's certificate pinned, pairing as
// the initiator (numeric comparison), hello, liveness. Like windows/link.js and mac/link.js, except
// that a phone connects only when asked (or to resume a session that dropped by accident, or to
// reclaim a paired Mac that advertises rc without taking another session).
package com.twindesk.android

import android.app.AlarmManager
import android.content.Context
import android.net.InetAddresses
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.Inet4Address
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

private const val FALLBACK_MS = 5000L // on the network this long, answering: its Bluetooth fallback goes (dropAlt)
private const val ANSWERING_MS = 3000L // … answering = something came through it this recently
private const val CONNECT_TIMEOUT_MS = 5000L
private const val RESUME_BACKOFF_MS = 8000L
private const val MAX_LAN_ADDRESSES = 4
// Quiet links (shared/quiet.js): the same numbers as the computers'.
private const val QUIET_IDLE = "idle"
private const val QUIET_ACTIVE_MS = 15000L
private const val QUIET_PING_MS = 5 * 60 * 1000L
private const val QUIET_TIMEOUT_MS = 11 * 60 * 1000L

data class PairState(
    val phase: String, // connecting | starting | code | waiting | failed
    val address: String,
    val port: Int,
    val name: String,
    val code: String = "",
    val error: String = "",
    val wired: Boolean = false, // through the USB cable: no code to compare, only Allow on the computer
    val ble: Boolean = false, // through Bluetooth: the address is the pipe's, not the computer's
    val qr: Boolean = false, // the computer's QR code, on the network: no code to compare either
)

class Link(
    private val store: Store,
    private val events: Events,
    // Where paired hosts are kept: the computers ("hosts"), or another phone (Peer.kt: "peerHosts").
    private val hostsKey: String = "hosts",
    private val context: Context? = null,
) {
    interface Events {
        fun onChange()
        fun onWelcome(host: Host)
        fun onMessage(m: JSONObject, route: TrustedRoute?, source: WebSocket)
        fun onClosed(host: Host, code: String?)
    }

    // idle | connecting | connected | failed
    @Volatile var state = "idle"; private set
    @Volatile var message = ""; private set
    @Volatile var pair: PairState? = null; private set
    @Volatile var host: Host? = null; private set
    @Volatile var rttMs: Long? = null; private set
    // On a USB cable: the computer's port reached through adb reverse on this device's 127.0.0.1.
    @Volatile var wired = false; private set
    // Through Bluetooth (Ble.kt): the computer's port reached through a pipe on 127.0.0.1. After a
    // resume onto the network (Core), false again, with the Bluetooth socket kept as the fallback.
    @Volatile var ble = false; private set
    val connected get() = state == "connected"
    private val connectionObservations = ConnectionObservations()

    internal fun doctorClose(h: Host): ConnectionCloseObservation? =
        if (store.hosts(hostsKey).any { it.id == h.id && it.fp == h.fp })
            connectionObservations.forPair(h.id, h.fp) else null

    private val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "td-link").apply { isDaemon = true } }
    @Volatile private var ws: WebSocket? = null
    private data class NetemDial(val route: NetemRoute, val socket: WebSocket, val started: Long) {
        val traceRemaining = java.util.concurrent.atomic.AtomicInteger(48)
    }
    @Volatile private var netemDial: NetemDial? = null
    @Volatile private var appsReady = false

    internal fun appsViewerReady(marker: Any?) {
        if (appsReady) sendFor(marker, msg("phone.apps.ready"))
    }

    internal fun isNetemPeer(h: Host): Boolean =
        hostsKey == "hosts" && h.os == "mac" && NetemRoute.configured?.peer == h.id

    internal fun pairedNetemHost(h: Host): Host? {
        if (!isNetemPeer(h)) return null
        return store.hosts(hostsKey).firstOrNull { it.id == h.id && it.fp == h.fp && it.token == h.token && it.os == "mac" }
    }

    internal fun netemRoute(marker: Any?): NetemRoute? =
        netemDial?.takeIf { it.socket === marker && ownsVideoSession(marker) }?.route

    internal fun netemElapsed(marker: Any?): Long? =
        netemDial?.takeIf { it.socket === marker && ownsVideoSession(marker) }?.let { SystemClock.elapsedRealtime() - it.started }

    internal fun netemMark(marker: Any?, stage: String, numbers: String = "") {
        val dial = netemDial?.takeIf { it.socket === marker && ownsVideoSession(marker) } ?: return
        if (dial.traceRemaining.getAndDecrement() <= 0) return
        val elapsed = SystemClock.elapsedRealtime() - dial.started
        Log.i("TwinDeskNetem", "stage=$stage elapsed_ms=$elapsed$numbers")
    }

    private var mode = "" // session | pair
    private var nw = ""
    private var pairNonce = "" // pairing through the cable: the nonce the computer sent us over adb
    private var seenFp = ""
    private var lastRx = 0L
    private var lastCode: String? = null
    private var pinger: ScheduledFuture<*>? = null
    private var quietAlarm: AlarmManager.OnAlarmListener? = null
    private val alarms by lazy { context?.getSystemService(AlarmManager::class.java) }
    private val alarmHandler by lazy { Handler(Looper.getMainLooper()) }
    @Volatile private var beatDue = Long.MAX_VALUE
    // Resume (hello {resume}): the session's other socket, and one being opened.
    private var resumeKey = ""
    private var alt: WebSocket? = null
    @Volatile private var altBle = false
    val hasBluetoothFallback get() = alt != null && altBle
    private var movedAt = 0L // when the session moved onto the network (dropAlt)
    private var pending: WebSocket? = null
    private data class LanOffer(val addresses: List<String>, val port: Int)
    private var lanOffer: LanOffer? = null // only while this authenticated socket is primary on BLE
    private var lanCapable = false
    private var lanAskAfter = 0L
    private val resumeTried = HashMap<String, Long>()
    private val lastRxOf = java.util.concurrent.ConcurrentHashMap<WebSocket, Long>()
    // When the computer last pinged this socket. Our own ping is skipped while that is inside the
    // current interval plus a little jitter grace (the computer keeps pinging, and measures rtt
    // from our pong). Cleared with lastRxOf.
    private val lastPeerPingOf = java.util.concurrent.ConcurrentHashMap<WebSocket, Long>()
    private var helloTimer: ScheduledFuture<*>? = null
    // The next hello is a reclaim (shared/reclaim.js): rc:1 plus a resume string older hosts refuse.
    private var reclaimHello = false
    // Read on this link's thread before opening, hello and welcome. Disconnect, Forget,
    // replacement or a background pause invalidates a queued automatic return.
    private var dialAdmit: (() -> Boolean)? = null
    // Core sets this in the admit callback when it returns false. "paused" keeps the reclaim
    // window (the screen went away). "local" does not.
    @Volatile var denyCode: String = "local"
    // hello() has been written. Disconnect sends bye even while still connecting, so a Mac that
    // already committed the welcome does not keep a grace or forget the stop.
    private var helloSent = false
    // Disconnect owns the socket. Set on the caller thread, before this executor runs, so a welcome
    // already queued still sees it and sends bye. A background pause must not close the socket first.
    @Volatile private var parting = false
    @Volatile var canReclaim = false; private set

    // Quiet links (shared/quiet.js, #143): while nothing is live here and the computer says the same
    // (`idle {on}`), the session stops pinging every second and the radio and CPU can sleep: one ping
    // every QUIET_PING_MS, closed after QUIET_TIMEOUT_MS of silence. A message sent while quiet is
    // followed by one ping (a probe): no answer within TIMEOUT_MS and the socket closes (and the
    // session comes back). Messages don't end the quiet; busyHere (Core: something live here), the
    // computer saying busy or wake() do. A computer that never says idle (an older app) keeps today's
    // pings. Not through Bluetooth.
    @Volatile var busyHere: () -> Boolean = { false }
    @Volatile var busyReason: (() -> String?)? = null
    private var lastQuietReason = ""
    private var quietReasonAt = 0L
    @Volatile var keepPinging = false
    @Volatile private var peerIdle = false
    @Volatile private var peerPerf = false // peer sent idle {perf:1}: it understands the 3 s tier
    @Volatile private var peerKeep = false // peer sent idle {keep:1}: Prioritize performance is why it is idle
    private var saidSig = ""
    private var idleTrue = false
    private var idlePerf = false
    private var beatAlarm = false
    @Volatile private var lastUse = 0L // the session's start: active for QUIET_ACTIVE_MS
    @Volatile private var probeAt = 0L
    private var probed = false
    @Volatile private var wokeAt = 0L
    @Volatile private var quietSince = 0L
    private var quietEnd = 0L
    private var quietPing = 0L
    private var perfSince = 0L
    private var perfPing = 0L
    private var perfEnd = 0L
    val quiet: Boolean get() = quietSince != 0L

    // The screen came on, the network changed, the app opened: active again for a while, so a session
    // that died in the quiet is found within TIMEOUT_MS. Also when a hold starts or ends (Core.changed).
    fun wake() {
        wokeAt = System.currentTimeMillis()
        if (state == "connected") run { beat() }
    }

    fun nudge() {
        if (state == "connected") runCatching {
            exec.execute {
                if (state != "connected") return@execute
                beat() // activity, idle {off}, or a hold: the 1 s tier on this tick, not at the next 3 s
            }
        }
    }

    private fun markProbe() {
        if (quiet && probeAt == 0L) {
            probeAt = System.currentTimeMillis()
            nudge()
        }
    }

    // Same decision as shared/quiet.js tick(). Activity (a stream, input, a transfer, a call, the
    // app on screen) stays the 1 s tier even when Prioritize performance is on. That setting is its
    // own tier only when it is the only reason left and the computer has said `idle {perf:1}`.
    private fun sayIdle(now: Long) {
        val blocked = runCatching {
            busyReason?.invoke() ?: if (busyHere()) "feature" else null
        }.getOrDefault("feature-error") ?: if (now - maxOf(lastUse, wokeAt) < QUIET_ACTIVE_MS) "recent-wake" else null
        val perfOnly = blocked == null && keepPinging
        val trueIdle = blocked == null && !keepPinging
        idleTrue = trueIdle
        idlePerf = perfOnly
        val advertiseOn = trueIdle || (perfOnly && peerPerf)
        val keepFlag = perfOnly && peerPerf
        val spec = when {
            advertiseOn && keepFlag -> "on-keep"
            advertiseOn && peerPerf -> "on-perf"
            advertiseOn -> "on"
            perfOnly && !peerPerf -> "off-perf"
            saidSig == "on" || saidSig == "on-perf" || saidSig == "on-keep" -> "off"
            else -> saidSig
        }
        if (spec.isNotEmpty() && spec != saidSig) {
            val body = msg(QUIET_IDLE, "on" to (spec == "on" || spec == "on-perf" || spec == "on-keep"))
            if (spec == "on-keep" || spec == "on-perf" || spec == "off-perf") body.put("perf", 1)
            if (spec == "on-keep") body.put("keep", 1)
            ws?.let { w -> if (!ble && w.send(body.toString())) saidSig = spec }
        }
        val peerWantsPerf = peerKeep && peerPerf
        val code = blocked ?: when {
            perfOnly && !(keepFlag && peerIdle) -> "performance"
            (peerWantsPerf || (keepFlag && peerIdle)) && !ble -> "idle-perf"
            ble -> "bluetooth"
            !peerIdle -> "peer-not-idle"
            else -> "quiet"
        }
        if (code != lastQuietReason && now - quietReasonAt >= 5000) {
            Log.i("TwinDesk", "quiet reason=$code")
            lastQuietReason = code
            quietReasonAt = now
        }
    }
    var bleRx: () -> Long = { 0L } // Ble.lastDown: bytes arriving through Bluetooth count as alive
    // Fast files (Proto.FX_PATH): the session's token from welcome {fx}; none from a computer that can't.
    @Volatile private var fxToken = ""
    // … and welcome {fxPlain: {port, token}}: the computer allows unencrypted file transfers (its
    // Files › Encrypt file transfers off). We always allow them (hello {fxPlain: 1}): the computer decides.
    @Volatile private var fxPlain: Fx.Plain? = null
    // … and fast files v2 (the computers' shared/fx2.js, Fx2.kt): welcome {fx2: {port}}, the port of
    // the computer's files engine (0: none, an older computer).
    @Volatile private var fx2Port = 0
    // welcome {pb: 1}: this Mac can back up new camera photos (PhotoBackup.kt). A resumed welcome
    // has no pb; the first welcome's answer stays until the socket closes.
    @Volatile var peerBackup = false
        private set
    private var fxClient: Pair<String, OkHttpClient>? = null // (pinned fingerprint, client), kept for its connections

    private fun run(block: () -> Unit) = exec.execute { try { block() } catch (e: Exception) { Log.e("TwinDesk", "link", e) } }

    // usbPort: connect through the cable (adb reverse) instead of the network; the host's own
    // address stays as it is, for when the cable comes out.
    // blePort: through a Bluetooth pipe on 127.0.0.1 instead.
    // admit: reclaim only. Checked here, on the link thread, before this dial can replace a socket,
    // and again in hello(). The generation Core captured is already stale if Disconnect ran first.
    fun connect(h: Host, usbPort: Int = 0, blePort: Int = 0, reclaim: Boolean = false, admit: (() -> Boolean)? = null) = run {
        val viaUsb = usbPort > 0
        val viaBle = blePort > 0
        val wantReclaim = reclaim && !viaUsb && !viaBle
        val saved = pairedNetemHost(h)
        // A stale queued dial for the test peer must not fall through to an ordinary endpoint.
        if (isNetemPeer(h) && (saved == null || viaUsb || viaBle)) return@run
        val testRoute = NetemRoute.configured?.takeIf { saved != null }
        if (admit != null && !admit()) return@run
        parting = false
        if (ws != null && host?.id == h.id && wired == viaUsb && ble == viaBle && reclaimHello == wantReclaim && (state == "connecting" || state == "connected")) return@run
        closeSocket()
        dialAdmit = if (wantReclaim) admit else null
        reclaimHello = wantReclaim
        pair = null
        connectionObservations.select(h.id, h.fp)
        host = saved ?: h
        wired = viaUsb
        ble = viaBle
        when {
            viaUsb -> open("session", "127.0.0.1", usbPort, h.fp)
            viaBle -> open("session", "127.0.0.1", blePort, h.fp)
            testRoute != null -> {
                val start = SystemClock.elapsedRealtime()
                open("session", testRoute.address, NetemRoute.CONTROL_PORT, h.fp)
                ws?.let { netemDial = NetemDial(testRoute, it, start) }
            }
            else -> open("session", h.address, h.port, h.fp)
        }
        setState("connecting", "")
    }

    // Core's Bluetooth tick looks up discovery for the current host on this executor. Offers and
    // retries live here too, so a tick queued before a socket change cannot dial the old peer's LAN.
    fun resume(discover: (String) -> Pair<String, Int>?) = run {
        val h = host ?: return@run
        if (parting || !connected || !ble || resumeKey.isEmpty() || pending != null) return@run
        val seen = discover(h.id)
        val now = SystemClock.elapsedRealtime()
        // A host that switched back to BLE first may have sent before our LAN socket closed.
        if (seen == null && lanOffer == null && lanCapable && now >= lanAskAfter) {
            lanAskAfter = now + RESUME_BACKOFF_MS
            raw(msg(Proto.T.NET_LAN, "ask" to true))
        }
        val addresses = lanOffer?.addresses.orEmpty()
        resumeTried.keys.retainAll(addresses + listOfNotNull(seen?.first))
        // Try every offered address before repeating one, even if earlier dials took a long time.
        val address = seen?.first ?: addresses.minByOrNull { resumeTried[it] ?: Long.MIN_VALUE } ?: return@run
        val port = seen?.second ?: lanOffer?.port ?: return@run
        if (resumeTried[address]?.let { now - it < RESUME_BACKOFF_MS } == true) return@run
        resumeTried[address] = now
        val w = socket("wss://$address:$port", h.fp)
        pending = w
        // Bound the entire attempt, including a TCP peer that never finishes TLS or the upgrade.
        exec.schedule({ if (pending === w) { pending = null; w.cancel() } }, CONNECT_TIMEOUT_MS + Proto.TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun onLanOffer(m: JSONObject) {
        val port = m.opt("port") as? Int ?: return
        val list = m.optJSONArray("addresses") ?: return
        if (port !in 1..65535 || list.length() > MAX_LAN_ADDRESSES) return
        val addresses = (0 until list.length()).map { i ->
            val address = list.opt(i) as? String ?: return
            if (address.length !in 7..15) return
            val ip = runCatching { InetAddresses.parseNumericAddress(address) }.getOrNull() as? Inet4Address ?: return
            val linkLocal = ip.isLinkLocalAddress && (ip.address[2].toInt() and 255) in 1..254
            if (ip.hostAddress != address || !(ip.isSiteLocalAddress || linkLocal)) return
            address
        }
        lanOffer = LanOffer(addresses.distinct(), port)
        lanCapable = true
    }

    fun disconnect() {
        parting = true
        run {
            if (state == "connected" || helloSent) {
                host?.let { connectionObservations.closed(it.id, it.fp, "local", false, System.currentTimeMillis()) }
                raw(msg(Proto.T.BYE))
            }
            closeSocket()
            setState("idle", "")
        }
    }

    // Reconnect in the background is off and the screen went away before hello. The reclaim window
    // stays; this socket does not. After hello, leave the socket so Disconnect can still say bye.
    fun pauseConnecting() = run {
        if (parting || helloSent || state != "connecting") return@run
        lastCode = "paused"
        closeSocket()
        if (state != "idle") setState("idle", "")
    }

    // nonce: through the USB cable (WiredReceiver): pair.start carries it, which tells the computer
    // the request is from the phone on its cable, and the code is confirmed here without asking
    // (only the computer the phone allowed USB debugging for could have sent the nonce).
    // qr: the nonce came in the computer's QR code instead: the same, over the network.
    fun startPairing(address: String, port: Int, name: String, nonce: String = "", viaBle: Boolean = false, qr: Boolean = false) = run {
        parting = false // this is a newly requested pairing, after Core revoked the old return intent
        closeSocket()
        host = null
        wired = false
        ble = viaBle
        pairNonce = nonce
        pair = PairState("connecting", address, port, name, wired = nonce.isNotEmpty() && !qr, ble = viaBle, qr = qr)
        open("pair", address, port, null)
        events.onChange()
    }

    // Pairing through Bluetooth: shown at once while the pipe opens (Core.pair), then startPairing,
    // or failed with why.
    fun pairOpening(name: String) {
        pair = PairState("connecting", "", 0, name, ble = true)
        events.onChange()
    }

    fun pairUnreachable(error: String) = run { pairFailed(error) }

    fun confirmCode() = run {
        val p = pair ?: return@run
        if (p.phase != "code" || mode != "pair") return@run
        raw(msg(Proto.T.PAIR_CONFIRM))
        pair = p.copy(phase = "waiting")
        events.onChange()
    }

    fun cancelPairing() = run {
        val p = pair ?: return@run
        if (mode == "pair" && p.phase != "failed") raw(msg(Proto.T.PAIR_CANCEL))
        pair = null
        if (mode == "pair") closeSocket()
        events.onChange()
    }

    // The socket welcome authenticated, with the pair it authenticated. A later socket is a new one.
    class TrustedRoute(val marker: Any, val id: String, val fp: String) {
        internal fun matches(socket: Any, id: String, fp: String): Boolean =
            marker === socket && this.id == id && this.fp == fp && id.isNotEmpty() && fp.isNotEmpty()
    }

    private fun trustedRoute(w: WebSocket): TrustedRoute? {
        if (w !== ws) return null
        val h = host ?: return null
        if (parting || state != "connected" || h.id.isEmpty() || h.fp.isEmpty()) return null
        return TrustedRoute(w, h.id, h.fp)
    }

    internal fun currentTrustedRoute(): TrustedRoute? = ws?.let(::trustedRoute)

    fun accepts(route: TrustedRoute?): Boolean = matches(route) != null

    // Only on the socket that is still this route. A retired socket, or a pair that has since
    // connected, gets nothing: the caller keeps the bytes for a later consenting socket of this pair.
    fun sendFor(route: TrustedRoute?, m: JSONObject): Boolean {
        val w = matches(route) ?: return false
        return sendOn(w, m)
    }

    private fun matches(route: TrustedRoute?): WebSocket? {
        if (parting || route == null) return null
        val w = ws ?: return null
        val h = host ?: return null
        if (state != "connected" || !route.matches(w, h.id, h.fp)) return null
        return w
    }

    fun send(m: JSONObject): Boolean {
        val w = ws ?: return false
        if (state != "connected") return false
        return sendOn(w, m)
    }

    private fun sendOn(w: WebSocket, m: JSONObject): Boolean {
        val sent = w.send(m.toString())
        if (sent) markProbe()
        if (netemDial?.socket !== w) return sent
        val stage = when (m.optString("t")) {
            "screen.policy" -> "tx_screen_policy"
            "screen.ctl" -> "tx_screen_ctl"
            "rtc.answer" -> "tx_rtc_answer"
            Proto.T.PHONE_APPS -> "tx_phone_apps"
            else -> return sent
        }
        netemMark(w, stage, " queued=${if (sent) 1 else 0} queued_bytes=${w.queueSize()}")
        return sent
    }

    internal fun photoRoute(source: WebSocket): Boolean =
        !parting && connected && !ble && ws === source && host?.os == "mac"

    internal fun sendPhoto(m: JSONObject, source: WebSocket): Boolean =
        photoRoute(source) && source.send(m.toString()).also { if (it) markProbe() }

    // send() for the pointer's hot path (WebHost's TD.move): the line written into one builder, made
    // once. Never held for Wi-Fi (Netlink.holdOut holds only files). kind: 0 remote.mm, 1 remote.wh,
    // 2 in.mm (WebHost).
    private val hot = StringBuilder(96)
    fun sendMove(kind: Int, a: Double, b: Double, smooth: Boolean): Boolean {
        val w = ws ?: return false
        if (state != "connected" || !a.isFinite() || !b.isFinite()) return false
        val line = synchronized(hot) {
            val s = hot
            s.setLength(0)
            when (kind) {
                0 -> num(num(s.append("{\"t\":\"remote.mm\",\"dx\":"), a).append(",\"dy\":"), b).append(",\"smooth\":").append(smooth)
                1 -> num(num(s.append("{\"t\":\"remote.wh\",\"dx\":"), a).append(",\"dy\":"), b)
                2 -> num(num(s.append("{\"t\":\"in.mm\",\"x\":"), a).append(",\"y\":"), b)
                else -> return false
            }
            s.append('}').toString()
        }
        return w.send(line).also { if (it) markProbe() }
    }

    // A JSON number: a whole one without ".0" (as the page's JSON.stringify writes it).
    private fun num(s: StringBuilder, v: Double): StringBuilder {
        val l = v.toLong()
        return if (l.toDouble() == v && l > -1_000_000_000_000L && l < 1_000_000_000_000L) s.append(l) else s.append(v)
    }

    // Bytes queued on the socket (file sending waits while it is high).
    fun queued(): Long = ws?.queueSize() ?: 0

    // Bytes still queued on this exact socket. -1 when it is no longer the primary IP session.
    internal fun queuedFor(marker: Any?): Long {
        val w = ws ?: return -1
        if (marker == null || w !== marker || state != "connected" || parting || ble) return -1
        return w.queueSize()
    }

    // Camera backup only (PhotoBackup.kt). Unset on the phone-to-phone link, which keeps today's path.
    // The computer link drops backup frames that did not arrive on the primary IP socket.
    @Volatile var backupIngress: ((WebSocket, JSONObject) -> Unit)? = null
    var offerPhotoBackup: () -> Boolean = { false }

    // ---- socket ----

    private fun open(m: String, address: String, port: Int, pinFp: String?) {
        mode = m
        nw = ""
        seenFp = ""
        lastCode = null
        ws = socket("wss://$address:$port", pinFp)
    }

    // Where each socket goes ("address", port), for the session's other HTTPS calls (Mirror.kt).
    private val endOf = java.util.concurrent.ConcurrentHashMap<WebSocket, Pair<String, Int>>()

    // The session's socket now: its address and port (127.0.0.1 through the cable or Bluetooth).
    fun endpoint(): Pair<String, Int>? = ws?.let { endOf[it] }

    // A deferred viewer request belongs to the socket that delivered its offer.
    internal fun sendFor(marker: Any?, m: JSONObject): Boolean {
        val socket = ws ?: return false
        if (marker == null || socket !== marker || state != "connected" || parting) return false
        return sendOn(socket, m)
    }

    internal fun ownsVideoSession(marker: Any?): Boolean =
        !parting && connected && marker != null && ws === marker

    internal fun sessionMarker(): Any? = ws
    // Called synchronously before Core removes durable return intent. An already queued welcome
    // must not re-arm that intent after Stop, Forget or another explicit connection choice.
    internal fun invalidateReturn() { parting = true }
    internal fun canRememberReturn(h: Host, socket: Any?): Boolean = !parting && socket != null && ws === socket && state == "connected" && host?.id == h.id && host?.fp == h.fp

    // An HTTPS client for the session's computer, its certificate pinned as the session's is.
    fun https(): OkHttpClient? {
        val fp = host?.fp ?: return null
        return client(fp).newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(0, TimeUnit.MILLISECONDS).build()
    }

    internal fun lockSessionCurrent(marker: Any?): Boolean = connected && !parting && !ble && marker != null && ws === marker && host?.os == "mac"

    // Separate RFB channel on the authenticated socket's exact endpoint and certificate.
    // A ticket never selects a destination, and BLE is deliberately unsupported.
    internal fun openLockTunnel(ticket: String, marker: Any?, listener: WebSocketListener): WebSocket? {
        val source = ws ?: return null
        val pairedHost = host ?: return null
        if (source !== marker || !lockSessionCurrent(marker)) return null
        val fp = pairedHost.fp.takeIf { it.isNotBlank() } ?: return null
        val (address, port) = endOf[source] ?: return null
        if (ws !== source || host !== pairedHost || !lockSessionCurrent(marker)) return null
        val hostname = if (address.contains(':')) "[$address]" else address
        return client(fp).newWebSocket(Request.Builder().url("wss://$hostname:$port/lockview")
            .header("X-TwinDesk-Lock-Ticket", ticket).build(), listener)
    }

    // Fast files for the next file: the computer gave a token, and the session is on the network, a
    // cable or a Wi-Fi Direct group / hotspot (as the computers' fastfile.js usable()). Else the bytes
    // go as file.chunk. plain: unencrypted (FxHttp) to `address` on that port, with its own token;
    // null: HTTPS (client). fx2Port: the computer's files engine (fx2, Fx2.kt), 0 when there's none
    // (an older computer, or through the cable: adb reverse carries only the session's port);
    // plain.fx2Port: its plain server.
    class Fx(val base: String, val token: String, val client: OkHttpClient, val address: String, val plain: Plain?, val fx2Port: Int = 0) {
        class Plain(val port: Int, val token: String, val fx2Port: Int = 0)
    }

    fun fx(): Fx? {
        val token = fxToken
        if (state != "connected" || ble || token.isEmpty()) return null
        val (address, port) = endpoint() ?: return null
        val fp = host?.fp ?: return null
        val c = synchronized(this) {
            fxClient?.takeIf { it.first == fp }?.second ?: client(fp).newBuilder()
                .readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS) // the computer's IDLE_MS
                .build().also { fxClient = fp to it }
        }
        val h = if (address.contains(':')) "[$address]" else address
        // Not through the cable: adb reverse carries only the session's port.
        val plain = if (wired) null else fxPlain
        return Fx("https://$h:$port${Proto.FX_PATH}", token, c, address, plain, if (wired) 0 else fx2Port)
    }

    // Self-signed certificates: the fingerprint is the identity (pinned once paired).
    private fun socket(url: String, pinFp: String?): WebSocket {
        val w = client(pinFp).newWebSocket(Request.Builder().url(url).build(), Listener())
        Regex("^wss://([^:/]+):(\\d+)").find(url)?.let { endOf[w] = it.groupValues[1] to it.groupValues[2].toInt() }
        return w
    }

    private fun client(pinFp: String?): OkHttpClient {
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String?) {
                val fp = Proto.sha256(chain[0].encoded).hex()
                if (pinFp == null) seenFp = fp
                else if (fp != pinFp) throw CertificateException("identity changed")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder()
            .socketFactory(NoDelaySockets)
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    // ---- the resume socket and the fallback ----

    private fun gone(w: WebSocket, failure: String?) {
        lastRxOf.remove(w)
        lastPeerPingOf.remove(w)
        endOf.remove(w)
        when {
            w === pending -> pending = null
            w === alt -> { alt = null; events.onChange() }
            w === ws -> if (!(state == "connected" && fallBack())) onClose(failure)
        }
    }

    private fun onPendingOpen(w: WebSocket) {
        if (parting) { pending = null; w.cancel(); return }
        val h = host ?: return
        lastRxOf[w] = System.currentTimeMillis()
        w.send(msg(Proto.T.HELLO, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "token" to h.token, "resume" to resumeKey).toString())
    }

    // welcome {resumed}: the computer sends on the new socket from now on; so do we.
    private fun promote(w: WebSocket) {
        pending = null
        lanOffer = null
        lanAskAfter = 0L
        resumeTried.clear()
        alt?.cancel()
        alt = ws
        altBle = ble
        ws = w
        ble = false
        movedAt = System.currentTimeMillis()
        endOf[w]?.let { (address, port) ->
            host?.let { h ->
                if (h.address != address || h.port != port) {
                    h.address = address
                    h.port = port
                    store.putHost(h, hostsKey)
                }
            }
            Log.i("TwinDesk", "session moved to $address")
        }
        events.onChange()
    }

    // On the same Wi-Fi as the computer (Core.bleTick): the Bluetooth fallback goes once this path
    // has proven itself (on it FALLBACK_MS, answering). The Wi-Fi dropping then ends the session,
    // which comes back over Bluetooth (Core.resume).
    fun dropAlt() = run {
        val a = alt ?: return@run
        val w = ws ?: return@run
        val now = System.currentTimeMillis()
        if (ble || !altBle || now - movedAt < FALLBACK_MS || now - (lastRxOf[w] ?: 0L) > ANSWERING_MS) return@run
        alt = null
        lastRxOf.remove(a)
        lastPeerPingOf.remove(a)
        a.close(1000, null)
        Log.i("TwinDesk", "Bluetooth fallback closed. The connection remains on Wi-Fi")
        events.onChange()
    }

    // The session's socket closed: carry on through the other one if it's still there.
    private fun fallBack(): Boolean {
        val a = alt ?: return false
        alt = null
        ws = a
        ble = altBle
        Log.i("TwinDesk", "session back on ${if (ble) "Bluetooth" else "the network"}")
        events.onChange()
        return true
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = run {
            if (webSocket === ws) onOpen() else if (webSocket === pending) onPendingOpen(webSocket)
        }
        override fun onMessage(webSocket: WebSocket, text: String) = run {
            lastRxOf[webSocket] = System.currentTimeMillis()
            if (webSocket === pending) {
                val m = runCatching { JSONObject(text) }.getOrNull()
                if (!parting && m?.optString("t") == Proto.T.WELCOME && m.optBoolean("resumed")) promote(webSocket)
                else { pending = null; webSocket.cancel() }
            } else if (webSocket === ws || webSocket === alt) onText(text, webSocket)
        }
        // The computer closed it (Disconnect, Forget…): answer at once. OkHttp waits for us to,
        // and until then neither side saw the session end.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = run {
            webSocket.close(1000, null)
            gone(webSocket, null)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = run { gone(webSocket, null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = run {
            if (webSocket !== ws) return@run gone(webSocket, t.message)
            lastRxOf.remove(webSocket)
            lastPeerPingOf.remove(webSocket)
            if (state == "connected" && fallBack()) return@run
            onClose(if (generateSequence(t) { it.cause }.any { it is CertificateException }) "identity" else t.message ?: "failed")
        }
    }

    private fun onOpen() {
        lastRx = System.currentTimeMillis()
        if (mode == "pair") {
            nw = Proto.randomHex(16)
            val start = msg(Proto.T.PAIR_START, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "commit" to Proto.commitOf(nw))
            if (pairNonce.isNotEmpty()) start.put("wired", pairNonce)
            raw(start)
            pair = pair?.copy(phase = "starting")
            events.onChange()
            return
        }
        hello()
    }

    private fun hello() {
        val h = host ?: return
        val allow = dialAdmit
        // Disconnect or a background pause invalidated this automatic dial. Do not send.
        // denyCode is "local" (do not retry) or "paused" (the screen left; the window stays).
        if (allow != null && !allow()) {
            lastCode = denyCode
            ws?.cancel()
            return
        }
        // rc and resume together: an older host treats hello+resume
        // as a socket move and refuses it. A plain phone hello would take whatever session it holds.
        raw(msg(Proto.T.HELLO, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "token" to h.token, "fx" to 1, "fxPlain" to 1).apply {
            put("pa", 1)
            if (netemDial?.let { it.socket === ws } == true) put("netem", 1)
            if (offerPhotoBackup() && h.os == "mac") put("pb", 1)
            if (!wired) put("fx2", 1)
            if (reclaimHello) { put("rc", 1); put("resume", "0") }
        })
        helloSent = true
        helloTimer?.cancel(false)
        helloTimer = exec.schedule({ if (state != "connected") { message = tr("No answer"); ws?.cancel() } }, if (ble) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun onText(text: String, ingress: WebSocket) {
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return
        val t = m.optString("t")
        lastRx = System.currentTimeMillis()
        // Other frames still arrive on the fallback socket. Backup frames do not: the socket they
        // came in on used to be discarded before Core.post, so a retired path could stop the new one.
        if (t.startsWith("backup.")) {
            val hook = backupIngress
            if (hook != null) {
                if (ingress === ws && !ble && state == "connected" && !parting) {
                    runCatching { hook(ingress, m) }.onFailure { Log.w("TwinDesk", "photo backup", it) }
                }
                return
            }
        }
        when (t) {
            Proto.T.PAIR_NONCE -> return onNonce(m)
            Proto.T.PAIR_OK -> return onPairOk(m)
            Proto.T.PAIR_CANCEL -> return pairFailed(tr("Pairing was cancelled on the computer."))
            Proto.T.WELCOME -> return onWelcome(m)
            Proto.T.ERROR -> return onError(m)
            Proto.T.NET_LAN -> {
                if (ingress === ws && !parting && connected && ble && resumeKey.isNotEmpty()) onLanOffer(m)
                return
            }
            Proto.T.PING -> {
                if (state == "connected") {
                    // This ping already proved the socket. beat() holds our own until the interval
                    // runs out, so a live computer is the only side that pings. The pong is unchanged.
                    lastPeerPingOf[ingress] = System.currentTimeMillis()
                    raw(msg(Proto.T.PONG, "ts" to m.opt("ts")))
                    beat()
                }
                return
            }
            Proto.T.PONG -> { if (m.has("ts")) rttMs = maxOf(0, System.currentTimeMillis() - m.optLong("ts")); return }
            QUIET_IDLE -> {
                if (state == "connected") {
                    val wasIdle = peerIdle
                    val wasPerf = peerPerf
                    val wasKeep = peerKeep
                    peerIdle = m.optBoolean("on")
                    if (m.optInt("perf") == 1) peerPerf = true
                    peerKeep = m.optInt("keep") == 1
                    if (wasIdle != peerIdle || wasPerf != peerPerf || wasKeep != peerKeep) nudge()
                }
                return
            }
        }
        if (state == "connected") {
            if (t == "rtc.offer") netemMark(ingress, "rx_rtc_offer")
            events.onMessage(m, trustedRoute(ingress), ingress)
        }
    }

    private fun onNonce(m: JSONObject) {
        val p = pair ?: return
        val nonce = m.optString("nonce")
        if (mode != "pair" || nw.isEmpty() || !Regex("^[0-9a-f]{32,128}$").matches(nonce) || nonce.length % 2 != 0) {
            return pairFailed(tr("The computer sent an invalid pairing response."))
        }
        raw(msg(Proto.T.PAIR_REVEAL, "nonce" to nw))
        pair = p.copy(phase = "code", code = Proto.sasCode(seenFp, nw, nonce))
        if (p.wired || p.qr) {
            raw(msg(Proto.T.PAIR_CONFIRM))
            pair = pair?.copy(phase = "waiting")
        }
        events.onChange()
    }

    private fun onPairOk(m: JSONObject) {
        val p = pair ?: return
        if (mode != "pair" || p.phase != "waiting") return
        val token = m.optString("token")
        val id = m.optString("macId")
        if (token.isEmpty() || id.isEmpty()) return pairFailed(tr("The computer sent an invalid pairing response."))
        // Through the cable the address is this phone's own end of adb reverse: the computer's
        // network address comes from discovery when it's seen (Core.connect), else the cable again.
        // Through Bluetooth likewise: no network address yet (Core keeps the pipe for it).
        val h = if (p.wired || p.ble) Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), "127.0.0.1", Proto.PORT, seenFp, token, System.currentTimeMillis())
            else Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), p.address, p.port, seenFp, token, System.currentTimeMillis())
        store.putHost(h, hostsKey)
        pair = null
        mode = "session"
        host = h
        wired = p.wired
        ble = p.ble
        setState("connecting", "")
        hello()
    }

    private fun onWelcome(m: JSONObject) {
        if (mode != "session" || state == "connected") return
        helloTimer?.cancel(false)
        val h = host ?: return
        if (parting) {
            lastCode = "local"
            if (helloSent) raw(msg(Proto.T.BYE))
            val rejected = ws
            rejected?.close(1000, "disconnected")
            exec.schedule({ if (ws === rejected) rejected?.cancel() }, 2, TimeUnit.SECONDS)
            return
        }
        // Check the current return intent before welcome becomes a session. A refused late
        // welcome still closes gracefully after BYE, so the Mac can drop its temporary grace.
        if (reclaimHello) {
            val allow = dialAdmit
            if (allow != null && !allow()) {
                lastCode = denyCode
                reclaimHello = false
                dialAdmit = null
                val rejected = ws
                if (helloSent) {
                    raw(msg(Proto.T.BYE, "retry" to !parting))
                    rejected?.close(1000, "return cancelled")
                    exec.schedule({ if (ws === rejected) rejected?.cancel() }, 2, TimeUnit.SECONDS)
                } else rejected?.cancel()
                return
            }
        }
        // Reclaim must be the paired Mac we dialed. A welcome for anyone else is refused, and the
        // pairing is kept (BAD_TOKEN is what forgets it).
        if ((reclaimHello || netemDial != null) && m.optString("macId") != h.id) {
            lastCode = "reclaim"
            message = tr("{name} didn’t confirm this pairing. Use Connect to try again.", "name" to h.name)
            reclaimHello = false
            ws?.cancel()
            return
        }
        canReclaim = m.optInt("rc", 0) == 1 && h.os in Core.RETURN_OS
        appsReady = h.os == "mac" && m.opt("pa") == 1
        reclaimHello = false
        m.optString("macName").takeIf { it.isNotEmpty() }?.let { h.name = it.take(64) }
        if (m.has("tail")) h.tail = Tailnet.clean(m.optJSONArray("tail")) // its Tailscale addresses (Tailnet.kt)
        if (m.has("relay")) h.relay = RelayInfo.from(m.optJSONObject("relay")) // its own relay, or none now (Relay.kt)
        h.lastSeen = System.currentTimeMillis()
        // Through the relay: this attempt's address is the local pipe, never the computer's to keep.
        val kept = if (h.address == "127.0.0.1" && h.port in Relay.ports) store.hosts().find { it.id == h.id } else null
        store.putHost(if (kept != null) h.copy(address = kept.address, port = kept.port) else h, hostsKey)
        rttMs = null
        resumeKey = m.optString("resume")
        fxToken = m.optString("fx").takeIf { Regex("^[0-9a-f]{32}$").matches(it) } ?: ""
        fxPlain = m.optJSONObject("fxPlain")?.let { p ->
            val port = p.optInt("port", 0)
            val token = p.optString("token")
            val p2 = p.optInt("fx2Port", 0).takeIf { it in 1..65535 } ?: 0
            if (port in 1..65535 && Regex("^[0-9a-f]{32}$").matches(token)) Fx.Plain(port, token, p2) else null
        }
        fx2Port = m.optJSONObject("fx2")?.optInt("port", 0)?.takeIf { it in 1..65535 && fxToken.isNotEmpty() } ?: 0
        ws?.let { lastRxOf[it] = System.currentTimeMillis() }
        // Each of the session's sockets on its own: a quiet fallback goes, the session lives on.
        peerIdle = false
        peerPerf = false
        peerKeep = false
        lastPeerPingOf.clear()
        saidSig = ""
        idleTrue = false
        idlePerf = false
        quietSince = 0L
        quietEnd = 0L
        quietPing = 0L
        perfSince = 0L
        perfPing = 0L
        perfEnd = 0L
        probeAt = 0L
        probed = false
        lastUse = System.currentTimeMillis()
        scheduleBeat(Proto.PING_MS)
        setState("connected", "")
        netemElapsed(ws)?.let { Log.i("TwinDeskNetem", "welcome_ms=$it") }
        peerBackup = m.opt("pb") == 1
        events.onWelcome(h)
    }

    private fun cancelBeat() {
        beatDue = Long.MAX_VALUE
        pinger?.cancel(false)
        pinger = null
        quietAlarm?.let { alarms?.cancel(it) }
        quietAlarm = null
    }

    private fun scheduleBeat(delay: Long, quiet: Boolean = delay > Proto.PING_MS) {
        cancelBeat()
        val due = SystemClock.elapsedRealtime() + delay
        if (quiet) {
            beatDue = due
            val alarm = AlarmManager.OnAlarmListener { checkBeatDeadline() }
            runCatching {
                alarms?.setExact(AlarmManager.ELAPSED_REALTIME, due, "TwinDesk:quiet", alarm, alarmHandler)
                quietAlarm = alarm
            }
        }
        pinger = exec.schedule({ beat() }, delay, TimeUnit.MILLISECONDS)
    }

    // Discovery already runs while the process is awake. It also covers alarm deferral by Android.
    internal fun checkBeatDeadline() {
        if (SystemClock.elapsedRealtime() < beatDue) return
        run { if (SystemClock.elapsedRealtime() >= beatDue) beat() }
    }

    // Each of the session's sockets on its own: a quiet fallback goes, the session lives on.
    private var beatFailures = 0
    private var lastBeatError = -60_000L

    private fun beat() {
        if (state != "connected") return
        var delay = Proto.PING_MS
        var failed = false
        try {
            delay = beatConnected()
            beatFailures = 0
        } catch (e: Exception) {
            failed = true
            delay = (Proto.PING_MS shl beatFailures).coerceAtMost(30_000L)
            beatFailures = (beatFailures + 1).coerceAtMost(5)
            val now = SystemClock.elapsedRealtime()
            if (now - lastBeatError >= 60_000L) {
                lastBeatError = now
                Log.e("TwinDesk", "link heartbeat", e)
            }
        } finally {
            // The 3 s tier must not take the quiet alarm: that alarm is for the multi-minute sleep.
            if (state == "connected") scheduleBeat(delay.coerceAtLeast(1L), !failed && beatAlarm && delay > Proto.PING_MS)
        }
    }

    private fun beatConnected(): Long {
        val now = System.currentTimeMillis()
        beatAlarm = false
        sayIdle(now)
        val peerWantsPerf = peerKeep && peerPerf
        // 3 s / 10 s only when nothing is live, the peer said idle, and one end's only reason is
        // Prioritize performance, and the peer sent perf:1. Otherwise today's rules.
        val perfNow = !ble && peerIdle && peerPerf && (idlePerf || (idleTrue && peerWantsPerf))
        val quietNow = !perfNow && quietLink(idleTrue && !peerWantsPerf, peerIdle, ble)
        if (perfNow && perfSince == 0L) {
            if (quietSince != 0L) { quietSince = 0L; quietEnd = now; probeAt = 0L; probed = false }
            perfSince = now
            Log.i("TwinDesk", "link idle, performance: pings every ${Proto.PING_MS_IDLE_PERF / 1000} s")
        }
        if (!perfNow && perfSince != 0L) {
            perfSince = 0L
            perfPing = 0L
            perfEnd = now
            // The same beat can enter the 5 min quiet. "link active" would be a lie in front of "link quiet".
            if (!quietNow) Log.i("TwinDesk", "link active: pings every second")
        }
        if (quietNow && quietSince == 0L) { quietSince = now; Log.i("TwinDesk", "link quiet: pings every ${QUIET_PING_MS / 60000} min") }
        if (!quietNow && quietSince != 0L) { quietSince = 0L; quietEnd = now; probeAt = 0L; probed = false; Log.i("TwinDesk", "link active: pings every second") }
        var primaryRx = lastRx
        for (w in listOfNotNull(ws, alt)) {
            val onBle = if (w === ws) ble else altBle
            val limit = if (onBle) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS
            var rx = maxOf(lastRxOf[w] ?: lastRx, if (onBle) bleRx() else 0L, if (onBle) 0L else maxOf(quietEnd, perfEnd))
            if (!onBle && perfNow) {
                if (quietEnd == now || perfEnd == now) rx = maxOf(rx, now) // a tier change does not inherit the old silence
                if (w === ws) primaryRx = rx
                if (now - rx > Proto.TIMEOUT_MS_IDLE_PERF) {
                    Log.i("TwinDesk", "network socket silent for ${now - rx} ms on an idle performance link, closing")
                    if (w === ws && alt == null) message = tr("Not responding")
                    w.cancel()
                    continue
                }
                val interval = Proto.PING_MS_IDLE_PERF
                if (ownPingWanted(w, now, interval, now - maxOf(perfPing, perfSince) >= interval, perfPing)) {
                    perfPing = now
                    w.send(msg(Proto.T.PING, "ts" to now).toString())
                }
                continue
            }
            if (!onBle && quietNow) {
                if (w === ws && probeAt != 0L) { // something went out while quiet: is anyone there?
                    if (rx >= probeAt) { probeAt = 0L; probed = false }
                    else if (!probed) {
                        // The probe is the question. A recent computer ping does not replace it.
                        probed = true
                        quietPing = now
                        w.send(msg(Proto.T.PING, "ts" to now).toString())
                        if (w === ws) primaryRx = rx
                        continue
                    } else if (now - probeAt > Proto.TIMEOUT_MS) {
                        Log.i("TwinDesk", "no answer on a quiet link, closing")
                        if (alt == null) message = tr("Not responding")
                        w.cancel()
                        continue
                    } else {
                        if (w === ws) primaryRx = rx
                        continue
                    }
                }
                if (w === ws) primaryRx = rx
                if (now - rx > QUIET_TIMEOUT_MS) {
                    Log.i("TwinDesk", "network socket silent for ${now - rx} ms on a quiet link, closing")
                    if (w === ws && alt == null) message = tr("Not responding")
                    w.cancel()
                } else {
                    val interval = QUIET_PING_MS
                    if (ownPingWanted(w, now, interval, now - maxOf(quietPing, quietSince) >= interval, quietPing)) {
                        quietPing = now
                        w.send(msg(Proto.T.PING, "ts" to now).toString())
                    }
                }
                continue
            }
            if (w === ws) primaryRx = rx
            if (now - rx > limit) {
                Log.i("TwinDesk", "${if (onBle) "Bluetooth" else "network"} socket silent for ${now - rx} ms, closing")
                if (w === ws && alt == null) message = tr("Not responding")
                w.cancel()
            } else if (ownPingWanted(w, now, Proto.PING_MS, true, 0L)) {
                w.send(msg(Proto.T.PING, "ts" to now).toString())
            }
        }
        beatAlarm = quietNow && alt == null && probeAt == 0L
        // A fallback socket, or a probe still out, stays on the 1 s timer: that is what notices it.
        if (alt != null || probeAt != 0L) return Proto.PING_MS
        val peerAt = ws?.let { lastPeerPingOf[it] } ?: 0L
        // The 1 s tier keeps its 1 s timer whenever we sent (or had nothing to skip). A fresh
        // computer ping is the one case that pushes the next wake out to the end of that window
        // (interval plus jitter grace), still no later than the silence limit. A socket we are
        // already closing stays on 1 s too.
        if (!perfNow && !quietNow) {
            val peerWindow = Proto.PING_MS + peerGrace(Proto.PING_MS)
            val fresh = peerAt != 0L && now >= peerAt && now - peerAt < peerWindow
            if (!fresh) return Proto.PING_MS
            val limit = if (ble) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS
            return quietBeatDelay(peerAt + peerWindow, primaryRx + limit + 1, now)
        }
        val interval = if (perfNow) Proto.PING_MS_IDLE_PERF else QUIET_PING_MS
        val peerWindow = interval + peerGrace(interval)
        val fresh = peerAt != 0L && now >= peerAt && now - peerAt < peerWindow
        val pingAt = if (fresh) peerAt + peerWindow else if (perfNow) maxOf(perfPing, perfSince) + interval else maxOf(quietPing, quietSince) + interval
        val expires = if (perfNow) maxOf(primaryRx, perfEnd) + Proto.TIMEOUT_MS_IDLE_PERF + 1
            else maxOf(primaryRx, quietEnd) + QUIET_TIMEOUT_MS + 1
        return quietBeatDelay(pingAt, expires, now)
    }

    // A computer ping stays fresh for interval + a little slack, so ordinary Wi-Fi and timer
    // jitter does not wake the phone to send the ping the computer is about to send. The slack
    // stays inside the silence timeout (1.5 s < 8 s, 4 s < 10 s, 310 s < 660 s).
    private fun peerGrace(interval: Long): Long = when (interval) {
        Proto.PING_MS -> 500L
        Proto.PING_MS_IDLE_PERF -> 1_000L
        QUIET_PING_MS -> 10_000L
        else -> 0L
    }

    // Skip our ping while the computer's is still inside this window. Once that window has
    // passed, send on this beat (not a beat later), unless we already sent one in the interval.
    // A backward wall-clock step (peerAt or sentAt in the future) is not fresh. sentAt 0: the
    // 1 s tier, which sends on every beat when the computer has not just pinged.
    // A quiet probe does not come through here.
    private fun ownPingWanted(w: WebSocket, now: Long, interval: Long, cadenceDue: Boolean, sentAt: Long): Boolean {
        val peerAt = lastPeerPingOf[w] ?: 0L
        val peerWindow = interval + peerGrace(interval)
        if (peerAt != 0L && now >= peerAt && now - peerAt < peerWindow) return false
        if (sentAt != 0L && now >= sentAt && now - sentAt < interval) return false
        if (peerAt != 0L) return true
        return cadenceDue
    }

    private val pairErrors get() = mapOf(
        Proto.E.PAIR_REFUSED to tr("Pairing was refused."),
        Proto.E.PAIR_TIMEOUT to tr("Pairing timed out."),
        Proto.E.BUSY to tr("That computer is busy pairing with another device."),
        Proto.E.VERSION_MISMATCH to tr("That computer runs a different version of TwinDesk. Update both devices."),
    )

    private fun onError(m: JSONObject) {
        val code = m.optString("code")
        lastCode = code
        if (mode == "pair") return pairFailed(pairErrors[code] ?: tr("Pairing failed ({code}).", "code" to code))
        message = when (code) {
            Proto.E.BAD_TOKEN -> tr("{name} forgot this phone. Pair again.", "name" to (host?.name ?: tr("The computer")))
            Proto.E.BUSY -> m.optString("message").ifEmpty { tr("Busy with another device") }
            Proto.E.REPLACED -> m.optString("message").ifEmpty { tr("Another device connected") }
            Proto.E.RELEASED -> tr("Disconnected from {name}", "name" to (host?.name ?: tr("the computer")))
            Proto.E.ASLEEP -> tr("{name} is asleep", "name" to (host?.name ?: tr("The computer")))
            else -> tr("Closed ({code})", "code" to code)
        }
        if (code == Proto.E.BAD_TOKEN) host?.let { store.forgetHostClearingCredentials(it.id, hostsKey) }
    }

    private fun pairFailed(error: String) {
        val p = pair ?: return
        pair = p.copy(phase = "failed", error = error, code = "")
        closeSocket()
        events.onChange()
    }

    private fun dropOthers() {
        resumeKey = ""
        lanOffer = null
        lanCapable = false
        lanAskAfter = 0L
        resumeTried.clear()
        alt?.cancel()
        alt = null
        pending?.cancel()
        pending = null
        lastRxOf.clear()
        lastPeerPingOf.clear()
    }

    private fun onClose(failure: String?) {
        Log.i("TwinDesk", "link closed: mode=$mode state=$state ble=$ble failure=$failure code=$lastCode")
        val wasReclaim = reclaimHello
        cancelBeat()
        quietSince = 0L
        helloTimer?.cancel(false)
        reclaimHello = false
        dialAdmit = null
        helloSent = false
        ws = null
        appsReady = false
        netemDial = null
        fxToken = ""
        fxPlain = null
        fx2Port = 0
        peerBackup = false
        dropOthers()
        if (mode == "pair") {
            val p = pair
            if (p != null && p.phase != "failed") {
                pairFailed(if (p.phase == "connecting") tr("Couldn’t connect to {address}{reason}.", "address" to p.address, "reason" to (failure?.let { " ($it)" } ?: "")) else tr("The connection closed."))
            }
            return
        }
        val was = state
        host?.let { connectionObservations.closed(it.id, it.fp, lastCode, failure == "identity", System.currentTimeMillis()) }
        if (failure == "identity" && !wasReclaim) {
            setState("failed", tr("{name} looks different now. Forget it and pair again.", "name" to (host?.name ?: tr("The computer"))))
        } else if (failure == "identity") {
            // Discovery is unauthenticated. An unrelated computer at a candidate address must
            // not erase the saved pairing or its return intent; another candidate may be genuine.
            setState("idle", tr("Reconnecting…"))
        } else {
            if (message.isEmpty() && failure != null && lastCode != "paused") message = failure
            setState(if (was == "connected" || was == "connecting") "idle" else was, message)
        }
        host?.let { events.onClosed(it, lastCode) }
    }

    private fun closeSocket() {
        cancelBeat()
        helloTimer?.cancel(false)
        reclaimHello = false
        dialAdmit = null
        helloSent = false
        val w = ws
        ws = null
        appsReady = false
        netemDial = null
        fxToken = ""
        fxPlain = null
        fx2Port = 0
        peerBackup = false
        dropOthers()
        val wasConnected = state == "connected"
        if (wasConnected) state = "idle"
        w?.close(1000, null)
        if (wasConnected) host?.let { events.onClosed(it, "local") }
    }

    private fun raw(m: JSONObject) {
        ws?.send(m.toString())
    }

    private fun setState(s: String, msg: String) {
        state = s
        message = msg
        events.onChange()
    }
}

// The session's sockets without Nagle: input (a pen's 120–240 samples a second, pointer moves) goes
// out at once instead of waiting for the computer to acknowledge what went before (40–200 ms with
// its delayed ACKs). OkHttp leaves Nagle on; the TLS socket is layered over these.
private object NoDelaySockets : javax.net.SocketFactory() {
    private val base = javax.net.SocketFactory.getDefault()
    private fun nd(s: java.net.Socket) = s.apply { runCatching { tcpNoDelay = true } }
    override fun createSocket() = nd(base.createSocket())
    override fun createSocket(host: String?, port: Int) = nd(base.createSocket(host, port))
    override fun createSocket(host: String?, port: Int, localHost: java.net.InetAddress?, localPort: Int) = nd(base.createSocket(host, port, localHost, localPort))
    override fun createSocket(host: java.net.InetAddress?, port: Int) = nd(base.createSocket(host, port))
    override fun createSocket(address: java.net.InetAddress?, port: Int, localAddress: java.net.InetAddress?, localPort: Int) = nd(base.createSocket(address, port, localAddress, localPort))
}
