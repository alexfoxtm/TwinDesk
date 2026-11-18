// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files with LocalSend-compatible apps, on the Files page (LocalSend.kt is the state and the
// actions): the switch (off until turned on), the devices found with what's known of each, an offer
// with its Accept and Decline, what's on its way. They're there without a computer connected too.
// "LocalSend" names the protocol these devices speak; TwinDesk is not affiliated with it.
package com.twindesk.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val PAD = PaddingValues(horizontal = 14.dp, vertical = 0.dp)

// The page's two buttons (MainActivity's Primary and Secondary are its own).
@Composable
private fun Strong(label: String, onClick: () -> Unit) = Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White),
    shape = if (Modern.on) RoundedCornerShape(50) else RoundedCornerShape(8.dp), contentPadding = PAD, modifier = Modifier.height(if (Modern.on) 40.dp else 36.dp)) {
    Text(label, fontSize = 14.sp, maxLines = 1, fontWeight = if (Modern.on) FontWeight.SemiBold else null)
}

@Composable
internal fun LocalSendButton(label: String, enabled: Boolean = true, onClick: () -> Unit) =
    if (Modern.on) Button(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(50), contentPadding = PAD, modifier = Modifier.height(40.dp),
        colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text), elevation = null) { Text(label, fontSize = 14.sp, maxLines = 1, fontWeight = FontWeight.Medium) }
    else OutlinedButton(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(8.dp), contentPadding = PAD, modifier = Modifier.height(36.dp)) { Text(label, color = pal.text, fontSize = 14.sp, maxLines = 1) }

@Composable
internal fun LocalSendField(value: String, placeholder: String, width: Int, type: KeyboardType, onValue: (String) -> Unit) = OutlinedTextField(
    value, onValue, singleLine = true, placeholder = { Text(placeholder, color = pal.muted, fontSize = 14.sp) }, shape = RoundedCornerShape(10.dp),
    keyboardOptions = KeyboardOptions(keyboardType = type),
    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = pal.accent, unfocusedBorderColor = pal.line, focusedTextColor = pal.text, unfocusedTextColor = pal.text),
    modifier = Modifier.width(width.dp),
)

// What a device asks to send: who it says it is, from where, and whether that was checked.
// Nothing is taken without Accept. At the top of the page.
@Composable
fun LocalSendOffers(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val ls = core.localSend
    val offers = ls.offers
    if (offers.isEmpty()) return
    MacCard(tr("Asking to send you files")) {
        offers.forEachIndexed { i, o ->
            val hint = listOfNotNull(o.ip, LocalSend.short(o.fingerprint).ifEmpty { null },
                if (o.verified) null else tr("This sender didn’t prove which device it is: its name is only what it says."),
                if (o.imitates) tr("Another device uses this name: this may not be the one you think.") else null,
                if (o.known) null else tr("a device not seen before"),
                o.text.takeIf { it.isNotEmpty() }?.let { "“${it.take(200)}”" }).joinToString(" · ")
            MacRow(tr("{name} wants to send {file} ({size})", "name" to o.alias, "file" to LocalSend.what(o.names, o.files), "size" to FileClip.size(o.total)), hint, first = i == 0) {
                LocalSendButton(tr("Decline")) { ls.answer(o.id, false) }
                Strong(tr("Accept")) { ls.answer(o.id, true) }
            }
        }
    }
}

