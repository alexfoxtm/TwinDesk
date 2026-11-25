// Offline recovery regression. Real TCP relay, paired Mesh WSS, per-device Stream dispatch,
// and viewer.js. Electron capture, native viewer events, WebRTC and frame presentation are mocked.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { startRelay } from './relay.mjs'

const require = createRequire(import.meta.url)
const Module = require('node:module')
const load = Module._load
const P = require('../../shared/protocol.js')
const { node, close, waitFor, pairPhone, rawConnect } = require('../../mac/mesh/test/lib/mesh.js')
const { StreamSet } = require('../../mac/mesh/streams.js')
const { observeNetemStream } = require('../../mac/netem-trace.js')
const ipcMain = new EventEmitter()
ipcMain.handle = () => {}
let captureWindows = 0
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    ipcMain,
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    desktopCapturer: { getSources: async () => [{ id: 'fixture-source', display_id: '1' }] },
    BrowserWindow: class {
      webContents = Object.assign(new EventEmitter(), {
        id: ++captureWindows,
        send: (event, config) => {
          if (event === 'start') queueMicrotask(() => ipcMain.emit('capture:out', { sender: this.webContents },
            { t: P.T.RTC_OFFER, session: config.session, sdp: 'fixture-sdp' }))
        },
      })
      isDestroyed() { return false }
      async loadFile() {}
    },
  }
  if (name === '../audiohub.js') return { loopback: () => false }
  if (name === '../shared/turn.js') return {
    TurnThread: class {
      async start() {}
      stop() {}
      ice() { return { iceTransportPolicy: 'relay',
        iceServers: [{ urls: 'turn:127.0.0.1:43200?transport=tcp', username: 'fixture', credential: 'fixture' }] } }
    },
  }
  return load.call(this, name, ...args)
}
const { Stream } = require('../../mac/mesh/stream.js')
const { netemTurn } = require('../../mac/netem-turn.js')
Module._load = load

async function present(offer, answer) {
  const on = new Map(), frames = [], samples = [], stages = []
  const video = { videoWidth: 640, videoHeight: 480, style: {}, play: async () => {},
    addEventListener: (event, fn) => on.set(event, fn), requestVideoFrameCallback: fn => frames.push(fn) }
  const elements = { video, audio: {}, overlay: { classList: { toggle() {} } },
    kbd: { addEventListener() {}, blur() {}, focus() {} } }
  const window = { innerWidth: 800, innerHeight: 600, addEventListener() {},
    TD: { ready() {}, playing() {}, videoState() {}, netemSample: (...args) => samples.push(args),
      netemStage: (generation, session, kind, relay) => stages.push([generation, session, kind, relay]),
      send: raw => { const msg = JSON.parse(raw); if (msg.t === P.T.RTC_ANSWER) answer(msg) } } }
  const doc = { hidden: false, getElementById: id => elements[id], addEventListener() {},
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) }) }
  let peer
  class Receiver {
    constructor() { peer = this; this.localDescription = { sdp: 'fixture-answer' } }
    async setRemoteDescription() {}
    async setLocalDescription() {}
    async createAnswer() { return {} }
    getReceivers() { return [] }
    close() {}
  }
  vm.runInNewContext(readFileSync(new URL('../../android/app/src/main/assets/web/viewer.js', import.meta.url), 'utf8'), {
    window, document: doc, RTCPeerConnection: Receiver, MediaStream: class {}, performance,
    console: { log() {} }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => frames.push(fn),
  })
  window.tdRecv({ ...offer, viewerGeneration: 1, _netemTurn: 'turn:127.0.0.1:43199?transport=tcp' })
  await new Promise(resolve => setImmediate(resolve))
  peer.ontrack({ track: { kind: 'video' }, receiver: {} })
  peer.connectionState = 'connected'
  peer.onconnectionstatechange()
  on.get('playing')()
  for (const callback of frames.splice(0)) callback()
  assert.ok(samples.some(([generation, session, first]) => generation === 1 && session === offer.session && first))
  assert.deepEqual(stages, [0, 5, 2].map(kind => [1, offer.session, kind, true]))
}

test('paired Mesh WSS cut recovers to a fresh offer and a mocked presentation within four seconds', { timeout: 9000 }, async t => {
  const phoneId = 'fixture-phone-netem'
  const calls = []
  t.mock.method(console, 'log', (line) => calls.push(String(line)))
  const prior = process.env.TWINDESK_NETEM_PHONE
  process.env.TWINDESK_NETEM_PHONE = phoneId
  const mac = await node('Fixture host')
  const clients = []
  let relay
  t.after(async () => {
    if (prior === undefined) delete process.env.TWINDESK_NETEM_PHONE
    else process.env.TWINDESK_NETEM_PHONE = prior
    for (const client of clients) client.close()
    await relay?.close()
    close(mac)
  })
  mac.server.netemIceFor = netemTurn(mac.server.https)
  const displays = new EventEmitter()
  displays.target = () => ({ id: '1', label: 'Fixture', pixelWidth: 640, pixelHeight: 480, hz: 60 })
  displays.setOverride = () => {}
  const settings = { sharing: { on: false }, bitrateMbps: 4 }
  const streams = new StreamSet({ hub: mac.hub, server: mac.server, displays, make: peer => {
    const stream = new Stream(peer, displays, () => settings, { release() {}, loopback() {} })
    observeNetemStream(stream, peer, () => settings, mac.hub)
    return stream
  } })
  const paired = await pairPhone(mac, { id: phoneId })
  clients.push(paired.client)
  paired.client.close()
  relay = await startRelay({ protocol: 'tcp', port: 43195, targetPort: mac.port, rtt: 40, jitter: 0, loss: 0 })

  async function dial() {
    const client = await rawConnect(43195)
    clients.push(client)
    client.send({ t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: paired.id, token: paired.token, os: P.OS.ANDROID, netem: 1 })
    await client.until(m => m.t === P.T.WELCOME)
    return client
  }
  const policy = { t: P.T.SCREEN_POLICY, accept: true }
  const first = await dial()
  first.send(policy)
  await waitFor(() => streams.byId.get(phoneId)?.viewer === true, 'policy delivered')
  assert.equal(first.count(P.T.RTC_OFFER), 0, 'acceptance alone cannot enable capture')
  settings.sharing.on = true
  await streams.restart('fixture owner allowed sharing')
  const before = await first.until(m => m.t === P.T.RTC_OFFER)
  await present(before, m => first.send(m))

  relay.cut()
  await waitFor(() => !mac.server.clients.has(phoneId), 'disconnected')
  const start = performance.now()
  relay.reconnect()
  const after = await dial()
  after.send(policy) // native Android re-admission is covered by its separate retry tests
  const offer = await after.until(m => m.t === P.T.RTC_OFFER, 3500)
  assert.notEqual(offer.session, before.session)
  assert.equal(offer.ice.netem, true)
  await present(offer, m => after.send(m))
  assert.ok(performance.now() - start < 4000)
  const trace = () => calls.filter(s => s.startsWith('[TwinDeskNetem]')).join('\n')
  await waitFor(() => trace().includes('stage=rx_rtc_answer'), 'answer logged')
  assert.match(trace(), /stage=stream_policy .*accept=1 .*sharing=0/)
  assert.match(trace(), /stage=capture_starting/)
  assert.match(trace(), /stage=tx_rtc_offer .*test_turn=1/)
  assert.doesNotMatch(trace(), /fixture-phone-netem|fixture-sdp|fixture-answer|credential/)
})
