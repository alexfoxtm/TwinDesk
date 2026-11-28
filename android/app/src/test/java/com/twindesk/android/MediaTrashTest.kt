// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Media.kt / Hub.kt / Notify.kt: Android 11+ reversible Trash capability, MediaStore trash request,
// notification confirmation ID/wording, on-phone reconciliation, and no silent fallback to delete.
package com.twindesk.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Looper
import android.provider.BaseColumns
import android.provider.MediaStore
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.WebSocket
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.shadows.ShadowEnvironment

@Implements(Environment::class)
class TestEnvironmentShadow : ShadowEnvironment() {
    companion object {
        @JvmStatic var allFilesAccess = false

        @Implementation
        @JvmStatic fun isExternalStorageManager(): Boolean = allFilesAccess
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE, shadows = [TestEnvironmentShadow::class])
class MediaTrashTest {

    @Before fun resetEnv() {
        TestEnvironmentShadow.allFilesAccess = false
    }

    private class FakeMediaProvider(private val ctx: Context) : ContentProvider() {
        data class Item(
            val id: Long,
            val video: Boolean,
            val name: String,
            val bucketId: String = "10",
            val bucketName: String = "Camera",
            var trashed: Int = 0,
        )

        val items = LinkedHashMap<Long, Item>()
        val deletedUris = ArrayList<Uri>()
        val trashRequestCalls = ArrayList<List<Uri>>()
        val deleteRequestCalls = ArrayList<List<Uri>>()
        var failTrashRequest = false

        override fun onCreate() = true
        override fun getType(uri: Uri): String? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

        override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int {
            deletedUris += uri
            val id = runCatching { ContentUris.parseId(uri) }.getOrNull() ?: return 0
            return if (items.remove(id) != null) 1 else 0
        }

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): MatrixCursor {
            val cols = projection ?: arrayOf(BaseColumns._ID)
            val cursor = MatrixCursor(cols)
            val singleId = runCatching { ContentUris.parseId(uri) }.getOrNull()
            val list = if (singleId != null) listOfNotNull(items[singleId]) else items.values.toList()
            for (item in list) {
                val row: Array<Any?> = cols.map { col ->
                    when (col) {
                        BaseColumns._ID -> item.id
                        MediaStore.Files.FileColumns.MEDIA_TYPE ->
                            if (item.video) MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO else MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
                        MediaStore.MediaColumns.DATE_ADDED -> 1_700_000_000L + item.id
                        MediaStore.MediaColumns.DATE_TAKEN -> (1_700_000_000L + item.id) * 1000L
                        MediaStore.MediaColumns.WIDTH -> 1200
                        MediaStore.MediaColumns.HEIGHT -> 900
                        MediaStore.MediaColumns.SIZE -> 1024L
                        MediaStore.MediaColumns.DISPLAY_NAME -> item.name
                        MediaStore.MediaColumns.DURATION -> 0L
                        MediaStore.MediaColumns.BUCKET_ID -> item.bucketId
                        MediaStore.MediaColumns.BUCKET_DISPLAY_NAME -> item.bucketName
                        MediaStore.MediaColumns.ORIENTATION -> 0
                        MediaStore.MediaColumns.IS_TRASHED -> item.trashed
                        else -> null
                    }
                }.toTypedArray()
                cursor.addRow(row)
            }
            return cursor
        }

