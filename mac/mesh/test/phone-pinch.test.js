// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: the same pinch gating as mac/phone-bridge.js, in mac/mesh/phone-bridge.js
// (PhoneBridge.handle and _gesture). The only dialect is upstream's stroke pinch
// (shared/pinch.js, PhoneInput.pinch). While the fingers are down, move and the wheel
// are not delivered. A click, a button release, a key, take, or kvm release lifts them
// and blocks leftover phase 'change' samples until the next begin. That block also holds
// in the gap after the 150 ms Accessibility flush, when the fingers are already up.
// Maps pan keeps moving in that gap: the wheel is held only while the fingers are down.
// Run with: node --test mac/mesh/test/phone-pinch.test.js
'use strict';

const assert = require('node:assert/strict');
const os = require('os');
const Module = require('module');
const { test } = require('node:test');

// electron: only if a module asks while PhoneBridge loads (app.getPath). Nothing is written.
const electronStub = new Proxy(function stub() {}, {
  get(t, key) {
    if (key === Symbol.toPrimitive) return () => '';
    if (key === 'then') return undefined;
    if (key === 'getPath') return () => os.tmpdir();
    return electronStub;
  },
  apply() { return electronStub; },
  construct() { return electronStub; },
});
const realLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') return electronStub;
  return realLoad.apply(this, arguments);
};

const P = require('../../../shared/protocol.js');
const { KeyState } = require('../../android-keys');
const { PhoneInput } = require('../../../shared/phoneinput.js');
const { PhoneBridge } = require('../phone-bridge.js');

test.after(() => { Module._load = realLoad; });

const T = P.T;
const D = { w: 1080, h: 2400, dpi: 420 };
const PINCH_MS = 150;

// What would otherwise keep a later sample from planting, apart from the block itself.
const INTERRUPTS = [
  { name: 'click', msg: { t: T.K_DOWN, b: 0 }, excuse: 'up' },
  { name: 'button release', msg: { t: T.K_UP, b: 0 }, excuse: null },
  { name: 'key down', msg: { t: T.K_KEY_DOWN, code: 'KeyA' }, excuse: null },
  { name: 'key up', msg: { t: T.K_KEY_UP, code: 'KeyA' }, excuse: null },
  { name: 'kvm take', msg: { t: T.KVM_TAKE, route: 'phone', side: 'left', offset: 0.5 }, excuse: null },
  { name: 'kvm release', msg: { t: T.KVM_RELEASE }, excuse: 'take' },
];

function withTimers(run) {
  const timers = new Map();
  let nextId = 0;
  const origSet = global.setTimeout;
  const origClear = global.clearTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    const id = ++nextId;
    timers.set(id, { fn, ms, args });
    return id;
  };
  global.clearTimeout = (id) => { timers.delete(id); };
  const fire = (ms) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms === ms) {
        timers.delete(id);
        timer.fn(...timer.args);
      }
    }
  };
  try { return run(fire); }
  finally {
    global.setTimeout = origSet;
    global.clearTimeout = origClear;
  }
}

function recordInput(sent) {
  const input = new PhoneInput((m) => sent.push(m));
  const mice = [];
  const scrolls = [];
  const mouse = input.mouse.bind(input);
  const scroll = input.scroll.bind(input);
  input.mouse = (...args) => { mice.push(args); return mouse(...args); };
  input.scroll = (...args) => { scrolls.push(args); return scroll(...args); };
  return { input, mice, scrolls };
}

