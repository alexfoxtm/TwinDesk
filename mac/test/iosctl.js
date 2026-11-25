// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const vm = require('node:vm');
const { IpadControl } = require('../iosctl');
const { RUNNER_ID, pairedWifiAddress, wifiSource, prepareManifest, stagedRunner,
  parseWdaResponse, WdaInputRejected } = require('../iosctl-xctest');
const { handleIPad, pairedIPad, installIPadQuitDrain } = require('../phoneview-ipad');

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
      if (path.endsWith('/appium/settings')) return { value: { animationCoolOffTimeout: 0 } };
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

test('existing network usbmux records use the paired tunnel while genuine USB uses loopback', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'twindesk-wda-route-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = 'Debug-iphoneos/WebDriverAgentRunner-Runner.app';
  const testBundle = 'PlugIns/WebDriverAgentRunner.xctest';
  const framework = 'Debug-iphoneos/WebDriverAgentLib.framework';
  await fs.mkdir(path.join(root, stage, testBundle), { recursive: true });
  await fs.mkdir(path.join(root, framework));
  const template = path.join(root, 'fixture.xctestrun');
  await fs.writeFile(template, JSON.stringify({
    __xctestrun_metadata__: { FormatVersion: 1 }, WebDriverAgentRunner: {
      IsUITestBundle: true, IsXCTRunnerHostedTestBundle: true, TestHostBundleIdentifier: `${RUNNER_ID}.xctrunner`,
      TestHostPath: `__TESTROOT__/${stage}`, TestBundlePath: `__TESTHOST__/${testBundle}`,
      DependentProductPaths: [framework, stage, `${stage}/${testBundle}`].map((p) => `__TESTROOT__/${p}`),
      CommandLineArguments: [], EnvironmentVariables: {}, TestingEnvironmentVariables: {},
    },
  }));
  const address = 'fd12:abcd:1234::1';
  const source = 'fd12:abcd:1234::2';
  const device = { hardwareProperties: { udid, deviceType: 'iPad' }, deviceProperties: { developerModeStatus: 'enabled' },
    connectionProperties: { pairingState: 'paired', transportType: 'localNetwork', tunnelState: 'connected', tunnelIPAddress: address } };
  const record = (connection) => ({ DeviceID: 42, Properties: { SerialNumber: udid, ConnectionType: connection } });
  const file = require.resolve('../iosctl-xctest');
  const realRequire = createRequire(file);

  for (const [records, expected] of [[[record('Network')], address], [[], address],
    [[record('Network'), record('USB')], '127.0.0.1']]) {
    let attested = false;
    let bound;
    class FakeMux extends EventEmitter {
      constructor() { super(); queueMicrotask(() => this.emit('open')); }
      send(msg) { assert.equal(msg.MessageType, 'ListDevices'); this.emit('message', { DeviceList: records }); }
      close() { this.emit('close'); }
    }
    const execFile = () => assert.fail('unmocked execFile');
    execFile[promisify.custom] = async (binary, args) => {
      if (binary === '/usr/bin/codesign') return { stdout: '' };
      if (binary === '/usr/bin/plutil') return { stdout: args.includes('json') ? await fs.readFile(template, 'utf8') : '' };
      if (binary === '/usr/bin/xcrun' && args.includes('list')) return { stdout: JSON.stringify({ result: { devices: [device] } }) };
      if (binary === '/usr/bin/xcrun' && args.includes('details')) {
        assert(args.includes(udid));
        attested = true;
        return { stdout: JSON.stringify({ result: device }) };
      }
      assert.equal(binary, '/sbin/route');
      assert.equal(args.at(-1), address);
      return { stdout: `destination: ${address}\ninterface: utun13\nflags: <UP,HOST,IFSCOPE>\n` };
    };
    const spawn = (binary, args) => {
      assert.equal(binary, '/usr/bin/xcrun');
      assert(args.includes(`platform=iOS,id=${udid}`));
      const runFile = args[args.indexOf('-xctestrun') + 1];
      bound = JSON.parse(readFileSync(runFile, 'utf8')).WebDriverAgentRunner.EnvironmentVariables.USE_IP;
      const child = new EventEmitter();
      child.kill = () => child.emit('exit');
      return child;
    };
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, process, Buffer, AbortSignal, AbortController,
      setTimeout, clearTimeout, require(name) {
        if (name === 'node:child_process') return { execFile, spawn };
        if (name === 'node:os') return { networkInterfaces: () => ({ utun13: [{ address: source, cidr: `${source}/64` }] }) };
        if (name === '../shared/iosnet') return { Mux: FakeMux };
        return realRequire(name);
      } });
    const transport = await module.exports.startXCTest(udid, new AbortController().signal, template);
    await transport.stop();
    assert.equal(bound, expected);
    assert.equal(attested, expected === address);
  }
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
  assert.deepEqual(calls[2], { method: 'POST', path: '/session/own-session/appium/settings', body: {
    settings: { animationCoolOffTimeout: 0 },
  } });
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
  assert.deepEqual(calls.map((c) => c.path), ['/status', '/session', '/session/own-session/appium/settings', '/wda/shutdown']);
  assert.equal(transport.stops, 1);
});

