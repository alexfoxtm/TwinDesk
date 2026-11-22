// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.Manifest
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.util.Base64
import org.json.JSONObject
import org.junit.Assume.assumeNoException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoBackupTest {
    @Test
    fun creditWaitWakesOnGrantAndHonorsTheAdvertisedOffset() {
        val chunk = 32_768
        val size = 65 * chunk
        val lock = Object()
        val window = requireNotNull(PbCredit.window(262_144, chunk))
        assertNull(PbCredit.window(null, chunk))
        assertNull(PbCredit.window(1, chunk))
        val credit = PbCredit(lock, window, size)
        val ready = java.util.concurrent.Semaphore(0)
        val started = System.nanoTime()
        val sender = java.util.concurrent.FutureTask {
            for (end in 1..65) {
                var waiting = false
                check(credit.await(end * chunk, end == 65) {
                    if (!waiting && (end == 1 || end >= 9)) {
                        waiting = true
                        ready.release()
                    }
                    true
                })
            }
        }
        val thread = Thread(sender).apply { isDaemon = true; start() }
        try {
            // One granter response per iteration. With 20 ms polling this takes at least 1.16 s.
            for (end in listOf(1) + (9..65)) {
                assertTrue(ready.tryAcquire(2, java.util.concurrent.TimeUnit.SECONDS))
                val offset = when (end) {
                    1 -> 0
                    65 -> size
                    else -> ((end - 8).coerceAtLeast(0)) * chunk
                }
                synchronized(lock) { credit.grant(offset.toLong(), minOf(size, offset + window).toLong(), size) }
            }
            sender.get(2, java.util.concurrent.TimeUnit.SECONDS)
            assertTrue(System.nanoTime() - started < 1_000_000_000)
        } finally {
            thread.interrupt()
        }
    }

    @Test
    fun senderFillsShortReadsAndWaitsForTheFinalWrittenOffset() {
        val data = byteArrayOf(1, 2, 3, 4, 5)
        val input = object : ByteArrayInputStream(data) {
            override fun read(b: ByteArray, off: Int, len: Int): Int =
                super.read(b, off, minOf(1, len))
        }
        val lock = Object()
        val credit = PbCredit(lock, 4, data.size)
        val chunks = mutableListOf<List<Byte>>()
        synchronized(lock) { credit.grant(0, 4, 0) }
        val body = pumpPhotoBody(input, data.size, 4, true,
            ready = { end, final ->
                assertEquals(chunks.size == 2, final)
                if (final) {
                    assertFalse("End must wait for written, even when upTo covers the tail",
                        creditWithoutWaiting(credit, end, true))
                    synchronized(lock) { credit.grant(5, 5, 5) }
                }
                creditWithoutWaiting(credit, end, final)
            },
            chunk = { sent, seq, encoded ->
                assertEquals(chunks.size, seq)
                assertEquals(if (seq == 0) 4 else 5, sent)
                chunks += Base64.getDecoder().decode(encoded).toList()
                if (seq == 0) synchronized(lock) { credit.grant(4, 5, sent) }
                true
            },
        )
        assertNull(body.failure)
        assertEquals(listOf(data.take(4), data.takeLast(1)), chunks)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(data).hex(), body.sha)
    }

    @Test
    fun rejectsInvalidGrantsBeforeTheyCanReleaseAChunk() {
        val lock = Object()
        val credit = PbCredit(lock, 4, 9)
        synchronized(lock) { credit.grant(1, 5, 0) }
        assertFalse("written cannot exceed sent", creditWithoutWaiting(credit, 4, false))
        synchronized(lock) { credit.grant(0, 5, 0) }
        assertFalse("upTo must match the negotiated window", creditWithoutWaiting(credit, 4, false))
    }

    @Test
    fun parsesWireGrantWithAndroidJson() {
        val message = try {
            JSONObject("""{"written":0,"upTo":32768}""").also { it.opt("written") }
        } catch (stub: RuntimeException) {
            if (stub.message != "Stub!" && stub.message?.startsWith("Method opt in org.json.JSONObject not mocked.") != true) throw stub
            assumeNoException("Requires Android's org.json implementation on the test classpath", stub)
            throw stub
        }
        val lock = Object()
        val credit = PbCredit(lock, 32768, 65536)
        synchronized(lock) {
            credit.grant(JSONObject("""{"written":0.5,"upTo":32768}"""), 0)
            credit.grant(JSONObject("""{"written":0}"""), 0)
        }
        assertFalse(creditWithoutWaiting(credit, 32768, false))
        synchronized(lock) { credit.grant(message, 0) }
        assertTrue(creditWithoutWaiting(credit, 32768, false))
    }

    // A ready grant succeeds before wait(). A missing grant returns immediately on interruption.
    private fun creditWithoutWaiting(credit: PbCredit, end: Int, final: Boolean): Boolean {
        Thread.currentThread().interrupt()
        try {
            return credit.await(end, final) { true }
        } finally {
            Thread.interrupted()
        }
    }

    @Test
    fun queueProgressRenewsTheIdleDeadline() {
        val timer = PbIdle(0, PB_STALL_MS)
        val almost = (PB_STALL_MS - 1) * 1_000_000
        timer.progress(almost)
        assertFalse(timer.expired(2 * almost))
        assertTrue(timer.expired(almost + PB_STALL_MS * 1_000_000))
    }

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
