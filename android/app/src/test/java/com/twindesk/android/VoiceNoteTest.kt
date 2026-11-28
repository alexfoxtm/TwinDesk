package com.twindesk.android

import android.Manifest
import android.app.AlertDialog
import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.DialogInterface
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.media.MediaRecorder
import android.net.Uri
import android.os.Environment
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.shadows.ShadowToast
import java.io.File
import java.io.FileDescriptor
import java.io.FileNotFoundException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class VoiceNoteTest {

    @Suppress("DEPRECATION")
    private class FakeMediaRecorder : MediaRecorder() {
        override fun setAudioSource(audioSource: Int) {}
        override fun setOutputFormat(outputFormat: Int) {}
        override fun setAudioEncoder(audioEncoder: Int) {}
        override fun setAudioEncodingBitRate(bitRate: Int) {}
        override fun setAudioSamplingRate(samplingRate: Int) {}
        override fun setOutputFile(fd: FileDescriptor?) {}
        override fun prepare() {}
        override fun start() {}
        override fun stop() {}
        override fun release() {}
    }

    private class FakeMediaProvider(private val root: File) : ContentProvider() {
        data class Entry(
            val uri: Uri,
            val collection: Uri,
            val file: File,
            val values: ContentValues,
        )

        val entries = LinkedHashMap<Uri, Entry>()
        val deleted = ArrayList<Uri>()
        var audioNameOnPublish: String? = null
        var failAudioDescribe = false
        var failDownloadsWrite = false
        private var nextId = 1L

        override fun onCreate(): Boolean = true

        override fun insert(uri: Uri, values: ContentValues?): Uri? {
            val copy = ContentValues(values ?: ContentValues())
            val id = nextId++
            val rowUri = ContentUris.withAppendedId(uri, id)
            val file = File(root, "entry_$id")
            file.writeBytes(ByteArray(0))
            entries[rowUri] = Entry(rowUri, uri, file, copy)
            return rowUri
        }

        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            val e = entries[uri] ?: throw FileNotFoundException("missing $uri")
            if (e.collection == MediaStore.Downloads.EXTERNAL_CONTENT_URI && mode.contains("w") && failDownloadsWrite) {
                throw FileNotFoundException("simulated write failure")
            }
            val bits = if (mode.contains("w")) {
                ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            } else {
                ParcelFileDescriptor.MODE_READ_ONLY
            }
            return ParcelFileDescriptor.open(e.file, bits)
        }

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor? {
            val e = entries[uri] ?: return null
            if (failAudioDescribe && e.collection != MediaStore.Downloads.EXTERNAL_CONTENT_URI) return null
            val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
            val cursor = MatrixCursor(cols)
            val row = Array<Any?>(cols.size) { i ->
                when (cols[i]) {
                    OpenableColumns.DISPLAY_NAME, MediaStore.MediaColumns.DISPLAY_NAME ->
                        e.values.getAsString(MediaStore.MediaColumns.DISPLAY_NAME)
                    OpenableColumns.SIZE -> e.file.length()
                    else -> null
                }
            }
            cursor.addRow(row)
            return cursor
        }

        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
            val e = entries[uri] ?: return 0
            if (values != null) e.values.putAll(values)
            if (e.collection != MediaStore.Downloads.EXTERNAL_CONTENT_URI &&
                values?.getAsInteger(MediaStore.MediaColumns.IS_PENDING) == 0) {
                audioNameOnPublish?.let { e.values.put(MediaStore.MediaColumns.DISPLAY_NAME, it) }
            }
            return 1
        }

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
            deleted.add(uri)
            val removed = entries.remove(uri) ?: return 0
            removed.file.delete()
            return 1
        }

        override fun getType(uri: Uri): String? = entries[uri]?.values?.getAsString(MediaStore.MediaColumns.MIME_TYPE)

        fun audioEntries(): List<Entry> = entries.values.filter { it.collection != MediaStore.Downloads.EXTERNAL_CONTENT_URI }
        fun downloadEntries(): List<Entry> = entries.values.filter { it.collection == MediaStore.Downloads.EXTERNAL_CONTENT_URI }
    }

    private fun withVoiceEnv(block: (Core, FakeMediaProvider) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val tmp = File(app.cacheDir, "voicenote-test-${System.nanoTime()}").apply { mkdirs() }
        val provider = FakeMediaProvider(tmp)
        provider.attachInfo(app, ProviderInfo().apply { authority = MediaStore.AUTHORITY })
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, provider)

        val core = Core::class.java.getDeclaredConstructor(Context::class.java)
            .apply { isAccessible = true }.newInstance(app)
        core.store.saveHosts(listOf(Host("host-1", "Mac", "mac", "192.168.1.2", 443, "fp", "tok", 1L)))
        val instance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        val previous = instance.get(null)
        instance.set(null, core)
        try {
            block(core, provider)
        } finally {
            instance.set(null, previous)
            core.timers.shutdownNow()
            core.bg.shutdownNow()
            tmp.deleteRecursively()
        }
    }

    @Test fun markersUseMonotonicClockAndSendAudioAndTextCompanionAsOneBatch() = withVoiceEnv { core, provider ->
        var elapsed = 50_000L
        provider.audioNameOnPublish = "Voice note renamed by MediaStore.m4a"
        val controller = Robolectric.buildActivity(VoiceNoteActivity::class.java)
        controller.get().elapsedNow = { elapsed }
        controller.get().createRecorder = { FakeMediaRecorder() }
        controller.create()
        shadowOf(Looper.getMainLooper()).idle()
        val dlg = ShadowAlertDialog.getLatestDialog() as AlertDialog
        assertNotNull(dlg)
        assertTrue(dlg.isShowing)

        // Add two markers using monotonic elapsedRealtime; dialog stays open and shows count + last time.
        elapsed = 54_600L
        dlg.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        assertTrue("Add marker keeps dialog open", dlg.isShowing)
        assertEquals("0:04\n1 marker · last at 0:04", shadowOf(dlg).message.toString())

        elapsed = 115_200L
        dlg.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        assertTrue(dlg.isShowing)
        assertEquals("1:05\n2 markers · last at 1:05", shadowOf(dlg).message.toString())

        // Send finalizes .m4a, publishes matching UTF-8 .txt in Downloads/TwinDesk, and queues both in one batch.
        elapsed = 117_000L
        dlg.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()

        val audio = provider.audioEntries().single()
        val marker = provider.downloadEntries().single()
        val audioName = audio.values.getAsString(MediaStore.MediaColumns.DISPLAY_NAME)
        val markerName = marker.values.getAsString(MediaStore.Downloads.DISPLAY_NAME)
        assertEquals(0, audio.values.getAsInteger(MediaStore.MediaColumns.IS_PENDING))
        assertEquals(0, marker.values.getAsInteger(MediaStore.Downloads.IS_PENDING))
        assertEquals("text/plain", marker.values.getAsString(MediaStore.Downloads.MIME_TYPE))
        assertEquals(Environment.DIRECTORY_DOWNLOADS + "/TwinDesk", marker.values.getAsString(MediaStore.Downloads.RELATIVE_PATH))
        assertEquals("Voice note renamed by MediaStore.m4a", audioName)
        assertEquals("Voice note renamed by MediaStore.txt", markerName)
        assertEquals("$audioName\n1. 0:04\n2. 1:05\n", marker.file.readText(Charsets.UTF_8))

        assertEquals(1, core.files.waiting.size)
        val batch = core.files.waiting.single()
        assertEquals(listOf(audio.uri, marker.uri), batch.items.map { it.uri })
        assertEquals(listOf(audioName, markerName), batch.items.map { it.name })
        assertEquals("Waiting for Mac", ShadowToast.getTextOfLatestToast())

        // Recording without markers produces no companion text file.
        core.files.waiting.clear()
        val plain = Robolectric.buildActivity(VoiceNoteActivity::class.java)
        elapsed = 200_000L
        plain.get().elapsedNow = { elapsed }
        plain.get().createRecorder = { FakeMediaRecorder() }
        plain.create()
        shadowOf(Looper.getMainLooper()).idle()
        val plainDlg = ShadowAlertDialog.getLatestDialog() as AlertDialog
        elapsed = 202_500L
        plainDlg.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("no extra marker file when no markers were added", 1, provider.downloadEntries().size)
        assertEquals(1, core.files.waiting.single().items.size)
    }

    @Test fun cancelShortAndPartialMarkerFailurePreserveInvariantsAndGiveFeedback() = withVoiceEnv { core, provider ->
        var elapsed = 10_000L

        // 1. Cancel after adding a marker deletes audio and creates no marker file.
        val cancelled = Robolectric.buildActivity(VoiceNoteActivity::class.java)
        cancelled.get().elapsedNow = { elapsed }
        cancelled.get().createRecorder = { FakeMediaRecorder() }
        cancelled.create()
        shadowOf(Looper.getMainLooper()).idle()
        val cancelDlg = ShadowAlertDialog.getLatestDialog() as AlertDialog
        elapsed = 13_000L
        cancelDlg.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        cancelDlg.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(provider.audioEntries().isEmpty())
        assertTrue(provider.downloadEntries().isEmpty())
        assertTrue(core.files.waiting.isEmpty())

        // 2. Under-1s recording with a marker discards audio and creates no marker file.
        val shortRec = Robolectric.buildActivity(VoiceNoteActivity::class.java)
        elapsed = 20_000L
        shortRec.get().elapsedNow = { elapsed }
        shortRec.get().createRecorder = { FakeMediaRecorder() }
        shortRec.create()
        shadowOf(Looper.getMainLooper()).idle()
        val shortDlg = ShadowAlertDialog.getLatestDialog() as AlertDialog
        elapsed = 20_500L
        shortDlg.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        shortDlg.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(provider.audioEntries().isEmpty())
        assertTrue(provider.downloadEntries().isEmpty())
        assertTrue(core.files.waiting.isEmpty())

        // 3. Partial marker write failure cleans up orphan, preserves .m4a, sends/queues audio, and shows feedback.
        provider.failDownloadsWrite = true
        val partial = Robolectric.buildActivity(VoiceNoteActivity::class.java)
        elapsed = 30_000L
        partial.get().elapsedNow = { elapsed }
        partial.get().createRecorder = { FakeMediaRecorder() }
        partial.create()
        shadowOf(Looper.getMainLooper()).idle()
        val partialDlg = ShadowAlertDialog.getLatestDialog() as AlertDialog
        elapsed = 34_000L
        partialDlg.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        elapsed = 36_000L
        partialDlg.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()

        val preservedAudio = provider.audioEntries().single()
        assertEquals(0, preservedAudio.values.getAsInteger(MediaStore.MediaColumns.IS_PENDING))
        assertTrue("failed companion file must be cleaned up", provider.downloadEntries().isEmpty())
        assertFalse("orphan Downloads entry was deleted", provider.deleted.none { it.toString().contains("/downloads/") })
        assertEquals(1, core.files.waiting.size)
        assertEquals(listOf(preservedAudio.uri), core.files.waiting.single().items.map { it.uri })
        assertEquals("Waiting for Mac (couldn’t save markers)", ShadowToast.getTextOfLatestToast())

        // A published recording that cannot be described must not produce a marker-only batch.
        core.files.waiting.clear()
        provider.failDownloadsWrite = false
        provider.failAudioDescribe = true
        val missingAudio = Robolectric.buildActivity(VoiceNoteActivity::class.java)
        elapsed = 40_000L
        missingAudio.get().elapsedNow = { elapsed }
        missingAudio.get().createRecorder = { FakeMediaRecorder() }
        missingAudio.create()
        shadowOf(Looper.getMainLooper()).idle()
        val missingAudioDlg = ShadowAlertDialog.getLatestDialog() as AlertDialog
        elapsed = 44_000L
        missingAudioDlg.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        missingAudioDlg.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, provider.audioEntries().size)
        assertTrue(provider.downloadEntries().isEmpty())
        assertTrue(core.files.waiting.isEmpty())
    }
}
