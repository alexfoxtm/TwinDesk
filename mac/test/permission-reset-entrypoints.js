// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Exercise the real permission routes with fakes. Never query or change macOS privacy grants.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { NotificationPermission } = require('../notification-permission');

async function entrypoints(file, allowed) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.doesNotMatch(source, /clearStalePermissions|resetMissing|tccutil/, file + ' must not reset privacy grants on launch');
  const start = source.indexOf('function refreshPermissions() {');
  const end = source.indexOf('// macOS owns privacy grants.', start);
  assert.ok(start >= 0 && end > start);
  const state = { permissions: {} };
  const context = {
    state,
    svc: { notifs: { nativePermission: { refresh() {} } }, helper: {
      running: true, request: async () => ({ screen: !allowed, inputMonitoring: true, location: 'granted' }),
    } },
    systemPreferences: {
      getMediaAccessStatus: (kind) => kind === 'screen' ? allowed ? 'granted' : 'denied' : kind === 'camera' ? 'not-determined' : 'restricted',
      isTrustedAccessibilityClient: () => true,
    },
    setupSeen() {}, pushState() {},
    permArm() {}, // refreshPermissions arms the 3 s poll; this slice has no timer
    require(name) { throw new Error('unexpected dependency ' + name); },
  };
  vm.runInNewContext(source.slice(start, end) + '\nrefreshPermissions();', context, { filename: file });
  await Promise.resolve();
  assert.equal(state.permissions.screen, allowed ? 'granted' : 'denied', 'only the capturing app decides Screen Recording access');
  assert.equal(state.permissions.inputMonitoring, true);
  assert.equal(state.permissions.location, 'granted');
  assert.equal(state.permissions.camera, 'not-determined');
  assert.equal(state.permissions.microphone, 'restricted');
}

async function requestRoute(file, granted, unavailable = false) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('    async allowPermission(kind) {');
  const end = source.indexOf('    skipSetup(', start);
  assert.ok(start >= 0 && end > start);
  let nativeRequests = 0, accessibilityRequests = 0, helperRequests = 0, mediaRequests = 0, refreshes = 0, warnings = 0;
  const opened = [];
  const nativePermission = new NotificationPermission({ requestScreenAccess() {
    nativeRequests++;
    if (unavailable) throw new Error('native request unavailable');
    return granted;
  } });
  const actions = vm.runInNewContext('({' + source.slice(start, end) + '})', {
    SETTINGS_URLS: { screen: 'screen-settings', accessibility: 'accessibility-settings', inputMonitoring: 'input-settings', localNetwork: 'network-settings', camera: 'camera-settings', microphone: 'microphone-settings' },
    systemPreferences: { isTrustedAccessibilityClient(prompt) {
      assert.equal(prompt, true, 'Allow asks macOS to register the main app');
      accessibilityRequests++;
      if (unavailable) throw new Error('Accessibility request unavailable');
      return granted;
    },
    getMediaAccessStatus: (kind) => kind === 'camera' ? 'not-determined' : 'denied',
    askForMediaAccess: async (kind) => { assert.equal(kind, 'camera'); mediaRequests++; return granted; },
    },
    ctx: { notifs: { nativePermission }, helper: { running: true, request: async () => { helperRequests++; return { granted: true }; } },
      refreshPermissions() { refreshes++; } },
    shell: { openExternal(url) { opened.push(url); } },
    console: { warn() { warnings++; } },
  }, { filename: file });
  await actions.allowPermission('screen');
  assert.equal(nativeRequests, 1);
  assert.equal(helperRequests, 0, 'screen request belongs to Electron main, never the helper');
  assert.deepEqual(opened, granted ? [] : ['screen-settings']);
  assert.equal(warnings, unavailable ? 1 : 0);
  assert.equal(refreshes, 1);
  await actions.allowPermission('accessibility');
  assert.equal(accessibilityRequests, 1);
  assert.equal(helperRequests, 0, 'Accessibility request belongs to Electron main, never the helper');
  assert.deepEqual(opened, granted ? [] : ['screen-settings', 'accessibility-settings']);
  assert.equal(warnings, unavailable ? 2 : 0);
  assert.equal(refreshes, 2);
  await actions.allowPermission('inputMonitoring');
  assert.equal(helperRequests, 1, 'Input Monitoring still asks the capturing helper');
  assert.equal(refreshes, 3);
  await actions.allowPermission('camera');
  assert.equal(mediaRequests, 1);
  assert.deepEqual(opened, granted ? [] : ['screen-settings', 'accessibility-settings', 'camera-settings']);
  await actions.allowPermission('microphone');
  assert.equal(mediaRequests, 1, 'a past denial goes to Settings');
  assert.equal(opened.at(-1), 'microphone-settings');
  assert.equal(refreshes, 5);
}

