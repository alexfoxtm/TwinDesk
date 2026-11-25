// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/peerstate.js + shared/hub-route.js:
// - Strictly remembers only audio.policy, screen.state, screen.policy bound to the active primary socket
// - Excludes hub.state (Save As requires true ingress), call.state, clipboard, and other capabilities
// - Preserves Route delivery stamps (v.conn / v.source()) on replay and strips `ask`
// - Rejects stale, fallback (alt), closed, released, detached, injected, and replaced/resumed sockets
// - Tears down active outbound audio.policy / screen.policy only when leaving a still-connected peer
// Run: node shared/test/peerstate.test.js
'use strict';

const assert = require('assert');
const { Heard, Said, REMEMBER, GOODBYE } = require('../peerstate.js');
const { Route } = require('../hub-route.js');

const sock = (name) => ({ name, readyState: 1 });

function fakeSession(id, { ws = sock(`${id}-ws`), host = true } = {}) {
  const sent = [];
  const s = {
    id,
    connected: true,
    hostUp: host,
    linkUp: !host,
    role: host ? 'guest' : 'host',
    transport: 'ip',
    peerOs: 'win',
    status: { rtt: 1 },
    lastRx: 1,
    ctx: host ? { authed: true, released: false, deviceId: id, name: id, os: 'win', address: '127.0.0.1', ws, alt: null } : null,
    link: !host ? { authed: true, ws, alt: null, pairing: { address: '127.0.0.1' } } : null,
    displayName: () => id,
    sent,
    send(m) {
      if (!this.connected) return false;
      sent.push(m);
      return true;
    },
  };
  return s;
}

function fakeHub(ids) {
  const sessions = new Map();
  for (const id of ids) sessions.set(id, fakeSession(id));
  return { sessions, selectedId: null, heard: new Heard() };
}

// 1. Scope: chat.want may be revoked on leave and is never replayed.
{
  assert.deepStrictEqual([...REMEMBER].sort(), ['audio.policy', 'screen.policy', 'screen.state']);
  assert.deepStrictEqual(Object.keys(GOODBYE).sort(), ['audio.policy', 'chat.want', 'screen.policy']);
}

// 2. Heard: remembers latest of allowed types on live primary socket, strips ask, ignores excluded payloads.
{
  const h = new Heard();
  const s = fakeSession('B');
  const ws = s.ctx.ws;
  assert.strictEqual(h.note(s, { t: 'audio.policy', accept: false }, ws), true);
  assert.strictEqual(h.note(s, { t: 'audio.policy', accept: true, ask: true, meshLeave: true }, ws), true);
  assert.strictEqual(h.note(s, { t: 'screen.state', on: true, mode: 'extend', ask: true }, ws), true);
  assert.strictEqual(h.note(s, { t: 'screen.policy', accept: true, width: 1920, height: 1080 }, ws), true);

  for (const excluded of [
    { t: 'hub.state', media: true, files: true },
    { t: 'call.state', state: 'ringing' },
    { t: 'clip', text: 'secret' },
    { t: 'mic.policy', accept: true },
    { t: 'cam.policy', share: true },
    { t: 'papp.policy', accept: true },
    { t: 'wol.info', macs: ['aa:bb:cc:dd:ee:ff'] },
    { t: 'ssh.key', pub: 'ssh-ed25519 AAAA' },
    { t: 'dev.state', battery: 90 },
  ]) {
    assert.strictEqual(h.note(s, excluded, ws), false, `excluded type ${excluded.t} must not be remembered`);
  }

  const entries = h.replayEntries(s);
  assert.deepStrictEqual(entries.map((e) => e.msg), [
    { t: 'audio.policy', accept: true, meshLeave: true },
    { t: 'screen.state', on: true, mode: 'extend' },
    { t: 'screen.policy', accept: true, width: 1920, height: 1080 },
  ], 'latest of each remembered type, ask stripped');
  assert.ok(entries.every((e) => e.ws === ws), 'every entry preserves the verified socket');
  assert.strictEqual(h.by.get('B').msgs.get('audio.policy').ask, true, 'stored object is not mutated');

  // Fork envelope { arrived, conn, ws }: accepted only for live primary socket, rejected for alt/released/unarrived.
  const sFork = fakeSession('F');
  const fWs = sFork.ctx.ws;
  const fAlt = sock('F-alt');
  sFork.ctx.alt = fAlt;
  assert.strictEqual(h.note(sFork, { t: 'audio.policy', accept: true }, { arrived: true, conn: sFork.ctx, ws: fAlt }), false, 'fallback alt in fork envelope rejected');
  assert.strictEqual(h.note(sFork, { t: 'audio.policy', accept: true }, { arrived: false, conn: sFork.ctx, ws: fWs }), false, 'unarrived envelope rejected');
  assert.strictEqual(h.note(sFork, { t: 'audio.policy', accept: true }, undefined), false, 'inject / missing socket rejected');
  assert.strictEqual(h.note(sFork, { t: 'audio.policy', accept: true }, { arrived: true, conn: sFork.ctx, ws: fWs }), true, 'live primary fork envelope accepted');
  sFork.ctx.released = true;
  assert.deepStrictEqual(h.replay(sFork), [], 'released ctx evicts remembered state');
}

