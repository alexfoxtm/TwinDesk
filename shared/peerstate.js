// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device: remembers each connected peer's latest audio/screen policy or state while it is
// unselected, bound to the exact live primary socket it arrived on, and tears down active outbound
// audio/screen policies when a route or facade leaves a still-connected peer.
//
// Scope (#313): strictly limited to audio.policy, screen.state and screen.policy. Excludes
// hub.state (Save As requires true ingress), call state, clipboard and other authenticated
// capability payloads. A stale, fallback (alt), closed, released, detached or replaced socket
// never records state and never confers permission on a new active connection (including
// same-device-ID reconnection or IP-to-IP resume).
'use strict';

const OPEN = 1; // WebSocket.OPEN

// Remembered peer media policy/state messages; latest per type supersedes earlier ones on the same socket.
const REMEMBER = new Set([
  'audio.policy', // {accept}: it plays our sound
  'screen.state', // {on, mode, remote, modes}: what it shares
  'screen.policy', // {accept}: its viewer wants our picture
]);

// Outbound policies switched off when a route or facade leaves a still-connected peer.
const GOODBYE = {
  'audio.policy': 'accept',
  'screen.policy': 'accept',
};

function socketLive(ws) {
  return !!ws && typeof ws === 'object' && ws.readyState === OPEN && ws.released !== true && ws.detached !== true;
}

// The session's single active primary socket (matching outboundOf in shared/hub-route.js).
// Never a fallback (alt), closed/closing, released, detached or unauthenticated socket.
function activeSocket(session) {
  if (!session || typeof session !== 'object' || !session.connected) return null;
  if (typeof session.outbound === 'function') {
    let ws = null;
    try { ws = session.outbound(); } catch { return null; }
    return socketLive(ws) ? ws : null;
  }
  if (session.linkUp && session.link && session.link.authed !== false) {
    return socketLive(session.link.ws) ? session.link.ws : null;
  }
  const ctx = session.ctx;
  if (session.hostUp && ctx && ctx.authed === true && ctx.released !== true) {
    return socketLive(ctx.ws) ? ctx.ws : null;
  }
  return null;
}

// Extract the live physical socket from either a raw ws or the fork's { arrived, conn, ws } envelope.
function arrivalSocket(source) {
  if (!source || typeof source !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(source, 'arrived')) {
    if (source.arrived !== true || !source.conn || !source.ws) return null;
    if (source.conn.released === true || source.conn.authed === false) return null;
    if (source.ws !== source.conn.ws) return null;
    return socketLive(source.ws) ? source.ws : null;
  }
  return socketLive(source) ? source : null;
}

// The last REMEMBER message of each type from each device id, bound to its active primary socket.
class Heard {
  constructor() {
    this.by = new Map(); // id -> { ws, msgs: Map(type -> msg) }
  }

  // Evict remembered state immediately if the session's active primary socket changed or went away.
  sync(session) {
    if (!session || !session.id) return null;
    const active = activeSocket(session);
    const cur = this.by.get(session.id);
    if (cur && cur.ws !== active) this.by.delete(session.id);
    return active;
  }

  // Record msg only when it is in REMEMBER and arrived on the session's current active primary socket.
  note(session, msg, source) {
    const active = this.sync(session);
    if (!active || !msg || typeof msg !== 'object' || !REMEMBER.has(msg.t)) return false;
    const ws = arrivalSocket(source);
    if (!ws || ws !== active) return false;
    let entry = this.by.get(session.id);
    if (!entry) {
      entry = { ws: active, msgs: new Map() };
      this.by.set(session.id, entry);
    }
    entry.msgs.set(msg.t, msg);
    return true;
  }

  // Copies without `ask`, paired with the verified live socket they arrived on.
  replayEntries(session) {
    const active = this.sync(session);
    if (!active) return [];
    const entry = this.by.get(session.id);
    if (!entry || entry.ws !== active) return [];
    return [...entry.msgs.values()].map((m) => {
      const copy = { ...m };
      delete copy.ask;
      return { msg: copy, ws: active };
    });
  }

  // Convenience view of the replayed messages for this session's current active socket.
  replay(session) {
    return this.replayEntries(session).map((e) => e.msg);
  }

  // The device went away or was replaced: its next connection must announce fresh state.
  forget(id) {
    if (id) this.by.delete(id);
  }
}

// The GOODBYE policies one facade or route sent to its current target device.
class Said {
  constructor() {
    this.id = null;
    this.on = new Map(); // type -> true while we told it the policy is on
  }

  note(id, msg) {
    if (!id || !msg || typeof msg !== 'object') return;
    const field = GOODBYE[msg.t];
    if (!field) return;
    if (id !== this.id) {
      this.id = id;
      this.on.clear();
    }
    if (msg[field] === true) this.on.set(msg.t, true);
    else this.on.delete(msg.t);
  }

  // The teardown messages for `id`, once; then nothing is left to switch off.
  goodbyes(id) {
    if (!id || id !== this.id) return [];
    const out = [...this.on.keys()].map((t) => ({ t, [GOODBYE[t]]: false }));
    this.on.clear();
    this.id = null;
    return out;
  }

  forget(id) {
    if (id && id === this.id) {
      this.on.clear();
      this.id = null;
    }
  }
}

module.exports = { Heard, Said, REMEMBER, GOODBYE, activeSocket, arrivalSocket };
