// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This phone's screen on the computer without wireless debugging (its Mirroring › Native; the
// computer's side is shared/nativescreen.js). Android's screen capture, the same grant as the
// sound's (Sound.kt: one Start for both, held by SoundService), drawn into the hardware H.264
// encoder; what it makes goes to the computer over HTTPS on the session's port (POST
// /twindesk/mirror, its certificate pinned as the session's), in scrcpy's 12-byte packets, so the
// computer's phone window decodes it as it does scrcpy's. Touch and keys come back as phone.in
// (Input.kt, Accessibility).
//   phone.mirror.want {on, key, maxSize, bitrate, fps} | {on, sync}   from the computer
//   phone.mirror.state {on, waiting, error, w, h, sw, sh, key}        to it
// Nothing runs until the computer asks and Start is tapped here; it all stops with the window there.
package com.twindesk.android

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Surface
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class PhoneMirror(core: Core) : Feature(core) {
    @Volatile var wanted = false; private set
    @Volatile var key = ""; private set
    @Volatile internal var embeddedTarget: Link.EmbeddedMirrorTarget? = null; private set
    @Volatile var maxSize = 0; private set
    @Volatile var bitrate = 8_000_000; private set
    @Volatile var fps = 60; private set
    @Volatile var error = ""; private set
    // The picture's size and the screen's (phone.in's pixels), while it runs.
    @Volatile var size = intArrayOf(0, 0, 0, 0)

    val on get() = SoundService.running?.screenOn == true

    override fun onWelcome(host: Host) { error = "" }

    override fun onClosed() {
        want(false, "")
        error = ""
        if (embeddedTarget != null) {
            key = ""
            embeddedTarget = null
        }
    }

    internal fun onMessage(t: String, m: JSONObject, route: Link.TrustedRoute?, fromEmbedded: Boolean): Boolean {
        if (t != Proto.T.PHONE_MIRROR_WANT) return false
        val on = m.optBoolean("on")
        val sync = on && m.optBoolean("sync")
        val ticket = m.optString("key").take(64)
        if (fromEmbedded) {
            if (route == null || (m.opt("key") as? String)?.matches(embeddedTicket) != true) return true
            val target = embeddedTarget
            if (!on || sync) {
                if (target?.route?.marker !== route.marker || !target.current() || !wanted || key != ticket) return true
            } else if (target?.route?.marker !== route.marker || key != ticket) {
                embeddedTarget = core.link.embeddedMirrorTarget(route) ?: return true
            }
        }
        if (sync) { SoundService.running?.syncFrame(); return true }
        if (on) {
            maxSize = m.optInt("maxSize", 0).coerceIn(0, 4096)
            bitrate = m.optInt("bitrate", 8_000_000).coerceIn(500_000, 40_000_000)
            fps = m.optInt("fps", 60).coerceIn(10, 60)
        }
        want(on, ticket)
        return true
    }

    private fun want(v: Boolean, k: String) {
        if (v && k.isNotEmpty() && k != key && wanted) { key = k; SoundService.running?.restartScreen() } // a new window there
        if (v == wanted) return tell()
        wanted = v
        if (v) key = k
        error = ""
        Capture.changed(core)
        tell()
        core.changed()
    }

    fun failed(why: String) {
        error = why
        tell()
        core.changed()
    }

    // phone.mirror.state
    fun tell() {
        if (!core.link.connected) return
        val s = size
        val state = msg(
            Proto.T.PHONE_MIRROR_STATE, "on" to on, "waiting" to (wanted && SoundService.running == null), "error" to error,
            "w" to s[0], "h" to s[1], "sw" to s[2], "sh" to s[3], "key" to key,
        )
        val target = embeddedTarget
        if (target != null) core.link.sendFor(target.route, state)
        else if (!core.link.embedded) core.send(state)
    }

    private companion object {
        val embeddedTicket = Regex("[0-9a-f]{32}")
    }
}

// What the capture grant is for now, and asking for it (one Start for the screen and the sound).
object Capture {
    private val main = Handler(Looper.getMainLooper())

