// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Internet over USB (#277; shared/tether.js and shared/tetherrelay.js on the computer): this phone
// uses the computer's internet through the cable, as gnirehtet does, with nothing else installed.
//   - As a session starts this says it can (tether.state {can: true}); a computer too old to know
//     it never offers, and nothing here runs.
//   - The computer offers (tether {on, port, token}) once it's switched on there and this phone
//     is on its cable with USB debugging: its relay is this phone's 127.0.0.1:<port> (adb reverse).
//   - A VPN (TetherVpn) takes every IPv4 packet the apps send and passes it, as it is, through
//     that one stream; the computer makes the connections. TwinDesk itself stays outside it. IPv6
//     isn't routed (apps use this phone's own networks for it).
//   - Android asks once for the VPN permission (TetherActivity, opened from a notification when the
//     app isn't in front). Refused, or Stop in the VPN's notification: switched off on the computer
//     (tether.set {on: false}).
//   - The cable unplugged, the session ended or tether {on: false}: the VPN stops and this phone is
//     back on its own networks.
// The stream proves both ends know the token first: TDT1 <nonce>, the computer's HMAC of it and its
// nonce, this phone's HMAC of that.
package com.twindesk.android

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID
import java.util.concurrent.FutureTask
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class Tether(core: Core) : Feature(core) {
    internal class Offer(val port: Int, val token: String, val route: Link.TrustedRoute) {
        val id: String = UUID.randomUUID().toString()

        fun accepts(request: String?, current: (Link.TrustedRoute) -> Boolean): Boolean =
            request == id && current(route)
    }

    // The offer, actions and service's current Run are owned by the main thread.
    private val main = Handler(Looper.getMainLooper())
    private var offer: Offer? = null
    private var state = "off" // off | ask | starting | on | error
    private var why = ""
    private var lastSocket: Any? = null
    private var lastSent = ""

    internal fun linkChanged() {
        main.post { syncLink() }
    }

    override fun onClosed() = syncLink()

    private fun syncLink() {
        val route = core.link.currentTrustedRoute()
        val active = offer
        if (active != null && !core.link.accepts(active.route)) clear()
        tell(route)
    }

    internal fun onMessage(t: String, m: JSONObject, route: Link.TrustedRoute?): Boolean {
        if (t != Proto.T.TETHER) return false
        if (route == null || !core.link.accepts(route)) return true
        val port = m.optInt("port")
        val token = m.str("token", 128)
        clear()
        if (m.optBoolean("on") && port in 1..65535 && token.matches(Regex("[0-9a-f]{32,128}"))) {
            val next = Offer(port, token, route)
            offer = next
            start(next)
        } else tell(route)
        return true
    }

    private fun clear() {
        val old = offer
        offer = null
        if (old != null) TetherVpn.running?.retire(old)
        Notify.nm(core.ctx).cancel(Notify.ID_TETHER)
        state = "off"
        why = ""
        core.changed()
    }

    internal fun current(request: String?): Offer? = offer?.takeIf { it.accepts(request, core.link::accepts) }
    internal fun awaitingPermission(request: String?): Boolean = state == "ask" && current(request) != null

    private fun promptIntent(ctx: Context, request: String) = Intent(ctx, TetherActivity::class.java)
        .setIdentifier(request)
        .putExtra(REQUEST, request)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    // Android's permission is app-wide; the action taken in response belongs to this offer.
    private fun start(active: Offer) {
        val ctx = core.ctx
        if (VpnService.prepare(ctx) == null) { launch(active); return }
        set(active, "ask")
        if (current(active.id) == null) return
        notifyAsk(active)
        if (inFront() || Settings.canDrawOverlays(ctx)) runCatching {
            ctx.startActivity(promptIntent(ctx, active.id))
        }
    }

    private fun inFront() = runCatching {
        android.app.ActivityManager.RunningAppProcessInfo().also { android.app.ActivityManager.getMyMemoryState(it) }.importance <=
            android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }.getOrDefault(false)

    internal fun permissionResult(request: String?, granted: Boolean, denied: String = "") {
        if (state != "ask") return
        val active = current(request) ?: return
        if (granted) launch(active) else userStop(active.id, denied)
    }

    private fun launch(active: Offer) {
        if (current(active.id) == null) return
        Notify.nm(core.ctx).cancel(Notify.ID_TETHER)
        set(active, "starting")
        val intent = Intent(core.ctx, TetherVpn::class.java).putExtra(REQUEST, active.id)
        runCatching { core.ctx.startService(intent) }.onFailure { set(active, "error", it.message ?: "couldn’t start") }
    }

    internal fun userStop(request: String, reason: String = "") {
        val active = current(request) ?: return
        clear()
        why = reason
        tell(active.route)
        core.link.sendFor(active.route, msg(Proto.T.TETHER_SET, "on" to false))
    }

    internal fun set(active: Offer, s: String, w: String = ""): Boolean {
        if (current(active.id) == null) return false
        state = s
        why = w
        tell(active.route)
        core.changed()
        return true
    }

    private fun tell(route: Link.TrustedRoute?) {
        if (route == null || !core.link.accepts(route)) {
            lastSocket = null
            lastSent = ""
            return
        }
        val reply = msg(Proto.T.TETHER_STATE, "can" to true, "state" to state, "why" to why)
        val key = reply.toString()
        if (lastSocket === route.marker && key == lastSent) return
        if (core.link.sendFor(route, reply)) {
            lastSocket = route.marker
            lastSent = key
        }
    }

    private fun notifyAsk(active: Offer) {
        val ctx = core.ctx
        val name = core.host?.name ?: tr("your computer")
        val open = PendingIntent.getActivity(ctx, 19, promptIntent(ctx, active.id), PendingIntent.FLAG_IMMUTABLE)
        val text = tr("This phone can use {name}’s internet through the USB cable. Tap Allow, then confirm Android’s VPN request.", "name" to name)
        runCatching {
            Notify.nm(ctx).notify(Notify.ID_TETHER, Notification.Builder(ctx, Notify.CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Use {name}’s internet?", "name" to name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .addAction(Notification.Action.Builder(null, tr("Allow"), open).build())
                .addAction(Notification.Action.Builder(null, tr("Not now"), stopAction(ctx, active.id, 20)).build())
                .setOnlyAlertOnce(true)
                .build())
        }
    }

    companion object {
        internal const val REQUEST = "tetherRequest"

        internal fun stopAction(ctx: Context, request: String, code: Int): PendingIntent =
            PendingIntent.getBroadcast(ctx, code, Intent(ctx, ActionReceiver::class.java)
                .setAction(ActionReceiver.TETHER_STOP).setIdentifier(request).putExtra("arg", request), PendingIntent.FLAG_IMMUTABLE)

        const val PHONE_IP = "10.215.173.1"
        const val DNS_IP = "10.215.173.2" // the computer sends these queries to its own DNS server (tetherrelay.js)
        const val MTU = 16384 // as tetherrelay.js: big packets, fewer of them through adb

        fun hmac(key: String, s: String): String {
            val m = Mac.getInstance("HmacSHA256")
            m.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            return m.doFinal(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        }
    }
}

// Android's VPN permission, asked from the front.
class TetherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tether = Core.get(this).tether
        val request = intent.getStringExtra(Tether.REQUEST)
        if (!tether.awaitingPermission(request)) { finish(); return }
        if (savedInstanceState != null) return
        val ask = VpnService.prepare(this)
        if (ask == null) { tether.permissionResult(request, true); finish(); return }
        @Suppress("DEPRECATION")
        runCatching { startActivityForResult(ask, PERMISSION) }.onFailure {
            tether.permissionResult(request, false, tr("Android didn’t let TwinDesk ask for the VPN permission"))
            finish()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PERMISSION) return
        Core.get(this).tether.permissionResult(intent.getStringExtra(Tether.REQUEST), resultCode == RESULT_OK,
            tr("The VPN permission wasn’t given on the phone"))
        finish()
    }

    private companion object { const val PERMISSION = 1 }
}

