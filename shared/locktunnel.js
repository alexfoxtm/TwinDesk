// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A one-use ticket binds an opaque Screen Sharing tunnel to the current paired IP session.
'use strict';

const crypto = require('crypto');
const net = require('net');
const P = require('./protocol');

const digest = (value) => crypto.createHash('sha256').update(value).digest();
const address = (value) => String(value || '').replace(/^::ffff:/, '');
const MAX_CHUNK = 1024 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;

// Only the RFB version and security negotiation are inspected. Credentials and framebuffer data
// remain opaque. Reject pipelined bytes until the server has offered, and the client selected, ARD.
class ArdGate {
  constructor() { this.phase = 'banner'; this.server = Buffer.alloc(0); this.client = Buffer.alloc(0); }
  fromServer(data) {
    if (this.phase === 'ard') return data;
    if (this.phase !== 'banner' && this.phase !== 'types') throw new Error('Unexpected RFB server bytes');
    this.server = Buffer.concat([this.server, data]);
    if (this.server.length > 512) throw new Error('Invalid RFB negotiation');
    if (this.phase === 'banner') {
      if (this.server.length < 12) return null;
      if (this.server.length !== 12 || !/^RFB 003\.(008|889)\n$/.test(this.server.toString('ascii'))) throw new Error('Unsupported RFB version');
      this.phase = 'version';
      const banner = this.server;
      this.server = Buffer.alloc(0);
      return banner;
    }
    if (!this.server.length || this.server.length < this.server[0] + 1) return null;
    if (!this.server[0] || this.server.length !== this.server[0] + 1 || !this.server.subarray(1).includes(30)) throw new Error('ARD required');
    this.server = Buffer.alloc(0);
    this.phase = 'choice';
    return Buffer.from([1, 30]); // never advertise None, VNC-password, or another fallback to this client
  }
  fromClient(data) {
    if (this.phase === 'ard') return data;
    if (this.phase !== 'version' && this.phase !== 'choice') throw new Error('Unexpected RFB client bytes');
    this.client = Buffer.concat([this.client, data]);
    const need = this.phase === 'version' ? 12 : 1;
    if (this.client.length < need) return null;
    if (this.client.length !== need) throw new Error('Pipelined RFB authentication');
    if (this.phase === 'version') {
      if (this.client.toString('ascii') !== 'RFB 003.008\n') throw new Error('Unsupported RFB version');
      this.phase = 'types';
    } else {
      if (this.client[0] !== 30) throw new Error('ARD required');
      this.phase = 'ard';
    }
    const bytes = this.client;
    this.client = Buffer.alloc(0);
    return bytes;
  }
}

class LockTunnel {
  constructor({ current, allowed, ended = () => {}, hold = () => {}, connect = net.connect, verifyPeer = async () => false, now = Date.now }) {
    Object.assign(this, { current, allowed, ended, hold, connect, verifyPeer, now });
    this.pending = null;
    this.active = null;
    this.lastIssued = -Infinity;
    this.closed = false;
  }

  eligible(ctx) {
    return !this.closed && !!ctx && this.current() === ctx && ctx.authed === true && !ctx.released &&
      ctx.os === P.OS.ANDROID && ctx.transport === 'ip' && typeof ctx.resumeKey === 'string' && !!ctx.resumeKey &&
      ctx.ws && ctx.ws.readyState === ctx.ws.OPEN && this.allowed();
  }

  valid(binding) {
    return this.eligible(binding.ctx) && binding.ctx.ws === binding.ws &&
      binding.ctx.resumeKey === binding.key && address(binding.ctx.address) === binding.address;
  }

  issue(ctx, request) {
    if (!/^[a-f0-9]{32}$/.test(request || '') || !this.eligible(ctx) || this.active || this.now() - this.lastIssued < 2000) return null;
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.lastIssued = this.now();
    this.pending = { hash: digest(ticket), until: this.now() + P.LOCK_TICKET_MS, request,
      ctx, ws: ctx.ws, key: ctx.resumeKey, address: address(ctx.address) };
    return { ticket, request, path: P.LOCK_PATH, expiresIn: P.LOCK_TICKET_MS };
  }

