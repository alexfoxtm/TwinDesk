// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared folders with the computer, both ways (shared/foldershare.js there). On USB, Wi-Fi or
// Wi-Fi Direct; through Bluetooth neither runs. The computer can also share over TwinDesk Network.
//   - This phone's folder there: switched on in File access, the folder chosen (TwinDesk in the
//     phone's storage unless another is) is served over WebDAV (Dav.kt) and the computer mounts it
//     in its file manager (share.offer). Needs All files access: TwinDesk reads and writes the files
//     itself. Offered again whenever the session moves (Bluetooth <-> Wi-Fi, the cable).
//   - The computer's folder here: when it shares one (share.host), it shows in Android's Files app
//     and every app's file picker (PcShareProvider.kt), until the session ends.
package com.twindesk.android

import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.security.auth.x500.X500Principal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64

private const val FOLDER_IDLE_MS = 10 * 60_000L // Wi-Fi Direct for the computer's folder: this long after it was last used

class FolderShare(core: Core) : Feature(core) {
    // Direct HTTPS uses the paired certificate. TwinDesk Network uses the exact control route.
    data class Pc(
        val host: String, val port: Int, val token: String, val name: String, val fp: String,
        val embeddedRoute: Link.TrustedRoute? = null,
    )

    private val embeddedToken = Regex("[a-f0-9]{32}")

    private val pcLock = Any()
    @Volatile var pc: Pc? = null; private set
    @Volatile var pcServe = false; private set // the computer's folder switched on (its setting, either side)
    @Volatile private var dav: Dav? = null
    @Volatile private var davRoute: Link.TrustedRoute? = null
    @Volatile var error = ""; private set
    @Volatile private var secret = Proto.randomHex(16)
    private var lastLink = ""

    val on get() = core.store.flag("shareOn", false)
    val folder: File get() = core.store.prefsString("shareFolder", "").let { if (it.isEmpty()) File(Environment.getExternalStorageDirectory(), "TwinDesk") else File(it) }
    val serving get() = dav != null
    val allowed get() = FsBrowse.allowed()

    // ~ for the phone's storage, in what's shown.
    fun shown(f: File = folder) = f.path.replace(Environment.getExternalStorageDirectory().path, tr("Phone storage"))

    override fun onWelcome(host: Host) {
        lastLink = ""
        pcServe = false
        setPc(null)
        linkChanged()
    }

    override fun onClosed() {
        lastLink = ""
        opening = false
        core.bg.execute { stopDav() }
        setPc(null)
    }

    override fun onMessage(t: String, m: JSONObject): Boolean = onMessage(t, m, null, false)

    internal fun onMessage(t: String, m: JSONObject, route: Link.TrustedRoute?, fromEmbedded: Boolean): Boolean {
        if (t == "embedded.dav.open") {
            val current = dav
            val expected = davRoute
            val key = m.opt("key") as? String
            val token = m.opt("share")
            if (fromEmbedded && route != null && current != null && expected != null && key != null &&
                expected.matches(route.marker, route.id, route.fp) && token == secret) {
                core.link.openEmbeddedDav(route, key, current.port) {
                    dav === current && davRoute === expected && token == secret && on && allowed
                }
            }
            return true
        }
        if (t != Proto.T.SHARE_HOST) return false
        if (fromEmbedded) {
            if (route == null || !core.link.isEmbeddedRoute(route) || m.opt("embedded") != 1) return true
            pcServe = m.optBoolean("serve", m.optBoolean("on"))
            val token = m.opt("token") as? String
            // Repeated announcements on the same socket keep existing Files opens valid.
            val owner = pc?.embeddedRoute?.takeIf { it.matches(route.marker, route.id, route.fp) } ?: route
            val name = m.str("name", 80).ifEmpty { "Computer" }
            setPc(if (m.optBoolean("on") && token != null && embeddedToken.matches(token))
                Pc("", 0, token, name, route.fp, owner) else null)
            return true
        }
        if (core.link.embedded || m.opt("embedded") == 1) return true
        pcServe = m.optBoolean("serve", m.optBoolean("on"))
        val port = m.optInt("port")
        val token = m.str("token", 64)
        val h = core.link.host
        val host = if (core.link.wired) "127.0.0.1" else h?.address ?: ""
        setPc(if (m.optBoolean("on") && port in 1..65535 && token.matches(Regex("[a-f0-9]{16,64}")) && host.isNotEmpty() && h != null && !core.link.ble) Pc(host, port, token, m.str("name", 80).ifEmpty { "Computer" }, h.fp) else null)
        return true
    }