    // The computer wants the screen or the sound (or neither any more): the running capture takes the
    // change; else Start, on the screen when Android lets TwinDesk open it, else in a notification.
    fun changed(core: Core) {
        main.removeCallbacksAndMessages(null)
        main.postDelayed({ // the screen and the sound are often asked for together: one Start
            val s = SoundService.running
            val name = core.host?.name ?: tr("your computer")
            val screen = core.mirror.wanted
            val sound = core.sound.wanted
            when {
                s != null -> s.update()
                !screen && !sound -> Notify.cancelSound(core.ctx)
                else -> {
                    Notify.sound(core.ctx, name, screen)
                    if (screen && (android.provider.Settings.canDrawOverlays(core.ctx) || MainActivity.shown)) core.sound.start(core.ctx)
                }
            }
        }, 300)
    }
}

// The screen, encoded and sent while the computer shows it. Lives with the capture (SoundService):
// its virtual display stays (Android 14 lets a grant make only one), and stopping only detaches it.
class ScreenStreamer(private val ctx: Context, private val projection: MediaProjection, private val core: Core) {
    private var display: VirtualDisplay? = null
    private var codec: MediaCodec? = null
    private var surface: Surface? = null
    private var encoder: Thread? = null
    @Volatile private var sender: Sender? = null

    private class Sender {
        val queue = LinkedBlockingQueue<ByteArray>()
        val queued = AtomicLong(0)
        @Volatile var dropping = false
        private var cancelled = false
        private var call: Call? = null

        @Synchronized fun attach(next: Call): Boolean {
            if (cancelled) return false
            call = next
            return true
        }

        @Synchronized fun cancel() {
            cancelled = true
            call?.cancel()
        }
    }
    @Volatile var running = false; private set
    private var gen = 0 // encoder generation: a rotation makes a new one
    private val main = Handler(Looper.getMainLooper())
    private val dm = ctx.getSystemService(DisplayManager::class.java)

