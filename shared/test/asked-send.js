// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos › Save / Files › Save with Accept files off (#239). The phone answers with an ordinary
// file.offer drop:'send'. Mac Drop takes that one transfer from the authenticated session that
// asked, in one-to-one (the ctx itself) and in mesh (a fresh view of the same conn).
// One that works, and one where nothing else may.
// Run with: node shared/test/asked-send.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const P = require('../protocol.js');

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { shell: { showItemInFolder() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } };
  return load.call(this, id, ...args);
};
const { Drop } = require('../../mac/drop.js');
const { PhoneHub } = require('../phonehub.js');
const { wireAsked } = require('../asked-send.js');
Module._load = load;

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-send-'));
  const sent = [];
  const server = Object.assign(new EventEmitter(), {
    current: null,
    sendToClient: (m) => sent.push(m),
  });
  const settings = { files: { acceptDrops: false, reveal: false, clipReceived: false, folder: dir }, hub: { media: true, files: true, calls: false, messages: false } };
  const drop = new Drop({
    server,
    helper: Object.assign(new EventEmitter(), { request: async () => ({}), send() {} }),
    displays: { target: () => null },
    getSettings: () => settings,
  });
  const hub = new PhoneHub({ server, getSettings: () => settings, save() {} });
  wireAsked(hub, drop);
  const offer = (m, ctx) => server.emit(`t:${P.T.FILE_OFFER}`, m, ctx);
  return { dir, sent, server, drop, hub, offer };
}

// Mesh: every read of the phone is a new view. `conn` is the authenticated session.
function mesh(conn) {
  return { deviceId: conn.deviceId, name: conn.name, os: conn.os, authed: true, conn, ws: conn.ws || null };
}

