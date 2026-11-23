// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Idle performance tier on the phone (Link.kt beat / beatConnected). Times are literals so a
// mutated constant or comparison fails the test.
package com.twindesk.android

import android.app.AlarmManager
import android.content.Context
import okhttp3.WebSocket
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
class PingKeepaliveTest {
    private val context get() = RuntimeEnvironment.getApplication()

    private class Harness(context: Context) {
        val sent = mutableListOf<String>()
        var cancelled = false
        val socket: WebSocket = Proxy.newProxyInstance(
            WebSocket::class.java.classLoader,
            arrayOf(WebSocket::class.java),
        ) { self, method, args ->
            when (method.name) {
                "hashCode" -> System.identityHashCode(self)
                "equals" -> self === args[0]
                "send" -> { sent += args[0] as String; true }
                "cancel" -> { cancelled = true; null }
                "close" -> null
                "queueSize" -> 0L
                else -> error(method.name)
            }
        } as WebSocket
        val link = Link(Store(context), object : Link.Events {
            override fun onChange() {}
            override fun onWelcome(host: Host) {}
            override fun onMessage(m: JSONObject, route: Link.TrustedRoute?, source: WebSocket) {}
            override fun onClosed(host: Host, code: String?) {}
        }, context = context)
        val exec = link.read("exec") as ScheduledExecutorService
        private val alarms = shadowOf(context.getSystemService(AlarmManager::class.java)!!)
        var alarmAdded = 0
            private set

        init {
            link.write("ws", socket)
            link.write("state", "connected")
            link.write("lastUse", System.currentTimeMillis() - 60_000)
            link.write("lastRx", System.currentTimeMillis())
        }

        fun beat(): Long {
            val before = alarms.scheduledAlarms.size
            Link::class.java.getDeclaredMethod("beat").apply { isAccessible = true }.invoke(link)
            val delay = (link.read("pinger") as ScheduledFuture<*>).getDelay(TimeUnit.MILLISECONDS)
            alarmAdded = alarms.scheduledAlarms.size - before
            Link::class.java.getDeclaredMethod("cancelBeat").apply { isAccessible = true }.invoke(link)
            return delay
        }

        fun text(json: String) {
            Link::class.java.getDeclaredMethod("onText", String::class.java, WebSocket::class.java)
                .apply { isAccessible = true }
                .invoke(link, json, socket)
            exec.submit {}.get(3, TimeUnit.SECONDS)
            Link::class.java.getDeclaredMethod("cancelBeat").apply { isAccessible = true }.invoke(link)
        }

        fun pings() = sent.map { JSONObject(it) }.filter { it.optString("t") == Proto.T.PING }
        fun idles() = sent.map { JSONObject(it) }.filter { it.optString("t") == "idle" }
        fun close() {
            Link::class.java.getDeclaredMethod("cancelBeat").apply { isAccessible = true }.invoke(link)
            exec.shutdownNow()
        }
    }

    private fun peer(h: Harness, on: Boolean, perf: Boolean = false, keep: Boolean = false) {
        h.link.write("peerIdle", on)
        if (perf) h.link.write("peerPerf", true)
        h.link.write("peerKeep", keep)
    }

    @Suppress("UNCHECKED_CAST")
    private fun peerPing(h: Harness, ageMs: Long) {
        val map = h.link.read("lastPeerPingOf") as java.util.concurrent.ConcurrentHashMap<WebSocket, Long>
        map[h.socket] = System.currentTimeMillis() - ageMs
    }

    @Test fun keepOffAndPeerNotIdleStaysOnTheSecond() {
        val h = Harness(context)
        try {
            val delay = h.beat()
            assertTrue(h.pings().isNotEmpty())
            val idle = h.idles().single()
            assertTrue(idle.optBoolean("on"))
            assertFalse(idle.has("perf"))
            assertFalse(h.link.quiet)
            assertEquals(0L, h.link.read("perfSince"))
            assertTrue("delay=$delay", delay in 1..1_000)
            assertEquals(0, h.alarmAdded)
        } finally { h.close() }
    }

    @Test fun bothIdleWithoutPerformanceIsTheLongQuiet() {
        val h = Harness(context)
        try {
            peer(h, on = true)
            val delay = h.beat()
            assertTrue(h.pings().isEmpty())
            assertTrue(h.link.quiet)
            assertTrue("delay=$delay", delay > 250_000)
            assertEquals(1, h.alarmAdded)
            assertEquals(0L, h.link.read("perfSince"))
        } finally { h.close() }
    }

