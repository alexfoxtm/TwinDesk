// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

// One budget per viewer/socket. A late callback cannot restart a retired operation.
internal class ViewerRetry(private val now: () -> Long) {
    private data class Admission(val viewer: Any, val peer: Host, val socket: Any, val retained: Boolean = false)
    private var admission: Admission? = null
    private var generation = 0

    fun cancel() {
        admission = null
        generation++
    }

    private fun samePair(a: Host, b: Host) =
        a.os == "mac" && b.os == "mac" && a.id == b.id && a.fp == b.fp && a.token == b.token

    fun opened(viewer: Any, host: Host, route: Link.TrustedRoute) {
        cancel()
        if (host.os == "mac" && route.id == host.id && route.fp == host.fp) {
            admission = Admission(viewer, host, route.marker)
        }
    }

    fun closed(host: Host?, retain: Boolean) {
        generation++
        admission = admission?.takeIf { host != null && retain && samePair(it.peer, host) }?.copy(retained = true)
    }

    fun reconnect(viewer: Any, host: Host, route: Link.TrustedRoute, welcomedAt: Long): Boolean {
        val prior = admission ?: return false
        if (prior.viewer !== viewer || !samePair(prior.peer, host)) { cancel(); return false }
        if (!prior.retained || prior.socket === route.marker || route.id != host.id || route.fp != host.fp ||
            now() >= welcomedAt + 12_000L) return false
        admission = Admission(viewer, host, route.marker)
        return true
    }

    fun stopRetries(socket: Any?) {
        if (socket != null && admission?.socket === socket) generation++
    }

    fun forget(id: String) {
        if (admission?.peer?.id == id) cancel()
    }

    fun schedule(post: (Long, () -> Unit) -> Unit, eligible: () -> Boolean, welcomedAt: Long = now(), reoffer: () -> Unit) {
        val current = ++generation
        val deadline = welcomedAt + 12_000L
        for (delay in listOf(4_500L, 9_000L)) {
            val remaining = welcomedAt + delay - now()
            if (remaining <= 0) continue
            post(remaining) {
                if (current == generation && now() < deadline && eligible()) reoffer()
            }
        }
    }
}
