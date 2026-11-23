// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Quiet links (shared/quiet.js, #143) in each session server (Mac, Windows, Linux): an older client
// that never says `idle` is pinged every second as before; a new one that is idle goes quiet (no pings
// but the safety one), input shared brings the second pings back, a message out while quiet gets a
// probe and a dead socket is closed, and coming out of quiet doesn't trip the 8 s limit at once.
// Run with: node shared/test/quiet-servers.js
'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

process.env.NODE_PATH = ['mac', 'windows', 'linux'].map((a) => path.join(__dirname, '..', '..', a, 'node_modules')).join(path.delimiter);
require('module').Module._initPaths();

const P = require('../protocol.js');
const Q = require('../quiet.js');

const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;

function server(file) {
  const { Server } = require(file);
  const s = Object.create(Server.prototype);
  EventEmitter.call(s);
  Object.assign(s, { sockets: new Set(), current: null, blePorts: new Map(), closed: false });
  return s;
}

function client(s) {
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, transport: 'ip', address: '10.0.0.2', lastRx: clock, send: (m) => sent.push(JSON.parse(m)), terminated: false };
  ws.terminate = () => { ws.terminated = true; ws.readyState = 3; };
  const ctx = { ws, alt: null, authed: true, deviceId: 'd1', name: 'Phone', address: '10.0.0.2', transport: 'ip', lastRx: clock, connectedAt: clock };
  ws.ctx = ctx;
  ws.sent = sent;
  s.sockets.add(ctx);
  s.current = ctx;
  const c = { ctx, ws, sent, dead: false };
  ctx.client = c;
  return c;
}

// A message from the client, as the socket hands it over.
const from = (s, c, msg) => s._onMessage(c.ctx, Buffer.from(JSON.stringify(msg)), false, c.ws);
const pings = (c) => c.sent.filter((m) => m.t === 'ping').length;
// A second goes by. A live client answers each ping (as it would); a dead one (c.dead) doesn't.
const second = (s, n = 1) => {
  for (let i = 0; i < n; i++) {
    clock += P.PING_MS;
    for (const ctx of [...s.sockets]) ctx.ws.seen = ctx.ws.sent ? ctx.ws.sent.length : 0;
    s._liveness();
    for (const ctx of [...s.sockets]) {
      const c = ctx.client;
      if (!c || c.dead || c.ws.terminated) continue;
      const fresh = c.sent.slice(c.ws.seen || 0);
      if (fresh.some((m) => m.t === 'ping')) from(s, c, { t: 'pong', ts: 1 });
    }
  }
};

