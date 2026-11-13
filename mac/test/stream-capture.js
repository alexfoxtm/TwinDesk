// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Run with: node --test mac/test/stream-capture.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');

const originalLoad = Module._load;
const ipcMain = new EventEmitter();
ipcMain.handle = () => {};
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    BrowserWindow: class {}, ipcMain,
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    desktopCapturer: { getSources: async () => [{ id: 'screen:2:0', display_id: '2' }] },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
  };
  if (request === './audiohub.js' || request === '../audiohub.js') return { loopback: () => true };
  return originalLoad.apply(this, arguments);
};
const { Stream } = require('../stream.js');
const { Stream: MeshStream } = require('../mesh/stream.js');
Module._load = originalLoad;

test('passes selected display, bounded dimensions and audio to the capture window', async () => {
  const server = new EventEmitter();
  server.current = { os: 'android', transport: 'ip' };
  server.sendToClient = () => {};
  const displays = new EventEmitter();
  displays.target = () => ({ id: 2, label: 'Display', pixelWidth: 5120, pixelHeight: 2880, hz: 60 });
  const settings = { bitrateMbps: 12, streamMaxHeight: 1080, sharing: { on: true, audio: true } };
  const stream = new Stream(server, displays, () => settings, { release() {}, loopback() {} });
  const sent = [];
  stream._ensureWindow = async () => { stream.win = { isDestroyed: () => false, webContents: { send: (channel, msg) => sent.push({ channel, msg }) } }; };
  await stream.restart('test');
  const start = sent.find((entry) => entry.channel === 'start');
  assert.ok(start, 'capture window receives a start message');
  assert.equal(start.msg.sourceId, 'screen:2:0');
  assert.equal(start.msg.width, 1920);
  assert.equal(start.msg.height, 1080);
  assert.equal(start.msg.audio, 'loopback');
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

test('refuses a capture source for a different selected display', async () => {
  const server = new EventEmitter();
  const displays = new EventEmitter();
  displays.target = () => ({ id: 3 });
  const stream = new Stream(server, displays, () => ({}), { release() {}, loopback() {} });
  await assert.rejects(stream._source(), /no screens/);
});
