// TwinDesk — GPL-3.0, see LICENSE.
package com.twindesk.android.embedded

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

/** Requires native signature verification on one local adbd socket, then relays ADB stream commands. */
internal class AdbAdmission {
    enum class Source { HOST, DEVICE }

    private enum class Phase(val source: Source) {
        HOST_CONNECT(Source.HOST),
        DEVICE_CHALLENGE(Source.DEVICE),
        HOST_SIGNATURE(Source.HOST),
        DEVICE_RESULT(Source.DEVICE),
    }

    private data class Packet(val bytes: ByteArray, val consumed: Int)

    private var phase = Phase.HOST_CONNECT
    private var buffer: ByteArray? = ByteArray(HEADER_SIZE + MAX_HANDSHAKE_PAYLOAD)
    private var buffered = 0
    private var packetSize = HEADER_SIZE
    private var hostVersion = VERSION_CHECKSUM
    private val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    private val fromHost = StreamPackets()
    private val fromDevice = StreamPackets()
    @Volatile private var admitted = false

    fun readTimeoutMillis(): Int {
        if (admitted) return 0
        val remaining = deadline - System.nanoTime()
        if (remaining <= 0) throw IOException("ADB authorization timed out")
        return TimeUnit.NANOSECONDS.toMillis(remaining).toInt().coerceAtLeast(1)
    }

    fun relay(source: Source, bytes: ByteArray, size: Int, forward: (ByteArray, Int, Int) -> Unit) {
        var offset = 0
        if (!admitted) {
            // Both readers share the auth phase. Socket writes can block and run outside this lock.
            val packet = synchronized(this) {
                if (admitted) null else consume(source, bytes, size) ?: return
            }
            if (packet != null) {
                forward(packet.bytes, 0, packet.bytes.size)
                offset = packet.consumed
            }
        }
        if (offset < size) {
            val packets = if (source == Source.HOST) fromHost else fromDevice
            packets.relay(bytes, offset, size, forward)
        }
    }

    private fun consume(source: Source, bytes: ByteArray, size: Int): Packet? {
        val pending = buffer ?: refuse()
        readTimeoutMillis()
        if (source != phase.source) refuse()
        var consumed = 0
        if (buffered < HEADER_SIZE) {
            consumed = minOf(size, HEADER_SIZE - buffered)
            bytes.copyInto(pending, buffered, 0, consumed)
            buffered += consumed
            if (buffered < HEADER_SIZE) return null
            packetSize = HEADER_SIZE + validateHeader(pending)
        }
        val copied = minOf(size - consumed, packetSize - buffered)
        bytes.copyInto(pending, buffered, consumed, consumed + copied)
        consumed += copied
        buffered += copied
        if (buffered != packetSize) return null

        val header = ByteBuffer.wrap(pending).order(ByteOrder.LITTLE_ENDIAN)
        val command = header.getInt(0)
        val version = if (phase == Phase.HOST_CONNECT) header.getInt(4) else hostVersion
        validatePayload(pending, command, version, header.getInt(16))
        val success = phase == Phase.DEVICE_RESULT && command == CNXN
        if (!success && consumed != size) refuse()
        val packet = Packet(pending.copyOf(packetSize), consumed)
        buffered = 0
        packetSize = HEADER_SIZE
        if (success) {
            buffer = null
            admitted = true
        } else {
            phase = when (phase) {
                Phase.HOST_CONNECT -> {
                    hostVersion = version
                    Phase.DEVICE_CHALLENGE
                }
                Phase.DEVICE_CHALLENGE, Phase.DEVICE_RESULT -> Phase.HOST_SIGNATURE
                Phase.HOST_SIGNATURE -> Phase.DEVICE_RESULT
            }
        }
        return packet
    }

