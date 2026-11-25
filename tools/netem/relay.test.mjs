import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startRelay } from './relay.mjs'

const host = '127.0.0.1'

test('TCP preserves bytes and FIN under modeled stalls, shapes bulk traffic, and reconnects after a cut', { timeout: 15000 }, async t => {
  const targetPort = 43170, port = 43171
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  server.listen(targetPort, host)
  await once(server, 'listening')
  let relay
  const peers = new Set()
  t.after(async () => {
    for (const socket of peers) socket.destroy()
    await relay?.close()
    await new Promise(resolve => server.close(resolve))
  })
  relay = await startRelay({ protocol: 'tcp', port, targetPort,
    rtt: 80, jitter: 0, loss: 100, mbps: 2 })

  function connect() {
    const socket = createConnection(port, host)
    peers.add(socket)
    socket.once('close', () => peers.delete(socket))
    return socket
  }

  async function echo(payload) {
    const socket = connect()
    socket.end(payload)
    const chunks = []
    for await (const chunk of socket) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  const short = Buffer.from('synthetic control')
  const start = performance.now()
  assert.deepEqual(await echo(short), short)
  assert.ok(performance.now() - start >= 235, '80 ms RTT plus an 80 ms stall each way')
  const bulk = Buffer.alloc(512 * 1024)
  for (let index = 0; index < bulk.length; ++index) bulk[index] = index % 251
  const bulkStart = performance.now()
  assert.deepEqual(await echo(bulk), bulk)
  assert.ok(performance.now() - bulkStart >= (bulk.length - 65536) / 250,
    'both directions are capped at 2 Mbps after the allowed burst')
  const stats = relay.stats()
  for (const side of [stats.up, stats.down]) {
    assert.ok(side.stalls >= 2)
    assert.equal(side.received, side.forwarded)
    assert.equal(side.bytes, short.length + bulk.length)
    assert.equal(side.overflow, 0)
    assert.ok(side.peakBytes <= 256 * 1024)
  }

  const live = connect()
  await once(live, 'connect')
  const lost = once(live, 'close')
  relay.cut()
  await lost
  const rejected = connect()
  await once(rejected, 'close')
  assert.equal(relay.stats().active, 0)
  assert.ok(relay.stats().rejected >= 1)
  relay.reconnect()
  assert.deepEqual(await echo(short), short)
})

test('UDP limits loss, queues and exposure and retires per-client state on cut or idle', { timeout: 8000 }, async t => {
  const targetPort = 43172, port = 43173
  const target = createSocket('udp4')
  target.on('message', (data, sender) => target.send(data, sender.port, host))
  target.bind(targetPort, host)
  await once(target, 'listening')
  const options = { protocol: 'udp', port, targetPort, rtt: 80, jitter: 0, idleMs: 1000 }
  const clients = [createSocket('udp4'), createSocket('udp4')]
  let relay
  t.after(async () => {
    for (const client of clients) client.close()
    await relay?.close()
    target.close()
  })

  await assert.rejects(startRelay({ ...options, host: '0.0.0.0' }), /unicast IPv4/)
  await assert.rejects(startRelay({ ...options, host: '192.0.2.4' }), /explicit unicast client/)
  await assert.rejects(startRelay({ ...options, targetPort: 51228 }), /allowed listener and target/)
  relay = await startRelay({ ...options, loss: 100 })
  for (const client of clients) {
    client.bind(0, host)
    await once(client, 'listening')
  }
  clients[0].send('discard', port, host)
  for (let retry = 0; retry < 20 && !relay.stats().up.dropped; retry++) await sleep(10)
  assert.equal(relay.stats().up.dropped, 1)
  assert.equal(relay.stats().up.forwarded, 0)
  await relay.close()
  relay = await startRelay({ ...options, loss: 0 })

  function send(client, payload) {
    const reply = once(client, 'message')
    client.send(payload, port, host)
    return reply.then(([data]) => data.toString())
  }
  assert.deepEqual(await Promise.all(clients.map((client, i) => send(client, `flow ${i}`))),
    ['flow 0', 'flow 1'])
  assert.equal(relay.stats().active, 2)
  const large = Buffer.alloc(8000)
  await Promise.all(Array.from({ length: 96 }, () => new Promise((resolve, reject) => {
    clients[0].send(large, port, host, error => error ? reject(error) : resolve())
  })))
  for (let retry = 0; retry < 20 && !relay.stats().up.overflow; retry++) await sleep(5)
  assert.ok(relay.stats().up.overflow > 0)
  assert.ok(relay.stats().up.peakBytes <= 256 * 1024)
  relay.cut()
  assert.equal(relay.stats().active, 0)
  relay.reconnect()
  assert.equal(await send(clients[0], 'new flow'), 'new flow')
  for (let retry = 0; retry < 40 && relay.stats().active; retry++) await sleep(50)
  assert.equal(relay.stats().active, 0)
})
