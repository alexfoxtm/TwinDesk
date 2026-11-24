// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Three Macs-and-PCs on real loopback sockets, paired through the real pairing protocol (mac side).
'use strict';

const assert = require('assert');
const P = require('../../../shared/protocol.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');
const { node, close, waitFor, pair, linked, socketCount, hello, pairPhone, helloPhone, rawConnect } = require('./lib/mesh.js');

// A full triangle: A dials B and C, B dials C.
async function triangle() {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  await pair(A, B);
  await pair(A, C);
  await pair(B, C);
  const all = [[A, B], [A, C], [B, C]];
  await waitFor(() => all.every(([x, y]) => linked(x, y)), 'all three links up');
  return { A, B, C, all };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('three devices: every link is up at the same time and stays up', async () => {
  const { A, B, C, all } = await triangle();
  try {
    assert.ok(all.every(([x, y]) => socketCount(x, y) === 1), 'one socket per pair');
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(all.every(([x, y]) => linked(x, y)), 'still linked after 2.5 s');
    assert.ok(all.every(([x, y]) => socketCount(x, y) === 1), 'still one socket per pair');
    const drops = [A, B, C].reduce((n, x) => n + x.events.length, 0);
    assert.strictEqual(drops, 0, 'no link or client closed');
  } finally {
    close(A, B, C);
  }
});

test('a message from A reaches exactly A\'s session on B, not C\'s', async () => {
  const { A, B, C } = await triangle();
  try {
    const got = { B_fromA: [], B_fromC: [], C_fromA: [], C_fromB: [], A_fromB: [] };
    B.hub.sessions.ensure(A.id).on('test.msg', (m) => got.B_fromA.push(m.n));
    B.hub.sessions.ensure(C.id).on('test.msg', (m) => got.B_fromC.push(m.n));
    C.hub.sessions.ensure(A.id).on('test.msg', (m) => got.C_fromA.push(m.n));
    C.hub.sessions.ensure(B.id).on('test.msg', (m) => got.C_fromB.push(m.n));
    A.hub.sessions.ensure(B.id).on('test.msg', (m) => got.A_fromB.push(m.n));

    assert.ok(A.hub.sessions.get(B.id).send({ t: 'test.msg', n: 1 }), 'A sends to B');
    await waitFor(() => got.B_fromA.length === 1, 'the message on B');
    assert.deepStrictEqual(got.B_fromA, [1]);
    assert.deepStrictEqual(got.B_fromC, [], 'C is not involved');
    assert.deepStrictEqual(got.C_fromA, [], 'nothing from A reached C');

    B.hub.sessions.get(A.id).send({ t: 'test.msg', n: 2 }); // and back: B's session for A
    await waitFor(() => got.A_fromB.length === 1, 'the answer on A');
    assert.deepStrictEqual(got.C_fromB, [], 'nothing from B reached C');
    assert.deepStrictEqual(got.B_fromC, []);
  } finally {
    close(A, B, C);
  }
});

test('a phone and two computers: the phone stays connected, nobody is refused busy', async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => linked(A, B) && linked(A, C), 'two computers linked to A');
    // A phone pairs as the Android app does: pair.start with os android, then hello on the same socket.
    const phoneId = P.randomHex(16);
    const { client, reply } = await hello(A.port, { id: phoneId, name: 'Phone', os: P.OS.ANDROID, token: 'x' });
    assert.strictEqual(reply.t, P.T.ERROR, 'an unknown phone is refused (not paired): no busy refusal path');
    assert.notStrictEqual(reply.code, P.E.BUSY, 'never busy');
    client.close();
    assert.strictEqual(A.server.phoneHolds(), false, 'phones hold nothing');
    assert.strictEqual(A.server.clients.size, 2, 'two computers are still connected');
  } finally {
    close(A, B, C);
  }
});

test('the selected device follows the Use button; the facade gets closed then client', async () => {
  const { A, B, C } = await triangle();
  try {
    const seen = [];
    A.hub.facade.on('client', (v) => seen.push(['client', v.deviceId]));
    A.hub.facade.on('closed', () => seen.push(['closed']));
    A.hub.select(B.id);
    assert.strictEqual(A.hub.selectedId, B.id, 'B is selected');
    A.hub.select(C.id);
    assert.strictEqual(A.hub.selectedId, C.id, 'C is selected');
    assert.deepStrictEqual(seen.slice(-2), [['closed'], ['client', C.id]], 'closed, then client for C');
    assert.ok(!A.hub.select('not-a-device'), 'an unknown device cannot be selected');
  } finally {
    close(A, B, C);
  }
});