    // Open on the computer's folder through Bluetooth: Wi-Fi Direct first, then the Files app once it's there.
    @Volatile var opening = false; private set
    fun openOverWifi() {
        opening = true
        core.net.need("folder", FOLDER_IDLE_MS)
        core.changed()
    }

    private fun setPc(p: Pc?, expected: Pc? = null) {
        synchronized(pcLock) {
            if (p == pc || (expected != null && pc !== expected)) return
            if (p?.embeddedRoute?.let(core.link::isEmbeddedRoute) == false) return
            pc = p
        }
        if (p != null && opening) { opening = false; openPcShare(core.ctx) }
        runCatching { core.ctx.contentResolver.notifyChange(DocumentsContract.buildRootsUri(PcShareProvider.authority(core.ctx)), null) }
        core.changed()
    }

    // The session started, moved or dropped (Link's onChange): offer again when its way changed.
    fun linkChanged() {
        val p = pc
        val owner = p?.embeddedRoute
        if (p != null && (core.link.ble || core.link.embedded != (owner != null) ||
            (owner != null && !core.link.isEmbeddedRoute(owner)))) setPc(null, expected = p)
        val key = "${core.link.connected}|${core.link.ble}|${core.link.wired}|${core.link.embedded}|${core.link.host?.address}"
        if (key == lastLink) return
        lastLink = key
        core.bg.execute { sync() }
    }

    // Serving while on, allowed and not through Bluetooth; the computer hears either way.
    @Synchronized
    fun sync() {
        val route = core.link.currentTrustedRoute()?.takeIf(core.link::embeddedMediaReady)
        val live = core.link.connected && !core.link.ble && (!core.link.embedded || route != null)
        val want = live && on && allowed
        fun offer(m: JSONObject) {
            if (route != null) core.link.sendFor(route, m.put("embedded", 1)) else core.send(m)
        }
        error = ""
        if (want) {
            runCatching {
                val f = folder
                if (!f.isDirectory && !f.mkdirs()) throw Exception("can’t make ${shown(f)}")
                if (davRoute?.marker !== route?.marker) {
                    stopDav()
                    secret = Proto.randomHex(16)
                }
                val token = secret
                val access: (InetAddress) -> Boolean = if (route == null) ::fromComputer else { addr ->
                    addr.isLoopbackAddress && davRoute?.marker === route.marker && core.link.isEmbeddedRoute(route) &&
                        secret == token && on && allowed && folder == f
                }
                val d = dav ?: Dav(f, token, volumeName(f), ShareKey.ssl(), access).also {
                    davRoute = route
                    it.start(loopbackOnly = route != null)
                    dav = it
                }
                offer(msg(Proto.T.SHARE_OFFER, "on" to true, "port" to d.port, "secret" to token, "name" to volumeName(f), "cert" to ShareKey.cert()))
            }.onFailure {
                Log.w("TwinDesk", "share: $it")
                error = it.message ?: "didn’t start"
                stopDav()
                offer(msg(Proto.T.SHARE_OFFER, "on" to false))
            }
        } else {
            stopDav()
            // Through Bluetooth: shared all the same, opened there over Wi-Fi Direct (foldershare.js).
            val ble = core.link.connected && core.link.ble && on && allowed
            if (core.link.connected) offer(if (ble) msg(Proto.T.SHARE_OFFER, "on" to false, "wifi" to true, "name" to volumeName(folder)) else msg(Proto.T.SHARE_OFFER, "on" to false))
        }
        core.changed()
    }

