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
  assert.ok(gm.view().rows[0].fingerprints[0].matches.includes(fingerprints(['2025550100'], false, 'fixture')[0]));
  assert.ok(!JSON.stringify(gm.view()).includes('synthetic-private-value'));
  assert.equal(await gm.action({ op: 'history', owner: 'other-owner', chat: 'thread' }), false);
  const opened = gm.action({ op: 'history', owner, chat: 'thread' });
  event({ type: 'history', chat: 'thread', items: [{ id: 'message', at: 1000, me: false }] });
  event({ type: 'result', ref: sent.at(-1).ref, ok: true });
  assert.equal(await opened, true);
  assert.equal(gm.view().history.items.length, 1);

  event({ type: 'state', state: 'offline' });
  assert.equal(gm.view().rows.length, 0);
  assert.equal(gm.view().history, null);
  assert.equal(await gm.action({ op: 'send', owner, chat: 'thread', text: 'fixture' }), false);
  const disconnected = gm.action({ op: 'disconnect', owner });
  assert.equal(sent.at(-1).op, 'disconnect');
  event({ type: 'state', state: 'disconnected', wipe: true });
  assert.equal(await disconnected, true);
  owner = '';
  assert.equal(gm.view(), null);
  await gm.retiring;
});
