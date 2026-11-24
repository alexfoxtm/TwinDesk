// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's pointer on the phone's screen. While the Mac's mouse is over here, the Mac injects the
// mouse through wireless debugging at positions it keeps itself (so it knows when the pointer
// reaches the edge to go back), and tells us where it is (`phone.pointer {on, x, y}`, physical
// pixels of the screen as it is turned now). We draw the arrow in a small overlay window that
// doesn't take touches; it sits one pixel off the tip so it never covers the point clicked.
//   With the Accessibility service on, the window is the service's (TYPE_ACCESSIBILITY_OVERLAY):
// an app's overlay is drawn under the notification shade, and Settings hides it on its screens
// (Android 12+, against tapjacking), so the arrow vanished there (#53). Without it, the app's.
package com.twindesk.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Choreographer
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import org.json.JSONObject

class Pointer(core: Core) : Feature(core) {
    private inner class Overlay(
        val view: View,
        val lp: WindowManager.LayoutParams,
        val host: Context,
        val service: InputService?,
        val wm: WindowManager,
        val preDraw: ViewTreeObserver.OnPreDrawListener,
    ) {
        var retired = false
        var layoutWaiting = false
        var layoutStartedAt = 0L
        val frames = PointerFrames { x, y -> applyMove(this, x, y) }
        var frameWaitingAt = 0L
        val deadline: Runnable = Runnable {
            if (retired || overlay !== this || !frames.hasPending) return@Runnable
            if (!layoutWaiting) {
                choreographer.removeFrameCallback(frameCb)
                noteFrameWait(this)
                fallbacks++
                frames.onFrame()
                return@Runnable
            }
            val now = SystemClock.uptimeMillis()
            val waited = (now - layoutStartedAt).coerceAtLeast(0L)
            if (waited >= RECOVERY_WAIT_MS && canRecover(now)) {
                recoverOverlay(this, now)
            }
        }
        val frameCb: Choreographer.FrameCallback = Choreographer.FrameCallback {
            if (retired || overlay !== this) return@FrameCallback
            dispatcher().removeCallbacks(deadline)
            frameCallbacks++
            noteFrameWait(this)
            // Healthy Choreographer frames are never permanently gated by a skipped OnPreDraw.
            frames.onFrame()
        }
        val choreographer = Choreographer.getInstance()
    }

    private data class LogSnapshot(
        val msgs: Int,
        val applied: Int,
        val preDraws: Int,
        val waiting: Boolean,
        val x: Int,
        val y: Int,
        val queueMs: Long,
        val layoutMs: Long,
        val fails: Int,
        val callbacks: Int,
        val fallbacks: Int,
        val recoveries: Int,
        val frameWaitMs: Long,
    )

    @Volatile private var worker: Handler? = null

    // This tiny window owns its Looper. A vendor traversal waiting for vsync must not hold
    // Core's main-thread messages behind the window's synchronization barrier.
    @Synchronized private fun dispatcher(): Handler = worker ?: run {
        val thread = HandlerThread("TwinDesk pointer").apply { start() }
        Handler.createAsync(thread.looper).also { worker = it }
    }

