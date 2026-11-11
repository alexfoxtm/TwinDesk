// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Exercise the real permission routes with fakes. Never query or change macOS privacy grants.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
      running: true, request: async () => ({ screen: !allowed, inputMonitoring: true }),
    } },
    systemPreferences: {
      getMediaAccessStatus: () => allowed ? 'granted' : 'denied',
      isTrustedAccessibilityClient: () => true,
    },
    setupSeen() {}, pushState() {},
    require(name) { throw new Error('unexpected dependency ' + name); },
  };
  vm.runInNewContext(source.slice(start, end) + '\nrefreshPermissions();', context, { filename: file });
  await Promise.resolve();
  assert.equal(state.permissions.screen, allowed ? 'granted' : 'denied', 'only the capturing app decides Screen Recording access');
  assert.equal(state.permissions.inputMonitoring, true);
}

async function requestRoute(file, granted, unavailable = false) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('    async allowPermission(kind) {');
  const end = source.indexOf('    skipSetup(', start);
  assert.ok(start >= 0 && end > start);
  let nativeRequests = 0, accessibilityRequests = 0, helperRequests = 0, refreshes = 0, warnings = 0;
  const opened = [];
  const nativePermission = new NotificationPermission({ requestScreenAccess() {
    nativeRequests++;
    if (unavailable) throw new Error('native request unavailable');
    return granted;
  } });
  const actions = vm.runInNewContext('({' + source.slice(start, end) + '})', {
    SETTINGS_URLS: { screen: 'screen-settings', accessibility: 'accessibility-settings', inputMonitoring: 'input-settings', localNetwork: 'network-settings' },
    systemPreferences: { isTrustedAccessibilityClient(prompt) {
      assert.equal(prompt, true, 'Allow asks macOS to register the main app');
      accessibilityRequests++;
      if (unavailable) throw new Error('Accessibility request unavailable');
      return granted;
    } },
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
}

async function main() {
  for (const file of ['main.js', 'mesh/main.js']) await entrypoints(file, true);
  for (const file of ['ipc.js', 'mesh/ipc.js']) await requestRoute(file, true);
}

async function failure() {
  for (const file of ['main.js', 'mesh/main.js']) await entrypoints(file, false);
  for (const file of ['ipc.js', 'mesh/ipc.js']) {
    await requestRoute(file, false);
    await requestRoute(file, false, true);
  }
  assert.throws(() => new NotificationPermission(null).requestScreen(), /unavailable/);
}

(async () => {
  await main();
  await failure();
  console.log('permission entrypoints: app-owned Screen Recording and Accessibility requests, no automatic resets');
})().catch((err) => { console.error(err); process.exitCode = 1; });
