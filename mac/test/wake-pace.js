// The menu-bar percentage, the address poll, the permission poll and the
// Bluetooth tick run only while something reads them. Run: node mac/test/wake-pace.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

test('addresses are checked only while the window is watched', () => {
  assert.equal(pace.addrShouldPoll({}), false);
  assert.equal(pace.addrShouldPoll({ peerConnected: false, windowWatching: false }), false);
  assert.equal(pace.addrShouldPoll({ peerConnected: true, windowWatching: false }), false);
  assert.equal(pace.addrShouldPoll({ peerConnected: false, windowWatching: true }), true);
  assert.equal(pace.addrShouldPoll({ peerConnected: true, windowWatching: true }), true);
});

test('bluetooth stays at 3 s while the window is watched or Wi-Fi quiet is still settling', () => {
  assert.equal(pace.bleIntervalMs({}), 20000);
  assert.equal(pace.bleIntervalMs({ peerConnected: false, windowWatching: false }), 20000);
  assert.equal(pace.bleIntervalMs({ peerConnected: true }), 3000, 'an omitted settle flag keeps the 3 s session pace');
  assert.equal(pace.bleIntervalMs({ windowWatching: true }), 3000);
  assert.equal(pace.bleIntervalMs({ peerConnected: true, windowWatching: false, bleSettled: false }), 3000);
  assert.equal(pace.bleIntervalMs({ peerConnected: true, windowWatching: true, bleSettled: true }), 3000, 'an open window stays at 3 s after the settle');
  assert.equal(pace.bleIntervalMs({ peerConnected: true, windowWatching: false, bleSettled: true }), 20000, 'connected, hidden and settled slows to 20 s');
  assert.equal(pace.bleIntervalMs({ peerConnected: false, windowWatching: false, bleSettled: true }), 20000);
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
  assert.match(main, /noteAddresses\(\);\n    addrArm\(\);/);
  const tick = main.slice(main.indexOf('  const bleTick = () => {'), main.indexOf('  const armBle = () => {'));
  assert.match(tick, /\n    armBle\(\);/, 'the tick reschedules when bleOff flips');
  assert.match(main, /peer\.on\('transport', refreshBlePace\)/);
  assert.match(main, /svc\.net\.on\('change', refreshBlePace\)/);
});

test('the address interval is not running while the window is hidden', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('  let addrKey = ');
  const end = main.indexOf('  // While Setup is on screen', start);
  assert.ok(start > 0 && end > start);
  const timers = [];
  let watching = false;
  let reads = 0;
  const ctx = {
    wakePace: pace,
    win: { isDestroyed: () => false },
    controlWatch: { watching: () => watching },
    interfaces: () => [{ name: 'en0', address: '10.0.0.2' }],
    readDefaultIf() { reads += 1; },
    pushState() {},
    setInterval(fn, ms) {
      const t = { fn, ms, cleared: false, unref() {} };
      timers.push(t);
      return t;
    },
    clearInterval(t) { if (t) t.cleared = true; },
  };
  vm.runInNewContext(main.slice(start, end) + '\nglobalThis.__addr = { addrArm, noteAddresses, get addrTimer() { return addrTimer; } };', ctx);
  assert.equal(timers.length, 0, 'defining the poll does not start it');
  ctx.__addr.addrArm();
  ctx.__addr.noteAddresses();
  assert.equal(timers.length, 0, 'hidden: no 5 s timer');
  assert.equal(ctx.__addr.addrTimer, null);
  assert.equal(reads, 0, 'hidden: addresses are not read, peer or not');
  watching = true;
  ctx.__addr.noteAddresses();
  ctx.__addr.addrArm();
  assert.equal(reads, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
  assert.equal(timers[0].cleared, false);
  watching = false;
  ctx.__addr.addrArm();
  assert.equal(timers[0].cleared, true, 'hiding stops the address timer');
  assert.equal(ctx.__addr.addrTimer, null);
  const after = reads;
  ctx.__addr.noteAddresses();
  timers[0].fn();
  assert.equal(reads, after, 'a leftover tick does not read while hidden');
});

test('bluetooth slows to 20 s once a hidden session has settled, and returns to 3 s while it has not', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('  const armBle = () => {');
  const end = main.indexOf('  refreshBlePace = () => { bleTick(); armBle(); };', start);
  assert.ok(start > 0 && end > start);
  const intervals = [];
  const ctx = {
    wakePace: pace,
    bleOff: false,
    bleTimer: null,
    bleEvery: 0,
    bleTick() {},
    peer: { current: { transport: 'ip', address: '10.0.0.8' } },
    settings: { net: { bleWifiOff: true, bleInput: false } },
    svc: { net: { onGroup: false } },
    win: { isDestroyed: () => false },
    controlWatch: { watching: () => ctx.watching },
    watching: false,
    setInterval(fn, ms) {
      const t = { fn, ms, cleared: false, unref() {} };
      intervals.push(t);
      return t;
    },
    clearInterval(t) { if (t) t.cleared = true; },
  };
  vm.runInNewContext(main.slice(start, end) + '\nglobalThis.armBle = armBle;', ctx);
  ctx.armBle();
  assert.equal(ctx.bleEvery, 3000, 'connected, hidden, still settling stays at 3 s');
  ctx.bleOff = true;
  ctx.armBle();
  assert.equal(ctx.bleEvery, 20000, 'bleOff true slows the hidden session');
  assert.equal(intervals[0].cleared, true);
  ctx.watching = true;
  ctx.armBle();
  assert.equal(ctx.bleEvery, 3000, 'an open window goes back to 3 s');
  ctx.watching = false;
  ctx.bleOff = false;
  ctx.peer.current = { transport: 'ble', address: '10.0.0.8' };
  ctx.armBle();
  assert.equal(ctx.bleEvery, 20000, 'a Bluetooth session is not in the Wi-Fi settle, so it is not held at 3 s');
  ctx.peer.current = { transport: 'ip', address: '127.0.0.1' };
  ctx.armBle();
  assert.equal(ctx.bleEvery, 20000, 'USB is not the Wi-Fi settle');
  ctx.peer.current = { transport: 'ip', address: '10.0.0.8' };
  ctx.svc.net.onGroup = true;
  ctx.armBle();
  assert.equal(ctx.bleEvery, 20000, 'a Wi-Fi Direct group is not the settle');
  ctx.svc.net.onGroup = false;
  ctx.bleOff = false;
  ctx.armBle();
  assert.equal(ctx.bleEvery, 3000, 'back on Wi-Fi with Bluetooth still up: 3 s until it settles');
});
