// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { mock } = require('node:test');
const { Worker } = require('node:worker_threads');
const cp = require('node:child_process');
const { run } = require('../../mac/photo-backup-process');
const PB = require('../photobackup');
const { ReceiptLedger } = require('../../mac/photo-backup-worker');
const { Server } = require('../../mac/server');

const workers = [];
const clock = new BigInt64Array(new SharedArrayBuffer(8));
const barrier = new Int32Array(new SharedArrayBuffer(12));
const events = new EventEmitter();
const messages = [];
let disk = {};

function simulatedDisk() {
  const fs = require('node:fs');
  const { workerData, parentPort } = require('node:worker_threads');
  const { clock, barrier, stallAt, holdDone } = workerData;
  Date.now = () => Number(Atomics.load(clock, 0));
  const write = fs.writeFileSync;
  const sync = fs.fsyncSync;
  const read = fs.readSync;
  let collisionReads = 0;
  let chunks = 0;
  let doneFd;
  let partFd;
  function hold(slot) {
    parentPort.postMessage({ barrier: slot });
    if (Atomics.wait(barrier, slot, 0, 10_000) === 'timed-out') throw new Error('test barrier timed out');
  }
  fs.writeFileSync = (fd, data, ...rest) => {
    if (Buffer.isBuffer(data)) {
      partFd = fd;
      if (++chunks === stallAt) hold(0);
      // 32 KiB takes 320 ms at 100 KiB/s. The harness advances the same virtual clock.
    } else if (holdDone && JSON.parse(data)?.row?.state === 'done') doneFd = fd;
    return write(fd, data, ...rest);
  };
  fs.readSync = (fd, data, ...rest) => {
    if (holdDone && Buffer.isBuffer(data) && data.length === 64 * 1024 && ++collisionReads <= 3) {
      parentPort.postMessage({ collision: collisionReads });
      if (Atomics.wait(barrier, 2, collisionReads - 1, 10_000) === 'timed-out') throw new Error('collision read');
    }
    return read(fd, data, ...rest);
  };
  fs.fsyncSync = (fd) => {
    if (fd === partFd) parentPort.postMessage({ flushedAfter: chunks });
    if (fd === doneFd) { doneFd = undefined; hold(1); }
    return sync(fd);
  };
  require(workerData.filename);
}

const { fork } = cp;
cp.fork = (_filename, [file]) => {
  const child = Object.assign(new EventEmitter(), { connected: true, unref() {} });
  const port = new EventEmitter();
  child.send = (event) => port.emit('message', event);
  port.send = (event) => {
    if ('barrier' in event || 'collision' in event || 'flushedAfter' in event) wire(event);
    else child.emit('message', event);
  };
  run(port, file, (filename, { workerData }) => {
    const worker = new Worker(`(${simulatedDisk.toString()})()`, {
      eval: true, workerData: { ...workerData, filename, clock, barrier, ...disk },
    });
    child.kill = () => { void worker.terminate(); };
    port.kill = () => { child.connected = false; child.emit('close'); };
    workers.push(worker);
    return worker;
  });
  return child;
};
const { attach } = require('../../mac/photobackup');
cp.fork = fork;

function wire(msg) {
  messages.push(msg);
  events.emit('wire');
}

async function read(match) {
  for (;;) {
    const index = messages.findIndex(match);
    if (index >= 0) return messages.splice(index, 1)[0];
    await once(events, 'wire', { signal: AbortSignal.timeout(5000) });
  }
}

const receive = (type) => read((m) => m.t === 'backup.' + type);

function release(slot) {
  Atomics.store(barrier, slot, 1);
  Atomics.notify(barrier, slot);
}

