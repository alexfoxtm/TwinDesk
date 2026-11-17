// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera photo backup: one copy into year/month, and a stopped request that must not finish.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PB = require('../photobackup.js');
const { EventEmitter } = require('node:events');
const { attach } = require('../../mac/photobackup.js');
const P = require('../protocol.js');

const scratch = process.env.HOME && fs.existsSync(path.join(process.env.HOME, 'orca', 'tmp'))
  ? path.join(process.env.HOME, 'orca', 'tmp')
  : os.tmpdir();

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function sock() { return { readyState: 1, released: false, authed: true }; }

function open(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sent = [];
  const ledger = new PB.Ledger(path.join(dir, 'photo-backup.json'));
  const mac = new PB.Mac(ledger, { send(msg) { sent.push(JSON.parse(JSON.stringify(msg))); } });
  return { sent, ledger, mac, s: sock() };
}

function arm(box, { peerPb = true, perm = 'ok', loc = true, api = 30, on = true, since = 1000, mrev = 1, folder }) {
  box.sent.length = 0;
  box.mac.bind(box.s, 'phone-1', { transport: 'ip', peerPb });
  box.mac.setLocal({ on, since, mrev, folder });
  box.mac.onState({ t: 'backup.state', on: true, since, rev: 1, perm, loc, api }, box.s);
}

function syncReq(sent) {
  const m = [...sent].reverse().find((x) => x.t === 'backup.sync');
  assert.ok(m, 'mac asks for a scan');
  return m.req;
}

function feed(box, items, { more = false, remain = false } = {}) {
  const req = syncReq(box.sent);
  box.sent.length = 0;
  box.mac.onInv({
    t: 'backup.inv', req: 'inv1', sync: req, rev: 1, mrev: box.mac.local.mrev, scan: 'scan1',
    page: 0, more, remain, items,
  }, box.s);
}

function takeOf(sent) {
  return sent.find((m) => m.t === 'backup.take');
}

function acceptBody(box, take, bytes) {
  const echo = {
    req: take.req, inv: take.inv, scan: take.scan, batch: take.batch,
    item: take.item, gen: take.gen, rev: take.rev, mrev: take.mrev,
  };
  box.mac.onAccept({ t: 'backup.accept', ...echo, size: take.size }, box.s);
  let seq = 0;
  for (let o = 0; o < bytes.length; o += PB.CHUNK) {
    const part = bytes.subarray(o, Math.min(o + PB.CHUNK, bytes.length));
    box.mac.onChunk({ t: 'backup.chunk', ...echo, seq, data: part.toString('base64') }, box.s);
    seq += 1;
  }
  box.mac.onEnd({ t: 'backup.end', ...echo, size: bytes.length, sha256: sha(bytes) }, box.s);
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.filter((p) => !p.endsWith('photo-backup.json') && !p.includes(`${path.sep}photo-backup.json.`));
}

