// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

internal const val PB_STALL_MS = 120_000L

// One chunk per grant. Access is serialized by PhotoBackup's lock.
internal class PbCredit {
    companion object {
        fun forTake(macAdvertised: Boolean, window: Any?, chunkSize: Int): PbCredit? =
            if (macAdvertised && window == chunkSize) PbCredit() else null
    }

    private var nextSeq = 0
    private var nextOffset = 0
    private var granted = false

    fun expect(seq: Int, offset: Int) {
        nextSeq = seq
        nextOffset = offset
        granted = false
    }

    fun grant(seq: Long, offset: Long) {
        if (seq == nextSeq.toLong() && offset == nextOffset.toLong()) granted = true
    }

    fun allows(seq: Int, offset: Int): Boolean =
        seq < 0 || (granted && seq == nextSeq && offset == nextOffset)
}

internal class PbIdle(start: Long, timeoutMs: Long) {
    private val timeout = timeoutMs * 1_000_000L
    private var last = start

    fun progress(now: Long) { last = now }
    fun expired(now: Long): Boolean = now - last >= timeout
}
