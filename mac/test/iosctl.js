// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { IpadControl } = require('../iosctl');
const { RUNNER_ID, pairedWifiAddress, wifiSource } = require('../iosctl-xctest');
const { handleIPad, pairedIPad } = require('../phoneview-ipad');

const udid = '12345678-1234567890ABCDEF';
const tick = () => new Promise(setImmediate);

function wda({ marker = 'expected', window = { x: 0, y: 0, width: 820, height: 1180 } } = {}) {
  const calls = [];
  const lost = new AbortController();
  const transport = {
    marker: 'expected',
    lost: lost.signal,
    exited: new Promise(() => {}),
    seal() { transport.sealed = true; },
    async request(method, path, body, signal) {
      signal.throwIfAborted();
      calls.push({ method, path, body });
      if (path === '/status') return { sessionId: null, value: { ready: true, device: 'ipad',
        build: { productBundleIdentifier: RUNNER_ID, upgradedAt: marker } } };
      if (path === '/session') return { value: { sessionId: 'own-session' } };
      if (path.endsWith('/window/rect')) return { value: { ...window } };
      return { value: null };
    },
    async stop() { transport.stops = (transport.stops || 0) + 1; },
  };
  return { calls, transport, window };
}

const frameArgs = (frame, rect) => ({ width: frame.width, height: frame.height, rect });
const actions = (calls) => calls.filter((c) => c.path.endsWith('/actions')).map((c) => c.body.actions[0].actions);

test('attests only the paired iPad’s exact Wi-Fi tunnel host route', () => {
  const detail = { hardwareProperties: { udid, deviceType: 'iPad' }, deviceProperties: { developerModeStatus: 'enabled' },
    connectionProperties: { pairingState: 'paired', transportType: 'localNetwork', tunnelState: 'connected', tunnelIPAddress: 'fd12:abcd:1234::1' } };
  const address = pairedWifiAddress(detail, udid);
  assert.equal(address, 'fd12:abcd:1234::1');
  const route = `destination: ${address}\n  interface: utun13\n      flags: <UP,HOST,IFSCOPE>\n`;
  const source = 'fd12:abcd:1234::2';
  const interfaces = { utun13: [{ address: source, cidr: `${source}/64` }] };
  assert.equal(wifiSource(address, route, interfaces), source);
  assert.equal(pairedWifiAddress(detail, '87654321-1234567890ABCDEF'), null);
  for (const tunnelIPAddress of ['::', '192.168.4.145', 'fe80::1%en0', 'fd12:abcd:1234::2']) {
    assert.equal(pairedWifiAddress({ ...detail, connectionProperties: { ...detail.connectionProperties, tunnelIPAddress } }, udid), null);
  }
  for (const other of [route.replace('utun13', 'en0'), route.replace(address, 'default'), route.replace('HOST', 'HOST,GATEWAY')]) {
    assert.equal(wifiSource(address, other, interfaces), null);
  }
  assert.equal(wifiSource(address, route, { utun12: interfaces.utun13 }), null);
});

test('verified WDA session maps upright portrait and landscape video, gestures, typing and Home', async (t) => {
  const { calls, transport, window } = wda();
  const statuses = [], logs = [];
  const controller = new IpadControl({ udid, owns: () => true, status: (s) => statuses.push(s),
    log: (s) => logs.push(s), start: async () => transport });
  t.after(() => controller.stop());
  await controller.connect();
  assert.deepEqual(statuses, ['connected']);
  assert(transport.sealed);
  const portrait = { frame: { width: 820, height: 1180 }, source: { w: 1640, h: 2360 } };
  const portraitRect = { left: 100, top: 64, width: 410, height: 590 };
  const tap = { op: 'gesture', ...frameArgs(portrait.frame, portraitRect), points: [{ x: 305, y: 359 }] };
  controller.input(tap, () => portrait);
  controller.input({ ...tap, points: [{ x: 99, y: 359 }] }, () => portrait); // letterbox
  controller.input({ ...tap, duration: 580 }, () => portrait);
  await tick();

  const landscape = { frame: { width: 1180, height: 820 }, source: { w: 2360, h: 1640 } };
  const landscapeRect = { left: 6, top: 194, width: 590, height: 410 };
  const drag = { op: 'gesture', ...frameArgs(landscape.frame, landscapeRect), duration: 180,
    points: [{ x: 301, y: 399 }, { x: 530, y: 500 }] };
  controller.input(drag, () => landscape); // WDA still portrait: reject transition
  await tick();
  [window.width, window.height] = [1180, 820];
  controller.input(drag, () => landscape);
  controller.input({ ...drag, op: 'scroll', points: [drag.points[0]], dx: 0, dy: 60 }, () => landscape);
  controller.input({ op: 'key', down: true, key: 'a' });
  controller.input({ op: 'key', down: true, key: 'Backspace' });
  controller.input({ op: 'home' });
  await tick();
  const [tapSteps, holdSteps, dragSteps, scrollSteps] = actions(calls);
  assert.equal(actions(calls).length, 4);
  assert.deepEqual(tapSteps[0], { type: 'pointerMove', origin: 'viewport', duration: 0, x: 410, y: 590 });
  assert.deepEqual(holdSteps[2], { type: 'pause', duration: 520 });
  assert.deepEqual(dragSteps[0], { type: 'pointerMove', origin: 'viewport', duration: 0, x: 590, y: 410 });
  assert.deepEqual(dragSteps[2], { type: 'pointerMove', origin: 'viewport', duration: 180, x: 1048, y: 612 });
  assert.equal(scrollSteps[2].y, 312);
  assert.deepEqual(calls.slice(-3).map(({ path, body }) => [path, body]), [
    ['/session/own-session/wda/keys', { value: ['a'] }],
    ['/session/own-session/wda/element/0/keyboardInput', { keys: ['XCUIKeyboardKeyDelete'] }],
    ['/session/own-session/wda/pressButton', { name: 'home' }],
  ]);
  assert.equal(logs.length, 7);
  assert(logs.every((line) => /^\[ipad control\] (tap|long-press|drag|scroll|key|home) \d+ms$/.test(line)));
  await controller.stop();
  assert.equal(calls.at(-1).path, '/wda/shutdown');
  assert.equal(transport.stops, 1);
});

