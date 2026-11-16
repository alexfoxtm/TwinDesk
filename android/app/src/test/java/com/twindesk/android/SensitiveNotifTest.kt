// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveNotifTest {
    @Test
    fun approvalIsPerHostAndALinkedComputerDoesNotGrantIt() {
        assertFalse(SensitiveNotif.release(featureSupported = true, approvedForThisHost = false))
        assertTrue(SensitiveNotif.release(featureSupported = true, approvedForThisHost = true))
        // Older Android has no approval feature. Forwarding stays as it was.
        assertTrue(SensitiveNotif.release(featureSupported = false, approvedForThisHost = false))
    }

    @Test
    fun aPhoneDoesNotInheritAMacApprovalAndRevocationIsImmediate() {
        assertFalse(SensitiveNotif.releaseTo(recipientMac = false, macConsent = true))
        assertFalse(SensitiveNotif.releaseTo(recipientMac = true, macConsent = false))
        assertTrue(SensitiveNotif.releaseTo(recipientMac = true, macConsent = true))

        assertTrue(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        assertFalse(consent(recipientMac = false, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        assertFalse(consent(recipientMac = true, recipientId = "mac-b", recipientFingerprint = "fp-b", sessionLive = true, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        assertFalse(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-new", sessionLive = true, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        // The socket is gone, or the listener was unbound while approval is removed.
        assertFalse(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = false, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        assertFalse(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = false, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        assertFalse(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = true, approvedId = null, approvedFingerprint = null))
        assertFalse(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = true, approvedId = "", approvedFingerprint = "fp-a"))
        // The same paired Mac on a new live session still matches. The check is the live host, not a cached grant.
        assertTrue(consent(recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
        assertFalse(SensitiveNotif.consent(featureSupported = false, recipientMac = true, recipientId = "mac-a", recipientFingerprint = "fp-a", sessionLive = true, listenerBound = true, approvedId = "mac-a", approvedFingerprint = "fp-a"))
    }

    @Test
    fun privilegeFollowsTheObservedBindNotATextPattern() {
        assertFalse(SensitiveNotif.listenerMaySeeSensitive(featureSupported = false, bindObserved = false, boundWithAssociation = true))
        assertTrue(SensitiveNotif.listenerMaySeeSensitive(featureSupported = true, bindObserved = false, boundWithAssociation = false))
        assertFalse(SensitiveNotif.listenerMaySeeSensitive(featureSupported = true, bindObserved = true, boundWithAssociation = false))
        assertTrue(SensitiveNotif.listenerMaySeeSensitive(featureSupported = true, bindObserved = true, boundWithAssociation = true))
    }

    @Test
    fun ordinaryTextIsForwardedWhenTheListenerIsNotPrivileged() {
        // These include an alphabetic code, a bare PIN, a year and a numeric code. None of that is
        // proof of anything. The listener was not privileged, so the text it already has goes on.
        val lunch = hold(privileged = false, "Alex", "", "Lunch at noon?", listOf("Mark read"), pictures = true)
        assertEquals("Lunch at noon?", lunch.body)
        assertEquals("Alex", lunch.title)
        assertTrue(lunch.pictures)
        assertFalse(lunch.redacted)

        val alpha = hold(privileged = false, "Bank", "codes", "Your code is AB7K-Q2PM", listOf("Copy AB7K-Q2PM"), pictures = true)
        assertEquals("Your code is AB7K-Q2PM", alpha.body)
        assertEquals("codes", alpha.subtitle)
        assertEquals(listOf("Copy AB7K-Q2PM"), alpha.actions)
        assertTrue(alpha.pictures)
        assertFalse(alpha.redacted)

        val pin = hold(privileged = false, "PIN 2024", "", "Use it at the door", emptyList(), pictures = false)
        assertEquals("PIN 2024", pin.title)
        assertEquals("Use it at the door", pin.body)
        assertFalse(pin.redacted)

        val year = hold(privileged = false, "Calendar", "", "Meeting in room 2024", listOf("2024"), pictures = true)
        assertEquals("Meeting in room 2024", year.body)
        assertEquals(listOf("2024"), year.actions)
        assertTrue(year.pictures)

        val numeric = hold(privileged = false, "Bank", "", "Your code is 482913", listOf("Mark read"), pictures = true)
        assertEquals("Your code is 482913", numeric.body)
        assertTrue(numeric.pictures)
        assertFalse(numeric.redacted)
    }

    @Test
    fun aPrivilegedListenerHoldsEveryFieldUntilThisRecipientConsents() {
        val mixed = hold(
            privileged = true,
            title = "Code AB7K-Q2PM",
            subtitle = "PIN 2024",
            body = "Year 2024 and 482913",
            actions = listOf("Copy AB7K-Q2PM", "Mark read", "2024"),
            pictures = true,
        )
        assertEquals("", mixed.title)
        assertEquals("", mixed.subtitle)
        assertEquals("", mixed.body)
        assertEquals(emptyList<String>(), mixed.actions)
        assertFalse(mixed.pictures)
        assertTrue(mixed.redacted)

        val bare = hold(privileged = true, "482913", "", "", emptyList(), pictures = true)
        assertEquals("", bare.title)
        assertFalse(bare.pictures)
        assertTrue(bare.redacted)

        val phone = SensitiveNotif.forward(
            release = SensitiveNotif.releaseTo(recipientMac = false, macConsent = true),
            listenerMaySeeSensitive = true,
            title = "Code AB7K-Q2PM",
            subtitle = "",
            body = "PIN 2024",
            actions = listOf("2024"),
            pictures = true,
        )
        assertTrue(phone.redacted)
        assertEquals("", phone.body)
        assertFalse(phone.pictures)

        val allowed = SensitiveNotif.forward(true, true, "Bank", "codes", "Your code is AB7K-Q2PM", listOf("Copy AB7K-Q2PM"), pictures = true)
        assertEquals("Your code is AB7K-Q2PM", allowed.body)
        assertEquals(listOf("Copy AB7K-Q2PM"), allowed.actions)
        assertTrue(allowed.pictures)
        assertFalse(allowed.redacted)
    }

    private fun consent(
        recipientMac: Boolean,
        recipientId: String,
        recipientFingerprint: String,
        sessionLive: Boolean,
        listenerBound: Boolean,
        approvedId: String?,
        approvedFingerprint: String?,
    ) = SensitiveNotif.consent(
        featureSupported = true,
        recipientMac = recipientMac,
        recipientId = recipientId,
        recipientFingerprint = recipientFingerprint,
        sessionLive = sessionLive,
        listenerBound = listenerBound,
        approvedId = approvedId,
        approvedFingerprint = approvedFingerprint,
    )

    private fun hold(privileged: Boolean, title: String, subtitle: String, body: String, actions: List<String>, pictures: Boolean) =
        SensitiveNotif.forward(false, privileged, title, subtitle, body, actions, pictures)

    @Test
    fun sameApprovedMacKeepsNotificationSnapshotHistoryAndPictures() {
        val marker = Any()
        val mac = recipient(marker, "mac-a", "fp-a", mac = true)
        val planned = macPlan(mac, approved = true, privileged = true)
        assertTrue(planned.includeSensitive)
        assertTrue(planned.consented)
        val again = macPlan(mac, approved = true, privileged = true)
        assertTrue(SensitiveNotif.deliver(planned, mac, again))
        // One gate for the notification, the chat snapshot, its history and its pictures.
        assertTrue(SensitiveNotif.deliver(planned, mac, again))
        assertTrue(SensitiveNotif.pictureAllowed(mac, mac, privileged = true, consented = true))
        val ticket = SensitiveNotif.ticket(planned)
        assertTrue(allow(ticket, mac, approved = true, privilegedNow = true, listenerBound = true))
    }

    @Test
    fun replacementDropsThePayloadEvenWhenTheNewMacIsApproved() {
        val first = Any()
        val second = Any()
        val macA = recipient(first, "mac-a", "fp-a", mac = true)
        val macB = recipient(second, "mac-b", "fp-b", mac = true)
        val planned = macPlan(macA, approved = true, privileged = true)
        val now = macPlan(macB, approved = true, privileged = true)
        assertTrue(now.includeSensitive)
        assertFalse(SensitiveNotif.deliver(planned, macB, now))
        assertFalse(SensitiveNotif.pictureAllowed(macA, macB, privileged = true, consented = true))
        // The same Mac on a new socket is a different session. Its approval does not adopt the old payload.
        val reconnected = recipient(second, "mac-a", "fp-a", mac = true)
        val renewed = macPlan(reconnected, approved = true, privileged = true)
        assertFalse(SensitiveNotif.deliver(planned, reconnected, renewed))
        assertFalse(allow(SensitiveNotif.ticket(planned), reconnected, approved = true, privilegedNow = true, listenerBound = true))
        // The socket object did not change, but the fingerprint did. That is not the Mac that was approved.
        val renamed = recipient(first, "mac-a", "fp-other", mac = true)
        assertFalse(SensitiveNotif.deliver(planned, renamed, macPlan(renamed, approved = true, privileged = true)))
        assertFalse(SensitiveNotif.sameSession(SensitiveNotif.ticket(planned), renamed))
    }

    @Test
    fun revocationDropsAReleaseAndItsPrivilegedActions() {
        val marker = Any()
        val mac = recipient(marker, "mac-a", "fp-a", mac = true)
        val planned = macPlan(mac, approved = true, privileged = true)
        val revoked = macPlan(mac, approved = false, privileged = true)
        assertFalse(revoked.includeSensitive)
        assertFalse(revoked.consented)
        assertFalse(SensitiveNotif.deliver(planned, mac, revoked))
        assertFalse(SensitiveNotif.pictureAllowed(mac, mac, privileged = true, consented = false))
        assertFalse(allow(SensitiveNotif.ticket(planned), mac, approved = false, privilegedNow = true, listenerBound = true))
        assertFalse(allow(SensitiveNotif.ticket(planned), mac, approved = true, privilegedNow = true, listenerBound = false))
        assertFalse(allow(SensitiveNotif.ticket(planned), null, approved = true, privilegedNow = true, listenerBound = true))
        // Dismiss is not a content release: the same session can still see the key. The button cannot.
        assertTrue(SensitiveNotif.sameSession(SensitiveNotif.ticket(planned), mac))
        val droppedPrivilege = macPlan(mac, approved = true, privileged = false)
        assertTrue(droppedPrivilege.includeSensitive)
        assertFalse(droppedPrivilege.consented)
        assertFalse(SensitiveNotif.deliver(planned, mac, droppedPrivilege))
        assertFalse(allow(SensitiveNotif.ticket(planned), mac, approved = true, privilegedNow = false, listenerBound = true))
        val blank = recipient(marker, "mac-a", "", mac = true)
        val noFingerprint = SensitiveNotif.plan(true, true, blank, toPhone = false, sessionLive = true, listenerBound = true, approvedForRecipient = true)
        assertFalse(noFingerprint.includeSensitive)
        assertFalse(noFingerprint.consented)
    }

    @Test
    fun redactedNoticeStillReachesTheSameMacAndNotItsReplacement() {
        val marker = Any()
        val mac = recipient(marker, "mac-a", "fp-a", mac = true)
        val redacted = macPlan(mac, approved = false, privileged = true)
        assertFalse(redacted.includeSensitive)
        assertTrue(SensitiveNotif.deliver(redacted, mac, macPlan(mac, approved = false, privileged = true)))
        val other = recipient(Any(), "mac-b", "fp-b", mac = true)
        assertFalse(SensitiveNotif.deliver(redacted, other, macPlan(other, approved = false, privileged = true)))
        assertFalse(SensitiveNotif.deliver(redacted, null, null))
    }

    @Test
    fun ordinaryUnprivilegedWorkDoesNotNeedConsentAndDiesWithItsSession() {
        val marker = Any()
        val mac = recipient(marker, "mac-a", "fp-a", mac = true)
        val ordinary = macPlan(mac, approved = false, privileged = false)
        assertTrue(ordinary.includeSensitive)
        assertFalse(ordinary.consented)
        assertTrue(SensitiveNotif.deliver(ordinary, mac, macPlan(mac, approved = false, privileged = false)))
        val next = recipient(Any(), "mac-a", "fp-a", mac = true)
        assertFalse(SensitiveNotif.deliver(ordinary, next, macPlan(next, approved = false, privileged = false)))
        val ticket = SensitiveNotif.ticket(ordinary)
        assertFalse(ticket.privileged)
        // No approval, and the listener later looks privileged: the ordinary action stays on this session.
        assertTrue(allow(ticket, mac, approved = false, privilegedNow = false, listenerBound = true))
        assertTrue(allow(ticket, mac, approved = false, privilegedNow = true, listenerBound = false))
        assertFalse(allow(ticket, next, approved = false, privilegedNow = false, listenerBound = true))
        assertFalse(allow(ticket, null, approved = false, privilegedNow = false, listenerBound = true))
        // Text read while ordinary is not sent if the listener becomes privileged before the send.
        val held = macPlan(mac, approved = false, privileged = true)
        assertFalse(SensitiveNotif.deliver(ordinary, mac, held))
    }

    @Test
    fun aPhoneDoesNotInheritMacConsentAndAReplacedPhoneDropsTheSend() {
        val phoneA = recipient(Any(), "phone-a", "peer-a", mac = false)
        val phoneB = recipient(Any(), "phone-b", "peer-b", mac = false)
        val toPhone = SensitiveNotif.plan(
            featureSupported = true,
            listenerMaySeeSensitive = true,
            recipient = phoneA,
            toPhone = true,
            sessionLive = true,
            listenerBound = true,
            approvedForRecipient = true,
        )
        assertFalse(toPhone.includeSensitive)
        assertFalse(toPhone.consented)
        assertTrue(SensitiveNotif.deliver(toPhone, phoneA, toPhone.copy(recipient = phoneA)))
        val other = toPhone.copy(recipient = phoneB)
        assertFalse(SensitiveNotif.deliver(toPhone, phoneB, other))
        // An unprivileged phone still gets ordinary notification text, and only on its own socket.
        val ordinaryPhone = SensitiveNotif.plan(true, false, phoneA, toPhone = true, sessionLive = true, listenerBound = true, approvedForRecipient = true)
        assertTrue(ordinaryPhone.includeSensitive)
        assertFalse(ordinaryPhone.consented)
        assertTrue(SensitiveNotif.deliver(ordinaryPhone, phoneA, ordinaryPhone))
        assertFalse(SensitiveNotif.deliver(ordinaryPhone, phoneB, ordinaryPhone.copy(recipient = phoneB)))
        // Text read while the listener was ordinary is not sent once the listener may be privileged.
        val heldPhone = SensitiveNotif.plan(true, true, phoneA, toPhone = true, sessionLive = true, listenerBound = true, approvedForRecipient = true)
        assertFalse(heldPhone.includeSensitive)
        assertFalse(SensitiveNotif.deliver(ordinaryPhone, phoneA, heldPhone))
        // A computer that is not a Mac does not get a Mac approval either.
        val windows = recipient(Any(), "pc", "fp-pc", mac = false)
        val held = SensitiveNotif.plan(true, true, windows, toPhone = false, sessionLive = true, listenerBound = true, approvedForRecipient = true)
        assertFalse(held.includeSensitive)
        assertFalse(held.consented)
    }

    @Test
    fun olderAndroidForwardsWithoutConsentAndStillDropsAReplacement() {
        val marker = Any()
        val mac = recipient(marker, "mac-a", "fp-a", mac = true)
        val old = SensitiveNotif.plan(false, false, mac, toPhone = false, sessionLive = true, listenerBound = false, approvedForRecipient = false)
        assertTrue(old.includeSensitive)
        assertFalse(old.consented)
        assertTrue(SensitiveNotif.deliver(old, mac, old))
        val replaced = recipient(Any(), "mac-b", "fp-b", mac = true)
        val next = SensitiveNotif.plan(false, false, replaced, toPhone = false, sessionLive = true, listenerBound = false, approvedForRecipient = false)
        assertFalse(SensitiveNotif.deliver(old, replaced, next))
        assertTrue(allow(SensitiveNotif.ticket(old), mac, approved = false, privilegedNow = false, listenerBound = false))
    }

    private fun recipient(marker: Any, id: String, fingerprint: String, mac: Boolean) =
        SensitiveNotif.Recipient(marker, id, fingerprint, mac)

    private fun macPlan(recipient: SensitiveNotif.Recipient, approved: Boolean, privileged: Boolean) =
        SensitiveNotif.plan(
            featureSupported = true,
            listenerMaySeeSensitive = privileged,
            recipient = recipient,
            toPhone = false,
            sessionLive = true,
            listenerBound = true,
            approvedForRecipient = approved,
        )

    private fun allow(
        ticket: SensitiveNotif.ActionTicket,
        current: SensitiveNotif.Recipient?,
        approved: Boolean,
        privilegedNow: Boolean,
        listenerBound: Boolean,
    ) = SensitiveNotif.actionAllowed(
        ticket,
        current,
        sessionLive = current != null,
        listenerBound = listenerBound,
        featureSupported = true,
        listenerMaySeeSensitive = privilegedNow,
        approvedForTicketRecipient = approved,
    )
}
