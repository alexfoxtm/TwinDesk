// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// New camera photos to a paired Mac (shared/photobackup.js). One finished DCIM/Camera image at a
// time, only after this phone and that Mac have each turned it on, and only the original file
// (location included). No ACCESS_MEDIA_LOCATION, or only selected photos: nothing is sent.
// Bytes are backup.chunk on the same IP socket that accepted the take, not a Save and not fx.
// Page by modification generation and row id on each versioned volume. Publishing a pending
// photo changes its generation even when its row id is older than photos already saved.
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
import java.io.IOException
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.concurrent.Executors

class PhotoBackup(core: Core) : Feature(core) {
    private val cr = core.ctx.contentResolver
    private val jobs = Executors.newSingleThreadExecutor { r -> Thread(r, "td-pb").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val files = File(core.ctx.filesDir, "pb-settled.json")
    private val lock = Any()

    @Volatile private var epoch = 0
    @Volatile private var marker: Any? = null
    @Volatile private var boundMac = ""
    @Volatile private var remoteOn = false
    @Volatile private var remoteSince = 0L
    @Volatile private var remoteMrev = 0
    @Volatile private var heard = false
    private var permSnap: String? = null
    private var scanJob = false

    private val dead = ArrayDeque<String>()
    private var scan: Scan? = null
    private var offered: MutableList<Row> = mutableListOf()
    private var hole = false
    private var flight: Flight? = null
    private var ackReq = ""
    private val vols = PbVolumes()
    private var observer: ContentObserver? = null
    private var armMac = ""
    private var armSocket: Any? = null
    private var armRev = -1
    private var armFp = ""

    private class Row(
        val id: Long, val vol: String, val ver: String, val item: String, val gen: String,
        val size: Int, val name: String, val taken: Long, val added: Long,
        var skip: String?, var done: Boolean,
    )

    private class Scan(val token: String, val rows: MutableList<Row>, val remain: Boolean, var pos: Int, var inv: String)
    private class Page(val rows: List<Row>, val more: Boolean, val remain: Boolean)
    private class Flight(
        val owner: PbOwner, val epoch: Int, val take: JSONObject, val row: Row,
        val req: String, val inv: String, val scan: String, val batch: String,
        var sha: String = "", var ended: Boolean = false,
    )
    private class Window(val rows: MutableList<Row>, val remain: Boolean)

    /** Socket, Mac and consent revision at the moment Link accepted the frame. */
    internal fun capture(socket: Any): PbOwner {
        val h = core.link.host
        val id = if (core.link.connected && h != null && h.os == "mac" && token(h.id)) h.id else ""
        return PbOwner(
            socket, id,
            if (id.isEmpty()) 0 else revOf(id),
            core.link.peerBackup,
            moduleOn(),
        )
    }

    internal fun copyIn(m: JSONObject): JSONObject {
        val o = JSONObject()
        val keys = m.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val v = m.opt(k)
            if (v != null) o.put(k, v)
        }
        return o
    }

    private fun moduleOn() = core.moduleOn("photos") && "photos" !in Modules.off(core.store)

    fun modulesChanged() {
        synchronized(lock) {
            if (!moduleOn()) revokeLocked(true)
            syncWatchLocked()
        }
        sendState(null, announceOff = !moduleOn())
    }

    fun on(): Boolean {
        val id = macId()
        return id.isNotEmpty() && allowed(id)
    }

    /** The switch may turn on: this Mac negotiated pb, on an IP socket, with the Photos module and full photo access. */
    fun canAsk(): Boolean {
        if (!moduleOn() || Build.VERSION.SDK_INT < 30) return false
        if (!core.link.peerBackup || core.link.ble || !core.link.connected) return false
        val h = core.host ?: return false
        if (h.os != "mac" || !token(h.id)) return false
        if (core.hub.perm("media") != "ok") return false
        return true
    }

    fun canToggle(): Boolean = canAsk()

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

    /**
     * User tapped the switch on. Returns true when the caller must request photo location.
     * The Mac and socket are fixed here; the permission result cannot opt in a different Mac.
     */
    fun enableFromUi(): Boolean {
        if (!canAsk()) return false
        val id = macId()
        val socket = core.link.sessionMarker() ?: return false
        if (!core.link.lockSessionCurrent(socket)) return false
        if (!locGranted()) {
            armMac = id
            armSocket = socket
            armRev = revOf(id)
            armFp = core.host?.fp ?: ""
            return true
        }
        setOn(true, id, socket)
        return false
    }

    fun onLocationResult(granted: Boolean) {
        val id = armMac
        val socket = armSocket
        val rev = armRev
        val fp = armFp
        armMac = ""
        armSocket = null
        armRev = -1
        armFp = ""
        if (!granted || id.isEmpty() || socket == null) {
            core.changed()
            return
        }
        if (macId() != id || core.host?.fp != fp || revOf(id) != rev || core.link.sessionMarker() !== socket || !canAsk()) {
            core.changed()
            return
        }
        setOn(true, id, socket)
    }

    fun setOn(on: Boolean) {
        val id = macId()
        setOn(on, id, if (on) core.link.sessionMarker() else marker)
    }