// #313: Mac three-peer deferred audio/screen state replay, excluded payloads, old-route teardown,
// delivery stamps, and active-audio stickiness.
test('three devices: deferred audio/screen state replays on selection with delivery stamps; excluded payloads stay dropped; B gets policy teardown', async () => {
  const { A, B, C } = await triangle();
  try {
    const facadeGot = [];
    const audioGot = [];
    const audioRoute = A.hub.audioRoute();
    A.hub.facade.on('client', (v) => facadeGot.push(['client', v.deviceId]));
    A.hub.facade.on(`t:${P.T.SCREEN_STATE}`, (m, v) => facadeGot.push(['screen.state', m.on, m.ask, v.conn, v.source()]));
    A.hub.facade.on(`t:${P.T.SCREEN_POLICY}`, (m, v) => facadeGot.push(['screen.policy', m.accept, v.conn]));
    A.hub.facade.on(`t:${P.T.HUB_STATE}`, (m) => facadeGot.push(['hub.state', m]));
    A.hub.facade.on(`t:${P.T.CALL_STATE}`, (m) => facadeGot.push(['call.state', m]));
    audioRoute.on('client', (v) => audioGot.push(['client', v.deviceId]));
    audioRoute.on(`t:${P.T.AUDIO_POLICY}`, (m, v) => audioGot.push(['audio.policy', m.accept, v.conn, v.source()]));

    const atB = { audio: [], screen: [] };
    B.hub.bus.on(P.T.AUDIO_POLICY, (m, from) => from === A.id && atB.audio.push(m.accept));
    B.hub.bus.on(P.T.SCREEN_POLICY, (m, from) => from === A.id && atB.screen.push(m.accept));

    assert.strictEqual(A.hub.select(B.id), true);
    assert.strictEqual(audioRoute.targetId, B.id);

    // A tells B both audio.policy and screen.policy are active.
    assert.strictEqual(audioRoute.send({ t: P.T.AUDIO_POLICY, accept: true }), true);
    assert.strictEqual(A.hub.facade.send({ t: P.T.SCREEN_POLICY, accept: true, width: 1440, height: 900 }), true);
    await waitFor(() => atB.audio.length === 1 && atB.screen.length === 1, 'B received A policies');

    // While B is selected, C advertises audio/screen state + excluded capability payloads.
    C.hub.bus.send(A.id, { t: P.T.AUDIO_POLICY, accept: true, ask: true });
    C.hub.bus.send(A.id, { t: P.T.SCREEN_STATE, on: false, mode: '' });
    C.hub.bus.send(A.id, { t: P.T.SCREEN_STATE, on: true, mode: 'extend', remote: true, ask: true });
    C.hub.bus.send(A.id, { t: P.T.SCREEN_POLICY, accept: true, width: 1920, height: 1080 });
    C.hub.bus.send(A.id, { t: P.T.HUB_STATE, media: true, files: true });
    C.hub.bus.send(A.id, { t: P.T.CALL_STATE, state: 'ringing' });
    const sC = A.hub.sessions.get(C.id);
    await waitFor(() => A.hub.heard.replay(sC).length === 3, 'A remembered C audio/screen state');
    const cWs = sC.outbound();
    assert.ok(cWs, 'C has live outbound socket');

    facadeGot.length = 0;
    audioGot.length = 0;
    assert.strictEqual(A.hub.select(C.id), true);

    assert.deepStrictEqual(facadeGot, [
      ['client', C.id],
      ['screen.state', true, undefined, cWs, cWs],
      ['screen.policy', true, cWs],
    ], 'facade replays only screen.state (no ask) and screen.policy with C delivery stamps; hub.state & call.state excluded');
    assert.deepStrictEqual(audioGot, [
      ['client', C.id],
      ['audio.policy', true, cWs, cWs],
    ], 'audioRoute replays C audio.policy with verified delivery stamp');
    await waitFor(() => atB.audio.length === 2 && atB.screen.length === 2, 'B receives policy teardown');
    assert.deepStrictEqual(atB.audio, [true, false]);
    assert.deepStrictEqual(atB.screen, [true, false]);

    // Active-audio stickiness on C: selecting B keeps audioRoute on C without tearing down C.
    const atC = [];
    C.hub.bus.on(P.T.AUDIO_POLICY, (m, from) => from === A.id && atC.push(m.accept));
    assert.strictEqual(audioRoute.send({ t: P.T.AUDIO_POLICY, accept: true }), true);
    await waitFor(() => atC.length === 1, 'C received A audio.policy');
    A.hub.setAudioSticky('sound', C.id);
    A.hub.select(B.id);
    assert.strictEqual(audioRoute.targetId, C.id, 'sticky audio route stays on C');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(atC, [true], 'C does not receive teardown while sticky');
    A.hub.setAudioSticky('sound', null);
    assert.strictEqual(audioRoute.targetId, B.id, 'route moves to B once stickiness clears');
    await waitFor(() => atC.length === 2, 'C receives teardown after leaving');
    assert.deepStrictEqual(atC, [true, false]);
  } finally {
    close(A, B, C);
  }
});

