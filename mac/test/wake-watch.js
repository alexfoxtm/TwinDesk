// Pasteboard pace and the notification watch. The helper's timers follow these
// messages. Run: node mac/test/wake-watch.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    clipboard: { readText: async () => '', writeText: async () => {} },
    Notification: class { static isSupported() { return false; } },
    nativeImage: { createFromBuffer() { return {}; } },
  };
  return realLoad.apply(this, arguments);
};
const { Clipboard } = require('../clipboard.js');
const { Notifs } = require('../notifs.js');
const Quiet = require('../../shared/quiet.js');
Module._load = realLoad;

function helper() {
  const h = new EventEmitter();
  h.sent = [];
  h.running = true;
  h.send = (cmd, msg) => { h.sent.push({ cmd, msg }); };
  h.request = (cmd, msg) => { h.sent.push({ cmd, msg }); return Promise.resolve({ readable: true }); };
  return h;
}

test('the pasteboard watch is off until send is on, and 1 s only while the phone is idle', () => {
  const h = helper();
  const server = new EventEmitter();
  server.current = null;
  server.sendToClient = () => {};
  const settings = { clipboard: { enabled: false, send: true, receive: true, queue: true, historySize: 5, mode: 'switch' } };
  const clip = new Clipboard(server, h, () => settings, () => null);
  clip._watch(true);
  assert.deepEqual(h.sent.at(-1), { cmd: 'clipboardWatch', msg: { on: false, every: 0.25 } });
  settings.clipboard.enabled = true;
  server.current = { ws: {} };
  clip._watch();
  assert.deepEqual(h.sent.at(-1), { cmd: 'clipboardWatch', msg: { on: true, every: 0.25 } }, 'an active link stays at 0.25 s');
  const n = h.sent.length;
  clip._watch();
  assert.equal(h.sent.length, n, 'the same pace is not sent again');
  server.current.ws.quietPeer = true;
  clip._watch();
  assert.deepEqual(h.sent.at(-1).msg, { on: true, every: 1 }, 'a quiet phone slows the check');
  assert.equal(Quiet.seen(server.current.ws, { t: 'idle', on: false }), true);
  assert.equal(server.current.ws.quietPeer, false);
  assert.deepEqual(h.sent.at(-1).msg, { on: true, every: 0.25 }, 'activity returns to 0.25 s');
  server.current = null;
  clip.queueOwner = { pair: { id: 'away' } };
  clip._watch(true);
  assert.deepEqual(h.sent.at(-1).msg, { on: true, every: 0.25 }, 'the queue has no idle socket, so it stays fast');
});

test('notification polling stays off until send is accepted, and the database interval stays 1 s', async () => {
  const h = helper();
  const server = new EventEmitter();
  server.current = null;
  server.sendToClient = () => {};
  const settings = { notifs: { send: false, receive: false, muted: [] } };
  const n = new Notifs({ server, helper: h, getSettings: () => settings, saveSettings() {} });
  n._watch();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent.at(-1), { cmd: 'notifWatch', msg: { on: false } });
  settings.notifs.send = true;
  n.peerAccepts = true;
  server.current = { id: 'phone' };
  n._watch();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent.at(-1), { cmd: 'notifWatch', msg: { on: true } });
  settings.notifs.send = false;
  n.webWant = true;
  n._watch();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent.at(-1).msg, { on: true }, 'TwinDesk Web still asks for notifications');
  const swift = fs.readFileSync(path.join(__dirname, '../../mac-helper/Sources/macshare-helper/Notifs.swift'), 'utf8');
  assert.match(swift, /withTimeInterval: 1\.0/, 'the database poll is not slowed');
});

test('a pasteboard pace change does not reset the item, and mesh still gets 0.25 s', () => {
  const pb = fs.readFileSync(path.join(__dirname, '../../mac-helper/Sources/macshare-helper/Pasteboard.swift'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../../mac-helper/Sources/macshare-helper/main.swift'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8');
  assert.match(pb, /func set\(on: Bool, every: Double = 0\.25\)/);
  assert.match(pb, /let paceOnly = on && timer != nil/);
  assert.match(pb, /if !paceOnly \{\s*lastCount = -1/s);
  assert.match(main, /let every = \(msg\["every"\] as\? NSNumber\)\?\.doubleValue \?\? 0\.25/);
  assert.match(main, /pasteboardWatch\.set\(on: \(msg\["on"\] as\? Bool\) \?\? false, every: every\)/);
  assert.match(js, /const every = on && this\._peerIdle\(\) \? 1 : 0\.25/);
});
