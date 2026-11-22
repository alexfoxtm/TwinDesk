// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const PB = require('../photobackup');

const workerPath = require.resolve('../../mac/photo-backup-worker');

function diskStub() {
  const fs = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  const barrier = new Int32Array(workerData.barrier);
  const write = fs.writeFileSync;
  const link = fs.linkSync;
  const sync = fs.fsyncSync;
  let first = true;
  let doneFd;
  let pendingFd;
  function wait(stage, slot) {
    parentPort.postMessage({ stage });
    if (Atomics.wait(barrier, slot, 0, 5000) === 'timed-out') throw new Error(stage);
  }
  fs.linkSync = (...args) => {
    link(...args);
    if (workerData.crashAfterLink) process.exit(1);
  };
  fs.writeFileSync = (fd, data, ...rest) => {
    write(fd, data, ...rest);
    if (Buffer.isBuffer(data) && workerData.slow) Atomics.wait(barrier, 0, 1, 1);
    if (Buffer.isBuffer(data) && first) {
      first = false;
      wait('chunk written', 0);
    }
    if (typeof data === 'string' && !first) {
      const state = JSON.parse(data)?.row?.state;
      if (state === 'done') doneFd = fd;
      if (state === 'pending' && workerData.holdPublish) pendingFd = fd;
    }
  };
  fs.fsyncSync = (fd) => {
    if (fd === pendingFd) {
      pendingFd = undefined;
      wait('before publish', 2);
    }
    if (fd === doneFd) {
      doneFd = undefined;
      wait('before done receipt fsync', 1);
    }
    sync(fd);
  };
  parentPort.on('message', (msg) => {
    if (msg.kind === 'test-error') throw new Error('injected worker error');
  });
  require(workerData.workerPath);
}

