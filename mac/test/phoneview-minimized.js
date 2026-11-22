// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const code = fs.readFileSync(path.join(__dirname, '../phoneview-renderer.js'), 'utf8');

function fixture(kind = 'app') {
  const events = new Map(), handlers = new Map(), decoders = [], sent = [], painted = [];
  const controls = new Map();
  const canvas = {
    width: 100, height: 200, style: {}, focus() {}, addEventListener() {},
    getContext: () => ({ drawImage: (frame) => painted.push(frame.id) }),
  };
  const element = () => ({ hidden: true, style: {}, classList: { add() {}, toggle() {} },
    setAttribute() {}, addEventListener() {} });
  const nodes = { screen: canvas, stage: { clientWidth: 400, clientHeight: 800 }, status: element(), title: element() };
  let recording = false;
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { this.chunks = (this.chunks || []).concat(chunk); }
    close() { this.state = 'closed'; }
  }
  const api = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    send: m => sent.push(JSON.parse(JSON.stringify(m))),
  };
  const rail = {
    controls: ['shot', 'rec'].map(k => {
      const el = {
        onclick() { controls.set(`${k}:after`, painted.slice()); },
        addEventListener: (_event, fn) => controls.set(k, fn),
      };
      return { k, el };
    }),
    mount() {}, recording: () => recording,
  };
  const window = { phoneview: api,
    PlayerI18n: { translate() {}, text() {}, literal() {}, t: key => key, onChange() {} },
    addEventListener: (name, fn) => events.set(name, fn),
    MirrorRail: () => rail,
  };
  vm.runInNewContext(code, {
    window, document: { body: element(), getElementById: key => nodes[key] || null, querySelector: () => element(), addEventListener() {} },
    location: { search: '?kind=' + kind }, URLSearchParams, devicePixelRatio: 2, VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data); } },
    ResizeObserver: class { observe() {} }, performance: { now: () => 5000 }, console,
    setTimeout, clearTimeout,
  });
  const recv = (name, value) => { for (const fn of handlers.get(name) || []) fn(value); };
  const config = () => recv('video', { config: true, data: Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0x1f]) });
  const frame = id => ({ id, displayWidth: 300, displayHeight: 600, closed: 0, close() { this.closed++; } });
  return { recv, config, frame, canvas, decoders, sent, painted, events, controls, rail,
    record(on) { recording = on; }, output(f) { decoders.at(-1).callbacks.output(f); } };
}

test('a minimized viewer of any kind does not decode, and restore waits for a keyframe', () => {
  for (const kind of ['app', 'screen', 'camera']) {
    const f = fixture(kind);
    f.config();
    const decoder = f.decoders[0];
    const visible = f.frame(1);
    f.output(visible);
    assert.deepEqual(f.painted, [1]);
    assert.equal(visible.closed, 1);

    f.recv('opts', { minimized: true });
    if (kind === 'app') f.recv('status', { appFrame: 'capture-7' });
    f.recv('video', { key: true, pts: 123, data: Uint8Array.of(1) });
    f.recv('video', { key: false, pts: 124, data: Uint8Array.of(2) });
    const dropped = f.frame(2);
    f.output(dropped);
    assert.equal(decoder.chunks, undefined, `${kind}: minimized window does not decode`);
    assert.equal(dropped.closed, 1, `${kind}: a frame that still comes out is dropped`);
    assert.deepEqual(f.painted, [1], `${kind}: nothing new is painted`);
    assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [], `${kind}: no keyframe ask while minimized`);
    if (kind === 'app') assert.deepEqual(f.sent.filter((m) => m.t === 'appFrame'), []);

    f.recv('opts', { minimized: false });
    assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [{ t: 'resetVideo' }], `${kind}: restore asks for a keyframe now`);
    f.recv('video', { key: false, pts: 200, data: Uint8Array.of(3) });
    assert.equal(decoder.chunks, undefined, `${kind}: a delta after the gap is not decoded`);
    f.recv('video', { key: true, pts: 201, data: Uint8Array.of(4) });
    assert.deepEqual(decoder.chunks.map((chunk) => chunk.timestamp), [201]);
    const key = f.frame(9);
    f.output(key);
    assert.equal(f.painted.at(-1), 9, `${kind}: the keyframe is the next picture`);
    assert.equal(key.closed, 1);
    if (kind === 'app') assert.deepEqual(f.sent.filter((m) => m.t === 'appFrame'), [{ t: 'appFrame', capture: 'capture-7' }]);
  }
});

test('recording still paints while minimized, and a retired frame is not shown on restore', () => {
  const f = fixture();
  f.config();
  f.recv('opts', { minimized: true });
  f.record(true);
  f.recv('video', { key: true, pts: 5, data: Uint8Array.of(5) });
  assert.deepEqual(f.decoders[0].chunks.map((chunk) => chunk.timestamp), [5], 'a recording keeps decoding');
  const recording = f.frame(5);
  f.output(recording);
  assert.equal(f.painted.at(-1), 5);
  assert.equal(recording.closed, 1, 'recording consumes the canvas');
  f.record(false);

  const shot = fixture();
  shot.config();
  const shown = shot.frame(1);
  shot.output(shown);
  shot.recv('opts', { minimized: true });
  shot.recv('video', { key: true, pts: 8, data: Uint8Array.of(8) });
  shot.rail.controls.find((c) => c.k === 'shot').el.onclick();
  assert.deepEqual(shot.painted, [1], 'a screenshot while minimized does not decode a new frame');
  assert.equal(shot.controls.get('shot:after').at(-1), 1);

  f.config();
  const old = f.decoders.at(-1);
  const late = f.frame(2);
  old.callbacks.output(late);
  assert.equal(late.closed, 1, 'a frame from the decoder that was replaced is dropped');
  f.recv('status', { closed: 'stopped' });
  f.recv('opts', { minimized: false });
  const afterClose = f.frame(4);
  f.output(afterClose);
  assert.equal(afterClose.closed, 1);
  assert.ok(!f.painted.includes(4), 'restore cannot paint a frame from a capture that already closed');
  f.recv('opts', { minimized: true });
  const onUnload = f.frame(6);
  f.output(onUnload);
  f.events.get('beforeunload')();
  assert.equal(onUnload.closed, 1);
});

test('background throttling stays off, and every kind hears minimize', () => {
  const host = fs.readFileSync(path.join(__dirname, '../phoneview.js'), 'utf8');
  assert.match(host, /backgroundThrottling:\s*false/);
  assert.match(host, /if \(view\.win\.isMinimized\(\)\) view\.win\.restore\(\)/);
  assert.match(host, /win\.on\('minimize', tellMinimized\)/);
  assert.equal(host.includes("if (kind === 'app') this._send"), false);
});
