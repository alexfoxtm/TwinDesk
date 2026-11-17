// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Session memory for one still preview of a Mac desktop. The bytes are a JPEG the Mac
// already took of a display this catalog allows. This file does not decode pixels and
// does not ask for another desktop. A missing or rejected image stays "not previewed".
package com.twindesk.android

object DesktopPreview {
    const val MAX_EDGE = 480
    const val MAX_BYTES = 24 * 1024
    const val MAX_SHOTS = 12
    const val MAX_STORE_BYTES = MAX_SHOTS * MAX_BYTES

    enum class Status { CURRENT, LAST, NONE }

    data class Shot(
        val displayId: String,
        val spaceId: String,
        val capture: Long,
        val viewGen: Long,
        val width: Int,
        val height: Int,
        val jpeg: ByteArray,
        val seq: Long,
        val stale: Boolean = false,
    )

    data class Board(val shots: List<Shot>, val unavailable: String, val session: Long = 0)

    fun empty(session: Long) = Board(emptyList(), "", session)

    val EMPTY = empty(0)

    data class Incoming(
        val clear: Boolean,
        val unavailable: String,
        val displayId: String,
        val spaceId: String,
        val capture: Long,
        val viewGen: Long,
        val width: Int,
        val height: Int,
        val jpeg: ByteArray?,
    )

    private var nextSeq = 1L

    fun reduce(board: Board, msg: Incoming, catalog: DesktopSelect.Catalog?, session: Long = board.session): Board {
        if (board.session != session) return empty(session)
        if (msg.clear) return Board(emptyList(), board.unavailable, session)
        if (msg.unavailable == "os" || msg.unavailable == "permission") return Board(emptyList(), msg.unavailable, session)
        if (msg.unavailable.isNotEmpty()) return board
        return accept(board, msg, catalog, session)
    }

    // A picture stays while its display and space are still listed, for this same session.
    // A different capture or view generation, or a missing one, marks it stale instead of
    // dropping it. A missing catalog drops the pictures. A different session drops them too.
    fun retain(board: Board, catalog: DesktopSelect.Catalog?, session: Long = board.session): Board {
        if (board.session != session) return empty(session)
        val cat = catalog ?: return empty(session)
        val cap = cat.capture
        val gen = cat.viewGen
        val shots = board.shots.mapNotNull { shot ->
            if (!listed(cat, shot.displayId, shot.spaceId)) return@mapNotNull null
            val fresh = cap != null && gen != null && shot.capture == cap && shot.viewGen == gen
            shot.copy(stale = !fresh)
        }
        return board.copy(shots = shots, session = session)
    }

    // Current only for a fresh picture of the desktop on screen now, and only while
    // Mission Control is not holding input. A stale picture, another desktop, or this
    // one while that hold is up, is last seen.
    fun tile(board: Board, displayId: String, desk: DesktopSelect.Desk, held: Boolean): Status {
        val shot = board.shots.find { it.displayId == displayId && it.spaceId == desk.id } ?: return Status.NONE
        if (!shot.stale && desk.current && !held) return Status.CURRENT
        return Status.LAST
    }

    private fun accept(board: Board, msg: Incoming, catalog: DesktopSelect.Catalog?, session: Long): Board {
        val cat = catalog ?: return board
        val cap = cat.capture ?: return board
        val gen = cat.viewGen ?: return board
        if (msg.capture != cap || msg.viewGen != gen) return board
        val jpeg = msg.jpeg
        if (!jpegOk(jpeg, msg.width, msg.height)) return board
        if (!listed(cat, msg.displayId, msg.spaceId)) return board
        val shot = Shot(msg.displayId, msg.spaceId, cap, gen, msg.width, msg.height, jpeg!!, nextSeq++, stale = false)
        var shots = board.shots.filterNot { it.displayId == shot.displayId && it.spaceId == shot.spaceId } + shot
        while (shots.size > MAX_SHOTS || shots.sumOf { it.jpeg.size } > MAX_STORE_BYTES) {
            val oldest = shots.minByOrNull { it.seq } ?: break
            shots = shots.filterNot { it.seq == oldest.seq }
        }
        return Board(shots, "", session)
    }

    private fun listed(catalog: DesktopSelect.Catalog, displayId: String, spaceId: String): Boolean {
        val display = catalog.displays.find { it.id == displayId } ?: return false
        return display.desktops.any { it.id == spaceId }
    }

    private fun jpegOk(bytes: ByteArray?, width: Int, height: Int): Boolean {
        if (bytes == null || bytes.size < 4 || bytes.size > MAX_BYTES) return false
        if (bytes[0] != 0xFF.toByte() || bytes[1] != 0xD8.toByte()) return false
        if (bytes[bytes.size - 2] != 0xFF.toByte() || bytes[bytes.size - 1] != 0xD9.toByte()) return false
        if (width !in 1..MAX_EDGE || height !in 1..MAX_EDGE) return false
        return true
    }
}