  accept(ws, req) {
    const ticket = req.headers[P.LOCK_TICKET_HEADER];
    const binding = this.pending;
    // No URL credentials, cookies, destination, or forwarded address is trusted.
    if (req.url !== P.LOCK_PATH || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
        !binding || this.active || this.now() >= binding.until || !this.valid(binding) ||
        address(req.socket.remoteAddress) !== binding.address || !crypto.timingSafeEqual(digest(ticket), binding.hash)) {
      ws.on('error', () => {});
      ws.close(1008, 'Unavailable');
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref?.();
      return false;
    }
    this.pending = null; // consumed before asynchronous TCP connect, even if it fails
    const session = { ...binding, socket: ws, tcp: null, done: false, gate: new ArdGate() };
    this.active = session;
    this.hold(true);
    const finish = (reason = 'ended') => {
      if (session.done) return;
      session.done = true;
      clearTimeout(session.idle);
      clearTimeout(session.limit);
      clearTimeout(session.connectTimer);
      clearInterval(session.guard);
      if (session.tcp) session.tcp.destroy();
      ws.close(1000, 'Ended');
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref?.();
      if (this.active === session) this.active = null;
      this.hold(false);
      this.ended(binding.ctx, binding.request, reason);
    };
    session.finish = finish;
    const live = () => !session.done && this.valid(binding);
    session.guard = setInterval(() => { if (!live()) finish('session-ended'); }, 500);
    session.guard.unref?.();
    const touch = () => {
      clearTimeout(session.idle);
      session.idle = setTimeout(() => finish('timeout'), (session.continuing ? 30 : 3) * 60000);
      session.idle.unref?.();
    };
    session.touch = touch;
    session.armLocked = () => {
      session.continuing = false;
      clearTimeout(session.limit);
      session.limit = setTimeout(() => finish('timeout'), 5 * 60000);
      session.limit.unref?.();
      touch();
    };
    session.armLocked();
    session.connectTimer = setTimeout(() => finish('unavailable'), 3000);
    session.connectTimer.unref?.();
    touch();
    ws.on('close', () => finish());
    ws.on('error', () => finish('unavailable'));
    // Before TCP connects, the client must wait for the RFB banner. No arbitrary pre-connect queue.
    ws.on('message', (data, binary) => {
      if (!live()) return finish('session-ended');
      if (!binary || !session.verified || data.length > MAX_CHUNK || session.tcp.writableLength + data.length > MAX_BUFFER) return finish('unavailable');
      // A changed display layout invalidates the keeper's crop and pointer coordinates.
      if (session.inputSuspended) return;
      touch();
      try {
        const bytes = session.gate.fromClient(data);
        if (bytes && !session.tcp.write(bytes)) ws.pause();
      } catch { finish('unavailable'); }
    });
    try {
      const tcp = session.tcp = this.connect({ host: '127.0.0.1', port: 5900 });
      tcp.on('error', () => finish('unavailable'));
      tcp.on('close', () => finish());
      tcp.on('drain', () => { if (live()) ws.resume(); else finish('session-ended'); });
      tcp.on('connect', async () => {
        clearTimeout(session.connectTimer);
        tcp.pause(); // not even the RFB banner is exposed until this accepted peer is trusted
        if (!live()) return finish('session-ended');
        session.connectTimer = setTimeout(() => finish('unavailable'), 6000);
        session.connectTimer.unref?.();
        let trusted = false;
        try { trusted = await this.verifyPeer(tcp); } catch {}
        clearTimeout(session.connectTimer);
        if (!live()) return finish('session-ended');
        if (!trusted) return finish('unavailable');
        session.verified = true;
        tcp.setNoDelay(true);
        tcp.resume();
      });
      tcp.on('data', (data) => {
        if (!live()) return finish('session-ended');
        if (!session.verified || ws.bufferedAmount + data.length > MAX_BUFFER) return finish('unavailable');
        touch();
        try {
          const bytes = session.gate.fromServer(data);
          if (!bytes) return;
          tcp.pause();
          ws.send(bytes, { binary: true }, (err) => {
            if (err) return finish('unavailable');
            if (live()) tcp.resume(); else finish('session-ended');
          });
        } catch { finish('unavailable'); }
      });
    } catch { finish('unavailable'); }
    return true;
  }

  end(reason = 'ended') {
    this.pending = null;
    if (this.active) this.active.finish(reason);
  }

  // Keep an existing viewer through unlock; never issue a new ticket while unlocked.
  continueUnlocked(ctx) {
    const session = this.active;
    if (!session || session.ctx !== ctx || session.done || !session.ready || session.gate.phase !== 'ard' || !this.valid(session)) return false;
    session.continuing = true;
    clearTimeout(session.limit);
    session.touch();
    return true;
  }

  markReady(ctx, request) {
    const session = this.active;
    if (!session || session.ctx !== ctx || session.request !== request || session.gate.phase !== 'ard' || !this.valid(session)) return false;
    session.ready = true;
    return true;
  }

  keep(ctx, request) {
    const session = this.active;
    if (!session || session.ctx !== ctx || session.request !== request || !session.ready || !session.continuing || !this.valid(session)) return false;
    session.touch();
    return true;
  }

  suspendInput(ctx) {
    const session = this.active;
    if (!session || session.ctx !== ctx || !session.continuing || !this.valid(session)) return false;
    session.inputSuspended = true;
    return true;
  }

  close() {
    this.closed = true;
    this.end('session-ended');
  }
}

module.exports = { LockTunnel, ArdGate };