    // Permission changed in Settings. Consent stays: clearing it would move the cutoff forward.
    // The first look only records what is granted, so opening the app does not drop a copy.
    fun permsChanged() {
        val tell = synchronized(lock) {
            if (!moduleOn()) {
                unwatchLocked()
                return
            }
            val snap = core.hub.perm("media") + ":" + locGranted()
            if (permSnap == snap) return
            val first = permSnap == null
            permSnap = snap
            if (first) return
            revokeLocked(true)
            syncWatchLocked()
            true
        }
        if (tell && admit()) sendState(null)
        core.changed()
    }

    fun forget(id: String) {
        synchronized(lock) {
            if (!token(id)) return
            val liveMac = macId() == id
            core.store.setFlag(onKey(id), false)
            core.store.setPrefsString(revKey(id), (revOf(id) + 1).toString())
            if (liveMac || cursorMac() == id) resetCursorLocked()
            if (liveMac) revokeLocked(true)
            syncWatchLocked()
        }
        core.changed()
    }

    // The session socket was replaced (Wi-Fi, cable, Bluetooth). The old request is dead.
    fun linkChanged() {
        val tell = synchronized(lock) {
            if (!moduleOn()) {
                unwatchLocked()
                return
            }
            val now = core.link.sessionMarker()
            val next = if (now != null && core.link.lockSessionCurrent(now)) now else null
            if (next === marker) {
                syncWatchLocked()
                return
            }
            val id = macId()
            val same = next != null && id.isNotEmpty() && id == boundMac
            revokeLocked(false)
            marker = next
            boundMac = if (next != null) id else ""
            if (!same) {
                heard = false
                remoteOn = false
                remoteSince = 0L
                remoteMrev = 0
            }
            syncWatchLocked()
            same
        }
        if (tell && admit()) sendState(null)
    }

    override fun onWelcome(host: Host) {
        synchronized(lock) {
            if (host.os != "mac" || !moduleOn()) {
                revokeLocked(false)
                marker = null
                boundMac = ""
                heard = false
                unwatchLocked()
                return
            }
            val socket = core.link.sessionMarker()
            permSnap = core.hub.perm("media") + ":" + locGranted()
            revokeLocked(false)
            marker = socket
            boundMac = if (token(host.id)) host.id else ""
            heard = false
            remoteOn = false
            remoteSince = 0L
            remoteMrev = 0
            syncWatchLocked()
        }
        sendState(null)
    }

    override fun onClosed() {
        synchronized(lock) {
            // A close posted for the socket we already left must not wipe the replacement.
            if (marker != null && core.link.lockSessionCurrent(marker)) return
            revokeLocked(false)
            marker = null
            boundMac = ""
            heard = false
            remoteOn = false
            remoteSince = 0L
            remoteMrev = 0
            unwatchLocked()
        }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        // Link hands backup frames to onIngress with the socket. Without that socket, do nothing.
        return t.startsWith("backup.")
    }

    internal fun onIngress(owner: PbOwner, m: JSONObject) {
        val t = m.optString("t")
        if (!t.startsWith("backup.")) return
        if (!owner.module || !moduleOn() || !owner.peer || !core.link.peerBackup) return
        if (owner.socket !== core.link.sessionMarker() || core.link.ble) return
        when (t) {
            Proto.T.BACKUP_STOP -> onStop(owner, m)
            Proto.T.BACKUP_STATE -> onState(owner, m)
            Proto.T.BACKUP_SYNC -> dispatch(owner, m, ::onSync)
            Proto.T.BACKUP_TAKE -> onTake(owner, m)
            Proto.T.BACKUP_HAVE -> onHave(owner, m)
            Proto.T.BACKUP_DONE -> onDone(owner, m)
            Proto.T.BACKUP_REFUSE -> onMacRefuse(owner, m)
        }
    }

    private fun dispatch(owner: PbOwner, m: JSONObject, block: (PbOwner, JSONObject) -> Unit) {
        jobs.execute {
            runCatching { block(owner, m) }.onFailure { Log.w("TwinDesk", "photo backup: ${it.javaClass.simpleName}") }
        }
    }

    private fun onStop(owner: PbOwner, m: JSONObject) {
        synchronized(lock) {
            if (!sameSocket(owner)) return
            val req = m.optString("req")
            if (!token(req)) return
            rememberDead(req)
            // A stop names one request. A duplicate state heartbeat must not come through here,
            // and this must not cancel a flight that already replaced that request.
            if (flight?.req == req) revokeLocked(false)
        }
    }

    private fun onState(owner: PbOwner, m: JSONObject) {
        val tell = synchronized(lock) {
            if (!live(owner)) return
            if (m.has("perm") || m.has("api") || m.opt("on") !is Boolean) return
            val since = longField(m.opt("since")) ?: return
            if (since < 0L || !m.has("mrev")) return
            val mrev = m.optInt("mrev", -1)
            if (mrev < 0) return
            val on = m.getBoolean("on")
            val mrevChanged = heard && remoteMrev != mrev
            val changed = heard && (mrevChanged || remoteOn != on || remoteSince != since)
            remoteOn = on
            remoteSince = since
            remoteMrev = mrev
            heard = true
            if (mrevChanged) resetCursorLocked()
            // Same on/since/mrev again (the Mac's state, delivered twice) is not a new flight's stop.
            if (changed) revokeLocked(true)
            loadCursorLocked()
            syncWatchLocked()
            true
        }
        if (tell) {
            sendState(owner)
            core.changed()
        }
    }