// #313 failure scenario: IP-to-IP resume and fallback socket (ctx.alt) + same-device-ID replacement
// must NOT confer previously advertised audio/screen permission onto the new active connection.
test('Mac hub: IP-to-IP resume, fallback socket, and same-device-ID replacement reject stale media state', async () => {
  const A = await node('A');
  const B = await node('B');
  let c1 = null;
  let c2 = null;
  let c3 = null;
  try {
    await pair(B, A);
    await waitFor(() => linked(A, B), 'B linked to A');
    A.hub.select(B.id);
    const audioRoute = A.hub.audioRoute();

    // Pair peer C as a raw client so we can drive real IP-to-IP resume + replacement.
    const p = await pairPhone(A, { name: 'PeerC' });
    c1 = p.client;
    const welcome = await helloPhone(c1, { id: p.id, name: 'PeerC', token: p.token });
    assert.ok(welcome.resume, 'host issued resume key');
    await waitFor(() => A.hub.sessions.get(p.id)?.connected, 'C connected on socket 1');

    // While B is selected, C advertises audio.policy + screen.state on socket 1.
    c1.send({ t: P.T.AUDIO_POLICY, accept: true });
    c1.send({ t: P.T.SCREEN_STATE, on: true, mode: 'extend' });
    const sC = A.hub.sessions.get(p.id);
    await waitFor(() => A.hub.heard.replay(sC).length === 2, 'A remembered socket 1 state');

    // Real IP-to-IP resume: C opens socket 2 with the resume key (socket 1 becomes fallback ctx.alt).
    c2 = await rawConnect(A.port);
    c2.send({ t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: p.id, name: 'PeerC', os: P.OS.ANDROID, resume: welcome.resume });
    const resumed = await c2.until((m) => m.t === P.T.WELCOME && m.resumed === true);
    assert.strictEqual(resumed.resumed, true);
    await waitFor(() => sC.ctx && sC.ctx.alt && sC.ctx.ws !== sC.ctx.alt, 'server moved to socket 2 with socket 1 as fallback');

    // Socket 1 (now fallback ctx.alt) sends another audio.policy; must be ignored by Heard.
    c1.send({ t: P.T.AUDIO_POLICY, accept: true });
    await new Promise((r) => setTimeout(r, 80));

    const facadeGot = [];
    const audioGot = [];
    A.hub.facade.on('client', (v) => facadeGot.push(['client', v.deviceId]));
    A.hub.facade.on(`t:${P.T.SCREEN_STATE}`, (m) => facadeGot.push(['screen.state', m.on]));
    audioRoute.on('client', (v) => audioGot.push(['client', v.deviceId]));
    audioRoute.on(`t:${P.T.AUDIO_POLICY}`, (m) => audioGot.push(['audio.policy', m.accept]));

    A.hub.select(p.id);
    assert.deepStrictEqual(facadeGot, [['client', p.id]], 'pre-resume screen.state does not replay onto resumed socket 2');
    assert.deepStrictEqual(audioGot, [['client', p.id]], 'pre-resume and fallback audio.policy do not confer permission on socket 2');

    // Now socket 2 advertises fresh state while A switches back to B, then socket 3 replaces C with same device ID.
    A.hub.select(B.id);
    c2.send({ t: P.T.AUDIO_POLICY, accept: true });
    await waitFor(() => A.hub.heard.replay(sC).length === 1, 'A remembered socket 2 state');
    const rep = await hello(A.port, { id: p.id, name: 'PeerC', os: P.OS.ANDROID, token: p.token });
    c3 = rep.client;
    assert.strictEqual(rep.reply.t, P.T.WELCOME);
    await waitFor(() => A.hub.heard.replay(sC).length === 0, 'replacement clears socket 2 state');

    audioGot.length = 0;
    A.hub.select(p.id);
    assert.deepStrictEqual(audioGot, [['client', p.id]], 'replaced connection does not inherit old socket audio.policy');
  } finally {
    if (c1) c1.close();
    if (c2) c2.close();
    if (c3) c3.close();
    close(A, B);
  }
});

runTests(tests);
