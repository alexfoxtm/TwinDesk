// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A user-started Android companion approval needs the existing BLE service even while Wi-Fi
// normally keeps it quiet. The lease belongs to that authenticated socket, never the selection.
'use strict';

const P = require('../shared/protocol.js');
const TYPE = 'companion.advertise';
const LEASE_MS = 60000;

class CompanionAdvertise {
  constructor({ server, pairing, apply, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { server, pairing, apply, now, setTimer, clearTimer });
    this.lease = null;
    server.on('message', (m, ctx) => { if (m.t === TYPE) this.request(m, ctx); });
    server.on('closed', (ctx) => { if (this.lease && this.lease.ctx === ctx) this.end(this.lease); });
    server.on('client', () => { if (this.lease && !this.valid(this.lease.ctx)) this.end(this.lease); });
    pairing.on('change', () => { if (this.lease && !this.valid(this.lease.ctx)) this.end(this.lease); });
  }

  valid(ctx) {
    const current = this.server.clients ? this.server.clients.get(ctx && ctx.deviceId) : this.server.current;
    return !!ctx && ctx.authed === true && ctx.released !== true && ctx.ws && ctx.ws.readyState === ctx.ws.OPEN &&
      ctx.os === P.OS.ANDROID && current === ctx &&
      this.pairing.list().some((p) => p.id === ctx.deviceId);
  }

  get active() {
    const lease = this.lease;
    return !!lease && this.valid(lease.ctx) && this.now() < lease.until;
  }

  accepts(id) { return this.active && this.lease.ctx.deviceId === id; }

  reply(ctx, requestId, on, expiresInMs) {
    this.server.send(ctx, { t: TYPE, requestId, on, ...(on ? { expiresInMs } : {}) });
  }

  request(m, ctx) {
    if (!this.valid(ctx) || typeof m.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.requestId) || typeof m.on !== 'boolean') return;
    const old = this.lease;
    if (!m.on) {
      if (old && old.ctx === ctx && old.requestId === m.requestId) this.end(old);
      else this.reply(ctx, m.requestId, false);
      return;
    }
    if (old) {
      if (old.ctx === ctx && old.requestId === m.requestId && this.active) {
        this.reply(ctx, m.requestId, true, Math.max(0, old.until - this.now()));
      } else this.reply(ctx, m.requestId, false);
      return;
    }
    const lease = { ctx, requestId: m.requestId, until: this.now() + LEASE_MS, timer: null };
    this.lease = lease;
    lease.timer = this.setTimer(() => this.end(lease), LEASE_MS);
    if (lease.timer && lease.timer.unref) lease.timer.unref();
    this.apply();
    this.reply(ctx, m.requestId, true, LEASE_MS);
  }

  end(lease) {
    if (this.lease !== lease) return;
    this.lease = null;
    this.clearTimer(lease.timer);
    this.apply();
    if (this.valid(lease.ctx)) this.reply(lease.ctx, lease.requestId, false);
  }
}

module.exports = { CompanionAdvertise };
