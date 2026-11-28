// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Pairing (numeric comparison), paired.json, and `hello` auth.
//
// Events: 'change' — the pending request or the paired list changed;
//         'request' — a new code is ready to show (bring the window to the front).
'use strict';

const { EventEmitter } = require('events');
const { PhonePreviews } = require('../phone-preview.js');
const P = require('../../shared/protocol.js');
const { PairFails } = require('../../shared/pairfail.js');
const store = require('./store');

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const RETURNS = 'phone-return-mesh.json';

class Pairing extends EventEmitter {
  // identity: {macId, macName, fp}. storage: {read, write} (default: store.js). No client is refused
  // because another one is connected (mesh, docs/mesh.md): one pairing at a time.
  constructor(server, identity, { storage } = {}) {
    super();
    this.store = storage || store;
    this.server = server;
    this.id = identity;
    this.paired = this.store.read('paired.json', []);
    const saved = this.store.read(RETURNS, []);
    this.returnPairs = new Set(this.paired.filter((e) =>
      e.os === P.OS.ANDROID && Array.isArray(saved) && saved.includes(e.tokenHash)).map((e) => e.tokenHash));
    this.previews = new PhonePreviews(this);
    this.pending = null; // {ctx, id, name, commit, nm, nw, code, confirmed, allowed, timer}
    this.fails = new PairFails(); // failed pairings per address: a lockout after too many (#136)
    server.on('preauth', (ctx, msg) => this._onMessage(ctx, msg));
    server.on('closed', (ctx) => this._onClosed(ctx));
    server.on('client', (ctx) => {
      if (ctx.os === P.OS.ANDROID) this._setReturn(ctx.deviceId, true);
    });
    server.on('noreclaim', (id) => this._setReturn(id, false));
  }

  list() {
    return this.paired.map(({ id, name, os, pairedAt, lastSeen }) => ({ id, name, os: os || P.OS.WIN, pairedAt, lastSeen }));
  }

  // What the control window shows about an in-progress request.
  pendingView() {
    const p = this.pending;
    return p && { name: p.name, os: p.os, code: p.code, confirmed: p.confirmed, allowed: p.allowed, wired: p.wired, qr: p.qr };
  }

  touch(id) {
    const e = this.paired.find((x) => x.id === id);
    if (!e) return;
    e.lastSeen = Date.now();
    this._save();
  }

  forget(id) {
    this._setReturn(id, false);
    // A pairing from it still going would add it straight back when it finishes: it ends here.
    const p = this.pending;
    if (p && p.id === id) { this._clear(); this.server.fail(p.ctx, P.E.PAIR_REFUSED, 'The pairing was forgotten'); }
    this.paired = this.paired.filter((x) => x.id !== id);
    this._save();
    this.server.closeDevice(id, P.E.BAD_TOKEN, 'This Mac forgot the pairing');
    this.emit('change');
  }

  // A pairing without the 6-digit flow, for a device the mesh introduces (shared/intro.js): the same
  // entry as a finished pairing. Returns the credential for the guest, or null (bad id, list full).
  grantFor({ id, name, os } = {}) {
    if (typeof id !== 'string' || !id || id.length > 128 || id === this.id.macId) return null;
    if (!this.paired.some((x) => x.id === id) && this.paired.length >= P.MAX_DEVICES) return null;
    const token = P.randomHex(32);
    const now = Date.now();
    this._setReturn(id, false);
    const entry = { id, name: String(name || 'Device').slice(0, 64), os: Object.values(P.OS).includes(os) ? os : P.OS.WIN, tokenHash: P.sha256Hex(token), pairedAt: now, lastSeen: now };
    this.paired = this.paired.filter((x) => x.id !== id);
    this.paired.push(entry);
    this._save();
    console.log(`[pairing] introduced ${entry.name} (${id}) by the mesh`);
    this.emit('change');
    return { token, macId: this.id.macId, macName: this.id.macName, os: P.OS.MAC, fp: this.id.fp };
  }

  // Local Allow / Deny.
  respond(allow) {
    const p = this.pending;
    if (!p) return;
    if (!allow) return this._abort(P.E.PAIR_REFUSED, 'The Mac user denied pairing');
    if (!p.code) return; // nothing to compare yet
    p.allowed = true;
    this.emit('change');
    this._maybeFinish();
  }

  _save() {
    this.store.write('paired.json', this.paired);
  }

  _setReturn(id, allow) {
    const e = this.paired.find((entry) => entry.id === id && entry.os === P.OS.ANDROID);
    if (!e || this.returnPairs.has(e.tokenHash) === allow) return;
    if (allow) this.returnPairs.add(e.tokenHash);
    else this.returnPairs.delete(e.tokenHash);
    try {
      this.store.write(RETURNS, [...this.returnPairs]);
    } catch (error) {
      this.returnPairs.clear();
      try { require('fs').unlinkSync(this.store.filePath(RETURNS)); }
      catch (removeError) {
        if (removeError.code !== 'ENOENT') console.error('[pairing] automatic return revocation failed:', removeError.code);
      }
      console.error('[pairing] automatic return disabled:', error.code || 'write');
    }
  }

