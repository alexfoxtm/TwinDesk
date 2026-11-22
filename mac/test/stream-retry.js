// A failing screen capture waits 2s, then 4, 8, 16 and 30s. Success, a new request,
// permission, a display change or a wake starts again at 2s, and at once.
// Run: node mac/test/stream-retry.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');

const pm = new EventEmitter();
const ipcMain = new EventEmitter();
ipcMain.handle = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    BrowserWindow: class {}, ipcMain, powerMonitor: pm,
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    desktopCapturer: { getSources: async () => [{ id: 'screen:2:0', display_id: '2' }] },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
  };
  if (request === './audiohub.js' || request === '../audiohub.js') return { loopback: () => true };
  return originalLoad.apply(this, arguments);
};
const { Stream } = require('../stream.js');
Module._load = originalLoad;

function useFakeTimers() {
  const timers = [];
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const t = { fn, ms: ms || 0 };
    timers.push(t);
    return t;
  };
  global.clearTimeout = (t) => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };
  return { timers, restore() { global.setTimeout = realSet; global.clearTimeout = realClear; } };
}

function make() {
  const server = new EventEmitter();
  server.current = null;
  server.sendToClient = () => {};
  const displays = new EventEmitter();
  displays.target = () => null;
  return new Stream(server, displays, () => ({ sharing: { on: true, audio: false } }), { release() {}, loopback() {} });
}

test('retries wait 2, 4, 8, 16 then 30 seconds, and a new request starts again at 2', async () => {
  const fake = useFakeTimers();
  try {
    const stream = make();
    const want = [2000, 4000, 8000, 16000, 30000, 30000];
    for (const ms of want) {
      stream._scheduleRetry();
      assert.equal(fake.timers.at(-1).ms, ms);
    }
    await stream.restart('sharing on'); // the user asked again: the counter goes back
    stream._scheduleRetry();
    assert.equal(fake.timers.at(-1).ms, 2000);
  } finally {
    fake.restore();
  }
});

test('a failure the capture window reports waits 2, 4, 8, 16 then 30 seconds', async () => {
  const fake = useFakeTimers();
  try {
    const server = new EventEmitter();
    server.current = { os: 'android', transport: 'ip' };
    server.sendToClient = () => {};
    const displays = new EventEmitter();
    displays.target = () => ({ id: 'd1', label: 'D', pixelWidth: 100, pixelHeight: 100, hz: 60 });
    const s = new Stream(server, displays, () => ({ sharing: { on: true, audio: false }, bitrateMbps: 8 }), { release() {}, loopback() {} });
    s._ensureWindow = async () => { s.win = { isDestroyed: () => false, webContents: { send() {} } }; };
    s._source = async () => ({ id: 'screen:1:0' });
    await s.restart('sharing on');
    const tell = (status, extra) => ipcMain.emit('capture:state', { sender: s.win.webContents }, { session: s.active.session, status, ...extra });
    s._retryN = 2;
    tell('waiting for answer');
    tell('connecting');
    ipcMain.emit('capture:stats', { sender: s.win.webContents }, { session: s.active.session, fps: 0, mbps: 0 });
    assert.equal(s._retryN, 2, 'the offer going out is not a capture that works');
    s._retryN = 0;
    const want = [2000, 4000, 8000, 16000, 30000];
    for (let i = 0; i < want.length; i++) {
      tell('failed');
      const t = fake.timers.at(-1);
      assert.equal(t && t.ms, want[i], `failure ${i + 1}`);
      fake.timers.splice(fake.timers.indexOf(t), 1);
      t.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    s._scheduleRetry();
    const pending = s.retryTimer;
    tell('live');
    assert.ok(!fake.timers.includes(pending) && s.retryTimer === null, 'live clears the scheduled retry');
    assert.equal(s._retryN, 0, 'live capture: the next failure waits 2s');
    ipcMain.emit('capture:stats', { sender: s.win.webContents }, { session: s.active.session, fps: 30, mbps: 1 });
    s._retryN = 4;
    ipcMain.emit('capture:stats', { sender: s.win.webContents }, { session: s.active.session, fps: 30, mbps: 1 });
    assert.equal(s._retryN, 0, 'frames flowing clear the wait');
    tell('failed');
    assert.equal(fake.timers.at(-1).ms, 2000, 'the failure after a real success starts at 2s');
  } finally {
    fake.restore();
  }
});

test('a wake or a granted permission retries at once, and a started capture clears the wait', async () => {
  const stream = make();
  stream._retryN = 4;
  const pending = setTimeout(() => {}, 50);
  stream.retryTimer = pending;
  try {
    await stream.nudge('wake');
  } finally {
    clearTimeout(pending);
    clearTimeout(stream.retryTimer);
  }
  assert.equal(stream._retryN, 0, 'wake resets the wait');
  assert.equal(stream.view.status, 'nothing connected', 'wake retried immediately');

  stream._retryN = 4;
  await stream.nudge('permission granted');
  assert.equal(stream._retryN, 0);

  stream._retryN = 0;
  stream.retryTimer = null;
  const session = stream.session;
  await stream.nudge('wake');
  assert.equal(stream.session, session, 'a healthy capture is not restarted on wake');

  const server = new EventEmitter();
  const socket = {};
  server.current = { os: 'android', transport: 'ip', conn: socket };
  server.sendToClient = () => {};
  server.outbound = (ctx) => (ctx === server.current ? socket : null);
  const displays = new EventEmitter();
  displays.target = () => ({ id: 2, label: 'Display', pixelWidth: 1920, pixelHeight: 1080, hz: 60 });
  const live = new Stream(server, displays, () => ({ bitrateMbps: 8, streamMaxHeight: 1080, sharing: { on: true, audio: false } }), { release() {}, loopback() {} });
  live._ensureWindow = async () => { live.win = { isDestroyed: () => false, webContents: { send() {} } }; };
  live._retryN = 4;
  await live.restart('retry');
  assert.equal(live._retryN, 4, 'sending start is not a capture that works');
  ipcMain.emit('capture:state', { sender: live.win.webContents }, { session: live.active.session, status: 'live' });
  assert.equal(live._retryN, 0, 'a live capture waits 2s next time');
});

test('wake is subscribed once, permission nudges from the main process, and Multi-device still retries every 2s', () => {
  const mac = fs.readFileSync(path.join(__dirname, '../stream.js'), 'utf8');
  const mesh = fs.readFileSync(path.join(__dirname, '../mesh/stream.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(mac, /Math\.min\(30000/);
  assert.match(mac, /powerMonitor && typeof powerMonitor\.on === 'function'/);
  assert.match(mac, /nudge\('wake'\)/);
  assert.match(mac, /restart\('display changed'\)/);
  assert.match(mac, /restart\('display available'\)/);
  assert.match(main, /prevScreen !== 'granted' && state\.permissions\.screen === 'granted'[\s\S]{0,180}nudge\('permission granted'\)/);
  assert.match(mesh, /setTimeout\(\(\) => this\.restart\('retry'\), RETRY_MS\)/);
  assert.doesNotMatch(mesh, /Math\.min\(30000/);
});
