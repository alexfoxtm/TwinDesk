// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoBackupTest {
    @Test
    fun backupRequestsPhotoAndLocationPermissionsTogether() {
        val loc = Manifest.permission.ACCESS_MEDIA_LOCATION
        val images = Manifest.permission.READ_MEDIA_IMAGES
        val selected = Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
        assertEquals(listOf(Manifest.permission.READ_EXTERNAL_STORAGE, loc), PbPermissions.request(32))
        assertEquals(listOf(images, loc), PbPermissions.request(33))
        for (api in listOf(34, 37)) {
            assertEquals(listOf(images, selected, loc), PbPermissions.request(api))
            assertEquals("ok", PbPermissions.photoAccess(api) { it == images })
        }
    }

    @Test
    fun selectedPhotosOrAllFilesAloneCannotAuthorizeCameraBackup() {
        assertEquals("partial", PbPermissions.photoAccess(37) {
            it == Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED || it == Manifest.permission.ACCESS_MEDIA_LOCATION
        })
        assertEquals("ask", PbPermissions.photoAccess(37) { it == Manifest.permission.MANAGE_EXTERNAL_STORAGE })
    }

    @Test
    fun perVolumeCursorAndExactGeneration() {
        val vols = PbVolumes()
        assertTrue(vols.advance("external_primary", "v1", PbPosition(20, 101)))
        // The older row publishes after the newer row was archived.
        assertTrue(vols.advance("external_primary", "v1", PbPosition(21, 100)))
        // Tie break so a batch of rows with the same generation survives pagination.
        assertTrue(vols.advance("external_primary", "v1", PbPosition(21, 102)))
        assertFalse(vols.advance("external_primary", "v1", PbPosition(21, 102)))
        assertEquals(PbPosition(), vols.from("sdcard", "v9"))
        assertTrue(vols.advance("sdcard", "v9", PbPosition(1, 5)))
        assertEquals(PbPosition(21, 102), vols.from("external_primary", "v1"))
        assertEquals(PbPosition(1, 5), vols.from("sdcard", "v9"))
        assertEquals(PbPosition(), vols.from("external_primary", "v2"))
        assertTrue(vols.advance("external_primary", "v2", PbPosition(1, 1)))
        assertEquals(PbPosition(1, 1), vols.from("external_primary", "v2"))

        assertEquals(3L, PbGen.firstFullSecond(3_000L))
        assertEquals(4L, PbGen.firstFullSecond(3_001L))
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
