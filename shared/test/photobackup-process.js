// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const PB = require('../photobackup');
const { attach } = require('../../mac/photobackup');

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
  const options = { store: { filePath: (name) => path.join(root, name) },
    settings: { photoBackup: { peers: { phone: { pair, folder, on: true, rev: 1, since: state.since } } } },
    peer, pushState() {}, save() {},
  };
  let pb = attach(options);
  const send = (msg) => peer.emit('t:' + msg.t, msg, ctx, ws);
  async function until(find) {
    const expires = Date.now() + 5000;
    while (Date.now() < expires) {
      const result = find();
      if (result) return result;
      await delay(5);
    }
    assert.fail('timed out waiting for photo backup');
  }
  const receive = (type, pred = () => true) => until(() => {
    const index = messages.findIndex((msg) => msg.t === 'backup.' + type && pred(msg));
    return index < 0 ? null : messages.splice(index, 1)[0];
  });
  const chunk = Buffer.alloc(PB.CHUNK, 37);
  const size = 17 * chunk.length;
  async function begin() {
    const sync = await receive('sync');
    send({ ...state, t: 'backup.inv', req: 'inv', scan: 'scan', sync: sync.req,
      items: [{ item: PB.itemKey('external', 'version', 1), gen: 1, size,
        name: 'photo.jpg', added: now, taken: now }] });
    const take = await receive('take');
    send({ ...take, t: 'backup.accept' });
    const grant = await receive('credit', (msg) => msg.req === take.req);
    assert.equal(grant.upTo, 16 * chunk.length);
    return take;
  }
  const body = (take, seq) => send({ ...take, t: 'backup.chunk', seq, data: chunk.toString('base64') });
  try {
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

    const take = await begin();
    assert.notEqual(take.req, interrupted.req);
    for (let i = 0; i < 16; i++) body(take, i);
    await receive('credit', (m) => m.req === take.req && m.upTo === size);
    body(take, 16);
    await receive('credit', (m) => m.req === take.req && m.written === size);
    const expected = Buffer.concat(Array(17).fill(chunk));
    send({ ...take, t: 'backup.end', sha256: createHash('sha256').update(expected).digest('hex') });
    await receive('done', (m) => m.req === take.req);
    const latest = await until(() => pb.latest());
    assert.deepEqual(fs.readFileSync(latest.path), expected);
    assert.ok(!messages.some((m) => m.req === interrupted.req));
    fs.appendFileSync(latest.path, 'edited');
    assert.equal(pb.latest().path, latest.path);
    pb.close();

    // A fresh Mac has only the receipt ledger until the peer announces.
    pb = attach(options);
    assert.equal(pb.latest()?.path, latest.path, 'startup restores the last receipt before phone state');
    ctx.transport = 'ble';
    peer.emit('transport', ctx);
    assert.equal(pb.latest()?.path, latest.path, 'BLE alone keeps the last receipt visible');
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
