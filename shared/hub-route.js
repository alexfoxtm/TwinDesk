// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// One mesh feature’s route: a target device picked by hub, events like the one-to-one link API.
'use strict';

const { EventEmitter } = require('events');
const { Said, activeSocket } = require('./peerstate.js');

// What a feature sees of its device: the one-to-one "client" object (role 'guest' = it connected to
// this computer, 'host' = this computer is its guest).
const OPEN = 1; // WebSocket.OPEN

function socketOpen(ws) {
  return !!ws && typeof ws === 'object' && ws.readyState === OPEN && ws.released !== true && ws.detached !== true;
}

// The socket send() writes. The guest link wins when it is up (Mac Session.send, and Windows
// and Linux once they are not hosting). The host socket is used only when the guest link is not.
// Not the host ctx, and not the device id. ws, address and ice below stay as they were.
function outboundOf(s) {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.outbound === 'function') {
    let ws = null;
    try { ws = s.outbound(); } catch { return null; }
    return socketOpen(ws) ? ws : null;
  }
  if (s.linkUp && s.link && s.link.authed !== false) return socketOpen(s.link.ws) ? s.link.ws : null;
  const ctx = s.ctx;
  if (s.hostUp && ctx && ctx.authed === true && ctx.released !== true) return socketOpen(ctx.ws) ? ctx.ws : null;
  return null;
}

// The socket a message arrived on, still held by this session. A reconnect keeps the Link and
// replaces link.ws: the previous socket does not pass. A released host ctx does not pass either.
function ingressOf(s, sock) {
  if (!socketOpen(sock) || !s) return null;
  if (s.link && s.link.ws === sock) return s.linkUp && s.link.authed !== false ? sock : null;
  const ctx = s.ctx;
  if (!ctx || ctx.released === true || ctx.authed === false) return null;
  if (ctx.ws !== sock && ctx.alt !== sock) return null;
  return s.hostUp || ctx.authed === true ? sock : null;
}

function viewOf(s) {
  if (!s) return null;
  const c = s.hostUp ? s.ctx : null;
  return {
    deviceId: s.id,
    name: s.displayName(),
    os: s.peerOs,
    role: s.role,
    transport: s.transport,
    address: c ? c.address : (s.link && s.link.pairing ? s.link.pairing.address : ''),
    rttMs: s.status.rtt != null ? s.status.rtt : (c ? c.rttMs : null),
    lastRx: s.lastRx,
    authed: true,
    ws: c ? c.ws : (s.link ? s.link.ws : null),
    ice: c ? c.ice : null,
    // Save binds this: the outbound socket. Route.deliver replaces it with the ingress socket
    // when a message names the one it arrived on. Not a protocol field.
    conn: outboundOf(s),
    source: () => outboundOf(s),
  };
}

// Events: 'client' (view), 'closed' (view), 'rtt' (view), 't:<type>' (msg, view), 'message' (msg, view).
class Route extends EventEmitter {
  constructor(hub, pick) {
    super();
    this.hub = hub;
    this.pick = pick;
    this.targetId = null;
    this.lastView = null;
    this.stateFns = [];
    this.said = new Said(); // active outbound policies this route told its device (shared/peerstate.js)
    this._refreshing = false;
    this._refreshAgain = false;
  }

  get session() {
    return this.targetId ? this.hub.sessions.get(this.targetId) : null;
  }

  get current() {
    return viewOf(this.session);
  }

  refresh() {
    if (this._refreshing) {
      this._refreshAgain = true;
      return;
    }
    this._refreshing = true;
    try {
      do {
        this._refreshAgain = false;
        const want = this.pick(this.hub);
        const s = want ? this.hub.sessions.get(want) : null;
        const next = s && s.connected ? want : null;
        if (next === this.targetId) {
          this._stateChanged();
          continue;
        }
        this.drop();
        if (next) {
          const target = this.hub.sessions.get(next);
          if (target && target.connected) {
            this.targetId = next;
            this.lastView = viewOf(target);
            this.emit('client', this.lastView);
            this._replay(target);
          }
        }
        this._stateChanged();
      } while (this._refreshAgain);
    } finally {
      this._refreshing = false;
    }
  }

  _replay(target) {
    if (!this.hub.heard || !target) return;
    for (const { msg, ws } of this.hub.heard.replayEntries(target)) {
      if (this.targetId !== target.id || this.session !== target) break;
      if (activeSocket(target) !== ws) break;
      if (this.listenerCount(`t:${msg.t}`) > 0 || this.listenerCount('message') > 0) {
        this.deliver(msg, ws);
      }
    }
  }

  drop(id) {
    if (!this.targetId || (id && id !== this.targetId)) return;
    const oldId = this.targetId;
    const s = this.session;
    const v = this.lastView || {};
    // Leaving a still-connected peer (refresh, no id): switch off policies we told it.
    // Disconnecting or replaced peer (drop(id) from hub._down): forget without sending.
    const goodbyes = id ? (this.said.forget(oldId), []) : this.said.goodbyes(oldId);
    if (goodbyes.length && s && s.connected && outboundOf(s)) {
      for (const m of goodbyes) s.send(m);
    }
    this.targetId = null;
    this.lastView = null;
    this.emit('closed', v);
  }

  // ingress: the physical socket that received msg. Without it (Windows and Linux routes,
  // and a one-argument deliver) the view stays the outbound socket of current(), and nothing
  // else about the view changes. With it, conn/source are that socket, checked again against
  // the session — not whatever send() would use now.
  deliver(msg, ingress) {
    const s = this.session;
    if (!s) return false;
    if (this.tap) this.tap(msg);
    const v = viewOf(s);
    if (arguments.length > 1) {
      const captured = ingress && typeof ingress === 'object' ? ingress : null;
      v.conn = ingressOf(s, captured);
      v.source = () => ingressOf(s, captured);
    }
    this.emit(`t:${msg.t}`, msg, v);
    this.emit('message', msg, v);
    return true;
  }

  rtt(id) {
    if (id !== this.targetId) return;
    this.emit('rtt', viewOf(this.session));
  }

  send(obj) {
    if (this.hold && this.hold(obj)) return true;
    return this.sendNow(obj);
  }

  sendNow(obj) {
    const s = this.session;
    // Positive audio acceptance is replayable only if this route revokes it on leave.
    const msg = this.hub.heard && obj.t === 'audio.policy' && obj.accept === true
      ? { ...obj, meshLeave: true }
      : obj;
    const ok = !!s && s.send(msg) === true;
    if (ok) this.said.note(this.targetId, msg);
    return ok;
  }

  inject(msg) {
    const s = this.session;
    if (s && s.connected) this.deliver(msg);
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  _stateChanged() {
    for (const fn of this.stateFns) fn();
  }
}

module.exports = { Route, viewOf, outboundOf, ingressOf };