test('rejects a wrong runner, duplicate owner, stale generation and reconnect during in-flight geometry', async (t) => {
  const statuses = [];
  const withdrawn = wda();
  let routeChecks = 0;
  withdrawn.transport.request = async () => { routeChecks++; throw new Error('route'); };
  const withdrawnController = new IpadControl({ udid, owns: () => true, status: (s) => statuses.push(s),
    log() {}, start: async () => withdrawn.transport });
  await withdrawnController.connect();
  assert.deepEqual(statuses.splice(0), ['route']);
  assert.equal(routeChecks, 1);
  assert.equal(withdrawn.transport.stops, 1);

  const spoof = wda({ marker: 'another-runner' });
  const spoofController = new IpadControl({ udid, owns: () => true, status: (s) => statuses.push(s),
    log() {}, start: async () => spoof.transport });
  await spoofController.connect();
  assert.deepEqual(statuses, ['endpoint']);
  assert.deepEqual(spoof.calls.map((c) => c.path), ['/status']);
  assert.equal(spoof.transport.stops, 1);

  const { calls, transport } = wda();
  const request = transport.request;
  let rectReply;
  transport.request = (method, path, body, signal) => path.endsWith('/window/rect')
    ? new Promise((resolve) => { rectReply = resolve; }) : request(method, path, body, signal);
  let owns = true;
  const controller = new IpadControl({ udid, owns: () => owns, status() {}, log() {}, start: async () => transport });
  t.after(() => controller.stop());
  await controller.connect();
  await assert.rejects(new IpadControl({ udid, owns: () => true }).connect(), /busy/);
  const socket = { readyState: 1 };
  const peer = { deviceId: 'ipad-1', os: 'ios', authed: true, conn: socket };
  const views = { server: { current: peer }, phone: { info: { platform: 'ipados' },
    pairing: { list: () => [{ id: 'ipad-1', os: 'ios', pairedAt: 42 }] } }, _send() {} };
  const { conn, ...directPeer } = peer;
  assert.equal(pairedIPad(views, { ...directPeer, ws: socket }).socket, conn);
  assert.equal(pairedIPad(views, { ...peer, conn: null, ws: socket }), null);
  const v = { ipadOwner: pairedIPad(views), win: { isFocused: () => true },
    size: { width: 820, height: 1180 }, ipadGeometry: { w: 1640, h: 2360 } };
  v.ipadLease = { generation: 'current', abort: new AbortController(), controller, stream: { removeListener() {} } };
  const input = { t: 'ipadInput', op: 'gesture', generation: 'old',
    ...frameArgs(v.size, { left: 0, top: 0, width: 410, height: 590 }), points: [{ x: 20, y: 20 }] };
  assert.equal(handleIPad(views, v, input), true);
  assert.equal(rectReply, undefined);
  assert.equal(handleIPad(views, v, { ...input, generation: 'current' }), true);
  assert.equal(typeof rectReply, 'function');
  handleIPad(views, v, { t: 'ipadInput', op: 'home', generation: 'current' }); // queued
  owns = false;
  views.server.current = { ...peer, conn: { readyState: 1 } }; // same Mesh peer id, new connection
  assert.equal(handleIPad(views, v, { t: 'nav', key: 'home' }), true);
  rectReply({ value: { x: 0, y: 0, width: 820, height: 1180 } });
  await controller.stopping;
  assert.equal(v.ipadLease, null);
  assert.deepEqual(calls.map((c) => c.path), ['/status', '/session', '/wda/shutdown']);
  assert.equal(transport.stops, 1);
});
