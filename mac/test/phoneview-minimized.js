// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { TYPE } = require('../scrcpy.js');

const code = fs.readFileSync(path.join(__dirname, '../phoneview-renderer.js'), 'utf8');

function fixture(kind = 'app', { screenOS, actualRail = false, ipad = false } = {}) {
  const events = new Map(), handlers = new Map(), decoders = [], sent = [], painted = [], blanks = [], pushed = [], statusKeys = [];
  const controls = new Map(), previewDraws = [], pointers = new Map();
  const timers = [];
  let now = 5000;
  const canvas = {
    width: 100, height: 200, style: {}, focus() {}, addEventListener(name, fn) { pointers.set(name, fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 600 }),
    getContext: () => ({
      fillStyle: '',
      drawImage: (frame) => painted.push(frame.id),
      fillRect: () => blanks.push(`${canvas.width}x${canvas.height}`),
    }),
  };
  const element = (hidden = true) => ({
    hidden, style: {}, dataset: {}, children: [], classList: { add() {}, toggle() {} },
    setAttribute() {}, addEventListener(_name, fn) { this.click = fn; },
    append(...children) { this.children.push(...children); },
  });
  const nodes = { screen: canvas, stage: { clientWidth: 400, clientHeight: 800 }, status: element(), title: element() };
  const toolbar = element();
  const body = element();
  if (actualRail) {
    for (const k of ['back', 'home', 'recents', 'notifs', 'rotate', 'pin']) nodes[`b-${k}`] = element(false);
    const retryButton = element();
    nodes['retry-ipad'] = Object.assign(element(), { querySelector: () => retryButton, retryButton });
  }
  if (ipad) for (const id of ['ipad-controls', 'ipad-control', 'ipad-control-status']) nodes[id] = element();
  let recording = false;
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.resets = 0; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { this.chunks = (this.chunks || []).concat(chunk); }
    reset() { this.resets++; this.state = 'unconfigured'; }
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
    PlayerI18n: {
      translate() {},
      text(el, key) { if (el === nodes.status) statusKeys.push(key); },
      literal() {}, t: key => key, onChange() {},
    },
    addEventListener: (name, fn) => events.set(name, fn),
    MirrorRail: () => rail,
    CamOut: () => ({ push: (frame) => pushed.push(frame.id), onRotate() {} }),
  };
  function later(fn, ms) {
    const t = { fn, at: now + (ms || 0) };
    timers.push(t);
    return t;
  }
  function cancel(t) {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  }
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const t of timers) if (t.at <= end && (!next || t.at < next.at)) next = t;
      if (!next) break;
      now = next.at;
      timers.splice(timers.indexOf(next), 1);
      next.fn();
    }
    now = end;
  }
  const env = vm.createContext({
    window, document: { body, getElementById: key => nodes[key] || null, querySelector: () => toolbar, addEventListener() {},
      createElement: (name) => name !== 'canvas' ? element() : ({
        getContext: () => ({ drawImage: (frame, _x, _y, w, h) => previewDraws.push([frame.id, w, h]) }),
        toDataURL: () => 'data:image/jpeg;base64,/9j/2Q==',
      }) },
    location: { search: '?kind=' + kind + (screenOS ? '&screenOS=' + screenOS : '') + (ipad ? '&ipad=1' : '') }, URLSearchParams, devicePixelRatio: 2, VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data); } },
    ResizeObserver: class { observe() {} }, performance: { now: () => now }, console,
    setTimeout: later, clearTimeout: cancel,
  });
  if (actualRail) vm.runInContext(fs.readFileSync(require.resolve('../../shared/mirror-rail.js'), 'utf8'), env);
  if (ipad) vm.runInContext(fs.readFileSync(require.resolve('../phoneview-ipad-renderer.js'), 'utf8'), env);
  vm.runInContext(code, env);
  const recv = (name, value) => { for (const fn of handlers.get(name) || []) fn(value); };
  const config = () => recv('video', { config: true, data: Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0x1f]) });
  const frame = (id, timestamp) => ({ id, timestamp, displayWidth: 300, displayHeight: 600, closed: 0, close() { this.closed++; } });
  return { recv, config, frame, canvas, decoders, sent, painted, blanks, pushed, statusKeys, previewDraws, pointers, nodes, body, status: nodes.status, events, controls, rail, advance,
    record(on) { recording = on; }, output(f) { decoders.at(-1).callbacks.output(f); } };
}

