// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bind photo backup and folder choices to the authenticated connection that owns them.
'use strict';

const fs = require('fs');
const path = require('path');
const PB = require('../shared/photobackup');
const P = require('../shared/protocol');
const { connectionOf } = require('../shared/asked-send');

const TYPES = [
  P.T.BACKUP_STATE, P.T.BACKUP_INV, P.T.BACKUP_ACCEPT, P.T.BACKUP_CHUNK,
  P.T.BACKUP_END, P.T.BACKUP_REFUSE, P.T.BACKUP_STOP,
];

function attach({ store, settings, peer, pushState, save, enabled = () => true }) {
  const ledger = new PB.Ledger(store.filePath('photo-backup.json'));
  let bound = null;
  let closed = false;
  let generation = 0;
  const engine = new PB.Mac(ledger, {
    send(msg) {
      const { ctx, ws } = bound || {};
      if (!ctx || socket(ctx) !== ws || engine.conn !== ws) return false;
      // The current primary IP socket is also the outbound socket. Do not queue backup traffic.
      peer.send(ctx, msg);
      return true;
    },
    changed: pushState,
  });

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
    if (bound && bound.ctx === ctx && bound.ws === ws) {
      engine.setLocal(local(ctx)); // module/settings changes affect an existing connection
      return;
    }
    if (bound) engine.unbind();
    bound = ws ? { ctx, ws } : null;
    if (bound) engine.bind(ws, ctx.deviceId, {
      transport: 'ip', peerPb: true, origin: `${ctx.deviceId}:${ctx.photoBackupPair}`, local: local(ctx),
    });
  }

  peer.on('client', () => { generation++; refresh(); pushState(); });
  peer.on('closed', (ctx) => {
    if (bound && bound.ctx === ctx) { generation++; refresh(); pushState(); }
  });
  peer.on('transport', (ctx) => {
    if (peer.current === ctx) { generation++; refresh(); pushState(); }
  });

  for (const type of TYPES) {
    peer.on(`t:${type}`, (msg, ctx, ws) => {
      if (!bound || ctx !== bound.ctx || ws !== bound.ws || socket(ctx) !== ws) return;
      engine.receive(msg, ws);
      if (type !== P.T.BACKUP_CHUNK) pushState();
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
    const apply = () => { if (bound && bound.ctx === ctx) engine.setLocal(local(ctx)); };
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
    update(target, { on, folder } = {}) {
      const ctx = current(target);
      if (!ctx || ((on === true || folder) && !socket(ctx))) return false;
      const p = row(ctx);
      if (folder) {
        try {
          const real = fs.realpathSync(folder);
          if (!path.isAbsolute(real) || !fs.statSync(real).isDirectory()) return false;
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
      if (bound) engine.unbind();
      bound = null;
      closed = true;
      generation++;
    },
    forget(id) {
      const key = String(id || '');
      generation++;
      if (bound && bound.ctx.deviceId === key) { engine.unbind(); bound = null; }
      if (Object.hasOwn(peers(), key)) { delete peers()[key]; save(); }
      pushState();
    },
    latest() {
      const ctx = control();
      if (!ctx || ledger.broken) return null;
      const { on, folder } = row(ctx);
      if (!on || !folder) return null;
      const history = ledger.data.peers[`${ctx.deviceId}:${ctx.photoBackupPair}`]?.items || {};
      const candidates = [];
      for (const item of Object.values(history)) {
        for (const receipt of Object.values(item || {})) {
          if (receipt?.state === 'done' && receipt.root === folder && Number.isFinite(receipt.mtime)) {
            candidates.push(receipt);
          }
        }
      }
      candidates.sort((a, b) => b.mtime - a.mtime);
      try {
        for (const receipt of candidates) {
          if (ledger.hasArchived(receipt, folder, receipt.size)) {
            return { path: receipt.dest, name: path.basename(receipt.dest), size: receipt.size, at: receipt.mtime };
          }
        }
      } catch { /* the archive folder may be offline */ }
      return null;
    },
    view() {
      const ctx = control(undefined, false);
      if (!ctx) return null;
      const p = row(ctx);
      if (!enabled()) return null;
      const here = !!bound && bound.ctx === ctx && bound.ws === socket(ctx);
      return {
        on: p.on, folder: p.folder, generation, available: here,
        why: here ? (engine.why() || engine.problem)
          : (ctx.transport === 'ble' ? 'transport' : ctx.photoBackup === true ? 'wait' : 'peer'),
        peer: ctx.photoBackup === true,
        name: ctx.name || '',
      };
    },
  };
}
module.exports = { attach };
