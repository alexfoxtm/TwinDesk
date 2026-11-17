// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// New camera photos to a paired Mac (shared/photobackup.js). One finished DCIM/Camera image at a
// time, only after this phone and that Mac have each turned it on, and only the original file
// (location included). No ACCESS_MEDIA_LOCATION, or only selected photos: nothing is sent.
// Bytes are backup.chunk on this session socket, not a Save and not fx. A generation change for
// an id the cursor has already passed waits until the cursor is reset.
package com.twindesk.android

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.MediaStore.Files.FileColumns
import android.provider.MediaStore.MediaColumns
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.concurrent.Executors

class PhotoBackup(core: Core) : Feature(core) {
    private val cr = core.ctx.contentResolver
    private val jobs = Executors.newSingleThreadExecutor { r -> Thread(r, "td-pb").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val files = File(core.ctx.filesDir, "pb-settled.json")

    @Volatile private var epoch = 0
    @Volatile private var scanStamp = 0
    @Volatile private var marker: Any? = null
    @Volatile private var flightReq = ""
    @Volatile private var remoteOn = false
    @Volatile private var remoteSince = 0L
    @Volatile private var remoteMrev = 0
    @Volatile private var heard = false
    private var permSnap: String? = null

    private val dead = ArrayDeque<String>()
    private var seenStamp = 0
    private var scan: Scan? = null
    private var offered: MutableList<Row> = mutableListOf()
    private var hole = false
    private var cursor = 0L
    private var observer: ContentObserver? = null

    private class Row(
        val id: Long, val vol: String, val ver: String, val item: String, val gen: Long,
        val size: Int, val name: String, val taken: Long, val added: Long,
        var skip: String?, var done: Boolean,
    )

    private class Scan(val token: String, val rows: MutableList<Row>, val remain: Boolean, var pos: Int)

    fun on(): Boolean {
        val id = macId()
        return id.isNotEmpty() && core.store.flag(onKey(id), false)
    }

    fun canToggle(): Boolean {
        val h = core.host
        return core.link.connected && h != null && h.os == "mac" && Build.VERSION.SDK_INT >= 30 && core.hub.perm("media") == "ok"
    }

    fun needsLocationPrompt(): Boolean = canToggle() && !locGranted()

    fun hint(name: String): String {
        if (Build.VERSION.SDK_INT < 30) return tr("Needs Android 11 or later.")
        if (core.link.connected && core.host?.os == "mac" && !core.link.peerBackup) {
            return tr("Update TwinDesk on {name} to back up camera photos.", "name" to name)
        }
        if (!on()) {
            val perm = if (core.link.connected && core.host?.os == "mac") core.hub.perm("media") else "ok"
            if (perm == "partial" || perm == "ask") return tr("Allow all photos on the phone. Selected photos can’t be backed up.")
            return longHint(name)
        }
        return when (blocked()) {
            "api" -> tr("Needs Android 11 or later.")
            "partial", "media" -> tr("Allow all photos on the phone. Selected photos can’t be backed up.")
            "location" -> tr("Allow photo locations on the phone. Backup copies that location with the photo.")
            "transport" -> tr("Connect over Wi-Fi or a cable.")
            "consent" -> tr("Turn backup on on {name} and choose a folder.", "name" to name)
            "peer" -> tr("Update TwinDesk on {name} to back up camera photos.", "name" to name)
            else -> longHint(name)
        }
    }

    fun onLocationResult(granted: Boolean) {
        if (granted && canToggle() && locGranted()) setOn(true) else core.changed()
    }

    fun setOn(on: Boolean) {
        val id = macId()
        if (id.isEmpty() || !canToggle() && on) return
        if (on() == on) return
        core.store.setFlag(onKey(id), on)
        core.store.setPrefsString(revKey(id), (revOf(id) + 1).toString())
        if (on) core.store.setPrefsString(sinceKey(id), System.currentTimeMillis().toString())
        resetCursor()
        invalidate(true)
        sendState()
        core.changed()
    }

    // Permission changed in Settings. Consent stays: clearing it would move the cutoff forward.
    // The first look only records what is granted, so opening the app does not drop a copy.
    fun permsChanged() {
        if (!core.moduleOn("photos")) return
        val snap = core.hub.perm("media") + ":" + locGranted()
        if (permSnap == snap) return
        val first = permSnap == null
        permSnap = snap
        if (first) return
        invalidate(true)
        if (core.link.connected && core.host?.os == "mac") sendState()
        core.changed()
    }

    fun forget(id: String) {
        if (!token(id)) return
        core.store.setFlag(onKey(id), false)
        core.store.setPrefsString(revKey(id), (revOf(id) + 1).toString())
        if (macId() == id || cursorMac() == id) resetCursor()
        invalidate(false)
        core.changed()
    }

    // The session socket was replaced (Wi-Fi, cable, Bluetooth). The old request is dead.
    fun linkChanged() {
        if (!core.moduleOn("photos")) return
        val now = core.link.sessionMarker()
        val next = if (now != null && core.link.lockSessionCurrent(now)) now else null
        if (next === marker) return
        invalidate(false)
        marker = next
        if (next != null && heard) sendState()
    }

    override fun onWelcome(host: Host) {
        if (host.os != "mac" || !core.moduleOn("photos")) return
        invalidate(false)
        marker = core.link.sessionMarker()
        heard = false
        remoteOn = false
        remoteSince = 0L
        remoteMrev = 0
        watch()
        sendState()
    }

    override fun onClosed() {
        invalidate(false)
        marker = null
        heard = false
        unwatch()
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (!t.startsWith("backup.")) return false
        val copy = JSONObject(m.toString())
        jobs.execute {
            runCatching {
                dropped()
                when (t) {
                    Proto.T.BACKUP_STATE -> onMacState(copy)
                    Proto.T.BACKUP_SYNC -> onSync(copy)
                    Proto.T.BACKUP_TAKE -> onTake(copy)
                    Proto.T.BACKUP_HAVE -> onHave(copy)
                    Proto.T.BACKUP_DONE -> onDone(copy)
                    Proto.T.BACKUP_REFUSE -> onMacRefuse(copy)
                    Proto.T.BACKUP_STOP -> invalidate(false)
                }
            }.onFailure { Log.w("TwinDesk", "photo backup: ${it.javaClass.simpleName}") }
        }
        return true
    }

    private fun onMacState(m: JSONObject) {
        if (m.has("perm") || m.has("api") || m.opt("on") !is Boolean) return
        val since = m.optLong("since", -1L)
        if (!m.has("mrev") || since < 0L) return
        val mrev = m.optInt("mrev", -1)
        if (mrev < 0) return
        val on = m.getBoolean("on")
        val mrevChanged = heard && remoteMrev != mrev
        val changed = heard && (mrevChanged || remoteOn != on || remoteSince != since)
        remoteOn = on
        remoteSince = since
        remoteMrev = mrev
        heard = true
        if (mrevChanged) resetCursor()
        if (changed) invalidate(true)
        loadCursor()
        sendState()
        core.changed()
    }

    private fun onSync(m: JSONObject) {
        val req = m.optString("req")
        if (!token(req)) return
        val id = macId()
        if (id.isEmpty() || !live(epoch)) { refuse(req, "stop"); return }
        if (m.optInt("rev", -1) != revOf(id) || m.optInt("mrev", -1) != remoteMrev) { refuse(req, "stop"); return }
        val why = blocked()
        if (why.isNotEmpty()) { refuse(req, why); return }
        if (flightReq.isNotEmpty()) { refuse(req, "stop"); return }
        if (hole) { hole = false; scan = null; offered = mutableListOf() }
        val page = nextPage()
        if (page == null) { query(req); return }
        sendPage(req, page)
    }

    private fun onTake(m: JSONObject) {
        val req = m.optString("req")
        if (!token(req) || isDead(req)) { if (token(req)) refuse(req, "stop"); return }
        val row = match(m) ?: run { refuse(req, "stop"); return }
        if (!live(epoch)) return
        val why = blocked()
        if (why.isNotEmpty()) { refuse(req, why); return }
        flightReq = req
        rememberDead(req)
        val ep = epoch
        val mark = marker
        sendOne(m, row, ep, mark)
    }

    private fun onHave(m: JSONObject) { settle(m, true) }
    private fun onDone(m: JSONObject) { settle(m, true); if (m.optString("req") == flightReq) flightReq = "" }
    private fun onMacRefuse(m: JSONObject) {
        val why = m.optString("why")
        val terminal = why == "date" || why == "gone" || why == "version" || why == "bad"
        settle(m, terminal)
        if (m.optString("req") == flightReq) flightReq = ""
        if (!terminal) hole = true
    }

    private fun sendOne(m: JSONObject, row: Row, ep: Int, mark: Any?) {
        val fresh = requery(row)
        if (!live(ep, mark)) return
        if (fresh == null) { settleRow(row, true); refuseEcho(m, "gone"); flightReq = ""; return }
        if (fresh != "ok") { settleRow(row, true); refuseEcho(m, "version"); flightReq = ""; return }
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.getContentUri(row.vol), row.id)
        val stream = try {
            if (Build.VERSION.SDK_INT < 30) { refuseEcho(m, "api"); flightReq = ""; return }
            cr.openInputStream(MediaStore.setRequireOriginal(uri))
        } catch (_: SecurityException) {
            hole = true
            refuseEcho(m, "permission")
            flightReq = ""
            return
        }
        if (stream == null) { settleRow(row, true); refuseEcho(m, "gone"); flightReq = ""; return }
        if (!sendEcho(Proto.T.BACKUP_ACCEPT, m, mark, ep, "size" to row.size)) { flightReq = ""; stream.close(); return }
        stream.use { input ->
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(CHUNK)
            var got = 0
            var seq = 0
            while (true) {
                if (!live(ep, mark)) return
                val n = input.read(buf)
                if (n < 0) break
                if (n == 0) continue
                if (got + n > row.size) { refuseEcho(m, "checksum"); flightReq = ""; return }
                md.update(buf, 0, n)
                val data = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                if (!sendEcho(Proto.T.BACKUP_CHUNK, m, mark, ep, "seq" to seq, "data" to data)) { flightReq = ""; return }
                got += n
                seq += 1
            }
            if (got != row.size) { refuseEcho(m, "checksum"); flightReq = ""; return }
            val sha = md.digest().hex()
            if (!sendEcho(Proto.T.BACKUP_END, m, mark, ep, "sha256" to sha, "size" to row.size)) flightReq = ""
        }
    }

