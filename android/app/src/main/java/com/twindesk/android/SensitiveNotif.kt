// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What may leave the phone in a notification.
//
// From Android 15, NotificationManagerService can treat a notification listener as trusted for the
// whole package when that package has any companion-device association. General's linked computer
// is such an association, and so is the per-Mac approval below. Trust is decided when the listener
// is bound. A trusted listener is given the original text of a notification the assistant marked
// sensitive. An OTP is the case the platform names; it is not the only one.
//
// The public SDK through API 37 has no method or extra that reports this. Ranking.hasSensitiveContent
// is @SystemApi and @hide, and it is not in android-36 or android-37.0 stubs. A text pattern is not
// a substitute: a miss (an alphabetic code, a bare PIN, a year, a picture, a field the pattern does
// not see) is not proof that the notification is ordinary. This file does not match text.
//
// When the listener may be privileged and this recipient has no consent, message text, action
// labels and pictures are held back. The app name can still be sent by the caller. That is broader
// than Android's own redaction, because the app cannot see which notifications Android would redact.
// When the listener was bound with no companion association, or this Android has no such trust,
// the text the listener already received is forwarded as ordinary notification flow. That is not a
// claim that the platform redacted anything.
//
// Consent is the paired Mac on the live link session, with the fingerprint recorded for that
// approval. A phone does not inherit it. Another Mac does not. A replaced session or a removed
// approval fails the next check.
//
// The recipient and its link marker are captured before notification text, chat history, a
// snapshot or a picture is read. The send is dropped unless that same marker is still the live
// socket and the consent decision still holds. A later socket, including another approved Mac,
// does not receive the payload that was built for the earlier one.
package com.twindesk.android

object SensitiveNotif {
    data class Text(
        val title: String,
        val subtitle: String,
        val body: String,
        val actions: List<String>,
        val pictures: Boolean,
        val redacted: Boolean,
    )

    // featureSupported: this Android can make a companion association privilege the listener.
    // approvedForThisHost: the live session is the Mac that approval was stored for.
    // On older Android the feature does not exist. Callers then forward what the listener received.
    fun release(featureSupported: Boolean, approvedForThisHost: Boolean): Boolean =
        !featureSupported || approvedForThisHost

    // A Mac's consent is not a phone's consent. macConsent is release() for the live Mac session.
    fun releaseTo(recipientMac: Boolean, macConsent: Boolean): Boolean = recipientMac && macConsent

    // The live recipient is the approved Mac. Phones, other computers, a dead session, an unbound
    // listener, and a cleared approval are all false.
    fun consent(
        featureSupported: Boolean,
        recipientMac: Boolean,
        recipientId: String,
        recipientFingerprint: String,
        sessionLive: Boolean,
        listenerBound: Boolean,
        approvedId: String?,
        approvedFingerprint: String?,
    ): Boolean {
        if (!featureSupported || !recipientMac || !sessionLive || !listenerBound) return false
        if (recipientId.isEmpty() || recipientFingerprint.isEmpty()) return false
        if (approvedId.isNullOrEmpty() || approvedFingerprint.isNullOrEmpty()) return false
        return recipientId == approvedId && recipientFingerprint == approvedFingerprint
    }

    // True when this bind may be delivering text Android would have held back from an untrusted
    // listener. Unknown until a bind is observed. An association, or a failed association query,
    // stays true. No association on the observed bind is false.
    fun listenerMaySeeSensitive(featureSupported: Boolean, bindObserved: Boolean, boundWithAssociation: Boolean): Boolean {
        if (!featureSupported) return false
        if (!bindObserved) return true
        return boundWithAssociation
    }

    fun forward(
        release: Boolean,
        listenerMaySeeSensitive: Boolean,
        title: String,
        subtitle: String,
        body: String,
        actions: List<String>,
        pictures: Boolean,
    ): Text {
        // Consent, or a listener that is not privileged: forward the text already in hand.
        // A pattern match is not what decides this.
        if (release || !listenerMaySeeSensitive) return Text(title, subtitle, body, actions, pictures, redacted = false)
        return Text(
            title = "",
            subtitle = "",
            body = "",
            actions = emptyList(),
            pictures = false,
            redacted = true,
        )
    }

