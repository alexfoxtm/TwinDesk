// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Process
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.IntentCompat

/** The exported picker keeps Android's incoming read grants until the person closes it. */
class LocalSendShareActivity : ComponentActivity() {
    private lateinit var core: Core
    private var uris: List<Uri> = emptyList()
    @Volatile private var closed = false
    private var peer by mutableStateOf<LsPeer?>(null)
    private var transferId by mutableStateOf<String?>(null)
    private var preparing by mutableStateOf(false)
    private var peerGone by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core = Core.get(this)
        uris = sharedFiles(intent)
        if (uris.isNotEmpty() && core.localSend.on) {
            core.localSend.start()
            core.localSend.refresh()
        }
        setContent { Theme { Picker() } }
    }

    private fun sharedFiles(intent: Intent): List<Uri> = runCatching {
        val streams = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> return emptyList()
        }
        val files = streams.ifEmpty {
            val clip = intent.clipData ?: return emptyList()
            if (clip.itemCount > Ls.MAX_FILES) return emptyList()
            (0 until clip.itemCount).map { clip.getItemAt(it).uri ?: return emptyList() }
        }
        if (files.size !in 1..Ls.MAX_FILES || files.any { uri ->
                uri.scheme != "content" || checkUriPermission(uri, Process.myPid(), Process.myUid(),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED
            }) return emptyList()
        files.distinct()
    }.getOrDefault(emptyList())

    private fun send(to: LsPeer, pin: String? = null) {
        if (preparing || closed) return
        preparing = true
        peer = to
        peerGone = false
        transferId = null
        core.localSend.sendShared(to, uris, pin, { closed }) { id ->
            transferId = id
            preparing = false
            peerGone = id == null
        }
    }

    override fun finish() {
        retire()
        super.finish()
    }

    override fun onDestroy() {
        retire()
        super.onDestroy()
    }

    private fun retire() {
        if (closed) return
        closed = true
        if (::core.isInitialized) transferId?.let { core.localSend.cancel(it) }
    }

    @Composable
    private fun Picker() {
        val version by core.version.collectAsState()
        @Suppress("UNUSED_EXPRESSION") version
        val ls = core.localSend
        val transfer = ls.transfers.firstOrNull { it.id == transferId }
        val sending = preparing || transfer?.live == true
        Box(Modifier.fillMaxSize().background(pal.content).safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 560.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
                PageHead(getString(R.string.label_send_nearby), trCount(uris.size, "file"))
                when {
                    uris.isEmpty() -> Note(tr("Nothing to send"))
                    !ls.on -> Note(tr("Off. Turn on to find devices running LocalSend-compatible apps on this network, send them files and be asked about theirs."))
                    preparing -> Note(tr("Starting…"))
                    transfer != null -> MacCard {
                        val label = LocalSend.line(transfer)
                        val progress = if (transfer.state == "running") "${Files.pct(transfer.done, transfer.total)}%" else ""
                        MacRow(label, progress, first = true) {
                            if (transfer.error == "pin") {
                                var pin by remember(transfer.id) { mutableStateOf("") }
                                LocalSendField(pin, tr("PIN"), 110, KeyboardType.Text) { pin = it.take(64) }
                                LocalSendButton(tr("Send"), enabled = pin.isNotEmpty()) { peer?.let { send(it, pin) } }
                            }
                        }
                    }
                    ls.failed.isNotEmpty() -> Note(tr("Couldn’t start receiving: {error}", "error" to ls.failed), "warn")
                    ls.starting || !ls.running -> Note(tr("Starting…"))
                    else -> {
                        if (peerGone) Note(tr("That device is gone"), "warn")
                        val peers = ls.peers.filter { it.supported }
                        MacCard(tr("LocalSend-compatible devices"), action = { LocalSendButton(tr("Look again")) { ls.refresh() } }) {
                            if (peers.isEmpty()) MacRow(tr("No devices found yet"), tr("Open the app on the other device, on the same network"), first = true)
                            for ((i, device) in peers.withIndex()) {
                                val hint = listOf(device.ip, device.deviceModel, LocalSend.short(device.fingerprint))
                                    .filter { it.isNotEmpty() }.joinToString(" · ")
                                MacRow(device.alias, hint, first = i == 0) { LocalSendButton(tr("Send")) { send(device) } }
                            }
                        }
                    }
                }
                LocalSendButton(if (sending) tr("Cancel") else tr("Close")) { finish() }
            }
        }
    }
}
