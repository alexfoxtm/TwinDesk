package com.twindesk.android

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Handler
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
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
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

    private fun pointer(ctx: Context = RuntimeEnvironment.getApplication()): Pointer =
        core(ctx).pointer.also { pointer ->
            Pointer::class.java.getDeclaredField("worker").apply { isAccessible = true }
                .set(pointer, Handler.createAsync(Looper.getMainLooper()))
        }

    private fun Any.read(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun InputService.connectService() {
        InputService::class.java.getDeclaredMethod("onServiceConnected").apply { isAccessible = true }.invoke(this)
    }

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
        val pointer = pointer()
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
        val pointer = pointer()
        ShadowSettings.setCanDrawOverlays(true)
        val before = ShadowLog.getLogsForTag("TwinDesk").size
        try {
            ShadowSystemClock.advanceBy(Duration.ofMillis(1000))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 10).put("y", 20)))
            val firstOverlay = pointer.read("overlay")!!
            val firstFrameCb = firstOverlay.read("frameCb") as Choreographer.FrameCallback
            val firstPreDraw = firstOverlay.read("preDraw") as ViewTreeObserver.OnPreDrawListener
            val firstDeadline = firstOverlay.read("deadline") as Runnable

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
            assertTrue(afterFirstLog[0].contains("msgs=3 applied=1 x=50 y=60 preDraws=1 waiting=0"))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(3000))
            assertEquals(1, pointerLogs(before).size)

            // Move inside the final second, then hide: final changed counters/position must be logged.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 70).put("y", 80)))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            pointer.hide()
            val afterHide = pointerLogs(before)
            assertEquals(2, afterHide.size)
            assertTrue(afterHide[1].contains("msgs=4 applied=2 x=70 y=80 preDraws=2 waiting=0"))

            // Show a replacement overlay; retired callbacks from the first overlay must not affect it.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("on", true).put("x", 5).put("y", 6)))
            val secondOverlay = pointer.read("overlay")!!
            assertTrue(secondOverlay !== firstOverlay)
            val secondLp = secondOverlay.read("lp") as WindowManager.LayoutParams
            firstFrameCb.doFrame(0L)
            firstPreDraw.onPreDraw()
            firstDeadline.run()
            assertEquals(6 to 7, secondLp.x to secondLp.y)
            assertEquals(0, pointer.read("applied"))
            assertEquals(0, pointer.read("preDraws"))

            // Withhold the normal frame callback and OnPreDraw. The bounded deadline applies the
            // latest position once; while frame callbacks remain withheld and traversal is pending,
            // a second 100ms tick does not spam updateViewLayout, and completing PreDraw resumes it.
            shadowOf(Looper.getMainLooper()).idle()
            val secondView = secondOverlay.read("view") as View
            val secondPreDraw = secondOverlay.read("preDraw") as ViewTreeObserver.OnPreDrawListener
            secondView.viewTreeObserver.removeOnPreDrawListener(secondPreDraw)
            pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 15).put("y", 16))
            val secondFrame = secondOverlay.read("frameCb") as Choreographer.FrameCallback
            Choreographer.getInstance().removeFrameCallback(secondFrame)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            assertEquals(1, pointer.read("fallbacks"))
            assertEquals(1, pointer.read("applied"))
            assertEquals(0, pointer.read("preDraws"))
            assertEquals(16 to 17, secondLp.x to secondLp.y)
            assertEquals(true, secondOverlay.read("layoutWaiting"))
            pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 25).put("y", 26))
            Choreographer.getInstance().removeFrameCallback(secondFrame)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            assertEquals(1, pointer.read("applied"))
            secondPreDraw.onPreDraw()
            assertEquals(1, pointer.read("preDraws"))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            assertEquals(2, pointer.read("applied"))
            assertEquals(26 to 27, secondLp.x to secondLp.y)
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }

    @Test fun overlayUsesItsOwnLooperAndClosesWithoutCoreMainWork() {
        val pointer = core().pointer
        ShadowSettings.setCanDrawOverlays(true)
        try {
            pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 10).put("y", 20))
            val handler = pointer.read("worker") as Handler
            assertTrue(handler.looper !== Looper.getMainLooper())
            shadowOf(handler.looper).idle()
            val first = pointer.read("view") as View
            assertNotNull(first.parent)
            pointer.hide()
            pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 30).put("y", 40))
            shadowOf(handler.looper).idle()
            val replacement = pointer.read("view") as View
            assertTrue(replacement !== first)
            assertNotNull(replacement.parent)
            pointer.hide()
            shadowOf(handler.looper).idle()
            assertNull(pointer.read("view"))
        } finally {
            pointer.hide()
            (pointer.read("worker") as? Handler)?.let { handler ->
                shadowOf(handler.looper).idle()
                handler.looper.quitSafely()
            }
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
        val pointer = pointer(ctx)
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

    @Test fun skippedPreDrawAllowsHealthyFramesAndStalledTraversalReattachesOnce() {
        val pointer = pointer()
        ShadowSettings.setCanDrawOverlays(true)
        try {
            ShadowSystemClock.advanceBy(Duration.ofMillis(1000))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 10).put("y", 20)))
            shadowOf(Looper.getMainLooper()).idle()
            val firstOverlay = pointer.read("overlay")!!
            val firstView = firstOverlay.read("view") as View
            val firstLp = firstOverlay.read("lp") as WindowManager.LayoutParams
            val firstPreDraw = firstOverlay.read("preDraw") as ViewTreeObserver.OnPreDrawListener
            // Simulate skipped OnPreDraw (e.g. TYPE_APPLICATION_OVERLAY hidden by Settings).
            firstView.viewTreeObserver.removeOnPreDrawListener(firstPreDraw)

            // Healthy Choreographer frame applies even when a prior OnPreDraw was skipped.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 30).put("y", 40)))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            assertEquals(1, pointer.read("applied"))
            assertEquals(0, pointer.read("preDraws"))
            assertEquals(true, firstOverlay.read("layoutWaiting"))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 50).put("y", 60)))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            assertEquals(2, pointer.read("applied"))
            assertEquals(51 to 61, firstLp.x to firstLp.y)
            assertEquals(0, pointer.read("recoveries"))

            // When both Choreographer and OnPreDraw stall while a new move is pending, one
            // bounded reattach retires the wedged overlay and places the replacement at the latest move.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 70).put("y", 80)))
            val firstFrame = firstOverlay.read("frameCb") as Choreographer.FrameCallback
            Choreographer.getInstance().removeFrameCallback(firstFrame)
            // layoutStartedAt was set on the first move (100ms ago), so 150ms more reaches RECOVERY_WAIT_MS (250ms).
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            assertSame(firstOverlay, pointer.read("overlay"))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))

            val recoveredOverlay = pointer.read("overlay")!!
            assertNotSame(firstOverlay, recoveredOverlay)
            assertEquals(true, firstOverlay.read("retired"))
            assertNull(firstView.parent)
            assertEquals(1, pointer.read("recoveries"))
            val recoveredLp = recoveredOverlay.read("lp") as WindowManager.LayoutParams
            assertEquals(71 to 81, recoveredLp.x to recoveredLp.y)
            // Replacement's own traversal completes, clearing layoutWaiting and resuming normal moves.
            assertEquals(1, pointer.read("preDraws"))
            assertEquals(false, recoveredOverlay.read("layoutWaiting"))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 90).put("y", 100)))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            assertEquals(3, pointer.read("applied"))
            assertEquals(2, pointer.read("preDraws"))
            assertEquals(91 to 101, recoveredLp.x to recoveredLp.y)
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }

    @Test fun stalledTraversalRecoveryStopsAfterOneAttemptAndCutoutGuardsApi29() {
        assertEquals(
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
            pointerCutoutMode(29),
        )
        assertEquals(
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS,
            pointerCutoutMode(30),
        )
        val base = RuntimeEnvironment.getApplication()
        var addViews = 0
        var updateLayouts = 0
        var removeImmediates = 0
        // Simulate a compositor outage where WindowManager accepts calls but never traverses/PreDraws.
        val stalledWm = Proxy.newProxyInstance(
            WindowManager::class.java.classLoader,
            arrayOf(WindowManager::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "addView" -> { addViews++; null }
                "updateViewLayout" -> { updateLayouts++; null }
                "removeViewImmediate" -> { removeImmediates++; null }
                else -> null
            }
        } as WindowManager
        val ctx = object : ContextWrapper(base) {
            override fun getSystemService(name: String): Any? =
                if (name == Context.WINDOW_SERVICE) stalledWm else super.getSystemService(name)
        }
        val pointer = pointer(ctx)
        ShadowSettings.setCanDrawOverlays(true)
        val before = ShadowLog.getLogsForTag("TwinDesk").size
        try {
            ShadowSystemClock.advanceBy(Duration.ofMillis(1000))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 10).put("y", 20)))
            assertEquals(1, addViews)
            val firstOverlay = pointer.read("overlay")!!
            val firstFrame = firstOverlay.read("frameCb") as Choreographer.FrameCallback

            // First stalled move triggers the single fallback updateViewLayout.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 20).put("y", 30)))
            Choreographer.getInstance().removeFrameCallback(firstFrame)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            assertEquals(1, pointer.read("fallbacks"))
            assertEquals(1, pointer.read("applied"))
            assertEquals(1, updateLayouts)
            assertEquals(0, pointer.read("preDraws"))

            // Next stalled move triggers the single bounded reattach at 250ms.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 40).put("y", 50)))
            Choreographer.getInstance().removeFrameCallback(firstFrame)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
            val recoveredOverlay = pointer.read("overlay")!!
            assertNotSame(firstOverlay, recoveredOverlay)
            assertEquals(1, pointer.read("recoveries"))
            assertEquals(2, addViews)
            assertEquals(1, removeImmediates)

            // Continued compositor outage: no second reattach and no further fallback updateViewLayout.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 60).put("y", 70)))
            val recoveredFrame = recoveredOverlay.read("frameCb") as Choreographer.FrameCallback
            Choreographer.getInstance().removeFrameCallback(recoveredFrame)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1000))
            assertSame(recoveredOverlay, pointer.read("overlay"))
            assertEquals(1, pointer.read("recoveries"))
            assertEquals(1, pointer.read("fallbacks"))
            assertEquals(1, pointer.read("applied"))
            assertEquals(0, pointer.read("preDraws"))
            assertEquals(2, addViews)
            assertEquals(1, updateLayouts)

            val logs = pointerLogs(before)
            assertTrue(logs.any {
                it.contains("applied=1") &&
                    it.contains("preDraws=0") &&
                    it.contains("waiting=1") &&
                    it.contains("fallback=1") &&
                    it.contains("recover=1")
            })
        } finally {
            pointer.hide()
            shadowOf(Looper.getMainLooper()).idle()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }

    @Test fun inputServiceLifecycleMigratesStationaryOverlayWithoutBlockingMain() {
        val coreInstance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        val previousCore = coreInstance.get(null)
        val runningField = InputService::class.java.getDeclaredField("running").apply { isAccessible = true }
        val previousService = runningField.get(null)
        val core = core()
        val pointer = core.pointer
        coreInstance.set(null, core)
        ShadowSettings.setCanDrawOverlays(true)
        try {
            val service1 = Robolectric.buildService(InputService::class.java).create().get()
            val service2 = Robolectric.buildService(InputService::class.java).create().get()

            // Stationary app overlay upgrades when InputService connects.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 15).put("y", 25)))
            val worker = pointer.read("worker") as Handler
            assertTrue(worker.looper !== Looper.getMainLooper())
            shadowOf(worker.looper).idle()
            val appOverlay = pointer.read("overlay")!!
            val appView = pointer.read("view") as View
            assertEquals(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, (appOverlay.read("lp") as WindowManager.LayoutParams).type)

            service1.connectService()
            shadowOf(worker.looper).idle()
            val a11yOverlay1 = pointer.read("overlay")!!
            assertNotSame(appOverlay, a11yOverlay1)
            assertNull(appView.parent)
            assertSame(service1, a11yOverlay1.read("service"))
            assertEquals(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, (a11yOverlay1.read("lp") as WindowManager.LayoutParams).type)
            assertEquals(16 to 26, (a11yOverlay1.read("lp") as WindowManager.LayoutParams).let { it.x to it.y })

            // Replacing service1 with service2 migrates cleanly; late service1.onDestroy ignores service2.
            service1.onUnbind(Intent())
            service2.connectService()
            shadowOf(worker.looper).idle()
            val a11yOverlay2 = pointer.read("overlay")!!
            assertSame(service2, a11yOverlay2.read("service"))
            service1.onDestroy()
            shadowOf(worker.looper).idle()
            assertSame(a11yOverlay2, pointer.read("overlay"))

            // Unbinding service2 while overlay consent exists falls back stationary arrow to app overlay.
            service2.onUnbind(Intent())
            shadowOf(worker.looper).idle()
            val fallbackOverlay = pointer.read("overlay")!!
            assertNotSame(a11yOverlay2, fallbackOverlay)
            assertNull(fallbackOverlay.read("service"))
            assertEquals(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, (fallbackOverlay.read("lp") as WindowManager.LayoutParams).type)
            assertEquals(16 to 26, (fallbackOverlay.read("lp") as WindowManager.LayoutParams).let { it.x to it.y })
        } finally {
            runningField.set(null, previousService)
            coreInstance.set(null, previousCore)
            pointer.hide()
            (pointer.read("worker") as? Handler)?.let { handler ->
                shadowOf(handler.looper).idle()
                handler.looper.quitSafely()
            }
            core.timers.shutdownNow()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }

    @Test fun inputServiceUnbindWithoutOverlayConsentRemovesStationaryOverlayAndDeniedPointerStaysLazy() {
        val coreInstance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        val previousCore = coreInstance.get(null)
        val runningField = InputService::class.java.getDeclaredField("running").apply { isAccessible = true }
        val previousService = runningField.get(null)
        val core = core()
        val pointer = core.pointer
        coreInstance.set(null, core)
        ShadowSettings.setCanDrawOverlays(false)
        try {
            // Denied pointer events do not spawn the overlay HandlerThread.
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 10).put("y", 20)))
            assertNull(pointer.read("worker"))

            // With InputService running and no app overlay permission, stationary arrow is removed on unbind.
            val service = Robolectric.buildService(InputService::class.java).create().get()
            service.connectService()
            assertNull(pointer.read("worker"))
            assertTrue(pointer.onMessage(Proto.T.PHONE_POINTER, JSONObject().put("x", 12).put("y", 34)))
            val worker = pointer.read("worker") as Handler
            shadowOf(worker.looper).idle()
            val a11yOverlay = pointer.read("overlay")!!
            val a11yView = pointer.read("view") as View
            assertSame(service, a11yOverlay.read("service"))
            assertNotNull(a11yView.parent)

            service.onUnbind(Intent())
            shadowOf(worker.looper).idle()
            assertNull(pointer.read("overlay"))
            assertNull(pointer.read("view"))
            assertNull(a11yView.parent)
            assertEquals(true, a11yOverlay.read("retired"))
        } finally {
            runningField.set(null, previousService)
            coreInstance.set(null, previousCore)
            pointer.hide()
            (pointer.read("worker") as? Handler)?.let { handler ->
                shadowOf(handler.looper).idle()
                handler.looper.quitSafely()
            }
            core.timers.shutdownNow()
            ShadowSettings.setCanDrawOverlays(false)
        }
    }
}