  _onMessage(ctx, msg) {
    if (msg.t === P.T.HELLO) return this._hello(ctx, msg);

    const p = this.pending;
    if (msg.t === P.T.PAIR_START) {
      if (this.fails.locked(ctx.address)) {
        return this.server.fail(ctx, P.E.PAIR_REFUSED, 'Too many failed pairing attempts from this address; wait a few minutes and try again');
      }
      if (p && p.ctx !== ctx) return this.server.fail(ctx, P.E.BUSY, 'Another pairing is in progress');
      if (p) return this.server.fail(ctx, P.E.BAD_MESSAGE, 'Pairing already started');
      if (msg.v !== P.PROTOCOL_VERSION) {
        return this.server.fail(ctx, P.E.VERSION_MISMATCH, `Mac speaks protocol v${P.PROTOCOL_VERSION}`);
      }
      if (typeof msg.id !== 'string' || !msg.id || typeof msg.commit !== 'string' || !HEX(64).test(msg.commit)) {
        this.fails.fail(ctx.address);
        return this.server.fail(ctx, P.E.BAD_MESSAGE, 'pair.start needs id and commit');
      }
      const embedded = !!ctx.embeddedPeer;
      if (embedded && (!P.isPhoneOs(msg.os) || !this.embeddedTailnet?.knows(msg.wired))) {
        return this.server.fail(ctx, P.E.PAIR_REFUSED, 'Open a fresh embedded Tailscale pairing QR on this Mac');
      }
      const nm = P.randomHex(16);
      this.pending = {
        ctx,
        id: msg.id,
        name: String(msg.name || 'PC').slice(0, 64),
        os: Object.values(P.OS).includes(msg.os) ? msg.os : P.OS.WIN,
        commit: msg.commit,
        nm,
        nw: null,
        code: null,
        confirmed: false,
        allowed: false,
        // A phone on the USB cable, with the nonce wired.js sent it through adb (wired.knows):
        // no code to compare, only Allow here.
        wired: !embedded && !!(this.isWired && this.isWired(msg.wired)),
        embeddedNonce: embedded ? msg.wired : null,
        qr: embedded || !!(this.isQr && this.isQr(msg.wired)), // the same, by Connection's QR code: on the network
        timer: setTimeout(() => this._abort(P.E.PAIR_TIMEOUT, 'Pairing timed out'), P.PAIR_TIMEOUT_MS),
      };
      this.server.send(ctx, { t: P.T.PAIR_NONCE, nonce: nm, os: P.OS.MAC });
      return this.emit('change');
    }

    if (!p || p.ctx !== ctx) {
      if (msg.t === P.T.PAIR_CANCEL) return ctx.ws.close();
      return this.server.fail(ctx, P.E.BAD_MESSAGE, `"${msg.t}" without pair.start`);
    }

    switch (msg.t) {
      case P.T.PAIR_REVEAL:
        if (p.nw || typeof msg.nonce !== 'string' || !HEX(32).test(msg.nonce) || P.commitOf(msg.nonce) !== p.commit) {
          return this._abort(P.E.PAIR_REFUSED, 'Nonce does not match the commitment');
        }
        p.nw = msg.nonce;
        p.code = P.sasCode(this.id.fp, p.nw, p.nm);
        this.emit('change');
        this.emit('request');
        return;
      case P.T.PAIR_CONFIRM:
        if (!p.code) return this._abort(P.E.BAD_MESSAGE, 'pair.confirm before pair.reveal');
        p.confirmed = true;
        this.emit('change');
        return this._maybeFinish();
      case P.T.PAIR_CANCEL:
        this.fails.fail(p.ctx.address); // a cancel after an accepted start counts toward the lockout
        this._clear();
        ctx.ws.close();
        return;
      default:
        return this._abort(P.E.BAD_MESSAGE, `Unexpected "${msg.t}" during pairing`);
    }
  }

