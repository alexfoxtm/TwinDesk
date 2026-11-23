package com.twindesk.android

import android.content.Context
import android.os.Looper
import android.os.SystemClock
import android.view.View
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
import org.robolectric.shadows.ShadowSettings
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PointerTest {
    private fun core() = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }
        .newInstance(RuntimeEnvironment.getApplication())

    private fun Any.read(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

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
}