    private fun requery(row: Row): String? {
        if (Build.VERSION.SDK_INT < 30) return "version"
        val cols = arrayOf(BaseColumns._ID, MediaColumns.SIZE, MediaColumns.RELATIVE_PATH, MediaColumns.VOLUME_NAME, MediaColumns.GENERATION_MODIFIED, MediaColumns.IS_TRASHED, MediaColumns.IS_PENDING)
        val sel = "${BaseColumns._ID}=? AND ${FileColumns.MEDIA_TYPE}=${FileColumns.MEDIA_TYPE_IMAGE} AND ${MediaColumns.IS_PENDING}=0 AND ${MediaColumns.IS_TRASHED}=0 AND ${MediaColumns.RELATIVE_PATH} LIKE ?"
        val found = cr.query(MediaStore.Files.getContentUri(row.vol), cols, sel, arrayOf(row.id.toString(), CAMERA), null)?.use { c ->
            if (!c.moveToFirst()) return@use false
            val gen = c.getLong(c.getColumnIndexOrThrow(MediaColumns.GENERATION_MODIFIED))
            val size = c.getLong(c.getColumnIndexOrThrow(MediaColumns.SIZE))
            val vol = c.getString(c.getColumnIndexOrThrow(MediaColumns.VOLUME_NAME)) ?: ""
            val ver = runCatching { MediaStore.getVersion(core.ctx, vol) }.getOrNull() ?: ""
            gen == row.gen && size == row.size.toLong() && vol == row.vol && ver == row.ver
        }
        return when (found) { null, false -> if (found == null) null else "version"; else -> "ok" }
    }

