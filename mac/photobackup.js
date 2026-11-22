// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bind photo backup and folder choices to the authenticated connection that owns them.
'use strict';

const fs = require('node:fs/promises');
const path = require('path');
const { fork } = require('node:child_process');
const PB = require('../shared/photobackup');
const { ReceiptLedger, latest: findLatest } = require('./photo-backup-worker');
const P = require('../shared/protocol');
const { connectionOf } = require('../shared/asked-send');

const TYPES = [
  P.T.BACKUP_STATE, P.T.BACKUP_INV, P.T.BACKUP_ACCEPT, P.T.BACKUP_CHUNK,
  P.T.BACKUP_END, P.T.BACKUP_REFUSE, P.T.BACKUP_STOP,
];

function attach({ store, settings, peer, pushState, save, enabled = () => true }) {
  let epoch = 0;
  let cancelled = false;
  const file = store.filePath('photo-backup.json');
  let worker = null;
  let retiring = false;
  let legacy = null;
  let bound = null;
  let closed = false;
  let generation = 0;
  let status = 'wait';
  let latest = null;
  let archive = null;
  let rechecking = false;
  let flight = null;
  let watchdog = null;
  let restart = null;
  let lastFailure = -Infinity;

  function send(msg) {
    const { ctx, ws } = bound || {};
    if (!ctx || socket(ctx) !== ws) return false;
    try { peer.send(ctx, msg); return true; } catch { return false; }
  }

  function clearFlight() {
    clearTimeout(watchdog);
    flight = null;
  }

  function refuse(why) {
    if (!flight) return;
    const { credit, size, ...echo } = flight.take;
    clearFlight();
    send({ ...echo, t: 'backup.refuse', why });
  }

  function retire() {
    if (!worker || retiring) return;
    retiring = true;
    worker.kill('SIGKILL');
    worker.channel?.unref();
    worker.unref();
  }

  function watch() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      refuse('timeout');
      command('unbind');
      lastFailure = Date.now();
      retire();
      status = 'disk';
      pushState();
    }, PB.CREDIT_IDLE_MS);
    watchdog.unref();
  }

  function dispatch(event) {
    if (worker?.connected && !retiring) worker.send(event, () => {});
  }

  function fence(next) {
    cancelled = next;
    dispatch({ kind: 'fence', gen: epoch, cancelled });
  }

  function command(kind, args) {
    epoch++;
    fence(false);
    clearFlight();
    status = 'wait';
    latest = null;
    dispatch({ kind, gen: epoch, args, archive });
  }

  function startWorker() {
    worker = fork(path.join(__dirname, 'photo-backup-process.js'), [file], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    worker.on('error', () => { /* exit owns cleanup and restart */ });
    worker.on('close', () => {
      worker = null;
      rechecking = false;
      const expected = retiring;
      retiring = false;
      if (closed) return;
      if (!expected) refuse('disk');
      latest = null;
      status = 'disk';
      pushState();
      if (bound?.mode !== 'credit') { activate(); return; }
      const now = Date.now();
      const delay = expected || now - lastFailure < PB.RETRY_MS ? PB.RETRY_MS : 0;
      lastFailure = now;
      restart = setTimeout(() => { restart = null; activate(); }, delay);
      restart.unref();
    });
    worker.on('message', (event) => {
      if (retiring) return;
      if (event.publish) {
        dispatch({ kind: 'permit', allow: event.generation === epoch && !cancelled &&
          flight?.take.req === event.publish && !!bound && socket(bound.ctx) === bound.ws });
        return;
      }
      if (event.drained) {
        if (event.drained === 'recheck') rechecking = false;
        return;
      }
      if (event.generation !== epoch || bound?.mode !== 'credit') return;
      if (event.msg) {
        const msg = event.msg;
        if (msg.t === 'backup.state') return;
        if (msg.t === 'backup.take') {
          fence(false);
          flight = { take: msg, seq: 0, written: null, accepted: false };
          watch();
        } else if (msg.t === 'backup.progress') {
          if (flight?.take.req !== msg.req || cancelled) return;
          watch();
        } else if (msg.t === 'backup.credit') {
          if (flight?.take.req !== msg.req || cancelled) return;
          flight.seq = msg.seq;
          flight.written = msg.written;
          watch();
        } else if (msg.t === 'backup.done' || msg.t === 'backup.stop' ||
                   (msg.t === 'backup.refuse' && msg.req !== msg.inv)) {
          if (flight?.take.req !== msg.req || (msg.t === 'backup.done' && cancelled)) return;
          clearFlight();
        }
        send(msg);
      } else {
        status = event.why;
        latest = event.receipt;
        pushState();
      }
    });
    worker.channel?.unref();
    worker.unref();
  }

  function args() {
    return [bound.ctx.deviceId, { transport: 'ip', peerPb: true,
      origin: `${bound.ctx.deviceId}:${bound.ctx.photoBackupPair}`, local: bound.local }];
  }

  function activate() {
    if (!bound?.state || closed) return;
    if (bound.mode === 'legacy') {
      if (worker) { retire(); return; }
      legacy = new PB.Mac(new ReceiptLedger(file), { send, changed: pushState });
      legacy.bind(bound.ws, ...args());
      legacy.receive(bound.state, bound.ws);
    } else if (!retiring && !restart) {
      if (!worker) startWorker();
      command('bind', args());
      post(bound.state);
    }
  }

  function post(msg, kind = 'receive') {
    dispatch({ kind, gen: epoch, msg });
  }

  function peers() { return settings.photoBackup.peers; }

  function row(ctx) {
    const p = Object.hasOwn(peers(), ctx.deviceId) ? peers()[ctx.deviceId] : null;
    return p && p.pair === ctx.photoBackupPair ? { ...p } : {
      pair: ctx.photoBackupPair, on: false, since: 0, rev: 0, folder: '',
    };
  }

  function control(ctx = peer.current, requireEnabled = true) {
    return !closed && (!requireEnabled || enabled()) && ctx && ctx === peer.current && ctx.os === P.OS.ANDROID &&
      /^[0-9A-Za-z._-]{1,64}$/.test(ctx.deviceId) && typeof ctx.photoBackupPair === 'string' &&
      /^[0-9a-f]{64}$/.test(ctx.photoBackupPair) &&
      connectionOf(ctx, ctx.ws) ? ctx : null;
  }

  // Only the primary IP socket can carry backup, even when cursor sharing uses a fallback.
  function socket(ctx) {
    if (!control(ctx) || ctx.photoBackup !== true || ctx.transport !== 'ip') return null;
    const ws = peer.outbound(ctx);
    return ws && ws === ctx.ws && ws.transport !== 'ble' ? ws : null;
  }

  function local(ctx) {
    const p = row(ctx);
    return { on: p.on, since: p.since, mrev: p.rev, folder: p.folder };
  }

  function refresh() {
    const ctx = peer.current;
    const ws = socket(ctx);
    const p = control(ctx) && row(ctx);
    const nextArchive = p?.on && p.folder ? { origin: `${ctx.deviceId}:${ctx.photoBackupPair}`, folder: p.folder } : null;
    archive = nextArchive;
    const next = ws ? local(ctx) : null;
    if (bound && bound.ctx === ctx && bound.ws === ws) {
      if (Object.keys(next).some((key) => next[key] !== bound.local[key])) {
        bound.local = next;
        if (legacy) legacy.setLocal(next);
        else {
          if (flight) send({ t: 'backup.stop', req: flight.take.req });
          if (bound.mode === 'credit') command('local', [next]);
          announce();
        }
      }
      return;
    }
    if (!bound && !ws) return;
    if (legacy) { legacy.unbind(); legacy = null; }
    command('unbind');
    bound = ws ? { ctx, ws, local: next } : null;
    if (bound) announce();
  }

  function announce() {
    const { on, since, mrev } = bound.local;
    send({ t: 'backup.state', on, since, mrev, photoCredit: 1 });
  }

  peer.on('client', () => { generation++; refresh(); pushState(); });
  peer.on('closed', (ctx) => {
    if (bound?.ctx === ctx || archive) { generation++; refresh(); pushState(); }
  });
  peer.on('transport', (ctx) => {
    if (peer.current === ctx) { generation++; refresh(); pushState(); }
  });

  function rejectFlight() {
    fence(true);
    refuse('checksum');
    post(null, 'invalid');
  }

  for (const type of TYPES) {
    peer.on(`t:${type}`, (msg, ctx, ws, bytes) => {
      if (!bound || ctx !== bound.ctx || ws !== bound.ws || socket(ctx) !== ws) return;
      const oversized = (bytes ?? Buffer.byteLength(JSON.stringify(msg))) > 64 * 1024;
      if (oversized) {
        if (legacy?.flight && legacy.flight.req === msg.req) legacy.failItem('checksum');
        else if (flight && flight.take.req === msg.req) rejectFlight();
        else {
          const req = typeof msg.req === 'string' && /^[0-9A-Za-z._-]{1,64}$/.test(msg.req) ? msg.req : undefined;
          send({ t: 'backup.refuse', req, rev: bound.state?.rev, mrev: bound.local.mrev, why: 'checksum' });
        }
        return;
      }
      if (type === P.T.BACKUP_STATE) {
        if (!PB.validPhoneState(msg)) return;
        const prev = bound.state;
        if (prev && (msg.rev < prev.rev || (msg.rev === prev.rev && (msg.on !== prev.on || msg.since !== prev.since)))) return;
        bound.state = msg;
        if (!bound.mode) {
          bound.mode = msg.photoCredit === 1 ? 'credit' : 'legacy';
          activate();
          return;
        }
        if (flight && prev && ['rev', 'on', 'since', 'perm', 'loc', 'api'].some((key) => prev[key] !== msg[key])) {
          fence(true);
        }
      }
      if (legacy) {
        legacy.receive(msg, ws);
        if (type !== P.T.BACKUP_CHUNK) pushState();
        return;
      }
      if (bound.mode !== 'credit') return;
      if (type === 'backup.accept' || type === 'backup.chunk' || type === 'backup.end') {
        if (!flight || flight.take.req !== msg.req || cancelled) return;
        if (type === 'backup.accept' && !flight.accepted) flight.accepted = true;
        else if (type === 'backup.chunk' && flight.written !== null && msg.seq === flight.seq) flight.written = null;
        else if (type === 'backup.end' && flight.written === flight.take.size) flight.written = null;
        else {
          rejectFlight();
          return;
        }
        watch();
      } else if (flight && flight.take.req === msg.req && (type === 'backup.stop' || type === 'backup.refuse')) {
        fence(true);
      }
      post(msg);
    });
  }

  if (peer.current) refresh();

  function current(target) {
    return target && target.generation === generation && target.ctx === control(undefined, false) &&
      target.ws === target.ctx.ws ? target.ctx : null;
  }

  function persist(ctx, next) {
    Object.defineProperty(peers(), ctx.deviceId, { value: next, configurable: true, writable: true, enumerable: true });
    generation++;
    const apply = () => refresh();
    if (!next.on) apply(); // in-memory revoke is immediate even if saving fails
    try { save(); } catch {
      next.on = false;
      apply();
      pushState();
      return false;
    }
    if (next.on) apply();
    pushState();
    return true;
  }

  return {
    target(version) {
      const ctx = control(undefined, false);
      return ctx && version === generation ? { ctx, ws: ctx.ws, generation } : null;
    },
    async update(target, { on, folder } = {}) {
      const ctx = current(target);
      if (!ctx || ((on === true || folder) && !socket(ctx))) return false;
      const p = row(ctx);
      if (folder) {
        try {
          const real = await fs.realpath(folder);
          if (!path.isAbsolute(real) || !(await fs.stat(real)).isDirectory()) return false;
          if (current(target) !== ctx || !socket(ctx)) return false;
          p.folder = real;
        } catch { return false; }
      }
      if (typeof on === 'boolean') {
        if (on && !p.folder) return false;
        if (p.on !== on && on) p.since = Date.now();
        p.on = on;
      }
      p.rev += 1;
      return persist(ctx, p);
    },
    refresh() { generation++; refresh(); pushState(); },
    close() {
      if (legacy) legacy.unbind();
      command('close');
      clearTimeout(restart);
      retire();
      bound = archive = null;
      closed = true;
      generation++;
    },
    forget(id) {
      const key = String(id || '');
      generation++;
      if (archive?.origin.startsWith(key + ':')) { archive = latest = null; }
      if (bound && bound.ctx.deviceId === key) { if (legacy) { legacy.unbind(); legacy = null; } command('unbind'); bound = null; }
      if (Object.hasOwn(peers(), key)) { delete peers()[key]; save(); }
      pushState();
    },
    latest() {
      const ctx = control();
      if (!ctx || archive?.origin !== `${ctx.deviceId}:${ctx.photoBackupPair}` || !row(ctx).on) return null;
      return legacy ? findLatest(legacy.ledger, archive.origin, archive.folder) : latest;
    },
    recheckLatest(receipt) {
      if (receipt !== latest || closed || !worker || retiring || rechecking) return;
      rechecking = true;
      post(null, 'recheck');
    },
    view() {
      const ctx = control(undefined, false);
      if (!ctx) return null;
      const p = row(ctx);
      if (!enabled()) return null;
      const here = !!bound && bound.ctx === ctx && bound.ws === socket(ctx);
      return {
        on: p.on, folder: p.folder, generation, available: here,
        why: here ? (legacy ? legacy.why() || legacy.problem : status)
          : (ctx.transport === 'ble' ? 'transport' : ctx.photoBackup === true ? 'wait' : 'peer'),
        peer: ctx.photoBackup === true,
        name: ctx.name || '',
      };
    },
  };
}
module.exports = { attach };
