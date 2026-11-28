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

test('attachment Save uses a current exact part and rejects a session replaced while the dialog is open', async (t) => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const Module = require('node:module');
  const { setupGoogleMessages } = require('../google-messages');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'twindesk-attachment-test.'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let handler, gm, changeSession = false;
  let enabledFlag = true, dialogMutate = () => {}, fetchMutate = () => {}, savePath;
  const dest = path.join(dir, 'fixture.pdf');
  const load = Module._load;
  Module._load = function (name, ...args) {
    return name === 'electron' ? { dialog: { showSaveDialog: async () => {
      if (changeSession) gm.session++;
      dialogMutate();
      return { canceled: false, filePath: savePath || dest };
    } } } : load.call(this, name, ...args);
  };
  t.after(() => { Module._load = load; });
  const frame = {};
  const wc = { mainFrame: frame };
  gm = setupGoogleMessages({ app: { on() {} }, ipcMain: { handle: (_name, fn) => { handler = fn; } },
    window: () => ({ webContents: wc }), current: () => 'owner', enabled: () => enabledFlag, change() {} });
  gm.owner = 'owner'; gm.active = true; gm.state = 'connected';
  gm.rows.set('chat', { id: 'chat' });
  gm.history = { chat: 'chat', items: [{ id: 'message', attachments: [{ part: 1, revision: 'a'.repeat(64), name: '../../fixture.pdf', mime: 'application/pdf', size: 7, save: true }] }] };
  const data = Buffer.from('%PDF-1');
  gm.child = { exitCode: null, signalCode: null, stdin: { writable: true, write(line) {
    const cmd = JSON.parse(line);
    gm.event({ type: 'attachment', chat: 'wrong', message: cmd.message, part: cmd.part, revision: cmd.revision, ref: cmd.ref, data: data.toString('base64') });
    assert.ok(gm.pending.has(cmd.ref), 'wrong chat cannot satisfy the request');
    gm.event({ type: 'attachment', chat: cmd.chat, message: cmd.message, part: cmd.part, revision: 'b'.repeat(64), ref: cmd.ref, data: data.toString('base64') });
    assert.ok(gm.pending.has(cmd.ref), 'a different media revision cannot satisfy the request');
    fetchMutate();
    gm.event({ type: 'attachment', chat: cmd.chat, message: cmd.message, part: cmd.part, revision: cmd.revision, ref: cmd.ref, data: data.toString('base64') });
  } } };
  const event = { sender: wc, senderFrame: frame };
  const request = { op: 'saveAttachment', owner: 'owner', chat: 'chat', message: 'message', part: 1, revision: 'a'.repeat(64) };
  assert.equal(await handler(event, request), true);
  assert.deepEqual(await fs.readFile(dest), data);
  assert.equal(await handler(event, { ...request, part: 9 }), false);
  assert.equal(await handler(event, { ...request, op: 'attachment' }), false, 'bytes are never returned to the renderer');
  changeSession = true;
  assert.equal(await handler(event, request), false);
  changeSession = false;
  const part = gm.history.items[0].attachments[0];
  for (const mutate of [() => { enabledFlag = false; }, () => { gm.closed = true; }, () => { part.revision = 'b'.repeat(64); }]) {
    dialogMutate = mutate;
    assert.equal(await handler(event, request), false, 'dialog-time authorization or payload change refuses Save');
    enabledFlag = true; gm.closed = false; part.revision = 'a'.repeat(64);
  }
  dialogMutate = () => {};
  for (const mutate of [() => { enabledFlag = false; }, () => { gm.closed = true; }, () => { part.revision = 'b'.repeat(64); }]) {
    fetchMutate = mutate;
    assert.equal(await handler(event, request), false, 'download-time authorization or payload change refuses the write');
    enabledFlag = true; gm.closed = false; part.revision = 'a'.repeat(64);
  }
  fetchMutate = () => {};
  savePath = dir;
  assert.equal(await handler(event, request), false, 'disk write errors return false');
  assert.deepEqual(await fs.readFile(dest), data);

});
