// The files engine stays up only when a welcome promised its port. A client that did not
// ask (a phone on the cable) and a computer that is only nearby do not keep the process.
// Run: node mac/test/fx2-session.js
'use strict';

process.env.TWINDESK_NO_IL = '1';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Peer } = require('../peer.js');

function setup() {
  const server = new EventEmitter();
  server.https = { on() {} };
  server.tls = { key: 'k', cert: 'c' };
  server.current = null;
  const link = new EventEmitter();
  link.poke = () => {};
  const peer = new Peer(server, link);
  const calls = [];
  assert.ok(peer.fx2, 'fx2 is on for this test');
  peer.fx2.need = (key, on) => { calls.push([key, !!on]); };
  return { server, link, peer, calls };
}

test('a host session keeps the files engine only when the welcome included its port', () => {
  const { server, link, calls } = setup();
  server.emit('client', { os: 'android', fx2: 0 });
  assert.deepEqual(calls, [['host', false]], 'a phone on the cable did not get a port, so the process is not held');
  server.emit('client', { os: 'android', fx2: 4433 });
  assert.deepEqual(calls.at(-1), ['host', true], 'the promised port has to keep listening for an incoming transfer');
  server.current = null;
  server.emit('closed', { authed: true });
  assert.deepEqual(calls.at(-1), ['host', false]);
  link.emit('welcome', { name: 'Other Mac' });
  assert.deepEqual(calls.at(-1), ['guest', true], 'a computer we connected to still holds its own session');
  link.emit('closed', {});
  assert.deepEqual(calls.at(-1), ['guest', false]);
});

test('a computer that is only nearby does not pin the files engine', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.equal(main.includes(".need('nearby'"), false);
});
