// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This phone's controls on the computer's Overview, and the computer's here (shared/devctl.js):
//   dev.state → the computer: what it can do here (ring, lock, quick settings, ringer, volume), its
//     quick settings (Wi-Fi, Bluetooth, mobile data, hotspot, torch, Do not disturb, auto-rotate,
//     battery saver: on or off, a word about each, and which only open their panel here), the media
//     volume, the ringer, and the most used apps (Usage access, granted over wireless debugging).
//     Sent at the start of each session and whenever one of them changes.
//   dev.do ← the computer: ring until stopped (the alarm sound at full volume, even on silent),
//     lock (Accessibility), a quick setting, the ringer, the volume. What Android doesn't let an app
//     switch (Wi-Fi, data, hotspot and Bluetooth on newer Android) the computer switches over
//     wireless debugging when it can (shared/devadb.js); otherwise its panel opens here.
//   dev.state ← the computer: its own (ring, lock, sleep, Bluetooth, Do not disturb, volume), for
//     the Computer page here; dev.do → the computer from that page.
package com.twindesk.android

import android.Manifest
import android.app.AppOpsManager
import android.app.NotificationManager
import android.app.usage.UsageStatsManager
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.hardware.camera2.CameraManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.telephony.TelephonyManager
import android.accessibilityservice.AccessibilityService
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.Executors

class DevCtl(core: Core) : Feature(core) {
    companion object {
        const val DO = "dev.do"
        const val STATE = "dev.state"
        private const val RING_MS = 120_000L
    }

    private val ctx get() = core.ctx
    private val main = Handler(Looper.getMainLooper())
    private val sendSoon = Runnable { sendState() }
    private var watching = false
    private var packagesWatching = false
    private var peerAsks = false
    private var askedUntil = 0L
    private val topCache = TopCache()
    private val topLock = Any()
    @Volatile private var packageSet: Set<String>? = null
    private var torchOn = false
    private var ringtone: Ringtone? = null
    private var alarmBefore = -1
    private val stateBuilds = DeviceStateBuilds(
        executor = Executors.newSingleThreadExecutor { Thread(it, "td-device-state").apply { isDaemon = true } },
        post = { main.post(it) },
        scheduleDeadline = { main.postDelayed(it, 20_000L) },
        cancelDeadline = { main.removeCallbacks(it) },
        current = { if (core.link.connected) core.link.sessionMarker() else null },
        capture = ::captureState,
        sendFor = { marker, message -> core.link.sendFor(marker, message) },
        onTimeout = { android.util.Log.w("TwinDesk", "Device state build timed out") },
    )

    // The computer's own controls, for the Computer page (null: it hasn't said: an older TwinDesk).
    @Volatile var computer: JSONObject? = null; private set
    var onComputer: (() -> Unit)? = null

    override fun onWelcome(host: Host) {
        val marker = core.link.sessionMarker()
        main.post {
            if (marker == null || core.link.sessionMarker() !== marker) return@post
            welcomed()
        }
    }

    private fun welcomed() {
        computer = null
        peerAsks = false
        askedUntil = 0L
        main.removeCallbacks(askExpired)
        stateBuilds.resetKey()
        // Until the computer's first dev.state, it may be a build that never asks. Keep today's stream.
        watchPackages(true)
        watch(true)
        sendState()
        askTries = 0
        main.removeCallbacks(askAgain)
        main.postDelayed(askAgain, 1500)
    }

    // The computer's dev.state can be missed at the start (it sent before this side listened, or the
    // computer had another device selected then): without it Overview shows only the hero until a
    // page change there. Ours again, a few times, until it answers (it answers our first).
    private var askTries = 0
    private val askAgain: Runnable = object : Runnable {
        override fun run() {
            if (!core.link.connected || computer != null || askTries >= 6) return
            askTries++
            sendState(ask = true)
            main.postDelayed(this, 1500L * (askTries + 1))
        }
    }

