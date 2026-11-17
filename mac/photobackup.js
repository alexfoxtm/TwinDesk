// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac side of camera photo backup. The transfer itself is shared/photobackup.js. This file binds
// that engine to the one authenticated session socket (not Save, not the outbox, not fx).
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

function attach({ store, settings, peer, pushState, save }) {
  const ledger = new PB.Ledger(store.filePath('photo-backup.json'));
  let boundId = '';
  const engine = new PB.Mac(ledger, {
    send(msg) {
      const ctx = peer.current;
      if (!ctx || ctx.deviceId !== boundId) return false;
      const live = sessionSocket(ctx, peer.outbound(ctx));
      if (!live || live.conn !== engine.conn) return false;
      peer.send(ctx, msg);
      return true;
    },
  });

  function peers() {
    if (!settings.photoBackup || typeof settings.photoBackup !== 'object') settings.photoBackup = { peers: {} };
    if (!settings.photoBackup.peers || typeof settings.photoBackup.peers !== 'object') settings.photoBackup.peers = {};
    return settings.photoBackup.peers;
  }

  function row(id) {
    const p = peers()[id];
    return p ? { on: p.on === true, since: p.since || 0, rev: p.rev || 0, folder: p.folder || '' } : { on: false, since: 0, rev: 0, folder: '' };
  }

  function applyLocal(id) {
    const p = row(id);
    engine.setLocal({ on: p.on, since: p.since, mrev: p.rev, folder: p.folder });
  }

  // The socket a backup byte would use. Bluetooth, a replaced socket, or a guest link that is
  // not this view: nothing is bound, so nothing is written.
  function sessionSocket(ctx, ws) {
    if (!ctx || ctx !== peer.current || ctx.os !== P.OS.ANDROID || ctx.photoBackup !== true) return null;
    if ((ctx.transport || 'ip') !== 'ip') return null;
    const live = connectionOf(ctx, ws);
    if (!live || live.conn.transport === 'ble') return null;
    return live;
  }

  function bindCurrent(ctx) {
    const live = sessionSocket(ctx, ctx && peer.outbound(ctx));
    if (!live) {
      if (boundId) engine.unbind();
      boundId = '';
      return;
    }
    boundId = ctx.deviceId;
    engine.bind(live.conn, ctx.deviceId, { transport: 'ip', peerPb: true });
    applyLocal(ctx.deviceId);
  }

  peer.on('client', (ctx) => bindCurrent(ctx));
  peer.on('closed', () => {
    if (!boundId) return;
    engine.unbind();
    boundId = '';
  });
  peer.on('transport', () => {
    engine.invalidate();
    bindCurrent(peer.current);
    pushState();
  });

  for (const type of TYPES) {
    peer.on(`t:${type}`, (msg, ctx, ws) => {
      if (!ctx || ctx.os !== P.OS.ANDROID) return;
      const arrived = sessionSocket(ctx, ws != null ? ws : peer.outbound(ctx));
      if (!arrived || arrived.conn !== engine.conn) {
        engine.invalidate();
        if (peer.current === ctx) bindCurrent(ctx);
        const now = sessionSocket(ctx, peer.outbound(ctx));
        if (!arrived || !now || now.conn !== arrived.conn || engine.conn !== arrived.conn) return;
      }
      engine.receive(msg, arrived.conn);
      if (msg.t !== P.T.BACKUP_CHUNK) pushState();
    });
  }

  if (peer.current) bindCurrent(peer.current);

  function persist(id) {
    save();
    if (boundId === id) applyLocal(id);
    pushState();
  }

  return {
    setOn(on) {
      const ctx = peer.current;
      if (!ctx || ctx.os !== P.OS.ANDROID || !/^[0-9A-Za-z._-]{1,64}$/.test(ctx.deviceId)) return false;
      const id = ctx.deviceId;
      const cur = row(id);
      const next = on === true;
      if (cur.on === next) return true;
      if (next && !cur.folder) return false;
      cur.on = next;
      cur.rev += 1;
      if (next) cur.since = Date.now();
      peers()[id] = cur;
      persist(id);
      return true;
    },
    setFolder(folder) {
      const ctx = peer.current;
      if (!ctx || ctx.os !== P.OS.ANDROID || !/^[0-9A-Za-z._-]{1,64}$/.test(ctx.deviceId)) return false;
      let real;
      try {
        real = fs.realpathSync(folder);
        if (!path.isAbsolute(real) || !fs.statSync(real).isDirectory()) return false;
      } catch { return false; }
      const id = ctx.deviceId;
      const cur = row(id);
      if (cur.folder === real) return true;
      cur.folder = real;
      cur.rev += 1;
      peers()[id] = cur;
      persist(id);
      return true;
    },
    // The folder dialog came back: remember it, then turn backup on.
    enable(folder) {
      if (!this.setFolder(folder)) return false;
      return this.setOn(true);
    },
    forget(id) {
      const key = String(id || '');
      if (!Object.prototype.hasOwnProperty.call(peers(), key)) {
        if (boundId === key) { engine.unbind(); boundId = ''; pushState(); }
        return;
      }
      delete peers()[key];
      save();
      if (boundId === key) { engine.unbind(); boundId = ''; }
      pushState();
    },
    view() {
      const ctx = peer.current;
      if (!ctx || ctx.os !== P.OS.ANDROID) return null;
      const p = row(ctx.deviceId);
      const here = boundId === ctx.deviceId && engine.deviceId === ctx.deviceId;
      const why = here ? engine.why()
        : (ctx.transport === 'ble' ? 'transport' : ctx.photoBackup === true ? 'wait' : 'peer');
      return {
        on: p.on,
        folder: p.folder,
        why,
        peer: here ? engine.peerPb === true : ctx.photoBackup === true,
        name: ctx.name || '',
      };
    },
  };
}

module.exports = { attach };