// The VPN: the apps' IPv4 packets to and from the computer's relay.
class TetherVpn : VpnService() {
    // One run per offer: its own socket and VPN interface, so a new offer (or Stop) ends the old one
    // without the old one's ending touching the new.
    private class Run(val offer: Tether.Offer) {
        @Volatile var sock: Socket? = null
        @Volatile var tun: ParcelFileDescriptor? = null
        @Volatile var stopping = false
        fun close() {
            runCatching { sock?.close() }
            runCatching { tun?.close() }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var cur: Run? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val core = Core.get(this)
        val offer = core.tether.current(intent?.getStringExtra(Tether.REQUEST))
        if (offer == null) {
            if (cur == null) stopSelf(startId)
            return START_NOT_STICKY
        }
        if (cur?.offer === offer) return START_NOT_STICKY
        stopRun()
        val r = Run(offer)
        cur = r
        running = this
        Thread({ run(core, r) }, "td-tether").apply { isDaemon = true; start() }
        return START_NOT_STICKY
    }

    internal fun retire(offer: Tether.Offer) {
        if (cur?.offer !== offer) return
        stopRun()
        stopSelf()
    }

    private fun stopRun() {
        val r = cur ?: return
        cur = null
        r.stopping = true
        r.close()
    }

    private fun run(core: Core, r: Run) {
        var why = ""
        try {
            val s = Socket()
            r.sock = s
            if (r.stopping) return
            protect(s)
            s.tcpNoDelay = true
            s.connect(InetSocketAddress("127.0.0.1", r.offer.port), 5000)
            handshake(s, r.offer.token)
            // Establishing a VPN can replace an existing interface. Do it on the same thread
            // that accepts a new Run, after checking that both the Run and offer still own it.
            val ready = FutureTask { establish(core, r) }
            if (r.stopping || !main.post(ready)) return
            val pfd = ready.get() ?: return
            if (r.stopping) return
            val up = Thread({ toComputer(pfd, s, r) }, "td-tether-up").apply { isDaemon = true; start() }
            toPhone(s.getInputStream(), FileOutputStream(pfd.fileDescriptor), r)
            up.interrupt()
            if (!r.stopping) why = tr("The cable or the computer ended it")
        } catch (e: Exception) {
            if (!r.stopping) {
                why = (e.cause ?: e).message ?: "stopped"
                Log.w("TwinDesk", "tether: $why")
            }
        } finally {
            r.close()
            main.post {
                if (cur !== r) return@post
                stopRun()
                Notify.nm(this).cancel(Notify.ID_TETHER)
                core.tether.set(r.offer, if (why.isNotEmpty()) "error" else "off", why)
                stopSelf()
            }
        }
    }