test('a minimized app or screen does not decode, and the phone panel still goes dark', () => {
  for (const kind of ['app', 'screen']) {
    const f = fixture(kind);
    f.config();
    const decoder = f.decoders[0];
    const visible = f.frame(1, 1);
    f.output(visible);
    assert.deepEqual(f.painted, [1]);
    assert.equal(visible.closed, 1);

    f.recv('opts', { minimized: true });
    assert.equal(decoder.resets, 1, `${kind}: minimize drops frames already queued`);
    if (kind === 'app') f.recv('status', { appFrame: 'capture-7' });
    f.recv('video', { key: true, pts: 123, data: Uint8Array.of(1) });
    f.recv('video', { key: false, pts: 124, data: Uint8Array.of(2) });
    const dropped = f.frame(2, 124);
    f.output(dropped);
    assert.equal(decoder.chunks, undefined, `${kind}: minimized window does not decode`);
    assert.equal(dropped.closed, 1, `${kind}: a frame that still comes out is dropped`);
    assert.deepEqual(f.painted, [1], `${kind}: nothing new is painted`);
    assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [], `${kind}: no keyframe ask while minimized`);
    if (kind === 'app') {
      assert.deepEqual(f.sent.filter((m) => m.t === 'appFrame'), [{ t: 'appFrame', capture: 'capture-7' }], 'the phone panel goes dark without a decoded frame');
    }

    f.recv('opts', { minimized: false });
    assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [{ t: 'resetVideo' }], `${kind}: restore asks for a keyframe now`);
    assert.equal(f.statusKeys.at(-1), 'Waiting for the picture…', `${kind}: the stale picture is cleared like the first one`);
    assert.ok(f.blanks.length >= 1, `${kind}: the canvas is blank while that keyframe is due`);
    f.recv('video', { key: false, pts: 200, data: Uint8Array.of(3) });
    assert.equal(decoder.chunks, undefined, `${kind}: a delta after the gap is not decoded`);
    f.recv('video', { key: true, pts: 201, data: Uint8Array.of(4) });
    assert.deepEqual(decoder.chunks.map((chunk) => chunk.timestamp), [201]);
    const stale = f.frame(8, 50);
    f.output(stale);
    assert.equal(stale.closed, 1, `${kind}: a frame from before the keyframe is not painted`);
    const key = f.frame(9, 201);
    f.output(key);
    assert.equal(f.painted.at(-1), 9, `${kind}: the keyframe is the next picture`);
    assert.equal(key.closed, 1);
    if (kind === 'app') assert.deepEqual(f.sent.filter((m) => m.t === 'appFrame'), [{ t: 'appFrame', capture: 'capture-7' }]);
    f.advance(5000);
    assert.equal(f.sent.filter((m) => m.t === 'resetVideo').length, 1, `${kind}: asks stop once the keyframe is in`);
  }
});

test('a minimized camera keeps feeding the virtual camera and the Camera tab', () => {
  const f = fixture('camera');
  f.config();
  f.recv('video', { key: true, pts: 1, data: Uint8Array.of(1) });
  f.output(f.frame(1, 1));
  assert.deepEqual(f.painted, [1]);
  assert.deepEqual(f.pushed, [1]);

  f.recv('opts', { minimized: true });
  assert.equal(f.decoders[0].resets, 0, 'minimize does not reset the camera decoder');
  f.recv('video', { key: false, pts: 2, data: Uint8Array.of(2) });
  assert.deepEqual(f.decoders[0].chunks.map((chunk) => chunk.timestamp), [1, 2], 'a minimized camera still decodes');
  const next = f.frame(2, 2);
  f.output(next);
  assert.deepEqual(f.painted, [1, 2], 'the feed is the same path that paints');
  assert.deepEqual(f.pushed, [1, 2], 'the virtual camera and the Camera tab still get the frame');
  assert.equal(next.closed, 1);
  assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), []);

  f.recv('opts', { minimized: false });
  assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [], 'nothing was skipped, so restore does not wait');
  f.advance(5000);
  assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), []);
});

