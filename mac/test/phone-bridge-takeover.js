// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A second Android phone takes the Mac session. The real PhoneBridge, with fake services and no
// device: the first phone's control session has to stop, and a lookup that then fails for that
// phone must not be recorded against the phone that replaced it (#263).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const starts = [];
class Control extends EventEmitter {
  constructor(_adb, serial) {
    super();
    this.serial = serial;
    this.closed = false;
  }
  start() {
    return new Promise((resolve) => starts.push({ session: this, resolve }));
  }
  stop() {
    this.closed = true;
    this.emit('closed', 'stopped');
  }
  mouse() {}
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-phone-bridge-'));
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../scrcpy' && parent.filename.endsWith('/mesh/phone-bridge.js')) {
    return { Session: Control, ACTION: { HOVER_EXIT: 10 } };
  }
  if (request === 'electron') return { app: { getPath: () => userData } };
  return realLoad.call(this, request, parent, isMain);
};
const { PhoneBridge } = require('../phone-bridge.js');
const { PhoneBridge: MeshBridge } = require('../mesh/phone-bridge.js');
const { AppPanel } = require('../app-panel.js');
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function phone(id, address) {
  return { deviceId: id, name: id, os: 'android', transport: 'ip', address };
}

function harness(input = 'adb', Bridge = PhoneBridge) {
  const server = new EventEmitter();
  server.current = null;
  const sent = [];
  server.sendToClient = (msg) => sent.push({ msg, deviceId: server.current && server.current.deviceId });
  server.inject = () => {};
  server.keySwap = () => false;
  const phoneHub = new EventEmitter();
  phoneHub.info = null;
  phoneHub.adb = null;
  const settings = {
    phone: { input, inputPicked: true, mirror: 'adb', soundVia: 'adb', wallpaper: false },
    audio: {},
    kvm: {},
  };
  const calls = { devices: 0, control: 0, views: 0, mouse: 0 };
  let devices = async () => [];
  const adb = {
    available: true,
    wake() {},
    devices() { calls.devices++; return devices(); },
    connect: async () => ({ ok: false, text: '' }),
    disconnect: async () => ({ ok: true, text: '' }),
    mdns: async () => [],
    shell: async () => ({ out: '', err: '' }),
    run: async () => ({ code: 0, out: '', err: '' }),
    pair: async () => ({ ok: false, text: '' }),
  };
  const bridge = new Bridge({ server, phone: phoneHub, getSettings: () => settings, clipboard: null, adb });
  bridge.adb = adb;
  bridge.views = {
    closeAll() { calls.views++; },
    list() { return []; },
    cameraState() { return null; },
    sound() {},
    mic() {},
    netMic() {},
    netSound() {},
    screenWithSound: false,
  };
  return {
    server, phoneHub, bridge, calls, sent, settings,
    setDevices(fn) { devices = fn; },
    stop() {
      clearInterval(bridge.pollTimer);
      clearTimeout(bridge.kickTimer);
    },
  };
}