@Composable
fun LocalSendCards(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val ls = core.localSend
    val ctx = LocalContext.current
    val on = ls.on
    val me = core.store.deviceName
    val running = ls.running
    val scanning = ls.scanning
    val peers = if (on && running) ls.peers else emptyList()
    val adding = ls.adding
    val addError = ls.addError
    var target by rememberSaveable { mutableStateOf("") } // the device the file picker was opened for
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty() && target.isNotEmpty()) ls.send(target, uris) }

    MacCard(tr("LocalSend-compatible devices"), action = if (on && running) ({ LocalSendRefresh(scanning, ls::refresh) }) else null) {
        SwitchRow(tr("Files with LocalSend-compatible apps"), when {
            !on -> tr("Off. Turn on to find devices running LocalSend-compatible apps on this network, send them files and be asked about theirs.")
            ls.failed.isNotEmpty() -> tr("Couldn’t start receiving: {error}", "error" to ls.failed)
            ls.starting || !ls.running -> tr("Starting…")
            ls.receiving -> tr("On as “{name}”. Every arriving transfer is asked about first; accepted files go to Downloads › TwinDesk.", "name" to me)
            ls.error == "port" -> tr("On as “{name}”: sending only. Port {port} is used by another app on this phone (LocalSend itself?): it receives.", "name" to me, "port" to Ls.PORT)
            else -> tr("On as “{name}”: sending only.", "name" to me)
        }, on, first = true) { ls.set(it) }
        if (on && running) {
            LocalSendDiscovery(peers, scanning)
            LocalSendPeers(peers, scanning, tr("Send…")) { peer -> target = peer.id; pick.launch("*/*") }
            LocalSendAddress(adding, addError, ls::add)
        }
    }

    val list = ls.transfers
    if (list.isNotEmpty()) MacCard(tr("LocalSend transfers"), action = { LocalSendButton(tr("Clear")) { ls.clear() } }) {
        list.forEachIndexed { i, t ->
            key(t.id) {
                val label = LocalSend.line(t) + if (t.state == "running") " · ${Files.pct(t.done, t.total)}%" else ""
                var pin by rememberSaveable { mutableStateOf("") }
                MacRow(label, if (t.total > 0) FileClip.size(t.total) else "", first = i == 0) {
                    if (ls.asksPin(t.id)) {
                        LocalSendField(pin, tr("PIN"), 110, KeyboardType.Text) { pin = it.take(64) }
                        LocalSendButton(tr("Send"), enabled = pin.isNotEmpty()) { ls.sendWithPin(t.id, pin) }
                    }
                    if (t.live) LocalSendButton(tr("Cancel")) { ls.cancel(t.id) }
                    if (!t.live && t.incoming && t.arrived > 0) LocalSendButton(tr("Show")) { ls.openIntent(t)?.let { runCatching { ctx.startActivity(it) } } }
                }
            }
        }
    }
}


@Composable
internal fun LocalSendRefresh(scanning: Boolean, onRefresh: () -> Unit) {
    LocalSendButton(tr("Look again"), enabled = !scanning, onClick = onRefresh)
}

@Composable
internal fun LocalSendDiscovery(peers: List<LsPeer>, scanning: Boolean, first: Boolean = false) {
    val found = peers.count { it.supported && it.verified }
    val status = when {
        found == 1 -> tr("1 device found")
        found > 1 -> tr("{count} devices found", "count" to found)
        scanning -> tr("Looking for nearby devices…")
        peers.isNotEmpty() -> tr("No reachable devices")
        else -> tr("No devices found yet")
    }
    val hint = when {
        scanning && found > 0 -> tr("Looking for nearby devices…")
        !scanning && found == 0 -> tr("Open the app on the other device, on the same network")
        else -> ""
    }
    if (!first) HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = pal.line)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val color = when {
            scanning -> pal.accent
            found > 0 -> pal.good
            peers.isNotEmpty() -> pal.warn
            else -> pal.muted
        }
        Box(Modifier.size(32.dp).background(color.copy(alpha = 0.14f), CircleShape), contentAlignment = Alignment.Center) {
            if (scanning) CircularProgressIndicator(Modifier.size(16.dp), color = color, strokeWidth = 2.dp)
            else Box(Modifier.size(8.dp).background(color, CircleShape))
        }
        Column(Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }) {
            Text(status, color = pal.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            if (hint.isNotEmpty()) Text(hint, color = pal.muted, fontSize = 12.5.sp)
        }
    }
}

@Composable
internal fun LocalSendPeers(peers: List<LsPeer>, scanning: Boolean, send: String, onSend: (LsPeer) -> Unit) {
    for (p in peers.sortedByDescending { it.supported && it.verified }) key(p.id) {
        val status = when {
            !p.supported -> LocalSend.unsupported(p.why)
            p.verified -> tr("Verified on this network")
            scanning -> tr("Checking availability…")
            else -> tr("Not answering: it may only send")
        }
        val address = if (p.port == Ls.PORT) p.ip else "${p.ip}:${p.port}"
        val fingerprint = if (p.protocol == "https") LocalSend.short(p.fingerprint) else ""
        val hint = listOf(status, address, p.deviceModel, fingerprint).filter { it.isNotEmpty() }.joinToString(" · ")
        MacRow(p.alias, hint) { LocalSendButton(send, enabled = p.supported) { onSend(p) } }
    }
}

@Composable
internal fun LocalSendAddress(adding: Boolean, error: String, onAdd: (String) -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    MacRow(tr("Add a device by its address"), when {
        adding -> tr("Looking…")
        error == "address" -> tr("Enter an address on this network, like 192.168.1.20")
        error == "plain" -> tr("That device has encryption off, which TwinDesk doesn’t use")
        error == "unreachable" || error == "timeout" -> tr("Nothing answered there")
        error.isNotEmpty() -> tr("That isn’t a LocalSend-compatible device")
        else -> tr("When it isn’t found by itself: its address is in that app’s settings")
    }) {
        LocalSendField(address, "192.168.1.20", 170, KeyboardType.Uri) { address = it.take(21) }
        LocalSendButton(tr("Add"), enabled = !adding && address.isNotBlank()) { onAdd(address) }
    }
}
