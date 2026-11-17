// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoBackupTest {
    @Test
    fun perVolumeCursorAndExactGeneration() {
        val vols = PbVolumes()
        assertTrue(vols.advance("external_primary", "v1", 100))
        // A lower id on another volume is not behind the primary volume's cursor.
        assertEquals(0L, vols.from("sdcard", "v9"))
        assertTrue(vols.advance("sdcard", "v9", 5))
        assertEquals(100L, vols.from("external_primary", "v1"))
        assertEquals(5L, vols.from("sdcard", "v9"))
        assertFalse(vols.advance("sdcard", "v9", 5))
        // The volume database was rebuilt. Old ids must not hide the new camera photos.
        assertEquals(0L, vols.from("external_primary", "v2"))
        assertTrue(vols.advance("external_primary", "v2", 1))
        assertEquals(1L, vols.from("external_primary", "v2"))
        // Idle and disconnected: nothing moves the cursor except a settled row.
        assertEquals(1L, vols.from("external_primary", "v2"))
        assertEquals(5L, vols.from("sdcard", "v9"))

        assertEquals("9223372036854775807", PbGen.canonical(9223372036854775807L))
        assertEquals("5", PbGen.canonical(5))
        assertEquals("5", PbGen.canonical("5"))
        assertNull(PbGen.canonical("05"))
        assertNull(PbGen.canonical(-1L))
        assertNull(PbGen.canonical(1.5))
        assertNull(PbGen.canonical(PbGen.MAX_SAFE.toDouble() + 2.0))
        assertEquals(5L, PbGen.echo(5, "5"))
        assertEquals(5L, PbGen.echo(5L, "5"))
        assertEquals("5", PbGen.echo("5", "5"))
        assertEquals("9223372036854775807", PbGen.echo("9223372036854775807", "9223372036854775807"))
        assertEquals("9223372036854775807", PbGen.echo(9223372036854775807L, "9223372036854775807"))
    }
}