    override fun onClosed() {
        main.removeCallbacks(askAgain)
        main.removeCallbacks(askExpired)
        main.post { stateBuilds.closed() }
        peerAsks = false
        askedUntil = 0L
        watch(false)
        watchPackages(false)
        ring(false)
        computer = null
        main.post { onComputer?.invoke() }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            DO -> main.post { act(m) }
            STATE -> {
                computer = m
                if (m.optInt("asks") == 1) peerAsks = true
                val asking = m.optBoolean("ask")
                if (asking) noteAsk(System.currentTimeMillis() + DEV_ASKED_MS)
                if (asking) sendState()
                refreshWatch()
                core.changed()
                main.post { onComputer?.invoke() }
            }
            // Explorer's Capture from phone on the computer: the camera here, each photo there.
            CaptureActivity.T -> main.post {
                if (m.optBoolean("on")) {
                    CaptureActivity.running?.end(tell = false) // a photo or a scan already open closes before the next one
                    runCatching {
                        ctx.startActivity(android.content.Intent(ctx, CaptureActivity::class.java)
                            .putExtra("once", m.optBoolean("once"))
                            .putExtra("mode", m.optString("mode")) // "scan" or absent: a normal capture (older computers)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                } else CaptureActivity.running?.end(tell = false)
            }
            else -> return false
        }
        return true
    }

    // The Computer page's buttons: to the computer.
    // Ring and Stop show at once (as the computer's Overview does): the computer's dev.state corrects
    // it, but one that is late or never comes (another device selected there) must not leave Ring
    // up while it rings, so Stop stays reachable.
    fun ask(cmd: String, vararg fields: Pair<String, Any?>) {
        core.send(msg(DO, "do" to cmd, *fields))
        val c = computer ?: return
        if (cmd == "ring" || cmd == "ringStop") {
            computer = JSONObject(c.toString()).put("ringing", cmd == "ring")
            core.changed()
            main.post { onComputer?.invoke() }
        }
    }

    // ---- what the computer asks ----

    private fun act(m: JSONObject) {
        runCatching {
            when (m.optString("do")) {
                "ring" -> ring(true)
                "ringStop" -> ring(false)
                "lock" -> lock()
                "qs" -> qs(m.optString("id"), m.optBoolean("on"))
                "ringer" -> ringer(m.optString("mode"))
                "volume" -> volume(m.optDouble("level", -1.0))
            }
        }
        // One result even when the computer is not watching. While it is, the usual debounce applies.
        if (deviceStateLive(peerAsks, askedUntil, System.currentTimeMillis())) later(250) else sendState()
    }

    private val audio get() = ctx.getSystemService(AudioManager::class.java)

    // Ringing because the computer asked: Stop on the phone (its notification, or Overview here).
    val ringing get() = ringtone != null
    fun stopRing() = main.post { ring(false) }.let { }

    private fun ring(on: Boolean) {
        main.removeCallbacks(stopRing)
        val was = ringtone != null
        ringtone?.stop()
        ringtone = null
        if (was && !on) { Notify.cancelRinging(ctx); core.changed() }
        if (alarmBefore >= 0) { runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, alarmBefore, 0) }; alarmBefore = -1 }
        if (!on) { later(0); return }
        val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: return
        val r = RingtoneManager.getRingtone(ctx, uri) ?: return
        r.audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
        alarmBefore = audio.getStreamVolume(AudioManager.STREAM_ALARM)
        runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0) }
        r.play()
        ringtone = r
        Notify.ringing(ctx, core.host?.name.orEmpty())
        core.changed()
        main.postDelayed(stopRing, RING_MS)
        later(0)
    }
    private val stopRing = Runnable { ring(false) }

    // Locks with the Accessibility service (Android 9+); the computer locks over ADB otherwise.
    private fun lock() {
        val a = InputService.running ?: return
        if (Build.VERSION.SDK_INT >= 28) a.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
    }

    private fun qs(id: String, on: Boolean) {
        when (id) {
            "torch" -> torch(on)
            "dnd" -> dnd(on)
            "rotate" -> if (Settings.System.canWrite(ctx)) Settings.System.putInt(ctx.contentResolver, Settings.System.ACCELEROMETER_ROTATION, if (on) 1 else 0) else panel(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).setData(android.net.Uri.parse("package:" + ctx.packageName)))
            "wifi" -> if (Build.VERSION.SDK_INT < 29) @Suppress("DEPRECATION") wifi()?.setWifiEnabled(on) else panel(Intent(Settings.Panel.ACTION_WIFI))
            "data" -> panel(if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY) else Intent(Settings.ACTION_DATA_ROAMING_SETTINGS))
            "bluetooth" -> {
                val a = bt()
                @Suppress("DEPRECATION", "MissingPermission")
                val done = Build.VERSION.SDK_INT < 33 && a != null && runCatching { if (on) a.enable() else a.disable() }.getOrDefault(false)
                if (!done) panel(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
            }
            "hotspot" -> panel(Intent().setClassName("com.android.settings", "com.android.settings.TetherSettings"), Intent(Settings.ACTION_WIRELESS_SETTINGS))
            "saver" -> panel(Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS))
        }
    }

    // A setting this app can't switch: its panel on the phone (TwinDesk may start it from the
    // background with Display over other apps).
    private fun panel(vararg intents: Intent) {
        for (i in intents) if (runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
    }

    private fun torch(on: Boolean) {
        torchOn = on
        val cm = ctx.getSystemService(CameraManager::class.java) ?: return
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true } ?: return
        cm.setTorchMode(id, on)
    }

    // Do not disturb: the notification listener may set it (the full app), else with Do not
    // disturb access, else its settings open.
    private fun dnd(on: Boolean) {
        if (!on) core.silence.personOff() // … and what Silence together turned on for the computer: its own rule, which this filter doesn't reach
        val f = if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.isNotificationPolicyAccessGranted) { nm.setInterruptionFilter(f); return }
        val l = NotifListener.running
        if (l != null) { runCatching { l.requestInterruptionFilter(f) }.onSuccess { return } }
        panel(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
    }

    private fun ringer(mode: String) {
        val m = when (mode) { "ring" -> AudioManager.RINGER_MODE_NORMAL; "vibrate" -> AudioManager.RINGER_MODE_VIBRATE; "silent" -> AudioManager.RINGER_MODE_SILENT; else -> return }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (m == AudioManager.RINGER_MODE_SILENT && !nm.isNotificationPolicyAccessGranted) {
            // Silent needs Do not disturb access; the listener's Do not disturb is the nearest thing.
            val l = NotifListener.running
            if (l != null) { runCatching { l.requestInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_NONE) }; return }
            panel(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
            return
        }
        runCatching { audio.ringerMode = m }
    }

    private fun volume(level: Double) {
        if (level < 0) return
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(level.coerceIn(0.0, 1.0) * max).toInt(), 0)
    }

    // ---- what the computer is told ----

    private fun wifi() = ctx.applicationContext.getSystemService(WifiManager::class.java)
    private fun bt() = ctx.getSystemService(BluetoothManager::class.java)?.adapter

    private fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    private fun sendState(ask: Boolean = false) = stateBuilds.request(ask)

    private fun captureState(ask: Boolean): () -> Pair<String, JSONObject> {
        val torch = torchOn
        val ringing = ringing
        val lock = InputService.running != null && Build.VERSION.SDK_INT >= 28
        return {
            val message = buildState(torch, ringing, lock)
            val key = message.toString()
            if (ask) message.put("ask", true)
            key to message
        }
    }

    private fun buildState(torch: Boolean, ringing: Boolean, lock: Boolean): JSONObject {
        val qs = JSONObject()
        val detail = JSONObject()
        val panel = JSONObject()
        runCatching { wifi()?.let { qs.put("wifi", it.isWifiEnabled) } }
        runCatching {
            val a = bt()
            if (a != null && (Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT))) qs.put("bluetooth", a.isEnabled)
        }
        runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            if (tm != null && tm.phoneType != TelephonyManager.PHONE_TYPE_NONE) {
                qs.put("data", Settings.Global.getInt(ctx.contentResolver, "mobile_data", 0) == 1)
                tm.networkOperatorName?.takeIf { it.isNotBlank() }?.let { detail.put("data", it.take(30)) }
            }
        }
        runCatching {
            val w = wifi()
            val m = w?.javaClass?.getMethod("isWifiApEnabled")
            if (m != null) qs.put("hotspot", m.invoke(w) == true)
        }
        if (ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) qs.put("torch", torch)
        runCatching { qs.put("dnd", ctx.getSystemService(NotificationManager::class.java).currentInterruptionFilter > NotificationManager.INTERRUPTION_FILTER_ALL) }
        runCatching { qs.put("rotate", Settings.System.getInt(ctx.contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0) == 1) }
        runCatching { qs.put("saver", ctx.getSystemService(PowerManager::class.java).isPowerSaveMode) }
        if (Build.VERSION.SDK_INT >= 29) { panel.put("wifi", true); panel.put("data", true); panel.put("hotspot", true) } else { panel.put("data", true); panel.put("hotspot", true) }
        if (Build.VERSION.SDK_INT >= 33) panel.put("bluetooth", true)
        panel.put("saver", true)
        if (!Settings.System.canWrite(ctx)) panel.put("rotate", true)
        qs.put("detail", detail).put("panel", panel)
        runCatching {
            val a = audio
            qs.put("volume", a.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / a.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1))
            qs.put("ringer", when (a.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "ring" })
        }
        val can = JSONObject().put("ring", true).put("qs", true).put("ringer", true).put("volume", true)
        if (lock) can.put("lock", true)
        val m = msg(STATE, "can" to can, "ringing" to ringing, "qs" to qs, "info" to info())
        m.put("app", JSONObject().put("v", BuildConfig.VERSION_NAME)) // which TwinDesk (shared/appinfo.js): the computer warns when it's older
        top()?.let { m.put("top", jsonArray(it)) }
        return stampDeviceAsks(m)
    }

    // For the computer's Overview card: storage, the network, the signal.
    private fun info(): JSONObject {
        val o = JSONObject()
        runCatching {
            val st = android.os.StatFs(android.os.Environment.getDataDirectory().path)
            val gb = 1_000_000_000.0
            val total = st.totalBytes / gb
            o.put("storageTotal", Math.round(total)).put("storageUsed", Math.round(total - st.availableBytes / gb))
        }
        runCatching {
            val cm = ctx.getSystemService(android.net.ConnectivityManager::class.java)
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            if (caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true) {
                @Suppress("DEPRECATION")
                val ssid = wifi()?.connectionInfo?.ssid?.trim('"')?.takeIf { it.isNotBlank() && it != "<unknown ssid>" }
                o.put("wifi", ssid ?: "Wi-Fi")
            }
        }
        runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            if (tm != null && tm.phoneType != TelephonyManager.PHONE_TYPE_NONE) {
                val gen = if (granted(Manifest.permission.READ_PHONE_STATE)) @Suppress("DEPRECATION") when (tm.dataNetworkType) {
                    TelephonyManager.NETWORK_TYPE_NR -> "5G"
                    TelephonyManager.NETWORK_TYPE_LTE -> "4G"
                    TelephonyManager.NETWORK_TYPE_HSPAP, TelephonyManager.NETWORK_TYPE_HSPA, TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_HSDPA, TelephonyManager.NETWORK_TYPE_HSUPA -> "3G"
                    TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_GPRS -> "2G"
                    else -> ""
                } else ""
                o.put("cell", listOf(tm.networkOperatorName.orEmpty(), gen).filter { it.isNotBlank() }.joinToString(" · "))
                if (Build.VERSION.SDK_INT >= 28) tm.signalStrength?.level?.let { o.put("signal", listOf("None", "Weak", "Fair", "Good", "Excellent")[it.coerceIn(0, 4)]) }
            }
        }
        return o
    }

    // The most used apps of the last week, with Usage access (wireless debugging grants it).
    // The 7-day query is cached for five minutes, and dropped when an app is installed or removed.
    private fun top(): List<String>? {
        val now = System.currentTimeMillis()
        val pkgs = packageSet
        if (pkgs != null) synchronized(topLock) { topCache.get(now, pkgs)?.let { return it } }
        val result = queryTop()
        val after = packageSet ?: launchablePackages().also { packageSet = it }
        if (pkgs == null || pkgs == after) synchronized(topLock) { topCache.put(now, after, result) }
        return result
    }

    private fun queryTop(): List<String>? {
        val ops = ctx.getSystemService(AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val mode = runCatching { ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName) }.getOrDefault(AppOpsManager.MODE_IGNORED)
        if (mode != AppOpsManager.MODE_ALLOWED) return null
        val usm = ctx.getSystemService(UsageStatsManager::class.java) ?: return null
        val now = System.currentTimeMillis()
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 7 * 86_400_000L, now) ?: return null
        val pm = ctx.packageManager
        return stats.groupBy { it.packageName }.mapValues { (_, v) -> v.sumOf { it.totalTimeInForeground } }
            .filter { (p, t) -> t > 60_000 && p != ctx.packageName && pm.getLaunchIntentForPackage(p) != null }
            .entries.sortedByDescending { it.value }.take(8).map { it.key }
    }

    private fun launchablePackages(): Set<String> = runCatching {
        ctx.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.activityInfo.packageName }
            .toSet()
    }.getOrDefault(emptySet())

    private fun later(ms: Long) {
        if (!deviceStateLive(peerAsks, askedUntil, System.currentTimeMillis())) return
        main.removeCallbacks(sendSoon)
        main.postDelayed(sendSoon, ms + 150)
    }

    private fun noteAsk(until: Long) {
        askedUntil = until
        main.removeCallbacks(askExpired)
        val delay = until - System.currentTimeMillis()
        if (delay > 0) main.postDelayed(askExpired, delay) else refreshWatch()
    }

    private val askExpired = Runnable { refreshWatch() }

    /** Sensors and the minute poll run only while a build that speaks "asks" still has a fresh one. */
    private fun refreshWatch() {
        val connected = core.link.connected
        val live = connected && deviceStateLive(peerAsks, askedUntil, System.currentTimeMillis())
        if (!live) main.removeCallbacks(sendSoon)
        watch(live)
        if (!connected) watchPackages(false)
    }

    // ---- watching for changes while connected ----

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = later(300)
    }
    private val observer = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) = later(300)
    }
    private val torchCb = object : CameraManager.TorchCallback() {
        override fun onTorchModeChanged(cameraId: String, enabled: Boolean) { torchOn = enabled; later(100) }
    }
    private val poll = object : Runnable {
        override fun run() {
            // The ask window closed between polls: drop the sensors instead of building another snapshot.
            if (!deviceStateLive(peerAsks, askedUntil, System.currentTimeMillis())) {
                refreshWatch()
                return
            }
            later(0)
            main.postDelayed(this, 60_000) // volume and the most used apps
        }
    }
    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            packageSet = null
            synchronized(topLock) { topCache.invalidate() }
        }
    }

    private fun watchPackages(on: Boolean) {
        if (on == packagesWatching) return
        packagesWatching = on
        if (on) {
            val f = IntentFilter().apply {
                addAction(Intent.ACTION_PACKAGE_ADDED)
                addAction(Intent.ACTION_PACKAGE_REMOVED)
                addDataScheme("package")
            }
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(packageReceiver, f, Context.RECEIVER_NOT_EXPORTED)
            else ctx.registerReceiver(packageReceiver, f)
        } else runCatching { ctx.unregisterReceiver(packageReceiver) }
    }

    private fun watch(on: Boolean) = main.post {
        if (on == watching) return@post
        watching = on
        val cm = ctx.getSystemService(CameraManager::class.java)
        if (on) {
            val f = IntentFilter().apply {
                addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
                addAction("android.net.wifi.WIFI_AP_STATE_CHANGED")
                addAction("android.bluetooth.adapter.action.STATE_CHANGED")
                addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
                addAction(AudioManager.RINGER_MODE_CHANGED_ACTION)
                addAction("android.media.VOLUME_CHANGED_ACTION")
                addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
            }
            ContextCompat.registerReceiver(ctx, receiver, f, ContextCompat.RECEIVER_EXPORTED)
            ctx.contentResolver.registerContentObserver(Settings.System.getUriFor(Settings.System.ACCELEROMETER_ROTATION), false, observer)
            ctx.contentResolver.registerContentObserver(Settings.Global.getUriFor("mobile_data"), true, observer)
            runCatching { cm?.registerTorchCallback(torchCb, main) }
            main.postDelayed(poll, 60_000)
        } else {
            runCatching { ctx.unregisterReceiver(receiver) }
            runCatching { ctx.contentResolver.unregisterContentObserver(observer) }
            runCatching { cm?.unregisterTorchCallback(torchCb) }
            main.removeCallbacks(poll)
            main.removeCallbacks(sendSoon)
        }
    }
}

