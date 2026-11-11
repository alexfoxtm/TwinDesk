// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanFilter
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.ComponentName
import android.content.Context
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

// CDM's approval is package-wide. It is distinct from the paired transport's authorization.
// The selected BLE endpoint must prove the current Mac's pin before we rebind the listener.
class CompanionApproval(core: Core) : Feature(core) {
    enum class State { IDLE, WAITING, CHOOSING, VERIFYING, APPROVED, FAILED, RECOVERY }

    companion object {
        private const val PREFS = "companion-approval"
        private const val PENDING = "pending"
        private const val PROOFS = "proofs"
        private const val CLEANUP = "cleanup"
        private const val REBIND = "rebind"
        const val WIRE = "companion.advertise"

        fun holdNotifications(ctx: Context): Boolean {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return prefs.contains(PENDING) || !prefs.getStringSet(CLEANUP, emptySet()).isNullOrEmpty()
        }

        fun listenerDisconnected(ctx: Context) {
            if (!holdNotifications(ctx) && ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(REBIND, false))
                runCatching { NotificationListenerService.requestRebind(ComponentName(ctx, NotifListener::class.java)) }
        }

        fun listenerConnected(ctx: Context) {
            if (!holdNotifications(ctx)) ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(REBIND).apply()
        }
    }

    private val prefs = core.ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val manager get() = core.ctx.getSystemService(CompanionDeviceManager::class.java)
    @Volatile var state = State.IDLE; private set
    @Volatile private var attempt: Attempt? = null

    private class Attempt(val host: Host, val session: Any, val id: String, val baseline: Set<Int>, val launch: (IntentSender) -> Unit) {
        @Volatile var until = SystemClock.elapsedRealtime() + 60000
        @Volatile var created: Int? = null
        @Volatile var pipe: Ble.ProofPipe? = null
        @Volatile var approved = false
    }

