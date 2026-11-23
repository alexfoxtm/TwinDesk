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

internal const val BEACON_CONNECTED_MS = 45_000L

internal fun beaconDelay(interactive: Boolean, connected: Boolean, peerOn: Boolean): Long = when {
    // Another phone still has to see this one inside the 10s discovery window.
    connected && peerOn -> if (interactive) Proto.BEACON_MS else 5000L
    connected -> BEACON_CONNECTED_MS
    !interactive -> 5000L
    else -> Proto.BEACON_MS
}

internal fun discoveryMulticastNeeded(running: Boolean, interactive: Boolean): Boolean = running && interactive

// LocalSend's multicast lock and its periodic announce. The TCP server stays open either way:
// a listening port is not a transfer, and a direct peer does not need multicast to finish.
internal fun localSendMulticastNeeded(running: Boolean, interactive: Boolean, activeTransfer: Boolean): Boolean =
    running && (interactive || activeTransfer)

internal fun staleDialDelay(away: Boolean, attempts: Int): Long = when {
    !away -> 5000L
    attempts == 0 -> 5000L
    attempts == 1 -> 10_000L
    attempts == 2 -> 20_000L
    else -> 60_000L
}

internal fun lowPowerAdvertisingNeeded(
    interactive: Boolean,
    pending: Boolean,
    networkChanged: Boolean,
    macSeen: Boolean,
    connected: Boolean = false,
): Boolean = !interactive && !pending && !networkChanged && !macSeen && !connected
