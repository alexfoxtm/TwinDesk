package com.twindesk.android.embedded

import android.net.Uri
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class EmbeddedRouteTest {
    private val qr = "twindesk://pair?ts=nABC&id=mac123&fp=${"b".repeat(64)}&n=Office%20Mac&k=${"c".repeat(32)}&p=47800"

    @Test fun validOfferAndBridgePutProofBeforeTls() {
        val offer = EmbeddedOffer.parse(Uri.parse(qr))
        assertNotNull(offer)
        assertEquals("nABC", offer!!.node)
        assertEquals("mac123", offer.id)
        assertEquals("Office Mac", offer.name)

        val loopback = InetAddress.getByName("127.0.0.1")
        ServerSocket(0, 1, loopback).use { listener ->
            listener.soTimeout = 2_000
            val expected = ByteArray(32) { it.toByte() }
            val proof = expected.copyOf()
            val bridge = EmbeddedBridge(listener.localPort, "fixture", proof)
            val destination = InetSocketAddress(loopback, listener.localPort)
            val client = OkHttpClient.Builder()
                .socketFactory(bridge.sockets)
                .proxy(Proxy.NO_PROXY)
                .retryOnConnectionFailure(false)
                .callTimeout(4, TimeUnit.SECONDS)
                .build()
            val request = Request.Builder().url("https://127.0.0.1:${listener.localPort}/").build()
            val call = client.newWebSocket(request, object : okhttp3.WebSocketListener() {})
            try {
                listener.accept().use { remote ->
                    remote.soTimeout = 2_000
                    val stream = remote.getInputStream()
                    assertArrayEquals(expected, stream.readNBytes(32))
                    assertArrayEquals(byteArrayOf(0x16, 0x03), stream.readNBytes(2))
                }
            } finally {
                call.cancel()
            }
            assertArrayEquals(ByteArray(32), proof)
            bridge.sockets.createSocket().use { second ->
                assertThrows(IOException::class.java) { second.connect(destination, 2_000) }
            }
        }
    }

    @Test fun embeddedOfferRejectsAddressAndAmbiguousIdentity() {
        assertNull(EmbeddedOffer.parse(Uri.parse("$qr&a=192.0.2.1")))
        assertNull(EmbeddedOffer.parse(Uri.parse("$qr&%74s=nOther")))
        assertNull(EmbeddedOffer.parse(Uri.parse(qr.replace("ts=nABC", "ts="))))
    }
}
