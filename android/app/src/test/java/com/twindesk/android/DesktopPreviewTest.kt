// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which preview the phone may keep. Pixel decode stays in the sheet, so this test never
// calls BitmapFactory.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopPreviewTest {
    @Test
    fun currentSpaceOfAPermittedDisplayIsKept() {
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog())
        assertEquals(1, board.shots.size)
        assertEquals("1", board.shots[0].spaceId)
        assertEquals("", board.unavailable)
        assertEquals(DesktopPreview.Status.CURRENT, DesktopPreview.tile(board, "1", desk("1", 0, true), false))
    }

    @Test
    fun anotherDisplayAndABadJpegAreRefused() {
        val start = DesktopPreview.EMPTY
        assertEquals(start, DesktopPreview.reduce(start, shot("9", "1"), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "99"), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", capture = 8), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", viewGen = 4), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", width = 481), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", jpeg = byteArrayOf(0, 0, 0, 0)), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0, 0)), catalog()))
        val huge = ByteArray(DesktopPreview.MAX_BYTES + 1)
        huge[0] = 0xFF.toByte(); huge[1] = 0xD8.toByte()
        huge[huge.size - 2] = 0xFF.toByte(); huge[huge.size - 1] = 0xD9.toByte()
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", jpeg = huge), catalog()))
    }

    @Test
    fun inactiveDesktopIsLastSeenAndAHoldIsNotCurrent() {
        var board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog())
        board = DesktopPreview.reduce(board, shot("1", "2"), catalog())
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(board, "1", desk("2", 1, false), false))
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(board, "1", desk("1", 0, true), true))
        assertEquals(DesktopPreview.Status.NONE, DesktopPreview.tile(board, "1", desk("3", 2, false), false))
    }

    @Test
    fun clearDropsShotsAndKeepsTheNotice() {
        val noted = DesktopPreview.reduce(DesktopPreview.EMPTY, DesktopPreview.Incoming(false, "os", "", "", -1, -1, 0, 0, null), null)
        val withShot = noted.copy(shots = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog()).shots)
        val cleared = DesktopPreview.reduce(withShot, DesktopPreview.Incoming(true, "", "", "", -1, -1, 0, 0, null), catalog())
        assertTrue(cleared.shots.isEmpty())
        assertEquals("os", cleared.unavailable)
        val permission = DesktopPreview.reduce(withShot, DesktopPreview.Incoming(false, "permission", "", "", -1, -1, 0, 0, null), catalog())
        assertTrue(permission.shots.isEmpty())
        assertEquals("permission", permission.unavailable)
    }

    @Test
    fun catalogChangeDropsWhatItNoLongerAllows() {
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "2"), catalog())
        assertTrue(DesktopPreview.retain(board, null).shots.isEmpty())
        assertEquals("", DesktopPreview.retain(board, null).unavailable)
        assertTrue(DesktopPreview.retain(board, catalog().copy(capture = null)).shots.isEmpty())
        assertTrue(DesktopPreview.retain(board, catalog().copy(capture = 8)).shots.isEmpty())
        assertTrue(DesktopPreview.retain(board, catalog().copy(viewGen = 9)).shots.isEmpty())
        val gone = catalog().copy(displays = listOf(catalog().displays[0].copy(desktops = listOf(desk("1", 0, true)))))
        assertTrue(DesktopPreview.retain(board, gone).shots.isEmpty())
        assertEquals(1, DesktopPreview.retain(board, catalog()).shots.size)
    }

    @Test
    fun oldestShotLeavesWhenTheSessionIsFull() {
        var board = DesktopPreview.EMPTY
        val cat = catalog()
        for (id in 1..13) board = DesktopPreview.reduce(board, shot("1", id.toString()), cat)
        assertEquals(DesktopPreview.MAX_SHOTS, board.shots.size)
        assertFalse(board.shots.any { it.spaceId == "1" })
        assertTrue(board.shots.any { it.spaceId == "13" })
    }

    private fun jpeg(): ByteArray = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x11, 0x22, 0xFF.toByte(), 0xD9.toByte())

    private fun shot(
        displayId: String,
        spaceId: String,
        capture: Long = 7,
        viewGen: Long = 3,
        width: Int = 480,
        height: Int = 270,
        jpeg: ByteArray = jpeg(),
    ) = DesktopPreview.Incoming(false, "", displayId, spaceId, capture, viewGen, width, height, jpeg)

    private fun desk(id: String, index: Int, current: Boolean) = DesktopSelect.Desk(id, index, current, true)

    private fun catalog(): DesktopSelect.Catalog {
        val spaces = (1..16).map { n -> desk(n.toString(), n - 1, n == 1) }
        val display = DesktopSelect.Display("1", "Built-in", true, 0, spaces.size, false, spaces)
        return DesktopSelect.Catalog(1, "1", 3, 7, listOf(display))
    }
}
