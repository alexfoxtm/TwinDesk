// Adapted from AppShare (Copyright 2026 Rahim Nathwani). SPDX-License-Identifier: Apache-2.0.
package com.twindesk.android.embedded

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.NetworkInterface
import java.net.SocketException

/** Observes Android's app-default path and allowed non-VPN path changes. */
internal class NativeInterfaces(context: Context) {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private var observer: Watcher? = null

    @Synchronized
    fun start(): Boolean {
        if (observer != null) return true
        val manager = connectivity ?: return false
        try {
            System.loadLibrary("twindesk_network")
            val watcher = Watcher()
            observer = watcher
            manager.registerDefaultNetworkCallback(watcher.default)
            watcher.registered.add(watcher.default)
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build()
            manager.registerNetworkCallback(request, watcher.underlay)
            watcher.registered.add(watcher.underlay)
            if (watcher.paths.start()) return true
        } catch (_: RuntimeException) {
            // ConnectivityManager can reject callback registration.
        } catch (_: LinkageError) {
            // A missing or incompatible JNI library is a startup failure.
        }
        unregister()
        return false
    }

    @Synchronized
    fun stop() {
        observer?.paths?.finish()
        unregister()
    }

    private fun unregister() {
        val watcher = observer ?: return
        observer = null
        watcher.registered.forEach { runCatching { connectivity?.unregisterNetworkCallback(it) } }
    }

    private inner class Watcher {
        val paths = NetworkPaths<Network, LinkProperties>(::families, ::publishPath)
        val registered = mutableListOf<ConnectivityManager.NetworkCallback>()

        val default = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = active { defaultAvailable(network) }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = active {
                val vpn = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                    !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                var transports = 0
                for (transport in observedTransports) {
                    if (capabilities.hasTransport(transport)) transports = transports or (1 shl transport)
                }
                defaultCapabilities(network, vpn, transports)
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) = active {
                defaultLink(network, linkProperties)
            }

            override fun onBlockedStatusChanged(network: Network, blocked: Boolean) = active {
                defaultBlocked(network, blocked)
            }

            override fun onLost(network: Network) = active { defaultLost(network) }
        }

        // Passive observation only. Link changes serve as a hint while Android
        // keeps a VPN as default across a Wi-Fi or cellular handoff.
        val underlay = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = active { underlayAvailable(network) }

            override fun onBlockedStatusChanged(network: Network, blocked: Boolean) = active {
                underlayBlocked(network, blocked)
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) = active {
                underlayLinkChanged(network)
            }

            override fun onLost(network: Network) = active { underlayLost(network) }
        }

        private fun active(action: NetworkPaths<Network, LinkProperties>.() -> Unit) {
            synchronized(this@NativeInterfaces) {
                if (observer === this) paths.action()
            }
        }
    }

    private fun families(properties: LinkProperties): NetworkFamilies {
        val addresses = properties.linkAddresses.map { it.address }.filter {
            !it.isAnyLocalAddress && !it.isLoopbackAddress && !it.isLinkLocalAddress && !it.isMulticastAddress
        }
        return NetworkFamilies(addresses.any { it is Inet4Address }, addresses.any { it is Inet6Address })
    }

    private fun publishPath(properties: LinkProperties?, vpn: VpnPath?): Boolean {
        if (vpn != null) {
            return publish(JSONObject().put("vpn", JSONObject()
                .put("ipv4", vpn.families.ipv4)
                .put("ipv6", vpn.families.ipv6)
                .put("revision", vpn.revision.toLong()))
                .toString())
        }
        val name = properties?.interfaceName ?: return publish("null")
        val index = try {
            NetworkInterface.getByName(name)?.index?.coerceAtLeast(0) ?: 0
        } catch (_: SocketException) {
            0
        }
        val addresses = properties.linkAddresses.mapNotNull { link ->
            link.address.hostAddress?.let { "${it.substringBefore('%')}/${link.prefixLength}" }
        }.distinct().sorted()
        return publish(JSONObject()
            .put("name", name)
            .put("index", index)
            .put("mtu", properties.mtu)
            .put("addresses", JSONArray(addresses))
            .toString())
    }

    private companion object {
        val observedTransports = intArrayOf(
            NetworkCapabilities.TRANSPORT_WIFI,
            NetworkCapabilities.TRANSPORT_CELLULAR,
            NetworkCapabilities.TRANSPORT_ETHERNET,
            NetworkCapabilities.TRANSPORT_BLUETOOTH,
            NetworkCapabilities.TRANSPORT_USB,
        )

        @JvmStatic
        private external fun publish(snapshot: String): Boolean
    }
}
