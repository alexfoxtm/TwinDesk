// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64
import org.json.JSONObject

internal const val PB_STALL_MS = 120_000L

// Credit and flight ownership share the same monitor.
internal class PbCredit(
    private val lock: Object,
    private val window: Int,
    private val size: Int,
) {
    private var written = -1
    private var upTo = 0

    fun grant(message: JSONObject, sent: Int) {
        val offset = longField(message.opt("written")) ?: return
        val limit = longField(message.opt("upTo")) ?: return
        grant(offset, limit, sent)
    }

    fun grant(offset: Long, limit: Long, sent: Int) {
        if (offset <= written || offset > sent || limit != minOf(size.toLong(), offset + window)) return
        written = offset.toInt()
        upTo = limit.toInt()
        lock.notifyAll()
    }

    fun await(end: Int, final: Boolean, alive: () -> Boolean): Boolean = synchronized(lock) {
        var observed = written
        var deadline = System.nanoTime() + PB_STALL_MS * 1_000_000
        while (alive()) {
            if (written >= 0 && (if (final) written >= end else upTo >= end)) return true
            val now = System.nanoTime()
            if (written != observed) {
                observed = written
                deadline = now + PB_STALL_MS * 1_000_000
            }
            val left = deadline - now
            if (left <= 0) return false
            try {
                lock.wait((left + 999_999) / 1_000_000)
            } catch (_: InterruptedException) {
                return false
            }
        }
        false
    }

    companion object {
        fun window(value: Long?, chunk: Int): Int? =
            value?.takeIf { it in chunk.toLong()..Int.MAX_VALUE.toLong() }?.toInt()
    }
}

internal class PbIdle(start: Long, timeoutMs: Long) {
    private val timeout = timeoutMs * 1_000_000L
    private var last = start

    fun progress(now: Long) { last = now }
    fun expired(now: Long): Boolean = now - last >= timeout
}

internal fun longField(v: Any?): Long? = when (v) {
    is Int -> v.toLong()
    is Long -> v
    is Double -> if (!v.isNaN() && !v.isInfinite() && v % 1.0 == 0.0 && v >= Long.MIN_VALUE.toDouble() && v <= Long.MAX_VALUE.toDouble()) v.toLong() else null
    is String -> v.toLongOrNull()
    else -> null
}


internal class PbBody(val sha: String = "", val failure: String? = null)

internal inline fun pumpPhotoBody(
    input: InputStream,
    size: Int,
    chunkSize: Int,
    credited: Boolean,
    ready: (end: Int, final: Boolean) -> Boolean,
    chunk: (sent: Int, seq: Int, data: String) -> Boolean,
): PbBody {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(chunkSize)
    var got = 0
    var seq = 0
    while (true) {
        val end = minOf(got + chunkSize, size)
        val final = got == size
        if (!ready(end, final)) return PbBody(failure = "stop")
        val n = try {
            if (!credited) input.read(buf)
            else if (final) {
                if (input.read() == -1) -1 else 1
            } else {
                var filled = 0
                while (filled < end - got) {
                    val count = input.read(buf, filled, end - got - filled)
                    if (count < 0) break
                    filled += count
                }
                if (filled == end - got) filled else -1
            }
        } catch (_: SecurityException) {
            return PbBody(failure = "permission")
        }
        if (n < 0) break
        if (n == 0) continue
        if (got + n > size) return PbBody(failure = "checksum")
        md.update(buf, 0, n)
        val data = Base64.getEncoder().encodeToString(if (n == buf.size) buf else buf.copyOf(n))
        if (!chunk(got + n, seq, data)) return PbBody(failure = "stop")
        got += n
        seq++
    }
    if (got != size) return PbBody(failure = "checksum")
    return PbBody(sha = md.digest().hex())
}