    @Test fun performanceOnWithoutPeerPerfStaysOnTheSecond() {
        val h = Harness(context)
        try {
            h.link.keepPinging = true
            peer(h, on = true)
            h.link.write("lastRx", System.currentTimeMillis() - 7_000)
            var delay = h.beat()
            assertFalse(h.cancelled)
            assertTrue(h.pings().isNotEmpty())
            val idle = h.idles().single()
            assertFalse(idle.optBoolean("on"))
            assertEquals(1, idle.optInt("perf"))
            assertFalse(idle.has("keep"))
            assertFalse(h.link.quiet)
            assertEquals(0L, h.link.read("perfSince"))
            assertTrue("delay=$delay", delay in 1..1_000)
            assertEquals(0, h.alarmAdded)
            h.sent.clear()
            h.link.write("lastRx", System.currentTimeMillis() - 9_000)
            delay = h.beat()
            assertTrue("an older peer still uses the 8 s limit", h.cancelled)
            assertTrue("delay=$delay", delay in 1..1_000)
        } finally { h.close() }
    }

    @Test fun performanceOnAndBothIdlePingsEveryThreeSeconds() {
        val h = Harness(context)
        try {
            h.link.keepPinging = true
            peer(h, on = true, perf = true, keep = true)
            var delay = h.beat()
            assertTrue(h.pings().isEmpty())
            assertFalse(h.link.quiet)
            assertTrue(h.link.read("perfSince") as Long > 0L)
            val idle = h.idles().single()
            assertTrue(idle.optBoolean("on"))
            assertEquals(1, idle.optInt("perf"))
            assertEquals(1, idle.optInt("keep"))
            assertTrue("delay=$delay", delay in 2_000..3_000)
            assertEquals(0, h.alarmAdded)
            h.link.write("perfSince", System.currentTimeMillis() - 2_000)
            h.link.write("perfPing", 0L)
            h.beat()
            assertTrue("no ping before 3 s", h.pings().isEmpty())
            h.link.write("perfSince", System.currentTimeMillis() - 3_500)
            h.link.write("perfPing", 0L)
            h.beat()
            assertEquals(1, h.pings().size)
            h.link.write("lastRx", System.currentTimeMillis() - 9_000)
            h.link.write("quietEnd", 0L)
            h.link.write("perfEnd", 0L)
            h.cancelled = false
            h.beat()
            assertFalse("9 s of silence stays up on the 10 s limit", h.cancelled)
            h.link.write("lastRx", System.currentTimeMillis() - 11_000)
            h.beat()
            assertTrue("silent past 10 s: closed", h.cancelled)
        } finally { h.close() }
    }

    @Test fun activityOrIdleOffReturnsToTheSecond() {
        val h = Harness(context)
        try {
            h.link.keepPinging = true
            peer(h, on = true, perf = true, keep = true)
            h.beat()
            assertTrue(h.link.read("perfSince") as Long > 0L)
            h.sent.clear()
            h.link.busyReason = { "viewer" }
            val delay = h.beat()
            assertTrue(h.pings().isNotEmpty())
            assertEquals(0L, h.link.read("perfSince"))
            assertFalse(h.link.quiet)
            val idle = h.idles().last()
            assertFalse(idle.optBoolean("on"))
            assertTrue("delay=$delay", delay in 1..1_000)
            h.link.busyReason = { null }
            h.beat()
            assertTrue(h.link.read("perfSince") as Long > 0L)
            h.sent.clear()
            h.text("""{"t":"idle","on":false}""")
            assertEquals(0L, h.link.read("perfSince"))
            assertTrue(h.pings().isNotEmpty())
            assertFalse(h.link.quiet)
        } finally { h.close() }
    }

    @Test fun leavingLongQuietForTheIdleTierDoesNotDrop() {
        val h = Harness(context)
        try {
            val now = System.currentTimeMillis()
            h.link.write("quietSince", now - 240_000)
            h.link.write("lastRx", now - 240_000)
            peer(h, on = true, perf = true, keep = true)
            h.beat()
            assertFalse(h.cancelled)
            assertFalse(h.link.quiet)
            assertTrue(h.link.read("perfSince") as Long > 0L)
            // A second later the socket still reports the old last-heard time. quietEnd is what
            // keeps that from looking like ten seconds of silence.
            h.link.write("quietEnd", System.currentTimeMillis() - 1_000)
            h.link.write("lastRx", System.currentTimeMillis() - 240_000)
            h.beat()
            assertFalse("the next beat is given the old last-heard time and still stays up", h.cancelled)
        } finally { h.close() }
    }

    @Test fun onlyThePeerHasPerformanceUsesThreeSecondsNotTheLongQuiet() {
        val h = Harness(context)
        try {
            peer(h, on = true, perf = true, keep = true)
            val delay = h.beat()
            assertFalse(h.link.quiet)
            assertTrue(h.link.read("perfSince") as Long > 0L)
            assertTrue(h.pings().isEmpty())
            assertTrue("delay=$delay", delay in 2_000..3_000)
            assertEquals(0, h.alarmAdded)
            val idle = h.idles().single()
            assertTrue(idle.optBoolean("on"))
            assertEquals(1, idle.optInt("perf"))
            assertFalse(idle.has("keep"))
        } finally { h.close() }
    }