test('Direct and Mesh require the exact authorized loopback serial and cancel a pending connect on LAN handback', async (t) => {
  for (const Bridge of [PhoneBridge, MeshBridge]) {
    const h = harness('adb', Bridge);
    t.after(() => h.stop());
    const { bridge, server, phoneHub, settings } = h;
    const ws = {};
    const owner = { ...phone('galaxy', '127.0.0.1'), ws, conn: ws, embeddedPeer: true };
    if (Bridge === MeshBridge) server.route = {};
    server.current = owner;
    server.emit('client', owner);
    clearTimeout(bridge.kickTimer);
    phoneHub.adb = { wifi: true, net: true, address: '192.168.1.20', port: 37123 };
    let closed = 0;
    const disconnected = [];
    const grant = { open: (live, onClose) => ({
      ready: Promise.resolve(40123),
      attached: true,
      close() { closed++; onClose(); },
    }) };
    phoneHub.raw = { embeddedAdbGrant: (socket) => socket === ws ? grant : null };
    bridge.adb.connectEmbedded = async (serial) => {
      assert.equal(serial, '127.0.0.1:40123');
      return { out: `connected to ${serial}`, err: '' };
    };
    bridge.adb.connect = async () => assert.fail('embedded control cannot dial a LAN ADB port');
    bridge.adb.disconnect = async (serial) => disconnected.push(serial);
    bridge.adb.shell = async () => assert.fail('ADB commands need the authorized exact serial');
    h.setDevices(async () => [
      { serial: '127.0.0.1:40123', state: 'unauthorized' },
      { serial: '127.0.0.1:40124', state: 'device' },
      { serial: '192.168.1.20:37123', state: 'device' },
    ]);
    await bridge._poll();
    assert.equal(bridge.state, 'needsPair');
    assert.equal(bridge.serial, null);
    assert.deepEqual(disconnected, ['127.0.0.1:40123']);

    Object.assign(settings.phone, { input: 'phone', mirror: 'native', soundVia: 'native' });
    phoneHub.adb = { wifi: false, net: false };
    grant.mode = 'cellular';
    assert.equal(bridge.need, false);
    assert.equal(bridge.embeddedAdb.wanted, false);
    bridge.known.add(owner.deviceId);
    await bridge._poll();
    assert.equal(bridge.state, 'error');
    assert.match(bridge.message, /ADB key isn’t authorized/);
    assert.equal(bridge.canPair, false);
    assert.equal(bridge.known.has(owner.deviceId), true);
    assert.equal(bridge.serial, null);

    h.setDevices(async () => [{ serial: '127.0.0.1:40123', state: 'device' }]);
    bridge._checkInput = async (serial) => assert.equal(serial, '127.0.0.1:40123');
    bridge._startControl = () => bridge._set('ready', '');
    await bridge._poll();
    assert.equal(bridge.state, 'ready');
    assert.equal(bridge.serial, '127.0.0.1:40123');
    bridge.embeddedAdb.close();

    let reportSignal;
    const started = new Promise((resolve) => { reportSignal = resolve; });
    bridge.adb.connectEmbedded = (_serial, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ out: '', err: '' }), { once: true });
      reportSignal(signal);
    });
    const connecting = bridge._poll();
    const signal = await started;
    server.current = phone('galaxy', '192.168.1.20');
    server.emit('transport', server.current);
    assert.equal(signal.aborted, true);
    await connecting;
    assert.equal(bridge.serial, null);
    assert.equal(closed, 4);
    assert.deepEqual(disconnected, Array(4).fill('127.0.0.1:40123'));
    h.stop();
  }
});

test('the adb poll and the phone clipboard poll wait until a phone can use them', () => {
  const h = harness();
  try {
    assert.equal(h.bridge.pollTimer, null, 'no 3 s adb poll before a phone connects');
    h.bridge.control = { closed: false, stop() {}, getClipboard() {} };
    h.server.current = phone('a', '10.0.0.2');
    assert.equal(h.bridge.allowClipPoll(), false, 'clipboard sync is off');
    h.settings.clipboard = { enabled: true, receive: true };
    assert.equal(h.bridge.allowClipPoll(), true);
    h.settings.clipboard.receive = false;
    assert.equal(h.bridge.allowClipPoll(), false, 'receive off');
    h.settings.clipboard.receive = true;
    h.server.current = { os: 'ios', deviceId: 'pad' };
    assert.equal(h.bridge.allowClipPoll(), false, 'not an Android phone');
    h.server.current = phone('a', '10.0.0.2');
    h.bridge.control.closed = true;
    assert.equal(h.bridge.allowClipPoll(), false, 'no control session');
    h.bridge.control.closed = false;
    h.server.emit('client', h.server.current);
    assert.ok(h.bridge.pollTimer, 'an Android phone starts the 3 s poll');
    h.server.current = null;
    h.server.emit('closed');
    assert.equal(h.bridge.pollTimer, null, 'the poll stops when the phone is gone');
  } finally {
    h.stop();
  }
});