// ---- it works: this session's Save is taken, and only that transfer ----
(async () => {
  const a = setup();
  const conn = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'sock' } };
  try {
    a.server.current = mesh(conn);
    a.server.emit('client', a.server.current);
    const before = a.sent.length;
    a.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['42'] } });
    assert.ok(a.sent.slice(before).some((m) => m.t === P.T.MEDIA_SAVE && m.ids[0] === '42'), 'the phone was asked');

    const body = Buffer.from('photo');
    const from = mesh(conn); // not the object PhoneHub handed to Drop
    a.offer({ t: P.T.FILE_OFFER, id: 'p1', name: 'PXL_1.jpg', size: body.length, drop: 'send', batch: 'save-1', count: 1 }, from);
    await until(() => a.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'p1'));
    a.server.emit(`t:${P.T.FILE_CHUNK}`, { t: P.T.FILE_CHUNK, id: 'p1', seq: 0, data: body });
    a.server.emit(`t:${P.T.FILE_END}`, { t: P.T.FILE_END, id: 'p1', sha256: sha(body) });
    await until(() => a.sent.some((m) => m.t === P.T.FILES_DONE && m.batch === 'save-1' && m.ok));
    assert.strictEqual(fs.readFileSync(path.join(a.dir, 'PXL_1.jpg')).equals(body), true, 'the asked-for photo is saved');

    a.offer({ t: P.T.FILE_OFFER, id: 'p2', name: 'other.jpg', size: 1, drop: 'send', batch: 'save-2', count: 1 }, mesh(conn));
    assert.ok(a.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === 'p2'), 'a second transfer is not part of that Save');
    console.log('  main: the asked session\'s one Send is saved');
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
  }

  // ---- nothing else: not asked, not this session, stopped, forgotten, or too late ----
  const b = setup();
  const phone = { authed: true, deviceId: 'pixel-1', name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'sock' } };
  try {
    assert.strictEqual(b.drop.allowAsked({ os: P.OS.ANDROID, deviceId: 'pixel-1' }), false, 'a session that has not authenticated grants nothing');
    b.server.current = mesh(phone);
    b.server.emit('client', b.server.current);
    b.offer({ t: P.T.FILE_OFFER, id: 'no', name: 'x.jpg', size: 1, drop: 'send', batch: 'u', count: 1 }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === 'no' && m.why === 'not_allowed'), 'a Send nobody asked for is refused');

    b.hub.act({ do: 'send', msg: { t: P.T.FS_SAVE, paths: ['DCIM/Camera/PXL_1.jpg'] } });
    const other = { authed: true, deviceId: 'other', name: 'Other', os: P.OS.ANDROID, ws: {} };
    b.offer({ t: P.T.FILE_OFFER, id: 'cross', name: 'x.jpg', size: 1, drop: 'send', batch: 'c', count: 1 }, mesh(other));
    const replaced = { authed: true, deviceId: phone.deviceId, name: 'Pixel', os: P.OS.ANDROID, ws: { id: 'next' } };
    b.offer({ t: P.T.FILE_OFFER, id: 'replay', name: 'x.jpg', size: 1, drop: 'send', batch: 'r', count: 1 }, mesh(replaced));
    b.offer({ t: P.T.FILE_OFFER, id: 'point', name: 'x.jpg', size: 1, drop: 'point', x: 0, y: 0 }, mesh(phone));
    b.server.emit('closed', mesh(phone));
    b.offer({ t: P.T.FILE_OFFER, id: 'stopped', name: 'x.jpg', size: 1, drop: 'send', batch: 's', count: 1 }, mesh(phone));
    b.server.current = mesh(phone);
    b.hub.act({ do: 'send', msg: { t: P.T.MEDIA_SAVE, ids: ['7'] } });
    b.hub.forget(false);
    b.offer({ t: P.T.FILE_OFFER, id: 'forgot', name: 'x.jpg', size: 1, drop: 'send', batch: 'f', count: 1 }, mesh(phone));
    const raw = { authed: true, deviceId: 'pixel-1', os: P.OS.ANDROID, ws: { id: 'single' } };
    b.drop.allowAsked(raw);
    b.offer({ t: P.T.FILE_OFFER, id: 'raw-next', name: 'x.jpg', size: 1, drop: 'send', batch: 'n', count: 1 }, { authed: true, deviceId: 'pixel-1', os: P.OS.ANDROID, ws: { id: 'later' } });
    const sock = { readyState: 1 };
    b.drop.allowAsked({ deviceId: 'pixel-1', os: P.OS.ANDROID, authed: true, conn: sock });
    b.offer({ t: P.T.FILE_OFFER, id: 'guest-next', name: 'x.jpg', size: 1, drop: 'send', batch: 'g', count: 1 }, { deviceId: 'pixel-1', os: P.OS.ANDROID, authed: true, conn: { readyState: 1 } });
    b.drop.allowAsked(mesh(phone), 20);
    await new Promise((r) => setTimeout(r, 40));
    b.offer({ t: P.T.FILE_OFFER, id: 'late', name: 'x.jpg', size: 1, drop: 'send', batch: 't', count: 1 }, mesh(phone));

    for (const id of ['cross', 'replay', 'point', 'raw-next', 'guest-next', 'stopped', 'forgot', 'late']) {
      assert.ok(b.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === id), `${id} was not refused`);
    }
    assert.ok(!b.sent.some((m) => m.t === P.T.FILE_ACCEPT), 'none of those offers were accepted');
    b.drop.allowAsked(mesh(phone));
    const part = { t: P.T.FILE_OFFER, name: 'part.jpg', size: 1, drop: 'send', batch: 'partial', count: 2 };
    b.offer({ ...part, id: 'first' }, mesh(phone));
    assert.ok(b.sent.some((m) => m.t === P.T.FILE_ACCEPT && m.id === 'first'));
    b.offer({ ...part, id: 'other-session' }, mesh(other));
    b.hub.stopped();
    b.offer({ ...part, id: 'after-stop' }, mesh(phone));
    for (const id of ['other-session', 'after-stop']) {
      assert.ok(b.sent.some((m) => m.t === P.T.FILE_REFUSE && m.id === id), `${id} continued a revoked batch`);
    }
    console.log('  failure: unsolicited, other device, replacement, Stop, Forget and timeout stay refused');
  } finally {
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
