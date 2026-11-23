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
const { Peer: MeshPeer } = require('../mesh/peer.js');
const bleInput = require('../../shared/bleinput.js');

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

test('selected Mesh crossing pins non-input outbound socket and never hides replacement selection', () => {
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
  const meshPeer = new MeshPeer(hub.facade, host);
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
      // Closed socket drops unhanded-off send.
      ipA.readyState = 3;
      bleA.readyState = 3;
      at(6_000_080);
      bridge._move({ dx: 6, dy: 0 });
      // Selecting Phone B switches the facade route; teardown must not hide Phone B or read its buffer.
      hub.select('mesh-b');
      assert.equal(lines.length, 1);
      assert.equal(lines[0], '[phone] pointer mouse=1 ctl=scrcpy moves=2 sent=2 moveGapMs=40 sendGapMs=40 buf=640');
    });
    assert.equal(ipA.sent.filter((m) => m.t === 'phone.pointer').length, 2);
    assert.equal(bleA.sent.filter((m) => m.t === 'phone.pointer').length, 0);
    assert.equal(ipB.sent.filter((m) => m.t === 'phone.pointer').length, 0, 'selected replacement phone must not be hidden');
  } finally {
    clearInterval(bridge.pollTimer);
    clearTimeout(bridge.kickTimer);
  }
});
