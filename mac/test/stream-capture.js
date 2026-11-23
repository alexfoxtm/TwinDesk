// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Run with: node --test mac/test/stream-capture.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('events');
const Module = require('module');

const originalLoad = Module._load;
const ipcMain = new EventEmitter();
ipcMain.handle = () => {};
let captureSources = [{ id: 'screen:2:0', display_id: '2' }];
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    BrowserWindow: class {}, ipcMain,
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    desktopCapturer: { getSources: async () => captureSources },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
  };
  if (request === './audiohub.js' || request === '../audiohub.js') return { loopback: () => true };
  return originalLoad.apply(this, arguments);
};
const { Stream } = require('../stream.js');
const { Stream: MeshStream } = require('../mesh/stream.js');

Module._load = originalLoad;

test('passes selected display, bounded dimensions and audio to the capture window', async () => {
  for (const Class of [Stream, MeshStream]) {
    const server = new EventEmitter();
    const socket = {};
    server.current = { os: 'android', transport: 'ip', conn: socket };
    server.sendToClient = () => {};
    server.outbound = (ctx) => ctx === server.current ? socket : null;
    const displays = new EventEmitter();
    displays.target = () => ({ id: 2, label: 'Display', pixelWidth: 5120, pixelHeight: 2880, hz: 60 });
    const settings = { bitrateMbps: 12, streamMaxHeight: 1080, sharing: { on: true, audio: true } };
    const stream = new Class(server, displays, () => settings, { release() {}, loopback() {} });
    const sent = [];
    stream._ensureWindow = async () => { stream.win = { isDestroyed: () => false, webContents: { send: (channel, msg) => sent.push({ channel, msg }) } }; };
    await stream.restart('test');
    const start = sent.find((entry) => entry.channel === 'start');
    assert.ok(start, 'capture window receives a start message');
    assert.equal(start.msg.sourceId, 'screen:2:0');
    assert.equal(start.msg.width, 1920);
    assert.equal(start.msg.height, 1080);
    assert.equal(start.msg.audio, 'loopback');
    assert.deepEqual(start.msg.detailSource, { width: 5120, height: 2880 });

    const detail = { t: 'rtc.detail', session: start.msg.session, height: 1440 };
    const from = (ws) => server.emit('t:rtc.detail', detail, Class === Stream ? server.current : { source: () => ws }, ws);
    from({});
    assert.equal(sent.length, 1, 'another socket cannot adjust this stream');
    from(socket);
    assert.deepEqual(sent.slice(1), [{ channel: 'remote', msg: detail }]);
    assert.equal(settings.streamMaxHeight, 1080, 'zoom does not change the saved baseline');
  }
});

test('refuses a capture source for a different selected display', async () => {
  const server = new EventEmitter();
  const displays = new EventEmitter();
  displays.target = () => ({ id: 3 });
  const stream = new Stream(server, displays, () => ({}), { release() {}, loopback() {} });
  // A selected display that is not in the capture list is refused. Headless recovery
  // reports NO_DISPLAY and waits, instead of the older "no screens" permission error.
  await assert.rejects(stream._source(), (err) => err && err.code === 'NO_DISPLAY' && /no display to share/.test(err.message));
});

test('does not use an unnamed source for a different remaining display', async () => {
  const server = new EventEmitter();
  const displays = new EventEmitter();
  displays.target = () => ({ id: 3 });
  displays.list = () => [{ id: 2 }];
  const stream = new Stream(server, displays, () => ({}), { release() {}, loopback() {} });
  captureSources = [{ id: 'screen:2:0', display_id: '' }];
  try {
    await assert.rejects(stream._source(), (err) => err && err.code === 'NO_DISPLAY');
  } finally {
    captureSources = [{ id: 'screen:2:0', display_id: '2' }];
  }
});