test('drops a rejected action, keeps its session, and stops on invalid session or heartbeat failure', async (t) => {
  const status = [], logs = [];
  const rejection = { sessionId: 'own-session', value: { error: 'invalid element state', message: 'PRIVATE' } };
  const { calls, transport } = wda();
  const request = transport.request;
  let keyAttempts = 0;
  transport.request = async (method, route, body, signal) => {
    if (route.endsWith('/wda/keys')) {
      keyAttempts++;
      if (keyAttempts === 1) return parseWdaResponse(400, route, rejection);
      return parseWdaResponse(404, route, { ...rejection, value: { error: 'invalid session id' } });
    }
    return request(method, route, body, signal);
  };
  const controller = new IpadControl({ udid, owns: () => true, status: (s) => status.push(s),
    log: (s) => logs.push(s), start: async () => transport });
  t.after(() => controller.stop());
  await controller.connect();
  controller.input({ op: 'key', down: true, key: 'F' });
  controller.input({ op: 'home' });
  await tick();
  assert.equal(keyAttempts, 1);
  assert.equal(calls.at(-1).path, '/session/own-session/wda/pressButton');
  assert.deepEqual(status, ['connected']);
  assert.equal(logs[0], '[ipad control] key rejected invalid_element_state');
  controller.input({ op: 'key', down: true, key: 'Q' });
  await tick();
  await controller.stopping;
  assert.equal(keyAttempts, 2);
  assert.deepEqual(status, ['connected', 'lost']);
  assert(logs.every((entry) => !entry.includes('PRIVATE')));
  for (const args of [[403, rejection], [400, { ...rejection, sessionId: 'wrong' }], [200, {}]]) {
    assert.throws(() => parseWdaResponse(args[0], '/session/own-session/actions', args[1]),
      (error) => !(error instanceof WdaInputRejected));
  }

  const heartbeat = wda();
  const heartbeatState = [];
  const next = new IpadControl({ udid, owns: () => true, log() {}, status: (s) => heartbeatState.push(s),
    start: async () => heartbeat.transport });
  t.after(() => next.stop());
  await next.connect();
  next.enqueue('heartbeat', () => parseWdaResponse(400, '/session/own-session', rejection));
  await tick();
  await next.stopping;
  assert.deepEqual(heartbeatState, ['connected', 'lost']);
});

