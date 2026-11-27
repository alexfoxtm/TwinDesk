// TwinDesk — GPL-3.0, see LICENSE.
package com.twindesk.android.embedded

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

internal class EmbeddedTurn(
    private val current: () -> Boolean,
    private val connect: (current: () -> Boolean, listener: WebSocketListener) -> Tunnel?,
) : Closeable {
    class Tunnel(val socket: WebSocket, val release: () -> Unit)

    private val lock = Any()
    private val streams = mutableSetOf<Stream>()
    @Volatile private var stopped = false
    @Volatile private var listener: ServerSocket? = null

    val port: Int get() = listener?.localPort?.takeIf { active() } ?: 0

    fun start(ready: () -> Unit) {
        Thread({
            try {
                ServerSocket().use { server ->
                    server.bind(InetSocketAddress(loopback, 0), MAX_STREAMS)
                    synchronized(lock) {
                        if (!active()) return@Thread
                        listener = server
                    }
                    ready()
                    while (active()) admit(server.accept())
                }
            } catch (_: IOException) {
                // Binding failed, or the owning Link closed the listener.
            } finally {
                close()
            }
        }, "td-embedded-turn").apply { isDaemon = true }.start()
    }

    private fun active() = !stopped && current()

    fun connectLocal(port: Int, ended: () -> Unit) {
        connectLocal(InetSocketAddress(loopback, port), ended)
    }

    fun connectLocal(endpoint: InetSocketAddress, ended: () -> Unit) {
        val socket = Socket()
        admit(socket, waitForDrain = true, prepare = { socket.connect(endpoint, 3000) }, ended = ended)
    }

    private fun admit(socket: Socket, waitForDrain: Boolean = false, prepare: () -> Unit = {}, ended: () -> Unit = {}) {
        val stream = synchronized(lock) {
            if (active() && slots.tryAcquire()) Stream(socket).also { streams.add(it) } else null
        }
        if (stream == null) {
            runCatching { socket.close() }
            ended()
            return
        }
        workers.execute {
            try {
                if (!active()) return@execute
                prepare()
                stream.pump(waitForDrain)
            } catch (_: IOException) {
                // The local service stopped before the child could connect.
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                stream.close()
                synchronized(lock) { streams.remove(stream) }
                slots.release()
                ended()
            }
        }
    }

    override fun close() {
        val children = synchronized(lock) {
            if (stopped) return
            stopped = true
            runCatching { listener?.close() }
            listener = null
            streams.toList()
        }
        for (stream in children) stream.close()
    }

    private inner class Stream(private val local: Socket) : WebSocketListener(), Closeable {
        private val opened = CountDownLatch(1)
        @Volatile private var remote: WebSocket? = null

        private fun allowed() = !local.isClosed && active()

        fun pump(waitForDrain: Boolean) {
            if (!allowed()) return
            val child = connect(::allowed, this) ?: return
            try {
                remote = child.socket
                if (!allowed() || !opened.await(5, TimeUnit.SECONDS) || !allowed()) return
                local.tcpNoDelay = true
                val input = local.getInputStream()
                val frame = ByteArray(MAX_FRAME)
                while (allowed()) {
                    val size = input.read(frame)
                    // File bytes must arrive intact. Pause this worker's local reads so
                    // backpressure reaches WebDAV, while keeping the TURN policy bounded.
                    val queueLimit = if (size > 0) MAX_QUEUE - size else 0L
                    while (allowed() && child.socket.queueSize() > queueLimit) {
                        if (!waitForDrain) return
                        Thread.sleep(10)
                    }
                    if (size <= 0 || !allowed() || !child.socket.send(frame.toByteString(0, size))) return
                }
            } catch (_: IOException) {
                // Either endpoint closed.
            } finally {
                close()
                child.release()
            }
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (allowed()) opened.countDown() else webSocket.cancel()
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            // The socket's send buffer provides backpressure on this WebSocket's reader.
            if (!allowed() || bytes.size !in 1..MAX_FRAME ||
                runCatching { local.getOutputStream().write(bytes.toByteArray()) }.isFailure) close()
        }

        override fun onMessage(webSocket: WebSocket, text: String) = close()

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = close()

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = close()

        override fun close() {
            runCatching { local.close() }
            opened.countDown()
            remote?.cancel()
        }
    }

    companion object {
        private const val MAX_STREAMS = 8
        private const val MAX_FRAME = 32768
        private const val MAX_QUEUE = 512L * 1024
        private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        // Count admitted sockets across Link replacements, including any native dial still returning.
        private val slots = Semaphore(MAX_STREAMS)
        private val workers = Executors.newCachedThreadPool { work ->
            Thread(work, "td-embedded-turn-stream").apply { isDaemon = true }
        }
    }
}

internal val embeddedMediaKey = Regex("[0-9a-f]{64}")

private val turnUrl = Regex("turn:127\\.0\\.0\\.1:([1-9][0-9]{0,4})\\?transport=tcp")

internal fun rewriteEmbeddedOffer(message: JSONObject, port: Int): Boolean {
    if (port !in 1..65535 || (message.opt("session") as? Int ?: 0) <= 0 ||
        (message.opt("sdp") as? String).isNullOrBlank()) return false
    val ice = message.optJSONObject("ice") ?: return false
    if (ice.opt("iceTransportPolicy") != "relay") return false
    val servers = ice.optJSONArray("iceServers") ?: return false
    if (servers.length() != 1) return false
    val server = servers.optJSONObject(0) ?: return false
    val url = server.opt("urls") as? String ?: return false
    val sourcePort = turnUrl.matchEntire(url)?.groupValues?.get(1)?.toInt() ?: return false
    if (sourcePort !in 1..65535) return false
    val username = (server.opt("username") as? String)?.takeIf { it.isNotEmpty() } ?: return false
    val credential = (server.opt("credential") as? String)?.takeIf { it.isNotEmpty() } ?: return false

    message.put("ice", JSONObject().put("iceTransportPolicy", "relay")
        .put("iceServers", JSONArray().put(JSONObject()
            .put("urls", "turn:127.0.0.1:$port?transport=tcp")
            .put("username", username).put("credential", credential))))
    return true
}
