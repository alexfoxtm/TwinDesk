package com.twindesk.android

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.os.SystemClock
import okhttp3.WebSocket
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.Proxy
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class IdleWiringTest {
    private val context get() = RuntimeEnvironment.getApplication()

    // Construct Core without starting its network listeners, background services or receivers.
    private fun core() = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(context)

    private fun Any.read(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun Any.write(name: String, value: Any?) {
        javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
    }

    @Test fun sendOnQuietSocketArmsProbeAndShortensBeatDelay() {
        val core = core()
        val link = core.link
        val sent = mutableListOf<String>()
        val socket = Proxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { self, method, args ->
            when (method.name) {
                "hashCode" -> System.identityHashCode(self)
                "equals" -> self === args[0]
                "send" -> { sent += args[0] as String; true }
                else -> error(method.name)
            }
        } as WebSocket
        val executor = link.read("exec") as ScheduledExecutorService
        try {
            link.write("ws", socket)
            link.write("state", "connected")
            link.write("peerIdle", true)
            val now = System.currentTimeMillis()
            link.write("quietSince", now)
            link.write("lastRx", now - 100)
            Link::class.java.getDeclaredMethod("beat").apply { isAccessible = true }.invoke(link)
            assertTrue((link.read("pinger") as ScheduledFuture<*>).getDelay(TimeUnit.SECONDS) > 250)
            link.write("beatDue", SystemClock.elapsedRealtime() - 1)
            link.write("quietSince", now - 300_001)
            core.discovery.onBeaconCycle!!.invoke()
            executor.submit {}.get(3, TimeUnit.SECONDS)
            assertTrue(sent.any { JSONObject(it).optString("t") == Proto.T.PING })
            sent.clear()
            assertTrue(link.send(JSONObject().put("t", "test")))
            executor.submit {}.get(3, TimeUnit.SECONDS)
            assertTrue((link.read("probeAt") as Long) > 0)
            assertTrue(sent.any { JSONObject(it).optString("t") == Proto.T.PING })
            assertTrue((link.read("pinger") as ScheduledFuture<*>).getDelay(TimeUnit.MILLISECONDS) <= Proto.PING_MS)
            link.wake()
            executor.submit {}.get(3, TimeUnit.SECONDS)
            assertFalse(link.quiet)
        } finally {
            Link::class.java.getDeclaredMethod("cancelBeat").apply { isAccessible = true }.invoke(link)
            executor.shutdownNow()
        }
    }

    @Test fun screenCannotReacquireDiscoveryLockAfterStop() {
        val discovery = core().discovery
        val lock = context.getSystemService(WifiManager::class.java).createMulticastLock("discovery-test")
        lock.setReferenceCounted(false)
        val screen = Discovery::class.java.getDeclaredMethod("screen", Boolean::class.javaPrimitiveType)
            .apply { isAccessible = true }
        discovery.write("lock", lock)
        discovery.write("running", true)
        screen.invoke(discovery, true)
        assertTrue(lock.isHeld)
        screen.invoke(discovery, false)
        assertFalse(lock.isHeld)
        screen.invoke(discovery, true)
        discovery.stop()
        assertFalse(lock.isHeld)
        // Give a late screen event the lock handle to exercise the running gate itself.
        discovery.write("lock", lock)
        screen.invoke(discovery, true)
        assertFalse(lock.isHeld)
    }

    private fun rememberHost(core: Core): Host {
        val host = Host("mac", "Mac", "mac", "192.0.2.1", 8080, "pin", "test", 0)
        core.store.putHost(host)
        context.getSharedPreferences("phone-return", Context.MODE_PRIVATE).edit()
            .putString("host", """{"id":"mac","fp":"pin"}""").commit()

        return host
    }

    @Suppress("DEPRECATION")
    @Test fun returnUsesRouteBeforeApplyingAwayBackoff() {
        val core = core()
        shadowOf(context.getSystemService(PowerManager::class.java)).setIsInteractive(false)
        core.store.setFlag("ble", false)
        core.store.setFlag("tailscale", false)
        val host = rememberHost(core)

        for ((route, delay) in listOf(true to 5000L, false to 60_000L)) {
            core.write("awayAttempts", 3)
            core.write("returnAfter", 0L)
            val before = System.currentTimeMillis()
            var dialed: Host? = null
            core.returnTick({ address -> assertEquals(host.address, address); route }) { candidate, _ -> dialed = candidate }
            assertEquals(host.id, dialed?.id)
            assertTrue(core.read("returnAfter") as Long in (before + delay)..(System.currentTimeMillis() + delay))
        }
    }

    @Test fun discoveryNotificationWakesLink() {
        val core = core()
        core.discovery.onNetworkChange!!.invoke()
        assertTrue((core.link.read("wokeAt") as Long) > 0)
    }

    @Test fun coreReconciliationArmsAndCancelsTimers() {
        val core = core()
        val refresh = Core::class.java.getDeclaredMethod("updateTimers").apply { isAccessible = true }
        try {
            refresh.invoke(core)
            assertNull(core.peer.read("ticker"))
            core.peer.write("tempUntil", System.currentTimeMillis() + 30_000L)
            refresh.invoke(core)
            val ticker = core.peer.read("ticker") as? ScheduledFuture<*>
            assertNotNull(ticker)
            core.peer.write("tempUntil", 0L)
            refresh.invoke(core)
            assertTrue(ticker!!.isCancelled)
            assertNull(core.peer.read("ticker"))

            rememberHost(core)
            core.write("returnAfter", System.currentTimeMillis() + 30_000)
            refresh.invoke(core)
            val returning = core.read("returnTimer") as ScheduledFuture<*>
            core.link.write("state", "connected")
            core.link.write("ble", true)
            refresh.invoke(core)
            assertTrue(returning.isCancelled)
            assertNull(core.read("returnTimer"))
            val bluetooth = core.read("bleTimer") as ScheduledFuture<*>
            core.link.write("ble", false)
            refresh.invoke(core)
            assertTrue(bluetooth.isCancelled)
            assertNull(core.read("bleTimer"))
        } finally {
            core.timers.shutdownNow()
        }
    }
}