    private fun query(syncReq: String) {
        if (Build.VERSION.SDK_INT < 30) { refuse(syncReq, "api"); return }
        val id = macId()
        loadCursor()
        val sinceSec = maxOf(sinceOf(id), remoteSince) / 1000L
        val sel = "${FileColumns.MEDIA_TYPE}=${FileColumns.MEDIA_TYPE_IMAGE} AND ${MediaColumns.IS_PENDING}=0 AND ${MediaColumns.IS_TRASHED}=0 AND ${MediaColumns.RELATIVE_PATH} LIKE ? AND ${MediaColumns.DATE_ADDED}>=? AND ${BaseColumns._ID}>?"
        val args = arrayOf(CAMERA, sinceSec.toString(), cursor.toString())
        val cols = arrayOf(BaseColumns._ID, MediaColumns.DISPLAY_NAME, MediaColumns.SIZE, MediaColumns.DATE_TAKEN, MediaColumns.DATE_ADDED, MediaColumns.VOLUME_NAME, MediaColumns.GENERATION_MODIFIED)
        val bundle = Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, sel)
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${BaseColumns._ID} ASC")
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, WALK)
        }
        val rows = mutableListOf<Row>()
        try {
            cr.query(MediaStore.Files.getContentUri("external"), cols, bundle, null)?.use { c ->
                val iId = c.getColumnIndexOrThrow(BaseColumns._ID)
                val iName = c.getColumnIndexOrThrow(MediaColumns.DISPLAY_NAME)
                val iSize = c.getColumnIndexOrThrow(MediaColumns.SIZE)
                val iTaken = c.getColumnIndexOrThrow(MediaColumns.DATE_TAKEN)
                val iAdded = c.getColumnIndexOrThrow(MediaColumns.DATE_ADDED)
                val iVol = c.getColumnIndexOrThrow(MediaColumns.VOLUME_NAME)
                val iGen = c.getColumnIndexOrThrow(MediaColumns.GENERATION_MODIFIED)
                while (c.moveToNext() && rows.size < WALK) {
                    val mediaId = c.getLong(iId)
                    if (mediaId <= 0L) continue
                    val vol = c.getString(iVol) ?: ""
                    val ver = runCatching { MediaStore.getVersion(core.ctx, vol) }.getOrNull() ?: ""
                    val gen = if (c.isNull(iGen)) -1L else c.getLong(iGen)
                    val size = if (c.isNull(iSize)) -1L else c.getLong(iSize)
                    val name = safeName(if (c.isNull(iName)) "" else c.getString(iName) ?: "")
                    val taken = if (c.isNull(iTaken)) 0L else c.getLong(iTaken)
                    val addedSec = if (c.isNull(iAdded)) -1L else c.getLong(iAdded)
                    val item = itemKey(vol, ver, mediaId)
                    val skip = when {
                        item.isEmpty() || gen < 0L || addedSec < 0L -> "bad"
                        size <= 0L || size > MAX_BYTES || name.isEmpty() -> "bad"
                        else -> null
                    }
                    rows.add(Row(mediaId, vol, ver, item, gen, if (skip == null) size.toInt() else 0, name, taken, addedSec * 1000L, skip, false))
                }
            }
        } catch (_: SecurityException) {
            refuse(syncReq, "permission"); return
        }
        hole = false
        scan = Scan(Proto.randomHex(8), rows, rows.size >= WALK, 0)
        drain()
        sendPage(syncReq, nextPage() ?: Page(emptyList(), false, false))
    }

    private class Page(val rows: List<Row>, val more: Boolean, val remain: Boolean)

    private fun nextPage(): Page? {
        val s = scan ?: return null
        drain()
        val out = mutableListOf<Row>()
        var i = s.pos
        while (i < s.rows.size && out.size < PAGE) {
            val row = s.rows[i++]
            if (row.skip == null && !row.done) out.add(row)
        }
        val more = (i until s.rows.size).any { s.rows[it].skip == null && !s.rows[it].done }
        if (out.isEmpty() && !more && s.remain) { scan = null; return null }
        return Page(out, more, !more && s.remain)
    }

    private fun sendPage(syncReq: String, page: Page) {
        if (!live(epoch)) return
        val id = macId()
        offered = page.rows.toMutableList()
        val items = JSONArray()
        for (row in page.rows) {
            items.put(JSONObject().put("item", row.item).put("gen", row.gen).put("size", row.size).put("name", row.name).put("taken", row.taken).put("added", row.added))
        }
        val s = scan
        send(msg(Proto.T.BACKUP_INV,
            "req" to Proto.randomHex(8), "sync" to syncReq, "rev" to revOf(id), "mrev" to remoteMrev,
            "scan" to (s?.token ?: Proto.randomHex(8)), "page" to 0, "more" to page.more, "remain" to page.remain, "items" to items,
        ))
        if (!page.more && !page.remain) scan = null
    }

    private fun settle(m: JSONObject, terminal: Boolean) {
        val item = m.optString("item")
        val gen = longGen(m.opt("gen")) ?: return
        val row = offered.firstOrNull { !it.done && it.item == item && it.gen == gen } ?: return
        if (!terminal) { hole = true; return }
        settleRow(row, true)
    }

    private fun settleRow(row: Row, terminal: Boolean) {
        if (!terminal) { hole = true; return }
        row.done = true
        drain()
    }

    private fun drain() {
        if (hole) return
        val s = scan ?: return
        var moved = false
        while (s.pos < s.rows.size && (s.rows[s.pos].done || s.rows[s.pos].skip != null)) {
            cursor = s.rows[s.pos].id
            s.pos++
            moved = true
        }
        if (moved) saveCursor()
    }

    private fun match(m: JSONObject): Row? {
        if (!token(m.optString("req")) || !token(m.optString("batch")) || !token(m.optString("scan")) || !token(m.optString("inv"))) return null
        val id = macId()
        if (m.optInt("rev", -1) != revOf(id) || m.optInt("mrev", -1) != remoteMrev) return null
        val gen = longGen(m.opt("gen")) ?: return null
        if (m.optInt("size", -1) <= 0) return null
        return offered.firstOrNull { !it.done && it.item == m.optString("item") && it.gen == gen && it.size == m.optInt("size") }
    }

    private fun longGen(v: Any?): Long? = when (v) {
        is Number -> v.toLong()
        is String -> v.toLongOrNull()
        else -> null
    }

    private fun refuseEcho(take: JSONObject, why: String) {
        send(echo(Proto.T.BACKUP_REFUSE, take, "why" to why))
    }

    private fun sendEcho(t: String, take: JSONObject, mark: Any?, ep: Int, vararg extra: Pair<String, Any?>): Boolean {
        if (!live(ep, mark)) return false
        return core.link.sendFor(mark, echo(t, take, *extra))
    }

    private fun echo(t: String, take: JSONObject, vararg extra: Pair<String, Any?>): JSONObject {
        val o = msg(t,
            "req" to take.optString("req"), "batch" to take.optString("batch"), "item" to take.optString("item"),
            "gen" to take.optLong("gen"), "rev" to take.optInt("rev"), "mrev" to take.optInt("mrev"),
            "scan" to take.optString("scan"), "inv" to take.optString("inv"),
        )
        for ((k, v) in extra) o.put(k, v)
        return o
    }

    private fun refuse(req: String, why: String) {
        val id = macId()
        send(msg(Proto.T.BACKUP_REFUSE, "req" to req, "why" to why, "rev" to revOf(id), "mrev" to remoteMrev))
    }

    private fun sendState() {
        val mark = marker ?: return
        val id = macId()
        if (id.isEmpty() || !core.link.lockSessionCurrent(mark)) return
        core.link.sendFor(mark, msg(Proto.T.BACKUP_STATE,
            "on" to core.store.flag(onKey(id), false), "since" to sinceOf(id), "rev" to revOf(id),
            "perm" to core.hub.perm("media"), "loc" to locGranted(), "api" to Build.VERSION.SDK_INT,
        ))
    }

    private fun send(m: JSONObject) {
        val mark = marker ?: return
        if (!core.link.lockSessionCurrent(mark)) return
        core.link.sendFor(mark, m)
    }

    private fun blocked(): String {
        if (!core.link.peerBackup) return "peer"
        if (core.link.ble || !core.link.lockSessionCurrent(marker)) return "transport"
        if (Build.VERSION.SDK_INT < 30) return "api"
        val perm = core.hub.perm("media")
        if (perm != "ok") return if (perm == "partial") "partial" else "media"
        if (!locGranted()) return "location"
        val id = macId()
        if (id.isEmpty() || !core.store.flag(onKey(id), false) || !remoteOn || sinceOf(id) <= 0L || remoteSince <= 0L) return "consent"
        return ""
    }

    private fun invalidate(sendStop: Boolean) {
        epoch++
        scanStamp++
        val req = flightReq
        flightReq = ""
        if (req.isNotEmpty()) rememberDead(req)
        if (sendStop && req.isNotEmpty()) {
            val mark = marker
            if (mark != null) core.link.sendFor(mark, msg(Proto.T.BACKUP_STOP, "req" to req))
        }
    }

    private fun dropped() {
        if (seenStamp == scanStamp) return
        seenStamp = scanStamp
        scan = null
        offered = mutableListOf()
        hole = false
    }

    private fun live(ep: Int, mark: Any? = marker): Boolean = ep == epoch && mark != null && core.link.lockSessionCurrent(mark)

    private fun watch() {
        if (observer != null || Build.VERSION.SDK_INT < 30) return
        val o = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                main.removeCallbacks(nudge)
                main.postDelayed(nudge, 700L)
            }
        }
        runCatching {
            cr.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, o)
            observer = o
        }.onFailure { runCatching { cr.unregisterContentObserver(o) } }
    }

    private fun unwatch() {
        observer?.let { o -> runCatching { cr.unregisterContentObserver(o) } }
        observer = null
        main.removeCallbacks(nudge)
    }

    private val nudge = Runnable {
        jobs.execute {
            if (flightReq.isEmpty() && core.link.lockSessionCurrent(marker)) sendState()
        }
    }

    private fun resetCursor() {
        cursor = 0L
        hole = false
        scanStamp++
        runCatching { files.delete() }
    }

    private fun loadCursor() {
        val id = macId()
        val o = runCatching { JSONObject(files.readText()) }.getOrNull()
        cursor = if (o != null && o.optString("mac") == id && o.optInt("rev") == revOf(id) && o.optInt("mrev") == remoteMrev) o.optLong("cursor").coerceAtLeast(0L) else 0L
    }

    private fun saveCursor() {
        val id = macId()
        if (id.isEmpty()) return
        val text = JSONObject().put("mac", id).put("rev", revOf(id)).put("mrev", remoteMrev).put("cursor", cursor).toString()
        val tmp = File(files.parentFile, files.name + ".tmp")
        runCatching {
            tmp.writeText(text)
            if (!tmp.renameTo(files)) { files.writeText(text); tmp.delete() }
        }
    }

    private fun cursorMac(): String = runCatching { JSONObject(files.readText()).optString("mac") }.getOrDefault("")

    private fun macId(): String {
        val h = core.host ?: return ""
        return if (core.link.connected && h.os == "mac" && token(h.id)) h.id else ""
    }

    private fun locGranted() = core.ctx.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED
    private fun sinceOf(id: String) = core.store.prefsString(sinceKey(id), "0").toLongOrNull()?.coerceAtLeast(0L) ?: 0L
    private fun revOf(id: String) = core.store.prefsString(revKey(id), "0").toIntOrNull()?.coerceAtLeast(0) ?: 0
    private fun onKey(id: String) = "pb.on.$id"
    private fun sinceKey(id: String) = "pb.since.$id"
    private fun revKey(id: String) = "pb.rev.$id"

    private fun rememberDead(req: String) {
        synchronized(dead) {
            if (req in dead) return
            dead.addLast(req)
            while (dead.size > 64) dead.removeFirst()
        }
    }

    private fun isDead(req: String) = synchronized(dead) { req in dead }

    private fun longHint(name: String) = tr("New camera photos are copied into the folder you choose, by year and month, after you turn this on here and on {name}. The copy includes the photo’s location. Nothing is deleted or replaced.", "name" to name)

    companion object {
        private const val CHUNK = 32 * 1024
        private const val MAX_BYTES = 80L * 1024L * 1024L
        private const val PAGE = 40
        private const val WALK = 400
        private const val CAMERA = "DCIM/Camera/%"
        private const val SEP = "\u001f"

        private fun token(s: String) = s.length in 1..64 && s.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }

        private fun fieldOk(s: String) = s.isNotEmpty() && s.length <= 128 && s.none { it.code <= 0x1f }

        private fun itemKey(vol: String, ver: String, id: Long): String {
            if (id <= 0L || !fieldOk(vol) || !fieldOk(ver)) return ""
            val n = id.toString()
            if (!Regex("^[1-9][0-9]{0,18}$").matches(n)) return ""
            return vol + SEP + ver + SEP + n
        }

        private fun safeName(name: String): String {
            var s = name.replace('\\', '/')
            val slash = s.lastIndexOf('/')
            if (slash >= 0) s = s.substring(slash + 1)
            s = s.replace(Regex("[\\u0000-\\u001f<>:\"|?*]"), "").trim().trimStart('.')
            if (s.isEmpty() || s == "." || s == "..") return ""
            if (s.length > 120) {
                val dot = s.lastIndexOf('.')
                val ext = if (dot >= 0) s.substring(dot).take(12) else ""
                s = s.take((120 - ext.length).coerceAtLeast(1)) + ext
            }
            return if (s == "." || s == "..") "" else s
        }
    }
}
