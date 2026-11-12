// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen, full screen: Mirror (the Mac's own screen) or Extend (a second screen for the
// Mac, sized to this one). The picture and the touches are viewer.html's; this activity adds a
// small bar (tap the handle at the top): Mirror / Extend, Start / Stop, keyboard, close.
package com.twindesk.android

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.delay

class ViewerActivity : ComponentActivity() {
    private var host: WebHost? = null
    private var started = false
    private var attached = false
    private var viewport: Pair<Int, Int>? = null
    private var lockPage: LockPage? = null
    private var login by mutableStateOf(false)
    private val resize = Runnable { updateViewport() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        val core = Core.get(this)
        val h = WebHost(this, "viewer.html", core) { ev, data ->
            if (ev == "playing" && data != null) core.screen.playing(data.optInt("w"), data.optInt("h"))
        }
        host = h
        h.view.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                h.view.removeCallbacks(resize)
                h.view.postDelayed(resize, 250)
            }
        }
        val locked = LockPage(this, core) { h.view.post { login = false; lockPage?.close(); window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
        lockPage = locked
        setContent { Theme { Viewer(core, h, locked, login, openLogin = {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            login = true
            locked.open()
        }, closeLogin = { login = false; locked.close(); window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }) { finish() } } }
    }

    override fun onStart() {
        super.onStart()
        started = true
        host?.view?.post(resize)
    }

    private fun updateViewport() {
        if (!started) return
        val h = host ?: return
        val w = h.view.width
        val hpx = h.view.height
        if (w <= 0 || hpx <= 0) return
        val core = Core.get(this)
        // The measured WebView follows folds, split windows and cutouts. Mac Extend can use
        // portrait; other hosts keep the landscape policy their virtual monitors already expect.
        val next = if (core.host?.os == "mac") w to hpx else maxOf(w, hpx) to minOf(w, hpx)
        if (viewport == next) return
        viewport = next
        if (attached) core.screen.resize(h, next.first, next.second)
        else { attached = true; core.screen.attach(h, next.first, next.second) }
    }

    override fun onStop() {
        super.onStop()
        started = false
        login = false
        lockPage?.close()
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        host?.view?.removeCallbacks(resize)
        host?.let { Core.get(this).screen.detach(it) }
        attached = false
        viewport = null
    }

    override fun onDestroy() {
        lockPage?.destroy()
        lockPage = null
        host?.destroy()
        host = null
        super.onDestroy()
    }
}

@androidx.compose.runtime.Composable
private fun Viewer(core: Core, host: WebHost, lockPage: LockPage, login: Boolean, openLogin: () -> Unit, closeLogin: () -> Unit, close: () -> Unit) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v
    var bar by remember { mutableStateOf(true) }
    val keyboard = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    LaunchedEffect(bar, login) { if (bar && !login) { delay(4000); bar = false } }
    var offered by remember(core.host?.id) { mutableStateOf(false) }
    LaunchedEffect(core.lockView.locked, core.lockView.available, login) {
        if (!core.lockView.locked) offered = false
        if (login && !core.lockView.available) closeLogin()
        else if (core.lockView.available && !login && !offered) {
            offered = true
            openLogin()
            bar = true
        }
    }
    val s = core.screen
    val name = core.host?.name ?: "Mac"
    // Opened because the computer started sharing: it closes when the computer stops.
    var seenOn by remember { mutableStateOf(false) }
    LaunchedEffect(s.sharing, v) {
        if (s.sharing) seenOn = true
        else if (seenOn && s.autoOpened && s.state != null) close()
    }

    Box(Modifier.fillMaxSize().background(Color.Black).windowInsetsPadding(WindowInsets.displayCutout)) {
        AndroidView(factory = { host.view.also { (it.parent as? android.view.ViewGroup)?.removeView(it) } }, modifier = Modifier.fillMaxSize())
        // Keep the login fields below the viewer handle and toolbar, including in landscape.
        if (login) AndroidView(factory = { lockPage.view.also { (it.parent as? android.view.ViewGroup)?.removeView(it) } }, modifier = Modifier.fillMaxSize().padding(top = if (bar && !keyboard) 92.dp else 8.dp).imePadding())
        // A small handle at the top: tap for the bar (the rest of the screen is the Mac's).
        if (!login || !keyboard) Box(
            Modifier.align(Alignment.TopCenter).padding(top = 4.dp).width(72.dp).height(18.dp)
                .clip(RoundedCornerShape(9.dp)).background(Color(0x55FFFFFF)).clickable { bar = !bar },
        )
        AnimatedVisibility(bar && !(login && keyboard), enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter).padding(top = 28.dp)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124))
                        .horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(name, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 8.dp).widthIn(max = 160.dp))
                    // Which way the picture comes: the USB cable, or Wi-Fi.
                    Text(
                        if (core.link.wired) "USB" else "Wi-Fi", color = Color.White, fontSize = 11.sp,
                        modifier = Modifier.padding(end = 4.dp).clip(RoundedCornerShape(6.dp))
                            .background(if (core.link.wired) Color(0xFF30D158).copy(alpha = 0.35f) else Color(0x33FFFFFF)).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                    if (s.remote && !login) {
                        for (mode in listOf("mirror", "extend")) {
                            val on = s.sharing && s.mode == mode
                            val label = if (mode == "mirror") tr("Mirror") else tr("Extend")
                            if (on) FilledTonalButton(onClick = { bar = true }) { Text(label) }
                            else TextButton(onClick = { s.pick(mode); bar = true }) { Text(label, color = Color.White) }
                        }
                        if (s.sharing) TextButton(onClick = { s.control(share = false) }) { Text(tr("Stop"), color = Color.White) }
                    }
                    if (core.lockView.available && !login) TextButton(onClick = { openLogin(); bar = true }) { Text(tr("Open Mac login screen"), color = Color.White) }
                    if (login) TextButton(onClick = { closeLogin(); s.control(share = false); bar = true }) { Text(tr("Stop"), color = Color.White) }
                    if (login) TextButton(onClick = { closeLogin(); bar = true }) { Text(tr("Back"), color = Color.White) }
                    TextButton(onClick = { if (login) lockPage.keyboard(!keyboard) else s.keyboard(!keyboard); bar = true }) { Text(if (keyboard) tr("Hide keyboard") else tr("Keyboard"), color = Color.White) }
                    TextButton(onClick = { closeLogin(); s.end(); close() }) { Text(tr("Close"), color = Color.White) }
                }
                if (!login && s.remote && s.displays.size > 1) {
                    Row(
                        Modifier.padding(top = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124)).padding(horizontal = 8.dp, vertical = 2.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        MacDisplayPick(s.displays, if (s.sharing && s.mode != "extend") s.displayId else "", onDark = true) { s.pickDisplay(it); bar = true }
                    }
                }
            }
        }
    }
}
