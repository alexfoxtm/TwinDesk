import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer, isIPv4, Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export const profiles = Object.freeze({
  easy: Object.freeze({ rtt: 80, loss: 1, mbps: 20 }),
  poor: Object.freeze({ rtt: 150, loss: 3, mbps: 5 }),
  severe: Object.freeze({ rtt: 300, loss: 5, mbps: 2 }),
})

const loopback = '127.0.0.1'
const excludedPorts = new Set([51228, 47624])
const maxFlows = 32
const queueBytes = 256 * 1024
const queueItems = 512
const burst = 64 * 1024 // Holds even a maximum-sized IPv4 UDP datagram.

function random(seed, flow, direction, kind) {
  let state = createHash('sha256').update(JSON.stringify([seed, flow, direction, kind]))
    .digest().readUInt32LE()
  return () => {
    // Mulberry32 with an independent state for each draw type and direction.
    state = (state + 0x6D2B79F5) >>> 0
    let word = Math.imul(state ^ (state >>> 15), state | 1)
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61)
    return ((word ^ (word >>> 14)) >>> 0) / 2 ** 32
  }
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !excludedPorts.has(port)
}

function externalAddress(address) {
  if (!isIPv4(address)) return false
  const firstOctet = Number(address.split('.')[0])
  return firstOctet > 0 && firstOctet !== 127 && firstOctet < 224
}

function validate({ protocol, host, port, targetPort, client, seed, rtt, loss, mbps, jitter, idleMs }) {
  if (!['tcp', 'udp'].includes(protocol) || !validPort(port) || !validPort(targetPort) || port === targetPort) {
    throw new Error('Use tcp or udp and distinct allowed listener and target ports')
  }
  if (host !== loopback && !externalAddress(host)) {
    throw new Error('Use an explicit unicast IPv4 listener')
  }
  if (host !== loopback && !externalAddress(client)) {
    throw new Error('A non-loopback listener requires one explicit unicast client IPv4')
  }
  if (host === loopback && client !== loopback) throw new Error('Loopback listener requires loopback client')
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > 80 ||
      !Number.isFinite(rtt) || rtt < 0 || rtt > 1000 ||
      !Number.isFinite(loss) || loss < 0 || loss > 100 ||
      ![2, 5, 20].includes(mbps) || !Number.isInteger(jitter) || jitter < 0 || jitter > 30 ||
      !Number.isInteger(idleMs) || idleMs < 1000 || idleMs > 120000) {
    throw new Error('Invalid seed, RTT, loss, jitter, rate or idle timeout')
  }
}

function direction(config, flow, name, stats, write, end, pause, resume) {
  const jitterRandom = random(config.seed, flow, name, 'jitter')
  const lossRandom = random(config.seed, flow, name, 'loss')
  const bytesPerMs = config.mbps * 125
  let tokens = burst
  let updatedAt = performance.now()
  let queued = 0
  const queue = []
  let timer
  let writing = false
  let ended = false
  let closed = false

  function drain() {
    if (closed || writing || timer) return
    const entry = queue[0]
    if (!entry) {
      if (ended) end()
      return
    }
    const now = performance.now()
    tokens = Math.min(burst, tokens + (now - updatedAt) * bytesPerMs)
    updatedAt = now
    const wait = Math.max(entry.due - now, (entry.data.length - tokens) / bytesPerMs)
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined
        drain()
      }, Math.ceil(wait))
      return
    }
    writing = true
    tokens -= entry.data.length
    write(entry.data, (err) => {
      if (closed) return
      if (err) stats.sendErrors++
      else {
        stats.forwarded++
        stats.bytes += entry.data.length
      }
      queue.shift()
      queued -= entry.data.length
      writing = false
      if (queued < queueBytes / 2 && queue.length < queueItems / 2) resume()
      drain()
    })
  }

  return {
    push(data) {
      const offset = Math.floor(jitterRandom() * (2 * config.jitter + 1)) - config.jitter
      const hit = lossRandom() * 100 < config.loss
      stats.received++
      if (hit && config.protocol === 'udp') {
        stats.dropped++
        return true
      }
      if (queue.length >= queueItems || queued + data.length > queueBytes) {
        stats.overflow++
        return config.protocol === 'udp'
      }
      // Model one retransmission wait per sampled TCP read. Preserve all bytes and order.
      if (hit) stats.stalls++
      const delay = Math.max(0, config.rtt / 2 + offset) + (hit ? config.rtt : 0)
      queued += data.length
      queue.push({ data, due: performance.now() + delay })
      stats.peakBytes = Math.max(stats.peakBytes, queued)
      stats.peakItems = Math.max(stats.peakItems, queue.length)
      if (queued >= queueBytes / 2 || queue.length >= queueItems / 2) pause()
      drain()
      return true
    },
    end() {
      ended = true
      drain()
    },
    close() {
      closed = true
      clearTimeout(timer)
      queue.length = 0
    },
  }
}

const noop = () => {}
const counters = () => ({
  received: 0, forwarded: 0, bytes: 0, dropped: 0, stalls: 0, overflow: 0,
  sendErrors: 0, peakBytes: 0, peakItems: 0,
})

