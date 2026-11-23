package com.twindesk.android

import android.content.Context
import android.content.ContextWrapper
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import org.robolectric.shadows.ShadowSettings
import org.robolectric.shadows.ShadowSystemClock
import java.lang.reflect.Proxy
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PointerTest {
    private fun core(ctx: Context = RuntimeEnvironment.getApplication()) = Core::class.java
        .getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }
        .newInstance(ctx)

    private fun Any.read(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun pointerLogs(fromIndex: Int) = ShadowLog.getLogsForTag("TwinDesk")
        .drop(fromIndex)
        .map { it.msg }
        .filter { it.startsWith("pointer ") }

    @Test fun firstAddUsesRequestedPositionAndRepeatSkipsLayout() {
        val params = WindowManager.LayoutParams()
        val applied = mutableListOf<Pair<Int, Int>>()
        placePointer(params, 10, 20, initial = true) { applied += params.x to params.y }
        placePointer(params, 10, 20, initial = false) { applied += params.x to params.y }
        placePointer(params, 30, 40, initial = false) { applied += params.x to params.y }
        assertEquals(listOf(11 to 21, 31 to 41), applied)
    }

    @Test fun failedMoveRestoresPositionSoTheNextEventCanRetry() {
        val params = WindowManager.LayoutParams()
        placePointer(params, 10, 20, initial = true) {}
        assertFalse(placePointer(params, 30, 40, initial = false) { error("layout failed") })
        assertEquals(11 to 21, params.x to params.y)
        placePointer(params, 30, 40, initial = false) { assertEquals(31 to 41, params.x to params.y) }
    }

    @Test fun failedMoveReportsTheErrorAndRestoresThePosition() {
        val params = WindowManager.LayoutParams()
        placePointer(params, 10, 20, initial = true) {}
        var seen: Throwable? = null
        assertFalse(placePointer(params, 30, 40, initial = false, onFailure = { seen = it }) { error("layout failed") })
        assertEquals("layout failed", seen?.message)
        assertEquals(11 to 21, params.x to params.y)
    }

    @Test fun hideThenShowKeepsTheArrowAfterTheLooperRuns() {
        val pointer = core().pointer
        ShadowSettings.setCanDrawOverlays(true)
        try {
            ShadowSystemClock.advanceBy(Duration.ofMillis(1000))
            val received = SystemClock.uptimeMillis()
            ShadowSystemClock.advanceBy(Duration.ofMillis(40))
            assertTrue(pointer.onPointer(JSONObject().put("on", true).put("x", 10).put("y", 20), received))
            assertTrue((pointer.read("maxQueueMs") as Long) >= 40L)
            assertEquals(1, pointer.read("msgs"))
            // on:false then on:true, the order a queued pair runs on main. hide() used to
            // post remove(), so this idle() deleted the arrow the second message had added.
            pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", false))
            assertNull(pointer.read("view"))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 30).put("y", 40)))
            val again = pointer.read("view") as View
            assertNotNull(again.parent)
            shadowOf(Looper.getMainLooper()).idle()
            assertSame(again, pointer.read("view"))
            assertNotNull(again.parent)
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }

    @Test fun frameCoalescingOverlayOwnershipAndBoundedFinalDiagnostics() {
        val pointer = core().pointer
        ShadowSettings.setCanDrawOverlays(true)
        val before = ShadowLog.getLogsForTag("TwinDesk").size
        try {
            ShadowSystemClock.advanceBy(Duration.ofMillis(1000))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 10).put("y", 20)))
            val firstOverlay = pointer.read("overlay")!!
            val firstFrameCb = firstOverlay.read("frameCb") as Choreographer.FrameCallback
            val firstPreDraw = firstOverlay.read("preDraw") as ViewTreeObserver.OnPreDrawListener

            // Multiple moves before the next frame coalesce onto a single Choreographer frame.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 30).put("y", 40)))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 50).put("y", 60)))
            assertEquals(0, pointer.read("applied"))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            assertEquals(1, pointer.read("applied"))
            val firstLp = firstOverlay.read("lp") as WindowManager.LayoutParams
            assertEquals(51 to 61, firstLp.x to firstLp.y)
            // Resolve traversal wait on the active overlay.
            firstPreDraw.onPreDraw()

            // Wait > 1s: first periodic stats line logs once, then idle overlay stops rescheduling/logging.
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1000))
            val afterFirstLog = pointerLogs(before)
            assertEquals(1, afterFirstLog.size)
            assertTrue(afterFirstLog[0].contains("msgs=3 applied=1 x=50 y=60"))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(3000))
            assertEquals(1, pointerLogs(before).size)

            // Move inside the final second, then hide: final changed counters/position must be logged.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 70).put("y", 80)))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            pointer.hide()
            val afterHide = pointerLogs(before)
            assertEquals(2, afterHide.size)
            assertTrue(afterHide[1].contains("msgs=4 applied=2 x=70 y=80"))

            // Show a replacement overlay; retired callbacks from the first overlay must not affect it.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 5).put("y", 6)))
            val secondOverlay = pointer.read("overlay")!!
            assertTrue(secondOverlay !== firstOverlay)
            val secondLp = secondOverlay.read("lp") as WindowManager.LayoutParams
            firstFrameCb.doFrame(0L)
            firstPreDraw.onPreDraw()
            assertEquals(6 to 7, secondLp.x to secondLp.y)
            assertEquals(0, pointer.read("applied"))
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }

    @Test fun initialOverlayCreationFailureIsSurfacedAndBoundedWithoutContent() {
        val base = RuntimeEnvironment.getApplication()
        val secret = "sensitive-window-token-payload"
        val failingWm = Proxy.newProxyInstance(
            WindowManager::class.java.classLoader,
            arrayOf(WindowManager::class.java),
        ) { _, method, _ ->
            if (method.name == "addView") throw WindowManager.BadTokenException(secret)
            null
        } as WindowManager
        val ctx = object : ContextWrapper(base) {
            override fun getSystemService(name: String): Any? =
                if (name == Context.WINDOW_SERVICE) failingWm else super.getSystemService(name)
        }
        val pointer = core(ctx).pointer
        ShadowSettings.setCanDrawOverlays(true)
        val before = ShadowLog.getLogsForTag("TwinDesk").size
        try {
            ShadowSystemClock.advanceBy(Duration.ofMillis(200))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 10).put("y", 20)))
            assertNull(pointer.read("view"))
            // Second immediate failure inside 1s is rate-limited.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 12).put("y", 22)))
            val logs = pointerLogs(before)
            assertEquals(1, logs.size)
            assertEquals("pointer add fail: BadTokenException host=app fail=1", logs[0])
            assertFalse(logs.any { it.contains(secret) })
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }
}
