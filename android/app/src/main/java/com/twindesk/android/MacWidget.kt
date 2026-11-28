// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.RemoteViews
import java.util.concurrent.atomic.AtomicBoolean
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MacWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) MacWidget.render(ctx, id, force = true)
    }

    override fun onAppWidgetOptionsChanged(ctx: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        MacWidget.render(ctx, id, force = true)
    }

    override fun onDeleted(ctx: Context, ids: IntArray) {
        for (id in ids) MacWidget.delete(ctx, id)
    }
}

internal object MacWidget {
    const val CONNECT = "com.twindesk.android.widget.CONNECT"
    const val TOUCHPAD = "com.twindesk.android.widget.TOUCHPAD"
    const val DISPATCH_CONNECT = "com.twindesk.android.widget.DISPATCH_CONNECT"

    enum class ConnectResult { STARTED, WAITING_FOR_NETWORK, UNAVAILABLE }

    data class Binding(val hostId: String, val pair: String, val revision: String) {
        val stored = "$pair\n$revision\n$hostId"
    }

    data class Request(val id: Int, val binding: Binding) {
        val key = id.toString()
    }

    private data class Display(
        val name: String, val status: String, val action: String? = null, val caption: String? = null,
        val revision: String? = null, val touchpad: Touchpad? = null,
    )

    class Touchpad(val request: Request, val route: Link.TrustedRoute, val routeRevision: Any) {
        val ticket: String = Proto.randomHex(16)

        fun current(core: Core): Boolean = prefs(core.ctx).getString(request.key, null) == request.binding.stored &&
            core.store.hasWidgetPair(request.binding.hostId, request.binding.pair) &&
            core.link.widgetRouteRevision === routeRevision && core.link.accepts(route)
    }

    // Launcher snapshots and dispatch tickets are process-local. The saved widget has only an
    // opaque pair reference, its Mac ID and a random configuration revision.
    private val displayed = mutableMapOf<Int, Display>()
    private var connectDispatch: Pair<String, Request>? = null
    private val main = Handler(Looper.getMainLooper())
    private val refresh = AtomicBoolean()
    private const val PREFS = "macWidgets"

    private fun manager(ctx: Context) = AppWidgetManager.getInstance(ctx)
    private fun provider(ctx: Context) = ComponentName(ctx, MacWidgetProvider::class.java)
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun owns(ctx: Context, id: Int): Boolean =
        id != AppWidgetManager.INVALID_APPWIDGET_ID && manager(ctx).getAppWidgetInfo(id)?.provider == provider(ctx)

    private fun binding(ctx: Context, id: Int): Binding? {
        val parts = prefs(ctx).getString(id.toString(), null)?.split('\n', limit = 3) ?: return null
        return parts.takeIf { it.size == 3 }?.let { Binding(it[2], it[0], it[1]) }
    }

    fun configure(ctx: Context, id: Int, store: Store, host: Host): Boolean {
        if (!owns(ctx, id)) return false
        val pair = store.bindWidgetPair(host) ?: return false
        val binding = Binding(host.id, pair, Proto.randomHex(16))
        prefs(ctx).edit().putString(id.toString(), binding.stored).apply()
        render(ctx, id)
        return true
    }

    fun delete(ctx: Context, id: Int) {
        prefs(ctx).edit().remove(id.toString()).apply()
        displayed.remove(id)
    }

    fun changed(ctx: Context) {
        if (!refresh.compareAndSet(false, true)) return
        main.postDelayed({
            refresh.set(false)
            if (prefs(ctx).all.isNotEmpty()) {
                for (id in manager(ctx).getAppWidgetIds(provider(ctx))) render(ctx, id)
            }
        }, 150)
    }

    fun saved(ctx: Context, store: Store, request: Request): Host? {
        if (binding(ctx, request.id) != request.binding || !owns(ctx, request.id)) return null
        return store.widgetPair(request.binding.hostId, request.binding.pair)
    }

