package com.twindesk.android

internal fun quietLink(localIdle: Boolean, peerIdle: Boolean, bluetooth: Boolean): Boolean =
    localIdle && peerIdle && !bluetooth

internal fun quietBeatDelay(pingAt: Long, expiresAt: Long, now: Long): Long =
    (minOf(pingAt, expiresAt) - now).coerceAtLeast(1L)
