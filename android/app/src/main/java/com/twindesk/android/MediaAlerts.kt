// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// New camera photos and videos, told to the computer as a count (media.new) for a notification
// there. Made by Hub.kt only while the computer asked for it (hub.policy mediaAlerts: its own
// switch, off until switched on there) with Photos on and its permission allowed; otherwise there
// is no observer, no query and nothing sent.
// It says how many, never which: no picture, name, path, place or time leaves the phone for it, and
// none is logged. What was in the gallery when watching started is never told (the newest id and
// the time then are the line: nothing after a reconnect either). Only the camera's own folder
// counts (DCIM/Camera, on any storage), so screenshots, downloads and what other apps save don't; a
// picture copied or restored into it with an old date doesn't either.
package com.twindesk.android

import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.MediaStore.Files.FileColumns as F
import android.provider.MediaStore.MediaColumns as C
import android.util.Log
import java.util.TreeSet

class MediaAlerts(private val hub: Hub, private val core: Core) {
    private val cr = core.ctx.contentResolver
    private val files = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
    private val main = Handler(Looper.getMainLooper())
    private var observer: ContentObserver? = null
    @Volatile private var stopped = false
    private val session = core.link.sessionMarker()

    // Only on the hub's thread: the newest id when watching started (null until known: nothing is
    // told before), and the ones told since (a photo is written, then finished, then changed again).
    private var mark: Long? = null
    private val told = TreeSet<Long>()
    private val since = System.currentTimeMillis() / 1000 - 1 // added before this: there already, whatever its id

    private val look = Runnable { if (!stopped) hub.run { quietly { tell() } } }

    // Does nothing when already watching (Hub.apply runs again when permissions change).
    @Synchronized
    fun start() {
        if (observer != null || stopped) return
        hub.run { quietly { mark = newest() } } // before any look: both run on the hub's one thread
        val o = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (stopped) return
                main.removeCallbacks(look) // one look once the changes settle (a burst: one count)
                main.postDelayed(look, SETTLE_MS)
            }
        }
        quietly {
            cr.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, o)
            cr.registerContentObserver(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true, o)
            observer = o
        }
        if (observer == null) quietly { cr.unregisterContentObserver(o) } // one of the two failed: none
    }

    @Synchronized
    fun stop() {
        stopped = true
        observer?.let { o -> quietly { cr.unregisterContentObserver(o) } }
        observer = null
        main.removeCallbacks(look)
    }

    // The newest photo or video there is now, wherever it is (ids only go up).
    private fun newest(): Long =
        cr.query(files, arrayOf(BaseColumns._ID), "${F.MEDIA_TYPE} IN (${F.MEDIA_TYPE_IMAGE}, ${F.MEDIA_TYPE_VIDEO})", null, "${BaseColumns._ID} DESC")
            ?.use { c -> if (c.moveToFirst()) c.getLong(0) else 0L } ?: 0L

    // The camera's finished photos and videos since the line that weren't told yet: how many of each.
    // One still being written (a video while it records) isn't there until it's done, and is told then.
    private fun tell() {
        var from = mark ?: return
        if (stopped) return
        // Switched off, the session gone or the permission taken back meanwhile: no query, and the
        // hub stops this and tells the computer what's allowed now (not from its own thread, which
        // it may end).
        if (!hub.alertsLive() || session == null || core.link.sessionMarker() !== session) { main.post { hub.permsChanged() }; return }
        val where = "${F.MEDIA_TYPE} IN (${F.MEDIA_TYPE_IMAGE}, ${F.MEDIA_TYPE_VIDEO}) AND ${BaseColumns._ID} > ? AND ${C.DATE_ADDED} >= ? AND ${C.IS_PENDING} = 0 " +
            "AND ${C.RELATIVE_PATH} LIKE ? AND (${C.DATE_TAKEN} IS NULL OR ${C.DATE_TAKEN} <= 0 OR ${C.DATE_TAKEN} >= ?)"
        val args = arrayOf(from.toString(), since.toString(), CAMERA, (System.currentTimeMillis() - TAKEN_MS).toString())
        var photos = 0
        var videos = 0
        cr.query(files, arrayOf(BaseColumns._ID, F.MEDIA_TYPE), where, args, null)?.use { c ->
            while (c.moveToNext()) {
                if (!told.add(c.getLong(0))) continue
                if (c.getInt(1) == F.MEDIA_TYPE_VIDEO) videos++ else photos++
            }
        }
        // Many told: the line moves up past the oldest of them, so neither the list nor the query grows.
        while (told.size > KEEP) from = maxOf(from, told.pollFirst() ?: break)
        mark = from
        if (photos + videos > 0 && !stopped && hub.alertsLive()) core.link.sendFor(session, msg(Proto.T.MEDIA_NEW, "photos" to photos, "videos" to videos))
    }

    // What went wrong by its kind only: Android's messages can name a file.
    private fun quietly(block: () -> Unit) {
        runCatching(block).onFailure { Log.w("TwinDesk", "media alerts: ${it.javaClass.simpleName}") }
    }

    companion object {
        private const val SETTLE_MS = 700L
        private const val KEEP = 500
        private const val CAMERA = "DCIM/Camera/%"
        // A photo's own date can be off by its time zone (Android reads it as UTC when the camera
        // wrote none), never by more than a day; older than that was taken before and put here now.
        private const val TAKEN_MS = 24 * 3600 * 1000L
    }
}