    private fun dispatch(block: () -> Unit) {
        val handler = dispatcher()
        if (Looper.myLooper() === handler.looper) block() else handler.post(block)
    }
    private var overlay: Overlay? = null
    private var view: View? = null
    // At most one line a second while counters or traversal waits change; idle settled overlays
    // do not reschedule the timer. Counts span this add-to-remove crossing.
    private var session = false
    private var msgs = 0
    private var applied = 0
    private var preDraws = 0
    private var lastX = 0
    private var lastY = 0
    private var maxQueueMs = 0L
    private var maxLayoutMs = 0L
    private var layoutFails = 0
    private var frameCallbacks = 0
    private var fallbacks = 0
    private var recoveries = 0
    private var lastRecoveryAt = 0L
    private var maxFrameWaitMs = 0L
    private var addFails = 0
    private var lastLogAt = 0L
    private var lastFailLog = 0L
    private var lastAddFailLog = 0L
    private var lastLogged: LogSnapshot? = null
    private var logScheduled = false
    private val logRunnable = object : Runnable {
        override fun run() {
            logScheduled = false
            if (!session) return
            val active = overlay
            val snap = snapshot(active)
            if (snap != lastLogged) writeLog(snap)
            if (active?.layoutWaiting == true) {
                logScheduled = true
                dispatcher().postDelayed(this, 1000L)
            }
        }
    }
    val allowed get() = InputService.running != null || Settings.canDrawOverlays(core.ctx)

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.PHONE_POINTER) return false
        // No socket time on a direct call. Zero would look like a delay since boot.
        return onPointer(m, 0L)
    }

    internal fun onPointer(m: JSONObject, receivedAt: Long): Boolean {
        val on = m.optBoolean("on", true)
        val x = m.optInt("x")
        val y = m.optInt("y")
        if (!on) hide()
        else if (worker != null || allowed) dispatch { show(x, y, receivedAt) }
        return true
    }

    override fun onClosed() = hide()

    // Called on main from InputService lifecycle transitions. Never blocks main and never spawns
    // the overlay thread when no pointer has been shown.
    fun onInputServiceChanged(leaving: InputService? = null) {
        if (worker == null) return
        dispatch { handleInputServiceChanged(leaving) }
    }

    private fun handleInputServiceChanged(leaving: InputService?) {
        val active = overlay ?: return
        val service = InputService.running
        val want: Context = service ?: core.ctx
        val leavingOwner = leaving != null && active.service === leaving
        if (!leavingOwner && active.host === want) return
        val x = lastX
        val y = lastY
        remove()
        if (service != null || Settings.canDrawOverlays(core.ctx)) {
            attachOverlay(x, y, receivedAt = 0L, preserveSession = false)
        }
    }

    private fun show(x: Int, y: Int, receivedAt: Long) {
        val service = InputService.running
        val want: Context = service ?: core.ctx
        if (service == null && !Settings.canDrawOverlays(core.ctx)) return remove()
        if (overlay != null && overlay?.host !== want) remove() // the service came or went: move the arrow over
        if (overlay == null) {
            attachOverlay(x, y, receivedAt, preserveSession = false)
            return
        }
        val active = overlay ?: return
        noteMessage(x, y, receivedAt)
        active.frames.move(x, y) { scheduleFrame(active) }
    }

    private fun createOverlay(want: Context, service: InputService?): Overlay {
        val density = core.ctx.resources.displayMetrics.density
        val size = (22 * density).toInt()
        var owner: Overlay? = null
        // updateViewLayout moves the window; OnPreDraw runs on the traversal scheduled for
        // that move, so layoutMs measures the wait between updateViewLayout and traversal.
        val preDraw = ViewTreeObserver.OnPreDrawListener {
            owner?.let { onOverlayPreDraw(it) }
            true
        }
        val arrowView = object : View(want) {
            val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; style = Paint.Style.FILL }
            val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 1.6f * density; strokeJoin = Paint.Join.ROUND }
            val arrow = Path().apply {
                val s = density
                moveTo(1.5f * s, 1.5f * s); lineTo(1.5f * s, 17f * s); lineTo(5.5f * s, 13.2f * s); lineTo(8.4f * s, 19.6f * s)
                lineTo(11f * s, 18.4f * s); lineTo(8.2f * s, 12.2f * s); lineTo(13.6f * s, 12.2f * s); close()
            }
            override fun onDraw(c: Canvas) { c.drawPath(arrow, fill); c.drawPath(arrow, edge) }
            override fun onAttachedToWindow() {
                super.onAttachedToWindow()
                val o = owner ?: return
                if (!o.retired) viewTreeObserver.addOnPreDrawListener(preDraw)
            }
            override fun onDetachedFromWindow() {
                val obs = viewTreeObserver
                if (obs.isAlive) obs.removeOnPreDrawListener(preDraw)
                super.onDetachedFromWindow()
            }
        }
        val p = WindowManager.LayoutParams(
            size, size,
            if (service != null) WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY else WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            layoutInDisplayCutoutMode = pointerCutoutMode()
            title = "TwinDesk pointer"
        }
        val m = want.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return Overlay(arrowView, p, want, service, m, preDraw).also { owner = it }
    }

    private fun attachOverlay(
        x: Int,
        y: Int,
        receivedAt: Long,
        preserveSession: Boolean,
        allowFallbackRetry: Boolean = true,
    ): Boolean {
        val service = InputService.running
        val want: Context = service ?: core.ctx
        if (service == null && !Settings.canDrawOverlays(core.ctx)) {
            if (preserveSession) endSession(null)
            return false
        }
        val next = createOverlay(want, service)
        if (service != null && InputService.running !== service) {
            next.retired = true
            return if (allowFallbackRetry && (InputService.running != null || Settings.canDrawOverlays(core.ctx))) {
                attachOverlay(x, y, receivedAt, preserveSession, allowFallbackRetry = false)
            } else {
                if (preserveSession) endSession(null)
                false
            }
        }
        val added = placePointer(
            next.lp, x, y, initial = true,
            onFailure = { noteAddFail(it, service != null) },
        ) { next.wm.addView(next.view, next.lp) }
        if (!added) {
            next.retired = true
            detachPreDraw(next)
            if (allowFallbackRetry && service != null && InputService.running !== service &&
                (InputService.running != null || Settings.canDrawOverlays(core.ctx))
            ) {
                return attachOverlay(x, y, receivedAt, preserveSession, allowFallbackRetry = false)
            }
            if (preserveSession) endSession(null)
            return false
        }
        if (service != null && InputService.running !== service) {
            next.retired = true
            detachPreDraw(next)
            runCatching { next.wm.removeViewImmediate(next.view) }
            return if (allowFallbackRetry && (InputService.running != null || Settings.canDrawOverlays(core.ctx))) {
                attachOverlay(x, y, receivedAt, preserveSession, allowFallbackRetry = false)
            } else {
                if (preserveSession) endSession(null)
                false
            }
        }
        addFails = 0
        lastAddFailLog = 0L
        overlay = next
        view = next.view
        if (preserveSession) {
            lastX = x
            lastY = y
            next.layoutWaiting = true
            next.layoutStartedAt = SystemClock.uptimeMillis()
            scheduleLog()
        } else {
            beginSession(x, y, receivedAt)
        }
        return true
    }

    private fun canRecover(now: Long): Boolean =
        recoveries < MAX_RECOVERIES_PER_CROSSING &&
            (lastRecoveryAt == 0L || (now - lastRecoveryAt).coerceAtLeast(0L) >= RECOVERY_COOLDOWN_MS)

    private fun deadlineDelay(o: Overlay, now: Long): Long? {
        if (!o.layoutWaiting) return FALLBACK_MS
        if (!canRecover(now)) return null
        val waited = (now - o.layoutStartedAt).coerceAtLeast(0L)
        return maxOf(FALLBACK_MS, RECOVERY_WAIT_MS - waited)
    }

    private fun scheduleFrame(o: Overlay) {
        if (o.retired || overlay !== o) return
        val now = SystemClock.uptimeMillis()
        if (o.frameWaitingAt == 0L) o.frameWaitingAt = now
        o.choreographer.removeFrameCallback(o.frameCb)
        dispatcher().removeCallbacks(o.deadline)
        o.choreographer.postFrameCallback(o.frameCb)
        deadlineDelay(o, now)?.let { dispatcher().postDelayed(o.deadline, it) }
    }

    private fun noteFrameWait(o: Overlay) {
        if (o.frameWaitingAt == 0L) return
        val waited = (SystemClock.uptimeMillis() - o.frameWaitingAt).coerceAtLeast(0L)
        if (waited > maxFrameWaitMs) maxFrameWaitMs = waited
        o.frameWaitingAt = 0L
    }

    private fun applyMove(o: Overlay, x: Int, y: Int) {
        if (o.retired || overlay !== o) return
        if (o.service != null && InputService.running !== o.service) {
            handleInputServiceChanged(o.service)
            return
        }
        placePointer(o.lp, x, y, initial = false, onFailure = { noteLayoutFail(it) }) {
            // Time from this call until the traversal that actually moves the window.
            // Later calls before that traversal keep the earlier start, so a pending
            // traversal wait is not reset by the next move.
            val started = !o.layoutWaiting
            if (started) {
                o.layoutWaiting = true
                o.layoutStartedAt = SystemClock.uptimeMillis()
            }
            try {
                o.wm.updateViewLayout(o.view, o.lp)
            } catch (t: Throwable) {
                if (started) o.layoutWaiting = false
                throw t
            }
            applied++
            scheduleLog()
        }
    }

    private fun onOverlayPreDraw(o: Overlay) {
        if (o.retired || overlay !== o || !o.layoutWaiting) return
        preDraws++
        val waited = (SystemClock.uptimeMillis() - o.layoutStartedAt).coerceAtLeast(0L)
        if (waited > maxLayoutMs) maxLayoutMs = waited
        o.layoutWaiting = false
        scheduleLog()
        if (o.frames.hasPending) scheduleFrame(o)
    }

    private fun recoverOverlay(o: Overlay, now: Long) {
        if (o.retired || overlay !== o || !o.frames.hasPending) return
        val px = o.frames.pendingX
        val py = o.frames.pendingY
        val stalledMs = (now - o.layoutStartedAt).coerceAtLeast(0L)
        if (stalledMs > maxLayoutMs) maxLayoutMs = stalledMs
        recoveries++
        lastRecoveryAt = now
        noteFrameWait(o)
        retireOverlay(o)
        attachOverlay(px, py, receivedAt = 0L, preserveSession = true)
    }

    // Hide and the next show are serialized on the overlay Looper. There is no deferred
    // remove nested behind a later show, which could delete the replacement arrow.
    fun hide() {
        if (worker == null) return
        dispatch {
            addFails = 0
            lastAddFailLog = 0L
            remove()
        }
    }

    private fun detachPreDraw(o: Overlay) {
        runCatching {
            val obs = o.view.viewTreeObserver
            if (obs.isAlive) obs.removeOnPreDrawListener(o.preDraw)
        }
    }

    private fun retireOverlay(old: Overlay) {
        if (overlay === old) {
            overlay = null
            view = null
        }
        old.retired = true
        old.frames.retire { cancelPointerFrame(old.choreographer, old.frameCb) }
        dispatcher().removeCallbacks(old.deadline)
        old.layoutWaiting = false
        detachPreDraw(old)
        runCatching { old.wm.removeViewImmediate(old.view) }
    }

    private fun remove() {
        val old = overlay
        overlay = null
        view = null
        if (old != null) {
            old.retired = true
            old.frames.retire { cancelPointerFrame(old.choreographer, old.frameCb) }
            dispatcher().removeCallbacks(old.deadline)
            endSession(old)
            old.layoutWaiting = false
            detachPreDraw(old)
            runCatching { old.wm.removeViewImmediate(old.view) }
        } else {
            endSession(null)
        }
    }

    private fun beginSession(x: Int, y: Int, receivedAt: Long) {
        session = true
        msgs = 1
        applied = 0
        preDraws = 0
        lastX = x
        lastY = y
        maxQueueMs = queueDelay(receivedAt)
        maxLayoutMs = 0L
        layoutFails = 0
        frameCallbacks = 0
        fallbacks = 0
        recoveries = 0
        maxFrameWaitMs = 0L
        lastLogAt = 0L
        lastFailLog = 0L
        lastLogged = null
        dispatcher().removeCallbacks(logRunnable)
        logScheduled = false
        scheduleLog()
    }

    private fun noteMessage(x: Int, y: Int, receivedAt: Long) {
        if (!session) return
        msgs++
        lastX = x
        lastY = y
        val delay = queueDelay(receivedAt)
        if (delay > maxQueueMs) maxQueueMs = delay
        scheduleLog()
    }

    private fun scheduleLog() {
        if (!session || logScheduled) return
        val now = SystemClock.uptimeMillis()
        val delay = if (lastLogAt == 0L || now - lastLogAt >= 1000L) 1000L else 1000L - (now - lastLogAt)
        logScheduled = true
        dispatcher().postDelayed(logRunnable, delay)
    }

    private fun queueDelay(receivedAt: Long): Long {
        if (receivedAt <= 0L) return 0L
        return (SystemClock.uptimeMillis() - receivedAt).coerceAtLeast(0L)
    }

    private fun layoutDelay(active: Overlay?): Long {
        var delay = maxLayoutMs
        if (active != null && active.layoutWaiting) {
            val waited = (SystemClock.uptimeMillis() - active.layoutStartedAt).coerceAtLeast(0L)
            if (waited > delay) delay = waited
        }
        return delay
    }

    private fun snapshot(active: Overlay?) = LogSnapshot(
        msgs = msgs,
        applied = applied,
        preDraws = preDraws,
        waiting = active?.layoutWaiting == true,
        x = lastX,
        y = lastY,
        queueMs = maxQueueMs,
        layoutMs = layoutDelay(active),
        fails = layoutFails,
        callbacks = frameCallbacks,
        fallbacks = fallbacks,
        recoveries = recoveries,
        frameWaitMs = maxOf(
            maxFrameWaitMs,
            active?.frameWaitingAt?.takeIf { it > 0L }
                ?.let { (SystemClock.uptimeMillis() - it).coerceAtLeast(0L) } ?: 0L,
        ),
    )

    private fun writeLog(snap: LogSnapshot) {
        lastLogAt = SystemClock.uptimeMillis()
        lastLogged = snap
        Log.i(
            "TwinDesk",
            "pointer msgs=${snap.msgs} applied=${snap.applied} x=${snap.x} y=${snap.y} preDraws=${snap.preDraws} waiting=${if (snap.waiting) 1 else 0} queueMs=${snap.queueMs} layoutMs=${snap.layoutMs} fail=${snap.fails} frames=${snap.callbacks} fallback=${snap.fallbacks} recover=${snap.recoveries} frameWaitMs=${snap.frameWaitMs}",
        )
    }

    private fun endSession(active: Overlay?) {
        if (!session) return
        dispatcher().removeCallbacks(logRunnable)
        logScheduled = false
        val snap = snapshot(active)
        if (snap != lastLogged) writeLog(snap)
        session = false
    }

    private fun noteLayoutFail(t: Throwable) {
        layoutFails++
        scheduleLog()
        val now = SystemClock.uptimeMillis()
        if (lastFailLog != 0L && now - lastFailLog < 1000L) return
        lastFailLog = now
        Log.w("TwinDesk", "pointer layout fail: ${t.javaClass.simpleName} fail=$layoutFails")
    }

    private fun noteAddFail(t: Throwable, a11y: Boolean) {
        addFails++
        val now = SystemClock.uptimeMillis()
        if (lastAddFailLog != 0L && now - lastAddFailLog < 1000L) return
        lastAddFailLog = now
        val hostKind = if (a11y) "a11y" else "app"
        Log.w("TwinDesk", "pointer add fail: ${t.javaClass.simpleName} host=$hostKind fail=$addFails")
    }

    companion object {
        private const val FALLBACK_MS = 100L
        private const val RECOVERY_WAIT_MS = 250L
        private const val RECOVERY_COOLDOWN_MS = 5000L
        private const val MAX_RECOVERIES_PER_CROSSING = 1
    }
}

