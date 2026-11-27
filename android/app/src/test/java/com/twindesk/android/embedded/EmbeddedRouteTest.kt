package com.twindesk.android.embedded

import android.net.Uri
import com.twindesk.android.Host
import com.twindesk.android.Link
import com.twindesk.android.Proto
import com.twindesk.android.Store
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.lang.reflect.Proxy as ReflectProxy
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.util.concurrent.ScheduledExecutorService
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

    @Test fun savedPairUsesItsTokenAndBindsTheExactWelcome() {
        savedPairWelcome("mac123", accepted = true)
    }

    @Test fun aDifferentWelcomeIdCannotBindOrReplaceTheSavedPair() {
        savedPairWelcome("otherMac", accepted = false)
    }

    // Start at the pinned WebSocket's onOpen. The bridge/TLS ordering is exercised above.
    private fun savedPairWelcome(macId: String, accepted: Boolean) {
        val ctx = RuntimeEnvironment.getApplication()
        val store = Store(ctx)
        val saved = Host("mac123", "Office Mac", "mac", "192.0.2.5", 47800, "b".repeat(64), "c".repeat(64), 0)
        store.putHost(saved)
        val network = EmbeddedNetwork(ctx, store) {}
        fun field(owner: Any, name: String) = owner.javaClass.getDeclaredField(name).apply { isAccessible = true }
        field(network, "desired").set(network, true)
        field(network, "status").set(network, EmbeddedNetwork.Status("running", setOf("nABC")))
        var connected: Host? = null
        val link = Link(store, object : Link.Events {
            override fun onChange() {}
            override fun onWelcome(host: Host) { connected = host }
            override fun onMessage(m: JSONObject, route: Link.TrustedRoute?, source: WebSocket) {}
            override fun onClosed(host: Host, code: String?) {}
        })
        val dial = Link::class.java.declaredClasses.single { it.simpleName == "EmbeddedDial" }
            .declaredConstructors.single().apply { isAccessible = true }
            .newInstance(network, listOf("nABC"), null, { true })
        field(dial, "node").set(dial, "nABC")
        val sent = mutableListOf<JSONObject>()
        var cancelled = false
        val socket = ReflectProxy.newProxyInstance(WebSocket::class.java.classLoader, arrayOf(WebSocket::class.java)) { self, method, args ->
            when (method.name) {
                "hashCode" -> System.identityHashCode(self)
                "equals" -> self === args[0]
                "send" -> { sent += JSONObject(args[0] as String); true }
                "cancel" -> { cancelled = true; null }
                else -> error(method.name)
            }
        } as WebSocket
        field(link, "embeddedDial").set(link, dial)
        field(link, "host").set(link, saved)
        field(link, "ws").set(link, socket)
        field(link, "mode").set(link, "session")
        field(link, "state").set(link, "connecting")
        field(link, "reclaimHello").set(link, true)
        val executor = field(link, "exec").get(link) as ScheduledExecutorService
        try {
            Link::class.java.getDeclaredMethod("onOpen").apply { isAccessible = true }.invoke(link)
            assertEquals(Proto.T.HELLO, sent.single().getString("t"))
            assertEquals(saved.token, sent.single().getString("token"))
            assertEquals(1, sent.single().getInt("rc"))
            assertEquals("0", sent.single().getString("resume"))

            val latest = saved.copy(address = "192.0.2.6", port = 48700)
            store.putHost(latest)
            val welcome = JSONObject().put("t", Proto.T.WELCOME).put("macId", macId).put("rc", 1)
            Link::class.java.getDeclaredMethod("onWelcome", JSONObject::class.java)
                .apply { isAccessible = true }.invoke(link, welcome)
            val paired = store.hosts().single()
            if (accepted) {
                assertEquals("nABC", paired.embeddedNode)
                assertEquals("nABC", connected?.embeddedNode)
                assertTrue(link.connected)
                assertFalse(cancelled)
            } else {
                assertNull(paired.embeddedNode)
                assertNull(connected)
                assertFalse(link.connected)
                assertTrue(cancelled)
            }
            assertEquals(latest.address, paired.address)
            assertEquals(latest.port, paired.port)
            assertEquals(saved.token, paired.token)
        } finally {
            executor.shutdownNow()
        }
    }
}