function main() {
  const root = fs.mkdtempSync(path.join(scratch, 'twindesk-pb-main-'));
  const box = open(root);
  const folder = path.join(root, 'archive');
  fs.mkdirSync(folder);
  const taken = new Date(2026, 2, 15, 12, 0, 0).getTime();
  const ym = PB.yearMonth(taken, taken);
  const photo = Buffer.from('camera-photo-after-opt-in');
  const item = PB.itemKey('external_primary', 'vol-9', 41);
  arm(box, { folder });
  assert.strictEqual(box.mac.why(), '');
  feed(box, [
    { item: PB.itemKey('external_primary', 'vol-9', 7), gen: 1, size: 4, name: 'OLD.jpg', taken, added: 500 },
    { item, gen: 3, size: photo.length, name: 'IMG_1.jpg', taken, added: 5000 },
  ]);
  assert.ok(box.sent.some((m) => m.t === 'backup.refuse' && m.why === 'date' && String(m.item).endsWith(`${PB.SEP}7`)));
  const take = takeOf(box.sent);
  assert.ok(take, 'the photo after both opt-ins is asked for');
  assert.strictEqual(take.item, item);
  assert.strictEqual(take.gen, '3');
  assert.strictEqual(take.rev, 1);
  assert.strictEqual(take.mrev, 1);
  assert.ok(take.req && take.batch && take.inv === 'inv1' && take.scan === 'scan1');
  // An observer event during the last upload requires a fresh scan once that page drains.
  box.mac.onState({ t: 'backup.state', on: true, since: 1000, rev: 1, perm: 'ok', loc: true, api: 30 }, box.s);
  acceptBody(box, take, photo);
  assert.ok(syncReq(box.sent));
  assert.ok(box.sent.findIndex((m) => m.t === 'backup.done') < box.sent.findIndex((m) => m.t === 'backup.sync'));
  const done = box.sent.find((m) => m.t === 'backup.done');
  assert.ok(done && done.req === take.req && done.sha256 === sha(photo) && !Object.hasOwn(done, 'dest'));
  const dest = path.join(folder, ym.y, ym.m, 'IMG_1.jpg');
  assert.ok(fs.readFileSync(dest).equals(photo));
  const row = box.ledger.get('phone-1', item, 3);
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(row.sha, sha(photo));
  assert.strictEqual(row.size, photo.length);
  assert.strictEqual(row.dest, dest);
  assert.deepStrictEqual(filesUnder(folder), [dest]);

  const again = open(path.join(root, 'unused'));
  fs.rmSync(path.join(root, 'unused'), { recursive: true, force: true });
  const restarted = new PB.Mac(new PB.Ledger(path.join(root, 'photo-backup.json')), {
    send(msg) { again.sent.push(JSON.parse(JSON.stringify(msg))); },
  });
  again.mac = restarted;
  arm(again, { folder });
  feed(again, [{ item, gen: 3, size: photo.length, name: 'IMG_1.jpg', taken, added: 5000 }]);
  assert.ok(again.sent.some((m) => m.t === 'backup.have' && m.item === item));
  assert.ok(!takeOf(again.sent), 'a restart does not ask for the archived photo');
  assert.deepStrictEqual(filesUnder(folder), [dest]);

  const second = Buffer.from('second-photo-crash-after-link');
  const item2 = PB.itemKey('external_primary', 'vol-9', 42);
  arm(again, { folder, mrev: 1 });
  feed(again, [{ item: item2, gen: 1, size: second.length, name: 'IMG_2.jpg', taken, added: 6000 }]);
  const take2 = takeOf(again.sent);
  assert.ok(take2);
  // Simulate a process exit after link: take a copy of the persisted pending ledger before
  // the injected I/O failure runs normal runtime cleanup.
  const recoveryLedger = path.join(root, 'recover.json');
  again.mac.hooks.afterLink = () => {
    fs.copyFileSync(path.join(root, 'photo-backup.json'), recoveryLedger);
    throw new Error('crash');
  };
  acceptBody(again, take2, second);
  assert.ok(again.sent.some((m) => m.t === 'backup.refuse' && m.req === take2.req && m.why === 'disk'));
  const dest2 = path.join(folder, ym.y, ym.m, 'IMG_2.jpg');
  assert.ok(fs.readFileSync(dest2).equals(second));
  const recovered = new PB.Mac(new PB.Ledger(recoveryLedger), {
    send(msg) { again.sent.push(JSON.parse(JSON.stringify(msg))); },
  });
  assert.strictEqual(recovered.ledger.get('phone-1', item2, 1).state, 'done');
  again.mac = recovered;
  arm(again, { folder });
  feed(again, [{ item: item2, gen: 1, size: second.length, name: 'IMG_2.jpg', taken, added: 6000 }]);
  assert.ok(again.sent.some((m) => m.t === 'backup.have' && m.item === item2));
  assert.ok(!takeOf(again.sent));
  assert.deepStrictEqual(filesUnder(folder).sort(), [dest, dest2].sort());
  fs.rmSync(root, { recursive: true, force: true });
}