    private fun onSync(owner: PbOwner, m: JSONObject) {
        val req = m.optString("req")
        var queryEp = -1
        synchronized(lock) {
            if (!token(req) || !live(owner)) return
            if (m.optInt("rev", -1) != revOf(owner.macId) || m.optInt("mrev", -1) != remoteMrev) {
                refuse(owner, req, "stop")
                return
            }
            val why = blocked()
            if (why.isNotEmpty()) {
                refuse(owner, req, why)
                return
            }
            if (flight != null || scanJob) {
                refuse(owner, req, "stop")
                return
            }
            if (hole) {
                hole = false
                scan = null
                offered = mutableListOf()
            }
            val page = nextPageLocked()
            if (page != null) {
                sendPageLocked(owner, req, page)
                return
            }
            scanJob = true
            queryEp = epoch
        }
        try {
            query(owner, req, queryEp)
        } finally {
            synchronized(lock) { if (epoch == queryEp) scanJob = false }
        }
    }

    private fun onTake(owner: PbOwner, m: JSONObject) {
        val work = synchronized(lock) {
            val req = m.optString("req")
            if (!token(req) || !live(owner)) return
            if (isDead(req) || flight != null) {
                refuse(owner, req, "stop")
                return
            }
            val row = matchLocked(m) ?: run {
                refuse(owner, req, "stop")
                return
            }
            val why = blocked()
            if (why.isNotEmpty()) {
                refuse(owner, req, why)
                return
            }
            val f = Flight(owner, epoch, m, row, req, m.optString("inv"), m.optString("scan"), m.optString("batch"))
            flight = f
            rememberDead(req)
            f
        }
        jobs.execute {
            runCatching { sendOne(work) }.onFailure {
                Log.w("TwinDesk", "photo backup: ${it.javaClass.simpleName}")
                failPump(work, "read", settle = false)
            }
        }
    }

    private fun onHave(owner: PbOwner, m: JSONObject) {
        synchronized(lock) {
            if (!live(owner) || blocked().isNotEmpty() || !sameRevision(m, owner)) return
            if (!SHA.matches(m.optString("sha256")) || !token(m.optString("req")) || !token(m.optString("batch"))) return
            settle(m, true, fromFlight = false)
        }
    }

    private fun onDone(owner: PbOwner, m: JSONObject) {
        synchronized(lock) {
            val f = flight ?: return
            if (!f.ended || !pumpingLocked(f) || f.owner.socket !== owner.socket || !sameRevision(m, owner)) return
            if (m.optString("req") != f.req || m.optString("inv") != f.inv || m.optString("scan") != f.scan || m.optString("batch") != f.batch) return
            if (m.optString("item") != f.row.item || PbGen.canonical(m.opt("gen")) != f.row.gen) return
            val size = longField(m.opt("size")) ?: return
            val sha = m.optString("sha256")
            if (size != f.row.size.toLong() || !SHA.matches(sha) || sha != f.sha || f.sha.isEmpty()) return
            if (!settle(m, true, fromFlight = true)) return
            flight = null
            clearAckLocked()
        }
    }

    private fun onMacRefuse(owner: PbOwner, m: JSONObject) {
        synchronized(lock) {
            if (!live(owner) || !sameRevision(m, owner)) return
            val why = m.optString("why")
            val terminal = why == "date" || why == "bad"
            val req = m.optString("req")
            if (flight?.req == req && token(req)) {
                if (!terminal) hole = true
                else settle(m, true, fromFlight = true)
                revokeLocked(false)
                return
            }
            if (terminal) settle(m, true, fromFlight = false)
        }
    }

