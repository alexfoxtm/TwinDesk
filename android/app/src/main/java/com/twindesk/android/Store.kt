// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What the phone remembers: its identity, the computers it paired with (hosts) and its settings.
package com.twindesk.android

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.twindesk.android.embedded.EmbeddedNetwork
import com.twindesk.android.embedded.stableNode
import org.json.JSONArray
import org.json.JSONObject

// A paired computer this phone connects to (it hosts the session).
data class Host(
    val id: String,
    var name: String,
    val os: String,
    var address: String,
    var port: Int,
    val fp: String,
    val token: String,
    var lastSeen: Long,
    var tail: List<String> = emptyList(), // its Tailscale addresses (Tailnet.kt)
    var relay: RelayInfo? = null, // its own relay, if it has one (Relay.kt)
    val embeddedNode: String? = null,
) {
    internal fun sameEmbeddedPair(other: Host) = os == "mac" && other.os == "mac" &&
        id == other.id && fp == other.fp && token == other.token && embeddedNode == other.embeddedNode

    internal fun sameWidgetPair(other: Host) =
        os == "mac" && other.os == "mac" && id == other.id && fp == other.fp && token == other.token

    fun json(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("os", os).put("address", address)
        .put("port", port).put("fp", fp).put("token", token).put("lastSeen", lastSeen)
        .apply { if (tail.isNotEmpty()) put("tail", JSONArray(tail)) }
        .apply { relay?.let { put("relay", it.json()) } }
        .apply { embeddedNode?.let { put("embeddedNode", it) } }

    companion object {
        fun from(o: JSONObject) = Host(
            o.getString("id"), o.optString("name", "Mac"), o.optString("os", "mac"), o.optString("address"),
            o.optInt("port", Proto.PORT), o.getString("fp"), o.getString("token"), o.optLong("lastSeen"),
            Tailnet.clean(o.optJSONArray("tail")),
            RelayInfo.from(o.optJSONObject("relay")),
            o.optString("embeddedNode").takeIf(stableNode::matches),
        )
    }
}

class Store(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // Every feature is off until it's turned on: a switch that was never saved is off (a fresh
    // install has them all off; an update keeps what was saved).

    val deviceId: String = prefs.getString("deviceId", null) ?: Proto.randomHex(16).also {
        prefs.edit().putString("deviceId", it).apply()
    }

    // The phone's own name as people know it (Settings › About › Device name). Some phones (MIUI)
    // leave that as the model number ("M2010J19CG") and keep the real one ("POCO M3") as the
    // Bluetooth name and the marketing name.
    val deviceName: String
        get() = prefs.getString("deviceName", null)?.takeIf { it.isNotBlank() }
            ?: Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() && it != Build.MODEL }
            ?: runCatching { Settings.Secure.getString(ctx.contentResolver, "bluetooth_name") }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: marketName()
            ?: Build.MODEL

    private fun marketName(): String? = runCatching {
        val sp = Class.forName("android.os.SystemProperties")
        val get = sp.getMethod("get", String::class.java)
        listOf("ro.product.marketname", "ro.product.vendor.marketname", "ro.config.marketing_name")
            .map { get.invoke(null, it) as String }.firstOrNull { it.isNotBlank() }
    }.getOrNull()

    fun setDeviceName(name: String) = prefs.edit().putString("deviceName", name.trim().take(64)).apply()

    // key: "hosts" (computers), or "peerHosts" (phones this one connects to, Peer.kt).
    fun hosts(key: String = "hosts"): List<Host> = try {
        val a = JSONArray(prefs.getString(key, "[]"))
        (0 until a.length()).map { Host.from(a.getJSONObject(it)) }
    } catch (e: Exception) {
        emptyList()
    }

    @Synchronized
    fun saveHosts(list: List<Host>, key: String = "hosts") {
        val encoded = jsonArray(list.map { it.json() }).toString()
        synchronized(widgetPairLock) {
            val edit = prefs.edit().putString(key, encoded)
            if (key == "hosts") {
                for (h in hosts(key)) {
                    if (list.none { it.id == h.id && it.fp == h.fp }) LockVault(ctx).forget(h.id)
                    if (h.os == "mac" && list.none {
                            h.sameWidgetPair(it) && (h.embeddedNode == null || h.embeddedNode == it.embeddedNode)
                        }) edit.remove(widgetPairKey(h.id))
                }
            }
            edit.apply()
        }
    }

    // Widgets hold a random reference that disappears in the same preferences edit as the old
    // saved pair. Renames and route/address updates keep it.
    internal fun bindWidgetPair(host: Host): String? = synchronized(widgetPairLock) {
        if (host.fp.isBlank() || host.token.isBlank() || hosts().none { it.sameWidgetPair(host) }) return null
        val key = widgetPairKey(host.id)
        prefs.getString(key, null) ?: Proto.randomHex(16).also { prefs.edit().putString(key, it).apply() }
    }

    internal fun widgetPair(id: String, revision: String): Host? = synchronized(widgetPairLock) {
        if (prefs.getString(widgetPairKey(id), null) != revision) return null
        hosts().firstOrNull { it.id == id && it.os == "mac" && it.fp.isNotBlank() && it.token.isNotBlank() }
    }

    internal fun hasWidgetPair(id: String, revision: String) =
        prefs.getString(widgetPairKey(id), null) == revision

    companion object {
        private const val PREFS = "twindesk"
        private val widgetPairLock = Any()
        private fun widgetPairKey(id: String) = "widget.pair.$id"

        internal fun cableOnly(ctx: Context) =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(Core.CABLE_ONLY, false)
    }

    @Synchronized
    fun putHost(h: Host, key: String = "hosts", verifiedNode: String? = null) {
        val old = hosts(key)
        if (key == "hosts" && old.any { it.id == h.id && it.fp != h.fp }) prefs.edit().remove("taskAlerts.${h.id}").apply()
        val binding = if (key == "hosts" && h.os == "mac") verifiedNode ?:
            old.find { it.id == h.id && it.fp == h.fp && it.os == h.os }?.embeddedNode else null
        saveHosts(listOf(h.copy(embeddedNode = binding)) + old.filter { it.id != h.id }, key)
    }

    @Synchronized
    fun forgetHost(id: String, key: String = "hosts") {
        if (key == "hosts") prefs.edit().remove("taskAlerts.$id").apply()
        saveHosts(hosts(key).filter { it.id != id }, key)
    }

    // Settings: one boolean per switch.
    fun flag(key: String, default: Boolean): Boolean = prefs.getBoolean(key, default)
    internal fun setEmbeddedEnabled(on: Boolean) = prefs.edit().putBoolean(EmbeddedNetwork.ENABLED, on).commit()

    fun setFlag(key: String, on: Boolean) = prefs.edit().putBoolean(key, on).apply()

    // Cable-only must be on disk before wireless teardown. apply() can die with the process first.
    fun commitFlag(key: String, on: Boolean): Boolean = prefs.edit().putBoolean(key, on).commit()

    fun forgetHostClearingCredentials(id: String, key: String = "hosts") {
        if (key == "hosts") LockVault(ctx).forget(id)
        forgetHost(id, key)
    }

    fun prefsString(key: String, default: String): String = prefs.getString(key, default) ?: default
    fun setPrefsString(key: String, v: String) = prefs.edit().putString(key, v).apply()

    fun prefsSet(key: String): Set<String> = prefs.getStringSet(key, emptySet()) ?: emptySet()
    fun setPrefsSet(key: String, v: Set<String>) = prefs.edit().putStringSet(key, v).apply()

    // Two-way switches remembered per pair (pair.sync), as JSON by host id.
    fun pairSync(hostId: String): JSONObject? = prefs.getString("sync.$hostId", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun setPairSync(hostId: String, v: JSONObject) = prefs.edit().putString("sync.$hostId", v.toString()).apply()
}
