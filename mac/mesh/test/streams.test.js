// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Share screen to several devices on the Mac: a Stream per connected device on a peer bound to it,
// a choice of its own per device, the active one answers for the single-stream API.
// Run with: node mac/mesh/test/streams.test.js  (NODE_PATH as in CI)
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../../../shared/protocol.js');
const { StreamSet } = require('../streams.js');
const { node, close, waitFor, pairPhone, helloPhone, hello } = require('./lib/mesh.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MODEL = [
  { id: '1', name: 'Built-in', x: 0, y: 0, w: 3024, h: 1964, scale: 2, primary: true },
  { id: '2', name: 'Left', x: -1920, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
  { id: '9', name: 'TwinDesk', x: 3024, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
];

function fakeStream(log) {
  return (peer) => {
    const st = new EventEmitter();
    Object.assign(st, { choice: null, view: { status: 'off' }, audio: { on: false }, got: [] });
    st.restart = (r) => log.push([peer.id, r]);
    st.stop = () => {};
    peer.on(`t:${T.SCREEN_POLICY}`, (m) => st.got.push(m));
    return st;
  };
}

test('a stream per device, choices of their own, the single-stream API follows the selection', async () => {
  const A = await node('A');
  const clients = [];
  try {
    const log = [];
    const set = new StreamSet({ hub: A.hub, server: A.server, displays: { model: () => MODEL }, make: fakeStream(log) });
    assert.strictEqual(set.all.length, 1);
    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await waitFor(() => set.byId.has(p1.id), 'device one has a stream');
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p2.id), 'device two has a stream');
    assert.strictEqual(set.all.length, 2);
    assert.strictEqual(set.first, set.byId.get(p1.id));

    p2.client.send({ t: T.SCREEN_POLICY, accept: true });
    await waitFor(() => set.byId.get(p2.id).got.length === 1, 'stream two heard its device');
    assert.strictEqual(set.byId.get(p1.id).got.length, 0, 'stream one did not');

    assert.strictEqual(set.view.displays.length, 3);
    assert.strictEqual(set.setTarget(p1.id, { mode: 'mirror', displayId: '2' }).ok, true);
    assert.deepStrictEqual(set.byId.get(p1.id).choice, { mode: 'mirror', displayId: 2 });
    assert.strictEqual(set.setTarget(p2.id, { mode: 'virtual' }).ok, true);
    assert.strictEqual(set.setTarget(p1.id, { mode: 'virtual' }).ok, false, 'one virtual display');
    assert.strictEqual(set.setTarget(p1.id, { mode: 'mirror', displayId: '77' }).ok, false, 'unknown display');
    assert.strictEqual(set.setTarget(p1.id, { mode: 'none' }).ok, true);
    assert.strictEqual(set.setTarget(p1.id, { mode: 'default' }).ok, true);
    assert.strictEqual(set.byId.get(p1.id).choice, null);
    assert.ok(log.some(([id, r]) => id === p2.id && r === 'target choice'), 'a choice restarts that stream');

    A.hub.select(p2.id);
    assert.strictEqual(set.active, set.byId.get(p2.id));
    assert.strictEqual(set.view.deviceId, p2.id);
    assert.strictEqual(set.view.targets.length, 2);

    p2.client.close();
    await waitFor(() => !A.hub.sessions.get(p2.id).connected, 'device two gone');
    assert.ok(!set.table[p2.id]);
  } finally {
    for (const c of clients) { try { c.close(); } catch (_) { /* already */ } }
    close(A);
  }
});

function receiveFixture(A) {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return {
      ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
      session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    };
    if (request === '../audiohub.js') return {};
    return load.call(this, request, parent, isMain);
  };
  let Stream;
  try { ({ Stream } = require('../stream.js')); }
  finally { Module._load = load; }
  const settings = { sharing: { on: false, remote: true } };
  const target = { id: 1, label: 'Built-in', primary: true, pixelWidth: 3024, pixelHeight: 1964 };
  const displays = Object.assign(new EventEmitter(), {
    model: () => MODEL, target: () => target, list: () => [target], setOverride() {},
  });
  const started = [];
  const set = new StreamSet({
    hub: A.hub, server: A.server, displays,
    make: (peer) => {
      const stream = new Stream(peer, displays, () => settings, { release() {}, loopback() {} });
      stream._ensureWindow = async () => {};
      stream._source = async () => ({ id: 'screen:1:0' });
      stream._toWindow = (ch, m) => { if (ch === 'start') started.push([peer.id, m.session]); };
      return stream;
    },
  });
  return { set, settings, started };
}

async function ipadFixture(A) {
  const other = await pairPhone(A, { name: 'Android' });
  await helloPhone(other.client, other);
  const ipad = await pairPhone(A, { name: 'iPad', os: P.OS.IOS });
  ipad.client.close();
  const connect = async () => {
    const result = await hello(A.port, { ...ipad, name: 'iPad', os: P.OS.IOS });
    assert.strictEqual(result.reply.t, T.WELCOME);
    return result.client;
  };
  return { other, ipad, connect };
}

