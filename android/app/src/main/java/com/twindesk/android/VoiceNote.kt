// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Voice note (a button of the connected notification, General › Notification buttons; not one of
// the defaults): recording starts at once, Add marker timestamps moments during recording using
// monotonic elapsedRealtime, and Send stops it so the note (plus a UTF-8 marker text companion in
// Download/TwinDesk when markers exist) goes to the computer in one batch as Send files does (it
// waits under Waiting to send when the computer isn't connected). A copy stays in Recordings/TwinDesk.
// Leaving the dialog sends what was recorded: Android lets only an app on screen use the microphone,
// so nothing records in the background.
package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.DialogInterface
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal object VoiceNoteMarkers {
    fun formatElapsed(ms: Long): String {
        val totalSeconds = ms.coerceAtLeast(0L) / 1000L
        val h = totalSeconds / 3600L
        val m = (totalSeconds % 3600L) / 60L
        val s = totalSeconds % 60L
        return if (h > 0L) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.ROOT, "%d:%02d", m, s)
    }

    fun dialogMessage(elapsedMs: Long, markersMs: List<Long>): String {
        val clock = formatElapsed(elapsedMs)
        if (markersMs.isEmpty()) return clock
        val last = formatElapsed(markersMs.last())
        val line = if (markersMs.size == 1) tr("1 marker · last at {time}", "time" to last)
        else tr("{count} markers · last at {time}", "count" to markersMs.size, "time" to last)
        return "$clock\n$line"
    }

    fun formatText(audioDisplayName: String, markersMs: List<Long>): String {
        val sb = StringBuilder()
        sb.append(audioDisplayName).append('\n')
        markersMs.forEachIndexed { index, ms ->
            sb.append(index + 1).append(". ").append(formatElapsed(ms)).append('\n')
        }
        return sb.toString()
    }
}