    private fun sendOne(f: Flight) {
        if (!still(f)) return
        val fresh = requery(f.row)
        synchronized(lock) {
            if (!pumpingLocked(f)) return
            when (fresh) {
                null -> {
                    settleRowLocked(f.row, true)
                    refuseEcho(f, "gone")
                    flight = null
                    return
                }
                "permission" -> {
                    hole = true
                    refuseEcho(f, "permission")
                    flight = null
                    return
                }
                "ok" -> Unit
                else -> {
                    settleRowLocked(f.row, true)
                    refuseEcho(f, "version")
                    flight = null
                    return
                }
            }
        }
        if (!still(f)) return
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.getContentUri(f.row.vol), f.row.id)
        val stream = try {
            if (Build.VERSION.SDK_INT < 30) {
                failPump(f, "api", settle = false)
                return
            }
            cr.openInputStream(MediaStore.setRequireOriginal(uri))
        } catch (_: SecurityException) {
            failPump(f, "permission", settle = false)
            return
        }
        if (stream == null) {
            failPump(f, "gone", settle = true)
            return
        }
        stream.use { input ->
            if (!room(f) || !sendEcho(f, Proto.T.BACKUP_ACCEPT, "size" to f.row.size)) {
                failPump(f, "stop", settle = false)
                return
            }
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(CHUNK)
            var got = 0
            var seq = 0
            while (true) {
                if (!room(f)) {
                    failPump(f, "stop", settle = false)
                    return
                }
                val n = try {
                    input.read(buf)
                } catch (_: SecurityException) {
                    failPump(f, "permission", settle = false)
                    return
                }
                if (n < 0) break
                if (n == 0) continue
                if (got + n > f.row.size) {
                    failPump(f, "checksum", settle = false)
                    return
                }
                md.update(buf, 0, n)
                val data = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                if (!sendEcho(f, Proto.T.BACKUP_CHUNK, "seq" to seq, "data" to data)) {
                    failPump(f, "stop", settle = false)
                    return
                }
                got += n
                seq += 1
            }
            if (got != f.row.size) {
                failPump(f, "checksum", settle = false)
                return
            }
            if (!still(f)) return
            if (requery(f.row) != "ok") {
                failPump(f, "version", settle = true)
                return
            }
            val sha = md.digest().hex()
            synchronized(lock) {
                if (!pumpingLocked(f)) return
                f.sha = sha
                f.ended = true
                if (core.link.sendFor(f.owner.socket, echo(Proto.T.BACKUP_END, f.take, f.row.gen, "sha256" to sha, "size" to f.row.size))) {
                    armAckLocked(f)
                } else failPump(f, "stop", settle = false)
            }
        }
    }

    private fun room(f: Flight): Boolean {
        val deadline = System.nanoTime() + Proto.TIMEOUT_MS * 1_000_000L
        while (true) {
            if (!still(f)) return false
            val queued = core.link.queuedFor(f.owner.socket)
            if (queued < 0L) return false
            if (queued <= QUEUE_MAX) return true
            if (System.nanoTime() >= deadline) return false
            try {
                Thread.sleep(20)
            } catch (_: InterruptedException) {
                return false
            }
        }
    }

    private fun still(f: Flight): Boolean = synchronized(lock) { pumpingLocked(f) }

    private fun failPump(f: Flight, why: String, settle: Boolean) {
        synchronized(lock) {
            if (flight !== f) return
            if (!settle) hole = true
            if (settle) settleRowLocked(f.row, true)
            if (why == "stop") {
                val socket = f.owner.socket
                flight = null
                clearAckLocked()
                if (core.link.lockSessionCurrent(socket)) core.link.sendFor(socket, msg(Proto.T.BACKUP_STOP, "req" to f.req))
            } else {
                refuseEcho(f, why)
                flight = null
                clearAckLocked()
            }
        }
    }

    private fun requery(row: Row): String? {
        if (Build.VERSION.SDK_INT < 30) return "version"
        val cols = arrayOf(BaseColumns._ID, MediaColumns.SIZE, MediaColumns.RELATIVE_PATH, MediaColumns.VOLUME_NAME, MediaColumns.GENERATION_MODIFIED, MediaColumns.IS_TRASHED, MediaColumns.IS_PENDING)
        val sel = "${BaseColumns._ID}=? AND ${FileColumns.MEDIA_TYPE}=${FileColumns.MEDIA_TYPE_IMAGE} AND ${MediaColumns.IS_PENDING}=0 AND ${MediaColumns.IS_TRASHED}=0 AND ${MediaColumns.RELATIVE_PATH} LIKE ?"
        val found = try {
            cr.query(MediaStore.Files.getContentUri(row.vol), cols, sel, arrayOf(row.id.toString(), CAMERA), null)?.use { c ->
            if (!c.moveToFirst()) return@use false
            val gen = if (c.isNull(c.getColumnIndexOrThrow(MediaColumns.GENERATION_MODIFIED))) "" else PbGen.canonical(c.getLong(c.getColumnIndexOrThrow(MediaColumns.GENERATION_MODIFIED)))
            val size = c.getLong(c.getColumnIndexOrThrow(MediaColumns.SIZE))
            val vol = c.getString(c.getColumnIndexOrThrow(MediaColumns.VOLUME_NAME)) ?: ""
            val ver = runCatching { MediaStore.getVersion(core.ctx, vol) }.getOrNull() ?: ""
            gen == row.gen && size == row.size.toLong() && vol == row.vol && ver == row.ver
        }
        } catch (_: SecurityException) {
            return "permission"
        }
        return when (found) {
            null -> null
            false -> "version"
            else -> "ok"
        }
    }

    private fun query(owner: PbOwner, syncReq: String, ep: Int) {
        if (Build.VERSION.SDK_INT < 30) {
            synchronized(lock) { if (epoch == ep && live(owner)) refuse(owner, syncReq, "api") }
            return
        }
        val snap = synchronized(lock) {
            if (epoch != ep || !live(owner)) null
            else {
                loadCursorLocked()
                PbGen.firstFullSecond(maxOf(sinceOf(owner.macId), remoteSince)) to vols.snapshot()
            }
        } ?: return
        val sinceSec = snap.first
        val marks = snap.second
        val read = try {
            readVolumes(marks, sinceSec)
        } catch (_: SecurityException) {
            synchronized(lock) { if (epoch == ep && live(owner)) refuse(owner, syncReq, "permission") }
            return
        } catch (_: Exception) {
            synchronized(lock) { if (epoch == ep && live(owner)) refuse(owner, syncReq, "read") }
            return
        }
        synchronized(lock) {
            if (epoch != ep || !live(owner)) return
            val why = blocked()
            if (why.isNotEmpty()) {
                refuse(owner, syncReq, why)
                return
            }
            hole = false
            scan = Scan(Proto.randomHex(8), read.rows, read.remain, 0, "")
            val page = nextPageLocked() ?: Page(emptyList(), false, false)
            sendPageLocked(owner, syncReq, page)
        }
    }

    private fun readVolumes(marks: List<PbVolumes.Mark>, sinceSec: Long): Window {
        val rows = mutableListOf<Row>()
        var remain = false
        val volumes = MediaStore.getExternalVolumeNames(core.ctx).sorted()
        for (vol in volumes) {
            val room = WALK - rows.size
            if (room <= 0) { remain = true; break }
            val version = MediaStore.getVersion(core.ctx, vol)
            if (!fieldOk(vol) || !fieldOk(version)) continue
            val ceiling = MediaStore.getGeneration(core.ctx, vol)
            val from = marks.firstOrNull { it.volume == vol && it.version == version }?.position ?: PbPosition()
            val batch = readVolume(vol, version, from, ceiling, sinceSec, room)
            if (MediaStore.getVersion(core.ctx, vol) != version) throw IOException("photo index changed")
            rows.addAll(batch)
            if (batch.size >= room) { remain = true; break }
        }
        return Window(rows, remain)
    }

    private fun readVolume(vol: String, ver: String, from: PbPosition, ceiling: Long, sinceSec: Long, limit: Int): List<Row> {
        val gen = MediaColumns.GENERATION_MODIFIED
        val id = BaseColumns._ID
        val sel = "${FileColumns.MEDIA_TYPE}=${FileColumns.MEDIA_TYPE_IMAGE} AND ${MediaColumns.IS_PENDING}=0 AND ${MediaColumns.IS_TRASHED}=0 AND ${MediaColumns.RELATIVE_PATH} LIKE ? AND ${MediaColumns.DATE_ADDED}>=? AND $gen<=? AND ($gen>? OR ($gen=? AND $id>?))"
        val args = arrayOf(CAMERA, sinceSec.toString(), ceiling.toString(), from.generation.toString(), from.generation.toString(), from.id.toString())
        val cols = arrayOf(BaseColumns._ID, MediaColumns.DISPLAY_NAME, MediaColumns.SIZE, MediaColumns.DATE_TAKEN, MediaColumns.DATE_ADDED, MediaColumns.VOLUME_NAME, MediaColumns.GENERATION_MODIFIED)
        val bundle = Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, sel)
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "$gen ASC, $id ASC")
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
        }
        val rows = mutableListOf<Row>()
        cr.query(MediaStore.Files.getContentUri(vol), cols, bundle, null)?.use { c ->
            val iId = c.getColumnIndexOrThrow(BaseColumns._ID)
            val iName = c.getColumnIndexOrThrow(MediaColumns.DISPLAY_NAME)
            val iSize = c.getColumnIndexOrThrow(MediaColumns.SIZE)
            val iTaken = c.getColumnIndexOrThrow(MediaColumns.DATE_TAKEN)
            val iAdded = c.getColumnIndexOrThrow(MediaColumns.DATE_ADDED)
            val iVol = c.getColumnIndexOrThrow(MediaColumns.VOLUME_NAME)
            val iGen = c.getColumnIndexOrThrow(MediaColumns.GENERATION_MODIFIED)
            while (c.moveToNext() && rows.size < limit) {
                val mediaId = c.getLong(iId)
                if (mediaId <= 0L) continue
                val gotVol = c.getString(iVol) ?: ""
                if (gotVol != vol) continue
                val gen = if (c.isNull(iGen)) null else PbGen.canonical(c.getLong(iGen))
                val size = if (c.isNull(iSize)) -1L else c.getLong(iSize)
                val name = safeName(if (c.isNull(iName)) "" else c.getString(iName) ?: "")
                val taken = if (c.isNull(iTaken)) 0L else c.getLong(iTaken)
                val addedSec = if (c.isNull(iAdded)) -1L else c.getLong(iAdded)
                val item = itemKey(vol, ver, mediaId)
                val skip = when {
                    item.isEmpty() || gen == null || addedSec < 0L -> "bad"
                    size <= 0L || size > MAX_BYTES || name.isEmpty() -> "bad"
                    else -> null
                }
                rows.add(Row(mediaId, vol, ver, item, gen ?: "", if (skip == null) size.toInt() else 0, name, taken, addedSec * 1000L, skip, false))
            }
        }
        return rows
    }

    /** Null when this scan has nothing left to offer, so the caller reads the volumes again. */
    private fun nextPageLocked(): Page? {
        val s = scan ?: return null
        drainLocked()
        val out = mutableListOf<Row>()
        var i = s.pos
        while (i < s.rows.size && out.size < PAGE) {
            val row = s.rows[i++]
            if (row.skip == null && !row.done) out.add(row)
        }
        val more = (i until s.rows.size).any { s.rows[it].skip == null && !s.rows[it].done }
        if (out.isEmpty() && !more) {
            scan = null
            offered = mutableListOf()
            return null
        }
        return Page(out, more, !more && s.remain)
    }

    private fun sendPageLocked(owner: PbOwner, syncReq: String, page: Page) {
        if (!live(owner)) return
        offered = page.rows.toMutableList()
        val items = JSONArray()
        for (row in page.rows) {
            items.put(JSONObject().put("item", row.item).put("gen", row.gen).put("size", row.size).put("name", row.name).put("taken", row.taken).put("added", row.added))
        }
        val s = scan
        val inv = Proto.randomHex(8)
        // Kept until the rows settle. Dropping the last page here left its cursor unmoved.
        if (s != null) s.inv = inv
        core.link.sendFor(owner.socket, msg(Proto.T.BACKUP_INV,
            "req" to inv, "sync" to syncReq, "rev" to revOf(owner.macId), "mrev" to remoteMrev,
            "scan" to (s?.token ?: Proto.randomHex(8)), "page" to 0, "more" to page.more, "remain" to page.remain, "items" to items,
        ))
    }

    private fun sameRevision(m: JSONObject, owner: PbOwner) =
        longField(m.opt("rev")) == owner.rev.toLong() && longField(m.opt("mrev")) == remoteMrev.toLong()

    private fun settle(m: JSONObject, terminal: Boolean, fromFlight: Boolean): Boolean {
        val item = m.optString("item")
        val gen = PbGen.canonical(m.opt("gen")) ?: return false
        val s = scan ?: return false
        if (m.optString("scan") != s.token || (s.inv.isNotEmpty() && m.optString("inv") != s.inv)) return false
        val row = offered.firstOrNull { !it.done && it.item == item && it.gen == gen } ?: return false
        if (m.optString("t") == Proto.T.BACKUP_HAVE && longField(m.opt("size")) != row.size.toLong()) return false
        if (fromFlight && (flight?.row !== row && (flight?.row?.item != row.item || flight?.row?.gen != row.gen))) return false
        if (!terminal) {
            hole = true
            return false
        }
        val flying = flight?.row
        if (!fromFlight && flying != null && flying.item == row.item && flying.gen == row.gen) return false
        settleRowLocked(row, true)
        return true
    }

    private fun settleRowLocked(row: Row, terminal: Boolean) {
        if (!terminal) {
            hole = true
            return
        }
        row.done = true
        drainLocked()
    }

    private fun drainLocked() {
        if (hole) return
        val s = scan ?: return
        var moved = false
        while (s.pos < s.rows.size && (s.rows[s.pos].done || s.rows[s.pos].skip != null)) {
            val row = s.rows[s.pos]
            row.gen.toLongOrNull()?.let { vols.advance(row.vol, row.ver, PbPosition(it, row.id)) }
            s.pos++
            moved = true
        }
        if (moved) saveCursorLocked()
    }

    private fun matchLocked(m: JSONObject): Row? {
        if (!token(m.optString("req")) || !token(m.optString("batch")) || !token(m.optString("scan")) || !token(m.optString("inv"))) return null
        val s = scan ?: return null
        if (m.optString("scan") != s.token || m.optString("inv") != s.inv) return null
        val id = macId()
        if (m.optInt("rev", -1) != revOf(id) || m.optInt("mrev", -1) != remoteMrev) return null
        val gen = PbGen.canonical(m.opt("gen")) ?: return null
        val size = longField(m.opt("size")) ?: return null
        if (size <= 0L || size > MAX_BYTES) return null
        return offered.firstOrNull { !it.done && it.item == m.optString("item") && it.gen == gen && it.size.toLong() == size }
    }

    private fun refuseEcho(f: Flight, why: String) {
        if (!live(f.owner)) return
        core.link.sendFor(f.owner.socket, echo(Proto.T.BACKUP_REFUSE, f.take, f.row.gen, "why" to why))
    }

    private fun sendEcho(f: Flight, t: String, vararg extra: Pair<String, Any?>): Boolean = synchronized(lock) {
        if (!pumpingLocked(f)) false
        else core.link.sendFor(f.owner.socket, echo(t, f.take, f.row.gen, *extra))
    }

    private fun echo(t: String, take: JSONObject, gen: String, vararg extra: Pair<String, Any?>): JSONObject {
        val o = msg(t,
            "req" to take.optString("req"), "batch" to take.optString("batch"), "item" to take.optString("item"),
            "gen" to PbGen.echo(take.opt("gen"), gen), "rev" to take.optInt("rev"), "mrev" to take.optInt("mrev"),
            "scan" to take.optString("scan"), "inv" to take.optString("inv"),
        )
        for ((k, v) in extra) o.put(k, v)
        return o
    }

    private fun refuse(owner: PbOwner, req: String, why: String) {
        if (!live(owner)) return
        core.link.sendFor(owner.socket, msg(Proto.T.BACKUP_REFUSE, "req" to req, "why" to why, "rev" to revOf(owner.macId), "mrev" to remoteMrev))
    }

    private fun sendState(owner: PbOwner?, announceOff: Boolean = false) {
        val sent = synchronized(lock) {
            val mark = owner?.socket ?: marker ?: return@synchronized null
            val id = macId()
            val current = if (owner != null) live(owner) else core.link.lockSessionCurrent(mark)
            if (id.isEmpty() || !core.link.peerBackup || (!moduleOn() && !announceOff) || !current) null else mark to id
        } ?: return
        val (mark, id) = sent
        core.link.sendFor(mark, msg(Proto.T.BACKUP_STATE,
            "on" to allowed(id), "since" to sinceOf(id), "rev" to revOf(id),
            "perm" to (if (moduleOn()) core.hub.perm("media") else "none"), "loc" to locGranted(), "api" to Build.VERSION.SDK_INT,
        ))
    }

    private fun admit(): Boolean {
        if (!moduleOn() || !core.link.peerBackup) return false
        val h = core.host ?: return false
        return h.os == "mac" && core.link.lockSessionCurrent(core.link.sessionMarker())
    }

    private fun blocked(): String {
        if (!core.link.peerBackup) return "peer"
        if (core.link.ble || !core.link.lockSessionCurrent(marker)) return "transport"
        if (Build.VERSION.SDK_INT < 30) return "api"
        val perm = core.hub.perm("media")
        if (perm != "ok") return if (perm == "partial") "partial" else "media"
        if (!locGranted()) return "location"
        val id = macId()
        if (id.isEmpty() || !allowed(id) || !remoteOn || sinceOf(id) <= 0L || remoteSince <= 0L) return "consent"
        return ""
    }

    /** Drops the in-memory flight and scan. The per-volume cursor file stays. */
    private fun revokeLocked(sendStop: Boolean) {
        epoch++
        scanJob = false
        scan = null
        offered = mutableListOf()
        hole = false
        val f = flight
        flight = null
        clearAckLocked()
        if (f != null) rememberDead(f.req)
        if (sendStop && f != null && core.link.lockSessionCurrent(f.owner.socket)) {
            core.link.sendFor(f.owner.socket, msg(Proto.T.BACKUP_STOP, "req" to f.req))
        }
    }

    private fun pumpingLocked(f: Flight): Boolean {
        return flight === f && epoch == f.epoch && live(f.owner) && blocked().isEmpty() && revOf(f.owner.macId) == f.owner.rev
    }

    private fun live(owner: PbOwner): Boolean {
        if (!owner.module || !moduleOn() || !owner.peer || !core.link.peerBackup) return false
        if (owner.macId.isEmpty() || macId() != owner.macId || revOf(owner.macId) != owner.rev) return false
        if (core.link.sessionMarker() !== owner.socket) return false
        return core.link.lockSessionCurrent(owner.socket)
    }

    private fun sameSocket(owner: PbOwner): Boolean {
        return owner.macId.isNotEmpty() && macId() == owner.macId && core.link.sessionMarker() === owner.socket && core.link.lockSessionCurrent(owner.socket)
    }

    private fun setOn(on: Boolean, id: String, socket: Any?) {
        val tell = synchronized(lock) {
            if (!token(id) || id != macId()) return
            if (on && (socket == null || core.link.sessionMarker() !== socket || !canAsk())) return
            if (on() == on) return
            revokeLocked(true)
            core.store.setFlag(onKey(id), on)
            core.store.setPrefsString(revKey(id), (revOf(id) + 1).toString())
            if (on) {
                core.store.setPrefsString(sinceKey(id), System.currentTimeMillis().toString())
                core.store.setPrefsString(pairKey(id), pairing(id))
            }
            resetCursorLocked()
            syncWatchLocked()
            true
        }
        if (tell) sendState(null)
        core.changed()
    }

    private fun watchable(): Boolean {
        if (Build.VERSION.SDK_INT < 30 || !moduleOn() || !core.link.peerBackup) return false
        if (!core.link.lockSessionCurrent(marker)) return false
        val id = macId()
        if (id.isEmpty() || !allowed(id) || sinceOf(id) <= 0L) return false
        if (!heard || !remoteOn || remoteSince <= 0L) return false
        if (core.hub.perm("media") != "ok" || !locGranted()) return false
        return true
    }

    private fun syncWatchLocked() {
        if (watchable()) watchLocked() else unwatchLocked()
    }

    private fun watchLocked() {
        if (observer != null || Build.VERSION.SDK_INT < 30) return
        val o = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                main.removeCallbacks(nudge)
                main.postDelayed(nudge, 700L)
            }
        }
        runCatching {
            cr.registerContentObserver(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL), true, o)
            observer = o
        }.onFailure { runCatching { cr.unregisterContentObserver(o) } }
    }

    private fun unwatchLocked() {
        observer?.let { o -> runCatching { cr.unregisterContentObserver(o) } }
        observer = null
        main.removeCallbacks(nudge)
    }

    private val nudge = Runnable {
        if (watchable()) sendState(null)
    }

    private val ack = Runnable {
        val stop = synchronized(lock) {
            val f = flight ?: return@Runnable
            if (!f.ended || f.req != ackReq) return@Runnable
            val socket = f.owner.socket
            val req = f.req
            flight = null
            ackReq = ""
            rememberDead(req)
            if (core.link.lockSessionCurrent(socket)) socket to req else null
        }
        if (stop != null) core.link.sendFor(stop.first, msg(Proto.T.BACKUP_STOP, "req" to stop.second))
    }

    private fun armAckLocked(f: Flight) {
        ackReq = f.req
        main.removeCallbacks(ack)
        main.postDelayed(ack, ACK_MS)
    }

    private fun clearAckLocked() {
        ackReq = ""
        main.removeCallbacks(ack)
    }

    private fun resetCursorLocked() {
        vols.clear()
        hole = false
        scan = null
        offered = mutableListOf()
        runCatching { files.delete() }
    }

    private fun loadCursorLocked() {
        val id = macId()
        vols.clear()
        val o = runCatching { JSONObject(files.readText()) }.getOrNull() ?: return
        if (o.optString("mac") != id || o.optString("pair") != pairing(id) || o.optInt("rev") != revOf(id) || o.optInt("mrev") != remoteMrev) return
        // A file that only has one global cursor is from the synthetic external scan. It is not a position on any volume.
        val tree = o.optJSONObject("vols") ?: return
        val keys = tree.keys()
        while (keys.hasNext()) {
            val vol = keys.next()
            val row = tree.optJSONObject(vol) ?: continue
            val ver = row.optString("ver")
            val cid = row.optLong("id", -1L)
            val gen = row.optString("gen").toLongOrNull() ?: continue // old id-only files are rescanned
            if (fieldOk(vol) && fieldOk(ver) && cid > 0L && gen >= 0L) vols.advance(vol, ver, PbPosition(gen, cid))
        }
    }

    private fun saveCursorLocked() {
        val id = macId()
        if (id.isEmpty()) return
        val tree = JSONObject()
        for ((vol, ver, pos) in vols.snapshot()) tree.put(vol, JSONObject().put("ver", ver).put("id", pos.id).put("gen", pos.generation.toString()))
        val text = JSONObject().put("mac", id).put("pair", pairing(id)).put("rev", revOf(id)).put("mrev", remoteMrev).put("vols", tree).toString()
        val tmp = File(files.parentFile, files.name + ".tmp")
        runCatching {
            tmp.writeText(text)
            if (!tmp.renameTo(files)) {
                files.writeText(text)
                tmp.delete()
            }
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
    private fun allowed(id: String) = pairing(id).isNotEmpty() &&
        core.store.flag(onKey(id), false) && core.store.prefsString(pairKey(id), "") == pairing(id)
    private fun pairing(id: String): String {
        val h = core.host ?: return ""
        // Token distinguishes re-pairing with the same certificate. Never write the token itself.
        return if (h.id == id) Proto.sha256(("photo backup:" + h.fp + ":" + h.token).toByteArray(Charsets.UTF_8)).hex() else ""
    }
    private fun pairKey(id: String) = "pb.pair.$id"
    private fun onKey(id: String) = "pb.on.$id"
    private fun sinceKey(id: String) = "pb.since.$id"
    private fun revKey(id: String) = "pb.rev.$id"

    private fun rememberDead(req: String) {
        if (req in dead) return
        dead.addLast(req)
        while (dead.size > 64) dead.removeFirst()
    }

    private fun isDead(req: String) = req in dead

    private fun longField(v: Any?): Long? = when (v) {
        is Int -> v.toLong()
        is Long -> v
        is Double -> if (!v.isNaN() && !v.isInfinite() && v % 1.0 == 0.0 && v >= Long.MIN_VALUE.toDouble() && v <= Long.MAX_VALUE.toDouble()) v.toLong() else null
        is String -> v.toLongOrNull()
        else -> null
    }

    private fun longHint(name: String) = tr("New camera photos are copied into the folder you choose, by year and month, after you turn this on here and on {name}. The copy includes the photo’s location. Nothing is deleted or replaced.", "name" to name)

    companion object {
        private const val CHUNK = 32 * 1024
        private const val MAX_BYTES = 80L * 1024L * 1024L
        private const val PAGE = 40
        private const val WALK = 400
        private const val QUEUE_MAX = 1024L * 1024L
        private const val ACK_MS = 60_000L
        private const val CAMERA = "DCIM/Camera/%"
        private const val SEP = "\u001f"
        private val SHA = Regex("^[0-9a-f]{64}$")

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

internal class PbOwner(val socket: Any, val macId: String, val rev: Int, val peer: Boolean, val module: Boolean)

/** Canonical decimal generation. A JSON number is echoed only when it is a safe integer. */
internal object PbGen {
    const val MAX_SAFE = 9007199254740991L

    // DATE_ADDED has no subsecond precision; never include an ambiguous pre-consent item.
    fun firstFullSecond(since: Long): Long = since / 1000L + if (since % 1000L == 0L) 0L else 1L

    fun canonical(v: Any?): String? = when (v) {
        is String -> v.toLongOrNull()?.takeIf { it >= 0 && it.toString() == v && v.length <= 19 }?.toString()
        is Long -> if (v >= 0) v.toString() else null
        is Int -> if (v >= 0) v.toString() else null
        is Double -> {
            if (v.isNaN() || v.isInfinite() || v < 0 || v > MAX_SAFE || v % 1.0 != 0.0) null
            else {
                val n = v.toLong()
                if (n.toDouble() == v) n.toString() else null
            }
        }
        else -> null
    }

    fun echo(raw: Any?, canonical: String): Any {
        val n = canonical.toLongOrNull()
        if (n != null && n <= MAX_SAFE && raw is Number && raw !is Double && raw !is Float && raw.toLong() == n) return n
        if (n != null && n <= MAX_SAFE && raw is Double && raw.toLong() == n && raw == n.toDouble()) return n
        return canonical
    }
}

internal data class PbPosition(val generation: Long = -1, val id: Long = 0) : Comparable<PbPosition> {
    override fun compareTo(other: PbPosition) =
        generation.compareTo(other.generation).takeIf { it != 0 } ?: id.compareTo(other.id)
}

/** A rebuilt volume has a new version; its old generation cursor cannot omit new photos. */
internal class PbVolumes {
    data class Mark(val volume: String, val version: String, val position: PbPosition)
    private val marks = HashMap<String, Mark>()

    fun from(vol: String, version: String): PbPosition =
        marks[vol]?.takeIf { it.version == version }?.position ?: PbPosition()

    fun advance(vol: String, version: String, pos: PbPosition): Boolean {
        if (vol.isEmpty() || version.isEmpty() || pos.id <= 0 || pos.generation < 0 || pos <= from(vol, version)) return false
        marks[vol] = Mark(vol, version, pos)
        return true
    }

    fun clear() = marks.clear()

    fun snapshot() = marks.values.sortedBy { it.volume }
}
