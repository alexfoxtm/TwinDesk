// TwinDesk — GPL-3.0, see LICENSE.
// Run with: node --test mac/test/photo-save-as.test.js
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { T, OS } = require('../../shared/protocol.js');
const { PhoneHub } = require('../../shared/phonehub.js');
const { Route } = require('../../shared/hub-route.js');
const { action } = require('../photo-save-as.js');

const electron = {
  app: { getPath() { throw new Error('expected the test folder'); } },
  dialog: {},
  shell: { showItemInFolder() { throw new Error('test has reveal off'); } },
};
const load = Module._load;
Module._load = function (id, ...args) {
  return id === 'electron' ? electron : load.call(this, id, ...args);
};
const { Drop } = require('../drop.js');
test.after(() => { Module._load = load; });

const bytes = Buffer.from('original photo bytes');
const end = { t: T.FILE_END, id: 'file', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const chunk = { t: T.FILE_CHUNK, id: 'file', seq: 0, data: bytes.toString('base64') };
const socket = () => ({ readyState: 1 });

function setup(t, mesh) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-photo-save-as-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const sent = [];
  const ctx = { authed: true, deviceId: 'phone', name: 'Phone', os: OS.ANDROID, transport: 'ip', ws: socket(), alt: socket() };
  const session = {
    id: ctx.deviceId, peerOs: ctx.os, ctx, hostUp: true, connected: true, transport: 'ip',
    status: {}, displayName: () => ctx.name, send: (msg) => { sent.push(msg); return true; },
  };
  const route = mesh ? new Route({ sessions: new Map([[session.id, session]]) }, () => session.id) : null;
  const server = route ? Object.assign(route, { route, sendToClient: (msg) => route.send(msg) })
    : Object.assign(new EventEmitter(), { current: ctx, outbound: (c) => c.ws, sendToClient: session.send, sendNow: session.send });
  route?.refresh();
  const settings = { hub: { media: true }, files: { folder: dir, acceptDrops: false, reveal: false } };
  const drop = new Drop({ server, helper: new EventEmitter(), getSettings: () => settings });
  const phone = new PhoneHub({ server, getSettings: () => settings, save() {},
    savePhotoAs: action(drop, () => ({ isDestroyed: () => false }), (s) => s) });
  phone.on('change', () => drop.checkPhotoSave());
  const data = [];
  phone.on('data', (m) => data.push(m));
  const receive = (m, ws = ctx.ws) => route ? route.deliver(m, ws) : server.emit(`t:${m.t}`, m, ctx, ws);
  const listing = { t: T.MEDIA_LIST, items: [{ id: 'i123', name: '../bad\n:name.jpg' }] };
  const enable = () => {
    receive({ t: T.HUB_STATE, media: { perm: 'ok', saveAs: true } });
    receive(listing);
  };
  const click = (key = data.at(-1)?.saveKey) => phone.act({ do: 'savePhotoAs', ...listing.items[0], key });
  const requests = () => sent.filter((m) => m.t === T.MEDIA_SAVE_AS);
  const target = path.join(dir, 'picked.jpg');
  const offer = (batch, extra = {}, ws = ctx.ws) => receive({
    t: T.FILE_OFFER, id: 'file', count: 1, index: 0, drop: 'photo-save-as', batch, size: bytes.length,
    name: 'sender.jpg', rel: 'sender.jpg', ...extra,
  }, ws);
  const flush = async () => {
    const f = drop.active.get('file');
    if (f) await f.q;
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { dir, ctx, server, settings, drop, phone, receive, enable, click, requests, target, offer, flush, sent };
}

test('Save As publishes only the verified single photo on its direct or selected mesh route', async (t) => {
  for (const mesh of [false, true]) {
    const s = setup(t, mesh);
    const { ctx, sent, target } = s;
    fs.writeFileSync(target, 'previous');
    electron.dialog.showSaveDialog = (_, options) => {
      assert.equal(options.defaultPath, path.join(s.dir, 'bad__name.jpg'));
      return { filePath: target };
    };
    electron.dialog.showMessageBox = () => ({ response: 1 });
    s.receive({ t: T.HUB_STATE, media: { perm: 'ok' } });
    assert.equal(await s.click(), false, 'old Android keeps ordinary Save');
    s.enable();
    assert.equal(await s.click(), true);
    const [request] = s.requests();
    assert.equal(request.id, 'i123');
    assert.match(request.batch, /^[0-9a-f-]{36}$/);
    s.offer(request.batch, { drop: 'send', id: 'other' });
    s.offer(request.batch, {}, ctx.alt);
    s.offer('wrong-batch', { id: 'wrong' });
    assert.equal(s.drop.active.size, 0);
    assert.equal(s.drop.asked.open, null);
    s.offer(request.batch);
    assert(sent.some((m) => m.t === T.FILE_ACCEPT && m.id === 'file'));
    s.receive(chunk, ctx.alt);
    s.receive(chunk);
    s.receive(end, ctx.alt);
    await s.flush();
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
    s.receive(end);
    await s.flush();
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(fs.readdirSync(s.dir), ['picked.jpg']);
    assert(sent.some((m) => m.t === T.FILES_DONE && m.batch === request.batch && m.ok));
    assert.equal(s.settings.files.folder, s.dir);
  }
});

test('cancel, socket replacement, and a newly occupied destination leave the file untouched', async (t) => {
  const s = setup(t, true);
  const { ctx, target } = s;
  s.enable();
  electron.dialog.showSaveDialog = () => ({ canceled: true });
  assert.equal(await s.click(), false);
  assert.equal(s.requests().length, 0);
  let closeDialog;
  electron.dialog.showSaveDialog = () => new Promise((resolve) => { closeDialog = resolve; });
  const oldKey = s.phone.view.photoSaveKey;
  const waiting = s.click();
  ctx.ws = socket();
  s.server.refresh();
  s.server.emit('transport');
  assert.equal(s.sent.at(-1).t, T.HUB_POLICY, 'the new socket gets its own capability state');
  s.enable();
  closeDialog({ filePath: target });
  assert.equal(await waiting, false);
  assert.equal(await s.click(oldKey), false);
  assert.equal(s.requests().length, 0);

  electron.dialog.showSaveDialog = () => ({ filePath: target });
  assert.equal(await s.click(), true);
  s.offer(s.requests().at(-1).batch);
  s.receive(chunk);
  fs.writeFileSync(target, 'appeared meanwhile');
  s.receive(end);
  await s.flush();
  assert.equal(fs.readFileSync(target, 'utf8'), 'appeared meanwhile');
  assert.equal(s.drop.recent[0].ok, false);

  electron.dialog.showMessageBox = () => ({ response: 0 });
  assert.equal(await s.click(), false);
  assert.equal(s.requests().length, 1, 'declining replacement sends no request');
  electron.dialog.showMessageBox = () => ({ response: 1 });
  assert.equal(await s.click(), true);
  s.offer(s.requests().at(-1).batch);
  s.receive(chunk);
  s.receive(end);
  const writing = s.drop.active.get('file').q;
  ctx.released = true;
  s.server.drop();
  await writing;
  await s.flush();
  assert.equal(fs.readFileSync(target, 'utf8'), 'appeared meanwhile');
  assert.deepEqual(fs.readdirSync(s.dir), ['picked.jpg']);
  assert.equal(s.drop.recent[0].ok, false);
});
