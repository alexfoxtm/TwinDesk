// Synthetic loopback sweep. The timestamp and sequence fields belong to the fixture.
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { startRelay } from './relay.mjs'

const host = '127.0.0.1'
const seed = '20261125'
const probes = 100
const intervalMs = 20
const settleMs = 600
const probeSize = 64

function percentile(ordered, fraction) {
  if (!ordered.length) return null
  return Math.round(ordered[Math.ceil(ordered.length * fraction) - 1] * 10) / 10
}

async function sweep(rtt, targetPort) {
  const target = createSocket('udp4')
  const client = createSocket('udp4')
  const port = targetPort + 1
  const received = new Map()
  let relay
  try {
    target.on('message', (data, peer) => target.send(data, peer.port, host))
    client.on('message', (data, peer) => {
      if (peer.address === host && peer.port === port && data.length === probeSize) {
        received.set(data.readUInt32BE(0), performance.now() - data.readDoubleBE(4))
      }
    })
    target.bind(targetPort, host)
    client.bind(targetPort + 2, host)
    await Promise.all([once(target, 'listening'), once(client, 'listening')])

    for (const loss of [1, 3, 5]) {
      for (const mbps of [2, 5, 20]) {
        relay = await startRelay({ protocol: 'udp', rtt, loss, mbps, port, targetPort, seed })
        received.clear()
        const begin = performance.now()
        for (let index = 0; index < probes; index++) {
          const data = Buffer.alloc(probeSize)
          data.writeUInt32BE(index, 0)
          data.writeDoubleBE(performance.now(), 4)
          client.send(data, port, host)
          await sleep(Math.max(0, begin + (index + 1) * intervalMs - performance.now()))
        }
        await sleep(settleMs)
        const durationMs = Math.round(performance.now() - begin)
        const samples = [...received.values()].sort((a, b) => a - b)
        const { up, down } = relay.stats()
        console.log(JSON.stringify({
          kind: 'udp-echo', rtt, loss, mbps, seed, durationMs, sent: probes, echoed: samples.length,
          p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95),
          upDrops: up.dropped, downDrops: down.dropped, upOverflow: up.overflow,
          downOverflow: down.overflow, sendErrors: up.sendErrors + down.sendErrors,
        }))
        await relay.close()
      }
    }
  } finally {
    await relay?.close()
    client.close()
    target.close()
  }
}

async function rate(mbps, targetPort) {
  let received = 0
  let failure
  const target = createServer(socket => {
    socket.on('data', data => { received += data.length })
    socket.on('error', error => { failure ??= error })
  })
  const port = targetPort + 1
  let relay
  let client
  try {
    target.listen(targetPort, host)
    await once(target, 'listening')
    relay = await startRelay({ protocol: 'tcp', rtt: 0, loss: 0, jitter: 0, mbps, port, targetPort, seed })
    client = createConnection(port, host)
    await once(client, 'connect')
    client.on('error', error => { failure ??= error })
    const chunk = Buffer.alloc(16384)
    function pump() {
      while (client.write(chunk)) { /* Stop at socket backpressure. */ }
    }
    client.on('drain', pump)
    pump()
    await sleep(1000)
    const begin = performance.now()
    const before = received
    await sleep(2000)
    if (failure) throw failure
    const durationMs = Math.round(performance.now() - begin)
    const bytes = received - before
    console.log(JSON.stringify({
      kind: 'tcp-bulk', mbps, seed, warmupMs: 1000, durationMs, bytes,
      measuredMbps: Math.round(bytes * 8 / durationMs / 10) / 100,
      overflow: relay.stats().up.overflow,
    }))
  } finally {
    client?.destroy()
    await relay?.close()
    await new Promise(resolve => target.close(resolve))
  }
}

const results = await Promise.allSettled([
  sweep(80, 43180), sweep(150, 43183), sweep(300, 43186),
  rate(2, 43189), rate(5, 43191), rate(20, 43193),
])
for (const result of results) {
  if (result.status === 'rejected') {
    console.error(result.reason.code ?? result.reason.message)
    process.exitCode = 1
  }
}