function harness(opt = {}) {
  const sent = [];
  const touches = [];
  const controlMice = [];
  const controlScrolls = [];
  const { input, mice: phoneMice, scrolls: phoneScrolls } = recordInput(sent);
  const control = {
    closed: false,
    touch: (...args) => touches.push(args),
    scroll: (...args) => controlScrolls.push(args),
    mouse: (...args) => controlMice.push(args),
    key: () => {},
    tap: () => {},
    backOrScreenOn: () => {},
  };
  // viaPhone is settings.phone.input === 'phone' (a getter). Accessibility gathers a stroke;
  // anything else keeps the control channel, which is where Maps pan plants a finger.
  let inputChoice = opt.viaPhone ? 'phone' : 'adb';
  // Prototype, not a constructed bridge: handle dispatches to _gesture, _move, _wheel and the rest.
  const b = Object.assign(Object.create(PhoneBridge.prototype), {
    phone: { info: { display: D } },
    input,
    control,
    phoneInput: true,
    getSettings: () => ({ phone: { enterSends: true, input: inputChoice, inputPicked: true }, kvm: {}, keys: {} }),
    kvm: opt.kvm === undefined
      ? { x: 540, y: 1200, buttons: opt.buttons || 0, mouse: opt.mouse !== false, route: 'phone', push: 0, side: 'left' }
      : opt.kvm,
    keys: new KeyState(),
    server: {
      keySwap: () => false,
      inject: () => {},
      sendToClient: () => {},
    },
    views: {
      activeApp: opt.maps ? 'com.google.android.apps.maps' : 'com.example.app',
      multipleApps: false,
      a11y: false,
    },
    emit() {},
  });
  return {
    b, sent, touches, controlMice, controlScrolls, phoneMice, phoneScrolls,
    accessibility(on) { inputChoice = on ? 'phone' : 'adb'; },
  };
}

function handle(h, m) {
  return PhoneBridge.prototype.handle.call(h.b, m);
}

const zoom = (phase, v = 0.2) => ({ t: T.K_GESTURE, g: 'zoom', phase, v });
const strokes = (sent) => sent.filter((m) => m && m.a === 'z');
const count = (touches, action, id) => touches.filter((t) => t[0] === action && t[1] === id).length;
const fingers = (touches, action) => [1001, 1002].map((id) => count(touches, action, id));
const panDowns = (touches) => count(touches, 0, 2);

function assertStroke(z, where) {
  assert.ok(z, where);
  assert.equal(z.t, T.PHONE_IN, where);
  assert.equal(z.a, 'z', where);
  assert.deepEqual(Object.keys(z).sort(), ['a', 'from', 't', 'to', 'vert', 'x', 'y'], where);
  assert.equal(z.vert, 1, where);
  assert.equal('v' in z, false, where);
  assert.ok(z.to > z.from, where);
  assert.ok(z.x >= 0 && z.x < D.w && z.y >= 0 && z.y < D.h, where);
}

// A click leaves the button down, and kvm release drops the pointer. Clear that before a
// leftover change, or Pinch / the missing driver would hide a block that never got set.
function clearExcuse(h, excuse) {
  if (excuse === 'up') handle(h, { t: T.K_UP, b: 0 });
  if (excuse === 'take') handle(h, { t: T.KVM_TAKE, route: 'phone', side: 'left', offset: 0.5 });
}

test('move and wheel wait while an Accessibility pinch gathers, and the next sample after the flush pinches again', () => {
  withTimers((fire) => {
    const h = harness({ viaPhone: true });
    handle(h, zoom('change', 0.2));
    handle(h, { t: T.K_GESTURE, g: 'rotate', phase: 'change', v: 0.2 });
    handle(h, { t: T.K_MOVE, dx: 12, dy: 0 });
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -40 });
    assert.equal(h.phoneMice.length, 0, 'move is not delivered while the stroke is gathering');
    assert.equal(h.phoneScrolls.length, 0, 'the wheel is not delivered while the stroke is gathering');
    assert.equal(strokes(h.sent).length, 0, 'the stroke waits for the flush');
    fire(PINCH_MS);
    assert.equal(strokes(h.sent).length, 1);
    assertStroke(strokes(h.sent)[0], 'flush');
    assert.equal(strokes(h.sent)[0].x, 540);
    assert.equal(strokes(h.sent)[0].y, 1200);
    handle(h, zoom('change', 0.2));
    fire(PINCH_MS);
    assert.equal(strokes(h.sent).length, 2, 'the same gesture pinches again after the flush');
    assertStroke(strokes(h.sent)[1], 'next sample');
  });
});

