// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const PB = require('../shared/photobackup');

function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Keep v1 history as the base and atomically replace only the receipt that changed.
// A deletion is a tombstone, so replay cannot resurrect an old v1 receipt.
class ReceiptLedger extends PB.Ledger {
  get receipts() { return this.file + '.receipts'; }

  _load() {
    super._load();
    if (this.broken) return;
    try {
      let names;
      try { names = fs.readdirSync(this.receipts); }
      catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const name of names) {
        if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name)) {
          (this.orphans ??= []).push(name);
          continue;
        }
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const { origin, item, gen, row } = JSON.parse(fs.readFileSync(path.join(this.receipts, name), 'utf8'));
        if (receiptName(origin, item, gen) !== name || (row !== null && !row?.state)) throw new Error('receipt');
        if (row) super.set(origin, item, gen, row);
        else super.drop(origin, item, gen);
      }
    } catch {
      this.broken = true;
    }
  }

  recover() {
    for (const name of this.orphans || []) {
      try { fs.unlinkSync(path.join(this.receipts, name)); } catch { /* retry at next startup */ }
    }
    this.orphans = null;
    super.recover();
  }

  set(origin, item, gen, row) {
    super.set(origin, item, gen, row);
    this._record(origin, item, gen, row);
  }

  drop(origin, item, gen) {
    super.drop(origin, item, gen);
    this._record(origin, item, gen, null);
  }

  _record(origin, item, gen, row) {
    this.dirty ??= new Map();
    this.dirty.set(receiptName(origin, item, gen), { origin, item, gen, row });
  }

  save() {
    if (this.broken) throw new Error('backup history is unreadable');
    if (!this.dirty?.size) return;
    if (!this.ready) {
      fs.mkdirSync(this.receipts, { recursive: true, mode: 0o700 });
      syncDir(path.dirname(this.receipts));
      syncDir(this.receipts);
      this.ready = true;
    }
    for (const [name, receipt] of this.dirty) {
      const tmp = path.join(this.receipts, randomUUID() + '.tmp');
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmp, path.join(this.receipts, name));
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    syncDir(this.receipts);
    this.dirty.clear();
  }
}

function receiptName(origin, item, gen) {
  return createHash('sha256').update(JSON.stringify([origin, item, String(gen)])).digest('hex') + '.json';
}

function latest(ledger, origin, root) {
  const items = ledger.data.peers[origin]?.items || {};
  const candidates = Object.values(items).flatMap((item) => Object.values(item || {})).filter((row) =>
    row?.state === 'done' && row.root === root && Number.isFinite(row.mtime));
  candidates.sort((a, b) => b.mtime - a.mtime);
  try {
    for (const row of candidates) {
      if (!PB.rowPath(row, row.dest)) continue;
      const st = fs.lstatSync(row.dest, { throwIfNoEntry: false });
      if (!st?.isFile() || st.dev !== row.dev || st.ino !== row.ino) continue;
      return { path: row.dest, name: path.basename(row.dest), size: st.size, at: row.mtime,
        identity: { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs, folder: false } };
    }
  } catch { /* archive is unavailable */ }
  return null;
}

module.exports = { ReceiptLedger, latest };

if (parentPort) {
  const epoch = new Int32Array(workerData.epoch);
  const permit = workerData.permit && new Int32Array(workerData.permit);
  const ledger = new ReceiptLedger(workerData.file);
  let generation = 0;
  let conn;
  let receipt = null;
  let archive;
  const current = () => generation === Atomics.load(epoch, 0);
  const publishState = (rechecked = false) => {
    if (current()) parentPort.postMessage({ generation, why: engine.why() || engine.problem, receipt, rechecked });
  };
  const updateReceipt = () => {
    receipt = archive && !ledger.broken ? latest(ledger, archive.origin, archive.folder) : null;
  };
  const engine = new PB.Mac(ledger, {
    send(msg) {
      if (!current()) return false;
      parentPort.postMessage({ generation, msg });
      return true;
    },
    changed: publishState,
    hooks: {
      credit: workerData.credit === true,
      beforePublish() {
        const allowed = () => current() && (epoch.length < 2 || !Atomics.load(epoch, 1));
        if (allowed() && permit) {
          Atomics.store(permit, 0, 0);
          parentPort.postMessage({ generation, publish: engine.flight.req });
          if (Atomics.wait(permit, 0, 0, PB.CREDIT_IDLE_MS) === 'timed-out' || Atomics.load(permit, 0) !== 1) {
            throw new Error('backup publication was not authorized');
          }
        }
        if (!allowed()) throw new Error('backup consent changed');
      },
    },
  });

  parentPort.on('message', ({ kind, gen, args, msg, archive: target }) => {
    try {
      if (kind === 'bind' || kind === 'local' || kind === 'unbind') {
        if (archive?.origin !== target?.origin || archive?.folder !== target?.folder) receipt = null;
        archive = target;
      }
      switch (kind) {
        case 'bind':
          engine.unbind();
          generation = gen;
          conn = { readyState: 1 };
          engine.bind(conn, ...args);
          updateReceipt();
          break;
        case 'local':
          generation = gen;
          engine.setLocal(...args);
          updateReceipt();
          break;
        case 'unbind':
          engine.unbind();
          generation = gen;
          conn = null;
          updateReceipt();
          break;
        case 'close':
          engine.unbind();
          parentPort.close();
          return;
        case 'recheck':
          if (gen === generation && current()) updateReceipt();
          break;
        case 'invalid':
          if (gen === generation && current()) engine.failItem(msg || 'checksum');
          break;
        case 'receive':
          if (gen !== generation || !current()) break;
          if (epoch.length > 1 && Atomics.load(epoch, 1) &&
              ['backup.accept', 'backup.chunk', 'backup.end'].includes(msg.t)) break;
          engine.receive(msg, conn);
          if (msg.t === 'backup.end') updateReceipt();
          if (msg.t === 'backup.chunk') return;
          break;
      }
      publishState(kind === 'recheck');
    } finally {
      if (kind === 'recheck') parentPort.postMessage({ drained: kind });
    }
  });
}