test('restore keeps asking while the keyframe has not arrived', () => {
  const f = fixture('screen');
  f.config();
  f.recv('video', { key: false, pts: 1, data: Uint8Array.of(1) });
  assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [{ t: 'resetVideo' }]);
  f.recv('opts', { minimized: true });
  f.recv('opts', { minimized: false });
  assert.equal(f.sent.filter((m) => m.t === 'resetVideo').length, 1, 'the restore ask is inside the one-second throttle');
  f.advance(999);
  assert.equal(f.sent.filter((m) => m.t === 'resetVideo').length, 1);
  f.advance(1);
  assert.equal(f.sent.filter((m) => m.t === 'resetVideo').length, 2, 'asks again once the throttle allows');
  f.advance(1000);
  assert.equal(f.sent.filter((m) => m.t === 'resetVideo').length, 3);
  f.recv('video', { key: true, pts: 40, data: Uint8Array.of(4) });
  f.output(f.frame(4, 40));
  f.advance(5000);
  assert.equal(f.sent.filter((m) => m.t === 'resetVideo').length, 3, 'stops once decoding resumes');

  const again = fixture('screen');
  again.config();
  again.recv('opts', { minimized: true });
  again.recv('opts', { minimized: false });
  again.recv('opts', { minimized: true });
  again.advance(5000);
  assert.equal(again.sent.filter((m) => m.t === 'resetVideo').length, 1, 'minimized again: stop asking');

  const closed = fixture('screen');
  closed.config();
  closed.recv('opts', { minimized: true });
  closed.recv('opts', { minimized: false });
  closed.recv('status', { closed: 'stopped' });
  closed.advance(5000);
  assert.equal(closed.sent.filter((m) => m.t === 'resetVideo').length, 1, 'closed: stop asking');

  const ended = fixture('screen');
  ended.config();
  ended.recv('status', { closed: 'stopped' });
  ended.recv('opts', { minimized: true });
  const asked = ended.sent.filter((m) => m.t === 'resetVideo').length;
  const said = ended.statusKeys.length;
  ended.recv('opts', { minimized: false });
  ended.advance(5000);
  assert.equal(ended.sent.filter((m) => m.t === 'resetVideo').length, asked, 'a capture that closed is not asked for a keyframe on restore');
  assert.equal(ended.statusKeys.length, said, 'and its message stays instead of "Waiting for the picture"');
  ended.config();
  ended.recv('opts', { minimized: true });
  ended.recv('opts', { minimized: false });
  assert.equal(ended.sent.filter((m) => m.t === 'resetVideo').length, asked + 1, 'a new capture is asked again');

  const failed = fixture('screen');
  failed.config();
  failed.decoders.at(-1).callbacks.error(new Error('refused'));
  failed.advance(0);
  const first = failed.sent.filter((m) => m.t === 'resetVideo').length;
  failed.advance(3000);
  assert.ok(failed.sent.filter((m) => m.t === 'resetVideo').length >= first + 2, 'a decoder that failed keeps asking until a keyframe is in');
  for (let i = 0; i < 8; i++) {
    failed.decoders.at(-1).callbacks.error(new Error('refused'));
    failed.advance(0);
  }
  failed.advance(2000);
  const gaveUp = failed.sent.filter((m) => m.t === 'resetVideo').length;
  failed.advance(10000);
  assert.equal(failed.sent.filter((m) => m.t === 'resetVideo').length, gaveUp, 'a stream that keeps failing is not asked forever');

  const prompt = fixture('screen');
  prompt.config();
  prompt.recv('status', { error: 'Wake and unlock the phone' });
  prompt.recv('video', { key: true, data: Uint8Array.from([0, 0, 1, 0x65]) });
  prompt.recv('opts', { minimized: true });
  const before = prompt.sent.filter((m) => m.t === 'resetVideo').length;
  prompt.advance(2000);
  prompt.recv('opts', { minimized: false });
  assert.equal(prompt.sent.filter((m) => m.t === 'resetVideo').length, before + 1, 'a capture that went on after a prompt is asked for a keyframe on restore');
});

