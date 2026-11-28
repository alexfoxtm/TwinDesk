// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos and videos on the computer (Hub.kt): the phone's gallery a page at a time (media.list),
// small pictures for the grid (media.thumb, the ones on screen first), a big one to look at
// (media.view), the files themselves to the computer's Downloads (media.save, as Send), and
// removing them (media.delete: right away with All files access, else Android's confirmation,
// tapped from a notification here).
// Nothing runs on its own: it answers what the computer asks while its page is open.
package com.twindesk.android

import android.content.ContentUris
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.MediaStore.Files.FileColumns as F
import android.provider.MediaStore.MediaColumns as C
import android.util.Base64
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class Media(private val hub: Hub, private val core: Core, internal val route: Link.TrustedRoute? = null) {
    private val cr = core.ctx.contentResolver
    private val main = Handler(Looper.getMainLooper())
    private val want = ArrayDeque<String>() // pictures still to send, the computer's order
    private val pendingTrash = LinkedHashMap<String, Uri>() // awaiting on-phone MediaStore Trash consent
    private var trashObserver: ContentObserver? = null
    private var pumping = false
    @Volatile private var stopped = false
    private val reconcileRun = Runnable { if (!stopped) hub.run { reconcilePendingTrash() } }

    fun stop() {
        stopped = true
        synchronized(want) { want.clear() }
        stopTrashWatch(clearPending = true)
        Notify.cancelMediaTrash(core.ctx)
    }

    // One page of the gallery, newest first. `before` is where the last page ended ("<date>:<id>").
    fun list(m: JSONObject): JSONObject {
        val kind = m.str("kind", 20)
        val n = m.optInt("n", 120).coerceIn(1, 500)
        val before = m.str("before", 40)
        val sel = StringBuilder(
            when (kind) {
                "photos" -> "${F.MEDIA_TYPE} = ${F.MEDIA_TYPE_IMAGE}"
                "videos" -> "${F.MEDIA_TYPE} = ${F.MEDIA_TYPE_VIDEO}"
                "screenshots" -> "${F.MEDIA_TYPE} = ${F.MEDIA_TYPE_IMAGE} AND (${C.RELATIVE_PATH} LIKE '%Screenshots%' OR ${C.BUCKET_DISPLAY_NAME} = 'Screenshots')"
                else -> "${F.MEDIA_TYPE} IN (${F.MEDIA_TYPE_IMAGE}, ${F.MEDIA_TYPE_VIDEO})"
            },
        )
        val args = ArrayList<String>()
        // One album's (Photos' albums, media.albums): its bucket.
        val album = m.str("album", 24).takeIf { Regex("^-?\\d{1,20}$").matches(it) }
        if (album != null) {
            sel.append(" AND ${C.BUCKET_ID} = ?")
            args += album
        }
        val (bd, bi) = before.split(':').let { (it.getOrNull(0)?.toLongOrNull() ?: 0L) to (it.getOrNull(1)?.toLongOrNull() ?: 0L) }
        if (bd > 0) {
            sel.append(" AND (${C.DATE_ADDED} < ? OR (${C.DATE_ADDED} = ? AND ${BaseColumns._ID} < ?))")
            args += listOf(bd.toString(), bd.toString(), bi.toString())
        }
        if (Build.VERSION.SDK_INT >= 30) {
            sel.append(" AND (${C.IS_TRASHED} = 0 OR ${C.IS_TRASHED} IS NULL)")
        }
        val items = JSONArray()
        var last = ""
        var more = false
        val cols = if (Build.VERSION.SDK_INT >= 30) {
            arrayOf(BaseColumns._ID, F.MEDIA_TYPE, C.DATE_ADDED, C.DATE_TAKEN, C.WIDTH, C.HEIGHT, C.SIZE, C.DISPLAY_NAME, C.DURATION, C.BUCKET_DISPLAY_NAME, C.ORIENTATION, C.IS_TRASHED)
        } else {
            arrayOf(BaseColumns._ID, F.MEDIA_TYPE, C.DATE_ADDED, C.DATE_TAKEN, C.WIDTH, C.HEIGHT, C.SIZE, C.DISPLAY_NAME, C.DURATION, C.BUCKET_DISPLAY_NAME, C.ORIENTATION)
        }
        cr.query(
            MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL),
            cols,
            sel.toString(), args.toTypedArray(), "${C.DATE_ADDED} DESC, ${BaseColumns._ID} DESC",
        )?.use { c ->
            while (c.moveToNext()) {
                if (Build.VERSION.SDK_INT >= 30 && c.columnCount > 11 && c.getInt(11) != 0) continue
                if (items.length() >= n) { more = true; break }
                val id = c.getLong(0)
                val video = c.getInt(1) == F.MEDIA_TYPE_VIDEO
                val added = c.getLong(2)
                val taken = c.getLong(3)
                val turned = c.getInt(10) % 180 != 0
                items.put(
                    JSONObject().put("id", (if (video) "v" else "i") + id).put("video", video).put("at", if (taken > 0) taken else added * 1000)
                        .put("w", if (turned) c.getInt(5) else c.getInt(4)).put("h", if (turned) c.getInt(4) else c.getInt(5))
                        .put("size", c.getLong(6)).put("name", c.getString(7) ?: "").put("dur", c.getLong(8)).put("album", c.getString(9) ?: ""),
                )
                last = "$added:$id"
            }
        }
        return msg(Proto.T.MEDIA_LIST, "kind" to kind, "before" to before, "items" to items, "more" to more, "next" to last).apply { if (album != null) put("album", album) }
    }

    // The albums (Camera, Screenshots, WhatsApp Images…): each one's name, how many and its newest
    // as the cover, the biggest first.
    fun albums(): JSONObject {
        data class A(val id: String, var name: String, var n: Int, val cover: String)
        val by = LinkedHashMap<String, A>()
        val where = "${F.MEDIA_TYPE} IN (${F.MEDIA_TYPE_IMAGE}, ${F.MEDIA_TYPE_VIDEO})" +
            if (Build.VERSION.SDK_INT >= 30) " AND (${C.IS_TRASHED} = 0 OR ${C.IS_TRASHED} IS NULL)" else ""
        val cols = if (Build.VERSION.SDK_INT >= 30) {
            arrayOf(BaseColumns._ID, F.MEDIA_TYPE, C.BUCKET_ID, C.BUCKET_DISPLAY_NAME, C.IS_TRASHED)
        } else {
            arrayOf(BaseColumns._ID, F.MEDIA_TYPE, C.BUCKET_ID, C.BUCKET_DISPLAY_NAME)
        }
        cr.query(
            MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL),
            cols,
            where, null, "${C.DATE_ADDED} DESC, ${BaseColumns._ID} DESC",
        )?.use { c ->
            while (c.moveToNext()) {
                if (Build.VERSION.SDK_INT >= 30 && c.columnCount > 4 && c.getInt(4) != 0) continue
                val b = c.getString(2) ?: continue
                val a = by[b]
                if (a != null) { a.n++; continue }
                val id = (if (c.getInt(1) == F.MEDIA_TYPE_VIDEO) "v" else "i") + c.getLong(0)
                by[b] = A(b, (c.getString(3) ?: "").ifEmpty { "Other" }, 1, id)
            }
        }
        val items = JSONArray()
        for (a in by.values.sortedByDescending { it.n }.take(200)) items.put(JSONObject().put("id", a.id).put("name", a.name.take(100)).put("n", a.n).put("cover", a.cover))
        return msg(Proto.T.MEDIA_ALBUMS, "items" to items)
    }

    private fun uri(id: String): Uri? {
        val n = id.drop(1).toLongOrNull() ?: return null
        return when (id.firstOrNull()) {
            'i' -> ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, n)
            'v' -> ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, n)
            else -> null
        }
    }

    // These next: the ones still waiting from before are dropped (scrolled past).
    fun thumbs(ids: JSONArray?) {
        val list = (0 until (ids?.length() ?: 0)).map { ids!!.optString(it).take(40) }.filter { it.isNotEmpty() }.take(300)
        synchronized(want) {
            want.clear()
            want.addAll(list)
            if (pumping || list.isEmpty()) return
            pumping = true
        }
        hub.run { pump() }
    }

    // One at a time, while the link has little queued: input and the rest never wait behind them.
    private fun pump() {
        try {
            while (!stopped && core.link.connected && !core.link.ble) {
                val id = synchronized(want) { want.removeFirstOrNull() } ?: break
                while (core.link.queued() > 256 * 1024 && !stopped) Thread.sleep(5)
                val data = runCatching { jpeg(cr.loadThumbnail(uri(id)!!, Size(256, 256), null), 72) }.getOrNull()
                core.send(msg(Proto.T.MEDIA_THUMB, "id" to id, "data" to data))
            }
        } finally {
            synchronized(want) { pumping = false; if (want.isNotEmpty() && !stopped) { pumping = true; hub.run { pump() } } }
        }
    }

    // A big picture to look at (a video's frame).
    fun view(id: String): String? = runCatching {
        val u = uri(id)!!
        val b = if (id.startsWith("v")) cr.loadThumbnail(u, Size(1280, 1280), null)
        else ImageDecoder.decodeBitmap(ImageDecoder.createSource(cr, u)) { d, info, _ ->
            val s = info.size
            val k = 1600.0 / maxOf(s.width, s.height)
            if (k < 1) d.setTargetSize((s.width * k).toInt().coerceAtLeast(1), (s.height * k).toInt().coerceAtLeast(1))
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        jpeg(b, 85)
    }.getOrNull()

    // The files themselves, to the computer's Downloads (as Send to computer).
    fun save(ids: JSONArray?) {
        val uris = (0 until (ids?.length() ?: 0)).mapNotNull { uri(ids!!.optString(it)) }.take(500)
        if (uris.isNotEmpty()) core.files.send(core.files.describe(uris), "send")
    }

    fun savePhotoAs(id: String, batch: String, source: okhttp3.WebSocket, grant: Any): Boolean {
        val u = uri(id) ?: return false
        val item = core.files.describe(listOf(u)).singleOrNull() ?: return false
        if (item.size <= 0 || item.size > Proto.FILE_MAX_BYTES) return false
        return core.files.send(listOf(item), "photo-save-as", batch, photoSocket = source, photoGrant = grant)
    }

    // Remove or move to Trash from the phone. Answers media.delete {ids: the ones gone, failed,
    // confirm: how many wait for on-phone consent, action?: "trash"}.
    fun delete(m: JSONObject, route: Link.TrustedRoute?): JSONObject {
        val ids = m.optJSONArray("ids")
        if (m.has("action")) {
            val action = m.opt("action") as? String
            if (action == "trash") return trash(ids, route)
            val count = (ids?.length() ?: 0).coerceIn(1, MAX_IDS)
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to count, "confirm" to 0)
        }
        if (hub.perm("media") !in listOf("ok", "partial")) {
            val count = (ids?.length() ?: 0).coerceIn(0, MAX_IDS)
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to count, "confirm" to 0)
        }
        return delete(ids)
    }

    fun delete(ids: JSONArray?): JSONObject {
        val asked = (0 until (ids?.length() ?: 0)).map { ids!!.optString(it).take(40) }.filter { uri(it) != null }.distinct().take(MAX_IDS)
        val gone = JSONArray()
        val left = ArrayList<Pair<String, Uri>>()
        val direct = Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
        for (id in asked) {
            val u = uri(id)!!
            val ok = direct && runCatching { cr.delete(u, null, null) > 0 }.getOrDefault(false)
            if (ok) gone.put(id) else left += id to u
        }
        var confirm = 0
        if (left.isNotEmpty() && Build.VERSION.SDK_INT >= 30) {
            runCatching {
                val pi = MediaStore.createDeleteRequest(cr, left.map { it.second })
                Notify.mediaDelete(core.ctx, core.host?.name ?: tr("Your computer"), left.size, pi)
                confirm = left.size
            }
        }
        return msg(Proto.T.MEDIA_DELETE, "ids" to gone, "failed" to left.size - confirm, "confirm" to confirm)
    }

    // Reversible Trash on Android 11+ via MediaStore.createTrashRequest: bound to existing media
    // permission, validated max 300 IDs, never falls back to direct/permanent delete even with All
    // files access or when the system request fails.
    private fun trash(ids: JSONArray?, route: Link.TrustedRoute?): JSONObject {
        val rawCount = ids?.length() ?: 0
        if (hub.perm("media") !in listOf("ok", "partial") || rawCount <= 0 || rawCount > MAX_IDS || Build.VERSION.SDK_INT < 30) {
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to rawCount.coerceAtLeast(0), "confirm" to 0, "action" to "trash")
        }
        val valid = LinkedHashMap<String, Uri>()
        var invalid = 0
        for (i in 0 until rawCount) {
            val id = ids?.opt(i) as? String
            val u = if (id != null && MEDIA_ID.matches(id)) uri(id) else null
            if (id != null && u != null) valid[id] = u else invalid++
        }
        if (valid.isEmpty()) {
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to rawCount, "confirm" to 0, "action" to "trash")
        }
        val pi = runCatching { MediaStore.createTrashRequest(cr, valid.values.toList(), true) }.getOrNull()
        if (pi == null) {
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to valid.size + invalid, "confirm" to 0, "action" to "trash")
        }
        if (!hub.mediaCurrent(this, route)) {
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to valid.size + invalid, "confirm" to 0, "action" to "trash")
        }
        trackPendingTrash(valid)
        Notify.mediaTrash(core.ctx, core.host?.name ?: tr("Your computer"), valid.size, pi)
        if (stopped || !hub.mediaCurrent(this, route) || hub.perm("media") !in listOf("ok", "partial")) {
            stopTrashWatch(clearPending = true)
            Notify.cancelMediaTrash(core.ctx)
            return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to rawCount, "confirm" to 0, "action" to "trash")
        }
        return msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(), "failed" to invalid, "confirm" to valid.size, "action" to "trash")
    }

    private fun trackPendingTrash(entries: Map<String, Uri>) {
        synchronized(pendingTrash) {
            for ((id, u) in entries) pendingTrash[id] = u
            while (pendingTrash.size > MAX_IDS) {
                val oldest = pendingTrash.keys.firstOrNull() ?: break
                pendingTrash.remove(oldest)
            }
            if (stopped || trashObserver != null || pendingTrash.isEmpty()) return
            val o = object : ContentObserver(main) {
                override fun onChange(selfChange: Boolean, uri: Uri?) {
                    if (stopped) return
                    main.removeCallbacks(reconcileRun)
                    main.postDelayed(reconcileRun, RECONCILE_MS)
                }
            }
            val registered = runCatching {
                cr.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, o)
                cr.registerContentObserver(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true, o)
                true
            }.getOrDefault(false)
            if (registered) trashObserver = o else runCatching { cr.unregisterContentObserver(o) }
        }
    }

    private fun stopTrashWatch(clearPending: Boolean) {
        main.removeCallbacks(reconcileRun)
        synchronized(pendingTrash) {
            if (clearPending) pendingTrash.clear()
            trashObserver?.let { o -> runCatching { cr.unregisterContentObserver(o) } }
            trashObserver = null
        }
    }

    internal fun reconcilePendingTrash() {
        if (stopped || !hub.mediaCurrent(this, route) || hub.perm("media") !in listOf("ok", "partial")) {
            stopTrashWatch(clearPending = true)
            Notify.cancelMediaTrash(core.ctx)
            return
        }
        val snapshot = synchronized(pendingTrash) { pendingTrash.entries.map { it.key to it.value } }
        if (snapshot.isEmpty()) {
            stopTrashWatch(clearPending = false)
            return
        }
        val confirmed = ArrayList<String>()
        val cols = if (Build.VERSION.SDK_INT >= 30) arrayOf(BaseColumns._ID, C.IS_TRASHED) else arrayOf(BaseColumns._ID)
        for ((id, u) in snapshot) {
            val gone = runCatching {
                cr.query(u, cols, null, null, null)?.use { c ->
                    !c.moveToFirst() || (Build.VERSION.SDK_INT >= 30 && c.columnCount > 1 && c.getInt(1) != 0)
                } ?: false
            }.getOrDefault(false)
            if (gone) confirmed += id
        }
        if (confirmed.isEmpty()) return
        val remaining = synchronized(pendingTrash) {
            for (id in confirmed) pendingTrash.remove(id)
            pendingTrash.size
        }
        if (remaining == 0) {
            stopTrashWatch(clearPending = false)
            Notify.cancelMediaTrash(core.ctx)
        }
        if (!stopped && hub.mediaCurrent(this, route)) {
            core.link.sendFor(route, msg(Proto.T.MEDIA_DELETE, "ids" to jsonArray(confirmed), "failed" to 0, "confirm" to 0, "action" to "trash"))
        }
    }

    companion object {
        private const val MAX_IDS = 300
        private const val RECONCILE_MS = 250L
        private val MEDIA_ID = Regex("^[iv][0-9]{1,18}$")
    }

    private fun jpeg(b: Bitmap, q: Int): String {
        val out = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.JPEG, q, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
