// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay

@Composable
internal fun viewerKeyboardVisible(): Boolean = WindowInsets.ime.getBottom(LocalDensity.current) > 0

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
