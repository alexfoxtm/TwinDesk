// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// USB-only desktop policy: in memory for this process, same lifetime as wired.js byDevice.
// Run with: node shared/test/cableonly.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CablePolicy, cable, isUsb } = require('../cableonly.js');

const root = path.join(__dirname, '../..');

function fresh() {
  cable.clear();
  return cable;
}

function adb() {
  const calls = [];
  return {
    calls, mode: 'twindesk-cable-unrestricted',
    available: true,
    devices: async () => [],
    async shell(serial, cmd) {
      calls.push(['shell', serial, cmd]);
      const data = this.mode ? ', data="' + this.mode + '"' : '';
      return { code: 0, out: cmd.includes('checkCableMode') ? 'Broadcast completed: result=0' + data + '\r\n' : '0' };
    },
    run: async (args) => { calls.push(['run', ...args]); return { code: 0, out: '' }; },
  };
}

function openWired(rel) {
  const { Wired } = require(path.join(root, rel));
  const raw = { current: null, https: new EventEmitter(), port: 47800 };
  const peer = Object.assign(new EventEmitter(), { all: () => [], ctxOf: () => null });
  const bridge = adb();
  const w = new Wired({ adb: bridge, raw, peer, getId: () => 'pc', getName: () => 'PC' });
  return { w, raw, peer, bridge };
}

function tcpRuns(calls) {
  return calls.filter((c) => c[0] === 'run' && c.includes('tcpip'));
}

function authenticatedHelloRefreshesPolicy() {
  const P = require('../protocol.js');
  const { Server } = require('../../mac/server.js');
  const { Pairing } = require('../../mac/pairing.js');
  const tailnet = require('../tailnet.js');
  const relay = require('../relay.js');
  const originalMine = tailnet.mine;
  const originalWelcome = relay.welcome;
  tailnet.mine = () => [];
  relay.welcome = () => null;
  const server = Object.assign(Object.setPrototypeOf(new EventEmitter(), Server.prototype), {
    send: () => true,
    fail() {},
  });
  const token = P.randomHex(32);
  const pair = Object.assign(Object.setPrototypeOf(new EventEmitter(), Pairing.prototype), {
    server, id: { macId: 'mac', macName: 'Fixture Mac' },
    paired: [{ id: 'phone', name: 'Fixture Galaxy', os: P.OS.ANDROID, tokenHash: P.sha256Hex(token) }],
    busy: () => false, _save() {}, previews: { authorize() {} },
  });
  server.on('preauth', (ctx, m) => pair._hello(ctx, m));
  const hello = (value, proof = token) => {
    const ws = { OPEN: 1, readyState: 1 };
    const ctx = { ws, address: '192.0.2.2' };
    const packet = { t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: 'phone', os: P.OS.ANDROID, token: proof };
    if (value !== undefined) packet.cable = value;
    server._onMessage(ctx, Buffer.from(JSON.stringify(packet)), false, ws);
    return ctx;
  };
  try {
    cable.note('phone', 'R58M123', { cable: 1 });
    assert.ok(!hello(0, 'not-the-paired-token').authed, 'a refused HELLO does not authenticate');
    assert.strictEqual(cable.on('phone'), true, 'a refused HELLO cannot clear the saved cable policy');
    const seen = [];
    server.on('client', () => seen.push(cable.on('phone')));
    assert.strictEqual(hello(0).authed, true);
    assert.strictEqual(hello(1).authed, true);
    assert.strictEqual(hello(undefined).authed, true);
    assert.deepStrictEqual(seen, [false, true, true], 'only the authenticated HELLO updates the policy before client listeners');
    assert.strictEqual(cable.serial('phone'), 'R58M123', 'policy refresh retains the previously verified serial');
  } finally {
    tailnet.mine = originalMine;
    relay.welcome = originalWelcome;
    cable.clear();
  }
}