internal fun pointerCutoutMode(sdkInt: Int = Build.VERSION.SDK_INT): Int =
    if (sdkInt >= Build.VERSION_CODES.R) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES

internal fun cancelPointerFrame(choreographer: Choreographer, callback: Choreographer.FrameCallback) {
    choreographer.removeFrameCallback(callback)
}

internal fun placePointer(
    params: WindowManager.LayoutParams,
    x: Int,
    y: Int,
    initial: Boolean,
    onFailure: ((Throwable) -> Unit)? = null,
    apply: () -> Unit,
): Boolean {
    val nextX = x + 1
    val nextY = y + 1
    val oldX = params.x
    val oldY = params.y
    if (!initial && oldX == nextX && oldY == nextY) return true
    params.x = nextX
    params.y = nextY
    return runCatching(apply).onFailure {
        params.x = oldX
        params.y = oldY
        onFailure?.invoke(it)
    }.isSuccess
}

/**
 * One layout per display frame. Moves that arrive before the frame replace the one waiting,
 * and the frame applies whichever position was last. Hide drops a waiting move and cancels
 * the frame callback; retire permanently disables future moves or callbacks for a retired overlay.
 */
internal class PointerFrames(private val apply: (Int, Int) -> Unit) {
    private var pending = false
    private var posted = false
    private var retired = false
    private var x = 0
    private var y = 0

    val hasPending get() = pending && !retired
    val pendingX get() = x
    val pendingY get() = y

    fun move(x: Int, y: Int, postFrame: () -> Unit) {
        if (retired) return
        this.x = x
        this.y = y
        pending = true
        if (posted) return
        posted = true
        postFrame()
    }

    fun onFrame() {
        posted = false
        if (retired || !pending) return
        pending = false
        apply(x, y)
    }

    fun hide(cancelFrame: () -> Unit = {}) {
        pending = false
        if (!posted) return
        posted = false
        cancelFrame()
    }

    fun retire(cancelFrame: () -> Unit = {}) {
        retired = true
        hide(cancelFrame)
    }
}

// The computer's shared folder in the phone's Files app (smb.offer). Comes with the drive work.
class Drive(core: Core) : Feature(core) {
    @Volatile var offer: JSONObject? = null; private set

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.SMB_OFFER -> offer = m
            Proto.T.SMB_REVOKE -> offer = null
            else -> return false
        }
        core.changed()
        return true
    }

    override fun onClosed() {
        offer = null
    }
}
