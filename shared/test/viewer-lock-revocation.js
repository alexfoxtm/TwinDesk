// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function fixture(local = true, touch = 'direct') {
  const events = new Map(), docEvents = new Map(), videoEvents = new Map(), sent = [], timers = new Map(), frames = new Map(), videoFrames = [], videoStates = [], peers = [], detailRequests = [], videoMetrics = [];
  let now = 10000, timerId = 0, frameId = 0;
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, play: async () => {}, requestVideoFrameCallback: fn => videoFrames.push(fn), addEventListener(k, fn) { videoEvents.set(k, fn); } };
  const ctx = { setTransform() {}, clearRect() {} };
  const cue = { hidden: true, style: {} };
  const nodes = { video, 'pointer-cue': cue, audio: {}, overlay: { classList: { toggle() {} } }, kbd: { value: '', addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(k, fn) { events.set(k, fn); },
    TD: { send: (m) => sent.push(JSON.parse(m)), ready() {}, playing() {}, videoState: (generation, session, playing, w, h) => videoStates.push({ generation, session, playing, w, h }), haptic() {},
      videoMetrics: (generation, session, w, h, fps, kbps, dropped) => videoMetrics.push({ generation, session, w, h, fps, kbps, dropped }),
      canDecodeVideo: (_codec, width, height, _fps) => width <= 3840 && height <= 2160,
      detail: (generation, session, height) => detailRequests.push({ generation, session, height }) } };
  const document = { hidden: false, getElementById: (id) => nodes[id], addEventListener(k, fn) { docEvents.set(k, fn); },
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ctx }) };
  class Peer {
    constructor() { peers.push(this); this.connectionState = 'connected'; this.localDescription = { sdp: 'fixture' }; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {} async addIceCandidate() {} async createAnswer() { return {}; } async setLocalDescription() {}
    getReceivers() { return []; }
    async getStats() {
      if (this.stats) return this.stats();
      return new Map([['in', { type: 'inbound-rtp', kind: 'video', codecId: 'codec' }],
        ['codec', { mimeType: 'video/H264' }]]);
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } }, window, document, console: { log() {} }, performance: { now: () => now },
    setTimeout: (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: (id) => timers.delete(id), requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
  });
  const pointer = (type, id, x, y, extra = {}) => events.get(type)({ pointerId: id, pointerType: 'touch', button: 0,
    clientX: x, clientY: y, preventDefault() {}, ...extra });
  const recv = (m) => window.tdRecv(m);
  recv({ t: 'opts', viewGestures: local, touch, tap: true });
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  return { window, video, cue, peers, videoStates, detailRequests, videoMetrics, videoFrame() { for (const fn of videoFrames.splice(0)) fn(); }, overlay: nodes.overlay, sent, pointer, events, recv, document, docEvents, videoEvents,
    frame() { for (const [id, fn] of [...frames]) { if (frames.delete(id)) fn(); } },
    advance, hold() { advance(600); } };
}

const zoomDetail = { baseline: 1080, fps: 60, sizes: [null, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }] };
async function detailedViewer(session = 40, touch = 'direct', local = true) {
  const f = fixture(local, touch);
  f.recv({ t: 'rtc.offer', session, viewerGeneration: session + 100, sdp: 'fixture', detail: zoomDetail });
  await new Promise(resolve => setImmediate(resolve));
  f.peers[0].ontrack({ track: { kind: 'video' }, receiver: {} });
  f.videoEvents.get('playing')(); f.videoFrame();
  return f;
}
function zoomIn(f) {
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400);
  f.pointer('pointermove', 2, 800, 400); f.frame();
  f.pointer('pointerup', 1, 400, 400); f.pointer('pointerup', 2, 800, 400);
}
async function detailRevokedByLock() {
  const f = await detailedViewer();
  zoomIn(f);
  f.recv({ t: 'viewer.probe', session: 40, viewerGeneration: 141, accept: false }); f.advance(400);
  assert.deepStrictEqual(f.detailRequests, [], 'lock probe cancels the old frame request');
  f.recv({ t: 'viewer.probe', session: 40, viewerGeneration: 142, accept: true }); f.videoFrame();
  f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [{ generation: 142, session: 40, height: 1440 }]);
}

async function trackpadCueDoesNotSurviveRevocation() {
  const f = await detailedViewer(51, 'pad');
  f.recv({ t: 'screen.state', on: true, remote: true });
  f.recv({ t: 'viewer.input', on: true });
  f.pointer('pointerdown', 1, 500, 400);
  f.pointer('pointermove', 1, 530, 430);
  f.recv({ t: 'viewer.input', on: false });
  f.frame();
  assert.equal(f.cue.hidden, true, 'a queued cue cannot appear after input is revoked');
  f.recv({ t: 'viewer.input', on: true });
  f.pointer('pointermove', 1, 560, 460);
  f.frame();
  assert.equal(f.cue.hidden, false);
  f.recv({ t: 'viewer.probe', session: 51, viewerGeneration: 152, accept: false });
  assert.equal(f.cue.hidden, true, 'lock clears the visible cue immediately');
  f.pointer('pointermove', 1, 590, 490);
  f.frame();
  assert.equal(f.cue.hidden, true);
}

async function receiveMetricsRejectLateStats() {
  const f = await detailedViewer(61);
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.recv({ t: 'viewer.probe', session: 61, viewerGeneration: 162, accept: false });
  finish(new Map([['in', { id: 'old', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 100, bytesReceived: 1000 }]]));
  await new Promise(resolve => setImmediate(resolve));
  f.advance(10000);
  assert.deepEqual(f.videoMetrics, [], 'an async report from the locked generation is discarded');
}

detailRevokedByLock().then(trackpadCueDoesNotSurviveRevocation)
  .then(receiveMetricsRejectLateStats).catch(error => { console.error(error); process.exitCode = 1; });