export async function startRelay(options) {
  const host = options.host ?? loopback
  const config = { ...profiles.easy, seed: '20261125', jitter: 30, idleMs: 60000, ...options,
    host, client: options.client ?? (host === loopback ? loopback : undefined) }
  validate(config)
  const { protocol, port, targetPort, client, idleMs } = config
  const tcp = protocol === 'tcp'
  const flows = new Map()
  const stats = { up: counters(), down: counters(), opened: 0, closed: 0, rejected: 0 }
  let cut = false
  let stopping = false

  function createFlow(key, from, to) {
    const ordinal = ++stats.opened
    const flow = { activity: performance.now() }
    const channel = (name, source, destination) => direction(config, ordinal, name, stats[name],
      destination.write, destination.end ?? noop, source.pause ?? noop, source.resume ?? noop)
    flow.up = channel('up', from, to)
    flow.down = channel('down', to, from)
    flow.push = (name, data) => {
      if (flows.get(key) !== flow) return
      flow.activity = performance.now()
      if (!flow[name].push(data)) flow.close()
    }
    flow.close = () => {
      if (flows.get(key) !== flow) return
      flows.delete(key)
      stats.closed++
      flow.up.close()
      flow.down.close()
      from.close()
      to.close()
    }
    flows.set(key, flow)
    return flow
  }

  function allowed(address) {
    if (!stopping && !cut && address === client) return true
    stats.rejected++
    return false
  }

  function atCapacity() {
    if (flows.size < maxFlows) return false
    stats.rejected++
    return true
  }

  function acceptTcp(source) {
    if (!allowed(source.remoteAddress) || atCapacity()) {
      source.destroy()
      return
    }
    const target = new Socket({ allowHalfOpen: true })
    const endpoint = socket => ({
      write: (data, callback) => socket.write(data, callback),
      end: () => socket.end(),
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      close: () => socket.destroy(),
    })
    const flow = createFlow(source, endpoint(source), endpoint(target))
    let socketsClosed = 0
    function read(socket, name) {
      socket.setNoDelay(true)
      socket.on('data', data => flow.push(name, data))
      socket.once('end', () => flow[name].end())
      socket.once('error', flow.close)
      socket.once('close', hadError => {
        if (hadError || ++socketsClosed === 2) flow.close()
      })
    }
    // Block client reads pending the fixed upstream connection. The connection
    // handshake itself runs on the two native TCP legs without injected delay.
    source.pause()
    read(source, 'up')
    read(target, 'down')
    target.setTimeout(5000, flow.close)
    target.once('connect', () => {
      target.setTimeout(0)
      source.resume()
    })
    target.connect(targetPort, loopback)
  }

  function acceptUdp(data, remote) {
    if (!allowed(remote.address)) return
    let flow = flows.get(remote.port)
    if (!flow) {
      if (atCapacity()) return
      const target = createSocket('udp4')
      let onConnected
      flow = createFlow(remote.port, {
        write: (buffer, done) => listener.send(buffer, remote.port, client, done),
        close: noop,
      }, {
        write(buffer, done) {
          if (onConnected === null) target.send(buffer, done)
          else onConnected = () => target.send(buffer, done)
        },
        close: () => target.close(),
      })
      target.on('message', buffer => flow.push('down', buffer))
      target.on('error', flow.close)
      // A dedicated connected socket isolates reply routing and filters the fixed target.
      target.connect(targetPort, loopback, () => {
        const send = onConnected
        onConnected = null
        send?.()
      })
    }
    flow.push('up', data)
  }

  const listener = tcp ? createServer({ allowHalfOpen: true, pauseOnConnect: true }, acceptTcp)
    : createSocket('udp4', acceptUdp)
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    const ready = () => {
      listener.off('error', reject)
      resolve()
    }
    if (tcp) listener.listen({ port, host, exclusive: true }, ready)
    else listener.bind({ port, address: host, exclusive: true }, ready)
  }).catch(error => {
    if (!tcp) listener.close()
    throw error
  })

  function closeFlows() {
    for (const flow of flows.values()) flow.close()
  }
  const reaper = setInterval(() => {
    const now = performance.now()
    for (const flow of flows.values()) {
      if (now - flow.activity >= idleMs) flow.close()
    }
  }, Math.min(idleMs / 2, 1000))

  let shutdown
  function close() {
    shutdown ??= new Promise(resolve => {
      stopping = true
      clearInterval(reaper)
      closeFlows()
      listener.close(resolve)
    })
    return shutdown
  }
  listener.on('error', () => {
    stats.listenerErrors = (stats.listenerErrors ?? 0) + 1
    void close()
  })

  return {
    cut() { cut = true; closeFlows() },
    reconnect() { cut = false },
    stats: () => structuredClone({ ...stats, active: flows.size, cut }),
    close,
  }
}

async function main() {
  const { values: args } = parseArgs({ options: {
    protocol: { type: 'string' }, listen: { type: 'string' }, port: { type: 'string' },
    'target-port': { type: 'string' }, client: { type: 'string' },
    profile: { type: 'string', default: 'easy' }, seed: { type: 'string', default: '20261125' },
    rtt: { type: 'string' }, loss: { type: 'string' }, mbps: { type: 'string' },
  } })
  if (!Object.hasOwn(profiles, args.profile)) throw new Error('Use profile easy, poor or severe')
  const profile = profiles[args.profile]
  const relay = await startRelay({
    protocol: args.protocol, host: args.listen, client: args.client, port: Number(args.port),
    targetPort: Number(args['target-port']), seed: args.seed,
    rtt: Number(args.rtt ?? profile.rtt), loss: Number(args.loss ?? profile.loss),
    mbps: Number(args.mbps ?? profile.mbps),
  })
  const log = event => console.log(JSON.stringify({ event, ...relay.stats() }))
  process.on('SIGUSR1', () => { relay.cut(); log('cut') })
  process.on('SIGUSR2', () => { relay.reconnect(); log('reconnect') })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await relay.close()
    log('closed')
  })
  log('ready')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.code ?? error.message)
    process.exitCode = 1
  })
}