    private fun validateHeader(bytes: ByteArray): Int {
        val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val command = header.int
        val arg0 = header.int
        val arg1 = header.int
        val length = header.int
        if (header.getInt(20) != command.inv() || length !in 1..MAX_HANDSHAKE_PAYLOAD) refuse()

        val connect = command == CNXN && arg0 in VERSION_CHECKSUM..VERSION_SKIP_CHECKSUM &&
            arg1 >= MAX_HANDSHAKE_PAYLOAD
        val token = command == AUTH && arg0 == AUTH_TOKEN && arg1 == 0 && length == TOKEN_SIZE
        val signature = command == AUTH && arg0 == AUTH_SIGNATURE && arg1 == 0 && length == SIGNATURE_SIZE
        val valid = when (phase) {
            Phase.HOST_CONNECT -> connect
            Phase.DEVICE_CHALLENGE -> token
            Phase.HOST_SIGNATURE -> signature
            Phase.DEVICE_RESULT -> token || connect
        }
        if (!valid) refuse()
        return length
    }

    private fun validatePayload(bytes: ByteArray, command: Int, version: Int, advertisedChecksum: Int) {
        if (version < VERSION_SKIP_CHECKSUM || advertisedChecksum != 0) {
            var checksum = 0
            for (index in HEADER_SIZE until packetSize) checksum += bytes[index].toInt() and 0xff
            if (checksum != advertisedChecksum) refuse()
        }
        if (command == CNXN) {
            val banner = bytes.decodeToString(HEADER_SIZE, packetSize).removeSuffix("\u0000")
            val prefix = if (phase == Phase.HOST_CONNECT) "host:" else "device:"
            if (!banner.startsWith(prefix) || banner.indexOf(':', prefix.length) < 0 || '\u0000' in banner) refuse()
        }
    }

    private fun refuse(): Nothing {
        buffer = null
        throw IOException("ADB authorization rejected")
    }

    // One reader owns each direction. Retain only a partial header between reads and stream payloads.
    private class StreamPackets {
        private val header = ByteArray(HEADER_SIZE)
        private var headerBytes = 0
        private var payloadRemaining = 0

        fun relay(bytes: ByteArray, start: Int, size: Int, forward: (ByteArray, Int, Int) -> Unit) {
            var offset = start
            var forwardFrom = start
            while (offset < size) {
                val available = size - offset
                if (payloadRemaining > 0) {
                    val count = minOf(available, payloadRemaining)
                    offset += count
                    payloadRemaining -= count
                } else if (headerBytes == 0 && available >= HEADER_SIZE) {
                    payloadRemaining = payloadSize(bytes, offset)
                    offset += HEADER_SIZE
                } else {
                    if (offset > forwardFrom) forward(bytes, forwardFrom, offset - forwardFrom)
                    val count = minOf(available, HEADER_SIZE - headerBytes)
                    bytes.copyInto(header, headerBytes, offset, offset + count)
                    headerBytes += count
                    offset += count
                    forwardFrom = offset
                    if (headerBytes == HEADER_SIZE) {
                        payloadRemaining = payloadSize(header, 0)
                        forward(header, 0, HEADER_SIZE)
                        headerBytes = 0
                    }
                }
            }
            if (offset > forwardFrom) forward(bytes, forwardFrom, offset - forwardFrom)
        }

        private fun payloadSize(bytes: ByteArray, offset: Int): Int {
            val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            val command = header.getInt(offset)
            val length = header.getInt(offset + 12)
            // Only stream commands are valid here. In particular, AUTH, CNXN and STLS can change auth state.
            if (command != OPEN && command != OKAY && command != WRTE && command != CLSE ||
                header.getInt(offset + 20) != command.inv() || length !in 0..MAX_STREAM_PAYLOAD) {
                throw IOException("Unexpected ADB stream header")
            }
            return length
        }
    }

    private companion object {
        const val HEADER_SIZE = 24
        const val MAX_HANDSHAKE_PAYLOAD = 4096
        const val MAX_STREAM_PAYLOAD = 1024 * 1024
        const val CNXN = 0x4e584e43
        const val AUTH = 0x48545541
        const val OPEN = 0x4e45504f
        const val OKAY = 0x59414b4f
        const val WRTE = 0x45545257
        const val CLSE = 0x45534c43
        const val VERSION_CHECKSUM = 0x01000000
        const val VERSION_SKIP_CHECKSUM = 0x01000001
        const val AUTH_TOKEN = 1
        const val AUTH_SIGNATURE = 2
        const val TOKEN_SIZE = 20
        const val SIGNATURE_SIZE = 256
    }
}
