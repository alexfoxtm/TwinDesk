package com.twindesk.android

import android.app.Notification
import android.app.PendingIntent
import android.app.Person
import android.app.RemoteInput
import android.content.Intent
import android.graphics.drawable.Icon
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
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
}
