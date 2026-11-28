// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Bundle
import android.view.Window
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

internal class DeskScreenAwake(private val window: Window) {
    private val original = window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0

    fun update(enabled: Boolean, plugged: Boolean, resumed: Boolean) {
        if (original || enabled && plugged && resumed) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@Composable
fun DeskModeCard(core: Core) {
    val context = LocalContext.current
    MacCard(tr("Desk mode")) {
        MacRow(tr("Clock, music and quick actions while this device is on your desk."), first = true) {
            TextButton(onClick = { context.startActivity(Intent(context, DeskModeActivity::class.java)) }) { Text(tr("Open")) }
        }
        SwitchRow(
            tr("Keep screen on while charging"),
            tr("Uses the screen’s normal timeout when unplugged."),
            core.store.flag("desk.awake", false),
        ) {
            core.store.setFlag("desk.awake", it)
            core.changed()
        }
    }
}

class DeskModeActivity : ComponentActivity() {
    private lateinit var core: Core
    private lateinit var awake: DeskScreenAwake
    private var resumed = false
    private var plugged by mutableStateOf(false)
    private var battery by mutableStateOf<Int?>(null)

    private val power = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            battery = if (level >= 0 && scale > 0) (100L * level / scale).toInt().coerceIn(0, 100) else null
            refreshAwake()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        core = Core.get(this)
        awake = DeskScreenAwake(window)
        ContextCompat.registerReceiver(this, power, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        TwinService.start(this)
        setContent {
            val version by core.version.collectAsState()
            @Suppress("UNUSED_EXPRESSION") version
            val mediaEnabled = core.moduleOn("media")
            LaunchedEffect(mediaEnabled) { core.pcMedia.desk(resumed && mediaEnabled) }
            Theme { DeskModeScreen(core, battery, plugged, ::finish, ::openFiles) }
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        MainActivity.shown = true
        core.foreground(reconnect = false)
        core.pcMedia.desk(core.moduleOn("media"))
        refreshAwake()
    }

    override fun onPause() {
        resumed = false
        MainActivity.shown = false
        refreshAwake()
        core.pcMedia.desk(false)
        core.background()
        super.onPause()
    }

    override fun onDestroy() {
        unregisterReceiver(power)
        super.onDestroy()
    }

    private fun refreshAwake() {
        awake.update(core.store.flag("desk.awake", false), plugged, resumed)
    }

    private fun openFiles() {
        if (!core.moduleOn("files")) return
        startActivity(Intent(this, MainActivity::class.java).putExtra("tab", "Files")
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}

@Composable
private fun DeskModeScreen(core: Core, battery: Int?, plugged: Boolean, close: () -> Unit, files: () -> Unit) {
    var now by androidx.compose.runtime.remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val context = LocalContext.current
    val host = core.host
    val connected = host != null && core.link.connected
    val playing = core.pcMedia.now.takeIf { connected && core.moduleOn("media") }
    BoxWithConstraints(Modifier.fillMaxSize().background(pal.content).safeDrawingPadding()) {
        val wide = maxWidth >= 650.dp
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(tr("Desk mode"), color = pal.text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = close) { Text(tr("Close")) }
            }
            val clock: @Composable () -> Unit = {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(android.text.format.DateFormat.getTimeFormat(context).format(Date(now)), color = pal.text,
                        fontSize = if (wide) 76.sp else 52.sp, fontWeight = FontWeight.Light, textAlign = TextAlign.Center)
                    Text(DateFormat.getDateInstance(DateFormat.FULL).format(Date(now)), color = pal.muted, textAlign = TextAlign.Center)
                    battery?.let {
                        Text(tr("Battery {percent}%", "percent" to it) + if (plugged) " · " + tr("Plugged in") else "", color = pal.muted)
                    }
                    if (!plugged && core.store.flag("desk.awake", false)) Text(tr("Plug in to keep the screen on"), color = pal.muted, textAlign = TextAlign.Center)
                }
            }
            val controls: @Composable () -> Unit = {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(host?.name ?: tr("Open TwinDesk to connect to a computer"), color = pal.muted)
                    if (playing != null) {
                        Text(playing.title, color = pal.text, fontWeight = FontWeight.SemiBold, fontSize = 22.sp)
                        Text(playing.artist.ifEmpty { playing.app }, color = pal.muted)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { if (core.host?.id == host?.id && core.link.connected) core.pcMedia.control("previous") }, modifier = Modifier.weight(1f)) { Text(tr("Previous")) }
                            Button(onClick = { if (core.host?.id == host?.id && core.link.connected) core.pcMedia.control("toggle") }, modifier = Modifier.weight(1f)) { Text(if (playing.playing) tr("Pause") else tr("Play")) }
                            TextButton(onClick = { if (core.host?.id == host?.id && core.link.connected) core.pcMedia.control("next") }, modifier = Modifier.weight(1f)) { Text(tr("Next")) }
                        }
                    } else if (connected) Text(tr("No music is playing on {name}", "name" to host.name), color = pal.text)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(
                            onClick = {
                                if (core.host?.id == host?.id && core.link.connected && core.moduleOn("remote") && core.remote.allowed != false)
                                    context.startActivity(Intent(context, RemoteActivity::class.java).putExtra("mode", "pad"))
                            },
                            enabled = connected && core.moduleOn("remote") && core.remote.allowed != false,
                            modifier = Modifier.weight(1f),
                        ) { Text(tr("Touchpad")) }
                        Button(onClick = files, enabled = core.moduleOn("files"), modifier = Modifier.weight(1f)) { Text(tr("Files")) }
                    }
                }
            }
            if (wide) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                Column(Modifier.weight(1f)) { clock() }
                Column(Modifier.weight(1f)) { controls() }
            } else {
                clock()
                controls()
            }
        }
    }
}
