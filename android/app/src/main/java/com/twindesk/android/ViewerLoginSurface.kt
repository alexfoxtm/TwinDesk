// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay


@Composable
internal fun viewerLoginBehindVideo(core: Core, login: Boolean, lockPage: LockPage): Boolean {
    val s = core.screen
    var fastLatched by remember(core.host?.id) { mutableStateOf(false) }
    LaunchedEffect(login, core.lockView.locked, s.videoPlaying, s.videoUnavailable, s.sharing) {
        if (!login || core.lockView.locked || !s.sharing || s.videoUnavailable) fastLatched = false
        else if (s.videoPlaying) fastLatched = true
    }
    LaunchedEffect(login, core.lockView.locked, fastLatched, s.videoPlaying) {
        if (login && !core.lockView.locked && fastLatched && !s.videoPlaying) {
            delay(10000)
            if (!s.videoPlaying) fastLatched = false
        }
    }
    // A stale RFB crop must stay behind the regular viewer until the next lock reconnects it.
    val fast = login && !core.lockView.locked && (s.videoPlaying || fastLatched || core.lockView.layoutStale)
    LaunchedEffect(login, fast) { if (login) lockPage.present(!fast) }
    return fast
}

@Composable
internal fun ObserveViewerLogin(core: Core, login: Boolean, openLogin: () -> Unit, closeLogin: () -> Unit, onOffered: () -> Unit) {
    var offered by remember(core.host?.id) { mutableStateOf(false) }
    LaunchedEffect(core.lockView.locked, core.lockView.available, login) {
        if (!core.lockView.locked) offered = false
        if (login && !core.lockView.available) closeLogin()
        else if (core.lockView.locked && core.lockView.available && !login && !offered) {
            offered = true
            android.util.Log.i("TwinDeskLock", "viewer-auto-open")
            openLogin()
            onOffered()
        }
    }
}

@Composable
internal fun ViewerLoginSurface(lockPage: LockPage, fast: Boolean, bar: Boolean, keyboard: Boolean) {
    val showLogin = !fast
    // Keep the login fields below the viewer handle and toolbar, including in landscape.
    Box(Modifier.fillMaxSize().zIndex(if (fast) -1f else 0f).padding(top = if (bar && !keyboard) 92.dp else 8.dp)) {
        AndroidView(factory = { lockPage.view.also { (it.parent as? android.view.ViewGroup)?.removeView(it) } }, modifier = Modifier.fillMaxSize())
        if (showLogin && lockPage.credentialsRequested) AndroidView(
            factory = { lockPage.authView.also { (it.parent as? android.view.ViewGroup)?.removeView(it) } },
            modifier = Modifier.align(Alignment.Center).fillMaxHeight().widthIn(max = 480.dp).fillMaxWidth().imePadding(),
        )
    }
}

@Composable
internal fun ViewerWithLogin(
    core: Core,
    host: WebHost,
    rail: MirrorRail,
    started: Boolean,
    lockPage: LockPage,
    login: Boolean,
    openLogin: () -> Unit,
    closeLogin: () -> Unit,
    close: () -> Unit,
) {
    ViewerFrame(core, host, close) {
        val bar = remember { mutableStateOf(true) }
        val keyboard = viewerKeyboardVisible()
        val revision by core.version.collectAsState()
        @Suppress("UNUSED_EXPRESSION") revision
        val fast = viewerLoginBehindVideo(core, login, lockPage)
        val showLogin = login && !fast
        ObserveViewerLogin(core, login, openLogin, closeLogin) { bar.value = true }
        if (login) ViewerLoginSurface(lockPage, fast, bar.value, keyboard)
        val stop: () -> Unit = { closeLogin(); core.screen.control(share = false) }
        val end: () -> Unit = { closeLogin(); core.screen.end(); close() }
        if (showLogin) {
            LaunchedEffect(rail) { rail.showEdge(true) }
            val reduceMotion = android.provider.Settings.Global.getFloat(
                LocalContext.current.contentResolver,
                android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
                1f,
            ) == 0f
            if (!keyboard) Box(
                Modifier.align(Alignment.TopCenter).padding(top = 4.dp).width(72.dp).height(18.dp)
                    .clip(RoundedCornerShape(9.dp)).background(Color(0x55FFFFFF))
                    .clickable { bar.value = !bar.value },
            )
            AnimatedVisibility(
                bar.value && !keyboard,
                enter = if (reduceMotion) EnterTransition.None else fadeIn(),
                exit = if (reduceMotion) ExitTransition.None else fadeOut(),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 28.dp, start = 8.dp, end = 8.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124))
                        .horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(core.host?.name ?: "Mac", color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 8.dp).widthIn(max = 160.dp))
                    Text(doctorTransport(core), color = Color.White, fontSize = 11.sp,
                        modifier = Modifier.padding(end = 4.dp).clip(RoundedCornerShape(6.dp))
                            .background(if (core.link.wired) Color(0xFF30D158).copy(alpha = 0.35f) else Color(0x33FFFFFF))
                            .padding(horizontal = 6.dp, vertical = 2.dp))
                    TextButton(onClick = { stop(); bar.value = true }) { Text(tr("Stop"), color = Color.White) }
                    TextButton(onClick = { closeLogin(); bar.value = true }) { Text(tr("Back"), color = Color.White) }
                    TextButton(onClick = { lockPage.keyboard(!keyboard); bar.value = true }) {
                        Text(if (keyboard) tr("Hide keyboard") else tr("Keyboard"), color = Color.White)
                    }
                    TextButton(onClick = end) { Text(tr("Close"), color = Color.White) }
                }
            }
        } else {
            val entries = if (core.lockView.locked && core.lockView.available && !login) {
                listOf(ViewerMenuEntry(tr("Open Mac login screen"), false) { openLogin(); bar.value = true })
            } else emptyList()
            val toggleKeyboard: () -> Unit = { core.screen.keyboard(!keyboard) }
            ViewerChrome(core, host, rail, started, bar, keyboard,
                toggleKeyboard = toggleKeyboard,
                stop = stop,
                close = end,
                moreEntries = { viewerMoreEntries(core, rail) + entries },
                rowEntries = entries + viewerRowEntries(keyboard, toggleKeyboard, end),
            )
        }
    }
}
