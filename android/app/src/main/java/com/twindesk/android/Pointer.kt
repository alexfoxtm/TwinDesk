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
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import org.json.JSONObject

class Pointer(core: Core) : Feature(core) {
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var lp: WindowManager.LayoutParams? = null
    private var host: Context? = null // whose window the view is in: the service, or the app
    private var wm: WindowManager? = null
    val allowed get() = InputService.running != null || Settings.canDrawOverlays(core.ctx)

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.PHONE_POINTER) return false
        if (!m.optBoolean("on", true)) hide() else show(m.optInt("x"), m.optInt("y"))
        return true
    }

    override fun onClosed() = hide()

    private fun show(x: Int, y: Int) {
        val service = InputService.running
        val want: Context = service ?: core.ctx
        if (service == null && !Settings.canDrawOverlays(core.ctx)) return remove()
        if (view != null && host !== want) remove() // the service came or went: move the arrow over
        val v = view ?: run {
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
            return
        }
        val p = lp ?: return
        placePointer(p, x, y, initial = false) { wm?.updateViewLayout(v, p) }
    }

    fun hide() {
        main.post { remove() }
    }

    private fun remove() {
        view?.let { v -> runCatching { wm?.removeView(v) } }
        view = null; lp = null; host = null; wm = null
    }
}

internal fun placePointer(
    params: WindowManager.LayoutParams,
    x: Int,
    y: Int,
    initial: Boolean,
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
    }.isSuccess
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