test('restore waits for a keyframe only when frames were skipped', () => {
  const f = fixture('screen');
  f.config();
  f.record(true);
  f.recv('video', { key: true, pts: 1, data: Uint8Array.of(1) });
  f.output(f.frame(1, 1));
  f.recv('opts', { minimized: true });
  f.recv('video', { key: false, pts: 2, data: Uint8Array.of(2) });
  assert.deepEqual(f.decoders[0].chunks.map((chunk) => chunk.timestamp), [1, 2], 'recording keeps decoding while minimized');
  assert.equal(f.decoders[0].resets, 0, 'recording does not drop the decoder');
  f.recv('opts', { minimized: false });
  assert.deepEqual(f.sent.filter((m) => m.t === 'resetVideo'), [], 'nothing was skipped, so the picture is not held for a keyframe');
  assert.equal(f.blanks.length, 0);
});

test('recording still paints while minimized, and a retired frame is not shown on restore', () => {
  const f = fixture();
  f.config();
  f.recv('opts', { minimized: true });
  f.record(true);
  f.recv('video', { key: true, pts: 5, data: Uint8Array.of(5) });
  assert.deepEqual(f.decoders[0].chunks.map((chunk) => chunk.timestamp), [5], 'a recording keeps decoding');
  const recording = f.frame(5, 5);
  f.output(recording);
  assert.equal(f.painted.at(-1), 5);
  assert.equal(recording.closed, 1, 'recording consumes the canvas');
  f.record(false);

  const shot = fixture();
  shot.config();
  const shown = shot.frame(1, 1);
  shot.output(shown);
  shot.recv('opts', { minimized: true });
  shot.recv('video', { key: true, pts: 8, data: Uint8Array.of(8) });
  shot.rail.controls.find((c) => c.k === 'shot').el.onclick();
  assert.deepEqual(shot.painted, [1], 'a screenshot while minimized does not decode a new frame');
  assert.equal(shot.controls.get('shot:after').at(-1), 1);

  f.config();
  const old = f.decoders.at(-1);
  const late = f.frame(2, 2);
  old.callbacks.output(late);
  assert.equal(late.closed, 1, 'a frame from the decoder that was replaced is dropped');
  f.recv('status', { closed: 'stopped' });
  f.recv('opts', { minimized: false });
  const afterClose = f.frame(4, 4);
  f.output(afterClose);
  assert.equal(afterClose.closed, 1);
  assert.ok(!f.painted.includes(4), 'restore cannot paint a frame from a capture that already closed');
  f.recv('opts', { minimized: true });
  const onUnload = f.frame(6, 6);
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

test('a terminal status clears pending app frames and ignores late requests until a capture is live', () => {
  for (const terminal of [{ closed: 'stopped' }, { error: 'connection failed' }]) {
    const f = fixture();
    f.config();
    f.recv('status', { appFrame: 'queued while visible' });
    f.recv('status', { ...terminal, appFrame: 'with terminal status' });
    f.recv('opts', { minimized: true });
    f.recv('status', { ...terminal, appFrame: 'with terminal status while minimized' });
    f.recv('status', { appFrame: 'after terminal status' });
    assert.deepEqual(f.sent.filter((m) => m.t === 'appFrame'), []);

    f.recv('status', { ready: true, appFrame: 'new capture' });
    assert.deepEqual(f.sent.filter((m) => m.t === 'appFrame'), [{ t: 'appFrame', capture: 'new capture' }]);
  }
});

function appStartup(dark, adb = null) {
  const name = require.resolve('../phoneview.js');
  const localRequire = createRequire(name);
  const module = { exports: {} };
  const launches = [];
  let delay, lease = {};
  let unlock = () => Promise.resolve(true);
  class Session extends EventEmitter {
    start() {
      if (adb) this.log = ['New display: 1080x2400/440 (id=12)'];
      return Promise.resolve();
    }
    startApp() { launches.push(this); }
    stop() { this.closed = true; }
    tap() {}
  }
  vm.runInNewContext(fs.readFileSync(name, 'utf8'), {
    module, process, __dirname: path.dirname(name),
    require(request) {
      if (request === 'electron') return { app: { on() {} } };
      if (request === './scrcpy') return { Session, TYPE };
      if (request === './dockstub') return {};
      return localRequire(request);
    },
    setTimeout(resolve, ms) {
      assert.equal(ms, 300);
      delay = resolve;
    },
  });
  const view = { id: 1, app: 'io.example.app', kind: 'app', win: { isDestroyed: () => false } };
  const views = Object.assign(Object.create(module.exports.PhoneViews.prototype), {
    bridge: { serial: 'adb-phone', adb },
    phone: { info: { maker: adb ? 'Xiaomi' : 'Samsung' } },
    views: new Map([[view.id, view]]),
    appPanel: {
      capture: () => null,
      begin: () => lease,
      owns: (panel) => panel === lease,
      waitUnlocked: () => unlock(),
      waitForApp: async () => false,
    },
    getSettings: () => ({ phone: { keepPanelOff: dark } }),
    _send() {},
  });
  return {
    view, views, launches,
    start: () => views._start(view, {}),
    finishDelay: () => delay(),
    waitForUnlock: () => new Promise((resolve) => { unlock = () => new Promise((done) => resolve(done)); }),
    releaseLease: () => { lease = null; },
  };
}

test('app startup cleans up the session when the view or lease is retired after start', async () => {
  const ending = appStartup(false);
  const end = ending.start();
  await new Promise(setImmediate);
  ending.view.ending = true;
  ending.finishDelay();
  await end;
  assert.equal(ending.view.session.closed, true);
  assert.deepEqual(ending.launches, []);

  const locked = appStartup(true);
  const revoke = locked.start();
  await new Promise(setImmediate);
  assert.equal(locked.view.started, true);
  const waiting = locked.waitForUnlock();
  locked.finishDelay();
  const finishUnlock = await waiting;
  locked.releaseLease();
  finishUnlock(false);
  await revoke;
  assert.equal(locked.view.session.closed, true);
  assert.deepEqual(locked.launches, []);

  const live = appStartup(true);
  const open = live.start();
  await new Promise(setImmediate);
  live.finishDelay();
  await open;
  assert.deepEqual(live.launches, [live.view.session]);
  assert.equal(live.view.session.closed, undefined);
});

test('app startup cleans up if the dark lease is lost during HyperOS activity lookup', async () => {
  const calls = [];
  let answer;
  const activity = new Promise((resolve) => { answer = resolve; });
  const f = appStartup(true, {
    shell(_, command) { calls.push(command); return activity; },
  });
  const opened = f.start();
  await new Promise(setImmediate);
  f.finishDelay();
  await new Promise(setImmediate);
  assert.match(calls[0], /^cmd package resolve-activity/);
  f.releaseLease();
  answer({ code: 0, out: 'io.example.app/.Main' });
  await opened;
  assert.equal(calls.length, 1, 'the revoked activity was never started');
  assert.deepEqual(f.launches, []);
  assert.equal(f.view.session.closed, true, 'the unused virtual display must stop');
});

test('unlock resumes panel blanking when no video preceded the app-frame request', async () => {
  const renderer = fixture();
  const { view, views } = appStartup(true);
  view.panelLease = views.appPanel.begin();
  view.session = {
    scid: 'resumed capture',
    videoStarted: true,
    simple(type) {
      assert.equal(type, TYPE.RESET_VIDEO);
      assert.deepEqual(renderer.sent.filter((m) => m.t === 'appFrame'), []);
      renderer.recv('video', { key: true, pts: 8, data: Uint8Array.of(8) });
      renderer.output(renderer.frame(8, 8));
    },
  };
  renderer.config();
  views._send = (_view, channel, status) => {
    assert.equal(channel, 'phoneview:status');
    renderer.recv('status', status);
  };
  views.appPanel.retry = () => {};
  views.appPanel.waitUnlocked = async (_panel, _live, waiting) => {
    waiting();
    return true;
  };
  views.appPanel.waitForApp = async () => true;
  await views._resumeDarkApp(view);
  assert.deepEqual(renderer.painted, [8]);
  assert.deepEqual(renderer.sent.filter((m) => m.t === 'appFrame'), [{ t: 'appFrame', capture: 'resumed capture' }]);
});

test('the preview reuses decoded frames and samples once per interval while the capture is live', () => {
  const f = fixture('screen');
  f.recv('opts', { mirrorPreview: 8 });
  f.config();
  f.output(f.frame(1, 1));
  f.output(f.frame(2, 2));
  f.advance(4000);
  f.output(f.frame(3, 3));
  f.recv('status', { closed: 'stopped' });
  f.advance(4000);
  f.output(f.frame(4, 4));
  assert.deepEqual(f.previewDraws, [[1, 100, 200], [3, 100, 200]]);
  assert.deepEqual(f.sent.filter((m) => m.t === 'mirrorPreview').map((m) => m.capture), [8, 8]);
});

test('iOS rail keeps local tools and removes legacy phone inputs, while Android keeps its controls', () => {
  const ipad = fixture('screen', { screenOS: 'ios', actualRail: true });
  const android = fixture('screen', { actualRail: true });
  const keys = (f) => f.body.children.find((n) => n.id === 'rail').children.map((b) => b.dataset.k);
  assert.deepEqual(keys(ipad), ['shot', 'rec']);
  assert.deepEqual(keys(android), ['shot', 'rec', 'volumeUp', 'volumeDown', 'rotate', 'autoRotate', 'power', 'screenOff']);
  for (const id of ['b-back', 'b-home', 'b-recents', 'b-notifs', 'b-rotate']) {
    assert.equal(ipad.nodes[id].hidden, true);
    assert.equal(android.nodes[id].hidden, false);
  }
  assert.equal(ipad.pointers.has('pointerdown'), false);
  assert.equal(android.pointers.has('pointerdown'), true);
  let prevented = false;
  const key = { code: 'Tab', type: 'keydown', preventDefault() { prevented = true; } };
  ipad.events.get('keydown')(key);
  assert.equal(prevented, false, 'Tab moves through the local controls');
  android.events.get('keydown')(key);
  assert.equal(prevented, true);
  assert.equal(android.sent.at(-1).t, 'key');
  assert.equal(ipad.sent.length, 0);
  ipad.nodes['b-pin'].onclick();
  ipad.recv('status', { error: 'Declined', retryIpad: true });
  const retry = ipad.nodes['retry-ipad'];
  assert.equal(retry.hidden, false);
  retry.retryButton.click();
  assert.deepEqual(ipad.sent, [{ t: 'pin' }, { t: 'retryIpad' }]);
});

test('iPad control waits for a freshly painted frame after a minimized gap', () => {
  const f = fixture('screen', { screenOS: 'ios', actualRail: true, ipad: true });
  f.recv('opts', { ipadState: 'connected', ipadGeneration: 'lease', mirrorPreview: 11 });
  f.recv('size', { width: 300, height: 600 });
  f.config();
  const home = () => f.pointers.get('pointerdown')({ button: 1, clientX: 20, clientY: 20 });
  const inputs = () => f.sent.filter((m) => m.t === 'ipadInput');
  home();
  assert.deepEqual(inputs(), []);
  f.recv('video', { key: true, pts: 1, data: Uint8Array.of(1) });
  f.output(f.frame(1, 1));
  home();
  assert.deepEqual(inputs(), [{ t: 'ipadInput', op: 'home', generation: 'lease' }]);
  assert.equal(f.sent.find((m) => m.t === 'mirrorPreview')?.capture, 11);
  f.recv('opts', { minimized: true });
  f.recv('opts', { minimized: false });
  f.recv('video', { key: true, pts: 2, data: Uint8Array.of(1) });
  home();
  assert.equal(inputs().length, 1, 'the accepted keyframe has yet to paint');
  f.output(f.frame(2, 2));
  home();
  assert.equal(inputs().length, 2);
  assert.equal(f.sent.some((m) => m.t === 'nav' || m.t === 'touch'), false);
});