// 3. Stale, fallback, detached, replaced, and IP-to-IP resumed sockets cannot confer permission.
{
  const h = new Heard();
  const s = fakeSession('C');
  const ws1 = s.ctx.ws;
  assert.strictEqual(h.note(s, { t: 'audio.policy', accept: true, meshLeave: true }, ws1), true);
  assert.strictEqual(h.replay(s).length, 1);

  // IP-to-IP resume: ws2 becomes primary, ws1 becomes fallback (alt).
  const ws2 = sock('C-ws2');
  s.ctx.alt = ws1;
  s.ctx.ws = ws2;
  assert.strictEqual(h.note(s, { t: 'screen.state', on: true }, ws1), false, 'fallback socket cannot record state');
  assert.deepStrictEqual(h.replay(s), [], 'pre-resume ws1 state must not replay onto ws2');

  // Even if ws2 later closes and falls back to ws1, pre-resume state stays evicted.
  s.ctx.alt = null;
  s.ctx.ws = ws1;
  assert.deepStrictEqual(h.replay(s), [], 'evicted state does not resurrect on fallback promotion');

  // Guest link: replacing link.ws on the same Link evicts old socket state.
  const g = fakeSession('G', { host: false });
  const g1 = g.link.ws;
  assert.strictEqual(h.note(g, { t: 'screen.policy', accept: true }, g1), true);
  const g2 = sock('G-ws2');
  g.link.ws = g2;
  assert.strictEqual(h.note(g, { t: 'audio.policy', accept: true }, g1), false, 'stale guest socket cannot record');
  assert.deepStrictEqual(h.replay(g), [], 'replaced guest socket gets no replay from old socket');

  // Detached or closing socket cannot record or replay.
  assert.strictEqual(h.note(g, { t: 'audio.policy', accept: true, meshLeave: true }, g2), true);
  g2.detached = true;
  assert.deepStrictEqual(h.replay(g), [], 'detached socket rejected');
}

// 4. Said: tracks active policies, emits once, ignores excluded policies.
{
  const s = new Said();
  s.note('B', { t: 'audio.policy', accept: true });
  s.note('B', { t: 'screen.policy', accept: true });
  s.note('B', { t: 'cam.policy', share: true });
  s.note('B', { t: 'mic.policy', accept: true });
  s.note('B', { t: 'screen.policy', accept: false });
  assert.deepStrictEqual(s.goodbyes('C'), [], 'nothing for another peer');
  assert.deepStrictEqual(s.goodbyes('B'), [{ t: 'audio.policy', accept: false }]);
  assert.deepStrictEqual(s.goodbyes('B'), [], 'emitted once');
  s.note('B', { t: 'screen.policy', accept: true });
  s.forget('B');
  assert.deepStrictEqual(s.goodbyes('B'), [], 'forgotten');
}

// 5. Route: replays after client with verified delivery stamps, tears down old peer on switch,
// does not tear down on drop(id) replacement, and handles re-entrant refresh from 'closed'.
{
  const hub = fakeHub(['B', 'C']);
  const sB = hub.sessions.get('B');
  const sC = hub.sessions.get('C');
  const route = new Route(hub, (h) => h.selectedId);
  const got = [];
  route.on('client', (v) => got.push(['client', v.deviceId, v.conn]));
  route.on('closed', () => {
    got.push(['closed']);
    // Simulate Sound/Audio calling setAudioSticky(null) -> route.refresh() during 'closed'.
    route.refresh();
  });
  route.on('t:audio.policy', (m, v) => got.push(['audio.policy', m.accept, v.conn, v.source()]));

  hub.selectedId = 'B';
  route.refresh();
  assert.deepStrictEqual(got, [['client', 'B', sB.ctx.ws]]);

  hub.heard.note(sC, { t: 'audio.policy', accept: true, ask: true, meshLeave: true }, sC.ctx.ws);
  hub.heard.note(sC, { t: 'screen.state', on: true }, sC.ctx.ws); // route has no listener for screen.state
  assert.strictEqual(route.send({ t: 'audio.policy', accept: true }), true);
  assert.strictEqual(route.send({ t: 'chat.want', on: true, messaging: true }), true);

  got.length = 0;
  hub.selectedId = 'C';
  route.refresh();
  assert.deepStrictEqual(got, [
    ['closed'],
    ['client', 'C', sC.ctx.ws],
    ['audio.policy', true, sC.ctx.ws, sC.ctx.ws],
  ], 'closed, single client, then replayed audio.policy with verified delivery stamp (no re-entrant duplicate)');
  assert.deepStrictEqual(sB.sent, [
    { t: 'audio.policy', accept: true, meshLeave: true },
    { t: 'chat.want', on: true, messaging: true },
    { t: 'audio.policy', accept: false },
    { t: 'chat.want', on: false },
  ], 'B receives audio and chat teardown');

  // Replacement drop(id): even if sC.connected is momentarily true during setCtx, no goodbye goes out.
  route.send({ t: 'audio.policy', accept: true });
  sC.sent.length = 0;
  route.drop('C');
  assert.deepStrictEqual(sC.sent, [], 'drop(id) for disconnect/replacement does not send goodbye');
  // And no stale goodbye leaks later.
  hub.selectedId = 'C';
  route.refresh();
  hub.selectedId = 'B';
  route.refresh();
  assert.deepStrictEqual(sC.sent, [], 'no stale goodbye sent to C');
}

console.log('peerstate: all passed');
