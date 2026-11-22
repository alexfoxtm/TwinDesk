package com.twindesk.android

internal fun quietLink(localIdle: Boolean, peerIdle: Boolean, bluetooth: Boolean): Boolean =
    localIdle && peerIdle && !bluetooth

internal fun quietBeatDelay(pingAt: Long, expiresAt: Long, now: Long): Long =
    (minOf(pingAt, expiresAt) - now).coerceAtLeast(1L)

internal fun returnTimerNeeded(backgroundBlocked: Boolean, connected: Boolean, connecting: Boolean, pairing: Boolean, peerConnected: Boolean) =
    !backgroundBlocked && !connected && !connecting && !pairing && !peerConnected

internal fun bleTimerNeeded(enabled: Boolean, radioOn: Boolean, allowed: Boolean, connected: Boolean, bluetooth: Boolean) =
    if (connected) bluetooth else enabled && radioOn && allowed

internal fun peerTimerNeeded(host: Boolean, pairing: Boolean, waiting: Boolean, temporaryHost: Boolean) =
    host || pairing || waiting || temporaryHost

internal fun netTimerNeeded(heldMessages: Boolean, expiringNeeds: Boolean) = heldMessages || expiringNeeds

internal fun beaconDelay(interactive: Boolean, connected: Boolean, peerOn: Boolean): Long = when {
    !interactive -> 5000L
    connected && !peerOn -> 4000L
    else -> Proto.BEACON_MS
}

internal fun discoveryMulticastNeeded(running: Boolean, interactive: Boolean): Boolean = running && interactive
