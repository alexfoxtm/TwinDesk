package com.twindesk.android

import android.Manifest
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

    @Test fun inboundGroupMmsFallbackExcludesOnlyATrustworthyHandset() {
        val from = "+12025550100"
        val handset = "+1 (202) 555-0101"
        val other = "2025550102"
        val third = "+12025550103"
        val secondLine = "+12025550104"
        val recipients = listOf(handset, other, third, secondLine)
        fun same(expected: List<String>, actual: List<String>) = assertTrue(actual == expected)
        same(emptyList(), MessageChat.incomingMmsParticipants(from, recipients, "US"))
        same(emptyList(), MessageChat.incomingMmsParticipants(from, recipients, "US", listOf("not-a-number")))
        same(emptyList(), MessageChat.incomingMmsParticipants(from, recipients, "US", listOf("+12025550109")))
        same(emptyList(), MessageChat.incomingMmsParticipants(from, recipients, "US", listOf("2025550101", "office")))
        same(emptyList(), MessageChat.incomingMmsParticipants(from, recipients, "US", listOf(from)))
        same(listOf(from, other, third, secondLine), MessageChat.incomingMmsParticipants(from, recipients, "US", listOf("2025550101")))
        same(listOf(from, other, third), MessageChat.incomingMmsParticipants(from, recipients, "US", listOf("+12025550101", secondLine)))
        same(emptyList(), MessageChat.incomingMmsParticipants("", recipients, "US", listOf(handset)))
        same(emptyList(), MessageChat.incomingMmsParticipants(from, listOf(from, other), "US", listOf(handset)))
        same(listOf(from), MessageChat.incomingMmsParticipants(from, listOf(handset), "US"))
        same(listOf(from), MessageChat.incomingMmsParticipants(from, listOf(handset), "US", listOf("2025550101")))
        same(listOf(from), MessageChat.incomingMmsParticipants(from, emptyList(), "US"))
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
        val grouped = row()
        assertTrue(grouped.optBoolean("group"))
        assertFalse(grouped.has("e164"))
        // No handset evidence is available on this fallback, so the row must not
        // publish a recipient set that still contains the handset.
        assertEquals(0, grouped.getJSONArray("addrs").length())
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

    private fun fixtureSocket(types: MutableList<String>) = Proxy.newProxyInstance(
        WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)
    ) { self, method, args ->
        when (method.name) {
            "hashCode" -> System.identityHashCode(self)
            "equals" -> self === args[0]
            "send" -> { types += JSONObject(args[0] as String).optString("t"); true }
            else -> error(method.name)
        }
    } as WebSocket

    private fun connect(core: Core, socket: WebSocket) {
        core.link.write("ws", socket)
        core.link.write("host", Host("fixture", "Fixture", "mac", "192.0.2.1", 47800, "fixture-pin", "fixture-token", 0))
        core.link.write("state", "connected")
    }

    @Test fun carrierSendDispatchesOnlyOnItsAuthenticatedRoute() {
        val core = core()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.SEND_SMS)
        val first = mutableListOf<String>()
        val replacement = mutableListOf<String>()
        val original = fixtureSocket(first)
        val next = fixtureSocket(replacement)
        connect(core, original)
        val route = core.link.currentTrustedRoute()
        core.hub.write("messagesOn", true)
        core.hub.write("messages", Messages(core.hub, core))
        fun send(ref: String) = core.onMessage(msg(Proto.T.SMS_SEND, "to" to "+12025550100", "body" to "Synthetic", "ref" to ref), route, original)
        try {
            // A replacement link takes over before the queued request runs: no dispatch, no output anywhere.
            send("r-replaced")
            core.link.write("ws", next)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(replacement.isEmpty())
            assertTrue(first.isEmpty())
            // The initiating route reaches dispatch, and its result (here: no SMS service) goes only to it.
            core.link.write("ws", original)
            send("r-current")
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(listOf(Proto.T.SMS_SENT), first)
            assertTrue(replacement.isEmpty())
        } finally {
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun carrierObserverResultsStayOnTheirRoute() {
        val core = core()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS)
        val worker = Executors.newSingleThreadExecutor()
        val first = mutableListOf<String>()
        val replacement = mutableListOf<String>()
        val original = fixtureSocket(first)
        val next = fixtureSocket(replacement)
        var latest = 1000L
        provider("sms") { _, cols ->
            MatrixCursor(cols).apply {
                if (cols.size == 1) addRow(arrayOf<Any>(1000L))
                else addRow(arrayOf<Any>(latest, "+12025550100", "Synthetic", latest, 1, 7L))
            }
        }
        provider("mms") { _, cols -> MatrixCursor(cols) }
        core.hub.write("io", worker)
        connect(core, original)
        fun drain() {
            shadowOf(Looper.getMainLooper()).idle()
            worker.submit {}.get(5, TimeUnit.SECONDS)
        }
        try {
            core.onMessage(msg(Proto.T.HUB_POLICY, "messages" to true), core.link.currentTrustedRoute(), original)
            drain()
            val field = core.hub.javaClass.getDeclaredField("messages").apply { isAccessible = true }
            val service = field.get(core.hub)
            assertNotNull(service)
            core.onMessage(msg(Proto.T.HUB_POLICY, "messages" to true), core.link.currentTrustedRoute(), original)
            drain()
            assertSame("a repeated policy on the same route keeps the running observer", service, field.get(core.hub))
            val check = Messages::class.java.getDeclaredMethod("check").apply { isAccessible = true }
            latest = 2000L
            worker.submit { check.invoke(service) }.get(5, TimeUnit.SECONDS)
            assertTrue(Proto.T.SMS_NEW in first)
            core.link.write("ws", next)
            latest = 3000L
            worker.submit { check.invoke(service) }.get(5, TimeUnit.SECONDS)
            assertFalse("a replacement link received the old observer's output", Proto.T.SMS_NEW in replacement)
        } finally {
            worker.shutdownNow()
            core.bg.shutdownNow()
            core.timers.shutdownNow()
        }
    }

    @Test fun groupWithAnUnresolvedMemberIsMarkedSoItIsNeverSentToASubset() {
        val core = core()
        val service = Messages(core.hub, core)
        var ids = "1 2 3"
        provider("mms-sms") { uri, cols ->
            MatrixCursor(cols).apply {
                when (uri.lastPathSegment) {
                    "canonical-addresses" -> { addRow(arrayOf<Any>("1", "+12025550100")); addRow(arrayOf<Any>("2", "+12025550101")) }
                    "conversations" -> addRow(arrayOf<Any>(7L, 100L, ids, "", 1))
                }
            }
        }
        fun row() = service.threads(10, "US").getJSONObject(0)
        assertTrue(row().optBoolean("group"))
        assertTrue(row().optBoolean("unresolved"))
        assertEquals(2, row().getJSONArray("addrs").length())
        ids = "1 2"
        assertFalse(row().optBoolean("unresolved"))
    }

    @Test fun captionedNonImageMmsKeepsItsAttachmentMetadata() {
        val core = core()
        val service = Messages(core.hub, core)
        provider("sms") { _, cols -> MatrixCursor(cols) }
        provider("mms") { uri, cols ->
            MatrixCursor(cols).apply {
                when (uri.lastPathSegment) {
                    null -> addRow(arrayOf<Any>(9L, 100L, 1, 7L))
                    "part" -> { addRow(arrayOf<Any?>(1L, "text/plain", "Synthetic caption")); addRow(arrayOf<Any?>(2L, "video/mp4", null)) }
                    "addr" -> addRow(arrayOf<Any>("+12025550100", 137))
                }
            }
        }
        val item = service.thread(msg(Proto.T.SMS_THREAD, "id" to "7")).getJSONArray("items").getJSONObject(0)
        assertEquals("Synthetic caption", item.optString("body"))
        assertTrue(item.optBoolean("attachment"))
        assertEquals(0, item.getJSONArray("parts").length())
    }
}
