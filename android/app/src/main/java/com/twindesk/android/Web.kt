// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen and sound on the phone. The Mac already streams to the computers over WebRTC
// (mac/stream.js, mac/audio.js); Android's WebView speaks the same WebRTC, so the phone answers
// those offers in two small pages (assets/web): viewer.html for the screen (ViewerActivity) and
// audio.html for the sound (a WebView kept without a window). WebHost carries messages between
// the link and a page.
package com.twindesk.android

import android.annotation.SuppressLint
import android.content.Context
import android.media.MediaCodecList
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.os.SystemClock
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import org.json.JSONObject

class WebHost internal constructor(ctx: Context, private val page: String, private val core: Core,
    private val widgetPad: MacWidget.Touchpad? = null, private val onPageEvent: (String, JSONObject?) -> Unit = { _, _ -> }) {
    private val main = Handler(Looper.getMainLooper())
    private var ready = false
    private data class Delivery(val message: JSONObject, val embeddedRoute: Link.TrustedRoute?)
    private data class EmbeddedOffer(val id: Int, val route: Link.TrustedRoute)
    private val queue = mutableListOf<Delivery>()
    private var offerId = 0
    @Volatile private var embeddedOffer: EmbeddedOffer? = null
    private val videoDecoders by lazy {
        runCatching { MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder } }
            .getOrDefault(emptyList())
    }

    @SuppressLint("SetJavaScriptEnabled")
    val view: WebView = object : WebView(ctx) {
        override fun onCreateInputConnection(info: android.view.inputmethod.EditorInfo): android.view.inputmethod.InputConnection? {
            val connection = super.onCreateInputConnection(info)
            if (page == "viewer.html") info.imeOptions = info.imeOptions or android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            return connection
        }
    }.apply {
        settings.javaScriptEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.domStorageEnabled = false
        if (page == "viewer.html") {
            @Suppress("DEPRECATION")
            settings.saveFormData = false
            importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        setBackgroundColor(android.graphics.Color.BLACK)
        isFocusable = true
        isFocusableInTouchMode = true
        webChromeClient = object : WebChromeClient() {
            // A <video> with nothing playing yet shows WebView's grey play button: black instead.
            override fun getDefaultVideoPoster(): android.graphics.Bitmap =
                android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.BLACK) }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("TwinDesk", "web: ${m.message()}")
                return true
            }
        }
        addJavascriptInterface(Bridge(), "TD")
        loadUrl("file:///android_asset/web/$page")
    }

    @Volatile private var widgetPadActive = false

    internal fun allowWidgetInput(active: Boolean) { widgetPadActive = active }

    internal fun sendRemote(message: JSONObject): Boolean {
        val pad = widgetPad ?: return core.send(message)
        return widgetPadActive && pad.current(core) && core.link.sendWidgetInput(pad.route, pad.routeRevision, message)
    }

    private inner class Bridge {
        // The pages' text in the app's language (I18n.kt); vars: a JSON object for its {name} parts.
        @JavascriptInterface fun tr(text: String, vars: String): String {
            val o = runCatching { JSONObject(vars) }.getOrNull() ?: JSONObject()
            return com.twindesk.android.tr(text, *o.keys().asSequence().map { it to o.opt(it) }.toList().toTypedArray())
        }

        @JavascriptInterface fun send(json: String) {
            runCatching {
                val m = JSONObject(json)
                if (widgetPad != null) {
                    if (m.optString("t").startsWith("remote.")) sendRemote(m)
                    return
                }
                val id = m.remove("_embeddedOffer")
                if (id != null) {
                    val offer = embeddedOffer
                    if (offer != null && id == offer.id) core.link.sendFor(offer.route, m)
                } else if (!core.link.embedded || m.optString("t") !in rtcReplies) {
                    core.send(m)
                }
            }
        }
        // A pointer move or a wheel step (remote.js, viewer.js), many a second: written straight to the
        // socket (Link.sendMove), with no JSON string from the page and no JSONObject to parse and
        // write out again for each one. kind: 0 remote.mm {dx: a, dy: b, smooth}, 1 remote.wh {dx, dy},
        // 2 in.mm {x: a, y: b}.
        @JavascriptInterface fun move(kind: Int, a: Double, b: Double, smooth: Boolean) {
            val pad = widgetPad
            if (pad == null) core.link.sendMove(kind, a, b, smooth)
            else if (kind in 0..1 && widgetPadActive && pad.current(core))
                core.link.sendMove(kind, a, b, smooth, pad.route, pad.routeRevision)
        }
        @JavascriptInterface fun ready() = main.post {
            ready = true
            for (m in queue) deliver(m)
            queue.clear()
            onEvent("ready", null)
        }.let { }
        @JavascriptInterface fun videoState(generation: Int, session: Int, playing: Boolean, w: Int, h: Int) = main.post {
            onEvent("videoState", msg("videoState", "generation" to generation, "session" to session, "playing" to playing, "w" to w, "h" to h))
        }.let { }
        @JavascriptInterface fun canDecodeVideo(codec: String, width: Int, height: Int, fps: Double): Boolean {
            val mime = when (codec.lowercase()) {
                "video/h264" -> "video/avc"
                "video/h265", "video/hevc" -> "video/hevc"
                "video/vp8" -> "video/x-vnd.on2.vp8"
                "video/vp9" -> "video/x-vnd.on2.vp9"
                "video/av1" -> "video/av01"
                else -> return false
            }
            if (width !in 1..4096 || height !in 1..2160 || !fps.isFinite() || fps !in 1.0..120.0) return false
            return videoDecoders.any { decoder ->
                runCatching { decoder.getCapabilitiesForType(mime).videoCapabilities
                    ?.areSizeAndRateSupported(width, height, fps) == true }.getOrDefault(false)
            }
        }
        @JavascriptInterface fun detail(generation: Int, session: Int, height: Int) = main.post {
            onEvent("videoDetail", msg("videoDetail", "generation" to generation, "session" to session, "height" to height))
        }.let { }
        @JavascriptInterface fun videoMetrics(generation: Int, session: Int, w: Int, h: Int, fps: Int, kbps: Int, dropped: Long) = main.post {
            onEvent("videoMetrics", msg("videoMetrics", "generation" to generation, "session" to session,
                "w" to w, "h" to h, "fps" to fps, "kbps" to kbps, "dropped" to dropped))
        }.let { }

        @JavascriptInterface fun netemSample(generation: Int, session: Int, first: Boolean, fps: Int, kbps: Int, path: String) {
            if (!BuildConfig.DEBUG || page != "viewer.html") return
            main.post { core.screen.netemSample(this@WebHost, generation, session, first, fps, kbps, path) }
        }
        @JavascriptInterface fun netemStage(generation: Int, session: Int, kind: Int, relay: Boolean) {
            if (!BuildConfig.DEBUG || page != "viewer.html") return
            main.post { core.screen.netemStage(this@WebHost, generation, session, kind, relay) }
        }
        @JavascriptInterface fun playing(w: Int, h: Int) = main.post { onEvent("playing", JSONObject().put("w", w).put("h", h)) }.let { }
        @JavascriptInterface fun haptic() = main.post { view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS) }.let { }
        // A light tap (a gamepad or touchpad button going down).
        @JavascriptInterface fun tick() = main.post { view.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY) }.let { }
        // Something for the activity around the page (remote.html: "close", "keyboard", "keyboardOff").
        @JavascriptInterface fun event(name: String) = main.post { onEvent(name, null) }.let { }
        // The gamepad's Keys: a control's key (Remote.CONTROLS id, a KeyboardEvent.code, Mouse0..2 or "").
        @JavascriptInterface fun setPad(id: String, code: String) = main.post {
            if (Remote.CONTROLS.any { it.first == id } && Remote.KEYS.any { it.first == code }) core.remote.setPad(id, code)
        }.let { }
        // The gamepad's layout (Edit): where each control is, its size, hidden ones, extra buttons.
        @JavascriptInterface fun setLayout(json: String) = main.post { core.remote.setLayout(json) }.let { }
        // The gamepad's state, as a Bluetooth gamepad (BtPad: remote.html while a computer is connected to it).
        @JavascriptInterface fun pad(b: Int, lx: Double, ly: Double, rx: Double, ry: Double, lt: Double, rt: Double) {
            if (widgetPad == null && core.btPadMade) core.btPad.pad(b, lx, ly, rx, ry, lt, rt)
        }
        // The phone's turning (remote.html's air mouse and presentation pointer): window.tdMotion while on.
        @JavascriptInterface fun motion(on: Boolean) = main.post {
            if (on && motion == null) motion = Motion(view.context) { s -> if (ready) view.evaluateJavascript("window.tdMotion&&tdMotion($s)", null) }.also { it.start() }
            else if (!on) { motion?.stop(); motion = null }
        }.let { }
    }

    private var motion: Motion? = null

    private fun onEvent(event: String, data: JSONObject?) {
        if (page == "viewer.html" && core.lockView.locked && (event == "videoMetrics" || event == "videoDetail" ||
                (event == "videoState" && data?.optBoolean("playing") == true))) return
        onPageEvent(event, data)
    }

    // A message to the page (any thread).
    fun post(m: JSONObject, embeddedRoute: Link.TrustedRoute? = null): Boolean {
        val delivery = Delivery(m, embeddedRoute)
        return main.post { if (ready) deliver(delivery) else queue.add(delivery) }
    }

    private fun deliver(delivery: Delivery) {
        val (m, route) = delivery
        if (route != null && !core.link.embeddedMediaReady(route)) return
        when (m.optString("t")) {
            "rtc.offer", "audio.offer" -> {
                if (!core.cableMediaOk(m)) return
                embeddedOffer = route?.let { EmbeddedOffer(++offerId, it) }
                m.remove("_embeddedOffer")
                embeddedOffer?.let { m.put("_embeddedOffer", it.id) }
            }
            "stream.stop", "audio.stop" -> embeddedOffer = null
        }
        if (page == "viewer.html" && core.lockView.locked) when (m.optString("t")) {
            "opts" -> m.put("inputOn", false)
            "viewer.input" -> m.put("on", false)
        }
        view.evaluateJavascript("window.tdRecv && window.tdRecv(${m});", null)
    }

    // The soft keyboard for typing on the Mac (viewer.html types what it gets into its hidden field).
    fun keyboard(on: Boolean) = main.post {
        val imm = view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        if (on) {
            view.requestFocus()
            imm.showSoftInput(view, 0)
        } else imm.hideSoftInputFromWindow(view.windowToken, 0)
    }

    fun destroy() = main.post {
        motion?.stop()
        motion = null
        ready = false
        embeddedOffer = null
        queue.clear()
        view.removeJavascriptInterface("TD")
        view.loadUrl("about:blank")
        view.destroy()
    }
    private companion object {
        val rtcReplies = setOf("rtc.answer", "rtc.ice", "audio.answer", "audio.ice")
    }
}

