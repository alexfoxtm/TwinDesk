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
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import org.json.JSONObject

class Pointer(core: Core) : Feature(core) {
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var lp: WindowManager.LayoutParams? = null
    private var host: Context? = null // whose window the view is in: the service, or the app
    private var wm: WindowManager? = null
    private val frames = PointerFrames { x, y ->
        val v = view ?: return@PointerFrames
        val p = lp ?: return@PointerFrames
        placePointer(p, x, y, initial = false, onFailure = { noteLayoutFail(it) }) {
            val manager = wm ?: return@placePointer
            // Time from this call until the traversal that actually moves the window.
            // Later calls before that traversal keep the earlier start, so a stuck
            // frame is not reset by the next move.
            val started = !layoutWaiting
            if (started) {
                layoutWaiting = true
                layoutStartedAt = SystemClock.uptimeMillis()
            }
            try {
                manager.updateViewLayout(v, p)
            } catch (t: Throwable) {
                if (started) layoutWaiting = false
                throw t
            }
            applied++
        }
    }
    private val moveRunnable = Runnable { frames.flush() }
    // One line a second while the arrow is up. Counts are for this add-to-remove
    // session, not reset each second. See preDraw for layoutMs.
    private var session = false
    private var msgs = 0
    private var applied = 0
    private var lastX = 0
    private var lastY = 0
    private var maxQueueMs = 0L
    private var maxLayoutMs = 0L
    private var layoutFails = 0
    private var loggedFails = 0
    private var lastLogAt = 0L
    private var lastFailLog = 0L
    private var layoutWaiting = false
    private var layoutStartedAt = 0L
    private val logRunnable = object : Runnable {
        override fun run() {
            if (!session) return
            writeLog()
            main.postDelayed(this, 1000L)
        }
    }
    // updateViewLayout only moves the window. The view's own frame stays put, so
    // onLayout does not run, and this arrow never invalidates, so onDraw may not
    // run either. The traversal scheduled for that window move does dispatch
    // OnPreDraw, on the same Choreographer pass the move waits for. A stalled
    // vsync shows up as layoutMs climbing after updateViewLayout has returned.
    private val preDraw = ViewTreeObserver.OnPreDrawListener {
        if (layoutWaiting) {
            val waited = (SystemClock.uptimeMillis() - layoutStartedAt).coerceAtLeast(0L)
            if (waited > maxLayoutMs) maxLayoutMs = waited
            layoutWaiting = false
        }
        true
    }
    val allowed get() = InputService.running != null || Settings.canDrawOverlays(core.ctx)

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.PHONE_POINTER) return false
        // No socket time on a direct call. Zero would look like a delay since boot.
        return onPointer(m, 0L)
    }

    internal fun onPointer(m: JSONObject, receivedAt: Long): Boolean {
        if (!m.optBoolean("on", true)) hide() else show(m.optInt("x"), m.optInt("y"), receivedAt)
        return true
    }

    override fun onClosed() = hide()

    private fun show(x: Int, y: Int, receivedAt: Long) {
        val service = InputService.running
        val want: Context = service ?: core.ctx
        if (service == null && !Settings.canDrawOverlays(core.ctx)) return remove()
        if (view != null && host !== want) remove() // the service came or went: move the arrow over
        if (view == null) {
            val density = core.ctx.resources.displayMetrics.density
            val size = (22 * density).toInt()
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
                    viewTreeObserver.addOnPreDrawListener(preDraw)
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
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                title = "TwinDesk pointer"
            }
            val m = want.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            if (!placePointer(p, x, y, initial = true) { m.addView(arrowView, p) }) return
            lp = p; host = want; wm = m
            view = arrowView
            beginSession(x, y, receivedAt)
            return
        }
        if (lp == null) return
        noteMessage(x, y, receivedAt)
        // Posted on the main looper, not on the next frame. This overlay is the app's only
        // window and it never invalidates, so an adaptive-refresh panel can stop this
        // process's vsync and a frame callback never runs. The arrow would stay where
        // addView put it. One runnable is enough: the last position wins.
        frames.move(x, y) { main.post(moveRunnable) }
    }

    // Core delivers onMessage and onClosed on the main thread already. Remove here.
    // A posted remove ran after a show queued behind the same hide, so on:false then
    // on:true deleted the arrow the second message had just kept.
    fun hide() = remove()

    private fun remove() {
        frames.hide { main.removeCallbacks(moveRunnable) }
        endSession()
        view?.let { v -> runCatching { wm?.removeView(v) } }
        view = null; lp = null; host = null; wm = null
    }

    private fun beginSession(x: Int, y: Int, receivedAt: Long) {
        session = true
        msgs = 1
        applied = 0
        lastX = x
        lastY = y
        maxQueueMs = queueDelay(receivedAt)
        maxLayoutMs = 0L
        layoutFails = 0
        loggedFails = 0
        lastLogAt = 0L
        lastFailLog = 0L
        layoutWaiting = false
        main.removeCallbacks(logRunnable)
        main.postDelayed(logRunnable, 1000L)
    }

    private fun noteMessage(x: Int, y: Int, receivedAt: Long) {
        if (!session) return
        msgs++
        lastX = x
        lastY = y
        val delay = queueDelay(receivedAt)
        if (delay > maxQueueMs) maxQueueMs = delay
    }

    private fun queueDelay(receivedAt: Long): Long {
        if (receivedAt <= 0L) return 0L
        return (SystemClock.uptimeMillis() - receivedAt).coerceAtLeast(0L)
    }

    private fun layoutDelay(): Long {
        var delay = maxLayoutMs
        if (layoutWaiting) {
            val waited = (SystemClock.uptimeMillis() - layoutStartedAt).coerceAtLeast(0L)
            if (waited > delay) delay = waited
        }
        return delay
    }

    private fun writeLog() {
        lastLogAt = SystemClock.uptimeMillis()
        loggedFails = layoutFails
        Log.i(
            "TwinDesk",
            "pointer msgs=$msgs applied=$applied x=$lastX y=$lastY queueMs=$maxQueueMs layoutMs=${layoutDelay()} fail=$layoutFails",
        )
    }

    private fun endSession() {
        if (!session) return
        main.removeCallbacks(logRunnable)
        val now = SystemClock.uptimeMillis()
        // At most one stats line a second, plus a closing line when this second
        // had a layout failure the last line did not include.
        if (lastLogAt == 0L || now - lastLogAt >= 1000L || layoutFails != loggedFails) writeLog()
        session = false
        layoutWaiting = false
    }

    private fun noteLayoutFail(t: Throwable) {
        layoutFails++
        val now = SystemClock.uptimeMillis()
        if (now - lastFailLog < 1000L) return
        lastFailLog = now
        val msg = (t.message ?: t.javaClass.simpleName).replace('\n', ' ').take(160)
        Log.w("TwinDesk", "pointer layout fail: $msg fail=$layoutFails")
    }
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
 * One layout per turn of the main looper. Moves that arrive before the posted runnable
 * runs replace the one waiting, and the runnable applies whichever position was last.
 * Hide drops a waiting move and cancels the runnable, so a hidden arrow is not moved.
 */
internal class PointerFrames(private val apply: (Int, Int) -> Unit) {
    private var pending = false
    private var posted = false
    private var x = 0
    private var y = 0

    fun move(x: Int, y: Int, post: () -> Unit) {
        this.x = x
        this.y = y
        pending = true
        if (posted) return
        posted = true
        post()
    }

    fun flush() {
        posted = false
        if (!pending) return
        pending = false
        apply(x, y)
    }

    fun hide(cancel: () -> Unit = {}) {
        pending = false
        if (!posted) return
        posted = false
        cancel()
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