async function main() {
  const scratch = path.join(os.homedir(), 'orca', 'tmp');
  const root = fs.mkdtempSync(path.join(fs.existsSync(scratch) ? scratch : os.tmpdir(), 'td-pb-flow-'));
  const folder = path.join(root, 'archive');
  fs.mkdirSync(folder);
  const realNow = Date.now();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: realNow });
  Atomics.store(clock, 0, BigInt(realNow));
  function advance(ms) {
    Atomics.add(clock, 0, BigInt(ms));
    mock.timers.tick(ms);
  }

  // Exercise production ingress and liveness against a synthetic authenticated socket.
  const server = Object.assign(new EventEmitter(), { sockets: new Set(), blePorts: new Map() });
  Object.setPrototypeOf(server, Server.prototype);
  let pauses = 0;
  let closed = 0;
  const ws = {
    OPEN: 1, readyState: 1, lastRx: Date.now(), transport: 'ip',
    send(line) { wire(JSON.parse(line)); },
    pause() { pauses++; },
    terminate() { closed++; },
  };
  const pair = 'a'.repeat(64);
  const ctx = { deviceId: 'phone', os: 'android', authed: true, transport: 'ip', ws,
    photoBackup: true, photoBackupPair: pair };
  server.sockets.add(ctx);
  const peer = Object.assign(new EventEmitter(), {
    current: ctx, outbound: (c) => c.ws, send: server.send.bind(server),
  });
  server.on('message', (m, c, socket, bytes) => peer.emit('t:' + m.t, m, c, socket, bytes));
  const send = (msg, padding = '') => server._onMessage(ctx, Buffer.from(JSON.stringify(msg) + padding), false, ws);
  const state = { t: 'backup.state', on: true, since: realNow - 1000, rev: 1, mrev: 1,
    perm: 'ok', loc: true, api: 30 };
  const settings = { photoBackup: { peers: { phone: { pair, on: true, since: state.since, rev: 1, folder } } } };
  const pb = attach({ store: { filePath: (name) => path.join(root, name) }, settings, peer,
    pushState() {}, save() {} });
  const inv = (sync, id, size) => send({ ...state, t: 'backup.inv', req: 'inv-' + id, scan: 'scan-' + id,
    sync: sync.req, items: [{ gen: 1, item: PB.itemKey('external', 'version', id), size,
      name: `IMG-${id}.jpg`, added: realNow, taken: realNow }] });
  async function begin(id, size) {
    inv(await receive('sync'), id, size);
    const take = await receive('take');
    assert.equal(take.credit, 16 * PB.CHUNK);
    send({ ...take, t: 'backup.accept' });
    assert.deepEqual(await receive('credit'), { t: 'backup.credit', req: take.req, written: 0, upTo: Math.min(size, take.credit) });
    return take;
  }
  function heartbeat(ms) {
    for (let i = 0; i < ms; i += 1000) {
      advance(Math.min(1000, ms - i));
      server._liveness();
      send({ t: 'pong', ts: Date.now() });
    }
  }
  async function waitExit(worker) {
    // EventEmitter.once rejects on a worker error, while an exit is still expected.
    await new Promise((resolve) => worker.once('exit', resolve));
  }

  try {
    assert.equal((await receive('state')).photoCredit, 1);
    send(state, ' '.repeat(65_536));
    assert.equal((await receive('refuse')).why, 'checksum');
    disk = { stallAt: 1281, holdDone: true };
    send({ ...state, photoCredit: 1 });
    send({ t: 'backup.chunk' });
    const size = PB.MAX_BYTES;
    const take = await begin(1, size);
    const ym = PB.yearMonth(realNow, realNow);
    const archive = path.join(folder, ym.y, ym.m);
    const collision = path.join(archive, 'IMG-1.jpg');
    fs.closeSync(fs.openSync(collision, 'wx'));
    fs.truncateSync(collision, size);
    const hash = createHash('sha256');
    const payload = Buffer.alloc(PB.CHUNK);
    let outstanding = 0;
    for (let seq = 0; seq < size / PB.CHUNK; seq++) {
      payload.writeUInt32LE(seq);
      hash.update(payload);
      outstanding += payload.length;
      assert.ok(outstanding <= PB.CHUNK);
      send({ ...take, t: 'backup.chunk', seq, data: payload.toString('base64') });
      advance(320);
      if (seq === 1280) {
        await read((m) => m.barrier === 0);
        let sideMessage = false;
        peer.once('t:clip', () => { sideMessage = true; });
        send({ t: 'clip' });
        send({ t: 'ping', ts: Date.now() });
        assert.ok(sideMessage);
        assert.ok(messages.some((m) => m.t === 'pong'));
        send({ ...state, photoCredit: 1 });
        heartbeat(60_000);
        assert.equal(closed, 0);
        assert.equal(pauses, 0);
        assert.ok(!messages.some((m) => m.t === 'backup.refuse'));
        release(0);
      }
      const credit = await receive('credit');
      if (seq === 255) await read((m) => m.flushedAfter === 256);
      assert.equal(credit.req, take.req);
      assert.equal(credit.upTo, Math.min(size, (seq + 1) * PB.CHUNK + take.credit));
      assert.equal(credit.written, (seq + 1) * PB.CHUNK);
      outstanding -= PB.CHUNK;
    }
    const sha256 = hash.digest('hex');
    send({ ...take, t: 'backup.end', sha256 });
    assert.equal((await receive('progress')).req, take.req); // the staged part was fsynced
    for (let step = 1; step <= 3; step++) {
      await read((m) => m.collision === step);
      heartbeat(60_000);
      Atomics.store(barrier, 2, step);
      Atomics.notify(barrier, 2);
      assert.equal((await receive('progress')).req, take.req);
    }
    await read((m) => m.barrier === 1);
    assert.ok(!messages.some((m) => m.t === 'backup.done'));
    assert.equal(PB.hashFile(path.join(archive, 'IMG-1-2.jpg')), sha256);
    release(1);
    assert.equal((await receive('done')).sha256, sha256);

    // A new inventory follows the same-state nudge during the stall.
    const oversized = await begin(2, 1);
    send({ ...oversized, t: 'backup.chunk', seq: 0, data: 'AA==' }, ' '.repeat(65_536));
    assert.equal((await receive('refuse')).why, 'checksum');

    // Crash during one flight. Recovery starts a fresh inventory and can finish the same item.
    const restartSession = (credited = true) => {
      peer.current = { ...ctx, ws: { ...ws } };
      const next = peer.current;
      peer.emit('client', next);
      peer.current = ctx;
      peer.emit('client', ctx);
      if (credited) send({ ...state, photoCredit: 1 });
    };
    restartSession();
    const interrupted = await begin(3, 1);
    disk = { stallAt: 1 };
    await workers.at(-1).terminate();
    const refused = await receive('refuse');
    assert.equal(refused.req, interrupted.req);
    assert.equal(refused.why, 'disk');
    advance(1);
    Atomics.store(barrier, 0, 0);
    const retry = await begin(3, 1);
    send({ ...retry, t: 'backup.chunk', seq: 0, data: 'AA==' });
    await read((m) => m.barrier === 0);
    release(0);
    await receive('credit');
    const oneHash = createHash('sha256').update(Buffer.alloc(1)).digest('hex');
    send({ ...retry, t: 'backup.end', sha256: oneHash });
    await receive('done');

    // A second death after a healthy interval can restart too.
    heartbeat(61_000);
    await workers.at(-1).terminate();
    disk = { stallAt: 1 };
    Atomics.store(barrier, 0, 0);
    advance(1);
    const stalled = await begin(4, 1);
    send({ ...stalled, t: 'backup.chunk', seq: 0, data: 'AA==' });
    await read((m) => m.barrier === 0);
    const exited = waitExit(workers.at(-1));
    heartbeat(PB.CREDIT_IDLE_MS);
    const timeout = await receive('refuse');
    assert.equal(timeout.req, stalled.req);
    assert.equal(timeout.why, 'timeout');
    assert.ok(!messages.some((m) => m.req === stalled.req && m.t === 'backup.done'));
    release(0);
    await exited;
    const workersBeforeBackoff = workers.length;
    heartbeat(PB.RETRY_MS - 1);
    assert.equal(workers.length, workersBeforeBackoff, 'stuck storage retries after the backoff');
    advance(1);
    const resumed = await receive('sync');
    assert.equal(workers.length, workersBeforeBackoff + 1);

    // An accepted phone can go quiet with no worker work outstanding.
    inv(resumed, 6, PB.CHUNK);
    const quiet = await receive('take');
    send({ ...quiet, t: 'backup.accept' });
    await receive('credit');
    const workersBeforeQuiet = workers.length;
    heartbeat(PB.CREDIT_IDLE_MS);
    assert.equal((await receive('refuse')).req, quiet.req);
    assert.equal(pb.view().why, 'wait');
    assert.equal(workers.length, workersBeforeQuiet);
    assert.equal(workers.at(-1).threadId > 0, true, 'a silent phone leaves the helper alive');

    // The old sender has no capability. It gets a synchronous take and streams without grants.
    restartSession();
    peer.current = { ...ctx, ws: { ...ws } };
    peer.emit('client', peer.current);
    peer.current = ctx;
    peer.emit('client', ctx);
    send(state);
    inv(await receive('sync'), 5, 1);
    const legacy = await receive('take');
    assert.equal(legacy.credit, undefined);
    send({ ...legacy, t: 'backup.accept' });
    send({ ...legacy, t: 'backup.chunk', seq: 0, data: 'AA==' });
    send({ ...legacy, t: 'backup.end', sha256: oneHash });
    assert.ok(messages.some((m) => m.req === legacy.req && m.t === 'backup.done'));
    assert.ok(!messages.some((m) => m.req === legacy.req && m.t === 'backup.credit'));
    const loads = mock.method(ReceiptLedger.prototype, '_load');
    try {
      restartSession(false);
      send(state);
      await receive('sync');
      assert.equal(loads.mock.callCount(), 0, 'legacy reconnect reuses the loaded ledger');
    } finally {
      loads.mock.restore();
    }
    assert.equal(closed, 0);
    assert.equal(pauses, 0);
  } finally {
    pb.close();
    mock.timers.reset();
    for (const worker of workers) await worker.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function quitWhileDiskBlocked() {
  const scratch = path.join(os.homedir(), 'orca', 'tmp');
  const root = fs.mkdtempSync(path.join(fs.existsSync(scratch) ? scratch : os.tmpdir(), 'td-pb-quit-'));
  try {
    const fifo = path.join(root, 'blocked.fifo');
    const fifoResult = cp.spawnSync('mkfifo', [fifo]);
    assert.equal(fifoResult.status, 0, String(fifoResult.stderr));
    const entered = path.join(root, 'entered');
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      if (!require('node:worker_threads').isMainThread) {
        const original = fs.readFileSync;
        fs.readFileSync = (file, ...args) => {
          if (file === ${JSON.stringify(fifo)}) fs.writeFileSync(${JSON.stringify(entered)}, 'blocked');
          return original(file, ...args);
        };
      }
    `);
    const test = `
      const fs = require('node:fs');
      const { EventEmitter } = require('node:events');
      const { attach } = require(${JSON.stringify(require.resolve('../../mac/photobackup'))});
      const peer = Object.assign(new EventEmitter(), {
        outbound: (ctx) => ctx.ws, send() {},
        current: { ws: { readyState: 1 }, deviceId: 'phone', os: 'android', authed: true,
          transport: 'ip', photoBackup: true, photoBackupPair: 'a'.repeat(64) }
      });
      const pb = attach({ peer, pushState() {}, settings: { photoBackup: { peers: {} } },
        store: { filePath: () => ${JSON.stringify(fifo)} } });
      peer.emit('t:backup.state', { t: 'backup.state', photoCredit: 1, on: true,
        since: 1, rev: 1, perm: 'ok', loc: true, api: 30 }, peer.current, peer.current.ws);
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(entered)})) return;
        clearInterval(timer);
        pb.close();
      }, 20);
    `;
    const result = cp.spawnSync(process.execPath, ['-e', test], {
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
      timeout: 5000, encoding: 'utf8',
    });
    assert.ok(fs.existsSync(entered), String(result.stderr));
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const keepAlive = setInterval(() => {}, 1000);
main().then(quitWhileDiskBlocked).then(() => console.log('photobackup-flow: ok'), (error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearInterval(keepAlive));
