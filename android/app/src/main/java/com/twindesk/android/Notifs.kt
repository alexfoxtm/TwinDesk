// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: the phone's (read by NotifListener, which needs Notification access)
// go to the computer while it accepts them (`notif.policy`); the computer's show here as real
// notifications, one channel per computer app is overkill, so one "From the computer" channel.
package com.twindesk.android

import android.app.Notification
import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import java.io.ByteArrayOutputStream
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

class Notifs(core: Core) : Feature(core) {
    @Volatile var peerAccepts = false; private set
    // The computer shows pictures and progress bars that fill in place (its notif.policy says rich):
    // only then are they sent (an older computer would show every update of a bar as a new one).
    @Volatile private var peerRich = false
    private val liveAt = HashMap<String, Long>() // key -> when its bar was last sent
    @Volatile var sent = 0; private set
    @Volatile var shown = 0; private set
    private val muted get() = core.store.prefsSet("notifs.muted")

    // Per app (#102): the apps that had a notification to send, each with its own switch on the
    // Notifications page (on unless muted). Kept across restarts, up to 200.
    fun apps(): List<Pair<String, String>> {
        val pm = core.ctx.packageManager
        return core.store.prefsSet("notifs.apps").mapNotNull { pkg ->
            val label = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrNull() ?: return@mapNotNull null
            pkg to label
        }.sortedBy { it.second.lowercase() }
    }

    fun isMuted(pkg: String) = pkg in muted

    fun setMuted(pkg: String, on: Boolean) {
        core.store.setPrefsSet("notifs.muted", if (on) muted + pkg else muted - pkg)
        messagePrefsChanged()
        core.changed()
    }

    // Notifications › Apps: a block list (every app but the ones switched off: the muted set, as
    // before) or an allow list (only the ones switched on), over every app on the phone (AppList).
    val allowMode: Boolean get() = core.store.prefsString("notifs.filter", "block") == "allow"
    fun setAllowMode(on: Boolean) { core.store.setPrefsString("notifs.filter", if (on) "allow" else "block"); messagePrefsChanged(); core.changed() }
    private val allowed get() = core.store.prefsSet("notifs.allowed")
    fun isAllowed(pkg: String) = pkg in allowed
    fun setAllowed(pkg: String, on: Boolean) {
        core.store.setPrefsSet("notifs.allowed", if (on) allowed + pkg else allowed - pkg)
        messagePrefsChanged()
        core.changed()
    }
    // Whether this app's notifications go to the computer.
    fun sends(pkg: String) = if (allowMode) pkg in allowed else pkg !in muted
    // The list's switch: on = its notifications go.
    fun setSends(pkg: String, on: Boolean) = if (allowMode) setAllowed(pkg, on) else setMuted(pkg, !on)
    // Every app at once (the list's All and None).
    fun setAll(pkgs: Collection<String>, on: Boolean) {
        if (allowMode) core.store.setPrefsSet("notifs.allowed", if (on) allowed + pkgs else allowed - pkgs.toSet())
        else core.store.setPrefsSet("notifs.muted", if (on) muted - pkgs.toSet() else muted + pkgs)
        messagePrefsChanged()
        core.changed()
    }

