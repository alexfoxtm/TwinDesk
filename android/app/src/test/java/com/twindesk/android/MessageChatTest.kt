package com.twindesk.android

import android.app.Notification
import android.app.PendingIntent
import android.app.Person
import android.app.RemoteInput
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.graphics.drawable.Icon
import java.lang.reflect.Proxy
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.WebSocket
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MessageChatTest {
    @Test fun projectsOnlyGoogleAndSamsungChildMessageNotifications() {
        val app = RuntimeEnvironment.getApplication()
        fun builder() = Notification.Builder(app, "fixture").setCategory(Notification.CATEGORY_MESSAGE)
        val intent = PendingIntent.getBroadcast(app, 1, Intent("fixture.reply").setPackage(app.packageName), PendingIntent.FLAG_MUTABLE)
        val action = Notification.Action.Builder(null as Icon?, "Reply", intent)
            .setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
            .addRemoteInput(RemoteInput.Builder("reply").build()).build()
        val noStyle = builder().build()
        fun style() = Notification.MessagingStyle(Person.Builder().setName("Fixture self").build())
            .addMessage("Fixture body", 1234, Person.Builder().setName("Fixture peer").build())
        val noReply = builder().setStyle(style()).build()
        val notification = builder().setStyle(style()).addAction(action).build()
        val summary = builder().setStyle(style()).setGroup("fixture").setGroupSummary(true).build()
        val service = builder().setStyle(style()).setCategory(Notification.CATEGORY_SERVICE).build()
        for (pkg in listOf("com.google.android.apps.messaging", "com.samsung.android.messaging")) {
            assertTrue(MessageChat.projects(pkg, notification, busy = false))
            assertFalse(MessageChat.projects(pkg, notification, busy = true))
            assertFalse(MessageChat.projects(pkg, noStyle, busy = false))
            assertFalse(MessageChat.projects(pkg, summary, busy = false))
        }
        assertFalse(MessageChat.projects("com.android.mms", notification, busy = false))
        assertFalse(MessageChat.projects("com.google.android.apps.messaging", service, busy = false))
        assertNull(MessageChat.reply(noReply))
        val (actual, input) = MessageChat.reply(notification)!!
        assertEquals(intent, actual.actionIntent)
        assertEquals("reply", input.resultKey)
    }

    @Test fun delayedCarrierRowsOnlyHideUnambiguousExactCorrespondence() {
        val match = MessageChat.fingerprint("+1 (202) 555-0100", false, "Fixture\r\nmessage")!!
        assertEquals(match, MessageChat.fingerprint("+12025550100", false, "Fixture\nmessage"))
        assertNull(MessageChat.fingerprint("Fixture contact", false, "Fixture\nmessage"))
        val first = MessageChat.Candidate("first", 10021, match)
        val second = MessageChat.Candidate("second", 10082, match)
        val candidates = listOf(first, second)
        val mms = MessageChat.Row(10000, match, mms = true)
        val sms = MessageChat.Row(10021, match, mms = false)
        assertEquals(emptyList<String>(), MessageChat.matches(candidates, emptyList()))
        assertEquals(listOf("first"), MessageChat.matches(candidates, listOf(sms)))
        val national = MessageChat.fingerprint("2025550100", false, "Fixture\nmessage")!!
        val aliased = sms.copy(match = national, normalizedMatch = match)
        assertEquals(listOf("first"), MessageChat.matches(candidates, listOf(aliased)))
        assertEquals(emptyList<String>(), MessageChat.matches(listOf(first, first.copy(id = "legacy", match = national)), listOf(aliased)))
        assertEquals(emptyList<String>(), MessageChat.matches(candidates, listOf(mms)))
        assertEquals(listOf("first"), MessageChat.matches(listOf(first), listOf(mms)))
        assertEquals(emptyList<String>(), MessageChat.matches(listOf(first), listOf(mms, sms)))
        val wrongDestination = MessageChat.fingerprint("+12025550101", false, "Fixture\nmessage")!!
        val wrongDirection = MessageChat.fingerprint("+12025550100", true, "Fixture\nmessage")!!
        val wrongBody = MessageChat.fingerprint("+12025550100", false, "Other fixture")!!
        assertEquals(emptyList<String>(), MessageChat.matches(candidates, listOf(
            sms.copy(match = wrongDestination), sms.copy(match = wrongDirection), sms.copy(match = wrongBody),
            sms.copy(at = 10022),
        )))
    }

    @Test fun incomingMmsAddressUsesTheThreadPeerWhenAddrRowsIncludeTheUser() {
        val from = "+1 (202) 555-0100"
        val peer = "2025550100"
        val own = "+12025550999"
        // The addr list for an incoming 1:1 MMS is [from] plus type-151 "to" rows (often the user).
        assertNull(listOf(from, own).singleOrNull())
        assertEquals("+12025550100", MessageChat.destination(MessageChat.incomingMmsAddress(from, peer, "US")))
        assertEquals(MessageChat.fingerprint(from, false, "Fixture MMS"), MessageChat.fingerprint(MessageChat.incomingMmsAddress(from, peer, "US"), false, "Fixture MMS"))
        assertNull(MessageChat.incomingMmsAddress(from, peer))
        assertNull(MessageChat.incomingMmsAddress(from, "+442025550100", "US"))
        assertNull(MessageChat.incomingMmsAddress(from, null))
        assertNull(MessageChat.incomingMmsAddress(from, own))
        assertNull(MessageChat.incomingMmsAddress(null, peer))
        assertNull(MessageChat.incomingMmsAddress("Fixture contact", peer))
    }
    private fun core() = Core::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(RuntimeEnvironment.getApplication())

    private fun Any.write(name: String, value: Any?) {
        javaClass.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
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

    @Test fun fallbackMmsScanUsesOnlyTheIncomingSenderForOneToOneIdentity() {
        val core = core()
        val service = Messages(core.hub, core)
        val sender = "+12025550100"
        val own = "+12025550101"
        var includeFrom = true
        var group = false
        provider("mms-sms") { _, _ -> null }
        provider("sms") { _, cols -> MatrixCursor(cols) }
        provider("mms") { uri, cols ->
            MatrixCursor(cols).apply {
                when (uri.lastPathSegment) {
                    null -> addRow(arrayOf(7, 8, 100, 1, 1))
                    "addr" -> {
                        if (includeFrom) addRow(arrayOf<Any>(sender, 137))
                        addRow(arrayOf<Any>(own, 151))
                        if (group) addRow(arrayOf<Any>("+12025550102", 151))
                    }
                }
            }
        }
        fun row() = service.threads(10, "US").getJSONObject(0)
        assertTrue(row().optString("e164") == sender)
        group = true
        assertTrue(row().optBoolean("group"))
        assertFalse(row().has("e164"))
        group = false
        includeFrom = false
        assertEquals(0, row().getJSONArray("addrs").length())
        assertFalse(row().has("e164"))
    }

    @Test fun carrierHistoryResultStaysOnItsOriginatingSocket() {
        val core = core()
        val worker = Executors.newSingleThreadExecutor()
        val first = mutableListOf<String>()
        val replacement = mutableListOf<String>()
        fun socket(types: MutableList<String>) = Proxy.newProxyInstance(
            WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)
        ) { self, method, args ->
            when (method.name) {
                "hashCode" -> System.identityHashCode(self)
                "equals" -> self === args[0]
                "send" -> { types += JSONObject(args[0] as String).optString("t"); true }
                else -> error(method.name)
            }
        } as WebSocket
        val original = socket(first)
        val next = socket(replacement)
        var replaceDuringRead = false
        provider("sms") { _, cols ->
            if (replaceDuringRead) core.link.write("ws", next)
            MatrixCursor(cols)
        }
        provider("mms") { _, cols -> MatrixCursor(cols) }
        core.hub.write("io", worker)
        core.hub.write("messagesOn", true)
        core.hub.write("messages", Messages(core.hub, core))
        core.link.write("ws", original)
        core.link.write("host", Host("fixture", "Fixture", "mac", "192.0.2.1", 47800, "fixture-pin", "fixture-token", 0))
        core.link.write("state", "connected")
        fun read() {
            core.onMessage(msg(Proto.T.SMS_THREAD, "id" to "7"), core.link.currentTrustedRoute(), original)
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
        }
        try {
            read()
            assertEquals(listOf(Proto.T.SMS_THREAD), first)
            replaceDuringRead = true
            read()
            assertEquals(1, first.size)
            assertEquals(0, replacement.size)
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

}
