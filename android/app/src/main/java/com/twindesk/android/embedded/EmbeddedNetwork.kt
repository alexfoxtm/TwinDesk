// TwinDesk — GPL-3.0, see LICENSE.
package com.twindesk.android.embedded

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.system.Os
import com.twindesk.android.Store
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

internal class EmbeddedNetwork(context: Context, private val store: Store, private val changed: () -> Unit) {
    data class Status(val state: String, val peers: Set<String> = emptySet(), val logoutPending: Boolean = false)
    private val ctx = context.applicationContext
    private val dir = File(ctx.noBackupFilesDir, "twindesk-network")
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadScheduledExecutor { work ->
        Thread(work, "td-embedded").apply { isDaemon = true }
    }
    private val interfaces = NativeInterfaces(ctx)
    @Volatile var status = Status("stopped")
        private set
    @Volatile private var desired = false
    val enabled get() = desired
    @Volatile private var generation = 0L
    // Accessed on the lifecycle worker.
    private var started = false
    private var loginRequested = false
    @Volatile private var loginAttempt = 0L
    private var ticker: ScheduledFuture<*>? = null
    private var restoreAttempted = false

    @Synchronized
    fun restore() {
        if (restoreAttempted || Store.cableOnly(ctx)) return
        restoreAttempted = true
        if (store.flag(ENABLED, false) && !desired) start(false)
    }

    @Synchronized
    fun start(signIn: Boolean) {
        if (Store.cableOnly(ctx)) return
        val restart = desired && status.state == "error"
        if (!desired || restart) {
            if (!store.setEmbeddedEnabled(true)) {
                update(Status("error"))
                return
            }
            desired = true
            generation++
            update(Status("starting"))
        }
        val current = generation
        worker.execute {
            if (!current(current)) return@execute
            if (!started) {
                val ready = runCatching {
                    check(dir.isDirectory || dir.mkdir())
                    Os.chmod(dir.path, 448) // 0700
                    NativeNode.load()
                    check(interfaces.start())
                }.isSuccess
                if (!ready || call("start", "dir" to dir.path, "role" to "android", "displayName" to store.deviceName) == null) {
                    interfaces.stop()
                    publish(current, Status("error"))
                    return@execute
                }
                started = true
            } else if (restart) {
                // Retry after an engine error with a fresh instance and the same app account.
                call("stop")
                started = call("start", "dir" to dir.path, "role" to "android", "displayName" to store.deviceName) != null
                if (!started) {
                    interfaces.stop()
                    publish(current, Status("error"))
                    return@execute
                }
            }
            if (ticker == null) {
                ticker = worker.scheduleWithFixedDelay({ if (desired && started) poll(generation) }, 2, 2, TimeUnit.SECONDS)
            }
            if (signIn && current(current)) {
                loginAttempt++
                loginRequested = call("login") != null
            }
            poll(current)
        }
    }

    @Synchronized
    fun stop(signOut: Boolean, goodbye: CompletableFuture<Unit>? = null) {
        restoreAttempted = true
        desired = false
        val current = ++generation
        val remembered = !signOut || store.setEmbeddedEnabled(false)
        update(Status("stopping"))
        worker.execute {
            ticker?.cancel(false)
            ticker = null
            loginRequested = false
            loginAttempt++
            // UI / route admission stopped above. Give the detached WebSocket a bounded chance
            // to drain its BYE before stopping the native node that carries it.
            runCatching { goodbye?.get(1, TimeUnit.SECONDS) }
            val reply = if (signOut) call("logout", "dir" to dir.path, "role" to "android") else call("stop")
            interfaces.stop()
            started = false
            synchronized(this) {
                if (current == generation) update(
                    if (reply == null || !remembered) Status("error")
                    else Status("stopped", logoutPending = signOut && !reply.optBoolean("remoteRevoked", true))
                )
            }
        }
    }

    fun online(node: String) = desired && status.state == "running" && node in status.peers

    fun onlineCandidates(bound: String?): List<String> {
        val current = status
        if (!desired || current.state != "running") return emptyList()
        if (bound != null) return if (bound in current.peers) listOf(bound) else emptyList()
        return current.peers.toList()
    }

    fun dial(node: String): EmbeddedBridge? {
        val current = generation
        if (!online(node)) return null
        val reply = call("dial", "peer" to node) ?: return null
        val handle = reply.optString("handle")
        val port = reply.optInt("port")
        val token = reply.optString("token")
        if (!current(current) || port !in 1..65535 || handle.isEmpty() || !proofFormat.matches(token)) {
            if (handle.isNotEmpty()) call("close", "handle" to handle)
            return null
        }
        val proof = ByteArray(32) { token.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        return EmbeddedBridge(port, handle, proof)
    }

    fun release(bridge: EmbeddedBridge) {
        bridge.retire()
        worker.execute { call("close", "handle" to bridge.handle) }
    }

    fun releaseNow(bridge: EmbeddedBridge) {
        bridge.retire()
        call("close", "handle" to bridge.handle)
    }

    private fun poll(current: Long) {
        val reply = call("status") ?: return publish(current, Status("error"))
        val list = reply.optJSONArray("peers")
        val peers = buildSet {
            for (i in 0 until (list?.length() ?: 0)) {
                val peer = list?.optJSONObject(i) ?: continue
                val id = peer.optString("id")
                if (peer.optBoolean("online") && stableNode.matches(id)) add(id)
            }
        }
        val state = reply.optString("state", "error")
        publish(current, Status(state, peers))
        if (!loginRequested || !current(current)) return
        val url = reply.optString("authURL").takeIf(::officialLogin)
        if (url != null) {
            loginRequested = false
            val attempt = loginAttempt
            main.post {
                if (current(current) && loginAttempt == attempt && status.state != "running") {
                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
            }
        } else if (state == "running" || state == "error") loginRequested = false
    }

    private fun current(ticket: Long) = desired && generation == ticket

    @Synchronized
    private fun publish(ticket: Long, next: Status) {
        if (current(ticket)) update(next)
    }

    private fun update(next: Status) {
        if (status == next) return
        status = next
        main.post(changed)
    }

    private fun call(op: String, vararg fields: Pair<String, String>): JSONObject? = runCatching {
        NativeNode.load()
        val request = JSONObject().put("op", op)
        fields.forEach { (key, value) -> request.put(key, value) }
        JSONObject(NativeNode.call(request.toString())).takeIf { it.optBoolean("ok") }
    }.getOrNull()

    private fun officialLogin(raw: String): Boolean {
        val url = runCatching { URI(raw) }.getOrNull() ?: return false
        return url.scheme == "https" && url.host in loginHosts && url.port == -1 &&
            url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null &&
            loginPath.matches(url.rawPath.orEmpty())
    }

    companion object {
        const val ENABLED = "embeddedNetworkEnabled"
        private val proofFormat = Regex("[0-9a-f]{64}")
        private val loginPath = Regex("/a/[A-Za-z0-9_-]{1,256}")
        private val loginHosts = setOf("login.tailscale.com", "controlplane.tailscale.com")
    }
}
