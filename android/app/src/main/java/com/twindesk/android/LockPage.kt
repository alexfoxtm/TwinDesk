// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.annotation.SuppressLint
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import java.io.ByteArrayInputStream

// A protected local page inside ViewerActivity. It has no general WebHost/session bridge.
@SuppressLint("SetJavaScriptEnabled")
class LockPage(private val activity: ComponentActivity, private val core: Core, private val unlocked: () -> Unit) {
    @Volatile private var visible = false
    @Volatile private var ready = false
    @Volatile private var generation = 0
    private var owner: Any? = null
    val view = object : WebView(activity) {
        override fun onCreateInputConnection(info: android.view.inputmethod.EditorInfo): android.view.inputmethod.InputConnection? {
            info.imeOptions = info.imeOptions or android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            return super.onCreateInputConnection(info)?.also {
                info.imeOptions = info.imeOptions or android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            }
        }
    }.apply {
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
                val mime = when { path.endsWith(".js") -> "text/javascript"; path.endsWith(".css") -> "text/css"; path.endsWith(".html") -> "text/html"; else -> "application/octet-stream" }
                return runCatching { WebResourceResponse(mime, "UTF-8", 200, "OK", mapOf(
                    "Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
                    "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"
                ), activity.assets.open(path.removePrefix("/"))) }.getOrElse { blocked() }
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                close(); activity.finish(); return true
            }
        }
    }

    fun open() {
        if (visible) return
        visible = true
        ready = false
        val token = Any()
        owner = token
        view.addJavascriptInterface(Bridge(++generation, token), "LockBridge")
        WebView.setWebContentsDebuggingEnabled(false)
        view.loadUrl("https://login.twindesk.invalid/lock/lock.html")
    }

    fun keyboard(on: Boolean = true) {
        if (!visible || !ready) return
        if (!on) {
            activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(view.windowToken, 0)
            return
        }
        val mine = generation
        view.requestFocus()
        view.evaluateJavascript("window.lockKeyboard && window.lockKeyboard();") { focused ->
            if (visible && mine == generation && focused == "true") activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(view, 0)
        }
    }

    fun close() {
        visible = false
        ready = false
        generation++
        owner?.let { core.lockView.endFor(it) }
        owner = null
        view.removeJavascriptInterface("LockBridge")
        view.evaluateJavascript("window.lockClose && window.lockClose();", null)
        view.loadUrl("about:blank")
    }

    fun destroy() { close(); view.removeJavascriptInterface("LockBridge"); view.destroy() }
    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
    private inner class Bridge(private val mine: Int, private val token: Any) {
        private fun current() = mine == generation && visible
        @JavascriptInterface fun tr(text: String): String = com.twindesk.android.tr(text)
        @JavascriptInterface fun ready() = activity.runOnUiThread {
            if (!current() || ready) return@runOnUiThread
            ready = true
            core.lockView.attach(token) { message ->
                if (!current()) return@attach
                if (message.optString("t") == "unlocked") unlocked()
                else view.evaluateJavascript("window.lockRecv && window.lockRecv($message);", null)
            }
        }
        @JavascriptInterface fun send(data: String) { if (current() && ready) core.lockView.send(token, data) }
        @JavascriptInterface fun ack() { if (current() && ready) core.lockView.ack(token) }
        @JavascriptInterface fun close() = activity.runOnUiThread { if (current()) core.lockView.endFor(token) }
        @JavascriptInterface fun keyboard() = activity.runOnUiThread { if (current() && ready) this@LockPage.keyboard() }
    }
}