// One real display the computer offered in screen.state (the virtual display is Extend, and is not listed).
data class MacDisplay(val id: String, val name: String, val w: Int, val h: Int) {
    fun label(): String = buildString {
        append(name.ifBlank { id }.take(40))
        if (w > 0 && h > 0) append(" · ").append(w).append('×').append(h)
    }
}

data class StreamDoctorSample(val width: Int, val height: Int, val fps: Int?, val kbps: Int?, val droppedFrames: Long?) {
    fun summary(): String = listOfNotNull(
        "$width × $height",
        fps?.let { tr("{value} fps", "value" to it) },
        kbps?.let { tr("{value} Mb/s", "value" to String.format(java.util.Locale.ROOT, "%.1f", it / 1000.0)) },
        droppedFrames?.let { tr("{count} dropped frames", "count" to it) },
    ).joinToString(" · ")
}

// The Mac's screen: what it shares (screen.state), Start/Stop and Mirror/Extend (screen.ctl), and
// the viewer page while ViewerActivity is open (screen.policy tells the Mac to stream).
class Screen(core: Core) : Feature(core) {
    @Volatile var state: JSONObject? = null; private set // the Mac's screen.state

    @Volatile var videoUnavailable = false; private set

    @Volatile var inputOn = true; private set // the Mac's "Receive input" (stream.input)
    @Volatile var spaceNote = ""; private set // a desktop refusal, a switch in progress, or why remote control stays paused
    @Volatile var desktopPreviews = DesktopPreview.EMPTY
    @Volatile var previewEpoch = 0L
        private set
    @Volatile private var previewSession = 0L
    private val ask = DesktopPreview.SheetAsk()
    private var previewSealed = false
    private var pending: DesktopSelect.Pending? = null
    private var timeoutDisplay = ""
    private var stickyNote = false
    @Volatile private var sessionEpoch = 0L
    private var refreshEpoch = 0
    private var refreshFollowups = 0
    private var decodedCapture: Long? = null
    private val pendingTimer = Handler(Looper.getMainLooper())
    private val viewerRetry = ViewerRetry(SystemClock::elapsedRealtime)
    private var viewerSize: Pair<Int, Int>? = null
    private var sharingRoute: Any? = null
    private val pendingTick = Runnable { onPendingClock() }
    @Volatile var viewing = false; private set
    @Volatile var size: Pair<Int, Int>? = null; private set
    @Volatile var decodedSize: Pair<Int, Int>? = null; private set
    var viewScale = "fit"; private set
    private val scalePresets = setOf("fit", "fill", "actual")
    private val savedScale get() = core.store.prefsString("screen.viewScale", "fit").takeIf { it in scalePresets } ?: "fit"
    private var host: WebHost? = null
    private var lastInfo: JSONObject? = null
    private var videoGeneration = 0
    private var videoSession: Int? = null
    private var videoMarker: Any? = null
    private var netemOfferAt: Long? = null
    private var netemPresented = false
    @Volatile var videoPlaying = false; private set
    private data class DoctorReading(val marker: Any, val sample: StreamDoctorSample)
    @Volatile private var doctorReading: DoctorReading? = null
    val lastDoctorSample: StreamDoctorSample?
        get() {
            if (core.lockView.locked) return null
            return ownedDoctorSample()
        }

    private fun ownedDoctorSample() = doctorReading?.takeIf { core.link.ownsVideoSession(it.marker) }?.sample

    val doctorSummary: String? get() = lastDoctorSample?.summary()

