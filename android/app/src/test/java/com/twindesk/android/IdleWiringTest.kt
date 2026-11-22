package com.twindesk.android

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.robolectric.shadows.ShadowSettings
import android.app.AlarmManager
import android.content.Context
import android.net.RouteInfo
import android.net.IpPrefix
import java.net.InetAddress
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import org.robolectric.shadows.ShadowLog
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.LinkProperties
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.View
import okhttp3.WebSocket
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities
import java.time.Duration
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
            val alarms = shadowOf(context.getSystemService(AlarmManager::class.java))
            assertEquals(AlarmManager.ELAPSED_REALTIME, alarms.scheduledAlarms.single().getType())
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
            assertTrue(alarms.scheduledAlarms.isEmpty())
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
        val discovery = core.discovery
        discovery.write("running", true)
        val callback = discovery.read("networkWatch") as ConnectivityManager.NetworkCallback
        val lan = ShadowNetwork.newInstance(1)
        val cellular = ShadowNetwork.newInstance(2)
        val vpn = ShadowNetwork.newInstance(3)
        fun caps(vararg transports: Int) = ShadowNetworkCapabilities.newInstance().also { caps ->
            transports.forEach { shadowOf(caps).addTransportType(it) }
        }
        fun properties(name: String, ip: String) = LinkProperties().apply {
            interfaceName = name
            val address = LinkAddress::class.java.getConstructor(String::class.java).newInstance(ip)
            LinkProperties::class.java.getMethod("addLinkAddress", LinkAddress::class.java).invoke(this, address)
        }
        try {
            callback.onCapabilitiesChanged(cellular, caps(NetworkCapabilities.TRANSPORT_CELLULAR))
            callback.onLinkPropertiesChanged(cellular, properties("mobile", "192.0.2.1/24"))
            callback.onLost(cellular)
            callback.onCapabilitiesChanged(vpn, caps(NetworkCapabilities.TRANSPORT_VPN, NetworkCapabilities.TRANSPORT_WIFI))
            callback.onLinkPropertiesChanged(vpn, properties("vpn", "192.0.2.1/24"))
            assertEquals(0L, core.link.read("wokeAt"))

            callback.onCapabilitiesChanged(lan, caps(NetworkCapabilities.TRANSPORT_WIFI))
            val firstPath = properties("wifi", "192.0.2.2/24")
            callback.onLinkPropertiesChanged(lan, firstPath)
            assertTrue((core.link.read("wokeAt") as Long) > 0)
            core.link.write("wokeAt", 0L)
            callback.onLinkPropertiesChanged(lan, firstPath)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            assertEquals(0L, core.link.read("wokeAt"))

            callback.onLinkPropertiesChanged(lan, properties("wifi", "192.0.2.3/24"))
            assertTrue((core.link.read("wokeAt") as Long) > 0)
            core.link.write("wokeAt", 0L)
            callback.onLinkPropertiesChanged(lan, properties("wifi", "192.0.2.4/24"))
            assertEquals(0L, core.link.read("wokeAt"))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            assertTrue((core.link.read("wokeAt") as Long) > 0)
        } finally {
            discovery.stop()
        }
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

    private fun awaitCondition(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (!condition() && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue(condition())
    }

    @Test fun changedReconcilesAgainOnTheTimerExecutor() {
        val core = core()
        core.timers.shutdownNow()
        val timers = Executors.newSingleThreadScheduledExecutor()
        core.write("timers", timers)
        core.write("started", true)
        core.store.setFlag("ble", false)
        try {
            core.peer.write("tempUntil", System.currentTimeMillis() + 30_000)
            core.changed()
            timers.submit {}.get(3, TimeUnit.SECONDS)
            val ticker = core.peer.read("ticker") as? ScheduledFuture<*>
            assertNotNull(ticker)
            // Prevent Peer's own tick from reconciling before the second assertion.
            ticker!!.cancel(false)
            core.peer.write("tempUntil", 0L)
            core.changed()
            timers.submit {}.get(3, TimeUnit.SECONDS)
            assertNull(core.peer.read("ticker"))
        } finally {
            timers.shutdownNow()
        }
    }

    @Test fun returnTimerRearmsAfterItFires() {
        val core = core()
        core.write("started", true)
        core.store.setFlag("ble", false)
        val host = rememberHost(core)
        // An older Mac suppresses real socket IO but still consumes and reschedules a return tick.
        core.discovery.found[host.id] = Found(host.id, "Mac", "mac", host.address, host.port, host.fp, 0, false)
        try {
            core.changed()
            awaitCondition { (core.read("returnTimer") as? ScheduledFuture<*>)?.getDelay(TimeUnit.MILLISECONDS)?.let { it > 1_000 } == true }
        } finally {
            core.timers.shutdownNow()
        }
    }

    @Test fun lanChangeRunsReturnImmediatelyDespiteExistingBackoff() {
        val core = core()
        core.write("started", true)
        core.store.setFlag("ble", false)
        val host = rememberHost(core)
        core.discovery.found[host.id] = Found(host.id, "Mac", "mac", host.address, host.port, host.fp, 0, false)
        val backedOff = System.currentTimeMillis() + 60_000
        core.write("returnAfter", backedOff)
        try {
            core.discovery.onNetworkChange!!.invoke()
            awaitCondition { (core.read("returnAfter") as Long) in 1 until backedOff }
        } finally {
            core.timers.shutdownNow()
        }
    }

    @Test fun mobileReturnCutsAwayBackoffWithFullTunnelVpnPresent() {
        val core = core()
        val discovery = core.discovery
        discovery.write("running", true)
        val callback = discovery.read("networkWatch") as ConnectivityManager.NetworkCallback
        val properties = LinkProperties().apply {
            val prefix = IpPrefix::class.java.getConstructor(String::class.java).newInstance("0.0.0.0/0")
            val route = RouteInfo::class.java.getConstructor(IpPrefix::class.java, InetAddress::class.java, String::class.java)
                .newInstance(prefix, InetAddress.getByName("192.0.2.1"), null)
            addRoute(route)
        }
        core.store.setFlag("ble", false)
        val host = rememberHost(core)
        core.discovery.found[host.id] = Found(host.id, "Mac", "mac", host.address, host.port, host.fp, 0, false)
        core.write("started", true)
        val mobile = ShadowNetwork.newInstance(1)
        val vpn = ShadowNetwork.newInstance(2)
        val backedOff = System.currentTimeMillis() + 60_000
        try {
            fun caps(transport: Int, internet: Boolean) = ShadowNetworkCapabilities.newInstance().also {
                shadowOf(it).addTransportType(transport)
                if (internet) shadowOf(it).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }
            val ims = ShadowNetwork.newInstance(3)
            val mobileCaps = caps(NetworkCapabilities.TRANSPORT_CELLULAR, true)
            val wifi = ShadowNetwork.newInstance(4)
            val onReturn = checkNotNull(discovery.onRouteAvailable)
            var returns = 0
            discovery.onRouteAvailable = { returns++ }
            var lanChanges = 0
            discovery.onNetworkChange = { lanChanges++ }
            core.write("awayAttempts", 3)
            core.write("returnAfter", backedOff)
            callback.onCapabilitiesChanged(vpn, caps(NetworkCapabilities.TRANSPORT_VPN, true))
            callback.onLinkPropertiesChanged(vpn, properties)
            assertEquals("VPN does not advertise a usable route", 0, returns)
            callback.onCapabilitiesChanged(ims, caps(NetworkCapabilities.TRANSPORT_CELLULAR, false))
            callback.onLinkPropertiesChanged(ims, properties)
            assertEquals("IMS does not advertise a usable route", 0, returns)
            callback.onLost(ims)

            callback.onCapabilitiesChanged(wifi, caps(NetworkCapabilities.TRANSPORT_WIFI, true))
            callback.onLinkPropertiesChanged(wifi, properties)
            val beforeChurn = lanChanges
            callback.onCapabilitiesChanged(mobile, mobileCaps)
            callback.onLinkPropertiesChanged(mobile, properties)
            callback.onLost(mobile)
            assertEquals("mobile churn does not wake the LAN path", beforeChurn, lanChanges)
            assertEquals("mobile churn cannot signal a return while Wi-Fi has a route", 0, returns)

            callback.onLost(wifi)
            val beforeMobile = discovery.read("beaconRevision")
            val wokeBeforeMobile = core.link.read("wokeAt")
            discovery.onRouteAvailable = onReturn
            callback.onLinkPropertiesChanged(mobile, properties)
            callback.onCapabilitiesChanged(mobile, mobileCaps)
            awaitCondition { (core.read("returnAfter") as Long) in 1 until backedOff }

            assertEquals(wokeBeforeMobile, core.link.read("wokeAt"))
            assertEquals(beforeMobile, discovery.read("beaconRevision"))
        } finally {
            core.timers.shutdownNow()
        }
    }

    @Test fun firstMobileReturnDialsImmediatelyAfterAwayBackoff() {
        val core = core()
        rememberHost(core)
        core.write("awayAttempts", 3)
        core.write("returnAfter", System.currentTimeMillis() + 60_000)
        var dials = 0
        core.retryRouteReturn { core.returnTick({ true }) { _, _ -> dials++ } }
        assertEquals(1, dials)
    }

    @Test fun mobileFlapsRespectCooldownAndFailureBackoff() {
        val core = core()
        core.store.setFlag("ble", false)
        val host = rememberHost(core)
        var dials = 0
        fun restore() {
            core.retryRouteReturn { core.returnTick({ true }) { _, _ -> dials++ } }
        }
        core.write("awayAttempts", 3)
        val awayDeadline = System.currentTimeMillis() + 60_000
        core.write("returnAfter", awayDeadline)
        restore()
        assertEquals(1, dials)

        core.write("awayAttempts", 3)
        core.write("returnAfter", awayDeadline)
        repeat(10) { restore() }
        assertEquals(1, dials)
        assertEquals(awayDeadline, core.read("returnAfter"))

        core.write("returnAfter", 1L)
        core.onClosed(host, null)
        val failureDeadline = core.read("returnFailureDeadline") as Long
        assertTrue(failureDeadline > System.currentTimeMillis())
        assertEquals(failureDeadline, core.read("returnAfter"))
        core.write("lastRouteReturn", SystemClock.elapsedRealtime() - 5000)
        restore()
        assertEquals(1, dials)
        assertEquals(failureDeadline, core.read("returnAfter"))
    }

    @Test fun wiredLanTransportsWakeTheLink() {
        for (transport in listOf(NetworkCapabilities.TRANSPORT_ETHERNET, NetworkCapabilities.TRANSPORT_USB)) {
            val core = core()
            val discovery = core.discovery
            discovery.write("running", true)
            val callback = discovery.read("networkWatch") as ConnectivityManager.NetworkCallback
            val network = ShadowNetwork.newInstance(transport)
            val caps = ShadowNetworkCapabilities.newInstance()
            shadowOf(caps).addTransportType(transport)
            callback.onCapabilitiesChanged(network, caps)
            callback.onLinkPropertiesChanged(network, LinkProperties().apply { interfaceName = "wired" })
            assertTrue("LAN transport $transport should wake Link", (core.link.read("wokeAt") as Long) > 0)
        }
    }

    @Test fun losingNetworkInvalidatesPrimedTargets() {
        val discovery = core().discovery
        discovery.write("running", true)
        Discovery::class.java.getDeclaredMethod("targets").apply { isAccessible = true }.invoke(discovery)
        assertNotNull(discovery.read("cachedTargets"))
        val callback = discovery.read("networkWatch") as ConnectivityManager.NetworkCallback
        callback.onLost(ShadowNetwork.newInstance(1))
        assertNull(discovery.read("cachedTargets"))
    }

    @Test fun failedHeartbeatRearmsAndRecovers() {
        val link = core().link
        val executor = link.read("exec") as ScheduledExecutorService
        val beat = Link::class.java.getDeclaredMethod("beat").apply { isAccessible = true }
        var failing = true
        val socket = Proxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { self, method, args ->
            when (method.name) {
                "hashCode" -> System.identityHashCode(self)
                "equals" -> self === args[0]
                "send" -> { check(!failing) { "socket send failed" }; true }
                else -> error(method.name)
            }
        } as WebSocket
        try {
            link.write("ws", socket)
            link.write("state", "connected")
            link.write("lastRx", System.currentTimeMillis())
            beat.invoke(link)
            val retry = link.read("pinger") as? ScheduledFuture<*>
            assertNotNull(retry)
            beat.invoke(link)
            assertTrue((link.read("pinger") as ScheduledFuture<*>).getDelay(TimeUnit.MILLISECONDS) > Proto.PING_MS)
            assertEquals(1, ShadowLog.getLogsForTag("TwinDesk").count { it.msg == "link heartbeat" })
            failing = false
            beat.invoke(link)
            assertEquals(0, link.read("beatFailures"))
            assertTrue((link.read("pinger") as ScheduledFuture<*>).getDelay(TimeUnit.MILLISECONDS) <= Proto.PING_MS)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun fastFileHoldNudgesTheConnectedLink() {
        val core = core()
        val link = core.link
        val executor = link.read("exec") as ScheduledExecutorService
        val awake = core.files.read("awake") as Awake
        try {
            link.write("state", "connected")
            link.busyHere = { core.files.moving }
            awake.touch()
            executor.submit {}.get(3, TimeUnit.SECONDS)
            assertEquals("feature", link.read("lastQuietReason"))
        } finally {
            awake.release()
            (awake.read("timer") as ScheduledExecutorService).shutdownNow()
            executor.shutdownNow()
        }
    }

    @Test fun wantedHostingArmsRetryWithNoOtherPeerWork() {
        val core = core()
        try {
            core.store.setFlag("peer.on", true)
            core.store.setFlag("peer.host", true)
            core.peer.updateTicker()
            assertNotNull(core.peer.read("ticker"))
        } finally {
            core.timers.shutdownNow()
        }
    }

    @Test fun deviceControlArmsDeadlineAndClearsPendingOnClose() {
        val core = core()
        val builds = core.dev.read("stateBuilds") as DeviceStateBuilds<*>
        val worker = mutableListOf<Runnable>()
        builds.write("executor", Executor { worker.add(it) })
        core.link.write("state", "connected")
        core.link.write("ws", Proxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { _, _, _ -> error("unexpected socket operation") })
        builds.request(false)
        assertEquals(1, worker.size)
        val main = shadowOf(Looper.getMainLooper())
        main.idleFor(Duration.ofSeconds(20))
        assertTrue(ShadowLog.getLogsForTag("TwinDesk").any { it.msg == "Device state build timed out" })
        builds.request(true)
        assertEquals(true, builds.read("pending"))
        core.dev.onClosed()
        main.idle()
        assertNull(builds.read("pending"))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun setupTickerStopsWhenActivityStops() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val owner = object : LifecycleOwner {
                override val lifecycle = LifecycleRegistry(this)
            }
            owner.lifecycle.currentState = Lifecycle.State.RESUMED
            var ticks = 0
            backgroundScope.launch { refreshSetupWhileResumed(owner.lifecycle) { ticks++ } }
            advanceTimeBy(1501)
            assertEquals(1, ticks)
            owner.lifecycle.currentState = Lifecycle.State.CREATED
            advanceTimeBy(4500)
            assertEquals(1, ticks)
            owner.lifecycle.currentState = Lifecycle.State.RESUMED
            advanceTimeBy(1501)
            assertEquals(2, ticks)
            owner.lifecycle.currentState = Lifecycle.State.DESTROYED
            runCurrent()
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test fun firstPointerMessageAddsAnOverlayAtDefaultWindowCoordinates() {
        val pointer = core().pointer
        ShadowSettings.setCanDrawOverlays(true)
        try {
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", -1).put("y", -1)))
            val view = pointer.read("view") as View
            assertNotNull(view.parent)
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }
}