class VoiceNoteActivity : Activity() {
    private var rec: MediaRecorder? = null
    private var pfd: ParcelFileDescriptor? = null
    private var uri: Uri? = null
    private val recordingFolder = (if (Build.VERSION.SDK_INT >= 31) Environment.DIRECTORY_RECORDINGS else Environment.DIRECTORY_MUSIC) + "/TwinDesk"
    private var started = 0L
    private val markers = ArrayList<Long>()
    private var dialog: AlertDialog? = null
    private var done = false
    internal var elapsedNow: () -> Long = { SystemClock.elapsedRealtime() }
    internal var createRecorder: () -> MediaRecorder = {
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
    }
    private val main = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            updateDialogMessage()
            if (rec != null) main.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return finish()
        if (RuntimeGrant.granted(this, Manifest.permission.RECORD_AUDIO)) {
            begin()
        } else if (RuntimeGrant.requestable(this, Core.get(this).store, listOf(Manifest.permission.RECORD_AUDIO)).isNotEmpty()) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        } else {
            RuntimeGrant.openSettings(this)
            finish()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 1) return
        grantResults.firstOrNull()?.let {
            RuntimeGrant.record(Core.get(this).store, Manifest.permission.RECORD_AUDIO, it == PackageManager.PERMISSION_GRANTED)
        }
        if (RuntimeGrant.granted(this, Manifest.permission.RECORD_AUDIO)) begin() else finish()
    }

    private fun begin() {
        val core = Core.get(this)
        val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: tr("your computer")
        val ok = runCatching { start() }.onFailure { Log.w("TwinDesk", "voice note: ${it.message}") }.isSuccess
        if (!ok) {
            Toast.makeText(applicationContext, tr("Couldn’t record"), Toast.LENGTH_SHORT).show()
            discard()
            return finish()
        }
        // The system's own dialog look, light or dark as the phone is.
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        val dlg = AlertDialog.Builder(this, if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
            .setTitle(tr("Voice note for {name}", "name" to name))
            .setMessage("0:00")
            .setPositiveButton(tr("Send")) { _, _ -> finishNote(send = true) }
            .setNeutralButton(tr("Add marker"), null)
            .setNegativeButton(tr("Cancel")) { _, _ -> finishNote(send = false) }
            .setOnCancelListener { finishNote(send = false) }
            .show()
        dlg.getButton(DialogInterface.BUTTON_NEUTRAL)?.setOnClickListener { addMarker() }
        dialog = dlg
        main.post(tick)
    }

    private fun updateDialogMessage() {
        val elapsed = (elapsedNow() - started).coerceAtLeast(0L)
        dialog?.setMessage(VoiceNoteMarkers.dialogMessage(elapsed, markers))
    }

    private fun addMarker() {
        if (done || rec == null) return
        markers.add((elapsedNow() - started).coerceAtLeast(0L))
        updateDialogMessage()
    }

    private fun start() {
        val stamp = SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(Date())
        val base = "Voice note $stamp"
        val v = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "$base.m4a")
            put(MediaStore.MediaColumns.MIME_TYPE, "audio/mp4")
            put(MediaStore.MediaColumns.RELATIVE_PATH, recordingFolder)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val u = contentResolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v) ?: error("no place for it")
        uri = u
        val fd = contentResolver.openFileDescriptor(u, "w") ?: error("can't write it")
        pfd = fd
        val r = createRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(96000)
            r.setAudioSamplingRate(44100)
            r.setOutputFile(fd.fileDescriptor)
            r.prepare()
            r.start()
        } catch (t: Throwable) {
            runCatching { r.release() }
            runCatching { pfd?.close() }
            pfd = null
            throw t
        }
        rec = r
        started = elapsedNow()
        markers.clear()
    }

    private fun publishMarkers(audioName: String, marks: List<Long>): Uri? {
        val base = if (audioName.endsWith(".m4a", ignoreCase = true)) audioName.dropLast(4) else audioName
        val markerName = "$base.txt"
        val content = VoiceNoteMarkers.formatText(audioName, marks).toByteArray(Charsets.UTF_8)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, markerName)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/TwinDesk")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        var created: Uri? = null
        return runCatching {
            val target = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("no place for markers")
            created = target
            contentResolver.openOutputStream(target)?.use { out ->
                out.write(content)
                out.flush()
            } ?: error("can't write markers")
            val updated = contentResolver.update(target, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            if (updated <= 0) error("can't finalize markers")
            target
        }.onFailure { err ->
            Log.w("TwinDesk", "voice note markers: ${err.message}")
            created?.let { orphan -> runCatching { contentResolver.delete(orphan, null, null) } }
        }.getOrNull()
    }

    // Stops it; send: to the computer (a note under a second isn't one).
    private fun finishNote(send: Boolean) {
        if (done) return
        done = true
        main.removeCallbacks(tick)
        val r = rec
        rec = null
        val long = elapsedNow() - started >= 1000L
        val stopped = r != null && runCatching { r.stop() }.isSuccess
        runCatching { r?.release() }
        runCatching { pfd?.close() }
        pfd = null
        val u = uri
        if (!send || !stopped || !long || u == null) {
            markers.clear()
            discard()
        } else {
            saveAndSend(u)
        }
        dialog?.dismiss()
        finish()
    }

    private fun saveAndSend(audioUri: Uri) {
        val published = runCatching {
            contentResolver.update(audioUri, ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }, null, null) > 0
        }.getOrDefault(false)
        if (!published) {
            toast(tr("Couldn’t save the recording"))
            return
        }

        val core = Core.get(this)
        // The text accompanies a playable recording. Do not create or queue markers on their own.
        val audio = core.files.describe(listOf(audioUri)).singleOrNull()
        if (audio == null) {
            toast(if (markers.isEmpty()) tr("Saved in Recordings › TwinDesk")
                else tr("Saved in Recordings › TwinDesk (couldn’t save markers)"))
            return
        }
        val markerUri = if (markers.isNotEmpty()) publishMarkers(audio.name, markers) else null
        val marker = markerUri?.let { core.files.describe(listOf(it)).singleOrNull() }
        val markerFailed = markers.isNotEmpty() && marker == null
        val went = core.files.send(listOfNotNull(audio, marker), "send")
        val now = went && core.link.connected
        val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: tr("your computer")
        toast(when {
            markerFailed && now -> tr("Sending to {name} (couldn’t save markers)", "name" to name)
            markerFailed && went -> tr("Waiting for {name} (couldn’t save markers)", "name" to name)
            markerFailed -> tr("Saved in Recordings › TwinDesk (couldn’t save markers)")
            now -> tr("Sending to {name}", "name" to name)
            went -> tr("Waiting for {name}", "name" to name)
            marker != null -> tr("Audio in {folder}, markers in Downloads › TwinDesk", "folder" to recordingFolder)
            else -> tr("Saved in Recordings › TwinDesk")
        })
    }

    private fun toast(message: String) = Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()

    private fun discard() {
        uri?.let { u -> runCatching { contentResolver.delete(u, null, null) } }
        uri = null
    }

    // Off screen: Android takes the microphone away, so what was recorded goes now.
    override fun onStop() {
        super.onStop()
        if (rec != null && !isChangingConfigurations) finishNote(send = true)
    }

    override fun onDestroy() {
        if (!done) finishNote(send = false)
        super.onDestroy()
    }
}