    fun doctorLinkChanged() {
        val reading = doctorReading ?: return
        if (!core.link.ownsVideoSession(reading.marker)) clearDoctor()
    }

    private fun clearDoctor() { doctorReading = null }

    private var wantStart = false // the viewer opened before we knew whether the Mac shares
    private var wantStartRoute: Link.TrustedRoute? = null
    private data class EmbeddedViewer(
        val viewer: WebHost,
        val route: Link.TrustedRoute,
        val welcomedAt: Long? = null,
    )
    private var embeddedViewer: EmbeddedViewer? = null
    private var startedByUs = false // we started the Mac's sharing: stop it when the viewer closes
    @Volatile var autoOpened = false; private set // the computer started sharing and opened the viewer: it closes when that stops

    val sharing get() = state?.optBoolean("on") == true
    val mode get() = state?.optString("mode") ?: ""
    val remote get() = state?.optBoolean("remote", true) != false
    // This Mac accepts previous/next desktop (screen.space). Older computers, Windows and Linux omit it.
    val spaces get() = state?.optBoolean("spaces") == true
    // The real display being mirrored, empty while extending or when the computer didn't say.
    val displayId get() = state?.optString("displayId").orEmpty()
    // Mac desktop catalog (screen.state desktops). Null on older computers, Windows, and Linux.
    val desktopCatalog: DesktopSelect.Catalog? get() = readCatalog(state)
    val pendingDisplayId: String get() = pending?.displayId.orEmpty()

