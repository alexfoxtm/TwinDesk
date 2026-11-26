// TwinDesk — GPL-3.0, see LICENSE.
package com.twindesk.android.embedded

import android.net.Uri
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import javax.net.SocketFactory

internal val stableNode = Regex("[A-Za-z0-9_-]{1,128}")
private val fingerprint = Regex("[0-9a-f]{64}")

// Keep this offer transient. In particular, the nonce must not enter the paired-host store.
internal class EmbeddedOffer(val node: String, val id: String, val pin: String, val name: String, val nonce: String) {
    companion object {
        const val PORT = 47800
        private val keys = setOf("ts", "id", "fp", "n", "k", "p")

        fun parse(uri: Uri): EmbeddedOffer? {
            if (uri.scheme != "twindesk" || uri.encodedAuthority != "pair" ||
                !uri.path.isNullOrEmpty() || uri.fragment != null
            ) return null
            val names = uri.encodedQuery?.split('&')?.map { it.substringBefore('=') } ?: return null
            if (names.size != keys.size || names.toSet() != keys) return null
            fun value(key: String) = uri.getQueryParameter(key)
            val node = value("ts")?.takeIf(stableNode::matches) ?: return null
            val id = value("id")?.takeIf { it.matches(Regex("[A-Za-z0-9._-]{1,64}")) } ?: return null
            val pin = value("fp")?.takeIf(fingerprint::matches) ?: return null
            val nonce = value("k")?.takeIf { it.matches(Regex("[0-9a-f]{32,64}")) && it.length % 2 == 0 } ?: return null
            val name = value("n")?.take(64) ?: return null
            if (value("p") != PORT.toString()) return null
            return EmbeddedOffer(node, id, pin, name, nonce)
        }
    }
}

internal class EmbeddedBridge(val port: Int, val handle: String, private val proof: ByteArray) {
    val sockets: SocketFactory = object : SocketFactory() {
        override fun createSocket(): Socket = object : Socket() {
            override fun connect(endpoint: SocketAddress?, timeout: Int) {
                if (endpoint != InetSocketAddress(loopback, this@EmbeddedBridge.port)) throw IOException("Invalid embedded endpoint")
                try {
                    synchronized(proof) {
                        if (used) throw IOException("Embedded bridge already used")
                        used = true
                        try {
                            tcpNoDelay = true
                            super.connect(endpoint, timeout)
                            getOutputStream().write(proof)
                            getOutputStream().flush()
                        } finally {
                            proof.fill(0)
                        }
                    }
                } catch (e: IOException) {
                    close()
                    throw e
                }
            }
        }

        override fun createSocket(host: String?, port: Int): Socket = unsupported()
        override fun createSocket(host: InetAddress?, port: Int): Socket = unsupported()
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = unsupported()
        override fun createSocket(host: InetAddress?, port: Int, localHost: InetAddress?, localPort: Int): Socket = unsupported()

        private fun unsupported(): Nothing = throw IOException("Embedded bridge requires an unconnected socket")
    }

    private var used = false

    fun retire() = synchronized(proof) {
        used = true
        proof.fill(0)
    }

    companion object {
        private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    }
}
