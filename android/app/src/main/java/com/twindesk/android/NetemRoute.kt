// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

internal data class NetemRoute(val peer: String, val address: String) {
    val turnUrl get() = "turn:$address:$TURN_PORT?transport=tcp"

    companion object {
        const val CONTROL_PORT = 43198
        private const val TURN_PORT = 43199
        val configured = if (BuildConfig.DEBUG) parse(BuildConfig.NETEM_PEER, BuildConfig.NETEM_ADDRESS) else null

        fun parse(peer: String, address: String): NetemRoute? {
            if (!peer.matches(Regex("[A-Za-z0-9._-]{1,64}"))) return null
            val octets = address.split('.')
            if (octets.size != 4 || octets.any { !it.matches(Regex("0|[1-9][0-9]{0,2}")) }) return null
            val values = octets.map { it.toInt() }
            if (values.any { it > 255 } || values[3] !in 1..254) return null
            val (a, b) = values
            if (a != 10 && !(a == 172 && b in 16..31) && !(a == 192 && b == 168) &&
                !(a == 100 && b in 64..127)) return null
            return NetemRoute(peer, address)
        }
    }
}
