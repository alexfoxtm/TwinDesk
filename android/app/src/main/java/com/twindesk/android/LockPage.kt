// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.annotation.SuppressLint
import android.view.View
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.text.InputType
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.io.ByteArrayInputStream

// A protected local page inside ViewerActivity. It has no general WebHost/session bridge.
@SuppressLint("SetJavaScriptEnabled")
class LockPage(private val activity: ComponentActivity, private val core: Core, private val unlocked: () -> Unit) {
    @Volatile private var visible = false
    @Volatile private var ready = false
    @Volatile private var generation = 0
    private var owner: Any? = null
    private var foreground = true
    var credentialsRequested by mutableStateOf(false); private set
    private val account: EditText = credentialField(false)
    private val secret: EditText = credentialField(true)
    private var suggestedAccount: String? = null
    private var manualAccount = false
    private val vault = LockVault(activity)
    private var pendingSave: Triple<Host, String, String>? = null
    private var usedSavedHost: String? = null
    private val rememberPassword = CheckBox(activity).apply {
        text = tr("Remember Screen Sharing password on this phone")
        setTextColor(0xffffffff.toInt())
        isChecked = false
        minHeight = dp(48)
    }
    private val useSaved = Button(activity).apply {
        text = tr("Use saved password")
        visibility = View.GONE
        setOnClickListener {
            val host = core.host ?: return@setOnClickListener
            val saved = vault.load(host) ?: return@setOnClickListener
            usedSavedHost = host.id
            submitCredentials(saved.first, saved.second, false)
        }
    }
    private val forgetSaved = Button(activity).apply {
        text = tr("Forget saved password")
        visibility = View.GONE
        setOnClickListener { core.host?.let { vault.forget(it.id) }; updateSaved() }
    }
    private val accountLabel = TextView(activity).apply {
        text = tr("Mac account name"); labelFor = account.id; setTextColor(0xffffffff.toInt()); textSize = 14f
        setPadding(0, dp(8), 0, dp(4))
    }
    private val changeAccount = Button(activity).apply {
        text = tr("Use a different account"); visibility = View.GONE
        setOnClickListener { manualAccount = true; updateAccountFields(); updateSaved(); focusedField = account; account.requestFocus() }
    }
    private val authError = TextView(activity).apply { setTextColor(0xffffb4ab.toInt()); visibility = View.GONE; isSaveEnabled = false }
    private var focusedField: EditText = account
    val authView = ScrollView(activity).apply {
        isFillViewport = true
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        isSaveEnabled = false
        addView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(16))
            fun label(text: String, field: EditText) = addView(TextView(activity).apply {
                this.text = text; labelFor = field.id; setTextColor(0xffffffff.toInt()); textSize = 14f
                setPadding(0, dp(8), 0, dp(4))
            })
            addView(accountLabel)
            addView(account, LinearLayout.LayoutParams(-1, dp(52)))
            label(tr("Mac account password"), secret)
            addView(secret, LinearLayout.LayoutParams(-1, dp(52)))
            addView(authError, LinearLayout.LayoutParams(-1, -2))
            addView(rememberPassword, LinearLayout.LayoutParams(-1, -2))
            addView(useSaved, LinearLayout.LayoutParams(-1, -2))
            addView(forgetSaved, LinearLayout.LayoutParams(-1, -2))
            addView(Button(activity).apply {
                text = tr("Sign in"); minHeight = dp(48); setOnClickListener { submitCredentials() }
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
            addView(changeAccount, LinearLayout.LayoutParams(-1, -2))
        }, android.widget.FrameLayout.LayoutParams(-1, -2))
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
    private fun credentialField(password: Boolean): EditText = EditText(activity).apply {
        id = View.generateViewId()
        setSingleLine(true)
        inputType = InputType.TYPE_CLASS_TEXT or if (password) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or if (password) EditorInfo.IME_ACTION_DONE else EditorInfo.IME_ACTION_NEXT
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        isSaveEnabled = false
        setTextColor(0xffffffff.toInt()); setHintTextColor(0xffb8bac0.toInt())
        backgroundTintList = android.content.res.ColorStateList.valueOf(0xff8b8e96.toInt())
        setPadding(dp(12), dp(8), dp(12), dp(8))
        setOnFocusChangeListener { _, hasFocus -> if (hasFocus) focusedField = this }
        setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_NEXT) { secret.requestFocus(); true }
            else if (action == EditorInfo.IME_ACTION_DONE) { submitCredentials(); true } else false
        }
    }

    private fun clearCredentials() { account.text.clear(); secret.text.clear(); authError.text = ""; authError.visibility = View.GONE }
    private fun updateSaved() {
        val saved = core.host?.let { vault.account(it) }
        val usable = vault.secure && saved != null
        useSaved.visibility = if (usable) View.VISIBLE else View.GONE
        useSaved.text = if (usable) tr("Use saved password for {account}", "account" to saved) else tr("Use saved password")
        forgetSaved.visibility = if (core.host?.let { vault.has(it.id) } == true) View.VISIBLE else View.GONE
        rememberPassword.visibility = if (vault.secure) View.VISIBLE else View.GONE
        if (!vault.secure) rememberPassword.isChecked = false
    }
    private fun updateAccountFields() {
        val automatic = suggestedAccount != null && !manualAccount
        account.visibility = if (automatic) View.GONE else View.VISIBLE
        accountLabel.text = if (automatic) "${tr("Mac account name")}: $suggestedAccount" else tr("Mac account name")
        accountLabel.visibility = View.VISIBLE
        changeAccount.visibility = if (automatic) View.VISIBLE else View.GONE
    }
    private fun submitCredentials(savedAccount: String? = null, savedPassword: String? = null, save: Boolean = rememberPassword.isChecked) {
        if (!visible || !ready || !credentialsRequested) return
        val username = savedAccount ?: if (!manualAccount) suggestedAccount ?: account.text.toString() else account.text.toString()
        val password = savedPassword ?: secret.text.toString()
        if (username.isEmpty() || password.isEmpty()) return
        if (username.toByteArray(Charsets.UTF_8).size > 63 || password.toByteArray(Charsets.UTF_8).size > 63) {
            authError.text = tr("Screen Sharing cannot use this account name or password because it exceeds 63 UTF-8 bytes.")
            authError.visibility = View.VISIBLE
            return
        }
        val mine = generation
        pendingSave = if (save && vault.secure) core.host?.let { Triple(it.copy(), username, password) } else null
        view.evaluateJavascript("window.lockCredentials && window.lockCredentials($mine, ${JSONObject.quote(username)}, ${JSONObject.quote(password)});") { result ->
            if (visible && mine == generation && result != "true") {
                pendingSave = null
                usedSavedHost = null
                credentialsRequested = true
                authError.text = tr("Login-screen connection ended. Close this view and try again.")
                authError.visibility = View.VISIBLE
            }
        }
        clearCredentials()
        credentialsRequested = false
        rememberPassword.isChecked = false
        activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(secret.windowToken, 0)
    }
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
        android.util.Log.i("TwinDeskLock", "page-open")
        visible = true
        ready = false
        credentialsRequested = false
        pendingSave = null
        usedSavedHost = null
        rememberPassword.isChecked = false
        clearCredentials()
        suggestedAccount = null
        manualAccount = false
        updateAccountFields()
        val token = Any()
        owner = token
        foreground = true
        core.lockView.present(token, true)
        view.addJavascriptInterface(Bridge(++generation, token), "LockBridge")
        WebView.setWebContentsDebuggingEnabled(false)
        view.loadUrl("https://login.twindesk.invalid/lock/lock.html")
    }

    fun present(on: Boolean) {
        if (!visible || foreground == on) return
        foreground = on
        owner?.let { core.lockView.present(it, on) }
        if (!on) { keyboard(false); view.clearFocus() }
        if (ready) view.evaluateJavascript("window.lockForeground && window.lockForeground($generation, $on);", null)
    }

    fun keyboard(on: Boolean = true) {
        if (!visible || !ready || (on && !foreground)) return
        if (credentialsRequested) {
            if (on) { focusedField.requestFocus(); activity.getSystemService(InputMethodManager::class.java).showSoftInput(focusedField, 0) }
            else activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(focusedField.windowToken, 0)
            return
        }
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
        if (visible) android.util.Log.i("TwinDeskLock", "page-close")
        visible = false
        ready = false
        credentialsRequested = false
        pendingSave = null
        usedSavedHost = null
        rememberPassword.isChecked = false
        clearCredentials()
        suggestedAccount = null
        manualAccount = false
        updateAccountFields()
        generation++
        owner?.let { core.lockView.present(it, false); core.lockView.endFor(it) }
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
        @JavascriptInterface fun pageId(): Int = mine
        @JavascriptInterface fun phase(value: String) {
            if (current() && value == "rfb-connected") core.lockView.markReady(token)
            if (value == "rfb-connected" || value == "security-failed" || value == "rfb-disconnected") activity.runOnUiThread {
                if (!current()) return@runOnUiThread
                val pending = pendingSave
                pendingSave = null
                if (value == "security-failed") usedSavedHost?.let { vault.forget(it); updateSaved() }
                if (value != "rfb-disconnected") usedSavedHost = null
                if (value == "rfb-connected" && pending != null && core.host?.let { it.id == pending.first.id && it.fp == pending.first.fp } == true) {
                    if (!vault.save(pending.first, pending.second, pending.third)) {
                        android.widget.Toast.makeText(activity, tr("Could not save password on this phone"), android.widget.Toast.LENGTH_LONG).show()
                    }
                }
            }
            if (current() && value in setOf("credentials-requested", "credentials-submitted", "security-failed", "rfb-connected", "rfb-disconnected", "framebuffer-data", "framebuffer-drawn"))
                android.util.Log.i("TwinDeskLock", value)
        }
        @JavascriptInterface fun geometry(fw: Int, fh: Int, cw: Int, ch: Int, vw: Int, vh: Int) {
            if (current() && listOf(fw, fh, cw, ch, vw, vh).all { it in 0..32768 })
                android.util.Log.i("TwinDeskLock", "geometry framebuffer=${fw}x$fh canvas=${cw}x$ch viewport=${vw}x$vh")
        }
        @JavascriptInterface fun credentials() = activity.runOnUiThread {
            if (current() && ready && !credentialsRequested) {
                clearCredentials(); updateAccountFields()
                updateSaved()
                focusedField = if (suggestedAccount != null && !manualAccount) secret else account
                credentialsRequested = true
            }
        }
        @JavascriptInterface fun ready() = activity.runOnUiThread {
            if (!current() || ready) return@runOnUiThread
            ready = true
            core.lockView.attach(token) { message ->
                if (!current()) return@attach
                if (message.optString("t") == "metadata") {
                    suggestedAccount = message.optString("account").takeIf { it.isNotBlank() }
                    manualAccount = false
                    updateAccountFields()
                    if (suggestedAccount != null) focusedField = secret
                    updateSaved()
                    message.remove("account") // The local web page needs only display geometry.
                }
                if (message.optString("t") == "closed") { credentialsRequested = false; pendingSave = null; clearCredentials() }
                if (message.optString("t") == "unlocked") unlocked()
                else view.evaluateJavascript("window.lockRecv && window.lockRecv($message);", null)
            }
        }
        @JavascriptInterface fun send(data: String) { if (current() && ready) core.lockView.send(token, data) }
        @JavascriptInterface fun ack() { if (current() && ready) core.lockView.ack(token) }
        @JavascriptInterface fun close() = activity.runOnUiThread { if (current()) core.lockView.endFor(token) }
        @JavascriptInterface fun keyboard() = activity.runOnUiThread { if (current() && ready && foreground) this@LockPage.keyboard() }
    }
}
