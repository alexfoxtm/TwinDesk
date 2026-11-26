// Adapted from AppShare (Copyright 2026 Rahim Nathwani). SPDX-License-Identifier: Apache-2.0.
package com.twindesk.android.embedded

internal data class NetworkFamilies(val ipv4: Boolean, val ipv6: Boolean)
internal data class VpnPath(val families: NetworkFamilies, val revision: UInt)

/** Tracks ordered ConnectivityManager events for one watcher registration. */
internal class NetworkPaths<N : Any, L : Any>(
    private val families: (L) -> NetworkFamilies,
    private val publish: (link: L?, vpn: VpnPath?) -> Boolean,
) {
    private data class Snapshot<L>(val link: L?, val vpn: VpnPath?)

    private var current: N? = null
    private var link: L? = null
    private var vpn: Boolean? = null
    private var transports = 0
    private var blocked: Boolean? = null
    private var revision = 0u
    private var finished = false
    private var last: Snapshot<L>? = null
    private val underlays = mutableMapOf<N, Boolean?>()

    fun start(): Boolean = send()

    fun defaultAvailable(network: N) {
        if (finished || current == network) return
        current = network
        link = null
        vpn = null
        blocked = null
        transports = 0
        revision++
        send()
    }

    fun defaultCapabilities(network: N, isVpn: Boolean, transports: Int) {
        if (!current(network) || (vpn == isVpn && this.transports == transports)) return
        vpn = isVpn
        this.transports = transports
        revision++
        send()
    }

    fun defaultLink(network: N, link: L) {
        if (!current(network) || this.link == link) return
        this.link = link
        revision++
        send()
    }

    fun defaultBlocked(network: N, blocked: Boolean) {
        if (!current(network) || this.blocked == blocked) return
        this.blocked = blocked
        revision++
        send()
    }

    fun defaultLost(network: N) {
        if (!current(network)) return
        current = null
        link = null
        send()
    }

    fun underlayAvailable(network: N) {
        if (!finished && network !in underlays) underlays[network] = null
    }

    fun underlayLinkChanged(network: N) {
        if (!finished && underlays[network] == false) rebindVpn()
    }

    fun underlayBlocked(network: N, blocked: Boolean) {
        if (finished || network !in underlays) return
        val previous = underlays.put(network, blocked)
        if (previous != blocked && (previous == false || !blocked)) rebindVpn()
    }

    fun underlayLost(network: N) {
        if (!finished && underlays.remove(network) == false) rebindVpn()
    }

    fun finish() {
        finished = true
        current = null
        link = null
        underlays.clear()
        send()
    }

    private fun current(network: N): Boolean = !finished && network == current

    private fun rebindVpn() {
        if (vpn != true || blocked != false || current == null) return
        revision++
        send()
    }

    private fun send(): Boolean {
        val properties = link
        val snapshot: Snapshot<L> = when {
            finished || current == null || blocked != false || vpn == null || properties == null -> Snapshot(null, null)
            vpn == true -> Snapshot(null, VpnPath(families(properties), revision))
            else -> Snapshot(properties, null)
        }
        if (snapshot == last) return true
        return publish(snapshot.link, snapshot.vpn).also { accepted ->
            if (accepted) last = snapshot
        }
    }
}
