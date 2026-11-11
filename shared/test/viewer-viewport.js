// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function fixture(local = true, touch = 'direct') {
  const events = new Map(), docEvents = new Map(), videoEvents = new Map(), sent = [], timers = new Map();
  let now = 10000, timerId = 0;
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, addEventListener(k, fn) { videoEvents.set(k, fn); } };
  const ctx = { setTransform() {}, clearRect() {} };
  const nodes = { video, audio: {}, overlay: { classList: { toggle() {} } }, kbd: { value: '', addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(k, fn) { events.set(k, fn); },
    TD: { send: (m) => sent.push(JSON.parse(m)), ready() {}, playing() {}, haptic() {} } };
  const document = { hidden: false, getElementById: (id) => nodes[id], addEventListener(k, fn) { docEvents.set(k, fn); },
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ctx }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    window, document, console: { log() {} }, performance: { now: () => now },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id), requestAnimationFrame() {},
  });
  const pointer = (type, id, x, y, extra = {}) => events.get(type)({ pointerId: id, pointerType: 'touch', button: 0,
    clientX: x, clientY: y, preventDefault() {}, ...extra });
  const recv = (m) => window.tdRecv(m);
  recv({ t: 'opts', viewGestures: local, touch, tap: true });
  return { window, video, overlay: nodes.overlay, sent, pointer, events, recv, document, docEvents, videoEvents,
    hold() { now += 600; for (const fn of [...timers.values()]) fn(); timers.clear(); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function pinchPanAndControl() {
  const f = fixture();
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400); f.sent.length = 0;
  f.pointer('pointermove', 2, 800, 400);
  assert.strictEqual(f.video.style.transform, 'translate(100px, 0px) scale(2)');
  f.pointer('pointermove', 1, 450, 450); f.pointer('pointermove', 2, 850, 450);
  assert.strictEqual(f.video.style.transform, 'translate(150px, 50px) scale(2)');
  assert.deepStrictEqual(f.sent, [], 'two fingers only change the local view');
  f.pointer('pointerup', 1, 450, 450); f.pointer('pointerup', 2, 850, 450);
  f.pointer('pointerdown', 3, 500, 400); f.pointer('pointerup', 3, 500, 400);
  const click = f.sent.find((m) => m.t === 'in.md'); near(click.x, .425); near(click.y, 512.5 / 1125);
  f.sent.length = 0;
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 500, 400); f.pointer('pointerdown', 3, 600, 400); f.sent.length = 0;
  f.pointer('pointermove', 1, 400, 460);
  assert.deepStrictEqual(f.sent.map((m) => m.t), ['in.wh']); near(f.sent[0].dy, -40);
  const legacy = fixture(false);
  legacy.pointer('pointerdown', 1, 400, 400); legacy.pointer('pointerdown', 2, 600, 400); legacy.sent.length = 0;
  legacy.pointer('pointermove', 2, 620, 400);
  assert.strictEqual(legacy.sent[0].t, 'in.wh', 'non-target viewer retains two-finger scroll');
  const pad = fixture(true, 'pad');
  pad.pointer('pointerdown', 1, 400, 400); pad.pointer('pointerdown', 2, 600, 400); pad.pointer('pointermove', 2, 1200, 400);
  pad.pointer('pointerup', 1, 400, 400); pad.pointer('pointerup', 2, 1200, 400);
  pad.pointer('pointerdown', 1, 500, 400); pad.pointer('pointermove', 1, 950, 400);
  assert.ok(pad.video.style.transform.includes('scale(4)'), 'pinch clamps at 4x');
  const m = pad.sent.at(-1), pan = Number(/^translate\(([^p]+)/.exec(pad.video.style.transform)[1]);
  const cursorX = (1000 - 4000) / 2 + pan + m.x * 4000;
  assert.ok(cursorX >= 32 && cursorX <= 968, 'zoomed touchpad follows its cursor');
  const staggered = fixture();
  staggered.pointer('pointerdown', 1, 300, 400); staggered.pointer('pointerdown', 2, 500, 400);
  staggered.pointer('pointermove', 2, 540, 400); staggered.pointer('pointerdown', 3, 700, 400);
  staggered.sent.length = 0; staggered.pointer('pointermove', 3, 700, 460);
  assert.strictEqual(staggered.sent[0].t, 'in.wh', 'a slightly staggered three-finger swipe scrolls');
}
function cancellationAndBounds() {
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
  const f = fixture();
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointermove', 1, 440, 400);
  f.pointer('pointerdown', 2, 600, 400);
  assert.strictEqual(f.sent.filter((m) => m.t === 'in.mu').length, 1, 'second finger releases direct drag');
  f.sent.length = 0; f.pointer('pointermove', 2, 900, 400); f.pointer('pointerup', 2, 900, 400);
  f.pointer('pointermove', 1, 800, 600); f.hold(); f.pointer('pointerup', 1, 800, 600);
  assert.deepStrictEqual(f.sent, [], 'remaining finger cannot become a click or pointer');
  for (let id = 1; id <= 4; id++) f.pointer('pointerdown', id, 400 + id * 30, 400);
  f.sent.length = 0; f.pointer('pointermove', 1, 1000, 1000);
  for (let id = 1; id <= 4; id++) f.pointer('pointerup', id, 500, 400);
  assert.deepStrictEqual(f.sent, [], 'four-finger gesture is ignored');
  f.pointer('pointerdown', 1, 500, 400); f.pointer('pointercancel', 1, 500, 400); f.sent.length = 0; f.hold();
  assert.deepStrictEqual(f.sent, [], 'cancel does not click or fire hold');
  f.pointer('pointerdown', 1, 500, 400); f.pointer('pointerup', 1, 500, 400);
  assert.deepStrictEqual(f.sent.slice(-2).map((m) => m.t), ['in.md', 'in.mu'], 'next tap works');
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400); f.pointer('pointermove', 2, 1600, 400);
  f.window.innerWidth = 400; f.window.innerHeight = 1000; f.events.get('resize')();
  assert.ok(!f.video.style.transform.includes('NaN'), 'rotation clamps transform');
  f.video.videoWidth = 0; f.videoEvents.get('resize')();
  f.pointer('pointerdown', 1, 100, 400); f.pointer('pointerdown', 2, 300, 400); f.sent.length = 0; f.pointer('pointermove', 2, 390, 400);
  assert.deepStrictEqual(f.sent, []); assert.ok(!f.video.style.transform.includes('NaN'));
  const real = fixture(); real.recv({ t: 'screen.state', touch: true });
  real.pointer('pointerdown', 1, 500, 400); real.pointer('pointerup', 1, 500, 400);
  assert.deepStrictEqual(real.sent.map((m) => m.t), ['in.tc', 'in.tc'], 'real touch remains unchanged');
  const pen = fixture();
  pen.pointer('pointerdown', 1, 400, 400); pen.pointer('pointerdown', 2, 600, 400);
  pen.pointer('pointermove', 2, 800, 400);
  pen.pointer('pointermove', 9, 500, 400, { pointerType: 'pen', buttons: 0, pressure: 0 });
  pen.sent.length = 0;
  pen.pointer('pointermove', 1, 800, 600); pen.pointer('pointerup', 1, 800, 600); pen.pointer('pointerup', 2, 800, 400);
  assert.deepStrictEqual(pen.sent, [], 'pen proximity drops the prior finger gesture');
  const resize = fixture();
  resize.videoEvents.get('resize')();
  resize.pointer('pointerdown', 9, 500, 400, { pointerType: 'mouse' });
  resize.events.get('keydown')({ code: 'ShiftLeft', preventDefault() {} });
  resize.sent.length = 0; resize.video.videoWidth = 1280; resize.video.videoHeight = 720;
  resize.videoEvents.get('resize')();
  assert.deepStrictEqual(resize.sent, [], 'same-aspect video resize preserves held input');
  const offscreen = fixture(true, 'pad');
  offscreen.pointer('pointerdown', 1, 400, 400); offscreen.pointer('pointerdown', 2, 600, 400);
  offscreen.pointer('pointermove', 2, 1200, 400); offscreen.pointer('pointerup', 1, 400, 400); offscreen.pointer('pointerup', 2, 1200, 400);
  offscreen.pointer('pointerdown', 3, 500, 400); offscreen.pointer('pointerup', 3, 500, 400);
  const pos = Number(/^translate\(([^p]+)/.exec(offscreen.video.style.transform)[1]);
  assert.ok((-1500 + pos + 2000) >= 32 && (-1500 + pos + 2000) <= 968, 'tap brings the touchpad cursor into view');
}
pinchPanAndControl(); cancellationAndBounds();
console.log('viewer-viewport: gestures, input mapping, legacy behavior and cancellation passed');
