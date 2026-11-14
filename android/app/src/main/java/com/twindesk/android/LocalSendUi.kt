// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files with LocalSend-compatible apps, on the Files page (LocalSend.kt is the state and the
// actions): the switch (off until turned on), the devices found with what's known of each, an offer
// with its Accept and Decline, what's on its way. They're there without a computer connected too.
// "LocalSend" names the protocol these devices speak; TwinDesk is not affiliated with it.
package com.twindesk.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
private fun Quiet(label: String, enabled: Boolean = true, onClick: () -> Unit) =
    if (Modern.on) Button(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(50), contentPadding = PAD, modifier = Modifier.height(40.dp),
        colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text), elevation = null) { Text(label, fontSize = 14.sp, maxLines = 1, fontWeight = FontWeight.Medium) }
    else OutlinedButton(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(8.dp), contentPadding = PAD, modifier = Modifier.height(36.dp)) { Text(label, color = pal.text, fontSize = 14.sp, maxLines = 1) }

@Composable
private fun Field(value: String, placeholder: String, width: Int, type: KeyboardType, onValue: (String) -> Unit) = OutlinedTextField(
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
                Quiet(tr("Decline")) { ls.answer(o.id, false) }
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
    var target by rememberSaveable { mutableStateOf("") } // the device the file picker was opened for
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty() && target.isNotEmpty()) ls.send(target, uris) }

    MacCard(tr("LocalSend-compatible devices"), action = if (on && !ls.starting) ({ Quiet(tr("Look again")) { ls.refresh() } }) else null) {
        SwitchRow(tr("Files with LocalSend-compatible apps"), when {
            !on -> tr("Off. Turn on to find devices running LocalSend-compatible apps on this network, send them files and be asked about theirs.")
            ls.failed.isNotEmpty() -> tr("Couldn’t start receiving: {error}", "error" to ls.failed)
            ls.starting || !ls.running -> tr("Starting…")
            ls.receiving -> tr("On as “{name}”. Every arriving transfer is asked about first; accepted files go to Downloads › TwinDesk.", "name" to me)
            ls.error == "port" -> tr("On as “{name}”: sending only. Port {port} is used by another app on this phone (LocalSend itself?): it receives.", "name" to me, "port" to Ls.PORT)
            else -> tr("On as “{name}”: sending only.", "name" to me)
        }, on, first = true) { ls.set(it) }
        if (on && ls.running) {
            val peers = ls.peers
            if (peers.isEmpty()) MacRow(tr("No devices found yet"), tr("Open the app on the other device, on the same network"))
            for (p in peers) {
                val state = if (!p.supported) LocalSend.unsupported(p.why) else if (!p.verified) tr("Not answering: it may only send") else ""
                val fp = if (p.protocol == "https") LocalSend.short(p.fingerprint) else ""
                val hint = listOf(p.ip + if (p.port == Ls.PORT) "" else ":${p.port}", p.deviceModel, fp, state).filter { it.isNotEmpty() }.joinToString(" · ")
                MacRow(p.alias, hint) { Quiet(tr("Send…"), enabled = p.supported) { target = p.id; pick.launch("*/*") } }
            }
            var address by rememberSaveable { mutableStateOf("") }
            MacRow(tr("Add a device by its address"), when {
                ls.adding -> tr("Looking…")
                ls.addError == "address" -> tr("Enter an address on this network, like 192.168.1.20")
                ls.addError == "plain" -> tr("That device has encryption off, which TwinDesk doesn’t use")
                ls.addError == "unreachable" || ls.addError == "timeout" -> tr("Nothing answered there")
                ls.addError.isNotEmpty() -> tr("That isn’t a LocalSend-compatible device")
                else -> tr("When it isn’t found by itself: its address is in that app’s settings")
            }) {
                Field(address, "192.168.1.20", 170, KeyboardType.Uri) { address = it.take(21) }
                Quiet(tr("Add"), enabled = !ls.adding && address.isNotBlank()) { ls.add(address) }
            }
        }
    }

    val list = ls.transfers
    if (list.isNotEmpty()) MacCard(tr("LocalSend transfers"), action = { Quiet(tr("Clear")) { ls.clear() } }) {
        list.forEachIndexed { i, t ->
            key(t.id) {
                val label = LocalSend.line(t) + if (t.state == "running") " · ${Files.pct(t.done, t.total)}%" else ""
                var pin by rememberSaveable { mutableStateOf("") }
                MacRow(label, if (t.total > 0) FileClip.size(t.total) else "", first = i == 0) {
                    if (ls.asksPin(t.id)) {
                        Field(pin, tr("PIN"), 110, KeyboardType.Text) { pin = it.take(64) }
                        Quiet(tr("Send"), enabled = pin.isNotEmpty()) { ls.sendWithPin(t.id, pin) }
                    }
                    if (t.live) Quiet(tr("Cancel")) { ls.cancel(t.id) }
                    if (!t.live && t.incoming && t.arrived > 0) Quiet(tr("Show")) { ls.openIntent(t)?.let { runCatching { ctx.startActivity(it) } } }
                }
            }
        }
    }
}