test('stats stay quiet until a window is watching or the stream is live, and frames still clear the retry', async () => {
  const { shouldSendStats } = require('../stats-send.js');
  assert.equal(shouldSendStats(undefined, { fps: 0, mbps: 0 }), true, 'mesh and an omitted flag still send every sample');
  assert.equal(shouldSendStats(true, { fps: 0, mbps: 0 }), true);
  assert.equal(shouldSendStats(false, { fps: 0, mbps: 0 }), false);
  assert.equal(shouldSendStats(false, { fps: 1, mbps: 0 }), true);
  assert.equal(shouldSendStats(false, { fps: 0, mbps: 0.1 }), true);
  const cap = fs.readFileSync(path.join(__dirname, '../capture.js'), 'utf8');
  const mac = fs.readFileSync(path.join(__dirname, '../stream.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(cap, /if \(!window\.TwinDeskStatsSend\.shouldSendStats\(me\.reportStats, \{ fps, mbps \}\)\) return;/);
  assert.match(mac, /if \(frames\) this\._captureReady\(\)/);
  assert.match(mac, /if \(!this\._statsOn\(\)\)/);
  assert.match(main, /svc\.stream\.setStatsWindow\(/);

  const server = new EventEmitter();
  server.current = { os: 'android', transport: 'ip' };
  server.sendToClient = () => {};
  const displays = new EventEmitter();
  displays.target = () => ({ id: 'd1', label: 'D', pixelWidth: 100, pixelHeight: 100, hz: 60 });
  const s = new Stream(server, displays, () => ({ sharing: { on: true, audio: false }, bitrateMbps: 8 }), { release() {}, loopback() {} });
  const sent = [];
  s._ensureWindow = async () => { s.win = { isDestroyed: () => false, webContents: { send: (ch, msg) => sent.push({ ch, msg }) } }; };
  s._source = async () => ({ id: 'screen:1:0' });
  let changes = 0;
  s.on('change', () => { changes += 1; });
  await s.restart('sharing on');
  const start = sent.find((e) => e.ch === 'start');
  assert.equal(start.msg.stats, false, 'a hidden window is not sent idle stats');
  const afterStart = changes;
  const emitStats = (fps, mbps) => ipcMain.emit('capture:stats', { sender: s.win.webContents }, { session: s.active.session, fps, mbps });
  s._retryN = 3;
  const waiting = {};
  s.retryTimer = waiting;
  emitStats(0, 0);
  assert.equal(s._retryN, 3, 'a zero sample does not clear the failure counter');
  assert.equal(s.retryTimer, waiting);
  assert.equal(changes, afterStart, 'a zero sample does not rebuild state');
  emitStats(24, 1);
  assert.equal(s._retryN, 0, 'frames clear the failure counter before the capture is live');
  assert.equal(s.retryTimer, waiting, 'frames do not cancel a retry until the capture is live');
  assert.equal(changes, afterStart, 'frames while hidden and not live do not rebuild state');
  assert.equal(s.view.fps, 24, 'the sample is kept for the next push');
  s.setStatsWindow(true);
  assert.equal(sent.some((e) => e.ch === 'stats-gate' && e.msg.on === true), true);
  emitStats(0, 0);
  assert.ok(changes > afterStart, 'a watched window receives the sample');
  const watched = changes;
  s.setStatsWindow(false);
  ipcMain.emit('capture:state', { sender: s.win.webContents }, { session: s.active.session, status: 'live' });
  emitStats(0, 0);
  assert.ok(changes > watched, 'a live stream still receives a zero sample while the window is hidden');
});

test('capture errors reach only the current viewer without raw error details', () => {
  for (const Class of [Stream, MeshStream]) {
    const sent = [];
    const context = { view: {}, server: { current: { deviceId: 'phone' }, sendToClient: (m) => sent.push(m) },
      getSettings: () => ({ sharing: { on: true } }), emit() {} };
    Class.prototype._setStatus.call(context, 'error: private system diagnostic');
    assert.deepEqual(sent, [{ t: 'stream.stop', reason: 'capture-unavailable' }]);
    Class.prototype._setStatus.call(context, 'starting');
    Class.prototype._setStatus.call(context, 'live');
    assert.equal(sent.length, 1, 'recovery is not mistaken for a capture failure');
    context.server.current = null;
    Class.prototype._setStatus.call(context, 'error: capture ended');
    assert.equal(sent.length, 1, 'no disconnected viewer receives status');
  }
});
