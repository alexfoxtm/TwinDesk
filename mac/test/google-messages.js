// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { GoogleMessages, fingerprints } = require('../google-messages');

test('Google Messages scopes the inbox and invalidates it on helper outage or Disconnect', async () => {
  let owner = 'fixture-owner';
  let child;
  const sent = [];
  const gm = new GoogleMessages({
    current: () => owner, enabled: () => true, change() {},
    launch() {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stdin.on('data', (chunk) => sent.push(JSON.parse(chunk)));
      child.stdin.on('finish', () => child.emit('close'));
      return child;
    },
  });
  const event = (obj) => child.stdout.write(JSON.stringify(obj) + '\n');
  assert.equal(gm.view().state, 'disconnected');
  await gm.starting;
  child.stdout.write('synthetic-private-value\n');
  event({ type: 'session', session: 'synthetic-private-value' });
  assert.equal(gm.view().state, 'disconnected');

  event({ type: 'conversations', items: [{ id: 'thread', at: 1000, addrs: ['+12025550100'], snippet: 'fixture', snippetMe: false, reply: true }] });
  assert.equal(gm.view().state, 'connected');
  assert.deepEqual(gm.view().rows[0].fingerprints[0].matches, fingerprints(['+12025550100'], false, 'fixture'));
  assert.notDeepEqual(gm.view().rows[0].fingerprints[0].matches, fingerprints(['2025550100'], false, 'fixture'));
  assert.ok(!JSON.stringify(gm.view()).includes('synthetic-private-value'));
  assert.equal(await gm.action({ op: 'history', owner: 'other-owner', chat: 'thread' }), false);
  const opened = gm.action({ op: 'history', owner, chat: 'thread' });
  event({ type: 'history', chat: 'thread', items: [{ id: 'message', at: 1000, me: false }] });
  event({ type: 'result', ref: sent.at(-1).ref, ok: true });
  assert.equal(await opened, true);
  assert.equal(gm.view().history.items.length, 1);
  const photo = gm.action({ op: 'photo', owner, chat: 'thread', message: 'message', part: 0, photoView: 17 });
  assert.equal(sent.at(-1).photoView, 17, 'the helper can distinguish visits to cached history');
  const image = 'data:image/png;base64,AAAA';
  event({ type: 'photo', chat: 'thread', ref: sent.at(-1).ref, data: image });
  assert.equal(await photo, image);
  assert.equal(gm.view().history.items.length, 1);

  const send = { op: 'send', owner, chat: 'thread', text: 'fixture', allowCarrier: true };
  const dispatched = gm.action(send);
  assert.equal(sent.at(-1).op, 'send');
  event({ type: 'state', state: 'offline' });
  assert.equal(await dispatched, false, 'loss after writing the request is an uncertain dispatch');
  assert.equal(gm.view().rows.length, 0);
  assert.equal(gm.view().history, null);
  assert.equal(await gm.action({ op: 'send', owner, chat: 'thread', text: 'fixture' }), false);
  const count = sent.length;
  assert.equal(await gm.action(send), 'not-dispatched');
  assert.equal(sent.length, count);
  event({ type: 'conversations', items: [{ id: 'replacement', reply: true }] });
  assert.equal(await gm.action(send), false, 'a removed conversation never grants fallback while connected');
  assert.equal(sent.length, count);
  const disconnected = gm.action({ op: 'disconnect', owner });
  assert.equal(sent.at(-1).op, 'disconnect');
  event({ type: 'state', state: 'disconnected', wipe: true });
  assert.equal(await disconnected, true);
  assert.equal(await gm.action(send), false);
  owner = '';
  assert.equal(gm.view(), null);
  await gm.retiring;
});
