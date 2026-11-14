// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mixed-version Accessibility pinch. Run: node shared/test/pinch-compat.js
// Fork c49da681 sends phone.in z as normalized x,y plus v when it sees input.pinch.
// Upstream sends pixel x,y plus from,to,vert and does not advertise that capability.
'use strict';
const assert = require('node:assert/strict');
const { Pinch } = require('../pinch.js');
const { PhoneInput } = require('../phoneinput.js');
const { CAP_LEGACY, CAP_STROKE, pinchDialect, classifyPinch } = require('../pinchwire.js');
const T = require('../protocol.js').T;

const d = { w: 1080, h: 2400, dpi: 420 };
const at = { x: 540, y: 1200, buttons: 0 };
const timers = new Map();
let nextId = 0;
const origSet = global.setTimeout;
const origClear = global.clearTimeout;
global.setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
function fire(ms) {
  for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
}

function input(caps) {
  const sent = [];
  const peer = { caps };
  const ctl = new PhoneInput((m) => sent.push(m), () => peer);
  return { sent, ctl, peer };
}

function keys(msg) {
  return Object.keys(msg).sort();
}

try {
  assert.equal(CAP_LEGACY, 'input.pinch');
  assert.equal(CAP_STROKE, 'input.pinch.stroke');
  assert.equal(pinchDialect({ caps: ['mirror.native', 'input.pinch'] }), 'legacy', 'input.pinch alone is the fork dialect');
  assert.equal(pinchDialect({ caps: ['input.pinch', 'input.pinch.stroke'] }), 'stroke', 'the additive cap is the pixel dialect');
  assert.equal(pinchDialect({ caps: ['input.pinch.stroke'] }), 'stroke');
  assert.equal(pinchDialect({ caps: ['mirror.native'] }), 'stroke', 'upstream advertises no pinch cap and speaks pixels');
  assert.equal(pinchDialect({ caps: [] }), 'stroke');
  assert.equal(pinchDialect(null), 'stroke');
  assert.equal(pinchDialect({ caps: ['input.pinch', 7, null] }), 'legacy');

  assert.equal(classifyPinch({ a: 'z', x: 0.5, y: 0.5, v: 0.3 }), 'legacy');
  assert.equal(classifyPinch({ a: 'z', x: 1, y: 2, from: 100, to: 180, vert: 1 }), 'stroke', 'a small pixel is not a normalized pinch');
  assert.equal(classifyPinch({ a: 'z', x: 540, y: 1200, from: 100, to: 180, vert: 0 }), 'stroke');
  assert.equal(classifyPinch({ a: 'z', x: 0.5, y: 0.5, v: 0.3, from: 10, to: 20, vert: 1 }), 'reject', 'both dialects on one message');
  assert.equal(classifyPinch({ a: 'z', x: 1, y: 2, from: 10 }), 'reject', 'from without to');
  assert.equal(classifyPinch({ a: 'z', x: 1, y: 2, vert: 1 }), 'reject');
  assert.equal(classifyPinch({ a: 'z', x: 1, y: 2, v: 0.2, vert: 1 }), 'reject');
  assert.equal(classifyPinch({ a: 'z', x: 1, y: 2 }), 'reject');
  assert.equal(classifyPinch(null), 'reject');

  { // new Mac, old fork Android: normalized x,y plus one summed v. No pixel fields.
    const { sent, ctl } = input(['mirror.native', 'input.pinch']);
    const p = new Pinch();
    p.feed(ctl, { g: 'zoom', phase: 'begin', v: 0 }, at, d);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.1 }, at, d);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.2 }, at, d);
    assert.equal(sent.length, 0, 'legacy gathers for 180 ms');
    assert.equal(p.active, true);
    p.feed(ctl, { g: 'zoom', phase: 'end', v: 0 }, at, d);
    assert.equal(sent.length, 0, 'end does not drop or send the fork batch early');
    fire(180);
    assert.equal(sent.length, 1);
    const z = sent[0];
    assert.equal(classifyPinch(z), 'legacy');
    assert.deepEqual(keys(z), ['a', 't', 'v', 'x', 'y']);
    assert.equal(z.t, T.PHONE_IN);
    assert.equal(z.a, 'z');
    assert.equal(z.x, 0.5);
    assert.equal(z.y, 0.5);
    assert.ok(Math.abs(z.v - 0.3) < 1e-9);
    assert.equal('from' in z, false);
    assert.equal('vert' in z, false);
  }

  { // summed v clamps, and a point off the screen stays inside 0..1
    const { sent, ctl } = input(['input.pinch']);
    const p = new Pinch();
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.8 }, { x: -20, y: 9000, buttons: 0 }, d);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.8 }, { x: -20, y: 9000, buttons: 0 }, d);
    fire(180);
    assert.equal(sent[0].v, 1);
    assert.equal(sent[0].x, 0);
    assert.equal(sent[0].y, 1);
    sent.length = 0;
    p.feed(ctl, { g: 'zoom', phase: 'change', v: -0.8 }, at, d);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: -0.8 }, at, d);
    fire(180);
    assert.equal(sent[0].v, -1);
  }

  function stroke(caps, label) {
    const { sent, ctl } = input(caps);
    const p = new Pinch();
    p.feed(ctl, { g: 'zoom', phase: 'begin', v: 0 }, at, d);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.2 }, at, d);
    p.feed(ctl, { g: 'zoom', phase: 'end', v: 0 }, at, d);
    assert.equal(sent.length, 1, label);
    const z = sent[0];
    assert.equal(classifyPinch(z), 'stroke', label);
    assert.deepEqual(keys(z), ['a', 'from', 't', 'to', 'vert', 'x', 'y'], label);
    assert.equal(z.a, 'z');
    assert.equal(z.vert, 1, label);
    assert.equal('v' in z, false, label);
    assert.ok(z.to > z.from, label);
    assert.equal(z.x, Math.round(z.x));
  }
  // new Mac with this Android, and with upstream Android (no pinch cap): the pixel message, unchanged.
  stroke(['mirror.native', 'input.pinch', 'input.pinch.stroke'], 'new Android');
  stroke(['input.pinch.stroke'], 'stroke cap alone');
  stroke(['mirror.native'], 'upstream Android');
  stroke(undefined, 'no pinch capability: pixel stroke, including before phone.info arrives');

  { // failure: a click drops the pending fork pinch, and the rest of that gesture does not start another
    timers.clear();
    for (const path of ['../../mac/phone-bridge', '../../mac/mesh/phone-bridge']) {
      const { PhoneBridge } = require(path);
      const sent = [];
      const b = Object.create(PhoneBridge.prototype);
      b.phone = { info: { caps: ['mirror.native', 'input.pinch'], display: d } };
      b.input = new PhoneInput((m) => sent.push(m), () => b.phone.info);
      b.phoneInput = true;
      b.control = null;
      b.getSettings = () => ({ phone: { input: 'phone' } });
      b.kvm = { x: 540, y: 1200, buttons: 0, mouse: true };
      b._display = () => d;
      b._move = () => { throw new Error(`${path}: move during pinch`); };
      b._wheel = () => { throw new Error(`${path}: wheel during pinch`); };
      b._button = () => {};
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.25 });
      assert.equal(b.pinch.active, true, path);
      b.handle({ t: T.K_MOVE, dx: 3 });
      b.handle({ t: T.K_DOWN, b: 0 });
      fire(180);
      assert.equal(sent.length, 0, `${path}: an interrupted fork pinch is not sent`);
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.25 });
      fire(180);
      assert.equal(sent.length, 0, `${path}: the rest of the gesture does not plant a new pinch`);
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'begin', v: 0.25 });
      fire(180);
      assert.equal(sent.length, 1, path);
      assert.equal(classifyPinch(sent[0]), 'legacy', path);
      assert.equal(sent[0].x, 0.5, path);
    }
  }

  { // failure: nothing to place, a closed session, and a button held send no phone.in
    timers.clear();
    const { sent, ctl } = input(['input.pinch']);
    const p = new Pinch();
    ctl.pinchLegacy(1, 2, 0, 10, 0.2);
    ctl.pinchLegacy(1, 2, 10, 10, 0);
    ctl.pinchLegacy(NaN, 2, 10, 10, 0.2);
    assert.equal(ctl.pinching, false);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.2 }, { ...at, buttons: 1 }, d);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.2 }, at, { w: 0, h: 2400 });
    assert.equal(sent.length, 0);
    p.feed(ctl, { g: 'zoom', phase: 'change', v: 0.2 }, at, d);
    ctl.closed = true;
    fire(180);
    assert.equal(sent.length, 0, 'a closed session drops the gathered fork pinch');
    ctl.closed = false;
    ctl.stop();
    assert.equal(timers.size, 0, 'stop cancels a pending fork pinch');
  }

  { // main: an Accessibility stroke continues across batch flushes. A click before any pinch does not block one.
    timers.clear();
    for (const path of ['../../mac/phone-bridge', '../../mac/mesh/phone-bridge']) {
      const { PhoneBridge } = require(path);
      const sent = [];
      const b = Object.create(PhoneBridge.prototype);
      b.phone = { info: { caps: ['mirror.native'], display: d } };
      b.input = new PhoneInput((m) => sent.push(m), () => b.phone.info);
      b.phoneInput = true;
      b.control = null;
      b.getSettings = () => ({ phone: { input: 'phone' } });
      b.kvm = { x: 540, y: 1200, buttons: 0, mouse: true };
      b._display = () => d;
      b._move = () => {};
      b._wheel = () => {};
      b._button = () => {};
      b._key = () => {};
      b._take = () => {};
      b._kvmEnd = () => {};
      b.handle({ t: T.K_DOWN, b: 0 });
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.2 });
      fire(150);
      assert.equal(sent.length, 1, `${path}: a click before the gesture does not block it`);
      assert.equal(classifyPinch(sent[0]), 'stroke', path);
      assert.equal(b.pinch.active, false, `${path}: the batch flush leaves the fingers up`);
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.2 });
      fire(150);
      assert.equal(sent.length, 2, `${path}: the next sample of the same gesture still pinches`);
    }
  }

  { // failure: after the flush, active is false, but click, key, take, and release still block leftovers
    timers.clear();
    const interrupts = [
      ['click', { t: T.K_DOWN, b: 0 }],
      ['key', { t: T.K_KEY_DOWN, code: 'KeyA' }],
      ['take', { t: T.KVM_TAKE }],
      ['release', { t: T.KVM_RELEASE }],
    ];
    for (const path of ['../../mac/phone-bridge', '../../mac/mesh/phone-bridge']) {
      for (const [name, interrupt] of interrupts) {
        timers.clear();
        const { PhoneBridge } = require(path);
        const sent = [];
        const seen = [];
        const b = Object.create(PhoneBridge.prototype);
        b.phone = { info: { caps: ['mirror.native'], display: d } };
        b.input = new PhoneInput((m) => sent.push(m), () => b.phone.info);
        b.phoneInput = true;
        b.control = null;
        b.getSettings = () => ({ phone: { input: 'phone' } });
        b.kvm = { x: 540, y: 1200, buttons: 0, mouse: true };
        b._display = () => d;
        b._move = () => seen.push('move');
        b._wheel = () => seen.push('wheel');
        b._button = () => {};
        b._key = () => {};
        b._take = () => {};
        b._kvmEnd = () => {};
        b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.2 });
        fire(150);
        assert.equal(sent.length, 1, `${path} ${name}: the first batch is sent`);
        assert.equal(b.pinch.active, false, `${path} ${name}: active is false between batches`);
        b.handle({ t: T.K_MOVE, dx: 2 });
        b.handle({ t: T.K_WHEEL, dy: -20 });
        assert.deepEqual(seen, ['move', 'wheel'], `${path} ${name}: pointer and wheel are not held between batches`);
        b.handle(interrupt);
        b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.2 });
        fire(150);
        assert.equal(sent.length, 1, `${path} ${name}: a leftover change does not plant another stroke`);
        b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'begin', v: 0 });
        b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'change', v: 0.2 });
        fire(150);
        assert.equal(sent.length, 2, `${path} ${name}: the next begin pinches again`);
        assert.equal(classifyPinch(sent[1]), 'stroke', path);
      }
    }
  }

  { // main: map pan still drags when the pinch fingers are up, including while a gesture is open between batches
    timers.clear();
    for (const path of ['../../mac/phone-bridge', '../../mac/mesh/phone-bridge']) {
      const { PhoneBridge } = require(path);
      const touches = [];
      const b = Object.create(PhoneBridge.prototype);
      b.control = { closed: false, touch: (...args) => touches.push(args), scroll() {}, mouse() {}, tap() {} };
      b.phoneInput = true;
      b.phone = { info: { display: d, caps: ['mirror.native'] } };
      b.input = new PhoneInput(() => {}, () => b.phone.info);
      b.getSettings = () => ({ phone: { input: 'adb' }, kvm: {} });
      b.views = { activeApp: 'com.google.android.apps.maps', multipleApps: false };
      b.kvm = { x: 540, y: 1200, buttons: 0, mouse: true };
      b._display = () => d;
      b._move = () => {};
      b._button = () => {};
      b._key = () => {};
      b._take = () => {};
      b._kvmEnd = () => {};
      const panDowns = () => touches.filter((t) => t[0] === 0 && t[1] === 2).length;
      b.handle({ t: T.K_WHEEL, dx: 0, dy: -20 });
      assert.equal(panDowns(), 1, `${path}: map pan plants a finger`);
      const mid = touches.length;
      b.nativePinchOpen = true;
      b.handle({ t: T.K_WHEEL, dx: 40, dy: 0 });
      assert.ok(touches.length > mid, `${path}: map pan keeps moving between batches`);
      b.nativePinchOpen = false;
      if (b.pan) b.pan.end();
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'begin', v: 0.15 });
      const held = touches.length;
      b.handle({ t: T.K_WHEEL, dx: 0, dy: -20 });
      assert.equal(touches.length, held, `${path}: the wheel waits while the pinch fingers are down`);
      b.handle({ t: T.K_GESTURE, g: 'zoom', phase: 'end', v: 0 });
      b.handle({ t: T.K_WHEEL, dx: 0, dy: -20 });
      assert.equal(panDowns(), 2, `${path}: map pan resumes after the pinch`);
    }
  }

  console.log('pinch-compat: fork and upstream Accessibility pinch passed');
} finally {
  global.setTimeout = origSet;
  global.clearTimeout = origClear;
}