    // The computer in the session: its address, or (the cable) adb forward's, from 127.0.0.1.
    private fun fromComputer(a: InetAddress): Boolean {
        if (!core.link.connected || core.link.ble || core.link.embedded) return false
        if (core.link.wired) return a.isLoopbackAddress
        val h = core.link.host?.address ?: return false
        return runCatching { InetAddress.getByName(h) == a }.getOrDefault(false)
    }

    // What the computer calls the volume: the folder's name, as foldershare.js would clean it (the
    // Dav path has it too, so both must agree).
    private fun volumeName(f: File) = f.name.replace(Regex("[/:\\\\\"<>|?*%#]"), " ").replace(Regex("\\s+"), " ").trim().take(60).ifEmpty { "Phone" }

    @Synchronized
    private fun stopDav() {
        davRoute = null
        dav?.stop()
        dav = null
    }

    // The computer's folder on or off, from here (the computer keeps it, and answers with share.host).
    fun setPcServe(v: Boolean) {
        pcServe = v
        if (!v) { opening = false; core.net.release("folder") }
        core.send(msg(Proto.T.SHARE_SET, "serve" to v))
        core.changed()
    }

    fun setOn(v: Boolean) {
        core.store.setFlag("shareOn", v)
        core.bg.execute { sync() }
        core.changed()
    }

    // A folder from the system's picker (a tree in the phone's storage or an SD card).
    fun choose(tree: Uri) {
        val id = runCatching { DocumentsContract.getTreeDocumentId(tree) }.getOrNull() ?: return
        val vol = id.substringBefore(':')
        val rest = id.substringAfter(':', "")
        val base = if (vol == "primary") Environment.getExternalStorageDirectory() else File("/storage/$vol")
        val f = if (rest.isEmpty()) base else File(base, rest)
        core.store.setPrefsString("shareFolder", f.path)
        // A new folder is a new volume: a new server, so the computer mounts it afresh.
        core.bg.execute {
            synchronized(this) { stopDav(); secret = Proto.randomHex(16) }
            sync()
        }
        core.changed()
    }
}

// This phone's key for the shared folder's TLS: made once in Android's keystore (it never leaves
// it), with a certificate signed by itself, which the computer pins (it comes through the session).
object ShareKey {
    private const val ALIAS = "twindesk-share"

    private fun store(): KeyStore {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                        .setCertificateSubject(X500Principal("CN=TwinDesk phone"))
                        .setCertificateNotBefore(Date(System.currentTimeMillis() - 86_400_000L))
                        .setCertificateNotAfter(Date(4_102_444_800_000L)) // 2100
                        .build(),
                )
                generateKeyPair()
            }
        }
        return ks
    }

    private fun chain(): Array<X509Certificate> = arrayOf(store().getCertificate(ALIAS) as X509Certificate)

    // Its certificate, DER in base64 (share.offer).
    fun cert(): String = Base64.encodeToString(chain()[0].encoded, Base64.NO_WRAP)

    fun ssl(): SSLContext {
        val key = store().getKey(ALIAS, null) as PrivateKey
        val certs = chain()
        val km = object : X509ExtendedKeyManager() {
            override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = null
            override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = null
            override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
            override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?) = if (keyType == null || keyType.startsWith("EC")) ALIAS else null
            override fun chooseEngineServerAlias(keyType: String?, issuers: Array<out Principal>?, engine: SSLEngine?) = if (keyType == null || keyType.startsWith("EC")) ALIAS else null
            override fun getCertificateChain(alias: String?) = certs
            override fun getPrivateKey(alias: String?) = key
        }
        return SSLContext.getInstance("TLS").apply { init(arrayOf(km), null, null) }
    }
}