    // Only the private trampoline creates this one-use handoff to the exported MainActivity.
    fun forwardConnect(ctx: Context, intent: Intent): Intent? {
        val store = Core.running()?.store ?: Store(ctx)
        val request = request(ctx, intent, CONNECT) ?: return null
        if (saved(ctx, store, request) == null) return null
        val ticket = Proto.randomHex(16)
        connectDispatch = ticket to request
        return Intent(ctx, MainActivity::class.java).setAction(DISPATCH_CONNECT)
            .putExtra("ticket", ticket).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }

    fun takeConnect(intent: Intent): Request? {
        val dispatch = connectDispatch ?: return null
        if (intent.action != DISPATCH_CONNECT || intent.getStringExtra("ticket") != dispatch.first) return null
        connectDispatch = null
        return dispatch.second
    }

    fun touchpad(ctx: Context, intent: Intent, core: Core): Touchpad? {
        val request = request(ctx, intent, TOUCHPAD) ?: return null
        val pad = displayed[request.id]?.touchpad ?: return null
        val host = saved(ctx, core.store, request) ?: return null
        if (pad.request != request || pad.ticket != intent.data?.pathSegments?.getOrNull(2) ||
            core.host?.sameWidgetPair(host) != true || !pad.current(core) || !core.remote.widgetAllowed(pad.route)) return null
        return pad
    }

    private fun tapParts(ctx: Context, intent: Intent): List<String>? {
        val uri = intent.data ?: return null
        return uri.pathSegments.takeIf { uri.scheme == "twindesk-widget" && uri.authority == ctx.packageName }
    }

    fun refreshRejectedTap(ctx: Context, intent: Intent) {
        if (intent.action != CONNECT && intent.action != TOUCHPAD) return
        val id = tapParts(ctx, intent)?.firstOrNull()?.toIntOrNull() ?: return
        render(ctx, id, force = true)
    }

    private fun request(ctx: Context, intent: Intent, action: String): Request? {
        if (intent.action != action) return null
        val parts = tapParts(ctx, intent) ?: return null
        if (parts.size != if (action == CONNECT) 2 else 3) return null
        val id = parts[0].toIntOrNull() ?: return null
        if (!owns(ctx, id)) return null
        val binding = binding(ctx, id)?.takeIf { it.revision == parts[1] } ?: return null
        return Request(id, binding)
    }

    private fun routeName(core: Core, host: Host, tr: (String) -> String): String {
        val link = core.link
        if (link.embedded || link.wired || link.ble) return tr(core.net.via)
        val (address, port) = link.endpoint() ?: return tr(core.net.via)
        return when {
            address == "127.0.0.1" && port in Relay.ports -> tr("Relay")
            address == Tailnet.address(host) && address != host.address -> "Tailscale"
            else -> tr(core.net.via)
        }
    }

