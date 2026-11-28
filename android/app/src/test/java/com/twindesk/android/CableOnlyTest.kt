package com.twindesk.android

import android.content.Context
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.lang.reflect.Proxy
import java.util.ArrayDeque
import java.util.concurrent.ExecutorService
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

// USB-only mode through the production dials. The link executor is queued so a task sees the
// flag that was committed after it was submitted, and so a hello timeout cannot dial on its own.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class CableOnlyTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before fun clearPrefs() {
        context.getSharedPreferences("twindesk", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("phone-return", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun verifiedCableConnectsWhileWirelessIsSuspended() {
        val core = core()
        val link = core.link
        val (exec, tasks) = queueExec()
        val original = swapExec(link, exec)
        val host = Host("mac-cable", "Cable Mac", "mac", "192.0.2.10", 47800, "pin", "token", 0)
        try {
            assertFalse(core.cableOnly)
            core.store.putHost(host)
            core.cableOnly = true
            drain(tasks)
            assertTrue(core.cableOnly)
            assertTrue(Store.cableOnly(context))

            core.connectWired(host.id, 43111, "nonce-1", host.name)
            drain(tasks)
            assertTrue(link.wired)
            assertEquals("connecting", link.state)
            assertEquals("127.0.0.1" to 43111, link.endpoint())
            val current = link.read("ws") as WebSocket
            val retired = socket {}
            val control = JSONObject().put("t", "clip")
            assertTrue(link.acceptsPostedMessage(current, false, control))
            assertFalse(link.acceptsPostedMessage(retired, false, control))

            fun offer(url: String, policy: String = "relay") = JSONObject().put("ice", JSONObject()
                .put("iceTransportPolicy", policy)
                .put("iceServers", org.json.JSONArray().put(JSONObject().put("urls", url))))
            val local = "turn:127.0.0.1:47802?transport=tcp"
            assertTrue(core.cableMediaOk(offer(local)))
            assertFalse(core.cableMediaOk(offer(local, policy = "all")))
            assertFalse(core.cableMediaOk(offer("turn:192.0.2.33:47802?transport=tcp")))
            assertFalse(core.cableMediaOk(offer("turn:127.0.0.1:47802?transport=udp")))
        } finally {
            releaseSocket(link.read("ws") as WebSocket?)
            original.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun queuedWirelessDialsDieWhenCableOnlyFlips() {
        val core = core()
        val link = core.link
        val (exec, tasks) = queueExec()
        val original = swapExec(link, exec)
        val originalTimers = core.timers
        setFinal(core, "timers", queueExec().first)
        val host = Host("mac-race", "Race Mac", "mac", "192.0.2.10", 47800, "pin", "token", 0)
        val prefs = context.getSharedPreferences("phone-return", Context.MODE_PRIVATE)
        val consent = JSONObject().put("id", host.id).put("fp", host.fp).toString()
        try {
            core.store.putHost(host)
            prefs.edit().putString("host", consent).commit()
            val refresh = Core::class.java.getDeclaredMethod("updateTimers").apply { isAccessible = true }
            core.write("returnAfter", System.currentTimeMillis() + 30_000L)
            refresh.invoke(core)
            val pendingReturn = core.read("returnTimer") as ScheduledFuture<*>
            link.write("host", host)
            link.write("state", "connected")
            link.write("ble", true)
            link.write("wired", false)
            link.write("resumeKey", "resume-key")
            link.write("pending", null)
            link.write("parting", false)

            link.connect(host)
            link.connect(host, blePort = 9)
            link.connectEmbedded(core.embeddedNetwork, listOf("node-a"), host) { true }
            link.resume { "192.0.2.20" to 47801 }
            assertEquals(4, tasks.size)

            core.cableOnly = true
            repeat(4) { tasks.removeFirst().run() }
            assertNull(link.read("pending"))
            assertNull(link.endpoint())
            assertEquals("connected", link.state)
            assertFalse(link.wired)
            assertEquals(consent, prefs.getString("host", null))
            assertEquals(host.id, core.store.hosts().single().id)

            link.write("state", "idle")
            link.write("ble", false)
            drain(tasks)
            refresh.invoke(core)
            assertTrue(pendingReturn.isCancelled)
            assertNull(core.read("returnTimer"))
            assertNull(link.endpoint())
            assertNull(link.read("pending"))

            link.connect(host.copy(address = "127.0.0.1", port = 9))
            drain(tasks)
            assertFalse(link.wired)
            assertNull(link.endpoint())
            assertEquals(consent, prefs.getString("host", null))

            val cancelled = java.util.concurrent.atomic.AtomicBoolean(false)
            link.write("pending", socket { cancelled.set(true) })
            link.write("wired", false)
            link.dropWirelessRoutes()
            drain(tasks)
            assertTrue(cancelled.get())
            assertNull(link.read("pending"))

            assertEquals(
                MacWidget.ConnectResult.UNAVAILABLE,
                core.connectFromWidget(MacWidget.Request(1, MacWidget.Binding("h", "p", "r"))),
            )
            core.connect(host)
            core.pair(Found(host.id, host.name, host.os, host.address, host.port, host.fp, 0, invited = false))
            core.returnTick()
            assertTrue(tasks.isEmpty())
            assertNull(link.pair)
            assertEquals(consent, prefs.getString("host", null))
            assertEquals(listOf(host.id), core.store.hosts().map { it.id })

            core.onClosed(host, Proto.E.RELEASED)
            assertNull(prefs.getString("host", null))
            core.cableOnly = false
            core.cableOnly = true
            drain(tasks)
            assertNull(prefs.getString("host", null))
            assertEquals(listOf(host.id), core.store.hosts().map { it.id })

            prefs.edit().putString("host", consent).commit()
            link.write("state", "idle")
            core.disconnect()
            drain(tasks)
            assertNull(prefs.getString("host", null))
            assertEquals(listOf(host.id), core.store.hosts().map { it.id })
        } finally {
            releaseSocket(link.read("ws") as WebSocket?)
            (link.read("pending") as WebSocket?)?.let { runCatching { it.cancel() } }
            original.shutdownNow()
            core.bg.shutdownNow()
            originalTimers.shutdownNow()
        }
    }

    @Test fun stopOrSignOutDuringCableOnlyCannotRestartEmbeddedNetwork() {
        for (signOut in listOf(false, true)) {
            val core = core()
            val network = core.embeddedNetwork
            val originalWorker = network.read("worker") as ExecutorService
            val (worker, queued) = queueExec()
            try {
                network.write("worker", worker)
                core.store.setEmbeddedEnabled(true)
                network.write("desired", true)
                core.cableOnly = true
                assertFalse(network.enabled)

                core.stopEmbedded(signOut)
                val pendingStops = queued.size
                // Exercise the running Core's real toggle path without starting discovery or
                // executing the queued native-engine work.
                core.store.setFlag("ble", false)
                core.discovery.write("running", true)
                core.write("started", true)
                core.cableOnly = false

                assertFalse("Explicit stop or sign out must win over the saved resume", network.enabled)
                assertEquals(!signOut, core.store.flag(com.twindesk.android.embedded.EmbeddedNetwork.ENABLED, false))
                assertEquals(pendingStops, queued.size)
            } finally {
                core.discovery.write("running", false)
                originalWorker.shutdownNow()
                core.timers.shutdownNow()
                core.bg.shutdownNow()
            }
        }
    }

    @Test fun preferenceOffStillDialsLan() {
        val core = core()
        val link = core.link
        val (exec, tasks) = queueExec()
        val original = swapExec(link, exec)
        val host = Host("mac-lan", "Lan Mac", "mac", "192.0.2.10", 47800, "pin", "token", 0)
        try {
            assertFalse(core.store.flag(Core.CABLE_ONLY, false))
            link.connect(host)
            drain(tasks)
            assertEquals("connecting", link.state)
            assertFalse(link.wired)
            assertEquals("192.0.2.10" to 47800, link.endpoint())
            assertFalse(core.cableOnly)
        } finally {
            releaseSocket(link.read("ws") as WebSocket?)
            original.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    private fun core() = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(context)

    private fun Any.read(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun Any.write(name: String, value: Any?) {
        javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
    }

    private fun queueExec(): Pair<ScheduledExecutorService, ArrayDeque<Runnable>> {
        val tasks = ArrayDeque<Runnable>()
        val exec = Proxy.newProxyInstance(
            ScheduledExecutorService::class.java.classLoader,
            arrayOf(ScheduledExecutorService::class.java),
        ) { proxy, method, args ->
            when (method.name) {
                "execute" -> { tasks.addLast(args[0] as Runnable); null }
                "schedule", "scheduleAtFixedRate", "scheduleWithFixedDelay" -> TestFuture()
                "submit" -> TestFuture(completed = true)
                "shutdownNow" -> emptyList<Runnable>()
                "shutdown" -> null
                "isShutdown", "isTerminated" -> false
                "awaitTermination" -> true
                "toString" -> "link-queue"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.get(0)
                else -> error("unexpected executor call ${method.name}")
            }
        } as ScheduledExecutorService
        return exec to tasks
    }

    private fun swapExec(link: Link, exec: ScheduledExecutorService): ExecutorService {
        val original = link.read("exec") as ExecutorService
        setFinal(link, "exec", exec)
        return original
    }

    private fun setFinal(target: Any, name: String, value: Any?) {
        val field = target.javaClass.getDeclaredField(name)
        field.isAccessible = true
        try {
            field.set(target, value)
        } catch (_: IllegalAccessException) {
            val unsafeClass = Class.forName("sun.misc.Unsafe")
            val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
            val offset = unsafeClass.getMethod("objectFieldOffset", Field::class.java).invoke(unsafe, field) as Long
            unsafeClass.getMethod("putObject", Any::class.java, java.lang.Long.TYPE, Any::class.java)
                .invoke(unsafe, target, offset, value)
        }
    }

    private fun drain(tasks: ArrayDeque<Runnable>) {
        var guard = 0
        while (tasks.isNotEmpty()) {
            tasks.removeFirst().run()
            if (++guard > 40) error("link queue did not settle")
        }
        shadowOf(Looper.getMainLooper()).idle()
    }


    private fun socket(onCancel: () -> Unit): WebSocket =
        Proxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { proxy, method, args ->
            when (method.name) {
                "cancel" -> { onCancel(); null }
                "send", "close" -> false
                "queueSize" -> 0L
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.get(0)
                "toString" -> "pending"
                else -> when (method.returnType) {
                    java.lang.Boolean.TYPE -> false
                    java.lang.Integer.TYPE -> 0
                    java.lang.Long.TYPE -> 0L
                    else -> null
                }
            }
        } as WebSocket

    private fun releaseSocket(socket: WebSocket?) {
        if (socket == null) return
        runCatching { socket.cancel() }
        val call = socket.javaClass.declaredFields.firstOrNull { it.name == "call" }
            ?.apply { isAccessible = true }?.get(socket) ?: return
        val client = call.javaClass.declaredFields.firstOrNull { it.name == "client" }
            ?.apply { isAccessible = true }?.get(call) as? OkHttpClient ?: return
        runCatching { client.dispatcher.executorService.shutdownNow() }
        runCatching { client.connectionPool.evictAll() }
    }

    private class TestFuture(private val completed: Boolean = false) : ScheduledFuture<Any> {
        private var cancelled = false
        override fun cancel(mayInterruptIfRunning: Boolean): Boolean {
            if (isDone) return false
            cancelled = true
            return true
        }
        override fun isCancelled() = cancelled
        override fun isDone() = completed || cancelled
        override fun get(): Any? = null
        override fun get(timeout: Long, unit: TimeUnit): Any? = null
        override fun getDelay(unit: TimeUnit) = 0L
        override fun compareTo(other: java.util.concurrent.Delayed) = 0
    }
}