test('a second Android phone releases the first and looks that phone up', async () => {
  for (const input of ['adb', 'phone']) {
  const h = harness(input);
  try {
    const a = phone('phone-a', '10.0.0.2');
    const b = phone('phone-b', '10.1.1.8');
    h.server.current = a;
    h.phoneHub.info = { model: 'Phone A', display: { w: 1080, h: 2400, rot: 0, dpi: 420 }, caps: [] };
    h.phoneHub.adb = { wifi: true, address: '10.0.0.2', port: 37000, devOptions: true, canEnable: true, full: true, net: true };
    h.server.emit('client', a);
    const controlA = {
      closed: false,
      stop() { this.closed = true; h.calls.control++; },
      mouse() { h.calls.mouse++; },
    };
    h.bridge.serial = 'serial-a';
    h.bridge.control = controlA;
    h.bridge.state = 'ready';
    h.bridge.phoneInput = true;
    h.bridge.kvm = { route: 1, x: 10, y: 20, side: 'left', push: 0, buttons: input === 'phone' ? 1 : 0, mouse: true };
    h.bridge.input.scroll(10, 20, 1080, 2400, 0, 1);
    h.server.current = b;
    h.server.emit('client', b);
    // The old socket closes after current is already B (authenticate does this).
    h.server.emit('closed', a);
    assert.equal(h.bridge.serial, null);
    assert.equal(h.bridge.control, null);
    assert.equal(h.bridge.kvm, null);
    assert.equal(h.phoneHub.info, null);
    assert.equal(h.phoneHub.adb, null);
    assert.equal(h.calls.control, 1);
    assert.equal(h.calls.views, 1);
    assert.equal(h.calls.mouse, input === 'adb' ? 1 : 0);
    h.phoneHub.adb = { wifi: true, address: '10.1.1.8', port: 38000, devOptions: true, canEnable: true, full: true, net: true };
    await wait(200);
    assert.ok(h.calls.devices > 0);
    assert.equal(h.bridge.serial, null);
    assert.equal(h.bridge.control, null);
    assert.notEqual(h.bridge.state, 'ready');
    assert.equal(h.calls.control, 1);
    assert.equal(h.calls.views, 1);
    assert.ok(!h.sent.some(({ msg, deviceId }) => msg.t === 'phone.in' && deviceId === 'phone-b'), 'old touch release or queued scroll reached the new phone');
    h.phoneHub.info = { model: 'Phone B' };
    h.server.current = { deviceId: 'iphone', os: 'ios' };
    h.server.emit('client', h.server.current);
    assert.equal(h.phoneHub.info, null);
    assert.equal(h.phoneHub.adb, null, 'an intervening non-Android peer must not preserve the retired phone address');
  } finally {
    h.stop();
  }
  }
});

test('a device lookup that fails after another phone is selected is not that phone’s failure', async () => {
  const h = harness();
  try {
    let rejectLookup;
    h.setDevices(() => new Promise((_, reject) => { rejectLookup = reject; }));
    const a = phone('phone-a', '10.0.0.2');
    const b = phone('phone-b', '10.1.1.8');
    h.server.current = a;
    h.phoneHub.adb = { wifi: true, address: '10.0.0.2', port: 37000, devOptions: true, canEnable: true, full: true, net: true };
    h.server.emit('client', a);
    await wait(80);
    assert.equal(h.calls.devices, 1);
    assert.equal(typeof rejectLookup, 'function');
    h.server.current = b;
    h.server.emit('client', b);
    h.server.emit('closed', a);
    rejectLookup(new Error('lookup failed'));
    await wait(250);
    assert.equal(h.bridge.state, 'connecting');
    assert.equal(h.bridge.message, 'Waiting for the phone…');
    assert.equal(h.bridge.serial, null);
    assert.equal(h.bridge.control, null);
  } finally {
    h.stop();
  }
});

function meshHarness() {
  const h = harness('adb', MeshBridge);
  const wifi = '10.0.0.2:37000';
  h.server.current = { ...phone('phone-a', '10.0.0.2'), authed: true, conn: { readyState: 1 } };
  h.phoneHub.adb = { wifi: true, address: '10.0.0.2', port: 37000 };
  h.setDevices(async () => [{ serial: wifi, state: 'device' }]);
  h.bridge.known.add('phone-a');
  h.bridge.setupDone.add(wifi);
  h.bridge.tcpipDone.add(wifi);
  h.bridge.setupDone.add('usb-a');
  return h;
}