async function main() {
  assert.strictEqual(isUsb('R58M123'), true);
  assert.strictEqual(isUsb(''), false);
  assert.strictEqual(isUsb('192.0.2.10:5555'), false);
  assert.strictEqual(isUsb('emulator-5554'), false);
  assert.strictEqual(isUsb('adb-1._adb-tls-connect._tcp'), false);

  const policy = new CablePolicy();
  assert.strictEqual(policy.exact('phone', [{ serial: 'R58M123', state: 'device' }]), undefined);
  policy.note('phone', 'R58M123', { nonce: 'n' });
  assert.strictEqual(policy.on('phone'), false);
  policy.note('phone', 'R58M123', { cable: 1 });
  assert.strictEqual(policy.on('phone'), true);
  assert.strictEqual(policy.serial('phone'), 'R58M123');
  assert.strictEqual(policy.skipsTcpip('R58M123'), true);
  assert.strictEqual(policy.skipsTcpip('OTHER'), false);
  assert.strictEqual(policy.skipsTcpip('192.0.2.10:5555'), false);
  policy.note('phone', 'R58M123', {});
  assert.strictEqual(policy.on('phone'), true, 'a message without cable keeps the previous intent');
  policy.note('phone', '192.0.2.10:5555', { cable: 1 });
  assert.strictEqual(policy.serial('phone'), 'R58M123', 'a wireless serial does not replace the USB one');
  assert.strictEqual(policy.exact('phone', [{ serial: 'OTHER', state: 'device' }]), null);
  assert.strictEqual(policy.exact('phone', [{ serial: 'R58M123', state: 'offline' }]), null);
  assert.strictEqual(policy.exact('phone', [{ serial: 'R58M123', state: 'device' }]), 'R58M123');
  policy.note('phone', 'R58M123', { cable: 0 });
  assert.strictEqual(policy.on('phone'), false);
  assert.strictEqual(policy.serial('phone'), null);
  assert.strictEqual(policy.skipsTcpip('R58M123'), false);
  policy.note('phone', null, { cable: 1 });
  assert.strictEqual(policy.serial('phone'), 'R58M123', 'cable 0 keeps the serial for a later opt-in');
  policy.note('emu', 'emulator-5554', { cable: 1 });
  assert.strictEqual(policy.serial('emu'), null);
  policy.note('tls', 'adb-1._adb-tls-connect._tcp', { cable: 1 });
  assert.strictEqual(policy.serial('tls'), null);
  policy.clear();

  const wiredFiles = [
    'mac/wired.js', 'linux/wired.js', 'windows/wired.js',
    'mac/mesh/wired.js', 'linux/mesh/wired.js', 'windows/mesh/wired.js',
  ];
  const bridgeFiles = [
    'mac/phone-bridge.js', 'linux/phone-bridge.js', 'windows/phone-bridge.js',
    'mac/mesh/phone-bridge.js', 'linux/mesh/phone-bridge.js', 'windows/mesh/phone-bridge.js',
  ];
  for (const rel of wiredFiles) {
    const opened = openWired(rel);
    try {
      opened.w.turnOk = true;
      opened.w.turn.ice = () => ({ iceServers: [{ urls: 'turn:127.0.0.1:1' }] });
      const phone = { os: 'android', address: '127.0.0.1', transport: 'tcp', embeddedPeer: false };
      assert.ok(opened.raw.iceFor(phone), `${rel} still offers relay ice without the cable flag`);
      assert.strictEqual(opened.raw.iceFor({ ...phone, embeddedPeer: true }), null, rel);
      assert.strictEqual(opened.raw.iceFor({ ...phone, address: '192.0.2.1' }), null, rel);
    } finally {
      opened.w.stop();
    }
  }

  fresh();
  const mac = openWired('mac/wired.js');
  try {
    // The desktop initially knows nothing about an attached phone, including its USB-only setting.
    mac.bridge.mode = 'twindesk-cable-only';
    await mac.w._tcpip('R58M123');
    assert.strictEqual(tcpRuns(mac.bridge.calls).length, 0, 'first cable attach honors persisted USB-only');
    mac.bridge.mode = null;
    await mac.w._tcpip('R58M123');
    assert.strictEqual(tcpRuns(mac.bridge.calls).length, 0, 'missing mode cannot enable wireless ADB');

    mac.bridge.mode = 'twindesk-cable-unrestricted';
    await mac.w._tcpip('R58M123');
    assert.strictEqual(tcpRuns(mac.bridge.calls).length, 1, 'explicit unrestricted mode retains desktop ADB setup');
    mac.bridge.calls.length = 0;
    cable.note('phone', 'R58M123', { cable: 1 });
    await mac.w._tcpip('R58M123');
    assert.deepStrictEqual(mac.bridge.calls, [], 'an opted-in USB serial skips tcpip');
    await mac.w._tcpip('OTHERUSB');
    assert.strictEqual(tcpRuns(mac.bridge.calls).length, 1, 'another serial is not skipped');

    mac.w.plugged.set('FREE', { nonce: 'free', at: Date.now(), linked: false });
    assert.strictEqual(mac.w._serialFor('phone'), null, 'opted in, and the saved serial is not plugged');
    mac.w.plugged.set('R58M123', { nonce: 'usb', at: Date.now(), linked: true });
    assert.strictEqual(mac.w._serialFor('phone'), 'R58M123');
    cable.note('phone', 'R58M123', { cable: 0 });
    mac.w.plugged.delete('R58M123');
    assert.strictEqual(mac.w._serialFor('lonely'), 'FREE', 'the flag off still allows the single free serial');
    mac.w.plugged.set('R58M123', { nonce: 'usb', at: Date.now(), linked: true });

    cable.clear();
    mac.peer.emit('t:phone.wired', { nonce: 'usb' }, { deviceId: 'phone', name: 'Phone' });
    assert.strictEqual(mac.w.byDevice.get('phone'), 'R58M123');
    assert.strictEqual(cable.on('phone'), false, 'phone.wired without cable does not opt in');
    mac.peer.emit('t:phone.wired', { nonce: 'usb', cable: 1 }, { deviceId: 'phone', name: 'Phone' });
    assert.strictEqual(cable.on('phone'), true);
    assert.strictEqual(cable.serial('phone'), 'R58M123');
    mac.peer.emit('t:phone.wired', { nonce: 'usb', cable: 0 }, { deviceId: 'phone', name: 'Phone' });
    assert.strictEqual(cable.on('phone'), false);
    assert.strictEqual(cable.skipsTcpip('R58M123'), false);
  } finally {
    mac.w.stop();
    cable.clear();
  }

  authenticatedHelloRefreshesPolicy();

  for (const rel of bridgeFiles) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(text.includes('cableonly.js'), rel);
    assert.ok(text.includes('cable.exact('), rel);
    assert.ok(text.includes("if (cable.on(cableId)) return this._set('connecting', 'Waiting for the phone…');"), rel);
    const tcp = text.indexOf('async _tcpip');
    assert.ok(tcp > 0, rel);
    assert.ok(!text.slice(tcp, tcp + 500).includes('skipsTcpip'), `${rel} leaves USB tcpip to wired.js`);
  }
  for (const rel of wiredFiles) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(text.includes('cable.skipsTcpip(serial)'), rel);
    assert.ok(text.includes('cable.note(ctx.deviceId, hit[0], m)'), rel);
    assert.ok(text.includes('!ctx.embeddedPeer'), rel);
  }

  console.log('cableonly: passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
