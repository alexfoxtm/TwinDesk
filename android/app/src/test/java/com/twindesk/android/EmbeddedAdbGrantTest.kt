// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class EmbeddedAdbGrantTest {
    private val self = InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 1)) as Inet4Address
    private val other = InetAddress.getByAddress(byteArrayOf(192.toByte(), 0, 2, 2))
    private val owner = Link.TrustedRoute(Any(), "mac", "fingerprint")
    private val port = 37123
    private val key = "a".repeat(64)
    private fun request(port: Any = this.port, key: Any = this.key) = JSONObject().put("port", port).put("key", key)

    @Test
    fun exactWifiEndpointAndRoutePermitARequestForTheTlsListener() {
        assertEquals(InetSocketAddress(self, port), embeddedAdbEndpoint(setOf(self), listOf(other, self), port, true))
        val sameRoute = Link.TrustedRoute(owner.marker, owner.id, owner.fp)
        assertEquals(key, embeddedAdbKey(request(), port, owner, sameRoute, true))
        assertTrue(probe(replyCommand = 0x534c5453)) // STLS
    }

    @Test
    fun staleOrUntrustedInputsAndNonTlsListenersAreRejected() {
        assertNull(embeddedAdbEndpoint(setOf(self), listOf(other), port, true))
        assertNull(embeddedAdbEndpoint(setOf(self), listOf(self), port, false))
        assertNull(embeddedAdbEndpoint(setOf(self), listOf(self), 5555, true))
        assertNull(embeddedAdbEndpoint(setOf(self), listOf(self), 65536, true))
        assertNull(embeddedAdbKey(request(), port, owner, Link.TrustedRoute(Any(), owner.id, owner.fp), true))
        assertNull(embeddedAdbKey(request(), port, owner, Link.TrustedRoute(owner.marker, owner.id, "changed"), true))
        assertNull(embeddedAdbKey(request(), port, owner, owner, false))
        assertNull(embeddedAdbKey(request(port + 1), port, owner, owner, true))
        assertNull(embeddedAdbKey(request(port.toString()), port, owner, owner, true))
        assertNull(embeddedAdbKey(request(key = "a".repeat(63)), port, owner, owner, true))
        assertFalse(probe(replyCommand = 0x48545541)) // AUTH
    }

    private fun probe(replyCommand: Int): Boolean {
        val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        ServerSocket(0, 1, loopback).use { server ->
            server.soTimeout = 3000
            val checkExchange = FutureTask {
                server.accept().use { client ->
                    client.soTimeout = 3000
                    val input = DataInputStream(client.getInputStream())
                    val header = ByteArray(24).also(input::readFully)
                    val connect = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
                    assertEquals(0x4e584e43, connect.getInt(0))
                    assertEquals(7, connect.getInt(12))
                    val banner = ByteArray(7).also(input::readFully)
                    assertEquals("host::\u0000", banner.decodeToString())
                    val reply = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
                        .putInt(replyCommand).putInt(0x01000000).putInt(0).putInt(0).putInt(0).putInt(replyCommand.inv())
                    client.getOutputStream().write(reply.array())
                    assertEquals(-1, input.read()) // The check closes before sending TLS or credentials.
                }
            }
            thread(isDaemon = true) { checkExchange.run() }
            val accepted = offersAdbTls(InetSocketAddress(loopback, server.localPort))
            checkExchange.get(4, TimeUnit.SECONDS)
            return accepted
        }
    }
}