    private val rotation = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) {}
        override fun onDisplayRemoved(id: Int) {}
        override fun onDisplayChanged(id: Int) {
            if (id != Display.DEFAULT_DISPLAY || !running) return
            val (sw, sh) = screen()
            val s = core.mirror.size
            if (sw != s[2] || sh != s[3]) runCatching { encode() }.onFailure { fail(it) }
        }
    }

    fun start() {
        if (running) return
        val attempt = Sender()
        sender = attempt
        running = true
        try {
            encode()
            dm.registerDisplayListener(rotation, main)
            send(core.mirror.key, attempt)
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun stop() {
        if (!running) return
        running = false
        runCatching { dm.unregisterDisplayListener(rotation) }
        val retired = sender
        sender = null
        retired?.cancel()
        stopEncoder()
        runCatching { display?.surface = null }
        core.mirror.size = intArrayOf(0, 0, 0, 0)
    }

    fun release() {
        stop()
        runCatching { display?.release() }
        display = null
    }

    fun sync() {
        runCatching { codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    private fun fail(e: Throwable) {
        Log.w("TwinDesk", "mirror: ${e.message}")
        stop()
        core.mirror.failed(e.message ?: "couldn’t share the screen")
    }

    // The screen's real size now (it turns with the phone), and its density.
    @Suppress("DEPRECATION")
    private fun screen(): Triple<Int, Int, Int> {
        val m = DisplayMetrics()
        dm.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(m)
        return Triple(m.widthPixels, m.heightPixels, m.densityDpi)
    }

    // A new encoder at the screen's size now (first, and after each turn), into the virtual display.
    private fun encode() {
        stopEncoder()
        val (sw, sh, dpi) = screen()
        val long = maxOf(sw, sh)
        val want = core.mirror.maxSize.let { if (it in 1 until long) it else minOf(long, 1920) }
        var w = 0; var h = 0
        var c: MediaCodec? = null
        for (target in listOf(want, 1600, 1280)) { // some encoders take only up to their own size
            if (target > want) continue
            val scale = target.toDouble() / long
            w = (Math.round(sw * scale / 16.0) * 16).toInt().coerceAtLeast(16)
            h = (Math.round(sh * scale / 16.0) * 16).toInt().coerceAtLeast(16)
            c = runCatching { configure(w, h) }.getOrNull()
            if (c != null) break
        }
        val codec = c ?: throw IllegalStateException("The phone’s video encoder didn’t start")
        val input = codec.createInputSurface()
        codec.start()
        this.codec = codec
        surface = input
        val d = display
        if (d == null) display = projection.createVirtualDisplay("TwinDesk", w, h, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null)
        else { d.resize(w, h, dpi); d.surface = input }
        core.mirror.size = intArrayOf(w, h, sw, sh)
        put(sessionPacket(w, h), true)
        val my = ++gen
        encoder = Thread({ drain(codec, my) }, "td-mirror-enc").apply { start() }
        core.mirror.tell()
    }

    private fun configure(w: Int, h: Int): MediaCodec {
        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, core.mirror.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, core.mirror.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000) // a still screen still sends now and then
            setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, core.mirror.fps.toFloat())
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        } catch (e: Exception) {
            c.release(); throw e
        }
        return c
    }

    private fun stopEncoder() {
        gen++
        val c = codec ?: return
        codec = null
        runCatching { encoder?.join(300) }
        encoder = null
        runCatching { c.stop() }
        runCatching { c.release() }
        runCatching { surface?.release() }
        surface = null
    }

    // Each encoded picture: to the stream, with its flags (config: the SPS/PPS; key: a keyframe).
    private fun drain(c: MediaCodec, my: Int) {
        val info = MediaCodec.BufferInfo()
        while (running && gen == my) {
            val i = try { c.dequeueOutputBuffer(info, 100_000) } catch (e: Exception) { break }
            if (i < 0) continue
            try {
                if (info.size > 0) {
                    val buf: ByteBuffer = c.getOutputBuffer(i) ?: continue
                    val data = ByteArray(info.size)
                    buf.position(info.offset); buf.get(data)
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    val keyFrame = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    put(framePacket(info.presentationTimeUs, config, keyFrame, data), config || keyFrame)
                }
            } finally {
                runCatching { c.releaseOutputBuffer(i, false) }
            }
        }
    }

    // Late pictures are worse than none: behind by too much, skip to the next keyframe (asked for now).
    private fun put(p: ByteArray, important: Boolean) {
        val attempt = sender ?: return
        if (attempt.queued.get() > MAX_QUEUED && !important) {
            if (!attempt.dropping) { attempt.dropping = true; sync() }
            return
        }
        if (attempt.dropping && !important) return
        if (important) attempt.dropping = false
        attempt.queued.addAndGet(p.size.toLong())
        attempt.queue.offer(p)
    }

    // The stream: one long POST to the computer, written as the pictures come.
    private fun send(key: String, attempt: Sender) {
        val target = core.mirror.embeddedTarget
        val client = if (target == null) core.link.https() ?: throw IllegalStateException("not connected") else null
        val endpoint = if (target == null) core.link.endpoint() ?: throw IllegalStateException("not connected") else null
        fun current() = running && sender === attempt && (target == null ||
            (target.current() && core.mirror.embeddedTarget === target && core.mirror.wanted && core.mirror.key == key))
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                while (current()) {
                    val p = attempt.queue.poll(500, TimeUnit.MILLISECONDS) ?: continue
                    attempt.queued.addAndGet(-p.size.toLong())
                    if (!current()) return
                    sink.write(p)
                    if (attempt.queue.isEmpty()) sink.flush()
                }
            }
        }
        val execute: (Call) -> Unit = { call ->
            if (current() && attempt.attach(call) && current()) {
                core.mirror.tell() // on: the picture is coming
                call.execute().use { r ->
                    if (!r.isSuccessful && current()) throw IllegalStateException("The computer refused the picture (${r.code})")
                }
            }
        }
        Thread({
            try {
                if (target != null) {
                    target.post(key, body, ::current, execute)
                } else if (endpoint != null && client != null) {
                    val (address, port) = endpoint
                    val request = Request.Builder().url("https://$address:$port/twindesk/mirror")
                        .header("x-twindesk-mirror", key).post(body).build()
                    execute(client.newCall(request))
                }
            } catch (e: Exception) {
                if (current()) main.post { if (current()) fail(e) }
            }
        }, "td-mirror-send").start()
    }

    companion object {
        private const val MAX_QUEUED = 3L * 1024 * 1024

        fun sessionPacket(w: Int, h: Int): ByteArray =
            ByteBuffer.allocate(12).put(0, 0x80.toByte()).putInt(4, w).putInt(8, h).array()

        fun framePacket(ptsUs: Long, config: Boolean, key: Boolean, data: ByteArray): ByteArray {
            var flags = ptsUs.coerceAtLeast(0) and ((1L shl 61) - 1)
            if (config) flags = flags or (1L shl 62)
            if (key) flags = flags or (1L shl 61)
            return ByteBuffer.allocate(12 + data.size).putLong(flags).putInt(data.size).put(data).array()
        }
    }
}