    fun render(ctx: Context, id: Int, force: Boolean = false) {
        if (!owns(ctx, id)) return
        val core = Core.running()
        val store = core?.store ?: Store(ctx)
        val tr = I18n.textFor(ctx, store)
        val binding = binding(ctx, id)
        val h = binding?.let { store.widgetPair(it.hostId, it.pair) }
        val route = core?.link?.currentTrustedRoute()?.takeIf {
            h != null && it.id == h.id && it.fp == h.fp && core.host?.sameWidgetPair(h) == true && core.link.accepts(it)
        }
        val display = if (binding == null || h == null) {
            Display(ctx.getString(R.string.mac_widget_label), tr("Choose a saved Mac"))
        } else if (core == null || route == null) {
            val connecting = core?.link?.state == "connecting" && core.link.host?.sameWidgetPair(h) == true
            val canConnect = !store.flag(Core.CABLE_ONLY, false) && !connecting && core?.host == null && core?.peer?.connected != true &&
                core?.link?.pair == null && core?.link?.state != "connecting"
            Display(h.name, tr(if (connecting) "Connecting…" else "Not connected"),
                CONNECT.takeIf { canConnect }, tr("Connect").takeIf { canConnect }, binding.revision)
        } else {
            val request = Request(id, binding)
            val pad = if (!core.moduleOn("remote") || !core.remote.widgetAllowed(route)) null
                else (displayed[id]?.touchpad?.takeIf { it.request == request && it.current(core) }
                    ?: Touchpad(request, route, core.link.widgetRouteRevision)).takeIf { it.current(core) }
            Display(h.name, tr("Connected") + " · " + routeName(core, h, tr),
                TOUCHPAD.takeIf { pad != null }, tr("Touchpad").takeIf { pad != null }, binding.revision, pad)
        }
        if (!force && display == displayed[id]) return
        val views = RemoteViews(ctx.packageName, R.layout.mac_widget)
        views.setTextViewText(R.id.widget_mac_name, display.name)
        views.setTextViewText(R.id.widget_mac_status, display.status)
        views.setViewVisibility(R.id.widget_mac_action, if (display.caption == null) View.GONE else View.VISIBLE)
        if (h == null) {
            val configure = Intent(ctx, MacWidgetConfigureActivity::class.java)
                .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
                .setData(Uri.Builder().scheme("twindesk-widget").authority(ctx.packageName)
                    .appendPath(id.toString()).appendPath("configure").build())
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            views.setOnClickPendingIntent(R.id.widget_mac_root,
                PendingIntent.getActivity(ctx, id, configure, PendingIntent.FLAG_IMMUTABLE))
        } else views.setOnClickPendingIntent(R.id.widget_mac_root, null)
        if (display.action != null && display.revision != null) {
            val uri = Uri.Builder().scheme("twindesk-widget").authority(ctx.packageName)
                .appendPath(id.toString()).appendPath(display.revision)
            display.touchpad?.let { uri.appendPath(it.ticket) }
            val target = if (display.action == CONNECT) MacWidgetConnectActivity::class.java else MacWidgetTouchpadActivity::class.java
            val action = Intent(ctx, target).setAction(display.action).setData(uri.build())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            views.setTextViewText(R.id.widget_mac_action, display.caption)
            views.setOnClickPendingIntent(R.id.widget_mac_action,
                PendingIntent.getActivity(ctx, id, action, PendingIntent.FLAG_IMMUTABLE))
        }
        manager(ctx).updateAppWidget(id, views)
        displayed[id] = display
    }
}

class MacWidgetConnectActivity : android.app.Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dispatch = MacWidget.forwardConnect(this, intent)
        if (dispatch != null) startActivity(dispatch) else MacWidget.refreshRejectedTap(this, intent)
        finish()
    }
}

class MacWidgetConfigureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val result = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
        setResult(RESULT_CANCELED, result)
        if (intent.action != AppWidgetManager.ACTION_APPWIDGET_CONFIGURE || !MacWidget.owns(this, id)) {
            finish()
            return
        }
        val store = Core.running()?.store ?: Store(this)
        val tr = I18n.textFor(this, store)
        val hosts = mutableStateOf(store.hosts().filter(::eligible))
        setContent {
            Theme {
                androidx.compose.material3.Surface {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
                        PageHead(getString(R.string.mac_widget_label), tr("Choose a saved Mac"))
                        if (hosts.value.isEmpty()) Text(tr("Pair a Mac in TwinDesk first."))
                        MacCard {
                            hosts.value.forEachIndexed { index, host ->
                                MacRow(host.name, "", first = index == 0) {
                                    Button(onClick = {
                                        if (MacWidget.configure(this@MacWidgetConfigureActivity, id, store, host)) {
                                            setResult(RESULT_OK, result)
                                            finish()
                                        } else hosts.value = store.hosts().filter(::eligible)
                                    }) { Text(tr("Save")) }
                                }
                            }
                        }
                        Button(onClick = { finish() }) { Text(tr("Cancel")) }
                    }
                }
            }
        }
    }

    private fun eligible(h: Host) = h.os == "mac" && h.fp.isNotBlank() && h.token.isNotBlank()
}