    private fun seen(pkg: String) {
        val all = core.store.prefsSet("notifs.apps")
        if (pkg in all) return
        core.store.setPrefsSet("notifs.apps", if (all.size >= 200) all else all + pkg)
    }
    // App icons with notifications (shared/notificon.js): ours go with an app's first one in a
    // session; the computer's are kept by app (the computer sends each only once).
    private val iconsSent = HashSet<String>()
    // Each sent notification's reply action (a chat's Reply), for notif.reply from the computer.
    // The ticket is the session that was allowed to see it. A later socket cannot use it.
    private val replies = object : LinkedHashMap<String, ReplyBind>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, ReplyBind>?) = size > 80
    }
    // Messages' chat apps on the computer (shared/chats.js): while it asks (chat.want), each chat
    // app conversation's recent messages as its notification shows them (chat.conv), whether or not
    // notifications go there; answered through the same Reply (notif.reply).
    @Volatile private var chatsWanted = false
    @Volatile private var messageChatRoute: Link.TrustedRoute? = null
    private val messageReplies = LinkedHashMap<String, MessageReply>() // Android notification key -> current offer
    private class MessageReply(val id: String, val pkg: String, val postedAt: Long, val bind: ReplyBind, val input: android.app.RemoteInput)
    private val chatApps = setOf(
        "com.whatsapp", "com.whatsapp.w4b", "com.instagram.android", "org.telegram.messenger", "org.telegram.messenger.web",
        "org.thunderdog.challegram", "com.facebook.orca", "org.thoughtcrime.securesms",
    )
    // Each sent notification's other buttons (Mark as read, Archive…), by key, for notif.act; and the
    // keys the computer has, so it hears when they go from here (notif.gone).
    private val actions = object : LinkedHashMap<String, ActionBind>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, ActionBind>?) = size > 80
    }
    private class ActionBind(val ticket: SensitiveNotif.ActionTicket, val actions: List<Notification.Action>)
    private class ReplyBind(val ticket: SensitiveNotif.ActionTicket, val action: Notification.Action)
    private val recentSent = object : LinkedHashMap<String, Long>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Long>?) = size > 64
    }

    // The standard build (what people download) has no notification listener: Play Protect blocks
    // sideloaded apps with one. The computer installs the full build over it (adb, not checked).
    val supported get() = BuildConfig.NOTIF_LISTENER

    val hasAccess: Boolean
        get() {
            if (!supported) return false
            val flat = Settings.Secure.getString(core.ctx.contentResolver, "enabled_notification_listeners") ?: return false
            val me = ComponentName(core.ctx, NotifListener::class.java).flattenToString()
            return flat.split(':').any { it == me }
        }

    fun sendPolicy() {
        core.send(msg(Proto.T.NOTIF_POLICY, "accept" to core.sync.get("notifs", "in")))
    }

    override fun onWelcome(host: Host) {
        peerAccepts = false
        peerRich = false
        chatsWanted = false
        messageChatRoute = null
        synchronized(messageReplies) { messageReplies.clear() }
        sendPolicy()
    }

    override fun onClosed() {
        peerAccepts = false
        chatsWanted = false
        messageChatRoute = null
        synchronized(messageReplies) { messageReplies.clear() }
        synchronized(iconsSent) { iconsSent.clear() }
        // The session that owned these buttons is gone. Ordinary and privileged alike.
        synchronized(actions) { actions.clear() }
        synchronized(replies) { replies.clear() }
        clearChatPictures()
    }

    // Consent was removed, or the listener is being held. Privileged buttons and picture files go.
    // An action stored while the listener was not privileged stays for its own live session.
    internal fun invalidatePrivileged() {
        forgetMessageReplies { it.bind.ticket.privileged }
        // Buttons and replies go. The key stays so this same session can still dismiss the
        // notification. An ordinary, unprivileged bind is left as it is.
        synchronized(actions) {
            for ((key, bind) in actions.toList()) {
                if (bind.ticket.privileged) actions[key] = ActionBind(bind.ticket, emptyList())
            }
        }
        synchronized(replies) {
            val it = replies.entries.iterator()
            while (it.hasNext()) if (it.next().value.ticket.privileged) it.remove()
        }
        clearChatPictures()
    }

    private fun clearChatPictures() {
        val dir = java.io.File(core.ctx.cacheDir, "mms")
        runCatching { dir.listFiles()?.forEach { if (it.name.startsWith("chat-")) it.delete() } }
    }

    // The computer on the socket right now. Read this before any notification or chat text.
    private fun captureComputer(): SensitiveNotif.Recipient? {
        val route = core.link.currentTrustedRoute() ?: return null
        val host = core.link.host ?: return null
        if (route.id != host.id || route.fp != host.fp || !core.link.accepts(route)) return null
        return SensitiveNotif.Recipient(route.marker, route.id, route.fp, host.os == "mac")
    }

    // toPhone is never given this Mac's approval, even when the ids would otherwise match.
    internal fun releasePlan(recipient: SensitiveNotif.Recipient, toPhone: Boolean): SensitiveNotif.Plan {
        val feature = core.companion.supported
        val privileged = core.companion.maySeeSensitive()
        val bound = NotifListener.running != null && hasAccess && !CompanionApproval.holdNotifications(core.ctx)
        val approved = !toPhone && recipient.mac && feature && bound &&
            core.companion.approvedIdentity(recipient.id, recipient.fingerprint)
        return SensitiveNotif.plan(
            featureSupported = feature,
            listenerMaySeeSensitive = privileged,
            recipient = recipient,
            toPhone = toPhone,
            sessionLive = true,
            listenerBound = bound,
            approvedForRecipient = approved,
        )
    }

    // The plan captured before the read, checked again against whoever the socket is now.
    private fun commit(plan: SensitiveNotif.Plan): Boolean {
        val current = captureComputer()
        return SensitiveNotif.deliver(plan, current, current?.let { releasePlan(it, toPhone = false) })
    }

    private fun listenerBound() = NotifListener.running != null && hasAccess && !CompanionApproval.holdNotifications(core.ctx)

    private fun messageChatAllowed(pkg: String) = core.link.accepts(messageChatRoute) && core.hub.messagesOn &&
        sends(pkg) && !core.store.flag("notifs.hideText", false) && listenerBound()

    private fun forgetMessageReplies(whenToForget: (MessageReply) -> Boolean) {
        synchronized(messageReplies) {
            val expired = messageReplies.values.filter(whenToForget)
            messageReplies.values.removeAll(expired.toSet())
            for (offer in expired) {
                core.link.sendFor(offer.bind.ticket.marker, msg("chat.gone", "id" to offer.id))
            }
        }
    }

    internal fun messagePrefsChanged() = forgetMessageReplies {
        it.bind.ticket.marker !== messageChatRoute?.marker || !messageChatAllowed(it.pkg)
    }

    internal fun messagePolicyChanged() {
        if (core.hub.messagesOn && core.link.accepts(messageChatRoute)) chatSnapshot(messagingOnly = true)
        else messagePrefsChanged()
    }

    internal fun listenerLost() = forgetMessageReplies { true }

    internal fun messageMatchPlan(route: Link.TrustedRoute?): SensitiveNotif.Plan? =
        captureComputer()?.takeIf { it.marker === route?.marker }?.let {
            releasePlan(it, toPhone = false).takeIf(::messageMatchAllowed)
        }

    internal fun messageMatchAllowed(plan: SensitiveNotif.Plan) =
        core.link.accepts(messageChatRoute) && core.hub.messagesOn && listenerBound() && plan.includeSensitive &&
            !core.store.flag("notifs.hideText", false) && commit(plan)

    private fun allowAction(ticket: SensitiveNotif.ActionTicket): Boolean {
        val current = captureComputer()
        val approved = ticket.mac && current != null && current.id == ticket.id && current.fingerprint == ticket.fingerprint &&
            core.companion.approvedIdentity(ticket.id, ticket.fingerprint)
        return SensitiveNotif.actionAllowed(
            ticket,
            current,
            sessionLive = current != null && core.link.connected,
            listenerBound = listenerBound(),
            featureSupported = core.companion.supported,
            listenerMaySeeSensitive = core.companion.maySeeSensitive(),
            approvedForTicketRecipient = approved,
        )
    }

    private fun rememberActions(key: String, ticket: SensitiveNotif.ActionTicket, buttons: List<Notification.Action>, reply: Notification.Action?) {
        synchronized(actions) { actions[key] = ActionBind(ticket, buttons) }
        if (reply != null) synchronized(replies) { replies[key] = ReplyBind(ticket, reply) }
        else synchronized(replies) { replies.remove(key) }
    }

    private fun forgetActions(key: String, marker: Any) {
        synchronized(actions) { if (actions[key]?.ticket?.marker === marker) actions.remove(key) }
        synchronized(replies) { if (replies[key]?.ticket?.marker === marker) replies.remove(key) }
    }

    // Extract title from standard, big title, conversation title, etc.
    fun titleOf(x: Bundle) = extractTitle(x)
    fun textOf(x: Bundle) = extractText(x)
    fun appName(pkg: String) = appNameOf(pkg)

    private fun extractTitle(x: Bundle): String {
        return (x.getCharSequence(Notification.EXTRA_TITLE)
            ?: x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)
            ?: x.getCharSequence(Notification.EXTRA_TITLE_BIG))?.toString()?.trim() ?: ""
    }

    // MessagingStyle's messages, and a message's sender (typed reads from Android 13).
    @Suppress("DEPRECATION")
    private fun messages(x: Bundle): Array<out android.os.Parcelable>? =
        if (Build.VERSION.SDK_INT >= 33) x.getParcelableArray(Notification.EXTRA_MESSAGES, android.os.Parcelable::class.java)
        else x.getParcelableArray(Notification.EXTRA_MESSAGES)

    @Suppress("DEPRECATION")
    private fun senderOf(m: Bundle): android.app.Person? = when {
        Build.VERSION.SDK_INT >= 33 -> m.getParcelable("sender_person", android.app.Person::class.java)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> m.getParcelable("sender_person")
        else -> null
    }

    // Extract text from MessagingStyle (WhatsApp, etc.), InboxStyle, BigText, Text, or SubText
    private fun extractText(x: Bundle): String {
        // 1. Direct big text or standard text
        val bigText = x.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
        if (!bigText.isNullOrEmpty()) return bigText

        val text = x.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        if (!text.isNullOrEmpty()) return text

        // 2. MessagingStyle (used by WhatsApp, Telegram, Google Messages)
        val msgs = messages(x)
        if (!msgs.isNullOrEmpty()) {
            val lastMsg = msgs.lastOrNull()
            if (lastMsg is Bundle) {
                val senderPerson = senderOf(lastMsg)?.name?.toString()?.trim() ?: ""
                val sender = senderPerson.ifEmpty { lastMsg.getCharSequence("sender")?.toString()?.trim() ?: "" }
                val msgText = lastMsg.getCharSequence("text")?.toString()?.trim() ?: ""
                if (msgText.isNotEmpty()) {
                    return if (sender.isNotEmpty()) "$sender: $msgText" else msgText
                }
            }
        }

        // 3. InboxStyle (used by Instagram and WhatsApp multi-message summaries)
        val lines = x.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (!lines.isNullOrEmpty()) {
            val valid = lines.mapNotNull { it?.toString()?.trim() }.filter { it.isNotEmpty() }
            if (valid.isNotEmpty()) return valid.joinToString("\n")
        }

        // 4. Fallback to sub text or summary text
        val subText = x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()
        if (!subText.isNullOrEmpty()) return subText

        val summaryText = x.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)?.toString()?.trim()
        if (!summaryText.isNullOrEmpty()) return summaryText

        val infoText = x.getCharSequence(Notification.EXTRA_INFO_TEXT)?.toString()?.trim()
        if (!infoText.isNullOrEmpty()) return infoText

        return ""
    }

    private fun appNameOf(pkg: String): String = when (pkg) {
        "com.whatsapp" -> "WhatsApp"
        "com.whatsapp.w4b" -> "WhatsApp Business"
        "com.instagram.android" -> "Instagram"
        "org.telegram.messenger", "org.telegram.messenger.web" -> "Telegram"
        "com.facebook.orca" -> "Messenger"
        "org.thoughtcrime.securesms" -> "Signal"
        else -> runCatching { core.ctx.packageManager.let { pm -> pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } }.getOrDefault(pkg)
    }

    // A chat app's conversation for the computer's Messages: its MessagingStyle messages (sender,
    // text, time; the user's own have no sender), else the notification's text as one message.
    // The recipient is fixed before the messages, the snapshot or the avatar are read. A replacement
    // or a revoked approval drops the whole conversation, including its picture.
    private fun chatPosted(sbn: StatusBarNotification) {
        if (!chatsWanted || CompanionApproval.holdNotifications(core.ctx)) return
        val captured = captureComputer() ?: return
        val plan = releasePlan(captured, toPhone = false)
        if (!plan.includeSensitive) return
        val n = sbn.notification ?: return
        if (MessageChat.isApp(sbn.packageName)) {
            messageChatPosted(sbn, n, plan)
            return
        }
        if (sbn.packageName !in chatApps && !otherChat(sbn, n)) return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        // "Sending video…", "Deleting chats 100%", "Checking for new messages": the app at work, not a chat.
        if (sbn.isOngoing || n.category == Notification.CATEGORY_PROGRESS || n.category == Notification.CATEGORY_SERVICE || liveOf(n) != null) return
        if (core.store.flag("notifs.hideText", false)) return
        val x = n.extras
        val title = extractTitle(x)
        val convTitle = x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim().orEmpty()
        val rawName = convTitle.ifEmpty { title }
        val name = if (shareText(rawName, plan)) rawName else appNameOf(sbn.packageName)
        val shortcut = (if (Build.VERSION.SDK_INT >= 26) n.shortcutId else null)?.takeIf { it.isNotEmpty() && shareText(it, plan) }
        val key = shortcut ?: name
        if (key.isEmpty()) return
        val items = JSONArray()
        val msgs = messages(x)
        if (!msgs.isNullOrEmpty()) {
            for (p in msgs) {
                if (p !is Bundle) continue
                val text = p.getCharSequence("text")?.toString()?.trim().orEmpty()
                if (!shareText(text, plan)) continue
                val person = senderOf(p)
                val sender = p.getCharSequence("sender")
                val me = person == null && sender == null
                val from = if (me) "" else (person?.name ?: sender)?.toString()?.trim().orEmpty()
                val who = if (shareText(from, plan)) from else ""
                items.put(JSONObject().put("at", p.getLong("time", sbn.postTime)).put("from", who.take(120)).put("text", text.take(4000)).put("me", me))
            }
        } else {
            val text = extractText(x)
            if (shareText(text, plan)) items.put(JSONObject().put("at", sbn.postTime).put("from", name.take(120)).put("text", text.take(4000)).put("me", false))
        }
        if (items.length() == 0) return
        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        val group = x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        val payload = msg(
            "chat.conv", "key" to key.take(300), "app" to sbn.packageName, "appName" to appNameOf(sbn.packageName),
            "name" to name.take(200), "group" to group, "id" to sbn.key.take(200), "reply" to (reply != null), "items" to items,
            "pic" to true, // takes a picture from the computer (chat.pic)
        ).apply { avatarOf(n)?.let { put("avatar", it) } } // the contact's or the group's picture
        if (!commit(plan)) return
        val ticket = SensitiveNotif.ticket(plan)
        if (reply != null) synchronized(replies) { replies[sbn.key] = ReplyBind(ticket, reply) }
        // Consent and the socket are read again immediately before the write. A revoke or a
        // replacement after the picture was encoded drops this conversation and the reply just stored.
        if (!commit(plan) || !core.link.sendFor(captured.marker, payload)) {
            if (reply != null) synchronized(replies) { if (replies[sbn.key]?.ticket?.marker === captured.marker) replies.remove(sbn.key) }
        }
    }

    private fun messageChatPosted(sbn: StatusBarNotification, n: Notification, plan: SensitiveNotif.Plan) {
        val pkg = sbn.packageName
        if (!messageChatAllowed(pkg)) return
        val x = n.extras
        val busy = sbn.isOngoing || liveOf(n) != null
        if (!MessageChat.projects(pkg, n, busy)) return
        val entries = messages(x)?.filterIsInstance<Bundle>().orEmpty()
        if (entries.isEmpty()) return
        val group = x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        // Use the app's shortcut (scoped to its Android user) or exact notification key.
        // Display names can collide or change while the conversation stays the same.
        val shortcut = n.shortcutId?.takeIf { it.isNotEmpty() }
        val key = MessageChat.digest(sbn.user.toString(), if (shortcut == null) "notification" else "shortcut", shortcut ?: sbn.key)
        val people = entries.associateWith(::senderOf)
        val canMatch = sbn.user == android.os.Process.myUserHandle() && !x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, true)
        fun address(person: android.app.Person?) = person?.uri?.takeIf { it.startsWith("tel:", ignoreCase = true) }
            ?.substring(4)?.let { MessageChat.destination(android.net.Uri.decode(it)) }
        val peer = if (group) null else entries.filter { people[it] != null || it.getCharSequence("sender") != null }
            .map { address(people[it]) }.distinct().singleOrNull()
        val occurrences = mutableMapOf<String, Int>()
        val items = JSONArray()
        for (entry in entries) {
            val text = entry.getCharSequence("text")?.toString()?.trim().orEmpty()
            val at = entry.getLong("time")
            if (at <= 0 || !shareText(text, plan)) continue
            val person = people[entry]
            val sender = entry.getCharSequence("sender")
            val me = person == null && sender == null
            val from = if (me) "" else (person?.name ?: sender)?.toString()?.trim().orEmpty()
            val attachment = entry.containsKey("uri") || entry.containsKey("type")
            val identity = person?.uri ?: person?.key ?: from
            val signature = MessageChat.digest(pkg, key, at.toString(), me.toString(), identity, text, entry.getString("type").orEmpty())
            val occurrence = (occurrences[signature] ?: 0) + 1
            occurrences[signature] = occurrence
            items.put(JSONObject().put("id", MessageChat.digest(signature, occurrence.toString()))
                .put("at", at).put("from", from.take(120)).put("text", text.take(4000)).put("me", me)
                .apply {
                    // With no exact, one-to-one phone destination, keep the projection.
                    if (canMatch && !attachment) {
                        MessageChat.fingerprint(if (me) peer else address(person), me, text)?.let { put("match", it) }
                    }
                })
        }
        if (items.length() == 0) return
        val reply = MessageChat.reply(n)
        val name = x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim().orEmpty().ifEmpty { extractTitle(x) }
        val id = reply?.let { "r:" + java.util.UUID.randomUUID().toString() }
        val payload = msg("chat.conv", "key" to key, "app" to pkg, "appName" to appNameOf(pkg), "source" to "messaging",
            "name" to name.take(200), "group" to group, "id" to id, "reply" to (reply != null), "items" to items)
            .apply { avatarOf(n)?.let { put("avatar", it) } }
        synchronized(messageReplies) {
            if (!messageChatAllowed(pkg) || !commit(plan)) return
            messageReplies.remove(sbn.key)?.let { core.link.sendFor(it.bind.ticket.marker, msg("chat.gone", "id" to it.id)) }
            if (reply != null && id != null) {
                if (messageReplies.size >= 80) {
                    val old = messageReplies.remove(messageReplies.keys.first())!!
                    core.link.sendFor(old.bind.ticket.marker, msg("chat.gone", "id" to old.id))
                }
                messageReplies[sbn.key] = MessageReply(id, pkg, sbn.postTime, ReplyBind(SensitiveNotif.ticket(plan), reply.first), reply.second)
            }
            if (!messageChatAllowed(pkg) || !commit(plan) || !core.link.sendFor(plan.recipient.marker, payload)) {
                messageReplies.remove(sbn.key)
            }
        }
    }

    // Another app's conversation (Viber, LINE, Discord, Slack…): a message notification in Android's
    // conversation style, from anything but a texting app (those are Messages' texts).
    private fun otherChat(sbn: StatusBarNotification, n: Notification): Boolean {
        if (sbn.packageName == core.ctx.packageName || sbn.isOngoing) return false
        if (n.category != Notification.CATEGORY_MESSAGE || messages(n.extras).isNullOrEmpty()) return false
        val sms = runCatching { android.provider.Telephony.Sms.getDefaultSmsPackage(core.ctx) }.getOrNull()
        return sbn.packageName != sms && sbn.packageName !in SMS_APPS
    }

    // The conversations open on the phone now (the computer just asked).
    private fun chatSnapshot(messagingOnly: Boolean = false) {
        if (CompanionApproval.holdNotifications(core.ctx)) return
        val l = NotifListener.running ?: return
        runCatching { l.activeNotifications }.getOrNull()?.forEach {
            if (!messagingOnly || MessageChat.isApp(it.packageName)) runCatching { chatPosted(it) }
        }
    }

    // From NotifListener: a new notification on this phone.
    fun posted(sbn: StatusBarNotification) {
        if (MessageChat.isApp(sbn.packageName)) forgetMessageReply(sbn.key)
        if (CompanionApproval.holdNotifications(core.ctx)) return
        runCatching { chatPosted(sbn) }
        // A call in an app (WhatsApp, Instagram…): the computer's call window, with Answer and Decline (Calls.kt).
        val cn = sbn.notification
        if (cn != null && cn.category == Notification.CATEGORY_CALL && sbn.packageName != core.ctx.packageName &&
            runCatching { core.hub.appCallPosted(sbn, appNameOf(sbn.packageName), extractTitle(cn.extras)) }.getOrDefault(false)) return
        runCatching { core.peer.notifPosted(sbn, this) } // and to a phone connected with Connect with Android (Peer.kt)
        if (!peerAccepts || !core.sync.get("notifs", "out")) return
        // Fixed before the title, the text, the buttons or any picture is read. sendFor uses this marker.
        val captured = captureComputer() ?: return
        val plan = releasePlan(captured, toPhone = false)
        val n = sbn.notification ?: return
        val pkg = sbn.packageName
        if (pkg == core.ctx.packageName) return
        // A progress bar (a download, an upload, a timer's): to a computer that fills it in place,
        // at most once a second until it's done. Other ongoing ones (music, navigation) never.
        val live = if (peerRich) liveOf(n) else null
        if (sbn.isOngoing && live == null) return

        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return // the group's children come too (a summary is "3 messages from 2 chats")
        if (n.category == Notification.CATEGORY_TRANSPORT || n.category == Notification.CATEGORY_SERVICE) return
        if (n.category == Notification.CATEGORY_PROGRESS && live == null) return
        if (n.category == Notification.CATEGORY_CALL && core.hub.callsOn) return // the computer shows the call itself
        seen(pkg)
        if (!sends(pkg)) return

        val x = n.extras
        val rawTitle = extractTitle(x)
        val rawText = extractText(x)
        if (rawTitle.isEmpty() && rawText.isEmpty()) return
        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        // Its other buttons (no typing): the computer shows them, and taps them here (notif.act).
        val buttons = n.actions.orEmpty().filter { a -> a !== reply && a.actionIntent != null && a.title?.isNotBlank() == true && a.remoteInputs.isNullOrEmpty() }.take(3)
        val hide = core.store.flag("notifs.hideText", false)
        val subtitle = x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() ?: ""
        val out = outgoing(rawTitle, subtitle, if (hide) "" else rawText, buttons.map { it.title.toString().take(40) }, pictures = peerRich && !hide, bound = plan)
        val title = if (out.redacted && out.title.isEmpty()) appNameOf(pkg) else out.title
        val text = out.body
        if (title.isEmpty() && text.isEmpty()) return
        // Indexes match the titles we send. A redacted title is not a button the computer can press.
        val remain = out.actions.toMutableList()
        val kept = buttons.filter { b ->
            val i = remain.indexOf(b.title.toString().take(40))
            if (i < 0) false else { remain.removeAt(i); true }
        }
        // Deduplicate rapid duplicate notifications (e.g. summary + child sent at same instant);
        // a progress bar instead: once a second, and always its end. Claimed before the picture
        // is built, and given back when the send is dropped, so the next peer is not suppressed.
        val nowMs = System.currentTimeMillis()
        val hash = "$pkg|$title|$text"
        if (live != null) {
            synchronized(liveAt) {
                if (!live.optBoolean("done") && nowMs - (liveAt[sbn.key] ?: 0L) < 1000L) return
                liveAt[sbn.key] = nowMs
                if (liveAt.size > 50) liveAt.keys.firstOrNull()?.let { liveAt.remove(it) }
            }
        } else {
            synchronized(recentSent) {
                val last = recentSent[hash] ?: 0L
                if (nowMs - last < 2000L) return
                recentSent[hash] = nowMs
            }
        }

        val pm = core.ctx.packageManager
        val appName = when (pkg) {
            "com.whatsapp" -> "WhatsApp"
            "com.whatsapp.w4b" -> "WhatsApp Business"
            "com.instagram.android" -> "Instagram"
            "org.telegram.messenger" -> "Telegram"
            else -> runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
        }

        val icon = if (synchronized(iconsSent) { pkg in iconsSent }) null else appIcon(pkg)
        val actionTitles = out.actions
        val payload = msg(
            Proto.T.NOTIF, "id" to sbn.key.take(200), "app" to pkg, "appName" to appName,
            "title" to title.take(300), "subtitle" to out.subtitle.take(200),
            "body" to text.take(1000), "at" to sbn.postTime,
        ).apply {
            if (icon != null) put("icon", icon)
            if (reply != null && !out.redacted) put("reply", true) // the computer may answer it (notif.reply)
            if (actionTitles.isNotEmpty()) put("actions", jsonArray(actionTitles))
            if (live != null) put("live", live)
            if (out.pictures) {
                picOf(n)?.let { put("pic", it) } // a big picture (a photo sent in a chat, a screenshot)
                avatarOf(n)?.let { put("avatar", it) } // the sender's or the chat's picture
            }
        }
        fun releaseClaim() {
            if (live != null) synchronized(liveAt) { if (liveAt[sbn.key] == nowMs) liveAt.remove(sbn.key) }
            else synchronized(recentSent) { if (recentSent[hash] == nowMs) recentSent.remove(hash) }
        }
        if (!commit(plan)) return releaseClaim()
        val ticket = SensitiveNotif.ticket(plan)
        val replyBind = if (reply != null && !out.redacted) reply else null
        rememberActions(sbn.key, ticket, if (out.redacted) emptyList() else kept, replyBind)
        // Checked again after the buttons are stored and immediately before the socket write.
        if (!commit(plan) || !core.link.sendFor(captured.marker, payload)) {
            forgetActions(sbn.key, captured.marker)
            return releaseClaim()
        }
        if (icon != null) synchronized(iconsSent) { iconsSent.add(pkg) }
        sent++
        core.changed()
    }

    // toPhone: Connect with Android. That phone never inherits the Mac's approval. When the
    // listener may be privileged, its text, buttons and pictures are held back. bound is the
    // recipient captured before this text was read; without one, nothing sensitive is forwarded.
    fun outgoing(title: String, subtitle: String, body: String, actions: List<String> = emptyList(), pictures: Boolean = false, toPhone: Boolean = false, bound: SensitiveNotif.Plan? = null): SensitiveNotif.Text {
        val plan = bound ?: captureComputer()?.let { releasePlan(it, toPhone) }
        if (plan == null || (toPhone && plan.recipient.mac)) return SensitiveNotif.forward(false, true, title, subtitle, body, emptyList(), false)
        return SensitiveNotif.forward(plan.includeSensitive, !plan.includeSensitive, title, subtitle, body, if (plan.includeSensitive) actions else emptyList(), pictures && plan.includeSensitive)
    }

    // Chat text uses the plan captured for this recipient. A pattern miss is not proof that the
    // message is ordinary.
    private fun shareText(text: String, plan: SensitiveNotif.Plan) = text.isNotEmpty() && plan.includeSensitive

    // From NotifListener: gone from this phone (swiped, opened, or the app took it back): from the
    // computer's list too.
    fun removed(sbn: StatusBarNotification) {
        if (MessageChat.isApp(sbn.packageName)) forgetMessageReply(sbn.key)
        runCatching { core.hub.appCallRemoved(sbn.key) }
        val set = synchronized(actions) { actions.remove(sbn.key) }
        synchronized(replies) { replies.remove(sbn.key) }
        if (set == null || !peerAccepts) return
        val payload = msg("notif.gone", "id" to sbn.key.take(200))
        val current = captureComputer() ?: return
        if (!SensitiveNotif.sameSession(set.ticket, current)) return
        core.link.sendFor(current.marker, payload)
    }

    private fun forgetMessageReply(key: String) {
        synchronized(messageReplies) {
            val offer = messageReplies.remove(key) ?: return
            core.link.sendFor(offer.bind.ticket.marker, msg("chat.gone", "id" to offer.id))
        }
    }

    private fun messageReply(id: String, text: String) {
        if (text.isBlank()) return
        synchronized(messageReplies) {
            val (key, offer) = messageReplies.entries.find { it.value.id == id } ?: return
            if (!messageChatAllowed(offer.pkg) || !allowAction(offer.bind.ticket)) return
            val listener = NotifListener.running ?: return
            runCatching {
                val action = offer.bind.action
                val current = listener.getActiveNotifications(arrayOf(key)).singleOrNull() ?: return
                if (current.postTime != offer.postedAt || current.packageName != offer.pkg) return
                val n = current.notification
                if (!MessageChat.projects(offer.pkg, n, current.isOngoing || liveOf(n) != null)) return
                val (currentAction, input) = MessageChat.reply(n) ?: return
                if (currentAction.actionIntent != action.actionIntent || currentAction.semanticAction != action.semanticAction ||
                    input.resultKey != offer.input.resultKey) return
                val intent = android.content.Intent()
                android.app.RemoteInput.addResultsToIntent(arrayOf(input), intent, Bundle().apply { putCharSequence(input.resultKey, text) })
                if (messageReplies[key] === offer && messageChatAllowed(offer.pkg) && allowAction(offer.bind.ticket)) {
                    action.actionIntent.send(core.ctx, 0, intent)
                }
            }
        }
    }

    internal fun chatWant(m: JSONObject, route: Link.TrustedRoute?) {
        if (!core.link.accepts(route)) return
        chatsWanted = m.optBoolean("on") && hasAccess
        messageChatRoute = route.takeIf { chatsWanted && m.optBoolean("messaging") }
        messagePrefsChanged()
        if (chatsWanted) chatSnapshot()
        core.changed()
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            // Dismissed on the computer: from this phone too.
            "notif.dismiss" -> {
                val key = m.str("id", 200)
                val set = if (key.isEmpty()) null else synchronized(actions) { actions[key] }
                // Dismiss is not a content release. It still has to be this session, checked again
                // immediately before the listener is asked to remove it.
                if (set != null) runCatching {
                    if (!SensitiveNotif.sameSession(set.ticket, captureComputer())) error("session")
                    NotifListener.running?.cancelNotification(key)
                }
            }
            // One of its buttons, clicked on the computer. The session and, when it was privileged, the consent are checked again.
            "notif.act" -> {
                val bind = synchronized(actions) { actions[m.str("id", 200)] } ?: return true
                val a = bind.actions.getOrNull(m.optInt("i", -1)) ?: return true
                if (!allowAction(bind.ticket)) return true
                runCatching {
                    if (!allowAction(bind.ticket)) error("session")
                    a.actionIntent.send()
                }
            }
            Proto.T.NOTIF_POLICY -> { peerAccepts = m.optBoolean("accept"); peerRich = m.optBoolean("rich") }
            Proto.T.NOTIF -> {
                if (!core.sync.get("notifs", "in")) return true
                val app = m.str("appName", 80).ifEmpty { m.str("app", 80) }
                val title = m.str("title", 300)
                val body = listOf(m.str("subtitle", 200), m.str("body", 1000)).filter { it.isNotEmpty() }.joinToString("\n")
                Notify.fromComputer(core.ctx, m.str("id", 200), app, title, body, core.host?.name ?: tr("Computer"), iconIn(m))
                shown++
                core.history.addNotif(m.str("id", 200), app, title, body, m.optLong("at")) // History.kt
            }
            // An answer typed on the computer (Overview, Messages' chat apps): through the app's own Reply.
            "notif.reply" -> {
                val key = m.str("id", 200)
                val text = m.str("text", 5000)
                if (key.startsWith("r:")) {
                    messageReply(key, text)
                    return true
                }
                val bind = synchronized(replies) { replies[key] } ?: return true
                if (text.isEmpty() || !allowAction(bind.ticket)) return true
                val a = bind.action
                runCatching {
                    val intent = android.content.Intent()
                    val results = Bundle()
                    for (ri in a.remoteInputs.orEmpty()) results.putCharSequence(ri.resultKey, text)
                    android.app.RemoteInput.addResultsToIntent(a.remoteInputs, intent, results)
                    if (!allowAction(bind.ticket)) error("session")
                    a.actionIntent.send(core.ctx, 0, intent)
                }
            }
            // A picture from Messages' chat apps: through the app's Reply where it takes pictures,
            // else the app opens on that conversation with it attached, to send on the phone.
            "chat.pic" -> chatPicture(m)
            else -> return false
        }
        core.changed()
        return true
    }

    private fun chatPicture(m: JSONObject) {
        val started = captureComputer() ?: return
        val ref = m.str("ref", 60)
        fun still() = SensitiveNotif.sameRecipient(started, captureComputer())
        fun open(): Boolean {
            val current = captureComputer()
            val plan = current?.let { releasePlan(it, toPhone = false) }
            return SensitiveNotif.pictureAllowed(started, current, plan?.privileged == true, plan?.consented == true)
        }
        fun done(ok: Boolean, opened: Boolean, error: String?) {
            if (!still()) return
            if (!open()) {
                core.link.sendFor(started.marker, msg("chat.picd", "ref" to ref, "ok" to false, "opened" to false, "error" to "That picture was not sent"))
                return
            }
            core.link.sendFor(started.marker, msg("chat.picd", "ref" to ref, "ok" to ok, "opened" to opened, "error" to error))
        }
        if (!open()) return done(false, false, "That picture was not sent")
        val app = m.str("app", 200)
        if (MessageChat.isApp(app)) return done(false, false, "That picture was not sent")
        val chat = m.str("chat", 300)
        val text = m.str("text", 5000).trim()
        val raw = runCatching { Base64.decode(m.str("image", 6_000_000).substringAfter("base64,", ""), Base64.DEFAULT) }.getOrNull()
        if (raw == null || raw.isEmpty() || !Regex("^[A-Za-z][\\w]*(\\.[\\w]+)+$").matches(app)) return done(false, false, "That picture can't be read")
        if (!open()) return done(false, false, "That picture was not sent")
        val ctx = core.ctx
        val dir = java.io.File(ctx.cacheDir, "mms").apply { mkdirs() }
        dir.listFiles()?.forEach { if (it.name.startsWith("chat-") && System.currentTimeMillis() - it.lastModified() > 3_600_000) it.delete() }
        val file = java.io.File(dir, "chat-" + System.currentTimeMillis() + ".jpg").apply { writeBytes(raw) }
        if (!open()) {
            file.delete()
            return done(false, false, "That picture was not sent")
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
        // 1. The Reply takes pictures (RemoteInput's data types): sent from here, like a typed answer.
        // The cached reply has to be this session's, and consent has to still hold when it was required.
        val bind = synchronized(replies) { replies[m.str("id", 200)] }
        val a = bind?.action
        val takes = a?.remoteInputs.orEmpty().firstOrNull { ri -> ri.allowedDataTypes.orEmpty().any { it == "image/*" || it == "image/jpeg" } }
        if (a != null && takes != null && allowAction(bind.ticket) && open()) {
            val sent = runCatching {
                if (!allowAction(bind.ticket) || !open()) error("session")
                ctx.grantUriPermission(app, uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                val intent = android.content.Intent()
                android.app.RemoteInput.addDataResultToIntent(takes, intent, mapOf("image/jpeg" to uri))
                if (text.isNotEmpty()) a.remoteInputs.filter { it.allowFreeFormInput && it !== takes }.forEach { ri ->
                    android.app.RemoteInput.addResultsToIntent(arrayOf(ri), intent, Bundle().apply { putCharSequence(ri.resultKey, text) })
                }
                if (!allowAction(bind.ticket) || !open()) {
                    ctx.revokeUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    file.delete()
                    return done(false, false, "That picture was not sent")
                }
                a.actionIntent.send(ctx, 0, intent)
            }.isSuccess
            if (sent) return done(true, false, null)
        }
        if (!open()) {
            file.delete()
            return done(false, false, "That picture was not sent")
        }
        // 2. The app's own share screen, on that conversation (its shortcut), the picture and text in it.
        if (!(Settings.canDrawOverlays(ctx) || MainActivity.shown)) return done(false, false, "Allow TwinDesk to display over other apps on the phone")
        val share = android.content.Intent(android.content.Intent.ACTION_SEND).setPackage(app).setType("image/jpeg")
            .putExtra(android.content.Intent.EXTRA_STREAM, uri)
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        share.clipData = android.content.ClipData.newRawUri("", uri)
        if (text.isNotEmpty()) share.putExtra(android.content.Intent.EXTRA_TEXT, text)
        if (chat.isNotEmpty()) {
            share.putExtra(android.content.Intent.EXTRA_SHORTCUT_ID, chat) // Android's direct share: that conversation
            if ('@' in chat) share.putExtra("jid", chat) // WhatsApp's own
        }
        if (!open()) {
            file.delete()
            return done(false, false, "That picture was not sent")
        }
        if (runCatching { ctx.startActivity(share) }.isSuccess) done(true, true, null)
        else done(false, false, "That app doesn't take pictures")
    }

    companion object {
        private val SMS_APPS = setOf("com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.android.messaging")
    }

    // A notification's progress bar: {v, max, ind, done}, or null without one.
    private fun liveOf(n: Notification): JSONObject? {
        val x = n.extras ?: return null
        val max = x.getInt(Notification.EXTRA_PROGRESS_MAX, 0)
        val ind = x.getBoolean(Notification.EXTRA_PROGRESS_INDETERMINATE, false)
        if (max <= 0 && !ind) return null
        val v = x.getInt(Notification.EXTRA_PROGRESS, 0).coerceIn(0, maxOf(max, 0))
        return JSONObject().put("v", v).put("max", max).put("ind", ind).put("done", max > 0 && v >= max)
    }

    // A JPEG data: URL of a bitmap at most `side` px wide and tall, or null.
    private fun jpegOf(b: Bitmap?, side: Int, q: Int): String? = runCatching {
        if (b == null || b.width <= 0 || b.height <= 0) return null
        val k = minOf(1f, side.toFloat() / maxOf(b.width, b.height))
        val small = if (k < 1f) Bitmap.createScaledBitmap(b, (b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1), true) else b
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, q, out)
        "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    private fun bitmapOf(d: android.graphics.drawable.Drawable?, side: Int): Bitmap? {
        if (d == null) return null
        if (d is android.graphics.drawable.BitmapDrawable && d.bitmap != null) return d.bitmap
        val w = if (d.intrinsicWidth > 0) d.intrinsicWidth else side
        val h = if (d.intrinsicHeight > 0) d.intrinsicHeight else side
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, w, h)
        d.draw(Canvas(bmp))
        return bmp
    }

    // BigPictureStyle's picture (a Bitmap, or from Android 12 an Icon), up to 480 px.
    @Suppress("DEPRECATION")
    private fun picOf(n: Notification): String? = runCatching {
        val x = n.extras ?: return null
        val bmp: Bitmap? = when (val p = x.get(Notification.EXTRA_PICTURE)) {
            is Bitmap -> p
            is android.graphics.drawable.Icon -> bitmapOf(p.loadDrawable(core.ctx), 480)
            else -> if (Build.VERSION.SDK_INT >= 31) (x.get(Notification.EXTRA_PICTURE_ICON) as? android.graphics.drawable.Icon)?.let { bitmapOf(it.loadDrawable(core.ctx), 480) } else null
        }
        jpegOf(bmp, 480, 72)?.takeIf { it.length < 380_000 }
    }.getOrNull()

    // The large icon (a contact's or a chat's picture), 72 px.
    private fun avatarOf(n: Notification): String? = runCatching {
        val icon = n.getLargeIcon() ?: return null
        jpegOf(bitmapOf(icon.loadDrawable(core.ctx), 72), 72, 80)?.takeIf { it.length < 55_000 }
    }.getOrNull()

    // A 64 px PNG of the app's icon as a data: URL, or null.
    private fun appIcon(pkg: String): String? = runCatching {
        val d = core.ctx.packageManager.getApplicationIcon(pkg)
        val bmp = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, 64, 64)
        d.draw(Canvas(bmp))
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    // The icon of a notification from the computer: the one it came with, else the app's last one.
    private fun iconIn(m: JSONObject): Bitmap? {
        val app = m.optString("app").take(300)
        val url = m.optString("icon")
        val head = "data:image/png;base64,"
        if (url.startsWith(head) && url.length <= 48000 && app.isNotEmpty()) {
            runCatching {
                val b = Base64.decode(url.substring(head.length), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(b, 0, b.size)
            }.getOrNull()?.let { NotifIcons.remember(app, it) }
        }
        return NotifIcons.get(app)
    }
}

/** Notification icons the computer sent. Session state: a trim cannot rebuild them. */
internal object NotifIcons {
    private val icons = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Bitmap>?) = size > 100
    }

    fun remember(app: String, bitmap: Bitmap) {
        synchronized(icons) { icons[app] = bitmap }
    }

    fun get(app: String): Bitmap? = synchronized(icons) { icons[app] }

    fun clear() {
        synchronized(icons) { icons.clear() }
    }
}
