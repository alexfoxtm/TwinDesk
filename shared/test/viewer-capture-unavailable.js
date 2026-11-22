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

function captureUnavailableAndRetry() {
  const capture = fixture();
  capture.recv({ t: 'stream.stop', reason: 'capture-unavailable' });
  assert.match(capture.overlay.textContent, /Screen capture is unavailable/);
  capture.recv({ t: 'stream.info' });
  capture.recv({ t: 'screen.state', on: true });
  assert.match(capture.overlay.textContent, /Retrying/,'retry state preserves the actionable failure');
  capture.videoEvents.get('playing')();
  assert.strictEqual(capture.overlay.textContent, '', 'a recovered stream clears its failure');
  capture.recv({ t: 'stream.stop', reason: 'capture-unavailable' });
  capture.recv({ t: 'screen.state', on: false });
  assert.doesNotMatch(capture.overlay.textContent, /Retrying/, 'explicit stop clears retry guidance');
  capture.recv({ t: 'stream.stop' });
  assert.match(capture.overlay.textContent, /isn’t sharing/, 'legacy stop behavior remains available');
}

captureUnavailableAndRetry();
