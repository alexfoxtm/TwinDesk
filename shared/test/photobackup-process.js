// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;
const { setTimeout: delay } = require('node:timers/promises');
const PB = require('../photobackup');
const { ReceiptLedger } = require('../../mac/photo-backup-worker');
const children = [];
const controls = [];
let holdRecheck = false;
let heldRecheck;
const fork = childProcess.fork;
childProcess.fork = (...args) => {
  const child = fork(...args);
  children.push(child);
  const emit = child.emit;
  child.emit = function (name, ...args) {
    if (holdRecheck && name === 'message' && args[0].rechecked) {
      holdRecheck = false;
      heldRecheck = { event: args[0], release: () => emit.call(this, name, ...args) };
      return true;
    }
    return emit.call(this, name, ...args);
  };
  const send = child.send.bind(child);
  child.send = (event, callback) => {
    controls.push(event);
    return send(event, callback);
  };
  return child;
};
const { attach } = require('../../mac/photobackup');
childProcess.fork = fork;
PB.RETRY_MS = 25;

async function run() {
  const scratch = path.join(os.homedir(), 'orca', 'tmp');
  const root = fs.mkdtempSync(path.join(fs.existsSync(scratch) ? scratch : os.tmpdir(), 'photo-backup-process-'));
  const folder = fs.realpathSync(root);
  const fifo = path.join(root, 'gate');
  const marker = path.join(root, 'entered');
  const preload = path.join(root, 'preload.cjs');
  execFileSync('mkfifo', [fifo]);
  fs.writeFileSync(preload, `
    if (!require('node:worker_threads').isMainThread) {
      const fs = require('node:fs');
      const original = fs.writeFileSync;
      fs.writeFileSync = (file, data, ...args) => {
        if (typeof file === 'number' && Buffer.isBuffer(data) && !fs.existsSync(${JSON.stringify(marker)})) {
          original(${JSON.stringify(marker)}, String(process.pid));
          fs.readFileSync(${JSON.stringify(fifo)});
        }
        return original(file, data, ...args);
      };
    }
  `);
  const oldOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${oldOptions || ''} --require="${preload}"`;
  const pair = 'a'.repeat(64);
  const ws = { transport: 'ip', readyState: 1 };
  const ctx = { os: 'android', authed: true, deviceId: 'phone', photoBackup: true,
    transport: 'ip', photoBackupPair: pair, ws };
  const now = Date.now();
  const state = { t: 'backup.state', photoCredit: 1, on: true, since: now - 1000,
    rev: 1, mrev: 1, perm: 'ok', loc: true, api: 30 };
  const messages = [];
  const peer = Object.assign(new EventEmitter(), {
    current: ctx, outbound: () => ws, send: (_, msg) => messages.push(msg),
  });
  let previewUpdates = null;
  const options = { store: { filePath: (name) => path.join(root, name) },
    settings: { photoBackup: { peers: { phone: { pair, folder, on: true, rev: 1, since: state.since } } } },
    peer, pushState() { previewUpdates?.push(pb.latest()?.path); }, save() {},
  };
  const other = fs.mkdtempSync(path.join(folder, 'other-'));
  const seed = (dir, added, name) => {
    const ym = '2026/01';
    fs.mkdirSync(path.join(dir, ym), { recursive: true });
    const dest = path.join(dir, ym, name);
    fs.writeFileSync(dest, name);
    fs.utimesSync(dest, added / 1000, added / 1000);
    const st = fs.statSync(dest);
    const ledger = new ReceiptLedger(options.store.filePath('photo-backup.json'));
    ledger.set('phone:' + pair, PB.itemKey('external', 'version', name === 'older.jpg' ? 2 : 3), 1,
      { state: 'done', dest, root: dir, ym, size: st.size, dev: st.dev, ino: st.ino, mtime: st.mtimeMs });
    ledger.save();
    return dest;
  };
  const older = seed(folder, now - 10_000, 'older.jpg');
  let pb = attach(options);
  const otherPhoto = seed(other, now - 5000, 'other.jpg');
  const send = (msg) => peer.emit('t:' + msg.t, msg, ctx, ws);
  async function until(find, message = 'timed out waiting for photo backup') {
    const expires = Date.now() + 5000;
    while (Date.now() < expires) {
      const result = find();
      if (result) return result;
      await delay(5);
    }
    assert.fail(message);
  }
  const receive = (type, pred = () => true) => until(() => {
    const index = messages.findIndex((msg) => msg.t === 'backup.' + type && pred(msg));
    return index < 0 ? null : messages.splice(index, 1)[0];
  });
  const chunk = Buffer.alloc(PB.CHUNK, 37);
  const size = 17 * chunk.length;
  async function offer(id = 1) {
    const sync = await receive('sync');
    send({ ...state, t: 'backup.inv', req: 'inv', scan: 'scan', sync: sync.req,
      items: [{ item: PB.itemKey('external', 'version', id), gen: 1, size,
        name: 'photo.jpg', added: now, taken: now }] });
  }
  async function begin() {
    await offer();
    const take = await receive('take');
    send({ ...take, t: 'backup.accept' });
    const grant = await receive('credit', (msg) => msg.req === take.req);
    assert.equal(grant.upTo, 16 * chunk.length);
    return take;
  }
  const body = (take, seq) => send({ ...take, t: 'backup.chunk', seq, data: chunk.toString('base64') });
  try {
    send(state);
    await receive('sync');
    ctx.transport = 'ble';
    peer.emit('transport', ctx);
    options.settings.photoBackup.peers.phone.folder = other;
    pb.refresh();
    assert.equal(pb.latest()?.path, otherPhoto, 'worker start invalidated the startup preview ledger');
    options.settings.photoBackup.peers.phone.folder = folder;
    pb.refresh();
    ctx.transport = 'ip';
    peer.emit('transport', ctx);
    send(state);
    const interrupted = await begin();
    body(interrupted, 0);
    await until(() => fs.existsSync(marker));
    for (let i = 1; i < 16; i++) body(interrupted, i);
    await delay(50);
    assert.equal(messages.filter((m) => m.req === interrupted.req).length, 0,
      'an entire window waits behind blocked storage without refusal or premature credit');
    process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL');
    const refusal = await receive('refuse');
    assert.equal(refusal.req, interrupted.req);
    assert.equal(refusal.why, 'disk');
    body(interrupted, 16);

    const reconnect = (credit = 1) => {
      ctx.transport = 'ble';
      peer.emit('transport', ctx);
      messages.length = 0;
      ctx.transport = 'ip';
      peer.emit('transport', ctx);
      send({ ...state, photoCredit: credit });
    };
    for (const [label, invalid] of [
      ['ingress window', take => { for (let i = 0; i < 17; i++) body(take, i); }],
      ['early End', take => send({ ...take, t: 'backup.end', sha256: '0'.repeat(64) })],
      ['extra encoded data', take => send({ ...take, t: 'backup.chunk', seq: 0, data: chunk.toString('base64').replace(/=$/, 'AAAA=') })],
      ['encoded padding', take => send({ ...take, t: 'backup.chunk', seq: 0, data: chunk.toString('base64').replace(/=$/, 'A') })],
      ['encoded length', take => send({ ...take, t: 'backup.chunk', seq: 0, data: 'YWI=' })],
    ]) {
      const rejected = await begin();
      invalid(rejected);
      assert.equal(messages.find(m => m.req === rejected.req)?.why, 'checksum', label);
      reconnect();
    }
    const take = await begin();
    assert.notEqual(take.req, interrupted.req);
    for (let i = 0; i < 16; i++) body(take, i);
    await receive('credit', (m) => m.req === take.req && m.upTo === size);
    body(take, 16);
    await receive('credit', (m) => m.req === take.req && m.written === size);
    const expected = Buffer.concat(Array(17).fill(chunk));
    send({ ...take, t: 'backup.end', sha256: createHash('sha256').update(expected).digest('hex') });
    await receive('done', (m) => m.req === take.req);
    const latest = await until(() => pb.latest()?.path !== older && pb.latest());
    assert.deepEqual(fs.readFileSync(latest.path), expected);
    assert.ok(!messages.some((m) => m.req === interrupted.req));
    ctx.transport = 'ble';
    peer.emit('transport', ctx);
    fs.unlinkSync(latest.path);
    pb.recheckLatest(latest);
    await until(() => pb.latest()?.path === older, 'unbound recheck falls back to the older photo');

    holdRecheck = true;
    previewUpdates = [];
    pb.recheckLatest(pb.latest());
    const stale = await until(() => heldRecheck);
    assert.equal(stale.event.receipt?.path, older);
    options.settings.photoBackup.peers.phone.folder = other;
    pb.refresh();
    stale.release();
    assert.ok(previewUpdates.every(preview => preview === otherPhoto), 'an old recheck cannot replace the new archive tile');
    previewUpdates = null;
    options.settings.photoBackup.peers.phone.folder = folder;
    pb.refresh();
    reconnect();
    const next = await begin();
    for (let i = 0; i < 16; i++) body(next, i);
    await receive('credit', (m) => m.req === next.req && m.upTo === size);
    body(next, 16);
    await receive('credit', (m) => m.req === next.req && m.written === size);
    send({ ...next, t: 'backup.end', sha256: createHash('sha256').update(expected).digest('hex') });
    await receive('done', (m) => m.req === next.req);
    const newest = await until(() => pb.latest()?.path !== older && pb.latest());
    reconnect(0);
    await offer();
    await until(() => messages.some(m => m.t === 'backup.have'), 'legacy sees the worker receipt after exit');
    assert.equal(pb.latest()?.path, newest.path, 'legacy reload sees the worker receipt after exit');
    pb.close();

    pb = attach(options);
    assert.equal(pb.latest()?.path, newest.path, 'startup restores the last receipt before phone state');
    ctx.transport = 'ble';
    peer.emit('transport', ctx);
    assert.equal(pb.latest()?.path, newest.path, 'BLE alone keeps the last receipt visible');
    fs.renameSync(newest.path, newest.path + '.removed');
    previewUpdates = [];
    pb.recheckLatest(pb.latest());
    assert.deepEqual(previewUpdates, [], 'cold BLE recheck does not reenter the shelf snapshot');
    await Promise.resolve();
    assert.deepEqual(previewUpdates, [older], 'cold BLE recheck publishes the older preview');
    previewUpdates = null;
    fs.renameSync(newest.path + '.removed', newest.path);
    fs.appendFileSync(newest.path, 'edited');
    const empty = fs.mkdtempSync(path.join(folder, 'empty-'));
    options.settings.photoBackup.peers.phone.folder = empty;
    pb.refresh();
    options.settings.photoBackup.peers.phone.folder = folder;
    pb.refresh();
    assert.equal(pb.latest()?.path, older, 'an edited photo is skipped when loading receipts');
    pb.close();

    fs.unlinkSync(marker);
    pb = attach(options);
    reconnect();
    const stalled = await begin();
    body(stalled, 0);
    await until(() => fs.existsSync(marker));
    for (let i = 0; i < 64; i++) send(state);
    assert.ok(!messages.some(m => m.req === stalled.req && m.t === 'backup.refuse'));
    const child = children.at(-1);
    const controlStart = controls.length;
    send(state);
    assert.equal(messages.find(m => m.req === stalled.req)?.why, 'disk', 'control overflow refuses the flight');
    assert.ok(controls.slice(controlStart).some(event => event.kind === 'fence' && event.cancelled),
      'control overflow fences queued work');
    assert.equal(child.killed, true, 'control overflow retires the blocked process');
    const count = children.length;
    await until(() => children.length > count, 'the overflowed worker restarts');
    assert.equal(controls.at(-1)?.msg?.t, 'backup.state', 'the replacement worker accepts control frames');
    await receive('sync');

    pb.close();

    pb = attach(options);
    assert.equal(pb.latest()?.path, older);
    reconnect();
    await receive('sync');
    const corrupt = path.join(options.store.filePath('photo-backup.json') + '.receipts', 'f'.repeat(64) + '.json');
    fs.writeFileSync(corrupt, 'bad receipt');
    options.settings.photoBackup.peers.phone.folder = empty;
    pb.refresh();
    assert.equal(pb.latest(), null, 'an unreadable new archive cannot show the previous archive photo');
  } finally {
    pb.close();
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldOptions;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('photobackup-process: ok'), (error) => {
  console.error(error);
  process.exitCode = 1;
});