try {
  for (const file of ['../../mac/server.js', '../../windows/server.js', '../../linux/server.js']) {
    const name = file.split('/')[2];

    // An older client: never says idle, pinged every second for good (as before).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      second(s, 120);
      assert.equal(pings(c), 120, `${name}: an older client is pinged every second`);
      assert.equal(c.ws.terminated, false);
      assert.deepEqual(c.sent.filter((m) => m.t === 'idle'), [{ t: 'idle', on: true }], `${name}: said idle once (ignored there)`);
    }

    // Both idle: quiet. No second pings; the safety ping; closed after a long silence.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, Q.ACTIVE_MS / P.PING_MS + 1);
      const before = pings(c);
      second(s, 60);
      assert.equal(pings(c), before, `${name}: no pings for a minute while quiet`);
      assert.equal(c.ws.terminated, false, `${name}: a minute's silence is fine while quiet`);
      c.dead = true; // from here on, nothing answers
      second(s, 5 * 60);
      assert.ok(pings(c) >= before + 1, `${name}: the safety ping`);
      assert.equal(c.ws.terminated, false);
      second(s, 7 * 60);
      assert.equal(c.ws.terminated, true, `${name}: silent past the quiet limit: closed`);
    }

    // Input shared (a hold): second pings again, and the old silence doesn't close it at once.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 4 * 60); // quiet, nothing heard for minutes (no pings to answer)
      Q.hold('kvm', true);
      const before = pings(c);
      second(s, 3);
      assert.equal(c.ws.terminated, false, `${name}: leaving quiet doesn't trip the 8 s limit`);
      assert.ok(pings(c) >= before + 3, `${name}: pinged every second while input is shared`);
      assert.deepEqual(c.sent.filter((m) => m.t === 'idle').pop(), { t: 'idle', on: false }, `${name}: the client hears busy`);
      c.dead = true;
      second(s, 10); // no answers at all now
      assert.equal(c.ws.terminated, true, `${name}: a dead socket is found within the 8 s limit again`);
      Q.hold('kvm', false);
    }

    // A message out while quiet: one probe; no answer, closed (and the client comes back).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      const before = pings(c);
      c.dead = true;
      s.send(c.ctx, { t: 'clip.text', text: 'hi' });
      second(s);
      assert.equal(pings(c), before + 1, `${name}: a probe after a message out`);
      second(s, 8);
      assert.equal(c.ws.terminated, true, `${name}: no answer to the probe: closed`);
    }

    // … answered: still quiet, no more pings.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      s.send(c.ctx, { t: 'clip.text', text: 'hi' });
      second(s); // the probe, answered
      const before = pings(c);
      second(s, 60);
      assert.equal(pings(c), before, `${name}: answered: quiet again`);
      assert.equal(c.ws.terminated, false);
    }

    // Messages coming in don't end the quiet (a battery level going by is one message, not a burst).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      const before = pings(c);
      for (let i = 0; i < 10; i++) { from(s, c, { t: 'phone.battery', level: 50 - i }); second(s, 20); } // within the safety ping's 5 min
      assert.equal(pings(c), before, `${name}: messages in: still quiet`);
    }

    // Prioritize performance over battery life: every second, as before.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      const settings = { app: { keepPinging: true } };
      Q.use(() => settings.app.keepPinging);
      from(s, c, { t: 'idle', on: true });
      second(s, 120);
      assert.ok(pings(c) >= 119, `${name}: Prioritize performance: pinged every second`);
      // An older phone said idle without perf. We answer once so it can learn the tier, and we do
      // not say on: an older build treats on:true as the 5 min quiet while we would still time out.
      assert.deepEqual(c.sent.filter((m) => m.t === 'idle'), [{ t: 'idle', on: false, perf: 1 }], `${name}: an older peer stays on the 1 s tier`);
    }

    // Through Bluetooth: never quiet (its own limits, as before).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      c.ws.transport = 'ble';
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      assert.equal(pings(c), 60, `${name}: Bluetooth: pinged every second`);
    }

    // Both new, both idle, Prioritize performance: a ping every 3 s, closed after 10 s not 8 s.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      Q.setKeep(true);
      from(s, c, { t: 'idle', on: true, perf: 1, keep: 1 });
      const stamps = [];
      for (let i = 0; i < 16 + 12; i++) {
        clock += P.PING_MS;
        const n = pings(c);
        s._liveness();
        if (pings(c) !== n) stamps.push(clock);
        const last = c.sent[c.sent.length - 1];
        if (!c.dead && !c.ws.terminated && last && last.t === 'ping') from(s, c, { t: 'pong', ts: 1 });
      }
      assert.equal(c.ws.terminated, false, `${name}: switching to 3 s does not drop the link`);
      assert.ok(stamps.length >= 4, `${name}: pings while the tier changes`);
      for (let i = 1; i < stamps.length; i++) {
        const gap = stamps[i] - stamps[i - 1];
        assert.ok(gap <= 4000, `${name}: tier-change gap ${gap} ms stays under the 8 s limit`);
      }
      const tail = stamps.slice(-3);
      assert.equal(tail[1] - tail[0], 3000, `${name}: once there, a ping every 3 s`);
      assert.equal(tail[2] - tail[1], 3000, `${name}: the 3 s gap holds`);
      from(s, c, { t: 'pong', ts: 1 });
      c.dead = true;
      second(s, 10);
      assert.equal(c.ws.terminated, false, `${name}: 10 s of silence is inside the idle performance limit`);
      second(s, 1);
      assert.equal(c.ws.terminated, true, `${name}: silent past 10 s: closed`);
    }

    // The other end has not switched yet (still answering, still on an 8 s limit). Our first 3 s
    // gap is the case above. Here WE have not switched: the peer already pings every 3 s and does
    // not pong, which is what an end on the new tier does while we are still at 1 s / 8 s.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      Q.setKeep(true);
      from(s, c, { t: 'idle', on: false, perf: 1 });
      c.dead = true;
      for (let i = 0; i < 24; i++) {
        clock += P.PING_MS;
        if (i % 3 === 2) from(s, c, { t: 'ping', ts: clock });
        s._liveness();
      }
      assert.equal(c.ws.terminated, false, `${name}: a peer that already pings every 3 s does not trip 8 s`);
      assert.ok(pings(c) >= 20, `${name}: we stay on the 1 s tier until the peer says idle`);
    }

    // Activity brings the 1 s ping and the 8 s limit back on the next liveness, and at once via onChange.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      s.tick = true;
      Q.onChange(() => { if (s.tick) s._liveness(); });
      Q.setKeep(true);
      from(s, c, { t: 'idle', on: true, perf: 1, keep: 1 });
      second(s, Q.ACTIVE_MS / P.PING_MS + 1);
      assert.equal(c.ws.terminated, false);
      const before = pings(c);
      Q.hold('kvm', true);
      assert.ok(pings(c) > before, `${name}: a hold pings on this tick, not at the next 3 s`);
      assert.deepEqual(c.sent.filter((m) => m.t === 'idle').pop(), { t: 'idle', on: false }, `${name}: the peer hears busy at once`);
      from(s, c, { t: 'pong', ts: 1 });
      c.dead = true;
      second(s, 8);
      assert.equal(c.ws.terminated, false, `${name}: back on the 8 s limit, 8 s is not over`);
      second(s, 1);
      assert.equal(c.ws.terminated, true, `${name}: back on the 8 s limit, closed at 9 s`);
      Q.hold('kvm', false);
    }

    // Minutes of quiet, then Prioritize performance. The idle message is not what refreshes rx:
    // the setting changes, and the following tick is given the old last-heard time.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true, perf: 1 });
      second(s, Q.ACTIVE_MS / P.PING_MS + 1);
      c.dead = true;
      second(s, 240);
      assert.equal(c.ws.terminated, false, `${name}: still inside the 5 min quiet`);
      Q.setKeep(true);
      second(s, 2);
      assert.equal(c.ws.terminated, false, `${name}: leaving a long quiet for the 3 s tier does not trip 10 s`);
    }

    // Liveness is silence of any message, not "the phone must ping". A phone that only answers
    // (its own pings stopped) stays up, and that pong is what rtt is measured from. The installed
    // Mac build does this the same way: _onMessage stamps lastRx before it looks at the type.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      second(s, 30);
      assert.equal(c.ws.terminated, false, `${name}: a phone that only answers pings is not dropped`);
      assert.ok(pings(c) >= 30, `${name}: this end keeps pinging`);
      assert.equal(typeof c.ctx.rttMs, 'number', `${name}: a pong still sets rtt`);
      assert.ok(c.ctx.rttMs >= 0, `${name}: rtt is not negative`);
    }

    console.log(`  ${name}: ok`);
  }

  // Multi-device (mac/mesh/server.js liveness). Busy stays 1 s / 8 s. An idle link stays on the
  // mesh 5 s / 15 s cadence until the peer says perf; then the same 3 s / 10 s tier.
  Q._reset();
  {
    const { Server } = require('../../mac/mesh/server.js');
    const mesh = () => {
      const s = Object.create(Server.prototype);
      EventEmitter.call(s);
      Object.assign(s, {
        sockets: new Set(), clients: new Map(), busyFlags: new Map(), blePorts: new Map(), primaryId: null,
        _now: () => clock,
        _raw(ws, m) { ws.send(JSON.stringify(m)); ws.lastTx = clock; },
        send(ctx, msg) { this._raw(ctx.ws, msg); ctx.lastTx = ctx.ws.lastTx; },
      });
      return s;
    };
    const phone = (s) => {
      const sent = [];
      const ws = { OPEN: 1, readyState: 1, transport: 'ip', address: '10.0.0.2', lastRx: clock, lastTx: 0, lastPing: 0, send: (m) => sent.push(JSON.parse(m)), terminated: false };
      ws.terminate = () => { ws.terminated = true; ws.readyState = 3; };
      const ctx = { ws, alt: null, authed: true, deviceId: 'd1', name: 'Phone', address: '10.0.0.2', transport: 'ip', lastRx: clock, lastTx: 0, connectedAt: clock };
      ws.ctx = ctx;
      ws.sent = sent;
      s.sockets.add(ctx);
      return { ctx, ws, sent };
    };
    // alive: the peer is still answering, so silence does not accumulate. The timeout cases pass false.
    const step = (s, n, alive = true) => {
      for (let i = 0; i < n; i++) {
        clock += P.PING_MS;
        if (alive) for (const ctx of s.sockets) { ctx.lastRx = clock; if (ctx.ws) ctx.ws.lastRx = clock; }
        s.liveness(clock);
      }
    };
    const meshPings = (c) => c.sent.filter((m) => m.t === 'ping').length;

    {
      const s = mesh();
      const c = phone(s);
      s.busyFlags.set('d1', true);
      Q.setKeep(true);
      s._onMessage(c.ctx, Buffer.from(JSON.stringify({ t: 'idle', on: true, perf: 1, keep: 1 })), false, c.ws);
      step(s, 16 + 5);
      const got = meshPings(c);
      assert.ok(got >= 20, `mesh busy: pinged every second (${got})`);
      c.ctx.lastRx = c.ws.lastRx = clock;
      step(s, 8, false);
      assert.equal(c.ws.terminated, false, 'mesh busy: 8 s is not over');
      step(s, 1, false);
      assert.equal(c.ws.terminated, true, 'mesh busy: the 8 s limit is unchanged');
    }
    Q._reset();
    {
      const s = mesh();
      const c = phone(s);
      s.busyFlags.set('d1', false);
      Q.setKeep(true);
      s._onMessage(c.ctx, Buffer.from(JSON.stringify({ t: 'idle', on: true })), false, c.ws);
      step(s, 16);
      const before = meshPings(c);
      step(s, 9);
      const got = meshPings(c) - before;
      assert.ok(got <= 2, `mesh idle without perf: still the 5 s cadence (${got})`);
      assert.ok(got >= 1, `mesh idle without perf: still pings (${got})`);
    }
    Q._reset();
    {
      const s = mesh();
      const c = phone(s);
      s.busyFlags.set('d1', false);
      Q.setKeep(true);
      s._onMessage(c.ctx, Buffer.from(JSON.stringify({ t: 'idle', on: true, perf: 1, keep: 1 })), false, c.ws);
      step(s, 16);
      const before = meshPings(c);
      step(s, 9);
      assert.equal(meshPings(c) - before, 3, 'mesh idle with perf: the 3 s tier, not the 5 s cadence');
      c.ctx.lastRx = c.ws.lastRx = clock;
      step(s, 10, false);
      assert.equal(c.ws.terminated, false, 'mesh idle with perf: 10 s is inside the limit');
      step(s, 1, false);
      assert.equal(c.ws.terminated, true, 'mesh idle with perf: closed after 10 s');
    }
  }
  console.log('quiet-servers: ok');
} finally {
  Date.now = realNow;
  Q._reset();
}
