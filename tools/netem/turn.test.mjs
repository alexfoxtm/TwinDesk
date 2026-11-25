// Exercise the stock TURN implementation's test mode through the TCP impairment relay.
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import turnModule from '../../shared/turn.js'
import { startRelay } from './relay.mjs'

const host = '127.0.0.1'
const cookie = 0x2112a442

function attr(type, data) {
  const buf = Buffer.alloc(4 + ((data.length + 3) & ~3))
  buf.writeUInt16BE(type)
  buf.writeUInt16BE(data.length, 2)
  data.copy(buf, 4)
  return buf
}

function request(type, attrs, key) {
  const body = Buffer.concat(attrs)
  const header = Buffer.alloc(20)
  header.writeUInt16BE(type)
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2)
  header.writeUInt32BE(cookie, 4)
  const frame = Buffer.concat([header, body])
  return key ? Buffer.concat([frame, attr(8, createHmac('sha1', key).update(frame).digest())]) : frame
}

function peerAddress(port) {
  const buf = Buffer.alloc(8)
  buf[1] = 1
  buf.writeUInt16BE(port ^ (cookie >>> 16), 2)
  buf.writeUInt32BE(0x7f000001 ^ cookie, 4)
  return attr(0x12, buf)
}

function readAttr(frame, type) {
  for (let offset = 20; offset < frame.length;) {
    const length = frame.readUInt16BE(offset + 2)
    if (frame.readUInt16BE(offset) === type) return frame.subarray(offset + 4, offset + 4 + length)
    offset += 4 + ((length + 3) & ~3)
  }
  throw new Error('Missing fixture attribute')
}

async function* frames(socket) {
  let buffered = Buffer.alloc(0)
  for await (const data of socket) {
    buffered = Buffer.concat([buffered, data])
    while (buffered.length >= 20) {
      const length = 20 + buffered.readUInt16BE(2)
      if (length > buffered.length) break
      yield buffered.subarray(0, length)
      buffered = buffered.subarray(length)
    }
  }
}

test('scoped TURN carries media only between live allocations through the TCP proxy', { timeout: 5000 }, async t => {
  const targetPort = 43174, port = 43175, unrelatedPort = 43176
  const upstream = new turnModule.Turn({ port: targetPort, allocationsOnly: true, password: 'loopback-fixture' })
  await upstream.start()
  let relay
  const sockets = []
  const unrelated = createSocket('udp4')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    unrelated.close()
    await relay?.close()
    upstream.stop()
  })
  unrelated.bind(unrelatedPort, host)
  await once(unrelated, 'listening')
  relay = await startRelay({ protocol: 'tcp', port, targetPort, rtt: 20, jitter: 0, loss: 0 })
  const received = []
  unrelated.on('message', data => received.push(data.length))

  const rt = attr(0x19, Buffer.from([17, 0, 0, 0]))
  async function allocate(tcpPort) {
    const socket = createConnection(tcpPort, host)
    sockets.push(socket)
    const reader = frames(socket)
    socket.write(request(3, [rt]))
    const challenge = (await reader.next()).value
    assert.equal(challenge.readUInt16BE(), 0x113)
    const realm = readAttr(challenge, 0x14)
    const nonce = readAttr(challenge, 0x15)
    const key = createHash('md5').update('td:' + realm.toString() + ':loopback-fixture').digest()
    const auth = [attr(6, Buffer.from('td')), attr(0x14, realm), attr(0x15, nonce)]
    socket.write(request(3, [rt, ...auth], key))
    const allocated = (await reader.next()).value
    assert.equal(allocated.readUInt16BE(), 0x103)
    const relayedPort = readAttr(allocated, 0x16).readUInt16BE(2) ^ (cookie >>> 16)
    return { socket, reader, relayedPort, auth, key }
  }

  const local = await allocate(targetPort)
  const remote = await allocate(port)
  const payload = Buffer.from('synthetic media')
  local.socket.write(request(0x16, [peerAddress(remote.relayedPort), attr(0x13, payload)]))
  const relayed = (await remote.reader.next()).value
  assert.equal(relayed.readUInt16BE(), 0x17)
  assert.deepEqual(readAttr(relayed, 0x13), payload)
  assert.ok(relay.stats().up.bytes > 0 && relay.stats().down.bytes > 0)

  remote.socket.write(request(9, [attr(0x0c, Buffer.from([0x40, 0, 0, 0])),
    peerAddress(unrelatedPort), ...remote.auth], remote.key))
  const denied = (await remote.reader.next()).value
  assert.equal(denied.readUInt16BE(), 0x119)
  remote.socket.write(request(0x16, [peerAddress(unrelatedPort), attr(0x13, payload)]))
  await sleep(80)
  assert.deepEqual(received, [])
})