const accept = (client) => client.send({ t: T.SCREEN_POLICY, accept: true, width: 2732, height: 2048 });
const start = (client) => client.send({ t: T.SCREEN_CTL, share: true, mode: 'mirror' });

test('a non-selected iPad can receive its own screen again after reconnect', async () => {
  const A = await node('A');
  try {
    const { set, settings, started } = receiveFixture(A);
    const { other, ipad, connect } = await ipadFixture(A);

    const first = await connect();
    const st = set.byId.get(ipad.id);
    assert.strictEqual(A.hub.selectedId, other.id);
    accept(first);
    await waitFor(() => st.viewer === true, 'iPad policy reached its own Stream');
    assert.strictEqual(started.length, 0, 'policy alone cannot start sharing that is off');
    start(first);
    await waitFor(() => started.length === 1, 'the unselected iPad’s own capture', 800);
    assert.deepStrictEqual(started.map(([id]) => id), [ipad.id]);
    await first.until((m) => m.t === T.SCREEN_STATE && m.on);
    const retiredSocket = st.peer.current.conn;

    assert.strictEqual(A.hub.select(ipad.id), true);
    first.close();
    await waitFor(() => !st.active && !st.peer.current, 'iPad sender retired');
    assert.strictEqual(A.hub.selectedId, other.id);
    const next = await connect();
    assert.strictEqual(set.byId.get(ipad.id), st);
    assert.strictEqual(st.viewer, null, 'the scoped client event reset viewer policy');
    assert.strictEqual(started.length, 1);
    await next.until((m) => m.t === T.SCREEN_STATE && !m.on && m.remote);
    st.peer.route.deliver({ t: T.SCREEN_POLICY, accept: true }, retiredSocket);
    assert.strictEqual(st.viewer, null, 'retired socket cannot accept for the replacement');
    accept(next);
    start(next);
    await waitFor(() => started.length === 2, 'fresh policy and Start restarted the iPad’s sender');
    assert.ok(started[1][1] > started[0][1]);
    assert.strictEqual(next.count(T.STREAM_INFO), 1);
    st.peer.route.deliver({ t: T.SCREEN_CTL, share: false, close: true }, retiredSocket);
    assert.ok(st.active, 'retired socket cannot stop the replacement');
    next.send({ t: T.SCREEN_CTL, share: false, close: true });
    await waitFor(() => !st.active, 'iPad Stop retired its own sender');
    const acceptedAgain = new Promise((resolve) => st.peer.once(`t:${T.SCREEN_POLICY}`, resolve));
    accept(next);
    await acceptedAgain;
    await next.until((m) => m.t === T.STREAM_STOP);
    assert.strictEqual(started.length, 2, 'repeated acceptance does not undo Stop');
    assert.strictEqual(settings.sharing.on, false);
    assert.strictEqual(A.hub.selectedId, other.id);
    assert.strictEqual(other.client.count(T.STREAM_INFO), 0);

    // Stopping the iPad's separate share must not veto a later Mac Share Screen action.
    settings.sharing.on = true;
    await set.restart('sharing on');
    assert.ok(st.active, 'the Mac can start global sharing after the iPad stops a scoped share');

    // A Stop during an active global share applies until that share ends.
    const stopped = next.until((m) => m.t === T.STREAM_STOP);
    next.send({ t: T.SCREEN_CTL, share: false });
    await stopped;
    await waitFor(() => !st.active, 'iPad can stop receiving the current global share');
    await set.restart('bitrate changed');
    assert.strictEqual(st.active, null, 'a restart of the same global share must respect the iPad Stop');
    settings.sharing.on = false;
    set.stop('off');
    settings.sharing.on = true;
    await set.restart('sharing on');
    assert.ok(st.active, 'the next Mac share is independent of the previous stop');
  } finally {
    close(A);
  }
});

test('remote revocation and a Mac target set to off deny the iPad’s scoped requests', async () => {
  const A = await node('A');
  try {
    const { set, settings, started } = receiveFixture(A);
    const { ipad, connect } = await ipadFixture(A);
    const client = await connect();
    const st = set.byId.get(ipad.id);
    const request = async () => {
      const delivered = new Promise((resolve) => st.peer.once(`t:${T.SCREEN_CTL}`, resolve));
      start(client);
      await delivered;
    };
    await request();
    assert.strictEqual(st.active, null, 'Start requires live viewer acceptance');
    accept(client);
    await request();
    await waitFor(() => started.length === 1, 'iPad capture before revoke');

    settings.sharing.remote = false;
    set.syncScopedScreens();
    assert.strictEqual(st.active, null, 'remote-start revocation retires the sender');
    await client.until((m) => m.t === T.STREAM_STOP);
    await request();
    assert.strictEqual(st.active, null, 'remote-start revocation stops and denies the request');

    settings.sharing.remote = true;
    assert.strictEqual(set.setTarget(ipad.id, { mode: 'none' }).ok, true);
    await request();
    assert.strictEqual(st.active, null, 'Mac’s per-device Off overrides remote start');
    assert.strictEqual(started.length, 1);
  } finally {
    close(A);
  }
});

require('../../../windows/mesh/test/lib/run.js').runTests(tests);
