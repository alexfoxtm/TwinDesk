// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import org.json.JSONObject

internal fun supportedVideoLink(value: String): Uri? {
    if (value.length > 2048) return null
    val uri = Uri.parse(value)
    if (uri.scheme != "https" || uri.userInfo != null || uri.port != -1) return null
    val host = uri.host ?: return null
    val path = uri.path ?: return null
    val supported = when (host) {
        "www.youtube.com" -> path == "/watch" && uri.getQueryParameter("v")?.matches(Regex("[A-Za-z0-9_-]{11}")) == true
        "vimeo.com" -> path.matches(Regex("/[0-9]{1,20}/?"))
        "www.twitch.tv" -> path.matches(Regex("/videos/[0-9]{1,20}/?"))
        "www.dailymotion.com" -> path.matches(Regex("/video/[A-Za-z0-9]{1,40}/?"))
        else -> false
    }
    if (!supported) return null
    val keys = when (host) {
        "www.youtube.com" -> setOf("v", "t")
        "vimeo.com" -> emptySet()
        "www.dailymotion.com" -> setOf("start")
        else -> setOf("t")
    }
    if (uri.queryParameterNames != keys || keys.any { uri.getQueryParameters(it).size != 1 }) return null
    val stamp = when (host) {
        "vimeo.com" -> uri.fragment?.removePrefix("t=")?.removeSuffix("s")
        "www.dailymotion.com" -> uri.getQueryParameter("start")
        else -> uri.getQueryParameter("t")?.removeSuffix("s")
    }
    if (host != "vimeo.com" && uri.fragment != null) return null
    if (host == "vimeo.com" && uri.fragment != "t=${stamp}s") return null
    val seconds = stamp?.takeIf { it.matches(Regex("[0-9]{1,6}")) }?.toIntOrNull() ?: return null
    return uri.takeIf { seconds in 0..604800 }
}

class VideoHandoff(core: Core) : Feature(core) {
    data class Offer(val id: String, val uri: Uri, val seconds: Int, val route: Link.TrustedRoute, val expires: Long)
    var incoming: Offer? = null
        private set

    fun onMessage(t: String, m: JSONObject, route: Link.TrustedRoute?): Boolean {
        if (t != "video.offer") return false
        if (!core.link.accepts(route) || route == null) return true
        val id = m.optString("id")
        val uri = supportedVideoLink(m.optString("url")) ?: return true
        val seconds = m.opt("seconds")
        if (!id.matches(Regex("[a-f0-9-]{36}")) || seconds !is Int || seconds !in 0..604800) return true
        val stamp = when (uri.host) {
            "vimeo.com" -> uri.fragment
            "www.dailymotion.com" -> uri.getQueryParameter("start")
            else -> uri.getQueryParameter("t")
        }
        val expected = when (uri.host) {
            "vimeo.com" -> "t=${seconds}s"
            "www.dailymotion.com" -> seconds.toString()
            else -> "${seconds}s"
        }
        if (stamp != expected) return true
        incoming = Offer(id, uri, seconds, route, SystemClock.elapsedRealtime() + 10 * 60_000)
        core.changed()
        return true
    }

    fun current(): Offer? = incoming?.takeIf { core.link.accepts(it.route) && SystemClock.elapsedRealtime() < it.expires }

    fun open() {
        val offer = current() ?: return dismiss()
        // The in-app button is the only path that opens another app.
        val intent = Intent(Intent.ACTION_VIEW, offer.uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (runCatching { core.ctx.startActivity(intent) }.isSuccess) {
            core.link.sendFor(offer.route, msg("video.ack", "id" to offer.id))
            dismiss()
        }
    }

    fun dismiss() { incoming = null; core.changed() }
    override fun onWelcome(host: Host) { incoming = null }
    override fun onClosed() { incoming = null }
}

@Composable
fun VideoHandoffCard(core: Core) {
    val offer = core.videoHandoff.current() ?: return
    val hours = offer.seconds / 3600
    val time = if (hours > 0) "%d:%02d:%02d".format(hours, offer.seconds / 60 % 60, offer.seconds % 60)
        else "%d:%02d".format(offer.seconds / 60, offer.seconds % 60)
    MacCard(tr("Continue watching")) {
        MacRow(offer.uri.host.orEmpty(), tr("Continue at {time}", "time" to time), first = true) {
            TextButton(onClick = { core.videoHandoff.dismiss() }) { Text(tr("Dismiss")) }
            Button(onClick = { core.videoHandoff.open() }) { Text(tr("Open video")) }
        }
    }
}
