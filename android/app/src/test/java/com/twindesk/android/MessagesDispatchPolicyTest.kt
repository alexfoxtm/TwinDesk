// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages.kt / Hub.kt: carrier dispatch is bound to the Messages policy in force, groups are sent to
// everyone or nobody, and sms.new emits each distinct row once (synthetic fixtures only).
package com.twindesk.android

import android.Manifest
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.WebSocket
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MessagesDispatchPolicyTest {
    private fun core() = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(RuntimeEnvironment.getApplication())

    private fun Any.write(name: String, value: Any?) {
        javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
    }

    private fun Any.read(name: String): Any? = javaClass.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun socket(sent: MutableList<JSONObject>) = Proxy.newProxyInstance(
        WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)
    ) { self, method, args ->
        when (method.name) {
            "hashCode" -> System.identityHashCode(self)
            "equals" -> self === args[0]
            "send" -> { sent += JSONObject(args[0] as String); true }
            else -> error(method.name)
        }
    } as WebSocket

    private fun connect(core: Core, socket: WebSocket) {
        core.link.write("ws", socket)
        core.link.write("host", Host("fixture", "Fixture", "mac", "192.0.2.1", 47800, "fixture-pin", "fixture-token", 0))
        core.link.write("state", "connected")
    }

    private fun provider(authority: String, query: (Uri, Array<out String>) -> MatrixCursor?) {
        val fixture = object : ContentProvider() {
            override fun onCreate() = true
            override fun getType(uri: Uri): String? = null
            override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
            override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
            override fun insert(uri: Uri, values: ContentValues?): Uri? = null
            override fun query(uri: Uri, cols: Array<out String>?, selection: String?, args: Array<out String>?, order: String?) =
                query(uri, requireNotNull(cols))
        }
        fixture.attachInfo(RuntimeEnvironment.getApplication(), android.content.pm.ProviderInfo().apply { this.authority = authority })
        ShadowContentResolver.registerProviderInternal(authority, fixture)
    }

    // The app's FileProvider hands MMS PDUs to the carrier. Robolectric cannot parse its manifest
    // paths, so the fixture seeds FileProvider's own path cache for that authority.
    @Suppress("UNCHECKED_CAST")
    private fun fileProvider() {
        val authority = RuntimeEnvironment.getApplication().packageName + ".files"
        val strategy = Class.forName("androidx.core.content.FileProvider\$PathStrategy")
        val paths = Proxy.newProxyInstance(strategy.classLoader, arrayOf(strategy)) { _, method, args ->
            when (method.name) {
                "getUriForFile" -> Uri.parse("content://$authority/mms/" + (args[0] as java.io.File).name)
                "getFileForUri" -> null
                else -> error(method.name)
            }
        }
        val cache = androidx.core.content.FileProvider::class.java.getDeclaredField("sCache")
            .apply { isAccessible = true }.get(null) as HashMap<String, Any>
        synchronized(cache) { cache[authority] = paths }
    }

    @Suppress("UNCHECKED_CAST")
    private fun dispatched(service: Any): Map<String, Any> = service.read("sendRoutes") as Map<String, Any>

    @Test fun queuedGroupMmsNeverReachesTheCarrierAfterMessagesIsSwitchedOffOnTheSameSocket() {
        val core = core()
        fileProvider()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS)
        provider("sms") { _, cols -> MatrixCursor(cols) }
        provider("mms") { _, cols -> MatrixCursor(cols) }
        provider("mms-sms") { _, cols -> MatrixCursor(cols) }
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
            core.onMessage(msg(Proto.T.HUB_POLICY, "messages" to true, "files" to true), core.link.currentTrustedRoute(), ws)
            drain()
            val first = core.hub.read("messages")!!
            // Hold the worker so the group MMS is queued, then switch Messages off on the same socket.
            val gate = CountDownLatch(1)
            worker.execute { gate.await(5, TimeUnit.SECONDS) }
            core.onMessage(msg(Proto.T.SMS_SEND, "to" to "+12025550100", "body" to "Synthetic group", "ref" to "r-queued",
                "addrs" to JSONArray(listOf("+12025550100", "+12025550101"))), core.link.currentTrustedRoute(), ws)
            core.onMessage(msg(Proto.T.HUB_POLICY, "messages" to false, "files" to true), core.link.currentTrustedRoute(), ws)
            shadowOf(Looper.getMainLooper()).idle()
            assertNull("Messages is off", core.hub.read("messages"))
            assertNotNull("Files keeps the worker alive", core.hub.read("io"))
            gate.countDown()
            drain()
            assertFalse("the queued group MMS reached carrier dispatch after Messages was switched off", "r-queued" in dispatched(first))

            // The same request with Messages still on does reach dispatch (the fixture is otherwise able to send).
            core.onMessage(msg(Proto.T.HUB_POLICY, "messages" to true, "files" to true), core.link.currentTrustedRoute(), ws)
            drain()
            val live = core.hub.read("messages")!!
            core.onMessage(msg(Proto.T.SMS_SEND, "to" to "+12025550100", "body" to "Synthetic group", "ref" to "r-live",
                "addrs" to JSONArray(listOf("+12025550100", "+12025550101"))), core.link.currentTrustedRoute(), ws)
            drain()
            assertTrue("control: a current Messages instance dispatches: $out", "r-live" in dispatched(live))
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun aRetiredMessagesInstanceCannotDispatchEvenOnTheSameSocket() {
        val core = core()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.SEND_SMS)
        val out = mutableListOf<JSONObject>()
        val ws = socket(out)
        connect(core, ws)
        val route = core.link.currentTrustedRoute()
        val retired = Messages(core.hub, core, route)
        core.hub.write("messagesOn", true)
        core.hub.write("messages", Messages(core.hub, core, route))
        try {
            retired.send(msg(Proto.T.SMS_SEND, "to" to "+12025550100", "body" to "Synthetic", "ref" to "r-retired"), route)
            assertTrue(dispatched(retired).isEmpty())
            assertTrue("a retired instance says nothing", out.isEmpty())
        } finally {
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun anOversizedOrUnresolvedGroupIsRefusedNeverCutDown() {
        val address = { v: String -> v.filter { it.isDigit() || it in "+*#" }.ifEmpty { v.trim() } }
        val twenty = (0 until 20).map { "+1202555%04d".format(it) }
        assertEquals(20, Messages.groupAddresses(twenty, address)!!.size)
        assertNull("21 members are refused", Messages.groupAddresses(twenty + "+12025559999", address))
        assertNull("a member without an address is refused", Messages.groupAddresses(listOf("+12025550100", " "), address))
        assertEquals(emptyList<String>(), Messages.groupAddresses(emptyList(), address))

        val core = core()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.SEND_SMS)
        val out = mutableListOf<JSONObject>()
        val ws = socket(out)
        connect(core, ws)
        val route = core.link.currentTrustedRoute()
        val worker = Executors.newSingleThreadExecutor()
        core.hub.write("io", worker)
        core.hub.write("messagesOn", true)
        val service = Messages(core.hub, core, route)
        core.hub.write("messages", service)
        try {
            core.onMessage(msg(Proto.T.SMS_SEND, "to" to twenty[0], "body" to "Synthetic group", "ref" to "r-big",
                "addrs" to JSONArray(twenty + "+12025559999")), route, ws)
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
            assertTrue("never dispatched to a 20-member subset", dispatched(service).isEmpty())
            val result = out.single { it.optString("t") == Proto.T.SMS_SENT }
            assertEquals("r-big", result.optString("ref"))
            assertFalse(result.optBoolean("ok"))
            assertEquals(Messages.GROUP_REFUSED, result.optString("error"))
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun watermarkAdmitsDistinctRowsSharingATimeOnce() {
        val w = CarrierWatermark()
        w.reset(1000)
        assertTrue(w.admit("s1", 1000))
        assertFalse("seeded rows are not news again", w.admit("s1", 1000))
        assertTrue("a distinct row at the same time", w.admit("m1", 1000))
        assertFalse("an older row", w.admit("s0", 999))
        assertTrue(w.admit("s2", 2000))
        assertTrue("another distinct row at the new time", w.admit("s3", 2000))
        assertFalse("never re-emitted", w.admit("s2", 2000))
        assertFalse("never re-emitted after a later row", w.admit("s1", 1000))
        assertEquals(2000, w.at)
    }

    @Test fun carrierRowsSharingATimestampEachReachOnlyTheirRouteOnce() {
        val core = core()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS)
        val worker = Executors.newSingleThreadExecutor()
        val first = mutableListOf<JSONObject>()
        val replacement = mutableListOf<JSONObject>()
        val original = socket(first)
        val next = socket(replacement)
        // _id, address, body, date, type, thread_id. The store starts with one row at 1000.
        val rows = mutableListOf(arrayOf<Any>(1L, "+12025550100", "Synthetic seed", 1000L, 1, 7L))
        provider("sms") { _, cols ->
            MatrixCursor(cols).apply {
                if (cols.size == 1) addRow(arrayOf<Any>(rows.maxOf { it[3] as Long }))
                else rows.forEach { addRow(it) }
            }
        }
        provider("mms") { _, cols -> MatrixCursor(cols) }
        provider("mms-sms") { _, cols -> MatrixCursor(cols) }
        core.hub.write("io", worker)
        connect(core, original)
        fun drain() {
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
        }
        try {
            core.onMessage(msg(Proto.T.HUB_POLICY, "messages" to true), core.link.currentTrustedRoute(), original)
            drain()
            val service = core.hub.read("messages")!!
            val check = Messages::class.java.getDeclaredMethod("check").apply { isAccessible = true }
            fun news(list: List<JSONObject>) = list.filter { it.optString("t") == Proto.T.SMS_NEW }.map { it.getJSONObject("msg").optString("id") }
            rows += arrayOf<Any>(2L, "+12025550100", "Synthetic one", 2000L, 1, 7L)
            rows += arrayOf<Any>(3L, "+12025550101", "Synthetic two", 2000L, 1, 8L)
            worker.submit { check.invoke(service) }.get(5, TimeUnit.SECONDS)
            assertEquals("both distinct rows sharing a time are told, the seed is not", listOf("s2", "s3"), news(first))
            worker.submit { check.invoke(service) }.get(5, TimeUnit.SECONDS)
            assertEquals("nothing is told twice", listOf("s2", "s3"), news(first))
            rows += arrayOf<Any>(4L, "+12025550102", "Synthetic late", 2000L, 1, 9L)
            worker.submit { check.invoke(service) }.get(5, TimeUnit.SECONDS)
            assertEquals("a row written later at the same time still goes", listOf("s2", "s3", "s4"), news(first))
            core.link.write("ws", next)
            rows += arrayOf<Any>(5L, "+12025550100", "Synthetic after", 3000L, 1, 7L)
            worker.submit { check.invoke(service) }.get(5, TimeUnit.SECONDS)
            assertTrue("a replacement link gets none of this observer's rows", news(replacement).isEmpty())
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    // The scan fallback has no trustworthy handset line identity, so an inbound group is withheld
    // and marked unresolved (the computer refuses it) instead of listing a subset or the handset.
    @Test fun anInboundGroupWithoutHandsetEvidenceIsUnresolvedNeverASubset() {
        val core = core()
        val service = Messages(core.hub, core)
        val sender = "+12025550100"
        provider("mms-sms") { _, _ -> null }
        provider("sms") { _, cols -> MatrixCursor(cols) }
        provider("mms") { uri, cols ->
            MatrixCursor(cols).apply {
                when (uri.lastPathSegment) {
                    null -> addRow(arrayOf(7, 8, 100, 1, 1))
                    "addr" -> {
                        addRow(arrayOf<Any>(sender, 137))
                        for (to in listOf("+12025550101", "+12025550102", "+12025550103")) addRow(arrayOf<Any>(to, 151))
                    }
                }
            }
        }
        try {
            val row = service.threads(10, "US").getJSONObject(0)
            assertTrue(row.optBoolean("group"))
            assertTrue("a withheld inbound group is unresolved", row.optBoolean("unresolved"))
            assertEquals("no recipient subset is published", 0, row.getJSONArray("addrs").length())
            assertFalse(row.has("e164"))
        } finally {
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }
}
