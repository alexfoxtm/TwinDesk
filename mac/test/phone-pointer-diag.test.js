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

process.env.TWINDESK_NO_FX2 = '1';
process.env.TWINDESK_NO_IL = '1';

const { PhoneBridge } = require('../phone-bridge.js');
const { PhoneBridge: MeshPhoneBridge } = require('../mesh/phone-bridge.js');
const { Peer: DirectPeer } = require('../peer.js');
const { Server: DirectServer } = require('../server.js');
const { Server: MeshServer } = require('../mesh/server.js');
const { Hub } = require('../mesh/hub.js');
const { ScopedPhonePeer } = require('../mesh/phones.js');
const bleInput = require('../../shared/bleinput.js');

test.after(() => { Module._load = realLoad; });

function harness({ session = false, buffered = 0, socket = true, Bridge = PhoneBridge } = {}) {
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
  const bridge = new Bridge({
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

function withPointerTimers(run) {
  const schedule = global.setTimeout;
  const cancel = global.clearTimeout;
  const pending = new Set();
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    pending.add(timer);
    return timer;
  };
  global.clearTimeout = timer => pending.delete(timer);
  try { run(pending); } finally {
    global.setTimeout = schedule;
    global.clearTimeout = cancel;
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

test('direct and Mesh delayed pointer updates send the latest position once', () => {
  for (const Bridge of [PhoneBridge, MeshPhoneBridge]) {
    for (const session of [false, true]) {
      const { bridge, sent } = harness({ Bridge, session });
      const gap = session ? 40 : 8;
      withClock(({ at }) => withPointerTimers(pending => {
        const start = 2_100_000;
        at(start);
        bridge._take({ route: 'phone', side: 'left', offset: 0.2, mouse: true });
        at(start + 2);
        bridge._move({ dx: 3, dy: 1 });
        const timer = bridge.pointerTimer;
        assert.equal(timer.delay, gap - 2);
        at(start + 4);
        bridge._move({ dx: 7, dy: 2 });
        assert.deepEqual([...pending], [timer], 'a later move keeps the original deadline');
        pending.delete(timer);
        at(start + gap);
        timer.callback();
        const visible = sent.filter(m => m.t === 'phone.pointer' && m.on);
        assert.equal(visible.length, 2, 'entry and one delayed move are handed off');
        assert.equal(visible[1].x, Math.round(bridge.kvm.x));
        assert.equal(visible[1].y, Math.round(bridge.kvm.y));
        assert.equal(bridge.pointerTimer, null);

        at(start + gap + 2);
        bridge._move({ dx: 3, dy: 1 });
        const superseded = bridge.pointerTimer;
        assert.ok(superseded);
        at(start + 2 * gap);
        bridge._move({ dx: 6, dy: 2 });
        assert.equal(pending.size, 0, 'an immediate update cancels the queued one');
        const afterMove = sent.filter(m => m.t === 'phone.pointer').length;
        at(start + 3 * gap);
        superseded.callback();
        assert.equal(sent.filter(m => m.t === 'phone.pointer').length, afterMove, 'no duplicate position after the mouse stops');
        at(start - 60_000);
        bridge._move({ dx: 3, dy: 1 });
        assert.equal(sent.filter(m => m.t === 'phone.pointer').length, afterMove + 1, 'a clock step back starts a fresh send interval');
        assert.equal(pending.size, 0);
        bridge._kvmEnd(false);
      }));
    }
  }
});

test('direct and Mesh retired pointer timers cannot send into the next crossing', () => {
  for (const Bridge of [PhoneBridge, MeshPhoneBridge]) {
    const { bridge, sent } = harness({ Bridge });
    withClock(({ at }) => withPointerTimers(pending => {
      at(2_200_000);
      bridge._take({ route: 'phone', side: 'left', offset: 0.2, mouse: true });
      at(2_200_004);
      bridge._move({ dx: 3, dy: 1 });
      const timer = [...pending][0];
      assert.ok(timer);
      bridge._kvmEnd(false);
      assert.equal(pending.size, 0, 'ending a crossing removes its delayed move');
      at(2_200_012);
      bridge._take({ route: 'phone', side: 'right', offset: 0.8, mouse: true });
      at(2_200_016);
      bridge._move({ dx: -3, dy: -1 });
      const active = bridge.pointerTimer;
      assert.ok(active);
      const sentBeforeLateCallback = sent.length;
      timer.callback();
      assert.equal(sent.length, sentBeforeLateCallback, 'old callback cannot update the new crossing');
      assert.equal(bridge.pointerTimer, active, 'old callback cannot clear the new timer handle');
      bridge._kvmEnd(false);
      assert.equal(pending.size, 0, 'ending the new crossing cancels its timer');
    }));
  }
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

function fakeSocket(transport, bufferedAmount = 0) {
  const sent = [];
  return {
    OPEN: 1,
    readyState: 1,
    transport,
    bufferedAmount,
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
  };
}

function directPeerHarness({ bleSplit = false } = {}) {
  const raw = Object.assign(new EventEmitter(), {
    https: new EventEmitter(),
    current: null,
    bleInput: bleSplit ? bleInput : null,
    socketFor: DirectServer.prototype.socketFor,
    send: DirectServer.prototype.send,
    sendToClient: DirectServer.prototype.sendToClient,
  });
  const link = Object.assign(new EventEmitter(), {
    ctx: null,
    authed: false,
    ws: { bufferedAmount: 999_999 },
    bufferedAmount: 999_999,
    poke() {},
  });
  const peer = new DirectPeer(raw, link);
  peer.bleInput = raw.bleInput;
  const settings = { phone: { input: 'adb', inputPicked: true }, kvm: {}, audio: {} };
  const phone = Object.assign(new EventEmitter(), {
    info: { display: { w: 1080, h: 2400, dpi: 420 } },
    adb: null,
  });
  const bridge = new PhoneBridge({ server: peer, phone, getSettings: () => settings, clipboard: null });
  bridge.adb = { available: false, wake() {}, devices: async () => [], shell: async () => ({ out: '' }) };
  bridge.control = { closed: false, tap() {}, mouse() {}, stop() { this.closed = true; } };
  bridge.inputBlocked = false;
  return { raw, peer, bridge };
}

test('direct crossing routes and samples the actual non-input outbound socket across BLE split and fallback', () => {
  const { raw, bridge } = directPeerHarness({ bleSplit: true });
  const bleSock = fakeSocket('ble', 88_888);
  const ipSock = fakeSocket('ip', 128);
  const phoneA = { os: 'android', deviceId: 'phone-a', authed: true, transport: 'ble', ws: bleSock, alt: ipSock };
  raw.current = phoneA;
  raw.emit('client', phoneA);
  try {
    withClock(({ at, lines }) => {
      at(4_000_000);
      bridge._take({ route: 'phone', side: 'left', offset: 0.5, mouse: true });
      ipSock.bufferedAmount = 512;
      at(4_000_030);
      bridge._move({ dx: 8, dy: 0 });
      // Non-input IP socket closes -> BLE split falls back to surviving BLE primary socket.
      ipSock.readyState = 3;
      bleSock.bufferedAmount = 1024;
      at(4_000_060);
      bridge._move({ dx: 8, dy: 0 });
      bridge._kvmEnd(false);
      assert.equal(lines.length, 1);
      assert.equal(lines[0], '[phone] pointer mouse=1 ctl=scrcpy moves=2 sent=4 moveGapMs=30 sendGapMs=30 buf=1024');
    });
    assert.equal(ipSock.sent.filter((m) => m.t === 'phone.pointer').length, 2, 'split routing sent initial + first move over IP');
    assert.equal(bleSock.sent.filter((m) => m.t === 'phone.pointer').length, 2, 'fallback sent second move + hide over BLE');
  } finally {
    clearInterval(bridge.pollTimer);
    clearTimeout(bridge.kickTimer);
  }
});

test('direct crossing counts only handed-off sends on closed sockets and never hides a replacement peer on takeover', () => {
  const { raw, bridge } = directPeerHarness();
  const sockA = fakeSocket('ip', 256);
  const sockB = fakeSocket('ip', 65_536);
  const phoneA = { os: 'android', deviceId: 'phone-a', authed: true, transport: 'ip', ws: sockA, alt: null };
  const phoneB = { os: 'android', deviceId: 'phone-b', authed: true, transport: 'ip', ws: sockB, alt: null };
  raw.current = phoneA;
  raw.emit('client', phoneA);
  try {
    withClock(({ at, lines }) => {
      at(5_000_000);
      bridge._take({ route: 'phone', side: 'left', offset: 0.5, mouse: true });
      // Socket closes before close event: move is not handed off and closed buffer is not sampled.
      sockA.readyState = 3;
      sockA.bufferedAmount = 77_777;
      at(5_000_030);
      bridge._move({ dx: 10, dy: 0 });
      // Phone B takes over before Phone A closes (as Server.authenticate does).
      phoneA.released = true;
      raw.current = phoneB;
      raw.emit('client', phoneB);
      assert.equal(lines.length, 1);
      assert.equal(lines[0], '[phone] pointer mouse=1 ctl=scrcpy moves=1 sent=1 moveGapMs=0 sendGapMs=0 buf=256');
    });
    assert.equal(sockA.sent.filter((m) => m.t === 'phone.pointer').length, 1);
    assert.equal(sockB.sent.filter((m) => m.t === 'phone.pointer').length, 0, 'replacement peer must never receive old hide');
  } finally {
    clearInterval(bridge.pollTimer);
    clearTimeout(bridge.kickTimer);
  }
});

test('a new authenticated context for the same phone ends the crossing and keeps scrcpy', () => {
  const { raw, peer, bridge } = directPeerHarness();
  const original = { os: 'android', deviceId: 'phone', authed: true, transport: 'ip', ws: fakeSocket('ip') };
  const replacement = { ...original, ws: fakeSocket('ip') };
  const control = bridge.control;
  const home = [];
  peer.on('t:kvm.home', (msg) => home.push(msg));
  try {
    raw.current = original;
    raw.emit('client', original);
    bridge._take({ route: 123, side: 'left', offset: 0.5 });
    raw.emit('client', original);
    assert.ok(bridge.kvm, 'an unchanged context keeps the crossing');
    original.released = true;
    raw.current = replacement;
    raw.emit('client', replacement);
    raw.emit('closed', original);
    assert.equal(bridge.kvm, null);
    assert.equal(bridge.control, control);
    assert.equal(control.closed, false);
    assert.deepEqual(home, [{ t: 'kvm.home', route: 123 }]);
    assert.equal(replacement.ws.sent.filter((msg) => msg.t === 'phone.pointer').length, 0);
  } finally {
    clearInterval(bridge.pollTimer);
    clearTimeout(bridge.kickTimer);
  }
});

test('a scoped Mesh phone keeps its crossing across selection and ends it on reconnect', () => {
  const host = Object.assign(new EventEmitter(), {
    clients: new Map(),
    https: new EventEmitter(),
    bleInput,
    _now: () => Date.now(),
    setPrimary() {},
    _raw(ws, msg) { ws.send(JSON.stringify(msg)); ws.lastTx = this._now(); },
    socketFor: MeshServer.prototype.socketFor,
    send: MeshServer.prototype.send,
    sendToClient: MeshServer.prototype.sendToClient,
  });
  const links = Object.assign(new EventEmitter(), { list: () => [], bindServer() {} });
  const hub = new Hub({ device: { id: 'mac' }, links, mesh: null, server: host });
  const meshPeer = new ScopedPhonePeer(hub, host, 'mesh-a');
  const settings = { phone: { input: 'adb', inputPicked: true }, kvm: {}, audio: {} };
  const phone = Object.assign(new EventEmitter(), {
    info: { display: { w: 1080, h: 2400, dpi: 420 } },
    adb: null,
  });
  const bridge = new MeshPhoneBridge({ server: meshPeer, phone, getSettings: () => settings, clipboard: null });
  bridge.adb = { available: false, wake() {}, devices: async () => [], shell: async () => ({ out: '' }) };
  bridge.control = { closed: false, tap() {}, mouse() {}, stop() { this.closed = true; } };
  bridge.inputBlocked = false;

  const bleA = fakeSocket('ble', 99_999);
  const ipA = fakeSocket('ip', 320);
  const ctxA = { os: 'android', deviceId: 'mesh-a', name: 'Phone A', authed: true, transport: 'ble', ws: bleA, alt: ipA };
  const ipB = fakeSocket('ip', 55_555);
  const ctxB = { os: 'android', deviceId: 'mesh-b', name: 'Phone B', authed: true, transport: 'ip', ws: ipB, alt: null };
  host.clients.set('mesh-a', ctxA);
  host.emit('client', ctxA);
  host.clients.set('mesh-b', ctxB);
  host.emit('client', ctxB);
  assert.equal(hub.selectedId, 'mesh-a');

  try {
    withClock(({ at, lines }) => {
      at(6_000_000);
      bridge._take({ route: 'phone', side: 'left', offset: 0.5, mouse: true });
      ipA.bufferedAmount = 640;
      at(6_000_040);
      bridge._move({ dx: 6, dy: 0 });
      // A selection change does not retarget the bridge that owns A's crossing.
      at(6_000_080);
      hub.select('mesh-b');
      assert.ok(bridge.kvm);
      assert.equal(meshPeer.current.deviceId, 'mesh-a');
      bridge._kvmEnd(false);
      assert.equal(lines.length, 1);
      assert.equal(lines[0], '[phone] pointer mouse=1 ctl=scrcpy moves=1 sent=3 moveGapMs=0 sendGapMs=40 buf=640');
    });
    assert.deepEqual(ipA.sent.filter((m) => m.t === 'phone.pointer').map(m => m.on), [true, true, false]);
    assert.equal(bleA.sent.filter((m) => m.t === 'phone.pointer').length, 0);
    assert.equal(ipB.sent.filter((m) => m.t === 'phone.pointer').length, 0, 'selected replacement phone must not be hidden');

    bridge.control = { closed: false, tap() {}, mouse() {}, stop() { this.closed = true; } };
    bridge._take({ route: 'phone-a', side: 'left', offset: 0.5 });
    assert.ok(bridge.kvm);
    ctxA.released = true;
    const resumed = { ...ctxA, released: false, transport: 'ip', alt: null, ws: fakeSocket('ip') };
    host.clients.set('mesh-a', resumed);
    host.emit('client', resumed);
    assert.equal(bridge.kvm, null, 'reconnecting the same phone ends the retired crossing');
    assert.equal(resumed.ws.sent.filter((m) => m.t === 'phone.pointer').length, 0);
  } finally {
    clearInterval(bridge.pollTimer);
    clearTimeout(bridge.kickTimer);
  }
});
