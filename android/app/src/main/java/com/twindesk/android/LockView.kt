// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.os.Handler
import android.os.Looper
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import org.json.JSONObject

// An explicit, foreground-only login attempt, bound to one authenticated session socket.
// The dedicated page sees RFB bytes, never a reusable ticket, host endpoint or certificate.
@Suppress("PARAMETER_NAME_CHANGED_ON_OVERRIDE")
class LockView(core: Core) : Feature(core) {
    @Volatile var locked = false; private set
    @Volatile var capable = false; private set
    val available get() = locked && capable && core.host?.os == "mac" && !core.link.ble
    @Volatile var active = false; private set
    private val main = Handler(Looper.getMainLooper())
    private var owner: Any? = null
    private var request = ""
    private var marker: Any? = null
    private var deliver: ((JSONObject) -> Unit)? = null
    private var socket: WebSocket? = null
    private var reader: LockReadGate? = null
    private var attempt = 0

    fun attach(pageOwner: Any, post: (JSONObject) -> Unit) {
        end()
        if (!available) { post(msg("closed")); return }
        active = true
        owner = pageOwner
        reader = LockReadGate()
        deliver = post
        marker = core.link.sessionMarker()
        request = Proto.randomHex(16)
        core.send(msg("lock.open", "request" to request))
        val mine = ++attempt
        main.postDelayed({ if (active && attempt == mine && socket == null) end() }, 12000)
        core.changed()
    }

    fun linkChanged() = main.post {
        if (active && (!core.link.connected || core.link.ble || core.link.sessionMarker() !== marker)) end()
    }

    fun send(pageOwner: Any, encoded: String) = main.post {
        if (owner !== pageOwner) return@post
        if (!valid() || encoded.length > 350000) { end(); return@post }
        val bytes = encoded.decodeBase64()
        val ws = socket
        if (bytes == null || bytes.size > 256 * 1024 || ws == null || ws.queueSize() > 1024 * 1024 || !ws.send(bytes)) end()
    }

    fun ack(pageOwner: Any) = main.post { if (owner === pageOwner) reader?.ack() }

    fun endFor(pageOwner: Any) { if (owner === pageOwner) end() }

    private fun valid() = active && core.link.connected && !core.link.ble && core.link.lockSessionCurrent(marker) && available

    fun end(notify: Boolean = true) {
        val wasActive = active
        active = false
        attempt++
        val ws = socket
        socket = null
        reader?.cancel() // release a blocked OkHttp reader before cancelling its socket
        reader = null
        ws?.cancel()
        marker = null
        owner = null
        val endedRequest = request
        request = ""
        val post = deliver
        deliver = null
        if (notify && wasActive) core.send(msg("lock.end", "request" to endedRequest))
        post?.invoke(msg("closed"))
        if (wasActive) core.changed()
    }

    override fun onWelcome(host: Host) { main.post { end(false); locked = false; capable = false } }
    override fun onClosed() { end(false); locked = false; capable = false }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            "lock.state" -> {
                locked = m.optBoolean("locked")
                capable = m.optBoolean("can")
                if (active && !available) {
                    if (!locked) deliver?.invoke(msg("unlocked"))
                    end(false)
                }
                core.changed()
            }
            "lock.end" -> if (m.optString("request") == request && request.isNotEmpty()) {
                if (m.optString("reason") == "unlocked") deliver?.invoke(msg("unlocked"))
                end(false)
            }
            "lock.ticket" -> {
                if (!valid() || socket != null || m.optString("request") != request) return true
                val ticket = m.optString("ticket")
                if (!Regex("[A-Za-z0-9_-]{43}").matches(ticket) || m.optString("path") != "/lockview" || m.optLong("expiresIn") !in 1..10000) { end(); return true }
                val mine = attempt
                val gate = reader ?: return true
                socket = core.link.openLockTunnel(ticket, marker, object : WebSocketListener() {
                    override fun onOpen(ws: WebSocket, response: Response) { main.post {
                        if (mine != attempt || !valid() || ws !== socket) { ws.cancel(); return@post }
                        deliver?.invoke(msg("open"))
                    } }
                    override fun onMessage(ws: WebSocket, bytes: ByteString) {
                        if (bytes.size > 1024 * 1024) {
                            ws.cancel(); main.post { if (mine == attempt) end() }; return
                        }
                        // Blocking only this socket's reader applies TCP backpressure. The page
                        // ACK releases one 64KiB chunk; no growing main-thread queue is created.
                        var at = 0
                        while (at < bytes.size) {
                            if (!gate.acquire()) {
                                ws.cancel(); main.post { if (mine == attempt) end() }; return
                            }
                            val chunk = bytes.substring(at, minOf(at + 64 * 1024, bytes.size))
                            main.post {
                                if (mine != attempt || ws !== socket) { gate.cancel(); return@post }
                                if (!valid()) { end(); return@post }
                                deliver?.invoke(msg("bytes", "data" to chunk.base64()))
                            }
                            at += chunk.size
                        }
                    }
                    override fun onMessage(ws: WebSocket, text: String) { main.post { if (mine == attempt) end() } }
                    override fun onClosed(ws: WebSocket, code: Int, reason: String) { main.post { if (mine == attempt) end(false) } }
                    override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { main.post { if (mine == attempt) end(false) } }
                })
                if (socket == null) end()
            }
            else -> return false
        }
        return true
    }
}