    // Real displays the computer can mirror. Missing on an older computer: no picker, Mirror/Extend only.
    val displays: List<MacDisplay>
        get() {
            val a = state?.optJSONArray("displays") ?: return emptyList()
            val out = ArrayList<MacDisplay>(minOf(a.length(), 8))
            for (i in 0 until minOf(a.length(), 8)) {
                val o = a.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id.isEmpty() || id.length > 16 || out.any { it.id == id }) continue
                out.add(MacDisplay(id, o.optString("name").take(60), o.optInt("w"), o.optInt("h")))
            }
            return out
        }

    // ViewerActivity opened: stream to us, at our screen's size (the Mac sizes Extend to it).
    fun attach(h: WebHost, w: Int, hpx: Int) {
        viewerRetry.cancel()
        host = h
        viewerSize = w to hpx
        resetVideo()
        viewing = true
        core.link.netemMark(core.link.sessionMarker(), "viewer_open")
        viewScale = savedScale
        h.post(opts()) // first: the computer's name for the messages below
        lastInfo?.let { h.post(it) }
        state?.let { h.post(it) }
        Notify.cancelScreen(core.ctx)
        // Through Bluetooth the picture needs Wi-Fi first (Netlink): asked for once it's there (onWifi).
        if (core.link.ble) {
            waitWifi = w to hpx
            core.net.need("screen")
            core.changed()
            return
        }
        policy(w, hpx)
    }

    // The same viewer resized: update Extend's shape without restarting sharing or its controls.
    fun resize(h: WebHost, w: Int, hpx: Int) {
        if (host !== h || !viewing || w <= 0 || hpx <= 0) return
        viewerSize = w to hpx
        if (core.link.ble) waitWifi = w to hpx
        else core.send(msg("screen.policy", "accept" to true, "width" to w, "height" to hpx))
    }

    private fun policy(w: Int, hpx: Int) {
        val route = core.link.currentTrustedRoute()
        val peer = core.link.host
        val viewer = host
        if (route != null && core.link.isEmbeddedRoute(route)) {
            if (viewer == null || core.lockView.locked) return
            if (!core.link.embeddedMediaReady(route)) {
                waitForEmbeddedMedia(viewer, route)
                return
            }
            if (!acceptEmbeddedViewer(viewer, route, w, hpx)) return
            startWhenKnown(route)
            core.changed()
            return
        }
        if (route != null && core.link.sendFor(route, acceptance(w, hpx))) {
            if (viewer != null && peer != null && core.link.accepts(route)) viewerRetry.opened(viewer, peer, route)
        }
        // Show the Mac's screen = the Mac starts sharing, in the mode used last.
        if (state == null) wantStart = true else startIfNeeded()
        core.changed()
    }

    private fun acceptEmbeddedViewer(viewer: WebHost, route: Link.TrustedRoute, w: Int, h: Int): Boolean {
        val peer = core.link.host ?: return false
        if (!core.link.sendFor(route, acceptance(w, h))) return false
        if (core.link.accepts(route)) viewerRetry.opened(viewer, peer, route)
        return true
    }

    private fun waitForEmbeddedMedia(viewer: WebHost, route: Link.TrustedRoute, welcomedAt: Long? = null) {
        val pending = EmbeddedViewer(viewer, route, welcomedAt)
        embeddedViewer = pending
        pendingTimer.postDelayed({
            if (embeddedViewer === pending && host === viewer && viewing &&
                core.link.isEmbeddedRoute(route) && !core.link.embeddedMediaReady(route)) {
                viewer.post(msg("viewer.unavailable", "reason" to tr("Screen sharing is unavailable on TwinDesk Network.")), route)
            }
        }, 8000)
    }

    internal fun onEmbeddedMediaReady(route: Link.TrustedRoute) {
        val pending = embeddedViewer ?: return
        if (pending.route.marker !== route.marker || pending.viewer !== host) return
        embeddedViewer = null
        val (w, h) = viewerSize ?: return
        if (!viewing || core.lockView.locked || !core.link.embeddedMediaReady(route) ||
            !acceptEmbeddedViewer(pending.viewer, route, w, h)) return
        if (pending.welcomedAt != null) watchOffer(pending.viewer, route, pending.welcomedAt)
        else startWhenKnown(route)
        core.changed()
    }

    private fun startWhenKnown(route: Link.TrustedRoute) {
        wantStartRoute = route
        if (state == null) wantStart = true else startIfNeeded()
    }

    private fun acceptance(w: Int, h: Int) = msg("screen.policy", "accept" to true, "width" to w, "height" to h)

    internal fun noteSharingRoute(m: JSONObject, route: Link.TrustedRoute?) {
        if (route == null || !core.link.accepts(route)) return
        val wasSharing = sharingRoute === route.marker
        sharingRoute = if (m.optBoolean("on")) route.marker else null
        if (sharingRoute == null) {
            if (wasSharing) viewerRetry.cancel() else viewerRetry.stopRetries(route.marker)
        }
    }

    private fun watchOffer(h: WebHost, route: Link.TrustedRoute, welcomedAt: Long) {
        if (host !== h || !viewing || core.link.ble || core.host?.os != "mac" || !core.link.accepts(route)) return
        viewerRetry.schedule({ after, task -> pendingTimer.postDelayed({ task() }, after) }, {
            host === h && viewing && videoMarker !== route.marker && sharing && sharingRoute === route.marker &&
                !core.lockView.locked && !core.link.ble && core.link.accepts(route)
        }, welcomedAt) {
            val (w, height) = viewerSize ?: return@schedule
            // A repeated true can be only a resize to the Mac. Renew this viewer's policy
            // without sending screen.ctl or turning host sharing back on.
            if (core.link.sendFor(route, msg("screen.policy", "accept" to false))) {
                core.link.sendFor(route, acceptance(w, height))
            }
        }
    }

    @Volatile private var waitWifi: Pair<Int, Int>? = null

    // The session moved onto Wi-Fi (Core): the viewer that was waiting for it starts now.
    fun onWifi() {
        val (w, hpx) = waitWifi ?: return
        val viewer = host
        val route = core.link.currentTrustedRoute()
        waitWifi = null
        pendingTimer.post {
            if (viewer != null && host === viewer && viewing && !core.link.ble && core.link.accepts(route)) policy(w, hpx)
        }
    }

    private fun startIfNeeded() {
        val route = wantStartRoute
        wantStart = false
        wantStartRoute = null
        if (!viewing || sharing || !remote ||
            (route != null && (core.lockView.locked || !core.link.embeddedMediaReady(route)))) return
        startedByUs = true
        // Opening again sends Mirror, and Mirror on the computer means the main screen.
        // A screen already picked stays that screen. Extend (no displayId) still starts on Mirror.
        val id = displayId
        if (id.isNotEmpty() && displays.any { it.id == id }) controlOn(route, share = true, displayId = id)
        else controlOn(route, share = true, mode = pickMode())
    }

    // Always Mirror to start with (the computer's screen as it is); Extend is a tap away in the viewer.
    private fun pickMode(): String {
        val modes = state?.optJSONArray("modes")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: listOf("extend", "mirror")
        return if ("mirror" in modes) "mirror" else modes.firstOrNull() ?: "mirror"
    }

    // The computer started sharing by itself (its Share Screen): open the viewer, or, where
    // Android doesn't let us start it from the background, a notification to tap.
    private fun autoOpen() {
        if (viewing) return
        autoOpened = true
        val ctx = core.ctx
        if (android.provider.Settings.canDrawOverlays(ctx)) {
            val ok = runCatching { ctx.startActivity(android.content.Intent(ctx, ViewerActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
            if (ok) return
        }
        Notify.screen(ctx, core.host?.name ?: tr("Your computer"))
    }

    fun detach(h: WebHost) {
        if (host !== h) return
        viewerRetry.cancel()
        viewerSize = null
        previewSheet(false)
        host = null
        resetVideo(keepDoctor = true)
        viewing = false
        size = null
        wantStart = false
        wantStartRoute = null
        embeddedViewer = null
        waitWifi = null
        core.net.release("screen")
        if (core.link.connected) {
            core.send(msg("screen.policy", "accept" to false))
            if (startedByUs && sharing) control(share = false)
        }
        startedByUs = false
        autoOpened = false
        cancelDesktopWait()
        stickyNote = false
        spaceNote = ""
        core.changed()
    }

    private fun pointerInput(): Boolean {
        val input = state?.opt("input") as? Boolean
        return when (core.host?.os) {
            "mac" -> inputOn && input != false // older Macs already report stream.input
            "win", "linux" -> input == true
            else -> false
        }
    }

    // name: the computer we're connected to, for the viewer's messages (stream.info's is the
    // display it shares, e.g. the Mac's "TwinDesk (virtual)"; a PC or Linux sends none).
    // touch: "pad" (slide moves the pointer, tap clicks) or "direct" (the
    // pointer goes where the finger is, tap = click); speed and tap are the Remote page's touchpad settings;
    // pen: a stylus is a pen on the computer (its pressure, tilt, eraser), else a mouse; penFast: a
    // stroke's samples batched per event (Fast writing), else each its own, paced (every point lands).
    fun opts(): JSONObject = msg("opts", "sound" to core.store.flag("screen.sound", false), "pacing" to (core.store.flag("screen.smooth", false).let { if (it) "smooth" else "fast" }),
        "viewGestures" to (core.host?.os == "mac"), "inputOn" to pointerInput(), "viewScale" to savedScale, "name" to (core.host?.name ?: "the computer"), "touch" to (if (core.store.flag("screen.touchpad", true)) "pad" else "direct"),
        "speed" to core.remote.speed.toDouble(), "tap" to core.remote.tapClick, "pen" to core.store.flag("screen.pen", true),
        "penFast" to core.store.flag("screen.penFast", false))

    // The touchpad settings changed on the Remote page: an open viewer follows.
    fun repost() { host?.post(opts()) }

    fun lockChanged(locked: Boolean) {
        clearDoctor()
        host?.post(msg("viewer.input", "on" to pointerInput()))
        if (locked) endPreviewSession()
        else {
            previewEpoch++
            core.changed()
        }
        videoGeneration++
        videoPlaying = false
        decodedSize = null
        val session = videoSession
        if (viewing && session != null && videoMarker != null && core.link.connected && core.link.sessionMarker() === videoMarker) host?.post(msg("viewer.probe", "session" to session, "viewerGeneration" to videoGeneration, "accept" to !locked))
    }

    fun setOpt(key: String, on: Boolean) {
        core.store.setFlag(key, on)
        host?.post(opts())
        core.changed()
    }

    // These controls affect only the currently open viewer, never a replacement host or its display.
    fun setViewScale(h: WebHost, mode: String) {
        if (host !== h || !viewing || core.host?.os != "mac" || mode !in scalePresets) return
        if (core.lockView.locked) return
        core.store.setPrefsString("screen.viewScale", mode)
        viewScale = mode
        h.post(msg("viewer.scale", "mode" to mode))
        core.changed()
    }

    fun viewScaleChanged(h: WebHost, mode: String) {
        if (host !== h || !viewing || core.host?.os != "mac" || (mode != "custom" && mode != savedScale) || mode == viewScale) return
        viewScale = mode
        core.changed()
    }

    private fun resetVideo(keepDoctor: Boolean = false) {
        if (!keepDoctor) clearDoctor()
        videoGeneration++
        videoSession = null
        videoMarker = null
        netemOfferAt = null
        netemPresented = false
        videoPlaying = false
        decodedSize = null
        videoUnavailable = false
        decodedCapture = null
    }

    // The Displays & desktops sheet is open on this phone. The Mac captures only while
    // this stays true. Each open has its own epoch, sent on screen.preview.want and
    // required on every screen.preview. Closing the sheet or leaving the foreground
    // asks it to stop and keeps the last-seen pictures. A reply from an older open is
    // ignored after the sheet opens again. Stop, revoke, and a new link forget that
    // epoch and clear the pictures. A locked or unknown Mac console is refused on the
    // Mac before a shot, and the clear that follows drops what this open stored.
    fun previewSheet(open: Boolean) {
        val requested = open && !core.lockView.locked
        val allowed = previewAllowed(requested)
        if (allowed == ask.wanted) return
        if (allowed) {
            previewSealed = false
            val epoch = ask.open()
            if (core.link.connected) core.send(msg("screen.preview.want", "on" to true, "epoch" to epoch))
        } else {
            val epoch = ask.epoch
            ask.close()
            if (epoch > 0L && core.link.connected) core.send(msg("screen.preview.want", "on" to false, "epoch" to epoch))
        }
        core.changed()
    }

    private fun previewAllowed(open: Boolean): Boolean =
        open && viewing && sharing && inputOn && remote && core.link.connected

    private fun endPreviewSession() {
        val cancel = ask.wanted
        val epoch = ask.epoch
        val dirty = !previewSealed || desktopPreviews.shots.isNotEmpty() || desktopPreviews.unavailable.isNotEmpty() || desktopPreviews.session != previewSession
        ask.end()
        if (!previewSealed) {
            previewSealed = true
            previewSession++
        }
        if (dirty) desktopPreviews = DesktopPreview.empty(previewSession)
        if (cancel && epoch > 0L && core.link.connected) core.send(msg("screen.preview.want", "on" to false, "epoch" to epoch))
        if (cancel || dirty) {
            previewEpoch++
            core.changed()
        }
    }

    override fun onWelcome(host: Host) {
        val welcomedAt = SystemClock.elapsedRealtime()
        resetVideo()
        this.host?.post(msg("stream.stop"))
        sessionEpoch++
        endPreviewSession()
        this.host?.post(opts())
        // Disconnect already cleared this session, so the clear above changes nothing and
        // does not ask again. The sheet can still be open on this new link. A later
        // composition subscribes once more. A closed sheet sends nothing.
        previewEpoch++
        core.changed()
        val session = previewSession
        val viewer = this.host
        val route = core.link.currentTrustedRoute()
        pendingTimer.post {
            decodedCapture = null
            refreshFollowups = 0
            cancelDesktopWait()
            if (previewSession == session) desktopPreviews = DesktopPreview.empty(session)
            // ViewerActivity can survive a dropped socket without another attach/resize.
            // Reassert its acceptance on the new authenticated socket only.
            val (w, h) = viewerSize ?: return@post
            if (viewer == null || this.host !== viewer || !viewing || route == null ||
                core.link.ble || core.lockView.locked || !core.link.accepts(route) ||
                !viewerRetry.reconnect(viewer, host, route, welcomedAt)) return@post
            if (core.link.isEmbeddedRoute(route) && !core.link.embeddedMediaReady(route)) {
                waitForEmbeddedMedia(viewer, route, welcomedAt)
            } else if (core.link.sendFor(route, acceptance(w, h))) {
                watchOffer(viewer, route, welcomedAt)
            }
        }
    }

    fun videoState(h: WebHost, generation: Int, session: Int, playing: Boolean, w: Int, height: Int) {
        if (host !== h || !viewing || videoGeneration != generation || videoSession != session ||
            !core.link.ownsVideoSession(videoMarker)) return
        if (playing && decodedCapture != session.toLong() && w > 0 && height > 0 && !core.lockView.locked) {
            core.link.appsViewerReady(videoMarker)
        }
        if (playing) decodedCapture = session.toLong() else if (decodedCapture == session.toLong()) decodedCapture = null
        val nextSize = if (playing && w > 0 && height > 0) w to height else null
        if (videoPlaying != playing || decodedSize != nextSize) {
            videoPlaying = playing
            decodedSize = nextSize
            core.changed()
        }
        if (!playing || pending == null) return
        if (dropWait(sharing)) { core.changed(); return }
        val step = DesktopSelect.onState(pending, desktopCatalog, displayId, System.currentTimeMillis(), frameFor())
        takeDesktop(step, state?.optString("spaceHold").orEmpty())
        core.changed()
    }

    internal fun onOffer(m: JSONObject, route: Link.TrustedRoute?, fromEmbedded: Boolean = false) {
        // Link's socket can change while Core hands this message to the UI thread.
        if (route == null || !core.link.accepts(route) || !core.cableMediaOk(m)) return
        viewerRetry.stopRetries(route.marker)
        resetVideo()
        videoSession = m.optInt("session", -1)
        videoMarker = route.marker
        val offer = JSONObject(m.toString()).put("viewerGeneration", videoGeneration)
        offer.remove("_netemTurn")
        core.link.netemRoute(route.marker)?.let {
            netemOfferAt = SystemClock.elapsedRealtime()
            offer.put("_netemTurn", it.turnUrl)
            core.link.netemMark(route.marker, "native_offer", " viewing=${if (viewing && host != null) 1 else 0}")
        }
        host?.post(offer, route.takeIf { fromEmbedded })
        core.changed()
    }

    internal fun onEmbeddedIce(m: JSONObject, route: Link.TrustedRoute?) {
        if (route != null) host?.post(m, route)
    }

    fun netemStage(h: WebHost, generation: Int, session: Int, kind: Int, relay: Boolean) {
        if (host !== h || !viewing || core.lockView.locked || netemOfferAt == null ||
            videoGeneration != generation || videoSession != session) return
        val stage = when (kind) {
            0 -> "viewer_offer"
            1 -> "rtc_relay_candidate"
            2 -> "rtc_connected"
            3 -> "rtc_failed"
            4 -> "rtc_setup_error"
            5 -> "rtc_video_track"
            else -> return
        }
        core.link.netemMark(videoMarker, stage, if (kind == 0) " test_turn=${if (relay) 1 else 0}" else "")
    }

    fun netemSample(h: WebHost, generation: Int, session: Int, first: Boolean, fps: Int, kbps: Int, path: String) {
        val offerAt = netemOfferAt ?: return
        if (host !== h || !viewing || !sharing || !videoPlaying || core.lockView.locked ||
            videoGeneration != generation || videoSession != session) return
        val elapsed = core.link.netemElapsed(videoMarker) ?: return
        if (first) {
            if (netemPresented) return
            netemPresented = true
            Log.i("TwinDeskNetem", "first_presented_ms=$elapsed offer_to_presented_ms=${SystemClock.elapsedRealtime() - offerAt}")
        } else if (fps in -1..240 && kbps in -1..1_000_000 &&
            path in listOf("unverified", "bypass", "proxy-turn-tcp")) {
            Log.i("TwinDeskNetem", "receiver_fps=$fps receiver_kbps=$kbps media_path=$path")
        }
    }

    fun videoMetrics(h: WebHost, generation: Int, session: Int, width: Int, height: Int, fps: Int, kbps: Int, dropped: Long) {
        val marker = videoMarker ?: return
        if (host !== h || !viewing || !sharing || !videoPlaying ||
            videoGeneration != generation || videoSession != session || !core.link.ownsVideoSession(marker) ||
            width !in 1..16384 || height !in 1..16384) return
        val sample = StreamDoctorSample(width, height, fps.takeIf { it in 0..240 },
            kbps.takeIf { it in 0..1_000_000 }, dropped.takeIf { it in 0..1_000_000_000 })
        val previous = doctorReading
        if (previous?.sample != sample || previous.marker !== marker) {
            doctorReading = DoctorReading(marker, sample)
            core.changed()
        }
    }

    fun videoDetail(h: WebHost, generation: Int, session: Int, height: Int) {
        if (host !== h || !viewing || !sharing || !videoPlaying ||
            core.host?.os !in listOf("mac", "win", "linux") ||
            videoGeneration != generation || videoSession != session ||
            height !in 0..2160 || !core.link.ownsVideoSession(videoMarker)) return
        core.link.sendFor(videoMarker, msg("rtc.detail", "session" to session, "height" to height))
    }

    fun playing(w: Int, h: Int) {
        size = w to h
        core.changed()
    }

    // Start/stop the Mac's sharing, or switch Mirror/Extend (when the Mac allows it).
    // displayId mirrors that real display and does not switch Extend/Mirror by itself.
    fun control(share: Boolean? = null, mode: String? = null, close: Boolean = false, displayId: String? = null) =
        controlOn(null, share, mode, close, displayId)

    private fun controlOn(route: Link.TrustedRoute?, share: Boolean? = null, mode: String? = null, close: Boolean = false, displayId: String? = null) {
        val m = msg("screen.ctl")
        if (share != null) m.put("share", share)
        if (mode != null) m.put("mode", mode)
        if (close) m.put("close", true)
        if (displayId != null) m.put("displayId", displayId)
        if (share == false) {
            wantStart = false
            wantStartRoute = null
            embeddedViewer = null
            sharingRoute = null
            viewerRetry.cancel()
            startedByUs = false
            resetVideo(keepDoctor = true)
            cancelDesktopWait()
        }
        if (route == null) core.send(m) else core.link.sendFor(route, m)
    }

    // Mirror one of the computer's real displays. Ownership matches Mirror: the viewer sets
    // startedByUs when it opens and sharing is off; choosing a display does not take the session over.
    // The host's display row uses this and does not keep a switching wait. The overview card uses selectDisplay.
    fun pickDisplay(id: String) {
        cancelDesktopWait()
        stickyNote = false
        spaceNote = ""
        if (id.isEmpty() || displays.none { it.id == id }) return
        control(share = true, displayId = id)
        core.changed()
    }

    fun keyboard(on: Boolean) {
        host?.post(msg("keyboard", "on" to on))
        host?.keyboard(on)
    }

    // The viewer's Close: the computer stops sharing too (whoever started it; close: even when it
    // doesn't let us start and switch it).
    fun end() {
        if (core.link.connected && sharing) control(share = false, close = true)
    }

    // Mirror / Extend tapped in the viewer.
    fun pick(mode: String) {
        cancelDesktopWait()
        stickyNote = false
        spaceNote = ""
        control(share = true, mode = mode)
        core.changed()
    }

    // Previous or next macOS desktop on the display this viewer is being shown.
    // displayId only when screen.state named one (one-to-one). Multi-device omits the list, so the
    // Mac uses that device's own picture. A Mac that does not know screen.space ignores it.
    fun space(dir: String) {
        if (dir != "prev" && dir != "next") return
        cancelDesktopWait()
        stickyNote = false
        spaceNote = ""
        val m = msg("screen.space", "dir" to dir)
        val id = displayId
        if (id.isNotEmpty()) m.put("displayId", id)
        core.send(m)
        core.changed()
    }

    // One display from the overview. The card stays on Switching until a later picture is
    // that display. A refusal, Stop, or a closed viewer drops the wait. This does not ask
    // for a desktop, so a late picture cannot move the workspace.
    fun selectDisplay(id: String) {
        timeoutDisplay = ""
        stickyNote = false
        val step = DesktopSelect.switchDisplay(
            desktopCatalog,
            id,
            displays.any { it.id == id },
            System.currentTimeMillis(),
            sessionEpoch,
            frameFor(),
            pending,
        )
        if (step.pending === pending && step.action is DesktopSelect.Action.None) return
        takeDesktop(step, "")
        core.changed()
    }

    // One desktop from the catalog. A different display is mirrored first. The desktop message
    // is sent only after a later state says this viewer is capturing that display.
    fun selectDesktop(displayId: String, spaceId: String) {
        timeoutDisplay = ""
        stickyNote = false
        val step = DesktopSelect.tap(
            desktopCatalog,
            displayId,
            spaceId,
            displays.any { it.id == displayId },
            System.currentTimeMillis(),
            sessionEpoch,
            frameFor(),
            pending,
        )
        // A catalog that already says this display is showing, before its frame is decoded,
        // must not send and must not replace the wait (its revision is what the frame is compared to).
        if (step.pending === pending && step.action is DesktopSelect.Action.None) return
        takeDesktop(step, "")
        core.changed()
    }

    private fun cancelDesktopWait() {
        pending = null
        timeoutDisplay = ""
        pendingTimer.removeCallbacks(pendingTick)
    }

    private fun armPending() {
        pendingTimer.removeCallbacks(pendingTick)
        if (pending != null) pendingTimer.postDelayed(pendingTick, DesktopSelect.WAIT_MS)
    }

    private fun frameFor(cat: DesktopSelect.Catalog? = desktopCatalog): DesktopSelect.Frame? {
        val decoded = decodedCapture ?: return null
        val ready = cat ?: return null
        val cap = ready.capture ?: return null
        val gen = ready.viewGen ?: return null
        if (decoded != cap) return null
        return DesktopSelect.Frame(cap, gen)
    }

    // True when the wait was dropped. Stop, revoked input, a closed viewer, a new
    // session, and a picture that landed on a different display all drop it here.
    private fun dropWait(sharingOn: Boolean): Boolean {
        val wait = pending ?: return false
        val why = DesktopSelect.cancelReason(wait, sharingOn, inputOn, viewing, sessionEpoch, desktopCatalog, displayId) ?: return false
        cancelDesktopWait()
        if (why == "stale") {
            stickyNote = true
            spaceNote = transitionNote("list", "")
        } else if (!stickyNote) spaceNote = ""
        return true
    }

    fun refreshDesktops(followUp: Boolean = false) {
        if (!viewing || !core.link.connected || core.host?.os != "mac") return
        if (!followUp) refreshFollowups = 0
        refreshEpoch = (refreshEpoch + 1) and 0x7fffffff
        if (refreshEpoch == 0) refreshEpoch = 1
        core.send(msg("screen.desktops", "epoch" to refreshEpoch))
    }

    private fun onPendingClock() {
        if (dropWait(sharing)) { core.changed(); return }
        val step = DesktopSelect.onState(pending, desktopCatalog, displayId, System.currentTimeMillis(), frameFor())
        takeDesktop(step, "")
        core.changed()
    }

    private fun takeDesktop(result: DesktopSelect.Result, hold: String) {
        val previous = pending
        val held = hold == "accessibility" || hold == "overview"
        if (result.action is DesktopSelect.Action.Note && result.action.code == "timeout") {
            timeoutDisplay = previous?.displayId.orEmpty()
        }
        // A ready desktop message must not go out while input is paused. The wait stays,
        // including a timeout that already gave up, so a later picture can say what happened.
        if (held && result.action is DesktopSelect.Action.Space) {
            pending = previous
            armPending()
            stickyNote = false
            spaceNote = spaceWhy(hold, "")
            return
        }
        if (held) {
            pending = result.pending
            armPending()
            stickyNote = false
            spaceNote = spaceWhy(hold, "")
            return
        }
        pending = result.pending
        armPending()
        when (val action = result.action) {
            is DesktopSelect.Action.Space -> {
                timeoutDisplay = ""
                stickyNote = false
                spaceNote = transitionNote("switching", action.name)
                core.send(msg(
                    "screen.space",
                    "displayId" to action.displayId,
                    "spaceId" to action.spaceId,
                    "index" to action.index,
                    "count" to action.count,
                    "rev" to action.rev,
                ))
            }
            is DesktopSelect.Action.DisplayThenWait -> {
                timeoutDisplay = ""
                stickyNote = false
                spaceNote = transitionNote("switching", action.name)
                if (displays.any { it.id == action.displayId }) control(share = true, displayId = action.displayId)
                else {
                    pending = null
                    pendingTimer.removeCallbacks(pendingTick)
                    stickyNote = true
                    spaceNote = transitionNote("display", action.name)
                }
            }
            is DesktopSelect.Action.Note -> {
                stickyNote = true
                spaceNote = transitionNote(action.code, action.name)
            }
            DesktopSelect.Action.None -> {
                val waiting = pending
                if (waiting != null) {
                    stickyNote = false
                    spaceNote = transitionNote("switching", waiting.name)
                } else if (timeoutDisplay.isNotEmpty()) {
                    val late = DesktopSelect.afterTimeout(timeoutDisplay, desktopCatalog, displayId, frameFor())
                    if (late is DesktopSelect.Action.Note) {
                        timeoutDisplay = ""
                        stickyNote = true
                        spaceNote = transitionNote(late.code, late.name)
                    }
                }
            }
        }
    }

    private fun transitionNote(code: String, name: String): String {
        val shown = name.ifBlank { tr("This screen") }
        return when (code) {
            "already" -> tr("Already on this desktop")
            "switching" -> tr("Switching to {name}", "name" to shown)
            "showing" -> tr("Showing {name}", "name" to shown)
            "gone" -> tr("Showing {name}. That desktop isn’t on this screen anymore.", "name" to shown)
            "wait" -> tr("The picture hasn’t caught up with this screen yet")
            "timeout" -> tr("The screen didn’t change")
            "late" -> tr("Showing {name}. The desktop was not changed.", "name" to shown)
            "display" -> tr("That screen is no longer the one being shown")
            "list" -> tr("The list of desktops changed. Look again.")
            else -> tr("Couldn’t change the desktop")
        }
    }

    private fun readCatalog(source: JSONObject?): DesktopSelect.Catalog? {
        val o = source?.optJSONObject("desktops") ?: return null
        if (!o.has("rev")) return null
        val rev = o.optLong("rev", -1)
        val viewing = o.optString("viewing")
        val viewGen = if (o.has("viewGen") && !o.isNull("viewGen")) o.optLong("viewGen", -1) else null
        val capture = if (o.has("capture") && !o.isNull("capture")) o.optLong("capture", -1) else null
        val arr = o.optJSONArray("displays") ?: return null
        val rows = ArrayList<DesktopSelect.WireDisplay>(minOf(arr.length(), DesktopSelect.MAX_DISPLAYS))
        val n = minOf(arr.length(), DesktopSelect.MAX_DISPLAYS)
        for (i in 0 until n) {
            val d = arr.optJSONObject(i) ?: continue
            val spacesArr = d.optJSONArray("spaces") ?: continue
            val spaces = ArrayList<String>(minOf(spacesArr.length(), DesktopSelect.MAX_LISTED))
            val m = minOf(spacesArr.length(), DesktopSelect.MAX_LISTED)
            for (j in 0 until m) {
                if (spacesArr.isNull(j)) continue
                val id = spacesArr.optString(j)
                if (id.isNotEmpty()) spaces.add(id)
            }
            rows.add(DesktopSelect.WireDisplay(
                d.optString("id"),
                d.optString("name"),
                d.optBoolean("primary"),
                d.optInt("current", -1),
                d.optInt("count", -1),
                d.optBoolean("truncated"),
                spaces,
            ))
        }
        return DesktopSelect.accept(rev, viewing, viewGen, rows, capture)
    }

    private fun spaceWhy(why: String, edge: String): String = when {
        why == "accessibility" -> tr("Mission Control’s accessibility status can’t be read, so remote control stays paused until it can. Touches are not sent.")
        why == "overview" -> tr("Remote control stays paused while Mission Control is open, so touches are not sent into it.")
        why == "input" -> tr("The Mac isn’t taking input right now")
        why == "unauthorized" || why == "stale" -> tr("The Mac didn’t accept that desktop change")
        why == "display" -> tr("That screen is no longer the one being shown")
        why == "spans" -> tr("macOS keeps these displays on the same desktops, so this screen can’t change desktop by itself")
        why == "composed" -> tr("macOS is still showing windows from another desktop, so this screen can’t change desktop yet")
        why == "edge" && edge == "first" -> tr("Already on the first desktop")
        why == "edge" && edge == "last" -> tr("Already on the last desktop")
        why == "unavailable" || why == "target" -> tr("This Mac can’t change the desktop on the screen being shown")
        else -> tr("Couldn’t change the desktop")
    }

    override fun onClosed() = onLinkClosed(null, false)

    internal fun stopViewerRecovery() { pendingTimer.post {
        viewerRetry.cancel()
        embeddedViewer = null
    } }

    internal fun forgetViewerRecovery(id: String) { pendingTimer.post { viewerRetry.forget(id) } }

    internal fun onLinkClosed(peer: Host?, retain: Boolean) {
        Notify.cancelScreen(core.ctx)
        state = null
        sharingRoute = null
        viewerRetry.closed(peer, retain)
        wantStart = false
        wantStartRoute = null
        embeddedViewer = null
        resetVideo()
        lastInfo = null
        startedByUs = false
        cancelDesktopWait()
        stickyNote = false
        spaceNote = ""
        endPreviewSession()
        host?.post(msg("viewer.input", "on" to false))
        host?.post(msg("stream.stop"))
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t == "screen.textFocus") {
            if (viewing && inputOn && !core.lockView.presented && core.host?.os == "mac") keyboard(true)
            return true
        }
        when (t) {
            "screen.state" -> {
                val was = state
                state = m
                val on = m.optBoolean("on")
                if (!on) resetVideo(keepDoctor = true)
                host?.post(msg("viewer.input", "on" to pointerInput()))
                host?.post(m)
                if (!on || !m.optBoolean("remote", true)) endPreviewSession()
                else desktopPreviews = DesktopPreview.retain(desktopPreviews, desktopCatalog, previewSession)
                // Off -> on, not asked for here: the person pressed Share Screen on the computer.
                if (was != null && !was.optBoolean("on") && on && !viewing && !startedByUs) autoOpen()
                if (!on) Notify.cancelScreen(core.ctx)
                val hold = m.optString("spaceHold")
                val dropped = dropWait(on)
                if (!on) cancelDesktopWait()
                if (!dropped && (pending != null || timeoutDisplay.isNotEmpty())) {
                    val step = DesktopSelect.onState(pending, desktopCatalog, displayId, System.currentTimeMillis(), frameFor())
                    takeDesktop(step, hold)
                } else if (hold == "accessibility" || hold == "overview") {
                    spaceNote = spaceWhy(hold, "")
                    stickyNote = false
                } else if (!stickyNote && (!on || !m.optBoolean("spaces"))) spaceNote = ""
                if (wantStart) startIfNeeded()
                core.changed()
            }
            "stream.input" -> {
                val wasOn = inputOn
                inputOn = m.optBoolean("on", true)
                host?.post(msg("viewer.input", "on" to pointerInput()))
                if (!inputOn) {
                    endPreviewSession()
                    cancelDesktopWait()
                    if (!stickyNote) spaceNote = ""
                } else if (!wasOn) previewEpoch++
                core.changed()
            }
            "screen.space.result" -> {
                if (!m.optBoolean("ok") && m.optString("why") == "stale") cancelDesktopWait()
                if (m.optBoolean("ok")) {
                    stickyNote = m.optBoolean("already")
                    spaceNote = if (m.optBoolean("already")) tr("Already on this desktop") else ""
                } else {
                    stickyNote = true
                    spaceNote = spaceWhy(m.optString("why"), m.optString("edge"))
                }
                refreshDesktops()
                core.changed()
            }
            "screen.preview" -> {
                val clear = m.optBoolean("clear")
                val unavailable = m.optString("unavailable")
                val replyEpoch = if (m.has("epoch")) m.optLong("epoch") else 0L
                if (!ask.accepts(replyEpoch, clear, unavailable)) return true
                desktopPreviews = DesktopPreview.reduce(desktopPreviews, previewMessage(m), desktopCatalog, previewSession)
                core.changed()
            }
            "screen.desktops" -> {
                val epoch = m.optInt("epoch", -1)
                if (epoch != refreshEpoch) return true
                if (m.optBoolean("ok")) refreshFollowups = 0
                else if (m.optString("why") == "stale" && refreshFollowups < 1) {
                    refreshFollowups++
                    refreshDesktops(followUp = true)
                }
            }
            "stream.info" -> { lastInfo = m; host?.post(m) }
            "stream.stop" -> {
                resetVideo(keepDoctor = true)
                videoUnavailable = m.optString("reason") == "capture-unavailable"
                host?.post(m)
                core.changed()
            }
            "rtc.ice" -> host?.post(m)
            else -> return false
        }
        return true
    }

    private fun previewMessage(m: JSONObject): DesktopPreview.Incoming {
        val clear = m.optBoolean("clear")
        val unavailable = m.optString("unavailable")
        if (clear || unavailable == "os" || unavailable == "permission") {
            return DesktopPreview.Incoming(clear, unavailable, "", "", -1, -1, 0, 0, null)
        }
        val raw = m.optString("jpeg")
        val jpeg = if (raw.length > DesktopPreview.MAX_BYTES * 2) null
            else runCatching { Base64.decode(raw, Base64.DEFAULT) }.getOrNull()
        val capture = if (m.has("capture")) m.optLong("capture") else -1L
        val viewGen = if (m.has("viewGen")) m.optLong("viewGen") else -1L
        return DesktopPreview.Incoming(false, unavailable, m.optString("displayId"), m.optString("spaceId"), capture, viewGen, m.optInt("width"), m.optInt("height"), jpeg)
    }
}

// The Mac's sound here (audio m2w): a page in a WebView with no window answers its offers.
class MacSound(core: Core) : Feature(core) {
    private var host: WebHost? = null
    @Volatile var playing = false; private set

    fun sendPolicy() = sendPolicy(null)

    internal fun sendPolicy(route: Link.TrustedRoute?) {
        val accept = core.sync.get("audio", "in")
        val policy = msg("audio.policy", "accept" to accept)
        if (route == null) core.send(policy) else core.link.sendFor(route, policy)
        if (!accept) stop()
    }

    override fun onWelcome(host: Host) = sendPolicy()

    override fun onClosed() = stop()

    private fun stop() {
        host?.destroy()
        host = null
        if (playing) { playing = false; core.changed() }
    }

    internal fun onMessage(t: String, m: JSONObject, embeddedRoute: Link.TrustedRoute?): Boolean {
        if (!t.startsWith("audio.") || m.optString("dir") != "m2w") return false
        when (t) {
            "audio.offer" -> {
                if (!core.sync.get("audio", "in") || !core.cableMediaOk(m)) return true
                val h = host ?: WebHost(core.ctx, "audio.html", core).also { host = it }
                h.post(m, embeddedRoute)
                playing = true
                core.changed()
            }
            "audio.stop" -> stop()
            else -> host?.post(m, embeddedRoute)
        }
        return true
    }
}

// A Wi-Fi lock that keeps the radio out of power save (which holds packets back for up to a
// beacon interval, 100 ms and more): low latency while our viewer is in front, high performance
// for the computer's phone windows (low latency counts only for the app in front).
class WifiFast(ctx: Context) {
    private val wm = ctx.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)
    @Suppress("DEPRECATION")
    private val locks = listOfNotNull(
        runCatching { wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "TwinDesk:screen") }.getOrNull(),
        runCatching { wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "TwinDesk:screen-bg") }.getOrNull(),
    ).onEach { it.setReferenceCounted(false) }
    private var held = false

    @Synchronized fun hold(on: Boolean) {
        if (on == held) return
        held = on
        for (l in locks) runCatching { if (on) l.acquire() else l.release() }
        Log.i("TwinDesk", "wifi low latency ${if (on) "on" else "off"}")
    }
}

