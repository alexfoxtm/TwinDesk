// TwinDesk — GPL-3.0, see LICENSE.
package com.twindesk.android.embedded

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class AdbAdmissionTest {
    private val hostConnect = packet(CNXN, 0x01000001, 1024 * 1024, "host::features=shell_v2".toByteArray())
    private val deviceConnect = packet(CNXN, 0x01000001, 1024 * 1024, "device::features=shell_v2".toByteArray(), true)
    private val token = packet(AUTH, 1, 0, ByteArray(20) { (it + 1).toByte() }, true)
    private val signature = packet(AUTH, 2, 0, ByteArray(256) { it.toByte() })
    private val publicKey = packet(AUTH, 3, 0, "unapproved-key\u0000".toByteArray())

    @Test fun relaysFragmentedNativeAuthorizationAndStreamPackets() = withStream { host, device ->
        exchangeSignatures(host, device, attempts = 2)
        val open = packet(OPEN, 1, 0, "localabstract:fixture\u0000".toByteArray())
        device.getOutputStream().write(deviceConnect + open)
        host.expect(deviceConnect + open)

        val ready = packet(OKAY, 2, 1, ByteArray(0))
        val payload = ByteArray(65_520) { (it % 127).toByte() }.also { publicKey.copyInto(it, 32_740) }
        val write = packet(WRTE, 2, 1, payload)
        host.receive(ready + write.copyOfRange(0, 11))
        device.expect(ready)
        val split = 11 + 32768
        host.receive(write.copyOfRange(11, split))
        device.expect(write.copyOfRange(0, split))
        host.receive(write.copyOfRange(split, write.size))
        device.expect(write.copyOfRange(split, write.size))

        val downstream = packet(OKAY, 1, 2, ByteArray(0)) +
            packet(WRTE, 1, 2, ByteArray(3000) { (it % 251).toByte() }, true) +
            packet(CLSE, 1, 2, ByteArray(0))
        device.getOutputStream().write(downstream)
        host.expect(downstream)
    }

    @Test fun rejectsUnexpectedPrefacesBeforeForwardingThem() {
        withStream { host, device ->
            host.receive(hostConnect)
            device.expect(hostConnect)
            device.getOutputStream().write(deviceConnect)
            assertTrue(host.cancelled.await(5, TimeUnit.SECONDS))
            assertTrue(host.sent.isEmpty())
            assertEquals(-1, device.getInputStream().read())
        }
        withStream { host, device ->
            host.receive(hostConnect)
            device.expect(hostConnect)
            device.getOutputStream().write(token)
            host.expect(token)
            host.receive(publicKey)
            assertEquals(-1, device.getInputStream().read())
            assertTrue(host.cancelled.await(5, TimeUnit.SECONDS))
        }
        for (preface in listOf(
            hostConnect.copyOf().apply { this[20] = 0 },
            hostConnect.copyOf().apply { this[16] = 0 },
            hostConnect.copyOf().apply { this[13] = 32 },
            hostConnect + signature,
            signature,
        )) {
            withStream { host, device ->
                host.receive(preface)
                assertEquals(-1, device.getInputStream().read())
                assertTrue(host.cancelled.await(5, TimeUnit.SECONDS))
            }
        }
        val tls = packet(STLS, 0x01000000, 0, ByteArray(0))
        val oversized = packet(WRTE, 1, 2, ByteArray(0)).apply { this[14] = 17 }
        for (header in listOf(publicKey, signature, hostConnect, tls, oversized)) {
            withStream { host, device ->
                exchangeSignatures(host, device)
                device.getOutputStream().write(deviceConnect)
                host.expect(deviceConnect)
                host.receive(header.copyOfRange(0, 7))
                host.receive(header.copyOfRange(7, header.size))
                assertEquals(-1, device.getInputStream().read())
                assertTrue(host.cancelled.await(5, TimeUnit.SECONDS))
            }
        }
        withStream { host, device ->
            exchangeSignatures(host, device)
            device.getOutputStream().write(deviceConnect + token)
            host.expect(deviceConnect)
            assertTrue(host.cancelled.await(5, TimeUnit.SECONDS))
            assertTrue(host.sent.isEmpty())
        }
    }

    private fun exchangeSignatures(host: Host, device: Socket, attempts: Int = 1) {
        host.receive(hostConnect.copyOfRange(0, 19))
        host.receive(hostConnect.copyOfRange(19, 27))
        host.receive(hostConnect.copyOfRange(27, hostConnect.size))
        device.expect(hostConnect)
        repeat(attempts) { attempt ->
            val challenge = if (attempt == 0) token else packet(AUTH, 1, 0, ByteArray(20) { 42 }, true)
            device.getOutputStream().write(challenge, 0, 23)
            device.getOutputStream().write(challenge, 23, challenge.size - 23)
            host.expect(challenge)
            host.receive(signature.copyOfRange(0, 45))
            host.receive(signature.copyOfRange(45, signature.size))
            device.expect(signature)
        }
    }

    private fun withStream(use: (Host, Socket) -> Unit) {
        val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        val ready = LinkedBlockingQueue<Host>()
        val released = CountDownLatch(1)
        val ended = CountDownLatch(1)
        ServerSocket(0, 1, loopback).use { server ->
            server.soTimeout = 5000
            EmbeddedTurn({ true }) { _, listener ->
                val host = Host(listener)
                listener.onOpen(host, Response.Builder().request(host.request()).protocol(Protocol.HTTP_1_1)
                    .code(101).message("Switching Protocols").build())
                ready.add(host)
                EmbeddedTurn.Tunnel(host) { released.countDown() }
            }.use { turn ->
                turn.connectLocal(InetSocketAddress(loopback, server.localPort), requireAdbAuthorization = true) {
                    ended.countDown()
                }
                server.accept().use { device ->
                    device.soTimeout = 5000
                    use(checkNotNull(ready.poll(5, TimeUnit.SECONDS)), device)
                }
            }
        }
        assertTrue(released.await(5, TimeUnit.SECONDS))
        assertTrue(ended.await(5, TimeUnit.SECONDS))
    }

    private fun Socket.expect(expected: ByteArray) {
        val actual = ByteArray(expected.size)
        DataInputStream(getInputStream()).readFully(actual)
        assertArrayEquals(expected, actual)
    }

    private class Host(private val listener: WebSocketListener) : WebSocket {
        val sent = LinkedBlockingQueue<ByteString>()
        val cancelled = CountDownLatch(1)
        override fun request() = Request.Builder().url("wss://127.0.0.1/embedded/adb").build()
        override fun queueSize() = 0L
        override fun send(text: String) = error("Unexpected text frame")
        override fun send(bytes: ByteString) = sent.add(bytes)
        override fun close(code: Int, reason: String?) = true
        override fun cancel() = cancelled.countDown()

        fun receive(bytes: ByteArray) = listener.onMessage(this, bytes.toByteString())

        fun expect(expected: ByteArray) {
            val actual = ByteArray(expected.size)
            var offset = 0
            while (offset < actual.size) {
                val frame = checkNotNull(sent.poll(5, TimeUnit.SECONDS)).toByteArray()
                frame.copyInto(actual, offset)
                offset += frame.size
            }
            assertArrayEquals(expected, actual)
        }
    }

    private companion object {
        const val CNXN = 0x4e584e43
        const val AUTH = 0x48545541
        const val STLS = 0x534c5453
        const val OPEN = 0x4e45504f
        const val OKAY = 0x59414b4f
        const val WRTE = 0x45545257
        const val CLSE = 0x45534c43

        fun packet(command: Int, arg0: Int, arg1: Int, payload: ByteArray, skipChecksum: Boolean = false): ByteArray {
            val checksum = if (skipChecksum) 0 else payload.sumOf { it.toInt() and 0xff }
            return ByteBuffer.allocate(24 + payload.size).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(command).putInt(arg0).putInt(arg1).putInt(payload.size)
                .putInt(checksum).putInt(command.inv()).put(payload).array()
        }
    }
}