    @Test fun bluetoothStaysOffTheIdlePerformanceTier() {
        val h = Harness(context)
        try {
            h.link.keepPinging = true
            h.link.write("ble", true)
            peer(h, on = true, perf = true, keep = true)
            h.link.write("lastRx", System.currentTimeMillis() - 9_000)
            val delay = h.beat()
            assertFalse(h.cancelled)
            assertTrue(h.pings().isNotEmpty())
            assertEquals(0L, h.link.read("perfSince"))
            assertTrue("delay=$delay", delay in 1..1_000)
            h.link.write("lastRx", System.currentTimeMillis() - 21_000)
            h.beat()
            assertTrue(h.cancelled)
        } finally { h.close() }
    }

    @Test fun phoneSkipsItsPingWhileTheComputerJustPinged() {
        val h = Harness(context)
        try {
            h.text("""{"t":"ping","ts":7}""")
            val pong = h.sent.map { JSONObject(it) }.single { it.optString("t") == Proto.T.PONG }
            assertEquals(7, pong.optInt("ts"))
            assertTrue("answering the computer's ping does not send one of our own", h.pings().isEmpty())
            h.sent.clear()
            peerPing(h, 400)
            val delay = h.beat()
            assertTrue("a computer ping 400 ms ago covers this 1 s interval", h.pings().isEmpty())
            assertTrue("delay=$delay", delay in 300..800)
            assertEquals(0, h.alarmAdded)
        } finally { h.close() }
    }

    @Test fun phonePingsAtOnceWhenThatComputerPingIsOneIntervalOld() {
        val h = Harness(context)
        try {
            peerPing(h, 1_000)
            val delay = h.beat()
            assertEquals("one interval with no computer ping: our ping goes on this beat", 1, h.pings().size)
            assertTrue("delay=$delay", delay in 800..1_000)
        } finally { h.close() }
    }

    @Test fun idlePerformanceSkipsADuePingWhenTheComputerPingedInsideThreeSeconds() {
        val h = Harness(context)
        try {
            h.link.keepPinging = true
            peer(h, on = true, perf = true, keep = true)
            h.beat()
            h.sent.clear()
            h.link.write("perfSince", System.currentTimeMillis() - 3_500)
            h.link.write("perfPing", 0L)
            peerPing(h, 1_500)
            val delay = h.beat()
            assertTrue("1500 ms is inside the 3 s interval, so the due ping is skipped", h.pings().isEmpty())
            assertTrue("delay=$delay", delay in 1_000..2_000)
        } finally { h.close() }
    }

    @Test fun idlePerformancePingsAtOnceWhenTheComputerPingIsStale() {
        val h = Harness(context)
        try {
            h.link.keepPinging = true
            peer(h, on = true, perf = true, keep = true)
            h.beat()
            h.sent.clear()
            h.link.write("perfSince", System.currentTimeMillis() - 1_000)
            h.link.write("perfPing", 0L)
            peerPing(h, 3_000)
            h.beat()
            assertEquals("the 3 s cadence is not due, but the computer ping is, so we ping now", 1, h.pings().size)
        } finally { h.close() }
    }

    @Test fun quietSafetyPingIsSkippedWhileTheComputerPingIsFresh() {
        val h = Harness(context)
        try {
            peer(h, on = true)
            h.link.write("quietSince", System.currentTimeMillis() - (5 * 60 * 1000 + 1_000))
            h.link.write("quietPing", 0L)
            h.link.write("lastRx", System.currentTimeMillis())
            peerPing(h, 1_000)
            h.beat()
            assertTrue("the 5 min safety ping waits while the computer's ping is inside that interval", h.pings().isEmpty())
            assertTrue(h.link.quiet)
        } finally { h.close() }
    }

    @Test fun quietProbeStillGoesOutWhileTheComputerPingIsFresh() {
        val h = Harness(context)
        try {
            peer(h, on = true)
            val now = System.currentTimeMillis()
            h.link.write("quietSince", now - 1_000)
            h.link.write("probeAt", now)
            h.link.write("probed", false)
            h.link.write("lastRx", now - 100)
            peerPing(h, 0)
            val delay = h.beat()
            assertEquals("a quiet probe is still sent", 1, h.pings().size)
            assertTrue("delay=$delay", delay in 1..1_000)
            assertEquals(0, h.alarmAdded)
        } finally { h.close() }
    }

    @Test fun pongStillMeasuresRttAndDoesNotCountAsAComputerPing() {
        val h = Harness(context)
        try {
            val sentAt = System.currentTimeMillis() - 40
            h.text("""{"t":"pong","ts":$sentAt}""")
            val rtt = h.link.rttMs
            assertTrue("rtt=$rtt", rtt != null && rtt >= 20 && rtt < 5_000)
            assertTrue(h.pings().isEmpty())
            assertTrue((h.link.read("lastPeerPingOf") as Map<*, *>).isEmpty())
            h.sent.clear()
            h.beat()
            assertEquals(1, h.pings().size)
        } finally { h.close() }
    }
}

private fun Any.read(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)
private fun Any.write(name: String, value: Any?) {
    javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
}
