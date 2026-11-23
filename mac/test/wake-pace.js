// The menu-bar percentage, the address poll, the permission poll and the
// Bluetooth tick run only while something reads them. Run: node mac/test/wake-pace.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const pace = require('../wake-pace');

const empty = { inBatches: [], receiving: [], outBatches: [], sending: [] };

test('the percentage timer runs only for a transfer or a tray title', () => {
  assert.equal(pace.pctShouldRun({}), false);
  assert.equal(pace.pctShouldRun({ drop: empty, send: empty, trayTitle: '' }), false);
  assert.equal(pace.pctShouldRun({ drop: { inBatches: [{}] }, send: empty }), true);
  assert.equal(pace.pctShouldRun({ drop: { receiving: [{}] }, send: empty }), true);
  assert.equal(pace.pctShouldRun({ drop: empty, send: { outBatches: [{}] } }), true);
  assert.equal(pace.pctShouldRun({ drop: empty, send: { sending: [{}] } }), true);
  assert.equal(pace.pctShouldRun({ trayTitle: ' ↓4%' }), true);
  assert.equal(pace.pctShouldRun({ windowOnScreen: true, streamLive: true }), false, 'the window and a live stream do not read the percentage');
});

test('permissions are polled only while the window is visible and one is missing', () => {
  const missing = { screen: 'denied', accessibility: false, inputMonitoring: false };
  const granted = { screen: 'granted', accessibility: true, inputMonitoring: true };
  assert.equal(pace.permShouldPoll({ visible: false, permissions: missing }), false);
  assert.equal(pace.permShouldPoll({ visible: true, permissions: granted }), false);
  assert.equal(pace.permShouldPoll({ visible: true, permissions: missing }), true);
  assert.equal(pace.permShouldPoll({ visible: true, permissions: { screen: 'granted', accessibility: true, inputMonitoring: null } }), false);
  assert.equal(pace.permShouldPoll({ visible: true, permissions: { screen: 'granted', accessibility: false, inputMonitoring: true } }), true);
  assert.equal(pace.permShouldPoll({ visible: true, permissions: { screen: 'granted', accessibility: true, inputMonitoring: false } }), true);
});

test('addresses are checked while a peer is connected or the window is watched', () => {
  assert.equal(pace.addrShouldPoll({}), false);
  assert.equal(pace.addrShouldPoll({ peerConnected: false, windowWatching: false }), false);
  assert.equal(pace.addrShouldPoll({ peerConnected: true, windowWatching: false }), true);
  assert.equal(pace.addrShouldPoll({ peerConnected: false, windowWatching: true }), true);
});

test('bluetooth stays at 3 s while it is read and at 20 s when it is not', () => {
  assert.equal(pace.bleIntervalMs({}), 20000);
  assert.equal(pace.bleIntervalMs({ peerConnected: false, windowWatching: false }), 20000);
  assert.equal(pace.bleIntervalMs({ peerConnected: true }), 3000);
  assert.equal(pace.bleIntervalMs({ windowWatching: true }), 3000);
});

test('main.js asks those decisions and keeps the address poll on its 5 s interval', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /if \(!wakePace\.pctShouldRun\(\{ drop: dv, send: sv, trayTitle: title \}\)\) \{ clearInterval\(pctTimer\); pctTimer = null; \}/);
  assert.match(main, /if \(!wakePace\.permShouldPoll\(permNow\(\)\)\) \{ clearInterval\(permTimer\); permTimer = null; return; \}/);
  assert.match(main, /if \(!wakePace\.addrShouldPoll\(\{/);
  assert.match(main, /const ms = wakePace\.bleIntervalMs\(\{/);
  assert.match(main, /setInterval\(pctTick, 500\)/);
  assert.match(main, /setInterval\(permTick, 3000\)/);
  assert.match(main, /setInterval\(bleTick, ms\)/);
  const addr = main.slice(main.indexOf('let addrKey'));
  assert.match(addr, /addrShouldPoll\(/);
  assert.match(addr, /if \(key === addrKey\) return;/);
  assert.doesNotMatch(addr.slice(0, addr.indexOf('}, 5000)')), /isVisible\(\)/);
});