internal fun shouldSendDeviceState(owner: Any, current: Any?, previous: String, next: String, ask: Boolean): Boolean =
    owner === current && (ask || previous != next)

internal const val DEV_ASKED_MS = 150_000L
internal const val TOP_FRESH_MS = 5 * 60_000L

/** A peer that never says `asks` is served as before. A peer that does is served only while its last ask is fresh. */
internal fun deviceStateLive(peerAsks: Boolean, askedUntil: Long, now: Long): Boolean =
    !peerAsks || now < askedUntil

/** Marks a phone snapshot as one the computer may ask to refresh (shared/devctl.js). */
internal fun stampDeviceAsks(message: JSONObject): JSONObject = message.put("asks", 1)

/** The 7-day usage list, kept until it is five minutes old or the installed package set changes. */
internal class TopCache {
    private var at = 0L
    private var packages: Set<String> = emptySet()
    private var value: List<String>? = null
    private var have = false

    fun get(now: Long, packages: Set<String>): List<String>? {
        if (!have || packages != this.packages || now - at >= TOP_FRESH_MS) return null
        return value
    }

    fun put(now: Long, packages: Set<String>, value: List<String>?) {
        at = now
        this.packages = packages
        this.value = value
        have = true
    }

    fun invalidate() {
        have = false
    }
}