// The phone's turning, for remote.html (tdMotion): the gyroscope's radians about the phone's x, y and z
// added up between calls (about every 12 ms), and which way is up (gravity, a unit vector), all in
// the phone's frame. "null" when there's no gyroscope.
class Motion(ctx: Context, private val out: (String) -> Unit) : android.hardware.SensorEventListener {
    private val sm = ctx.getSystemService(android.hardware.SensorManager::class.java)
    private val gyro = sm?.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE)
    private val grav = sm?.getDefaultSensor(android.hardware.Sensor.TYPE_GRAVITY)
    private val accel = if (grav == null) sm?.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER) else null
    private val main = Handler(Looper.getMainLooper())
    private var last = 0L
    private var lastOut = 0L
    private val a = DoubleArray(3)
    private val up = doubleArrayOf(0.0, 0.0, 1.0)

    fun start() {
        if (sm == null || gyro == null) return out("null")
        sm.registerListener(this, gyro, 5_000, main) // as fast as it gives, up to 200 a second
        (grav ?: accel)?.let { sm.registerListener(this, it, android.hardware.SensorManager.SENSOR_DELAY_GAME, main) }
    }

    fun stop() { sm?.unregisterListener(this) }

    override fun onSensorChanged(e: android.hardware.SensorEvent) {
        val v = e.values
        if (e.sensor.type != android.hardware.Sensor.TYPE_GYROSCOPE) {
            val n = Math.sqrt((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toDouble())
            if (n < 1) return
            val k = if (accel != null) 0.15 else 1.0 // the accelerometer alone: smoothed, so a shake doesn't tip "up"
            for (i in 0..2) up[i] += (v[i] / n - up[i]) * k
            val m = Math.sqrt(up[0] * up[0] + up[1] * up[1] + up[2] * up[2]).takeIf { it > 0 } ?: 1.0
            for (i in 0..2) up[i] /= m
            return
        }
        if (last != 0L) {
            val dt = (e.timestamp - last) / 1e9
            if (dt > 0 && dt < 0.1) for (i in 0..2) a[i] += v[i] * dt
        }
        last = e.timestamp
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastOut < 12) return
        lastOut = now
        val f = { d: Double -> String.format(java.util.Locale.ROOT, "%.6f", d) }
        out("${f(a[0])},${f(a[1])},${f(a[2])},${f(up[0])},${f(up[1])},${f(up[2])}")
        a.fill(0.0)
    }

    override fun onAccuracyChanged(s: android.hardware.Sensor?, acc: Int) {}
}