async function locationRoute(file, result) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('    async allowPermission(kind) {');
  const end = source.indexOf('    skipSetup(', start);
  const opened = [], requests = [], rendered = [];
  let decision, refreshes = 0;
  let location = result.openSettings ? 'denied' : 'notDetermined';
  const state = { permissions: { location } };
  const ctx = {
    state,
    helper: { running: true, request(cmd) {
      requests.push(cmd);
      if (cmd === 'wifiLocation') return Promise.resolve({});
      return new Promise((resolve, reject) => { decision = { resolve, reject }; });
    } },
    refreshPermissions() {
      refreshes++;
      state.permissions.location = location;
      pushState();
    },
  };
  const shell = { openExternal(url) { opened.push(url); } };
  const pushState = () => rendered.push({ ...state.permissions });
  const settingsUrl = 'location-settings';
  const wiring = source.match(/^  const requestLocation = .*$/m)?.[0] ?? '';
  const actions = vm.runInNewContext(wiring + '\n({' + source.slice(start, end) + '})', {
    SETTINGS_URLS: { location: settingsUrl }, ctx, shell, pushState,
    createLocationRequest: wiring && require('../location-permission').createLocationRequest,
  }, { filename: file });
  const first = actions.allowPermission('location');
  const repeated = actions.allowPermission('location');
  // An old helper acknowledgement returns immediately, exposing the premature Settings launch.
  if (!decision) await Promise.all([first, repeated]);
  assert.deepEqual(opened, [], 'Settings stays closed while the system prompt is pending');
  assert.equal(refreshes, 0, 'the action waits for a decision');
  assert.deepEqual(requests, ['requestLocation'], 'repeated Allow waits on one request');
  assert.equal(rendered.at(-1)?.locationPending, true);
  location = result.location ?? 'notDetermined';
  if (result instanceof Error) decision.reject(result);
  else decision.resolve({ openSettings: result.openSettings === true });
  await Promise.all([first, repeated]);
  assert.equal(refreshes, 1, 'completion refreshes the row without a focus event');
  assert.equal(rendered.at(-1).locationPending, false, 'Allow becomes available again');
  assert.equal(rendered.at(-1).location, location);
  assert.deepEqual(opened, result.openSettings ? [settingsUrl] : []);

  if (result.openSettings || location === 'notDetermined') {
    const serviceFile = file.replace('ipc.js', 'services.js');
    const service = fs.readFileSync(path.join(__dirname, '..', serviceFile), 'utf8');
    const listener = service.match(/^  helper\.on\('event', \(event\) => \{[\s\S]*?^  \}\);/m);
    assert.ok(listener, 'service listens for helper authorization changes');
    let emit;
    vm.runInNewContext(listener[0], {
      helper: { on(_name, callback) { emit = callback; } },
      onHelperReady: ctx.refreshPermissions,
    }, { filename: serviceFile });
    location = 'granted';
    emit('locationChanged');
    assert.equal(rendered.at(-1).location, 'granted', 'Settings or a late grant refreshes without focus');
  }
}

function localNetworkEvidence() {
  const { Discovery } = require('../discovery');
  const networkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: 'IPv4', address: '192.0.2.1', netmask: '255.255.255.0' }],
    utun0: [{ family: 'IPv4', address: '100.64.0.1', netmask: '255.255.255.255' }],
  });
  try {
    const discovery = new Discovery({ macId: 'fixture' });
    let reply;
    discovery.sock = { send: (_payload, _port, _address, cb) => cb(reply) };
    reply = { code: 'ENETUNREACH' };
    discovery.probe('192.0.2.255');
    assert.equal(discovery.status.localNetwork, true, 'an unavailable route does not establish a privacy block');
    reply = { code: 'EHOSTUNREACH' };
    discovery.probe('192.0.2.255');
    assert.equal(discovery.status.localNetwork, false);
    reply = null;
    discovery.probe('100.64.0.1');
    assert.equal(discovery.status.localNetwork, false, 'a point-to-point adapter does not establish LAN recovery');
    discovery.probe('192.0.2.255');
    assert.equal(discovery.status.localNetwork, true);
    assert.equal(discovery.status.localNetworkWasBlocked, true);
  } finally {
    os.networkInterfaces = networkInterfaces;
  }
}

async function main() {
  for (const file of ['main.js', 'mesh/main.js']) await entrypoints(file, true);
  for (const file of ['ipc.js', 'mesh/ipc.js']) {
    await locationRoute(file, { location: 'granted' });
    await requestRoute(file, true);
  }
}

async function failure() {
  for (const file of ['main.js', 'mesh/main.js']) await entrypoints(file, false);
  for (const file of ['ipc.js', 'mesh/ipc.js']) {
    await locationRoute(file, { location: 'denied' });
    await locationRoute(file, { location: 'denied', openSettings: true });
    await locationRoute(file, { location: 'notDetermined' });
    await locationRoute(file, new Error('helper exited'));
    await locationRoute(file, new Error('helper: requestLocation timed out'));
    await requestRoute(file, false);
    await requestRoute(file, false, true);
  }
  assert.throws(() => new NotificationPermission(null).requestScreen(), /unavailable/);
}

(async () => {
  await main();
  await failure();
  localNetworkEvidence();
  console.log('permission entrypoints: app-owned grants, Location completion and Settings recovery, no automatic resets');
})().catch((err) => { console.error(err); process.exitCode = 1; });