    val supported: Boolean get() = Build.VERSION.SDK_INT >= 35 && BuildConfig.NOTIF_LISTENER &&
        core.ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_COMPANION_DEVICE_SETUP)
    val busy: Boolean get() = attempt != null

    init { main.post { reconcile() } }

    fun readyFor(hostId: String): Boolean {
        if (!supported || holdNotifications(core.ctx) || NotifListener.running == null || !core.notifs.hasAccess) return false
        return hasApproval(hostId)
    }

    fun hasApproval(hostId: String): Boolean {
        if (!supported) return false
        val h = core.store.hosts().find { it.id == hostId } ?: return false
        val p = proofs().optJSONObject(hostId) ?: return false
        return p.optString("pin") == h.fp && associations().any { it.id == p.optInt("association", -1) }
    }

    fun begin(launch: (IntentSender) -> Unit) {
        if (!supported || busy || state == State.RECOVERY) return
        val h = core.link.host ?: return fail()
        val session = core.link.sessionMarker() ?: return fail()
        if (!core.link.connected || core.link.ble || h.os != "mac" || !core.ble.allowed() || !core.ble.radioOn ||
            core.store.hosts().none { it.id == h.id && it.fp == h.fp }) return fail()
        if (readyFor(h.id)) { setState(State.APPROVED); return }
        val baseline = associationIds() ?: return fail()
        val a = Attempt(h.copy(), session, Proto.randomHex(16), baseline, launch)
        val pending = JSONObject().put("request", a.id).put("baseline", JSONArray(baseline.toList()))
        if (!prefs.edit().putString(PENDING, pending.toString()).commit()) return fail()
        attempt = a
        NotifListener.running?.suspendForApproval()
        core.ble.scan(false)
        setState(State.WAITING)
        if (!core.link.send(msg(WIRE, "on" to true, "requestId" to a.id))) return finish(a, false)
        main.postDelayed({ if (attempt === a) finish(a, false) }, 60000)
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != WIRE) return false
        val a = attempt ?: return true
        if (m.optString("requestId") != a.id) return true
        if (!valid(a) || m.optBoolean("on") != true) { finish(a, false); return true }
        if (state != State.WAITING) return true
        val remaining = m.optLong("expiresInMs", 0).coerceIn(0, 60000)
        if (remaining < 1000) { finish(a, false); return true }
        a.until = minOf(a.until, SystemClock.elapsedRealtime() + remaining)
        choose(a)
        return true
    }

    private fun choose(a: Attempt) {
        if (!valid(a)) return finish(a, false)
        setState(State.CHOOSING)
        val filter = BluetoothLeDeviceFilter.Builder().setScanFilter(
            ScanFilter.Builder().setServiceUuid(ParcelUuid(Ble.SERVICE)).build(),
        ).build()
        val request = AssociationRequest.Builder().addDeviceFilter(filter).setSingleDevice(false).build()
        runCatching {
            manager.associate(request, core.ctx.mainExecutor, object : CompanionDeviceManager.Callback() {
                override fun onAssociationPending(sender: IntentSender) {
                    if (!valid(a)) return finish(a, false)
                    runCatching { a.launch(sender) }.onFailure { finish(a, false) }
                }
                override fun onAssociationCreated(info: AssociationInfo) {
                    if (info.id in a.baseline) { finish(a, false); return }
                    a.created = info.id
                    val pending = pending()
                    if (pending?.optString("request") == a.id) {
                        if (!prefs.edit().putString(PENDING, pending.put("association", info.id).toString()).commit()) {
                            finish(a, false); return
                        }
                    }
                    if (!valid(a)) { finish(a, false); return }
                    val device = info.associatedDevice?.bleDevice?.device
                    if (device == null || info.isSelfManaged) { finish(a, false); return }
                    verify(a, device)
                }
                override fun onFailure(error: CharSequence?) { finish(a, false) }
            })
        }.onFailure { finish(a, false) }
    }

    private fun verify(a: Attempt, device: BluetoothDevice) {
        setState(State.VERIFYING)
        core.bg.execute {
            val pipe = if (valid(a)) core.ble.openProof(device, minOf(15000, (a.until - SystemClock.elapsedRealtime()).coerceAtLeast(1))) else null
            a.pipe = pipe
            val proved = pipe != null && valid(a) && prove(pipe.port, a.host.fp, a.until)
            pipe?.close()
            a.pipe = null
            main.post {
                if (!proved || !valid(a)) return@post finish(a, false)
                val id = a.created ?: return@post finish(a, false)
                if (associations().none { it.id == id }) return@post finish(a, false)
                val saved = proofs().put(a.host.id, JSONObject().put("pin", a.host.fp).put("association", id))
                if (!prefs.edit().putString(PROOFS, saved.toString()).remove(PENDING).commit()) return@post finish(a, false)
                finish(a, true)
            }
        }
    }

    // A TLS handshake only: no HTTP request, WebSocket hello, pairing token, or session takeover.
    private fun prove(port: Int, pin: String, until: Long): Boolean = runCatching {
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String?) {
                if (chain.isEmpty() || Proto.sha256(chain[0].encoded).hex() != pin) throw CertificateException("identity changed")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val timeout = minOf(10000L, until - SystemClock.elapsedRealtime()).coerceAtLeast(1).toInt()
        (ssl.socketFactory.createSocket() as SSLSocket).use {
            it.soTimeout = timeout
            it.connect(InetSocketAddress("127.0.0.1", port), timeout)
            it.startHandshake()
        }
        SystemClock.elapsedRealtime() < until
    }.getOrDefault(false)

    private fun valid(a: Attempt): Boolean = attempt === a && SystemClock.elapsedRealtime() < a.until &&
        core.link.connected && core.link.sessionMarker() === a.session && core.link.host?.id == a.host.id &&
        core.link.host?.fp == a.host.fp && core.store.hosts().any { it.id == a.host.id && it.fp == a.host.fp }

    fun cancel() { attempt?.let { finish(it, false) } }
    fun refresh() = reconcile()
    fun retryRecovery() = reconcile()
    override fun onClosed() = cancel()
    override fun onWelcome(host: Host) = reconcile()

    fun forget(hostId: String) {
        if (attempt?.host?.id == hostId) cancel()
        val p = proofs()
        val id = p.optJSONObject(hostId)?.optInt("association", -1) ?: return
        if (id >= 0 && !removeOwned(id)) { setState(State.RECOVERY); return }
        p.remove(hostId)
        prefs.edit().putString(PROOFS, p.toString()).commit()
        rebind()
        setState(State.IDLE)
    }

    private fun finish(a: Attempt, success: Boolean) {
        if (a.approved && !success) return
        if (success) a.approved = true
        a.pipe?.close()
        val current = attempt === a
        if (current) {
            if (!success && state == State.CHOOSING) runCatching {
                manager.buildAssociationCancellationIntent()?.sendIntent(core.ctx, 0, null, null, null)
            }
            attempt = null
            if (core.link.connected && core.link.sessionMarker() === a.session) core.link.send(msg(WIRE, "on" to false, "requestId" to a.id))
        }
        val retained = proofs().let { p -> p.keys().asSequence().any { p.optJSONObject(it)?.optInt("association", -1) == a.created } }
        if (!success && !retained && a.created != null && a.created !in a.baseline && !removeOwned(a.created!!)) {
            setState(State.RECOVERY); return
        }
        val p = pending()
        if (!current && p?.optString("request") != a.id) return
        if (p?.optString("request") == a.id) {
            // A crash/cancel before the callback can leave an association whose ownership is unknown.
            val ids = associationIds()
            if (!success && (ids == null || ids.any { it !in a.baseline && it != a.created })) {
                setState(State.RECOVERY); return
            }
            prefs.edit().remove(PENDING).commit()
        }
        rebind()
        setState(if (holdNotifications(core.ctx)) State.RECOVERY else if (success) State.APPROVED else State.FAILED)
    }

    private fun reconcile() {
        if (!supported || busy) return
        for (id in prefs.getStringSet(CLEANUP, emptySet()).orEmpty().mapNotNull { it.toIntOrNull() }) {
            if (!removeOwned(id)) { setState(State.RECOVERY); return }
        }
        val p = pending()
        if (p != null) {
            val id = p.optInt("association", -1)
            if (id >= 0 && !removeOwned(id)) { setState(State.RECOVERY); return }
            val before = p.optJSONArray("baseline") ?: JSONArray()
            val baseline = (0 until before.length()).map { before.optInt(it, -1) }.toSet()
            val ids = associationIds()
            if (ids == null || ids.any { it !in baseline && it != id }) { setState(State.RECOVERY); return }
            prefs.edit().remove(PENDING).commit()
            rebind()
        }
        val saved = proofs()
        val keys = saved.keys().asSequence().toList()
        for (hostId in keys) {
            val proof = saved.optJSONObject(hostId) ?: continue
            if (core.store.hosts().none { it.id == hostId && it.fp == proof.optString("pin") }) {
                val id = proof.optInt("association", -1)
                if (id >= 0 && !removeOwned(id)) { setState(State.RECOVERY); return }
                saved.remove(hostId)
            }
        }
        prefs.edit().putString(PROOFS, saved.toString()).apply()
        if (state == State.RECOVERY) setState(State.IDLE) else core.changed()
    }

    private fun associations(): List<AssociationInfo> = if (supported) runCatching { manager.myAssociations }.getOrDefault(emptyList()) else emptyList()
    private fun associationIds(): Set<Int>? = runCatching { manager.myAssociations.map { it.id }.toSet() }.getOrNull()
    private fun proofs(): JSONObject = runCatching { JSONObject(prefs.getString(PROOFS, "{}")!!) }.getOrDefault(JSONObject())
    private fun pending(): JSONObject? = prefs.getString(PENDING, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    private fun removeOwned(id: Int): Boolean {
        val removed = runCatching {
            if (manager.myAssociations.any { it.id == id }) manager.disassociate(id)
            true
        }.getOrDefault(false)
        val cleanup = prefs.getStringSet(CLEANUP, emptySet()).orEmpty().toSet()
        prefs.edit().putStringSet(CLEANUP, if (removed) cleanup - id.toString() else cleanup + id.toString()).commit()
        return removed
    }
    private fun rebind() {
        if (!BuildConfig.NOTIF_LISTENER || holdNotifications(core.ctx)) return
        prefs.edit().putBoolean(REBIND, true).commit()
        val listener = NotifListener.running
        if (listener != null) listener.suspendForApproval()
        else listenerDisconnected(core.ctx)
    }
    private fun fail() = setState(State.FAILED)
    private fun setState(value: State) { state = value; core.changed() }
}
