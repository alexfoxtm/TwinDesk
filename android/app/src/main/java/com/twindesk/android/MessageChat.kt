// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.app.Notification
import android.app.RemoteInput
import java.security.MessageDigest

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

    data class Candidate(val id: String, val at: Long, val match: String)
    data class Row(val at: Long, val match: String, val mms: Boolean)

    // SMS has millisecond timestamps and MMS has seconds. Require a one-to-one match
    // at the precision of the provider. If two rows or projections could match, keep both.
    fun matches(candidates: List<Candidate>, rows: List<Row>): List<String> {
        val sms = candidates.groupBy { it.at to it.match }
        val mms = candidates.groupBy { it.at / 1000 to it.match }
        val edges = rows.map { row ->
            if (row.mms) mms[row.at / 1000 to row.match].orEmpty() else sms[row.at to row.match].orEmpty()
        }
        val counts = edges.flatten().groupingBy { it.id }.eachCount()
        return edges.mapNotNull { edge -> edge.singleOrNull()?.id?.takeIf { counts[it] == 1 } }
    }
}
