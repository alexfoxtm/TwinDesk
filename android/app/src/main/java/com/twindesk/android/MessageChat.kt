// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.app.Notification
import android.app.RemoteInput
import android.content.Context
import android.telephony.PhoneNumberUtils
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import java.security.MessageDigest
import java.util.Locale

// A MessagingStyle projection has no SMS/MMS/RCS transport flag.
internal object MessageChat {
    private val apps = setOf("com.google.android.apps.messaging", "com.samsung.android.messaging")
    private val phoneNumber = Regex("""\+?[0-9() .-]+""")
    private const val HEX = "0123456789abcdef"
    fun isApp(pkg: String) = pkg in apps

    fun projects(pkg: String, n: Notification, busy: Boolean) =
        isApp(pkg) && (n.category == null || n.category == Notification.CATEGORY_MESSAGE) &&
            n.extras.getString(Notification.EXTRA_TEMPLATE) == Notification.MessagingStyle::class.java.name &&
            n.flags and Notification.FLAG_GROUP_SUMMARY == 0 && !busy

    fun reply(n: Notification): Pair<Notification.Action, RemoteInput>? =
        n.actions.orEmpty().sortedBy { it.semanticAction != Notification.Action.SEMANTIC_ACTION_REPLY }.firstNotNullOfOrNull { action ->
            if (action.actionIntent == null || action.semanticAction !in listOf(Notification.Action.SEMANTIC_ACTION_REPLY, Notification.Action.SEMANTIC_ACTION_NONE)) null
            else action.remoteInputs.orEmpty().firstOrNull { it.allowFreeFormInput }?.let { action to it }
        }

    fun destination(value: String?): String? {
        val address = value?.trim() ?: return null
        if (!phoneNumber.matches(address)) return null
        val digits = address.filter { it in '0'..'9' }
        return if (digits.length in 1..15) (if (address.startsWith("+")) "+" else "") + digits else null
    }

    // A SIM supplies the numbering context, never the desktop locale or a matching suffix.
    fun simCountry(ctx: Context): String {
        val country = runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            val subs = ctx.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList
            if (subs.isNullOrEmpty()) {
                // Without subscription access, use the SIM only when there's one modem.
                if (tm.phoneCount == 1) tm.simCountryIso else ""
            } else subs.map { tm.createForSubscriptionId(it.subscriptionId).simCountryIso }.distinct().singleOrNull().orEmpty()
        }.getOrElse {
            runCatching {
                val tm = ctx.getSystemService(TelephonyManager::class.java)
                if (tm.phoneCount == 1) tm.simCountryIso else ""
            }.getOrDefault("")
        }
        return country.uppercase(Locale.ROOT)
    }

    fun e164(value: String?, country: String): String? {
        val addr = destination(value) ?: return null
        if (addr.startsWith("+")) return addr.takeIf { Regex("""\+[1-9][0-9]{6,14}""").matches(it) }
        if (country == "US" || country == "CA") {
            val national = addr.takeLast(10)
            if ((addr == national || addr == "1$national") && Regex("""[2-9][0-9]{2}[2-9][0-9]{6}""").matches(national)) {
                return "+1$national"
            }
        }
        return country.takeIf { it.length == 2 }?.let { PhoneNumberUtils.formatNumberToE164(addr, it) }
    }

    fun digest(vararg fields: String): String {
        val hash = MessageDigest.getInstance("SHA-256")
        for (field in fields) {
            val bytes = field.toByteArray(Charsets.UTF_8)
            hash.update(bytes.size.toString().toByteArray(Charsets.US_ASCII))
            hash.update(':'.code.toByte())
            hash.update(bytes)
        }
        return buildString(64) {
            for (byte in hash.digest()) {
                append(HEX[(byte.toInt() shr 4) and 15])
                append(HEX[byte.toInt() and 15])
            }
        }
    }

    fun fingerprint(address: String?, out: Boolean, body: String): String? {
        val dest = destination(address) ?: return null
        val text = body.replace("\r\n", "\n").trim()
        return if (text.isEmpty()) null else digest(dest, out.toString(), text)
    }

    // Incoming MMS addr rows usually include the user's own number, so addrs.singleOrNull()
    // is null. Use the thread's one recipient, and only when it is the same destination as from.
    fun sameDestination(a: String?, b: String?, country: String = ""): Boolean {
        val left = destination(a) ?: return false
        val right = destination(b) ?: return false
        if (left == right) return true
        val normalized = e164(left, country) ?: return false
        return normalized == e164(right, country)
    }

    fun incomingMmsAddress(from: String?, threadPeer: String?, country: String = ""): String? =
        from?.takeIf { sameDestination(it, threadPeer, country) }

    data class Candidate(val id: String, val at: Long, val match: String)
    data class Row(val at: Long, val match: String, val mms: Boolean, val normalizedMatch: String? = null)

    // SMS has millisecond timestamps and MMS has seconds. Require a one-to-one match
    // at the precision of the provider. If two rows or projections could match, keep both.
    fun matches(candidates: List<Candidate>, rows: List<Row>): List<String> {
        val sms = candidates.groupBy { it.at to it.match }
        val mms = candidates.groupBy { it.at / 1000 to it.match }
        val edges = rows.map { row ->
            val at = if (row.mms) row.at / 1000 else row.at
            val byTime = if (row.mms) mms else sms
            listOfNotNull(row.match, row.normalizedMatch).distinct().flatMap { byTime[at to it].orEmpty() }
        }
        val counts = edges.flatten().groupingBy { it.id }.eachCount()
        return edges.mapNotNull { edge -> edge.singleOrNull()?.id?.takeIf { counts[it] == 1 } }
    }
}