async function main() {
  const scratch = path.join(os.homedir(), 'orca', 'tmp');
  const root = fs.mkdtempSync(path.join(fs.existsSync(scratch) ? scratch : os.tmpdir(), 'twindesk-pb-worker-'));
  const file = path.join(root, 'photo-backup.json');
  const folder = path.join(root, 'archive');
  const origin = 'phone:pair';
  const item = PB.itemKey('external', 'version', 42);
  const now = Date.now();
  const ym = PB.yearMonth(now, now);
  const dest = path.join(folder, ym.y, ym.m, 'IMG.jpg');
  const bytes = Buffer.from('first chunk, then second chunk');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(folder);
  fs.writeFileSync(file, '{"v":1,"peers":{}}');

  const workers = [];
  function start({ crashAfterLink = false, holdPublish = false } = {}) {
    const epoch = new Int32Array(new SharedArrayBuffer(4));
    const barrier = new Int32Array(new SharedArrayBuffer(12));
    Atomics.store(epoch, 0, 1);
    const worker = new Worker(`(${diskStub.toString()})()`, { eval: true,
      workerData: { file, epoch: epoch.buffer, barrier: barrier.buffer, workerPath, crashAfterLink, holdPublish } });
    workers.push(worker);
    const seen = [];
    worker.on('message', (m) => seen.push(m));
    const send = (kind, extra) => worker.postMessage({ kind, gen: 1, ...extra });
    async function until(match, label = String(match)) {
      for (;;) {
        const found = seen.find(match);
        if (found) return found;
        try { await once(worker, 'message', { signal: AbortSignal.timeout(8000) }); }
        catch (error) { throw new Error(`waiting for ${label}: ${JSON.stringify(seen)}`, { cause: error }); }
      }
    }
    function resume(slot) {
      Atomics.store(barrier, slot, 1);
      Atomics.notify(barrier, slot);
    }
    send('bind', { args: ['phone', { transport: 'ip', peerPb: true, origin,
      local: { on: true, since: 1, mrev: 1, folder } }], archive: { origin, folder } });
    const receive = (msg) => send('receive', { msg });
    const wire = async (t) => (await until((m) => m.msg?.t === t, t)).msg;
    receive({ t: 'backup.state', rev: 1, since: 1, on: true, perm: 'ok', loc: true, api: 30 });
    return { worker, seen, until, resume, receive, wire, epoch, send };
  }

  function recorded() {
    const dir = file + '.receipts';
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  }
  async function begin(box) {
    const { req: sync } = await box.wire('backup.sync');
    box.receive({ t: 'backup.inv', req: 'inv', scan: 'scan', rev: 1, mrev: 1, sync,
      items: [{ item, gen: 1, size: bytes.length, name: 'IMG.jpg', taken: now, added: now }] });
    const { t, ...echo } = await box.wire('backup.take');
    box.receive({ ...echo, t: 'backup.accept' });
    box.receive({ ...echo, t: 'backup.chunk', seq: 0, data: bytes.subarray(0, 12).toString('base64') });
    await box.until((m) => m.stage === 'chunk written');
    return echo;
  }

  try {
    const crashed = start();
    await begin(crashed);
    const receiving = recorded()[0].row;
    assert.equal(receiving.state, 'receiving');
    assert.ok(fs.readFileSync(receiving.part).equals(bytes.subarray(0, 12)));
    assert.equal(crashed.seen.some((m) => m.msg?.t === 'backup.done'), false);
    await crashed.worker.terminate();

    // A legacy row would reappear on the next replay if the overlay merely deleted it.
    const legacy = new PB.Ledger(file);
    legacy.set(origin, item, 1, receiving);
    legacy.save();
    const legacyBase = fs.readFileSync(file);
    const revoked = start();
    await revoked.wire('backup.sync');
    assert.ok(!fs.existsSync(receiving.part), 'startup clears the partial file before another accept');
    assert.equal(recorded()[0].row, null, 'startup durably masks the legacy row');
    const revokedEcho = await begin(revoked);
    revoked.receive({ ...revokedEcho, t: 'backup.chunk', seq: 1, data: bytes.subarray(12).toString('base64') });
    revoked.receive({ ...revokedEcho, t: 'backup.end', sha256 });
    Atomics.store(revoked.epoch, 0, 2);
    revoked.send('local', { gen: 2, args: [{ on: false, mrev: 2 }] });
    revoked.resume(0);
    await revoked.until((m) => m.generation === 2);
    assert.equal(fs.existsSync(dest), false, 'an epoch change discards the queued end');
    assert.equal(recorded()[0].row, null);

    const publishing = start({ holdPublish: true });
    const publishingEcho = await begin(publishing);
    publishing.receive({ ...publishingEcho, t: 'backup.chunk', seq: 1, data: bytes.subarray(12).toString('base64') });
    publishing.receive({ ...publishingEcho, t: 'backup.end', sha256 });
    publishing.resume(0);
    await publishing.until((m) => m.stage === 'before publish');
    Atomics.store(publishing.epoch, 0, 2);
    publishing.send('local', { gen: 2, args: [{ on: false, mrev: 2 }] });
    publishing.resume(2);
    await publishing.until((m) => m.generation === 2);
    assert.equal(fs.existsSync(dest), false, 'revocation after journal fsync starts prevents the link');

    const linked = start({ crashAfterLink: true });
    const interrupted = await begin(linked);
    linked.receive({ ...interrupted, t: 'backup.chunk', seq: 1, data: bytes.subarray(12).toString('base64') });
    linked.receive({ ...interrupted, t: 'backup.end', sha256 });
    const exit = once(linked.worker, 'exit');
    linked.resume(0);
    assert.deepEqual(await exit, [1]);
    const pending = recorded()[0].row;
    assert.equal(pending.state, 'pending');
    assert.deepEqual(fs.readFileSync(dest), bytes);
    assert.ok(!linked.seen.some((m) => m.msg?.t === 'backup.done'));
    const recovered = start();
    await recovered.wire('backup.sync');
    assert.equal(recorded()[0].row.state, 'done', 'recovery recognizes the already-linked file');
    assert.ok(!fs.existsSync(pending.part));
    await recovered.worker.terminate();
    fs.unlinkSync(dest);

    const retried = start();
    const echo = await begin(retried);
    retried.receive({ ...echo, t: 'backup.chunk', seq: 1, data: bytes.subarray(12).toString('base64') });
    retried.receive({ ...echo, t: 'backup.end', sha256 });
    assert.ok(!fs.existsSync(dest), 'end waits behind the slow first write');
    retried.resume(0);
    await retried.until((m) => m.stage === 'before done receipt fsync');
    assert.ok(fs.readFileSync(dest).equals(bytes), 'published bytes are in socket order');
    assert.equal(recorded()[0].row.state, 'pending');
    assert.equal(retried.seen.some((m) => m.msg?.t === 'backup.done'), false);
    retried.resume(1);
    assert.equal((await retried.wire('backup.done')).sha256, sha256);
    assert.equal(recorded()[0].row.state, 'done');
    assert.deepEqual(fs.readFileSync(file), legacyBase, 'transfers leave the existing history file alone');
    assert.equal(recorded().length, 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => console.log('photobackup-worker: ok'), (error) => {
  console.error(error);
  process.exitCode = 1;
});
