// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.Intent
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

// Metadata and resources are read off the UI and link threads. Matching versions need no bitmaps.
internal fun phoneAppsVersion(configuration: List<String>, packages: List<List<String>>): String {
    val digest = MessageDigest.getInstance("SHA-256")
    fun field(value: String) {
        val bytes = value.toByteArray()
        digest.update(bytes.size.toString().toByteArray())
        digest.update(':'.code.toByte())
        digest.update(bytes)
    }
    configuration.forEach(::field)
    packages.sortedBy { it.first() }.forEach { it.forEach(::field) }
    return digest.digest().hex()
}

internal inline fun phoneAppsResponse(version: String, known: String?, apps: () -> List<JSONObject>) =
    msg(Proto.T.PHONE_APPS, "version" to version).apply {
        if (known != version) put("apps", jsonArray(apps()))
    }

class Apps(core: Core) : Feature(core) {
    private data class Request(val route: Link.TrustedRoute, val version: String?)
    private var pending: Request? = null
    private var running = false

    fun onMessage(t: String, m: JSONObject, route: Link.TrustedRoute?): Boolean {
        if (t != Proto.T.PHONE_APPS_LIST) return false
        if (route != null && core.link.accepts(route)) enqueue(Request(route, m.opt("version") as? String))
        return true
    }

    @Synchronized private fun enqueue(request: Request) {
        pending = request
        if (!running) next()
    }

    @Synchronized private fun next() {
        val request = pending
        running = request != null
        if (request == null) return
        pending = null
        core.bg.execute {
            try { respond(request) } finally { next() }
        }
    }

    private fun respond(request: Request) {
        if (!core.link.accepts(request.route)) return
        val pm = core.ctx.packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(main, 0)
            .filter { it.activityInfo.packageName != core.ctx.packageName }
            .distinctBy { it.activityInfo.packageName }.take(2000)
        val icons = !core.link.ble
        // If a package changes while making its response, the next request recomputes this digest.
        val config = core.ctx.resources.configuration
        val metadata = apps.map {
            if (!core.link.accepts(request.route)) return
            it.metadata()
        }
        val version = phoneAppsVersion(listOf(config.locales.toLanguageTags(), config.uiMode.toString(),
            config.densityDpi.toString(), config.colorMode.toString(), icons.toString()), metadata)
        val response = phoneAppsResponse(version, request.version) {
            apps.map { ri ->
                if (!core.link.accepts(request.route)) return
                JSONObject().put("id", ri.activityInfo.packageName)
                    .put("name", ri.loadLabel(pm).toString().take(100))
                    .put("icon", if (icons) icon(ri.loadIcon(pm)) else "")
            }
        }
        core.link.sendFor(request.route, response)
    }

    @Suppress("DEPRECATION")
    private fun ResolveInfo.metadata(): List<String> {
        val activity = activityInfo
        val pm = core.ctx.packageManager
        val pkg = runCatching { pm.getPackageInfo(activity.packageName, 0) }.getOrNull()
        return listOf(activity.packageName, activity.name, pkg?.lastUpdateTime.toString(),
            pkg?.longVersionCode.toString(), labelRes.toString(), activity.labelRes.toString(),
            nonLocalizedLabel.toString(), iconResource.toString(), activity.applicationInfo.icon.toString())
    }

    private fun icon(d: Drawable): String = runCatching {
        val size = 96
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        d.setBounds(0, 0, size, size)
        d.draw(c)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrDefault("")
}