    private fun establish(core: Core, r: Run): ParcelFileDescriptor? {
        if (cur !== r || core.tether.current(r.offer.id) == null) return null
        val pfd = Builder()
            .setSession(tr("Internet over USB"))
            .addAddress(Tether.PHONE_IP, 24)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(Tether.DNS_IP)
            .setMtu(Tether.MTU)
            .addDisallowedApplication(packageName) // TwinDesk's own session stays on the phone's networks
            .setBlocking(true)
            .setConfigureIntent(Notify.openApp(this))
            .setMetered(false)
            .establish() ?: throw Exception(tr("Android didn’t start the VPN (the permission was taken back?)"))
        r.tun = pfd
        if (!core.tether.set(r.offer, "on")) return null
        notifyOn(core, r.offer)
        return pfd
    }
    private fun handshake(s: Socket, token: String) {
        s.soTimeout = 5000
        val nonce = Proto.randomHex(16)
        val out = s.getOutputStream()
        val inp = s.getInputStream()
        out.write("TDT1 $nonce\n".toByteArray(Charsets.ISO_8859_1))
        out.flush()
        val line = readLine(inp)
        val parts = line.split(" ")
        if (parts.size != 2 || !java.security.MessageDigest.isEqual(parts[0].toByteArray(), Tether.hmac(token, "r$nonce").toByteArray()) || !parts[1].matches(Regex("[0-9a-f]{32}")))
            throw Exception(tr("Something else answered on the cable, not TwinDesk on the computer"))
        out.write("${Tether.hmac(token, "p${parts[1]}")}\n".toByteArray(Charsets.ISO_8859_1))
        out.flush()
        s.soTimeout = 0
    }

    private fun readLine(inp: InputStream): String {
        val b = StringBuilder()
        while (b.length < 200) {
            val c = inp.read()
            if (c < 0) throw Exception(tr("The computer closed the connection"))
            if (c == '\n'.code) return b.toString()
            b.append(c.toChar())
        }
        throw Exception("hello too long")
    }

    // The apps' packets, as they are, to the computer.
    private fun toComputer(pfd: ParcelFileDescriptor, s: Socket, r: Run) {
        runCatching {
            val inp = FileInputStream(pfd.fileDescriptor)
            val out = s.getOutputStream()
            val buf = ByteArray(Tether.MTU)
            while (!r.stopping) {
                val n = inp.read(buf)
                if (n < 0) break
                if (n < 20 || (buf[0].toInt() shr 4) != 4) continue // IPv4 only
                out.write(buf, 0, n)
            }
        }
        runCatching { s.close() }
    }

    // The computer's packets, one by one (by their IPv4 length), to the apps.
    private fun toPhone(inp: InputStream, tunOut: FileOutputStream, r: Run) {
        val buf = ByteArray(Tether.MTU)
        while (!r.stopping) {
            if (!readFully(inp, buf, 0, 20)) return
            if ((buf[0].toInt() shr 4) != 4) throw Exception("the stream broke")
            val len = ((buf[2].toInt() and 0xff) shl 8) or (buf[3].toInt() and 0xff)
            if (len < 20 || len > buf.size) throw Exception("the stream broke")
            if (!readFully(inp, buf, 20, len - 20)) return
            tunOut.write(buf, 0, len)
        }
    }

    private fun readFully(inp: InputStream, b: ByteArray, off: Int, n: Int): Boolean {
        var got = 0
        while (got < n) {
            val r = inp.read(b, off + got, n - got)
            if (r < 0) return false
            got += r
        }
        return true
    }

    private fun notifyOn(core: Core, offer: Tether.Offer) {
        val name = core.host?.name ?: tr("your computer")
        runCatching {
            Notify.nm(this).notify(Notify.ID_TETHER, Notification.Builder(this, Notify.CH_LINK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Using {name}’s internet over USB", "name" to name))
                .setContentIntent(Notify.openApp(this))
                .setOngoing(true)
                .addAction(Notification.Action.Builder(null, tr("Stop"), Tether.stopAction(this, offer.id, 21)).build())
                .build())
        }
    }

    override fun onRevoke() { // another VPN started, or it was switched off in Android's settings
        val revoked = cur ?: return
        main.post {
            if (cur !== revoked) return@post
            Core.get(this).tether.userStop(revoked.offer.id, tr("Another VPN took over, or the VPN was switched off in Android’s settings"))
            if (cur === revoked) retire(revoked.offer)
        }
    }

    override fun onDestroy() {
        stopRun()
        if (running === this) running = null
        super.onDestroy()
    }

    companion object {
        internal var running: TetherVpn? = null
            private set
    }
}