  _maybeFinish() {
    const p = this.pending;
    if (!p || !p.confirmed || !p.allowed) return;
    if (p.embeddedNonce && !this.embeddedTailnet?.knows(p.embeddedNonce)) {
      return this._abort(P.E.PAIR_REFUSED, 'The embedded Tailscale pairing QR expired');
    }
    const token = P.randomHex(32);
    const now = Date.now();
    this._setReturn(p.id, false);
    this.paired = this.paired.filter((x) => x.id !== p.id);
    this.paired.push({
      id: p.id, name: p.name, os: p.os, tokenHash: P.sha256Hex(token), pairedAt: now, lastSeen: now,
      ...(p.embeddedNonce ? { tailNode: p.ctx.embeddedPeer } : {}),
    });
    this._save();
    this.fails.clear(p.ctx.address);
    this.server.send(p.ctx, { t: P.T.PAIR_OK, token, macId: this.id.macId, macName: this.id.macName, os: P.OS.MAC, mesh: 1 });
    console.log(`[pairing] paired with ${p.name} (${p.id})`);
    if (p.embeddedNonce) this.embeddedTailnet.consume(p.embeddedNonce);
    else if (p.qr && this.consumeQr) this.consumeQr(); // a QR pairing that went through: the link is single-use
    this._clear();
  }

  _hello(ctx, msg) {
    if (msg.v !== P.PROTOCOL_VERSION) {
      return this.server.fail(ctx, P.E.VERSION_MISMATCH, `Mac speaks protocol v${P.PROTOCOL_VERSION}`);
    }
    const e = this.paired.find((x) => x.id === msg.id);
    const newTailBinding = ctx.embeddedPeer && e?.tailNode == null &&
      e?.os === P.OS.ANDROID && msg.os === P.OS.ANDROID;
    if (!e || !P.tokenMatches(msg.token, e.tokenHash) ||
        (ctx.embeddedPeer && ctx.embeddedPeer !== e.tailNode && !newTailBinding)) {
      return this.server.fail(ctx, P.E.BAD_TOKEN, 'Not paired with this Mac');
    }
    let gate;
    if (msg.rc === 1) {
      if (e.os !== P.OS.ANDROID || msg.os !== P.OS.ANDROID) {
        return this.server.fail(ctx, P.E.BAD_MESSAGE, 'Reclaim is only for a paired phone');
      }
      gate = () => this.paired.includes(e) && this.returnPairs.has(e.tokenHash);
      if (!gate()) return this.server.fail(ctx, P.E.RELEASED, 'The Mac disconnected');
      ctx.automaticReturn = true;
      ctx.returnBase = this.server.clients.get(e.id);
    }
    if (typeof msg.name === 'string' && msg.name && msg.name !== e.name) e.name = msg.name.slice(0, 64);
    if (Object.values(P.OS).includes(msg.os)) e.os = msg.os;
    e.lastSeen = Date.now();
    this._save();
    ctx.ilWanted = !ctx.embeddedPeer && msg.il && typeof msg.il === 'object' ? msg.il : null; // the input lane (shared/inputlane.js)
    ctx.fx2Wanted = !ctx.embeddedPeer && msg.fx2 === 1; // … and the files engine (shared/meshfx2.js)
    if (!ctx.embeddedPeer && msg.netem === 1) ctx.netemRequested = true;
    ctx.embeddedMediaWanted = !!ctx.embeddedPeer && e.os === P.OS.ANDROID && msg.em === 1;
    if (e.os === P.OS.ANDROID && msg.pa === 1) ctx.appsPair = P.sha256Hex(`phone apps:${e.id}:${e.tokenHash}`);
    ctx.fxWanted = !ctx.embeddedPeer && msg.fx === 1; // fast files (shared/fastfile.js): the bytes over HTTPS, a token of this session
    ctx.mesh = !!msg.mesh; // the device speaks the mesh (docs/mesh.md): it gets the roster
    this.previews.authorize(ctx, e);
    this.server.authenticate(ctx, { deviceId: e.id, name: e.name, os: e.os || P.OS.WIN, cable: msg.cable }, {
      t: P.T.WELCOME, v: P.PROTOCOL_VERSION, macId: this.id.macId, macName: this.id.macName, os: P.OS.MAC, mesh: 1,
      ...(ctx.appsPair ? { pa: 1 } : {}),
      ...(e.os === P.OS.ANDROID ? { rc: 1 } : {}),
      tail: require('../../shared/tailnet.js').mine(), // its Tailscale addresses, for reconnecting away from this network (#161)
    }, gate);
    // Embedded HELLO authenticates synchronously. Learn its witnessed node only after admission.
    if (newTailBinding && ctx.authed && this.paired.includes(e)) {
      e.tailNode = ctx.embeddedPeer;
      this._save();
    }
    this.emit('change');
  }

  _abort(code, message) {
    const p = this.pending;
    if (!p) return;
    this.fails.fail(p.ctx.address); // a denial, a wrong code, a timeout: all count toward the lockout
    this._clear();
    this.server.fail(p.ctx, code, message);
  }

  _clear() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.emit('change');
  }

  _onClosed(ctx) {
    if (this.pending && this.pending.ctx === ctx) {
      this.fails.fail(ctx.address); // a socket dropped mid-pairing counts like a cancel
      this._clear();
    }
    if (ctx.authed && ctx.deviceId) this.touch(ctx.deviceId);
    this.emit('change');
  }
}

module.exports = { Pairing };
