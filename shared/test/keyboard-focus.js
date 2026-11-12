// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { Input } = require('../../mac/input');
const pause = () => new Promise(resolve => setTimeout(resolve, 180));
function fixture() {
  const server = new EventEmitter(), sent = [], requests = [];
  const ctx = { deviceId: 'phone', os: 'android', authed: true, ws: {} };
  let resolve, enabled = true;
  Object.defineProperty(server, 'current', { get: () => server.connected ? { ...ctx } : null });
  server.connected = true;
  server.sendToClient = message => sent.push(message);
  const helper = { send() {}, request(name) { requests.push(name); return new Promise(r => { resolve = r; }); } };
  new Input(server, helper, { target: () => ({ bounds: {} }) }, { enabled: () => enabled });
  return { server, ctx, sent, requests, click: () => server.emit('t:in.mu', { t: 'in.mu', b: 0 }, ctx),
    reply: result => resolve(result), disable: () => { enabled = false; } };
}
async function main() {
  const f = fixture();
  f.click(); await pause();
  assert.deepEqual(f.requests, ['textFocus']);
  f.reply({ editable: true, secure: true }); await Promise.resolve();
  assert.deepEqual(f.sent, [{ t: 'screen.textFocus', secure: true }]);
}
async function failure() {
  for (const cancel of [f => { f.server.connected = false; f.server.emit('closed'); }, f => f.disable()]) {
    const f = fixture(); f.click(); await pause(); cancel(f);
    f.reply({ editable: true, secure: true }); await Promise.resolve();
    assert.deepEqual(f.sent, [], 'stale focus must not open the keyboard');
  }
  const f = fixture(); f.click(); await pause(); f.reply({ editable: false }); await Promise.resolve();
  assert.deepEqual(f.sent, [], 'non-editable focus must not open the keyboard');
}
(async () => { await main(); await failure(); console.log('keyboard-focus: ok'); })().catch(error => { console.error(error); process.exitCode = 1; });