test('a click before any pinch does not block the gesture', () => {
  withTimers((fire) => {
    const h = harness({ viaPhone: true });
    handle(h, { t: T.K_DOWN, b: 0 });
    handle(h, { t: T.K_UP, b: 0 }); // the button has to come up, or the sample is a drag
    handle(h, zoom('change', 0.2)); // change, not begin: a sticky block would drop this
    fire(PINCH_MS);
    assert.equal(strokes(h.sent).length, 1);
    assertStroke(strokes(h.sent)[0], 'after an earlier click');
  });
});

test('no pinch unless this session is driving the pointer', () => {
  withTimers((fire) => {
    const idle = { x: 540, y: 1200, buttons: 0, mouse: false, route: 'phone', push: 0 };
    for (const viaPhone of [true, false]) {
      for (const kvm of [null, idle]) {
        const h = harness({ viaPhone, kvm });
        handle(h, zoom('begin', 0.2));
        handle(h, zoom('change', 0.2));
        fire(PINCH_MS);
        const where = `${viaPhone ? 'accessibility' : 'scrcpy'} ${kvm ? 'mouse off' : 'no driver'}`;
        assert.equal(strokes(h.sent).length, 0, where);
        assert.deepEqual(fingers(h.touches, 0), [0, 0], where);
      }
    }
  });
});

test('a held mouse button does not start a pinch', () => {
  withTimers((fire) => {
    for (const viaPhone of [true, false]) {
      const h = harness({ viaPhone, buttons: 1 });
      handle(h, zoom('begin', 0.2));
      handle(h, zoom('change', 0.2));
      fire(PINCH_MS);
      const where = viaPhone ? 'accessibility' : 'scrcpy';
      assert.equal(strokes(h.sent).length, 0, where);
      assert.deepEqual(fingers(h.touches, 0), [0, 0], where);
    }
  });
});

for (const spec of INTERRUPTS) {
  test(`a ${spec.name} during an Accessibility pinch drops the stroke and blocks a leftover change`, () => {
    withTimers((fire) => {
      const h = harness({ viaPhone: true });
      handle(h, zoom('change', 0.2));
      handle(h, spec.msg);
      fire(PINCH_MS);
      assert.equal(strokes(h.sent).length, 0, `${spec.name}: the gathered stroke is not sent`);
      clearExcuse(h, spec.excuse);
      handle(h, zoom('change', 0.2));
      fire(PINCH_MS);
      assert.equal(strokes(h.sent).length, 0, `${spec.name}: a leftover change does not pinch`);
      handle(h, zoom('begin', 0.2));
      fire(PINCH_MS);
      assert.equal(strokes(h.sent).length, 1, `${spec.name}: the next begin pinches`);
      assertStroke(strokes(h.sent)[0], spec.name);
    });
  });

  test(`a ${spec.name} in the gap after an Accessibility flush blocks a leftover change`, () => {
    withTimers((fire) => {
      const h = harness({ viaPhone: true });
      handle(h, zoom('change', 0.2));
      fire(PINCH_MS);
      assert.equal(strokes(h.sent).length, 1, `${spec.name}: the first stroke is sent`);
      assertStroke(strokes(h.sent)[0], spec.name);
      handle(h, { t: T.K_MOVE, dx: 12, dy: 0 });
      handle(h, { t: T.K_WHEEL, dx: 0, dy: -40 });
      assert.ok(h.phoneMice.length > 0, `${spec.name}: move is delivered between flushes`);
      assert.ok(h.phoneScrolls.length > 0, `${spec.name}: the wheel is delivered between flushes`);
      handle(h, spec.msg);
      clearExcuse(h, spec.excuse);
      handle(h, zoom('change', 0.2));
      fire(PINCH_MS);
      assert.equal(strokes(h.sent).length, 1, `${spec.name}: a leftover change does not pinch`);
      handle(h, zoom('begin', 0.2));
      fire(PINCH_MS);
      assert.equal(strokes(h.sent).length, 2, `${spec.name}: the next begin pinches`);
      assertStroke(strokes(h.sent)[1], spec.name);
    });
  });
}

