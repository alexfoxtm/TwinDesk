// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import java.io.ByteArrayInputStream

// Separate from WebHost: it cannot send session commands, use clipboard, or log page output.
class LockActivity : ComponentActivity() {
    private var page: WebView? = null
    @Volatile private var accepted = false
    @Volatile private var visible = false
    @Volatile private var ready = false
    private val core get() = Core.get(this)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WebView.setWebContentsDebuggingEnabled(false)
        val web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            @Suppress("DEPRECATION")
            settings.databaseEnabled = false
            settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            @Suppress("DEPRECATION")
            settings.saveFormData = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            isFocusable = true
            isFocusableInTouchMode = true
            setBackgroundColor(android.graphics.Color.BLACK)
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage) = true
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val uri = request.url
                    val path = uri.path.orEmpty()
                    if (request.method != "GET" || uri.scheme != "https" || uri.host != "login.twindesk.invalid" || uri.port != -1 || uri.query != null ||
                        path.contains("..") || path.contains('\\') || !Regex("/(?:lock/(?:lock\\.html|lock\\.js|lock\\.css)|novnc/[A-Za-z0-9_./-]+)").matches(path)) return blocked()
                    val asset = path.removePrefix("/")
                    val mime = when { path.endsWith(".js") -> "text/javascript"; path.endsWith(".css") -> "text/css"; path.endsWith(".html") -> "text/html"; else -> "application/octet-stream" }
                    return runCatching { WebResourceResponse(mime, "UTF-8", 200, "OK", mapOf(
                        "Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
                        "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"
                    ), assets.open(asset)) }.getOrElse { blocked() }
                }
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    core.lockView.endFor(this@LockActivity); finish(); return true
                }
            }
            addJavascriptInterface(Bridge(), "LockBridge")
        }
        page = web
        setContent { Theme {
            var consent by remember { mutableStateOf(true) }
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                    Text(tr("Mac login screen"), Modifier.weight(1f).padding(top = 12.dp))
                    TextButton(onClick = {
                        web.requestFocus()
                        web.evaluateJavascript("window.lockKeyboard && window.lockKeyboard();") { focused ->
                            if (visible && focused == "true") getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                                .showSoftInput(web, 0)
                        }
                    }) { Text(tr("Keyboard")) }
                    TextButton(onClick = { finish() }) { Text(tr("Close")) }
                }
                AndroidView(factory = { web }, modifier = Modifier.weight(1f).fillMaxWidth())
            }
            if (consent) AlertDialog(onDismissRequest = { finish() },
                title = { Text(tr("Open Mac login screen")) },
                text = { Text(tr("Sign in to Screen Sharing with your Mac account, then unlock the Mac. Your password is used only for this connection and is not saved. Screen Sharing must already be enabled on the Mac.")) },
                confirmButton = { TextButton(onClick = {
                    consent = false; accepted = true
                    web.loadUrl("https://login.twindesk.invalid/lock/lock.html")
                }) { Text(tr("Continue")) } },
                dismissButton = { TextButton(onClick = { finish() }) { Text(tr("Cancel")) } })
        } }
    }

    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    private inner class Bridge {
        @JavascriptInterface fun tr(text: String): String = com.twindesk.android.tr(text)
        @JavascriptInterface fun ready() = runOnUiThread {
            if (!visible || !accepted || ready) return@runOnUiThread
            ready = true
            core.lockView.attach(this@LockActivity) { message ->
                if (message.optString("t") == "unlocked") finish()
                else page?.evaluateJavascript("window.lockRecv && window.lockRecv($message);", null)
            }
        }
        @JavascriptInterface fun send(data: String) { if (visible && accepted && ready) core.lockView.send(this@LockActivity, data) }
        @JavascriptInterface fun ack() { if (visible && accepted && ready) core.lockView.ack(this@LockActivity) }
        @JavascriptInterface fun close() = runOnUiThread { core.lockView.endFor(this@LockActivity) }
    }

    override fun onStart() { super.onStart(); visible = true }
    override fun onStop() {
        visible = false
        ready = false
        core.lockView.endFor(this@LockActivity)
        ViewerActivity.loginViewStopped(intent.getIntExtra("lockHandoff", -1))
        page?.evaluateJavascript("window.lockClose && window.lockClose();", null)
        super.onStop()
        finish()
    }

    override fun onDestroy() {
        ViewerActivity.loginViewStopped(intent.getIntExtra("lockHandoff", -1))
        core.lockView.endFor(this@LockActivity)
        page?.apply { removeJavascriptInterface("LockBridge"); loadUrl("about:blank"); destroy() }
        page = null
        super.onDestroy()
    }
}
