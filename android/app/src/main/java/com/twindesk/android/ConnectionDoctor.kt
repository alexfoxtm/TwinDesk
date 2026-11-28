// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton

internal enum class ConnectionCloseReason {
    LOCAL, INTERRUPTED, ASLEEP, REPLACED, RELEASED, BAD_PAIRING, IDENTITY, VERSION, PAUSED;

    companion object {
        fun from(code: String?, identity: Boolean): ConnectionCloseReason = when {
            identity -> IDENTITY
            code == "local" -> LOCAL
            code == "asleep" -> ASLEEP
            code == "replaced" -> REPLACED
            code == "released" -> RELEASED
            code == "bad_token" -> BAD_PAIRING
            code == "version_mismatch" -> VERSION
            code == "paused" -> PAUSED
            else -> INTERRUPTED
        }
    }
}

internal data class ConnectionCloseObservation(
    val id: String,
    val fingerprint: String,
    val reason: ConnectionCloseReason,
    val at: Long,
)

// One process-local observation. Reconnecting the same pair keeps the reason available;
// selecting another pair discards it before a new dial can publish state.
internal class ConnectionObservations {
    @Volatile private var last: ConnectionCloseObservation? = null

    fun select(id: String, fingerprint: String) {
        if (last?.let { it.id != id || it.fingerprint != fingerprint } == true) last = null
    }

    fun closed(id: String, fingerprint: String, code: String?, identity: Boolean, at: Long) {
        last = ConnectionCloseObservation(id, fingerprint, ConnectionCloseReason.from(code, identity), at)
    }

    fun forPair(id: String, fingerprint: String): ConnectionCloseObservation? =
        last?.takeIf { it.id == id && it.fingerprint == fingerprint }
}

internal fun doctorTransport(core: Core): String {
    val link = core.link
    val endpoint = if (link.connected) link.endpoint() else null
    return when {
        !link.connected -> tr("Not connected")
        link.wired -> "USB"
        link.embedded -> tr("TwinDesk Network")
        link.ble -> tr("Bluetooth")
        endpoint?.first == "127.0.0.1" && endpoint.second in Relay.ports -> tr("Your own relay")
        Tailnet.isTailnet(endpoint?.first.orEmpty()) -> "Tailscale"
        else -> tr(core.net.via)
    }
}

internal fun doctorFeaturePermission(connected: Boolean, enabled: Boolean?, permission: String?): String = when {
    !connected -> "Not connected"
    enabled == null -> "Unknown"
    !enabled -> "Settings on the computer"
    permission == "ok" -> "Ready"
    permission == "partial" -> "Limited"
    permission == "none" -> "Not supported"
    permission == "ask" -> "Allow Messages access in Android settings"
    else -> "Unknown"
}

// Only observations from the primary authenticated route are shown as current capabilities.
@Composable
internal fun ConnectionFeatureRows(core: Core, onOpenPage: ((String) -> Unit)? = null) {
    val link = core.link
    val route = link.currentTrustedRoute()
    val connected = route != null && link.accepts(route)
    val mediaReady = connected && (!link.embedded || link.embeddedMediaReady(route!!))
    val adb = core.adb
    val bridgeCurrent = connected && link.accepts(adb.doctorBridgeRoute)
    val adbStatus = when {
        !connected -> tr("Not connected")
        bridgeCurrent && adb.bridge == "ready" -> if (adb.inputBlocked) tr("Limited") else tr("Ready")
        link.ble -> tr("Waiting for Wi-Fi")
        adb.off -> tr("Wireless debugging is off")
        bridgeCurrent && adb.bridgeMessage.isNotEmpty() -> adb.bridgeMessage
        else -> tr("Unknown")
    }
    MacRow(tr("Wireless debugging"), adbStatus) {
        if (connected && (!bridgeCurrent || adb.bridge != "ready")) DoctorOpen(tr("Open settings")) { adb.openSettings() }
    }
    val phoneScreen = when {
        !connected -> tr("Not connected")
        core.mirror.error.isNotEmpty() -> core.mirror.error
        core.mirror.on || (bridgeCurrent && adb.bridge == "ready") -> tr("Ready")
        link.ble -> tr("Waiting for Wi-Fi")
        !mediaReady -> tr("Waiting for TwinDesk Network media")
        else -> tr("Settings on the computer")
    }
    MacRow(tr("Phone screen"), phoneScreen)
    val screen = core.screen.state
    val computerScreen = when {
        !connected -> tr("Not connected")
        !core.moduleOn("screen") -> tr("Off")
        core.screen.videoPlaying -> tr("Ready")
        link.ble -> tr("Waiting for Wi-Fi")
        !mediaReady -> tr("Waiting for TwinDesk Network media")
        core.screen.videoUnavailable -> tr("Not supported")
        screen == null -> tr("Unknown")
        !screen.optBoolean("on") || screen.opt("remote") == false -> tr("Settings on the computer")
        else -> tr("Ready")
    }
    MacRow(tr("Screen"), computerScreen) {
        if (connected && core.moduleOn("screen") && onOpenPage != null) DoctorOpen(tr("Open")) { onOpenPage("screen") }
    }
    val files = when {
        !connected -> tr("Not connected")
        !core.moduleOn("files") -> tr("Off")
        link.ble -> tr("Waiting for Wi-Fi")
        else -> tr("Ready")
    }
    MacRow(tr("File Sharing"), files) {
        if (connected && core.moduleOn("files") && onOpenPage != null) DoctorOpen(tr("Open")) { onOpenPage("files") }
    }
    val messages = doctorFeaturePermission(connected, core.hub.messagesOn.takeIf { core.hub.peer }, core.hub.perm("messages"))
    val messageHint = when {
        !core.moduleOn("messages") -> tr("Off")
        messages == "Allow Messages access in Android settings" -> tr("Allow Messages access in Android settings")
        else -> tr(messages)
    }
    MacRow(tr("Messages"), messageHint) {
        if (connected && core.moduleOn("messages") && core.hub.messagesOn && core.hub.perm("messages") == "ask") DoctorOpen(tr("Open settings")) {
            core.ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${core.ctx.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } else if (connected && core.moduleOn("messages") && onOpenPage != null) DoctorOpen(tr("Open")) { onOpenPage("messages") }
    }
}

@Composable
private fun DoctorOpen(label: String, action: () -> Unit) {
    TextButton(onClick = action) { Text(label, color = pal.accent) }
}