test('Mesh USB handoff restores the panel on Wi-Fi, drops that controller, and keeps the USB controller', async (t) => {
  const h = meshHarness();
  t.after(h.stop);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstPoll = h.bridge._poll();
  await new Promise(setImmediate);
  const { session: wifi, resolve } = starts.shift();
  resolve();
  await firstPoll;

  const panel = new AppPanel(h.bridge, h.server);
  const view = {};
  const power = [];
  wifi.setDisplayPower = (on) => {
    assert.equal(h.bridge.control, wifi);
    assert.equal(wifi.closed, false);
    power.push(on);
  };
  assert.equal(panel.blank(panel.begin(view), view), true);
  h.bridge.views.releaseAppPanel = () => panel.release();
  wifi.once('closed', () => {
    assert.equal(h.bridge.control, null, 'the stopping controller no longer owns the bridge');
    assert.deepEqual(power, [false, true], 'panel power was restored before stop');
  });
  const states = [];
  h.bridge.on('change', () => states.push(h.bridge.state));
  let kicks = 0;
  h.bridge._kick = () => kicks++;
  h.bridge.wired = { serialOf: (id) => id === 'phone-a' ? 'usb-a' : null };
  h.setDevices(async () => [{ serial: 'usb-a', state: 'device' }]);
  const secondPoll = h.bridge._poll();
  await new Promise(setImmediate);
  const next = starts.shift();
  next.resolve();
  await secondPoll;
  assert.equal(h.bridge.control, next.session);
  assert.equal(next.session.serial, 'usb-a');
  assert.deepEqual(states, ['connecting', 'ready']);
  wifi.emit('clipboard', 'old clipboard');
  wifi.emit('closed', 'late close');
  assert.equal(h.bridge.control, next.session);
  assert.equal(h.bridge.state, 'ready');
  assert.equal(h.bridge.lastPhoneClip, undefined);
  next.session.emit('clipboard', 'new clipboard');
  assert.equal(h.bridge.lastPhoneClip, 'new clipboard');
  t.mock.timers.tick(2100);
  assert.equal(kicks, 0, 'deliberately stopping Wi-Fi did not schedule a retry');
  next.session.closed = true;
  next.session.emit('closed', 'the connection closed');
  assert.equal(h.bridge.control, null);
  assert.equal(h.bridge.state, 'error');
  t.mock.timers.tick(2000);
  assert.equal(kicks, 1, 'an unexpected close of the current controller schedules a retry');
});

test('Mesh discards an in-flight controller when its scoped phone disconnects and retries on reconnect', async (t) => {
  const h = meshHarness();
  t.after(h.stop);
  const scopedPhone = h.server.current;
  const firstPoll = h.bridge._poll();
  await new Promise(setImmediate);
  const abandoned = starts.shift();
  h.server.current = null;
  h.server.emit('closed');
  h.server.current = { ...scopedPhone, conn: { readyState: 1 } };
  let kicks = 0;
  h.bridge._kick = () => kicks++;
  h.server.emit('client', h.server.current);
  await h.bridge._poll(); // the reconnect's first chance to poll, while the old attempt is still busy
  abandoned.session.emit('clipboard', 'before install');
  abandoned.resolve();
  await firstPoll;
  assert.equal(abandoned.session.closed, true);
  assert.equal(h.bridge.control, null);
  assert.equal(h.bridge.state, 'off');
  assert.equal(h.bridge.lastPhoneClip, undefined);
  assert.equal(kicks, 2, 'the reconnect queues a kick and retiring the busy poll queues another');

  const secondPoll = h.bridge._poll();
  await new Promise(setImmediate);
  const active = starts.shift();
  active.resolve();
  await secondPoll;
  abandoned.session.emit('closed', 'late close');
  abandoned.session.emit('clipboard', 'late clipboard');
  assert.equal(h.bridge.control, active.session);
  assert.equal(h.bridge.state, 'ready');
  assert.equal(h.bridge.lastPhoneClip, undefined);
});