test('move and wheel wait while scrcpy pinch fingers are down', () => {
  withTimers(() => {
    const h = harness();
    handle(h, zoom('change', 0.2));
    assert.deepEqual(fingers(h.touches, 0), [1, 1], 'two fingers go down');
    assert.deepEqual(fingers(h.touches, 1), [0, 0]);
    const n = h.touches.length;
    handle(h, { t: T.K_GESTURE, g: 'rotate', phase: 'change', v: 0.2 });
    handle(h, { t: T.K_MOVE, dx: 12, dy: 0 });
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -40 });
    assert.equal(h.touches.length, n, 'rotate, move and wheel add no contacts');
    assert.equal(h.controlMice.length, 0, 'move is not delivered');
    assert.equal(h.controlScrolls.length, 0, 'the wheel is not delivered');
    handle(h, zoom('end', 0));
    assert.deepEqual(fingers(h.touches, 1), [1, 1], 'the fingers were still down until the gesture ended');
  });
});

for (const spec of INTERRUPTS) {
  test(`a ${spec.name} lifts scrcpy pinch fingers and blocks a leftover change`, () => {
    withTimers(() => {
      const h = harness();
      handle(h, zoom('change', 0.2));
      assert.deepEqual(fingers(h.touches, 0), [1, 1], spec.name);
      handle(h, spec.msg);
      assert.deepEqual(fingers(h.touches, 1), [1, 1], `${spec.name}: both fingers lift`);
      clearExcuse(h, spec.excuse);
      handle(h, zoom('change', 0.2));
      assert.deepEqual(fingers(h.touches, 0), [1, 1], `${spec.name}: a leftover change does not plant fingers`);
      handle(h, zoom('begin', 0.2));
      assert.deepEqual(fingers(h.touches, 0), [2, 2], `${spec.name}: the next begin plants fingers`);
    });
  });
}

test('Maps pan waits while pinch fingers are down and runs when the gesture is open but the fingers are up', () => {
  withTimers(() => {
    const h = harness({ maps: true });
    handle(h, zoom('begin', 0)); // announced, nothing planted: the wheel is not held yet
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(panDowns(h.touches), 1, 'pan plants a finger');
    const mid = h.touches.length;
    handle(h, { t: T.K_WHEEL, dx: 40, dy: 0 });
    assert.ok(h.touches.length > mid, 'pan keeps moving while the fingers are up');
    handle(h, zoom('change', 0.2));
    const held = h.touches.length;
    handle(h, { t: T.K_MOVE, dx: 12, dy: 0 });
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(h.touches.length, held, 'move and wheel wait while the pinch fingers are down');
    assert.equal(h.controlMice.length, 0, 'move is not delivered');
    handle(h, zoom('end', 0));
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(panDowns(h.touches), 2, 'pan resumes after the pinch');
  });
});

test('Maps pan continues in the gap after an Accessibility stroke flushes', () => {
  withTimers((fire) => {
    // Maps pan needs the control channel (ctl.touch). That channel holds the fingers for the
    // whole pinch, so it never flushes at 150 ms. Gather the stroke on Accessibility, then
    // point the bridge back at the control channel: the gesture is still open and the fingers
    // are up, which is the gap the wheel is allowed through.
    const h = harness({ viaPhone: true, maps: true });
    handle(h, zoom('change', 0.2));
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(panDowns(h.touches), 0, 'no pan while the stroke is gathering');
    assert.equal(h.phoneScrolls.length, 0, 'the wheel is not delivered while the stroke is gathering');
    fire(PINCH_MS);
    assert.equal(strokes(h.sent).length, 1);
    assertStroke(strokes(h.sent)[0], 'flush before the pan');
    h.accessibility(false);
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(panDowns(h.touches), 1, 'pan plants a finger in the gap');
    const mid = h.touches.length;
    handle(h, { t: T.K_WHEEL, dx: 40, dy: 0 });
    assert.ok(h.touches.length > mid, 'pan keeps moving in the gap');
    handle(h, zoom('change', 0.2));
    const held = h.touches.length;
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(h.touches.length, held, 'the wheel waits once the pinch fingers are down');
    handle(h, zoom('end', 0));
    handle(h, { t: T.K_WHEEL, dx: 0, dy: -20 });
    assert.equal(panDowns(h.touches), 2, 'pan resumes after the pinch');
  });
});
