// TwinDesk — GPL-3.0, see LICENSE.
package com.twindesk.android.embedded

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class EmbeddedTurnTest {
    @Test fun rewritesOnlySingleRelayTcpOffers() {
        for (type in listOf("rtc.offer", "audio.offer")) {
            val server = JSONObject().put("urls", "turn:127.0.0.1:47802?transport=tcp")
                .put("username", "user").put("credential", "pass")
            val servers = JSONArray().put(server)
            val ice = JSONObject().put("iceTransportPolicy", "relay").put("iceServers", servers)
            val offer = JSONObject().put("t", type).put("session", 1).put("sdp", "v=0").put("ice", ice)

            ice.put("iceTransportPolicy", "all")
            assertFalse(rewriteEmbeddedOffer(offer, 39000))
            ice.put("iceTransportPolicy", "relay")
            servers.put(JSONObject().put("urls", "stun:example.invalid"))
            assertFalse(rewriteEmbeddedOffer(offer, 39000))
            servers.remove(1)
            server.put("urls", "turn:127.0.0.2:47802?transport=tcp")
            assertFalse(rewriteEmbeddedOffer(offer, 39000))
            server.put("urls", "turn:127.0.0.1:65536?transport=tcp")
            assertFalse(rewriteEmbeddedOffer(offer, 39000))
            server.put("urls", "turn:127.0.0.1:47802?transport=tcp")
            assertTrue(rewriteEmbeddedOffer(offer, 39000))

            val rewritten = offer.getJSONObject("ice").getJSONArray("iceServers").getJSONObject(0)
            assertEquals("turn:127.0.0.1:39000?transport=tcp", rewritten.getString("urls"))
            assertEquals("user", rewritten.getString("username"))
            assertEquals("pass", rewritten.getString("credential"))
        }
    }

    @Test fun transfersBoundedBinaryFramesAndReleasesChildOnClose() {
        val ready = CountDownLatch(1)
        val released = CountDownLatch(1)
        val request = Request.Builder().url("wss://127.0.0.1/embedded/turn").build()
        EmbeddedTurn({ true }) { current, listener ->
            val remote = object : WebSocket {
                override fun request() = request
                override fun queueSize() = 0L
                override fun send(text: String) = error("Unexpected text frame")
                override fun send(bytes: ByteString): Boolean {
                    assertTrue(current())
                    assertTrue(bytes.size in 1..32768)
                    listener.onMessage(this, bytes)
                    return true
                }

                override fun close(code: Int, reason: String?) = true
                override fun cancel() {}
            }
            listener.onOpen(remote, Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                .code(101).message("Switching Protocols").build())
            EmbeddedTurn.Tunnel(remote) { released.countDown() }
        }.use { proxy ->
            proxy.start { ready.countDown() }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            Socket("127.0.0.1", proxy.port).use { client ->
                client.soTimeout = 5000
                val payload = ByteArray(40_000) { (it % 251).toByte() }
                client.getOutputStream().write(payload)
                val reply = ByteArray(payload.size)
                java.io.DataInputStream(client.getInputStream()).readFully(reply)
                assertArrayEquals(payload, reply)
                proxy.close()
                assertEquals(0, proxy.port)
                assertEquals(-1, client.getInputStream().read())
                assertTrue(released.await(5, TimeUnit.SECONDS))
            }
        }
    }
}