// Main owns the queue and publication. The worker only runs the captured build.
internal class DeviceStateBuilds<T>(
    private val executor: Executor,
    private val post: (Runnable) -> Unit,
    private val scheduleDeadline: (Runnable) -> Unit,
    private val cancelDeadline: (Runnable) -> Unit,
    private val current: () -> Any?,
    private val capture: (Boolean) -> () -> Pair<String, T>,
    private val sendFor: (Any, T) -> Boolean,
    private val onTimeout: () -> Unit,
) {
    private var building = false
    private var pending: Boolean? = null
    private var last = ""

    fun resetKey() {
        last = ""
    }

    fun closed() {
        pending = null
    }

    fun request(ask: Boolean) {
        val marker = current() ?: return
        if (building) {
            pending = ask || pending == true
            return
        }
        val build = try {
            capture(ask)
        } catch (e: Exception) {
            android.util.Log.e("TwinDesk", "Device state capture failed", e)
            return
        }
        building = true
        var expired = false
        // A blocked Android system call may ignore cancellation. Keep its slot until it
        // returns, so timeouts cannot accumulate workers or reorder state messages.
        val deadline = Runnable {
            expired = true
            onTimeout()
        }
        scheduleDeadline(deadline)
        executor.execute {
            val result = runCatching(build)
            post {
                cancelDeadline(deadline)
                building = false
                if (!expired) result.getOrNull()?.let { (key, message) ->
                    if (shouldSendDeviceState(marker, current(), last, key, ask) &&
                        sendFor(marker, message)) last = key
                }
                val followUp = pending
                pending = null
                if (followUp != null) request(followUp)
            }
        }
    }
}
