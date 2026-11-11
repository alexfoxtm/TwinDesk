// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function fixture() {
  const events = new Map(), sent = [];
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, addEventListener() {} };
  const ctx = { setTransform() {}, clearRect() {} };
  const nodes = { video, audio: {}, overlay: { classList: { toggle() {} } }, kbd: { value: '', addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(k, fn) { events.set(k, fn); },
    TD: { send: (m) => sent.push(JSON.parse(m)), ready() {}, playing() {}, haptic() {} } };
  const document = { getElementById: (id) => nodes[id], addEventListener() {},
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ctx }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    window, document, console: { log() {} }, performance: { now: () => 10000 },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
  });
  const pointer = (type, x, y, extra = {}) => events.get(type)({ pointerId: 1, pointerType: 'mouse', button: 0,
    clientX: x, clientY: y, preventDefault() {}, ...extra });
  return { window, video, sent, pointer, events, recv: (m) => window.tdRecv(m) };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

function zoomMoveAndControl() {
  const f = fixture();
  f.recv({ t: 'viewport', scale: 2, pan: true });
  f.pointer('pointerdown', 500, 400, { pointerType: 'touch' });
  f.pointer('pointermove', 600, 450, { pointerType: 'touch' });
  f.pointer('pointerup', 600, 450, { pointerType: 'touch' });
  assert.strictEqual(f.video.style.transform, 'translate(100px, 50px) scale(2)');
  assert.deepStrictEqual(f.sent, [], 'moving the view cannot inject Mac input');
  f.recv({ t: 'viewport', scale: 2, pan: false });
  f.pointer('pointerdown', 500, 400);
  f.pointer('pointerup', 500, 400);
  near(f.sent[0].x, 0.45); near(f.sent[0].y, 512.5 / 1125);
  assert.deepStrictEqual(f.sent.map((m) => m.t), ['in.md', 'in.mu']);
  f.recv({ t: 'viewport', scale: 3, pan: false });
  f.pointer('pointermove', 500, 400);
  near(f.sent.at(-1).x, 0.45); near(f.sent.at(-1).y, 512.5 / 1125);
  f.recv({ t: 'viewport', scale: 1, pan: false });
  assert.strictEqual(f.video.style.transform, 'translate(0px, 0px) scale(1)');
  f.pointer('pointermove', 500, 400);
  near(f.sent.at(-1).x, 0.5); near(f.sent.at(-1).y, 0.5);
}

function boundsAndCancelledInput() {
  const f = fixture();
  f.pointer('pointerdown', 500, 400);
  f.events.get('keydown')({ code: 'ShiftLeft', preventDefault() {} });
  f.recv({ t: 'viewport', scale: 2, pan: true });
  assert.deepStrictEqual(f.sent.map((m) => m.t), ['in.md', 'in.kd', 'in.mu', 'in.ku'], 'mode changes release held input');
  const count = f.sent.length;
  f.pointer('pointerdown', 500, 400);
  f.pointer('pointermove', 99999, 99999);
  f.pointer('pointercancel', 99999, 99999);
  const at = /^translate\(([^p]+)px, ([^p]+)px\) scale\(2\)$/.exec(f.video.style.transform);
  assert.ok(at, 'zoom remains fixed while panning');
  near(Number(at[1]), 500); near(Number(at[2]), 162.5);
  f.events.get('wheel')({ deltaX: -99999, deltaY: -99999, preventDefault() {} });
  f.events.get('keyup')({ code: 'ShiftLeft', preventDefault() {} });
  assert.strictEqual(f.sent.length, count, 'pan mode does not forward wheel, keys or pointer events');
  f.video.videoWidth = 0;
  f.recv({ t: 'viewport', scale: NaN, pan: true });
  f.pointer('pointerdown', 500, 400);
  assert.strictEqual(f.sent.length, count, 'no input before a picture exists');
  assert.strictEqual(f.video.style.transform, 'translate(0px, 0px) scale(1)');
}
zoomMoveAndControl();
boundsAndCancelledInput();
console.log('viewer-viewport: zoom/pan coordinates, fit, bounds and input isolation passed');
