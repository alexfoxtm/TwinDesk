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
    )

    data class Board(val shots: List<Shot>, val unavailable: String)

    val EMPTY = Board(emptyList(), "")

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

    fun reduce(board: Board, msg: Incoming, catalog: DesktopSelect.Catalog?): Board {
        if (msg.clear) return Board(emptyList(), board.unavailable)
        if (msg.unavailable == "os" || msg.unavailable == "permission") return Board(emptyList(), msg.unavailable)
        if (msg.unavailable.isNotEmpty()) return board
        return accept(board, msg, catalog)
    }

    // A new catalog keeps a picture only while that display, space, capture, and view
    // generation are still the ones it was taken for. No catalog, or no capture session, drops all of it.
    fun retain(board: Board, catalog: DesktopSelect.Catalog?): Board {
        val cat = catalog ?: return EMPTY
        val cap = cat.capture ?: return EMPTY
        val gen = cat.viewGen ?: return board.copy(shots = emptyList())
        val shots = board.shots.filter { shot ->
            shot.capture == cap && shot.viewGen == gen && listed(cat, shot.displayId, shot.spaceId)
        }
        return board.copy(shots = shots)
    }

    // Current only for the desktop on screen now, and only while Mission Control is not holding input.
    // Any stored picture of another desktop, or of this one while that hold is up, is last seen.
    fun tile(board: Board, displayId: String, desk: DesktopSelect.Desk, held: Boolean): Status {
        if (board.shots.none { it.displayId == displayId && it.spaceId == desk.id }) return Status.NONE
        if (desk.current && !held) return Status.CURRENT
        return Status.LAST
    }

    private fun accept(board: Board, msg: Incoming, catalog: DesktopSelect.Catalog?): Board {
        val cat = catalog ?: return board
        val cap = cat.capture ?: return board
        val gen = cat.viewGen ?: return board
        if (msg.capture != cap || msg.viewGen != gen) return board
        val jpeg = msg.jpeg
        if (!jpegOk(jpeg, msg.width, msg.height)) return board
        if (!listed(cat, msg.displayId, msg.spaceId)) return board
        val shot = Shot(msg.displayId, msg.spaceId, cap, gen, msg.width, msg.height, jpeg!!, nextSeq++)
        var shots = board.shots.filterNot { it.displayId == shot.displayId && it.spaceId == shot.spaceId } + shot
        while (shots.size > MAX_SHOTS || shots.sumOf { it.jpeg.size } > MAX_STORE_BYTES) {
            val oldest = shots.minByOrNull { it.seq } ?: break
            shots = shots.filterNot { it.seq == oldest.seq }
        }
        return Board(shots, "")
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
