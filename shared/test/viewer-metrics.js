// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(netemOnly = false) {
  const events = new Map(), documentEvents = new Map(), videoEvents = new Map();
  const timers = new Map(), frames = [], peers = [], metrics = [], netem = [];
  let now = 5000, timerId = 0;
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, currentTime: 0,
    play: async () => {}, requestVideoFrameCallback: callback => frames.push(callback),
    addEventListener: (event, callback) => videoEvents.set(event, callback) };
  const elements = { video, audio: {}, overlay: { classList: { toggle() {} } },
    kbd: { addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener: (event, callback) => events.set(event, callback),
    TD: { send() {}, ready() {}, playing() {}, videoState() {},
      videoMetrics: (generation, session, width, height, fps, kbps, dropped) =>
        metrics.push({ generation, session, width, height, fps, kbps, dropped }) } };
  if (netemOnly) {
    delete window.TD.videoState;
    delete window.TD.videoMetrics;
    window.TD.netemSample = (...sample) => netem.push(sample);
  }
  const document = { hidden: false, getElementById: id => elements[id],
    addEventListener: (event, callback) => documentEvents.set(event, callback),
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) }) };
  class Peer {
    constructor(config) { peers.push(this); this.config = config; this.connectionState = 'connected'; this.localDescription = { sdp: '' }; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {}
    async addIceCandidate() {}
    async createAnswer() { return {}; }
    async setLocalDescription() {}
    getReceivers() { return []; }
    async getStats() { return this.stats(); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    window, document, RTCPeerConnection: Peer, MediaStream: class {}, console: { log() {} },
    performance: { now: () => now },
    setTimeout: (callback, wait = 0) => { timers.set(++timerId, { callback, at: now + wait }); return timerId; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => frames.push(callback),
  });
  const receive = message => window.tdRecv(message);
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.callback();
  };
  const decodedFrame = () => { for (const callback of frames.splice(0)) callback(); };
  const connect = async (session = 1, extra = {}) => {
    receive({ t: 'rtc.offer', session, viewerGeneration: session + 100, sdp: '', ...extra });
    await new Promise(resolve => setImmediate(resolve));
    peers.at(-1).ontrack({ track: { kind: 'video' }, receiver: {} });
    videoEvents.get('playing')();
    decodedFrame();
  };
  return { peers, metrics, netem, receive, advance, decodedFrame, connect, document, documentEvents };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function measuredRates() {
  const f = fixture();
  await f.connect();
  let count = 0;
  f.peers[0].stats = async () => {
    count++;
    return new Map([['in', { id: 'video', type: 'inbound-rtp', kind: 'video',
      timestamp: count * 2000, framesDecoded: count * 120, bytesReceived: count * 250000, framesDropped: count }]]);
  };
  f.advance(2000); await tick();
  assert.deepEqual(f.metrics[0], { generation: 101, session: 1, width: 1920, height: 1080, fps: -1, kbps: -1, dropped: 1 });
  f.advance(2000); await tick();
  assert.deepEqual(f.metrics[1], { generation: 101, session: 1, width: 1920, height: 1080, fps: 60, kbps: 1000, dropped: 2 });
  f.receive({ t: 'stream.stop' });
  f.advance(10000); await tick();
  assert.equal(count, 2, 'stopped viewers no longer sample');
}
async function retiredReports() {
  const f = fixture();
  await f.connect();
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  await f.connect(2);
  finish(new Map([['in', { type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 60, bytesReceived: 1000 }]]));
  await tick();
  assert.deepEqual(f.metrics, [], 'an old offer cannot report under the replacement');
  f.peers[1].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.document.hidden = true;
  f.documentEvents.get('visibilitychange')();
  finish(new Map([['in', { type: 'inbound-rtp', kind: 'video', timestamp: 2000 }]]));
  await tick();
  assert.deepEqual(f.metrics, [], 'backgrounding rejects an in-flight report');
}
async function transientDisconnectRecovers() {
  const f = fixture();
  await f.connect();
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.peers[0].connectionState = 'connecting';
  finish(new Map([['in', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 10, bytesReceived: 1000 }]]));
  await tick();
  assert.deepEqual(f.metrics, []);
  f.peers[0].connectionState = 'connected';
  f.peers[0].stats = async () => new Map([['in', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 3000, framesDecoded: 130, bytesReceived: 251000, framesDropped: 1 }]]);
  f.peers[0].onconnectionstatechange();
  f.decodedFrame();
  f.advance(2000); await tick();
  assert.equal(f.metrics.length, 1, 'polling resumes after transient non-connected getStats');
}

async function scopedNetem() {
  const f = fixture(true);
  const expected = 'turn:100.64.0.77:43199?transport=tcp';
  const issued = 'turn:127.0.0.1:43200?transport=tcp';
  const ice = { netem: true, iceTransportPolicy: 'relay',
    iceServers: [{ urls: issued, username: 'fixture', credential: 'fixture' }] };
  await f.connect(1, { ice, _netemTurn: expected });
  assert.equal(f.peers[0].config.iceServers[0].urls, expected);
  assert.equal(f.peers[0].config.iceTransportPolicy, 'relay');
  assert.deepEqual(f.netem[0], [101, 1, true, -1, -1, 'unverified']);

  let url = expected, clock = 0, selected = 'pair';
  f.peers[0].stats = async () => {
    clock += 2000;
    return new Map([
      ['in', { id: 'video', type: 'inbound-rtp', kind: 'video', transportId: 'transport',
        timestamp: clock, framesDecoded: clock * 0.06, bytesReceived: clock * 125 }],
      ['transport', { selectedCandidatePairId: selected }],
      ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { candidateType: 'relay', relayProtocol: 'tcp', url }],
      ['remote', { candidateType: 'relay' }],
    ]);
  };
  f.advance(2000); await tick();
  assert.equal(f.netem.at(-1)[5], 'proxy-turn-tcp');
  url = 'turn:100.64.0.77:43197?transport=tcp';
  f.advance(2000); await tick();
  assert.deepEqual(f.netem.at(-1), [101, 1, false, 60, 1000, 'bypass']);
  url = expected;
  selected = 'missing';
  f.advance(2000); await tick();
  assert.equal(f.netem.at(-1)[5], 'unverified', 'a different nominated pair cannot stand in for the selected pair');

  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.receive({ t: 'stream.stop' });
  const reported = f.netem.length;
  finish(new Map([['in', { type: 'inbound-rtp', kind: 'video' }]]));
  await tick();
  assert.equal(f.netem.length, reported, 'Stop retires an in-flight netem sample');

  await f.connect(2, { ice: { ...ice, netem: false }, _netemTurn: expected });
  assert.equal(f.peers[1].config.iceServers[0].urls, issued, 'unnegotiated TURN credentials are never redirected');
  delete ice.netem;
  await f.connect(3, { ice });
  assert.equal(f.netem.at(-1)[1], 2, 'no scoped samples from a normal offer');
}
measuredRates().then(retiredReports).then(transientDisconnectRecovers).then(scopedNetem).then(() => {
  console.log('viewer metrics: decoded frame rates, capture retirement and foreground ownership passed');
}).catch(error => { console.error(error); process.exitCode = 1; });