        @Suppress("DEPRECATION")
        override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
            val uris = extras?.getParcelableArrayList<Uri>("uri_list")
                ?: extras?.getParcelable<android.content.ClipData>("clip_data")?.let { cd ->
                    (0 until cd.itemCount).mapNotNull { cd.getItemAt(it).uri }
                }
                ?: emptyList()
            if (method == "create_trash_request") {
                trashRequestCalls += uris
                if (failTrashRequest) throw SecurityException("simulated trash failure")
                val pi = PendingIntent.getActivity(ctx, 101, Intent("fixture.TRASH"), PendingIntent.FLAG_IMMUTABLE)
                return Bundle().apply { putParcelable("result", pi) }
            }
            if (method == "create_delete_request") {
                deleteRequestCalls += uris
                val pi = PendingIntent.getActivity(ctx, 102, Intent("fixture.DELETE"), PendingIntent.FLAG_IMMUTABLE)
                return Bundle().apply { putParcelable("result", pi) }
            }
            return super.call(method, arg, extras)
        }
    }

    private fun core() = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(RuntimeEnvironment.getApplication())

    private fun Any.write(name: String, value: Any?) {
        javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
    }

    private fun socket(sent: MutableList<JSONObject>) = Proxy.newProxyInstance(
        WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java),
    ) { self, method, args ->
        when (method.name) {
            "hashCode" -> System.identityHashCode(self)
            "equals" -> self === args[0]
            "send" -> { sent += JSONObject(args[0] as String); true }
            else -> error(method.name)
        }
    } as WebSocket

    private fun connect(core: Core, ws: WebSocket) {
        core.link.write("ws", ws)
        core.link.write("host", Host("fixture", "Studio Mac", "mac", "192.0.2.1", 47800, "fixture-pin", "fixture-token", 0))
        core.link.write("state", "connected")
    }

    private fun registerMediaProvider(app: Context): FakeMediaProvider {
        val provider = FakeMediaProvider(app)
        provider.attachInfo(app, ProviderInfo().apply { authority = MediaStore.AUTHORITY })
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, provider)
        return provider
    }

    private fun lastOf(out: List<JSONObject>, type: String): JSONObject =
        out.lastOrNull { it.optString("t") == type }
            ?: throw AssertionError("No '$type' in out=$out logs=${org.robolectric.shadows.ShadowLog.getLogs().map { "${it.tag}:${it.msg}:\n${it.throwable?.stackTraceToString()}" }}")

    @Test fun android11AdvertisesTrashUsesSystemTrashRequestAndReconcilesAfterConsent() {
        val app = RuntimeEnvironment.getApplication()
        shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        val provider = registerMediaProvider(app)
        provider.items[10L] = FakeMediaProvider.Item(10L, false, "IMG_10.jpg")
        provider.items[20L] = FakeMediaProvider.Item(20L, true, "VID_20.mp4")

        val core = core()
        val out = mutableListOf<JSONObject>()
        val ws = socket(out)
        connect(core, ws)
        val worker = Executors.newSingleThreadExecutor()
        core.hub.write("io", worker)
        fun drain() {
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
        }

        try {
            val route = core.link.currentTrustedRoute()
            core.onMessage(msg(Proto.T.HUB_POLICY, "media" to true), route, ws)
            drain()

            // Capability advertised in hub.state on Android 11+.
            val state = lastOf(out, Proto.T.HUB_STATE)
            assertTrue("Android 11+ advertises media.trash", state.getJSONObject("media").optBoolean("trash"))

            // Request Trash for 2 items even with All files access enabled: uses MediaStore.createTrashRequest,
            // never cr.delete, and does not mark gone yet.
            TestEnvironmentShadow.allFilesAccess = true
            core.onMessage(
                msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10", "v20")), "action" to "trash"),
                route, ws,
            )
            drain()

            assertEquals(1, provider.trashRequestCalls.size)
            assertEquals(2, provider.trashRequestCalls[0].size)
            assertTrue("Trash must never call cr.delete directly", provider.deletedUris.isEmpty())
            assertTrue("Trash must never fall back to createDeleteRequest", provider.deleteRequestCalls.isEmpty())

            val immediate = lastOf(out, Proto.T.MEDIA_DELETE)
            assertEquals("trash", immediate.optString("action"))
            assertEquals(0, immediate.getJSONArray("ids").length())
            assertEquals(2, immediate.optInt("confirm"))
            assertEquals(0, immediate.optInt("failed"))

            // Notification uses distinct audited ID and accurate Move to Trash wording.
            assertNotEquals(Notify.ID_MEDIA_DEL, Notify.ID_MEDIA_TRASH)
            assertNotEquals(20, Notify.ID_MEDIA_TRASH) // PcMedia uses ID 20
            val nm = shadowOf(app.getSystemService(NotificationManager::class.java))
            val note = nm.getNotification(Notify.ID_MEDIA_TRASH)
            assertNotNull("Trash confirmation notification posted", note)
            assertEquals("Move 2 photos and videos to Trash?", note.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
            assertEquals("Studio Mac asks to move them to Trash on this phone. Tap to confirm.", note.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())

            // Before user consents on phone, MediaStore notifyChange with active rows marks nothing gone.
            val beforeCount = out.size
            app.contentResolver.notifyChange(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, null)
            shadowOf(Looper.getMainLooper()).idleFor(400, TimeUnit.MILLISECONDS)
            drain()
            assertEquals("unconfirmed items stay active", beforeCount, out.size)

            // User approves on-phone Trash dialog: MediaStore marks IS_TRASHED=1 and notifies observers.
            provider.items[10L]!!.trashed = 1
            app.contentResolver.notifyChange(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, null)
            shadowOf(Looper.getMainLooper()).idleFor(400, TimeUnit.MILLISECONDS)
            drain()

            val reconciled = lastOf(out, Proto.T.MEDIA_DELETE)
            assertEquals("trash", reconciled.optString("action"))
            assertEquals(listOf("i10"), listOf(reconciled.getJSONArray("ids").getString(0)))
            assertEquals(0, reconciled.optInt("confirm"))

            // Refreshed media.list and media.albums exclude trashed items.
            core.onMessage(msg(Proto.T.MEDIA_LIST, "kind" to "all"), route, ws)
            core.onMessage(msg(Proto.T.MEDIA_ALBUMS), route, ws)
            drain()
            val listReply = lastOf(out, Proto.T.MEDIA_LIST)
            assertEquals(1, listReply.getJSONArray("items").length())
            assertEquals("v20", listReply.getJSONArray("items").getJSONObject(0).getString("id"))
            val albumsReply = lastOf(out, Proto.T.MEDIA_ALBUMS)
            assertEquals(1, albumsReply.getJSONArray("items").getJSONObject(0).getInt("n"))
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun trashFailureMissingPermOverLimitOrStaleRouteNeverFallsBackToPermanentDelete() {
        val app = RuntimeEnvironment.getApplication()
        val provider = registerMediaProvider(app)
        provider.items[10L] = FakeMediaProvider.Item(10L, false, "IMG_10.jpg")

        val core = core()
        val out = mutableListOf<JSONObject>()
        val ws = socket(out)
        connect(core, ws)
        val worker = Executors.newSingleThreadExecutor()
        core.hub.write("io", worker)
        fun drain() {
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
        }

        try {
            val route = core.link.currentTrustedRoute()
            core.onMessage(msg(Proto.T.HUB_POLICY, "media" to true, "files" to true), route, ws)
            drain()

            // 1. Missing media permission: refused without touching MediaStore.
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to "trash"), route, ws)
            drain()
            assertEquals(1, lastOf(out, Proto.T.MEDIA_DELETE).optInt("failed"))
            assertTrue(provider.trashRequestCalls.isEmpty() && provider.deletedUris.isEmpty())

            // Grant media permission, but simulate system createTrashRequest failure.
            shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
            provider.failTrashRequest = true
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to "trash"), route, ws)
            drain()
            val failReply = lastOf(out, Proto.T.MEDIA_DELETE)
            assertEquals("trash", failReply.optString("action"))
            assertEquals(0, failReply.getJSONArray("ids").length())
            assertEquals(0, failReply.optInt("confirm"))
            assertEquals(1, failReply.optInt("failed"))
            assertTrue("system Trash failure must never fall back to cr.delete", provider.deletedUris.isEmpty())
            assertTrue("system Trash failure must never fall back to createDeleteRequest", provider.deleteRequestCalls.isEmpty())

            // 2. >300 IDs and unknown action: rejected without touching MediaStore.
            provider.failTrashRequest = false
            val over300 = JSONArray((1..301).map { "i$it" })
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to over300, "action" to "trash"), route, ws)
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to "purge"), route, ws)
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to JSONObject.NULL), route, ws)
            drain()
            assertEquals(1, provider.trashRequestCalls.size) // only the earlier failed call
            assertTrue(provider.deletedUris.isEmpty() && provider.deleteRequestCalls.isEmpty())

            // 3. Stale route and queued request after media turned off: never executes.
            val staleRoute = Link.TrustedRoute(Any(), "fixture", "fixture-pin")
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to "trash"), staleRoute, ws)
            val gate = CountDownLatch(1)
            worker.execute { gate.await(5, TimeUnit.SECONDS) }
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to "trash"), route, ws)
            core.onMessage(msg(Proto.T.HUB_POLICY, "media" to false, "files" to true), route, ws)
            shadowOf(Looper.getMainLooper()).idle()
            gate.countDown()
            drain()
            assertEquals(1, provider.trashRequestCalls.size)
            assertTrue(provider.deletedUris.isEmpty() && provider.deleteRequestCalls.isEmpty())

            // 4. Explicit legacy remove (no action) still uses createDeleteRequest when media is on.
            core.onMessage(msg(Proto.T.HUB_POLICY, "media" to true), route, ws)
            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10"))), route, ws)
            drain()
            assertEquals(1, provider.deleteRequestCalls.size)
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test @Config(sdk = [29])
    fun android10DoesNotAdvertiseTrashAndRefusesTrashWithoutFallback() {
        val app = RuntimeEnvironment.getApplication()
        shadowOf(app).grantPermissions(Manifest.permission.READ_EXTERNAL_STORAGE)
        val provider = registerMediaProvider(app)
        provider.items[10L] = FakeMediaProvider.Item(10L, false, "IMG_10.jpg")

        val core = core()
        val out = mutableListOf<JSONObject>()
        val ws = socket(out)
        connect(core, ws)
        val worker = Executors.newSingleThreadExecutor()
        core.hub.write("io", worker)
        fun drain() {
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
        }
        try {
            val route = core.link.currentTrustedRoute()
            core.onMessage(msg(Proto.T.HUB_POLICY, "media" to true), route, ws)
            drain()
            val state = out.last { it.optString("t") == Proto.T.HUB_STATE }
            assertFalse("Android 10 must not advertise media.trash", state.getJSONObject("media").optBoolean("trash"))

            core.onMessage(msg(Proto.T.MEDIA_DELETE, "ids" to JSONArray(listOf("i10")), "action" to "trash"), route, ws)
            drain()
            val reply = out.last { it.optString("t") == Proto.T.MEDIA_DELETE }
            assertEquals("trash", reply.optString("action"))
            assertEquals(1, reply.optInt("failed"))
            assertTrue("Android 10 Trash request must never fall back to cr.delete", provider.deletedUris.isEmpty())
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }
}