test('only one iPad quit drain runs on completion, timeout, or repeated quit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['no jobs', 'completed', 'timeout']) {
    const app = new EventEmitter();
    let quitCalls = 0, completedQuits = 0, cleanupCalls = 0, finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    app.quit = () => {
      quitCalls++;
      let canceled = false;
      app.emit('before-quit');
      app.emit('will-quit', { preventDefault() { canceled = true; } });
      if (!canceled) completedQuits++;
    };
    installIPadQuitDrain(app, () => { cleanupCalls++; return outcome === 'no jobs' ? null : pending; });
    app.quit();
    if (outcome !== 'no jobs') {
      app.quit();
      assert.equal(completedQuits, 0);
      if (outcome === 'timeout') t.mock.timers.tick(3000);
      else { finish(); await tick(); }
      assert.equal(quitCalls, 3);
      finish();
      await tick();
      t.mock.timers.tick(3000);
      assert.equal(quitCalls, 3);
    }
    assert.equal(cleanupCalls, 1);
    assert.equal(completedQuits, 1);
  }
});

test('staged XCTest runner discards both envs and rejects executable overrides or path escapes', async (t) => {
  const host = '__TESTROOT__/Debug-iphoneos/WebDriverAgentRunner-Runner.app';
  const suite = 'PlugIns/WebDriverAgentRunner.xctest';
  const library = '__TESTROOT__/Debug-iphoneos/WebDriverAgentLib.framework';
  const unsafe = { USE_IP: '0.0.0.0', ENABLE_AUTOMATIC_SCREEN_RECORDINGS: 'YES',
    ENABLE_AUTOMATIC_SCREENSHOTS: 'YES', DYLD_INSERT_LIBRARIES: '/tmp/untrusted.dylib', USE_PORT: '8100' };
  const template = {
    __xctestrun_metadata__: { FormatVersion: 1 }, WebDriverAgentRunner: {
      IsUITestBundle: true, IsXCTRunnerHostedTestBundle: true, TestHostBundleIdentifier: `${RUNNER_ID}.xctrunner`,
      TestHostPath: host, TestBundlePath: `__TESTHOST__/${suite}`, DependentProductPaths: [library, host, `${host}/${suite}`],
      EnvironmentVariables: unsafe, TestingEnvironmentVariables: unsafe, UITargetAppEnvironmentVariables: unsafe,
      CommandLineArguments: [],
    },
  };
  const build = (manifest) => prepareManifest(manifest, '127.0.0.1', 54000, 'fixture');
  const prepared = build(template).WebDriverAgentRunner;
  assert.deepEqual(prepared.EnvironmentVariables, { USE_IP: '127.0.0.1', USE_PORT: '54000', MJPEG_SERVER_PORT: '0',
    WDA_PRODUCT_BUNDLE_IDENTIFIER: RUNNER_ID, UPGRADE_TIMESTAMP: 'fixture' });
  assert.deepEqual(prepared.TestingEnvironmentVariables, {});
  assert.deepEqual(prepared.UITargetAppEnvironmentVariables, {});
  assert.equal(prepared.SystemAttachmentLifetime, 'keepNever');
  for (const override of [{ EnvironmentVariables: [] }, { TestingEnvironmentVariables: [] },
    { TestHostPath: '__TESTROOT__/../other.app' }, { TestBundlePath: '__TESTHOST__/../elsewhere.xctest' },
    { CommandLineArguments: ['--port', '8100'] }, { UITargetAppPath: '/Applications/other.app' },
    { DependentProductPaths: [host, `${host}/${suite}`, '/tmp/other.framework'] }]) {
    assert.throws(() => build({ ...template, WebDriverAgentRunner: { ...template.WebDriverAgentRunner, ...override } }), /setup/);
  }

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'twindesk-wda-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagedHost = path.join(root, host.replace('__TESTROOT__/', ''));
  const stagedSuite = path.join(stagedHost, suite);
  await fs.mkdir(stagedSuite, { recursive: true });
  await fs.mkdir(path.join(root, library.replace('__TESTROOT__/', '')));
  assert.equal(await stagedRunner(root), stagedHost);
  const outsideHost = path.join(root, 'another-test-bundle');
  await fs.rename(stagedSuite, outsideHost);
  await fs.symlink(outsideHost, stagedSuite, 'dir');
  await assert.rejects(stagedRunner(root), /setup/);
});
