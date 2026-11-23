package com.twindesk.android

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class LocalSendIdleTest {
    @Test fun localSendMulticastNeededIsRunningAndAwakeOrBusy() {
        val cases = listOf(
            Triple(false, false, false) to false,
            Triple(false, false, true) to false,
            Triple(false, true, false) to false,
            Triple(false, true, true) to false,
            Triple(true, false, false) to false,
            Triple(true, false, true) to true,
            Triple(true, true, false) to true,
            Triple(true, true, true) to true,
        )
        for ((args, expected) in cases) {
            val (running, interactive, transfer) = args
            assertEquals(
                "running=$running interactive=$interactive transfer=$transfer",
                expected,
                localSendMulticastNeeded(running, interactive, transfer),
            )
        }
    }

    @Test fun pausedTickExpiresPeersAndWakeAnnouncesOnceOffTheCaller() {
        val dir = File(System.getProperty("java.io.tmpdir"), "ls-idle-${System.nanoTime()}").apply { mkdirs() }
        val node = LocalSendCore(dir, { "phone" }, idleSink(), idleEvents(), LsOptions(multicast = false))
        try {
            @Suppress("UNCHECKED_CAST")
            val peers = node.field("peers").get(node) as MutableMap<String, LsPeer>
            val stale = LsPeer(
                "p", "Other", "", "desktop", "ab".repeat(32), "192.168.1.9", 9, "https", "2.0", "",
                seen = System.currentTimeMillis() - Ls.PEER_TTL_MS - 5_000,
            )
            peers[stale.id] = stale
            val announces = AtomicInteger()
            val thread = AtomicReference("")
            node.announceObserver = {
                announces.incrementAndGet()
                thread.set(Thread.currentThread().name)
            }
            node.multicastPaused = true
            node.discoveryTick()
            assertTrue(node.peers().isEmpty())
            assertEquals(0, announces.get())

            node.pauseAnnounce(false)
            waitFor { announces.get() == 1 }
            assertEquals(1, announces.get())
            assertTrue(thread.get().contains("td-localsend"))
            assertFalse(thread.get().equals("main"))

            node.discoveryTick()
            assertEquals(2, announces.get())
        } finally {
            dir.deleteRecursively()
            (node.field("pool").get(node) as java.util.concurrent.ExecutorService).shutdownNow()
        }
    }

    @Test fun screenReceiverForwardsToLocalSendAndTheTickerHonorsThePause() {
        val core = source("src/main/java/com/twindesk/android/Core.kt")
        assertTrue(core.contains("localSend.onScreen(false)"))
        assertTrue(core.contains("localSend.onScreen(true)"))
        val protocol = source("src/main/java/com/twindesk/android/LocalSendCore.kt")
        assertTrue(protocol.contains("runCatching { discoveryTick() }"))
        assertTrue(protocol.contains("if (!multicastPaused) announce()"))
        assertFalse(protocol.contains("expire(); announce()"))
        val phone = source("src/main/java/com/twindesk/android/LocalSend.kt")
        assertTrue(phone.contains("isInteractive != false"))
        assertTrue(phone.contains("localSendMulticastNeeded"))
        assertTrue(phone.contains("announceNow()"))
    }

    @Test fun startReadsTheScreenFromPowerManager() {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(context.getSystemService(PowerManager::class.java)).setIsInteractive(false)
        val core = core(context)
        try {
            core.localSend.start()
            assertFalse(core.localSend.field("interactive").getBoolean(core.localSend))
            shadowOf(context.getSystemService(PowerManager::class.java)).setIsInteractive(true)
            core.localSend.start()
            assertTrue(core.localSend.field("interactive").getBoolean(core.localSend))
        } finally {
            core.timers.shutdownNow()
            (core.localSend.field("life").get(core.localSend) as ScheduledExecutorService).shutdownNow()
        }
    }

    @Test fun darkScreenReleasesTheLockUntilATransferOrTheScreenReturns() {
        val context = RuntimeEnvironment.getApplication()
        val core = core(context)
        val phone = core.localSend
        val dir = File(System.getProperty("java.io.tmpdir"), "ls-idle-lock-${System.nanoTime()}").apply { mkdirs() }
        val node = LocalSendCore(dir, { "phone" }, idleSink(), idleEvents(), LsOptions(multicast = false))
        val lock = context.getSystemService(WifiManager::class.java).createMulticastLock("localsend-test")
        lock.setReferenceCounted(false)
        lock.acquire()
        try {
            phone.field("node").set(phone, node)
            phone.field("multicast").set(phone, lock)
            phone.field("interactive").setBoolean(phone, true)
            phone.onScreen(false)
            await(phone)
            assertFalse(lock.isHeld)
            assertTrue(node.multicastPaused)

            // The TCP port being open is not a transfer: the lock stays down.
            node.field("receiving").setBoolean(node, true)
            phone.onScreen(false)
            await(phone)
            assertFalse(lock.isHeld)
            assertTrue(node.multicastPaused)

            val announces = AtomicInteger()
            val thread = AtomicReference("")
            node.announceObserver = {
                announces.incrementAndGet()
                thread.set(Thread.currentThread().name)
            }
            phone.transfer(LsTransfer("t1", true, "Other", "192.168.1.9", listOf("a.txt"), 1, 4, 0, "running"))
            await(phone)
            waitFor { announces.get() == 1 }
            assertTrue(lock.isHeld)
            assertFalse(node.multicastPaused)
            assertTrue(thread.get().contains("td-localsend"))

            // Already announcing for the transfer: waking the screen sends one more, for peers that missed it.
            phone.onScreen(true)
            await(phone)
            waitFor { announces.get() == 2 }
            assertEquals(2, announces.get())
            assertTrue(lock.isHeld)

            phone.onScreen(false)
            await(phone)
            assertTrue(lock.isHeld)
            assertFalse(node.multicastPaused)

            phone.transfer(LsTransfer("t1", true, "Other", "192.168.1.9", listOf("a.txt"), 1, 4, 4, "done"))
            await(phone)
            assertFalse(lock.isHeld)
            assertTrue(node.multicastPaused)
            assertEquals(2, announces.get())

            phone.onScreen(true)
            await(phone)
            waitFor { announces.get() == 3 }
            assertTrue(lock.isHeld)
            assertFalse(node.multicastPaused)
            assertEquals(3, announces.get())
        } finally {
            dir.deleteRecursively()
            core.timers.shutdownNow()
            (phone.field("life").get(phone) as ScheduledExecutorService).shutdownNow()
            (node.field("pool").get(node) as java.util.concurrent.ExecutorService).shutdownNow()
        }
    }

    private fun core(context: Context): Core = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(context)

    private fun await(phone: LocalSend) {
        (phone.field("life").get(phone) as ScheduledExecutorService).submit {}.get(3, TimeUnit.SECONDS)
    }

    private fun waitFor(ready: () -> Boolean) {
        val deadline = System.nanoTime() + 3_000_000_000L
        while (!ready() && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue(ready())
    }

    private fun source(relative: String): String {
        var dir: File? = File(System.getProperty("user.dir") ?: "")
        repeat(8) {
            val current = dir ?: return@repeat
            val direct = File(current, relative)
            if (direct.isFile) return direct.readText()
            val nested = File(current, "android/app/$relative")
            if (nested.isFile) return nested.readText()
            dir = current.parentFile
        }
        error("missing $relative from ${System.getProperty("user.dir") ?: ""}")
    }

    private fun Any.field(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }
}

private fun idleEvents() = object : LsEvents {
    override fun changed() {}
    override fun offer(o: LsOffer) {}
    override fun offerEnd(id: String, accepted: Boolean, why: String) {}
    override fun transfer(t: LsTransfer) {}
}

private fun idleSink() = object : LsSink {
    override fun free(): Long = -1
    override fun open(session: String, folder: List<String>, name: String, type: String): LsOut = error("no file")
}