function failure() {
  const root = fs.mkdtempSync(path.join(scratch, 'twindesk-pb-fail-'));
  const box = open(root);
  const folder = path.join(root, 'archive');
  fs.mkdirSync(folder);
  const taken = new Date(2026, 2, 15, 12, 0, 0).getTime();
  const item = PB.itemKey('external_primary', 'vol-9', 41);
  const photo = Buffer.from('must-not-land-early');
  const row = { item, gen: 4, size: photo.length, name: 'IMG_1.jpg', taken, added: 5000 };

  arm(box, { folder, peerPb: false });
  assert.strictEqual(box.mac.why(), 'peer');
  box.mac.syncReq = 'stale';
  box.mac.onInv({ t: 'backup.inv', req: 'inv1', sync: 'stale', rev: 1, mrev: 1, scan: 'scan1', items: [row] }, box.s);
  assert.ok(!takeOf(box.sent));

  arm(box, { folder, perm: 'partial' });
  assert.strictEqual(box.mac.why(), 'partial');
  box.mac.syncReq = 'stale';
  box.mac.onInv({ t: 'backup.inv', req: 'inv1', sync: 'stale', rev: 1, mrev: 1, scan: 'scan1', items: [row] }, box.s);
  assert.ok(!takeOf(box.sent));

  arm(box, { folder, loc: false });
  assert.strictEqual(box.mac.why(), 'location');
  box.mac.syncReq = 'stale';
  box.mac.onInv({ t: 'backup.inv', req: 'inv1', sync: 'stale', rev: 1, mrev: 1, scan: 'scan1', items: [row] }, box.s);
  assert.ok(!takeOf(box.sent));
  assert.strictEqual(filesUnder(folder).length, 0);

  arm(box, { folder });
  feed(box, [row]);
  const take = takeOf(box.sent);
  assert.ok(take);
  const echo = {
    req: take.req, inv: take.inv, scan: take.scan, batch: take.batch,
    item: take.item, gen: take.gen, rev: take.rev, mrev: take.mrev,
  };
  box.mac.onAccept({ t: 'backup.accept', ...echo, size: photo.length }, box.s);
  box.mac.onChunk({ t: 'backup.chunk', ...echo, seq: 0, data: photo.toString('base64') }, box.s);
  assert.ok(box.mac.flight && box.mac.flight.part);
  const part = box.mac.flight.part;
  assert.strictEqual(box.ledger.get('phone-1', item, 4).state, 'receiving');
  const afterCrash = new PB.Ledger(path.join(root, 'photo-backup.json'));
  assert.strictEqual(afterCrash.get('phone-1', item, 4), null);
  assert.ok(!fs.existsSync(part), 'startup erases uncommitted photo bytes');
  box.s.readyState = 3;
  box.mac.onChunk({ t: 'backup.chunk', ...echo, seq: 1, data: Buffer.from('x').toString('base64') }, box.s);
  assert.strictEqual(box.mac.flight, null);
  assert.ok(!fs.existsSync(part));
  assert.ok(!box.ledger.get('phone-1', item, 4) || box.ledger.get('phone-1', item, 4).state !== 'done');
  box.s.readyState = 1;
  box.sent.length = 0;
  box.mac.onChunk({ t: 'backup.chunk', ...echo, seq: 1, data: Buffer.from('y').toString('base64') }, box.s);
  assert.ok(!box.sent.some((m) => m.t === 'backup.done' && m.req === take.req));
  assert.strictEqual(filesUnder(folder).length, 0);

  arm(box, { folder, mrev: 2 });
  feed(box, [row]);
  const fresh = takeOf(box.sent);
  assert.ok(fresh && fresh.req !== take.req);
  acceptBody(box, fresh, photo);
  assert.ok(box.sent.some((m) => m.t === 'backup.done' && m.req === fresh.req));
  assert.strictEqual(filesUnder(folder).length, 1);

  // The real adapter cannot follow a picker, a fallback packet, or a delayed close to phone B.
  const peer = new EventEmitter();
  const a = { deviceId: 'a', transport: 'ip', os: P.OS.ANDROID, photoBackup: true, photoBackupPair: 'a'.repeat(64), authed: true, ws: sock() };
  const b = { ...a, deviceId: 'b', ws: sock(), photoBackupPair: 'b'.repeat(64) };
  const state = { photoBackup: { peers: {} } };
  const sent = [];
  peer.outbound = (ctx) => ctx.ws;
  peer.send = (ctx, msg) => sent.push({ ctx, msg });
  const pb = attach({ store: { filePath: (name) => path.join(root, 'adapter-' + name) },
    settings: state, peer, save() {}, pushState() {} });
  peer.current = a;
  peer.emit('client', a);
  const picker = pb.target(pb.view().generation);
  peer.current = b;
  peer.emit('client', b);
  assert.ok(!sent.some(({ ctx, msg }) => ctx === b && msg.on), 'phone B never inherits an on state');
  assert.strictEqual(pb.update(picker, { folder, on: true }), false);
  assert.strictEqual(pb.view().on, false);
  peer.emit('closed', a);
  assert.strictEqual(pb.view().available, true);
  pb.update(pb.target(pb.view().generation), { folder, on: true });
  const phoneState = { t: P.T.BACKUP_STATE, on: true, since: 1010, rev: 1, perm: 'ok', loc: true, api: 30 };
  const sends = sent.length;
  peer.emit(`t:${P.T.BACKUP_STATE}`, phoneState, b, null);
  assert.strictEqual(sent.length, sends, 'missing ingress does not fall back to the current socket');
  peer.emit(`t:${P.T.BACKUP_STATE}`, phoneState, b, b.ws);
  assert.ok(sent.slice(sends).some(({ msg }) => msg.t === P.T.BACKUP_SYNC));
  const pendingPicker = pb.target(pb.view().generation);
  pb.update(pendingPicker, { on: false });
  assert.strictEqual(pb.update(pendingPicker, { on: true, folder }), false, 'turning off expires all open pickers');

  // A pre-existing year symlink never causes writes (including a mkdir) outside the archive.
  const outside = path.join(root, 'outside');
  const safeRoot = path.join(root, 'symlink-test');
  fs.mkdirSync(outside);
  fs.mkdirSync(safeRoot);
  fs.symlinkSync(outside, path.join(safeRoot, PB.yearMonth(taken, taken).y));
  arm(box, { folder: safeRoot, mrev: 3 });
  feed(box, [row]);
  acceptBody(box, takeOf(box.sent), photo);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
  assert.ok(box.sent.some((m) => m.t === 'backup.refuse' && m.why === 'disk'));
  box.mac.invalidate();

  arm(box, { folder, mrev: 4 });
  feed(box, [{ ...row, item: PB.itemKey('external_primary', 'vol-9', 42) }]);
  const stopped = takeOf(box.sent);
  box.mac.receive({ t: 'backup.stop', req: 'retired' }, box.s);
  assert.strictEqual(box.mac.flight.req, stopped.req, 'an old stop does not cancel the current take');
  box.mac.receive({ t: 'backup.stop', req: stopped.req }, box.s);
  assert.strictEqual(box.mac.flight, null);
  assert.ok(box.mac.retry, 'a matching sender stop schedules recovery on the same socket');
  box.mac.invalidate();
  assert.strictEqual(box.mac.retry, null, 'local invalidation cancels the scheduled retry');
  fs.rmSync(root, { recursive: true, force: true });
}

main();
failure();
console.log('photobackup: ok');
