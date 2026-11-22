// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

internal const val PB_STALL_MS = 120_000L

// Credit and flight ownership share the same monitor.
internal class PbCredit(
    private val lock: Object,
    private val window: Int,
    private val size: Int,
) {
    private var written = -1
    private var upTo = 0

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
