// One crossing, one line. The line is what a stuck arrow is grepped from.
// Run with: node --test mac/test/phone-pointer-diag.test.js
'use strict';

const assert = require('node:assert/strict');
const os = require('os');
const Module = require('module');
const { EventEmitter } = require('events');
const { test } = require('node:test');

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

const { PhoneBridge } = require('../phone-bridge.js');

test.after(() => { Module._load = realLoad; });

function harness({ session = false, buffered = 0, socket = true } = {}) {
  const sent = [];
  const current = { os: 'android', deviceId: 'phone' };
  if (socket) current.ws = { bufferedAmount: buffered };
  const server = new EventEmitter();
  server.current = current;
  server.sendToClient = (m) => sent.push(m);
  server.inject = () => {};
  server.keySwap = () => false;
  const settings = {
    phone: { input: session ? 'phone' : 'adb', inputPicked: true },
    kvm: {},
    audio: {},
  };
  const phone = new EventEmitter();
  phone.info = { display: { w: 1080, h: 2400, dpi: 420 } };
  phone.adb = null;
  const bridge = new PhoneBridge({
    server,
    phone,
    getSettings: () => settings,
    clipboard: null,
  });
  bridge.control = { closed: false, tap() {}, mouse() {} };
  bridge.phoneInput = session;
  bridge.inputBlocked = false;
  return { bridge, sent, current };
}

function withClock(run) {
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const lines = [];
  const log = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[phone] pointer ')) lines.push(line);
  };
  try {
    run({
      at(ms) { now = ms; },
      lines,
    });
  } finally {
    Date.now = real;
    console.log = log;
  }
}

test('a scrcpy crossing logs one summary when the pointer goes home', () => {
  const { bridge, sent, current } = harness({ buffered: 0 });
  withClock(({ at, lines }) => {
    at(1_000_000);
    bridge._take({ route: 'phone', side: 'left', offset: 0.5, mouse: true });
    at(1_000_050);
    bridge._move({ dx: 10, dy: 0 });
    at(1_000_130);
    bridge._move({ dx: 10, dy: 0 });
    current.ws.bufferedAmount = 4096;
    at(1_000_180);
    bridge._move({ dx: 4, dy: 1 });
    bridge._kvmEnd(false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '[phone] pointer mouse=1 ctl=scrcpy moves=3 sent=5 moveGapMs=80 sendGapMs=80 buf=4096');
  });
  assert.equal(sent.filter((m) => m.t === 'phone.pointer').length, 5);
});

test('a move inside the send gap is counted and not sent', () => {
  const { bridge } = harness();
  withClock(({ at, lines }) => {
    at(2_000_000);
    bridge._take({ route: 'phone', side: 'left', offset: 0.2, mouse: true });
    at(2_000_004);
    bridge._move({ dx: 3, dy: 0 });
    bridge._kvmEnd(false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '[phone] pointer mouse=1 ctl=scrcpy moves=1 sent=2 moveGapMs=0 sendGapMs=4 buf=0');
  });
});

test('session input and a mouse-off crossing name themselves, and a missing socket is a dash', () => {
  const { bridge, sent } = harness({ session: true, socket: false });
  withClock(({ at, lines }) => {
    at(3_000_000);
    bridge._take({ route: 'phone', side: 'right', offset: 0.4, mouse: false });
    at(3_000_050);
    bridge._move({ dx: -20, dy: 0 });
    bridge._kvmEnd(false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '[phone] pointer mouse=0 ctl=session moves=1 sent=2 moveGapMs=0 sendGapMs=50 buf=-');
  });
  assert.equal(sent.filter((m) => m.t === 'phone.pointer' && m.on === true).length, 1);
});