    // marker is the live socket object. Identity, not string equality, is the session.
    data class Recipient(val marker: Any, val id: String, val fingerprint: String, val mac: Boolean)

    data class Plan(
        val recipient: Recipient,
        val includeSensitive: Boolean,
        val privileged: Boolean,
        val consented: Boolean,
    )

    // Notification, chat snapshot, conversation history and pictures share this decision.
    // toPhone never receives a Mac's consent. Older Android (no feature) forwards what it has.
    fun plan(
        featureSupported: Boolean,
        listenerMaySeeSensitive: Boolean,
        recipient: Recipient,
        toPhone: Boolean,
        sessionLive: Boolean,
        listenerBound: Boolean,
        approvedForRecipient: Boolean,
    ): Plan {
        val macConsent = !toPhone && featureSupported && recipient.mac && sessionLive && listenerBound &&
            approvedForRecipient && recipient.id.isNotEmpty() && recipient.fingerprint.isNotEmpty()
        val releaseFlag = when {
            toPhone -> false
            !featureSupported -> true
            else -> macConsent
        }
        val includeSensitive = releaseFlag || !listenerMaySeeSensitive
        val consented = listenerMaySeeSensitive && macConsent && includeSensitive
        return Plan(recipient, includeSensitive, listenerMaySeeSensitive, consented)
    }

    // Called again immediately before sendFor(original marker). Replacement drops the payload
    // even when the new Mac is also approved. Revocation drops a release that included sensitive
    // fields. A redacted payload may still go to the same recipient. A phone plan never matches a Mac.
    fun deliver(planned: Plan, current: Recipient?, recomputed: Plan?): Boolean {
        if (current == null || recomputed == null) return false
        if (!sameRecipient(planned.recipient, current) || !sameRecipient(recomputed.recipient, current)) return false
        if (planned.includeSensitive && !recomputed.includeSensitive) return false
        if (planned.consented && !recomputed.consented) return false
        return true
    }

    fun sameRecipient(expected: Recipient, current: Recipient?): Boolean {
        if (current == null) return false
        return current.marker === expected.marker && current.id == expected.id &&
            current.fingerprint == expected.fingerprint && current.mac == expected.mac
    }

    data class ActionTicket(
        val marker: Any,
        val id: String,
        val fingerprint: String,
        val mac: Boolean,
        val privileged: Boolean,
        val consented: Boolean,
    )

    fun ticket(plan: Plan) = ActionTicket(
        plan.recipient.marker, plan.recipient.id, plan.recipient.fingerprint, plan.recipient.mac,
        plan.privileged, plan.consented,
    )

    fun sameSession(ticket: ActionTicket, current: Recipient?): Boolean {
        if (current == null) return false
        return current.marker === ticket.marker && current.id == ticket.id &&
            current.fingerprint == ticket.fingerprint && current.mac == ticket.mac
    }

    // Privileged actions need the same session and consent that stored them. An ordinary action
    // from a listener that was not privileged stays usable on that same session without consent,
    // and is still rejected once that session is gone.
    fun actionAllowed(
        ticket: ActionTicket,
        current: Recipient?,
        sessionLive: Boolean,
        listenerBound: Boolean,
        featureSupported: Boolean,
        listenerMaySeeSensitive: Boolean,
        approvedForTicketRecipient: Boolean,
    ): Boolean {
        if (!sessionLive || !sameSession(ticket, current)) return false
        if (!ticket.privileged) return true
        if (!ticket.consented || !listenerBound || !listenerMaySeeSensitive || current == null) return false
        return consent(
            featureSupported = featureSupported,
            recipientMac = ticket.mac,
            recipientId = current.id,
            recipientFingerprint = current.fingerprint,
            sessionLive = true,
            listenerBound = true,
            approvedId = if (approvedForTicketRecipient) ticket.id else null,
            approvedFingerprint = if (approvedForTicketRecipient) ticket.fingerprint else null,
        )
    }

    // Chat pictures and their reply cache. The session that received the request must still be
    // the socket, and a privileged listener still needs consent. An unprivileged session does not.
    fun pictureAllowed(started: Recipient, current: Recipient?, privileged: Boolean, consented: Boolean): Boolean {
        if (!sameRecipient(started, current)) return false
        if (!privileged) return true
        return consented
    }
}
