// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sound that plays with one device while another is selected (#245): three real hubs on real sockets (A, B,
// C linked to each other), the real PairSync on A's facade (as mesh/main.js wires it, set() re-applying the
// sound as ipc.js does) and the real sound engines, windows/sound.js and linux/sound.js, with `electron`
// (and Linux's loopback) stubbed. A sends its sound to B; selecting C, whose pair has the sound off, must
// not stop it; turning B's own switch off still does.
// Run: node shared/test/mesh-sound-selection.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');
const { Hub } = require('../../linux/mesh/hub.js');
const { LinkManager } = require('../../linux/mesh/links.js');
const { Server } = require('../../linux/mesh/server.js');
const { Pairing } = require('../../linux/mesh/hostpair.js');
const { normalize } = require('../../linux/mesh/settings.js');
const { PairSync } = require('../../linux/pairsync.js');
const { waitFor, pair, memoryStorage, close } = require('../../linux/mesh/test/lib/mesh.js');
const { loadTestCert } = require('../../linux/mesh/test/lib/testcert.js');

const T = P.T;

// The Electron the sound engines use: a hidden window that only queues, and ipcMain.
class FakeWindow {
  constructor() {
    this.webContents = { send() {} };
  }

  loadFile() {}

  isDestroyed() { return false; }

  on() {}

  once() {}

  destroy() {}
}
const electron = {
  BrowserWindow: FakeWindow,
  ipcMain: new EventEmitter(),
  session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
  desktopCapturer: { getSources: async () => [] },
};
const loopback = { acquire: async () => 'twindesk-test', release() {} };
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return electron;
  if (id === './loopback') return loopback;
  return load.call(this, id, ...args);
};
const SOUNDS = { windows: require('../../windows/sound.js'), linux: require('../../linux/sound.js') };
Module._load = load;

async function node(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  hub.start();
  return { name, id, port: server.port, server, links, pairing, hub, stops: [] };
}

const linked = (a, b) => {
  const sa = a.hub.sessions.get(b.id);
  const sb = b.hub.sessions.get(a.id);
  return !!(sa && sa.connected && sb && sb.connected);
};

async function run(platform) {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  const N = { A, B, C };
  const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
  try {
    // A's sound and its two-way switches, there before any device connects (as in mesh/main.js).
    A.settings = normalize({ audio: { send: true, receive: false } });
    A.settings.pairSync = { [C.id]: { audio: { out: false, in: false }, values: {} } }; // C's pair: no sound
    A.sound = new SOUNDS[platform]({ link: A.hub.audioLink(), settings: A.settings, onChange() {}, meshHub: A.hub });
    A.pairSync = new PairSync({
      link: A.hub.facade, settings: A.settings, save() {},
      set: (section, partial) => { Object.assign(A.settings[section], partial); if (section === 'audio') A.sound.apply(); },
      only: ['clipboard', 'notifs', 'apps', 'audio', 'cursor', 'terminal', 'files'], bus: A.hub.bus,
      peerRole: (id) => { const s = A.hub.sessions.get(id); return s ? s.role : null; },
      peerOs: (id) => { const s = A.hub.sessions.get(id); return s ? s.peerOs : null; },
    });
    B.hub.bus.on(T.AUDIO_STOP, (m, from) => B.stops.push({ m, from }));

    for (const [x, y] of TRIANGLE) await pair(N[x], N[y]);
    await waitFor(() => TRIANGLE.every(([x, y]) => linked(N[x], N[y])), 'triangle linked');

    // B selected, B plays A's sound (its audio.policy accepts it).
    A.hub.select(B.id);
    assert.strictEqual(A.hub.selectedId, B.id);
    assert.strictEqual(A.hub.audioRoute().targetId, B.id);
    B.hub.bus.send(A.id, { t: T.AUDIO_POLICY, accept: true });
    await waitFor(() => !!A.sound.sending, 'A sends its sound to B');
    if (platform === 'linux') await waitFor(() => A.sound.sending.loop, 'the loopback source is up');

    // The pointer crosses to C: C's pair (sound off) is in the settings now, the sound stays with B.
    A.hub.select(C.id);
    assert.strictEqual(A.settings.audio.send, false, 'the Audio page shows C’s pair');
    assert.ok(A.sound.sending, 'A still sends its sound');
    assert.strictEqual(A.hub.audioRoute().targetId, B.id, 'the sound stays with B');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(B.stops.length, 0, 'B was not told to stop');

    // Back to B: its pair comes back, nothing restarts.
    const session = A.sound.sending.session;
    A.hub.select(B.id);
    assert.strictEqual(A.settings.audio.send, true, 'B’s pair is back');
    assert.strictEqual(A.sound.sending && A.sound.sending.session, session, 'the same sending session');

    // B's own switch off (B selected): the sound stops, as before.
    A.settings.audio.send = false;
    A.sound.apply();
    assert.strictEqual(A.sound.sending, null, 'turning B’s switch off stops it');
    await waitFor(() => B.stops.some((s) => s.from === A.id), 'B gets audio.stop'); // its dir as B reads it (P.swapRole)
    console.log(`passed: ${platform}/sound.js keeps playing with B while C (sound off) is selected`);
  } finally {
    close(A, B, C);
  }
}

// #313: C advertises audio.policy {accept: true} while A selects B; switching A to C starts sound
// to C immediately without another announcement from C, tears down A's audio.policy on B, preserves
// explicit local consent, and rejects a stale/replaced socket's policy.
async function runDeferredAdvertisement(platform) {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  const N = { A, B, C };
  const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
  try {
    // B: receive on, send off (so audio route is not sticky on B and A sends audio.policy accept:true to B).
    // C: send on, receive off (explicit local consent to send to C).
    A.settings = normalize({ audio: { send: false, receive: true } });
    A.settings.pairSync = {
      [B.id]: { audio: { out: false, in: true }, values: {} },
      [C.id]: { audio: { out: true, in: false }, values: {} },
    };
    A.sound = new SOUNDS[platform]({ link: A.hub.audioLink(), settings: A.settings, onChange() {}, meshHub: A.hub });
    A.pairSync = new PairSync({
      link: A.hub.facade, settings: A.settings, save() {},
      set: (section, partial) => { Object.assign(A.settings[section], partial); if (section === 'audio') A.sound.apply(); },
      only: ['clipboard', 'notifs', 'apps', 'audio', 'cursor', 'terminal', 'files'], bus: A.hub.bus,
      peerRole: (id) => { const s = A.hub.sessions.get(id); return s ? s.role : null; },
      peerOs: (id) => { const s = A.hub.sessions.get(id); return s ? s.peerOs : null; },
    });
    const bPolicies = [];
    B.hub.bus.on(T.AUDIO_POLICY, (m, from) => { if (from === A.id) bPolicies.push(m.accept); });

    for (const [x, y] of TRIANGLE) await pair(N[x], N[y]);
    await waitFor(() => TRIANGLE.every(([x, y]) => linked(N[x], N[y])), 'triangle linked');

    // A selects B first; wait until B receives A's audio.policy accept:true.
    A.hub.select(B.id);
    assert.strictEqual(A.hub.audioRoute().targetId, B.id);
    await waitFor(() => bPolicies.includes(true), 'B received A audio.policy accept:true');

    // While B is selected on A, C advertises audio.policy {accept: true} ONCE.
    C.hub.bus.send(A.id, { t: T.AUDIO_POLICY, accept: true });
    await waitFor(() => A.hub.heard.replay(A.hub.sessions.get(C.id)).some((m) => m.t === T.AUDIO_POLICY && m.accept === true), 'A remembered C audio.policy');
    assert.strictEqual(A.sound.sending, null, 'A does not start sending while B is selected');

    // A selects C: sound starts immediately without C announcing again; B hears accept: false.
    A.hub.select(C.id);
    assert.strictEqual(A.hub.audioRoute().targetId, C.id);
    await waitFor(() => !!A.sound.sending, 'A starts sending sound to C without another announcement');
    if (platform === 'linux') await waitFor(() => A.sound.sending.loop, 'Linux loopback source up');
    await waitFor(() => bPolicies[bPolicies.length - 1] === false, 'B receives audio.policy accept:false teardown');

    // Sticky audio on C: selecting B does not stop C's sound.
    A.hub.select(B.id);
    assert.strictEqual(A.hub.audioRoute().targetId, C.id, 'sticky audio stays on C');
    assert.ok(A.sound.sending, 'C sound keeps running');

    // Stop sound to C, return to B, and verify a replaced/stale socket for C does not confer permission.
    A.hub.select(C.id);
    A.settings.audio.send = false;
    A.sound.apply();
    assert.strictEqual(A.sound.sending, null);
    A.hub.select(B.id);
    assert.strictEqual(A.hub.audioRoute().targetId, B.id);

    // Re-enable send consent for C, then terminate C's socket and wait for C to reconnect cleanly.
    A.settings.pairSync[C.id].audio.out = true;
    const oldSession = A.hub.sessions.get(C.id);
    const oldWs = oldSession.linkUp ? oldSession.link.ws : oldSession.ctx.ws;
    oldWs.terminate();
    await waitFor(() => !linked(A, C), 'C dropped');
    await waitFor(() => linked(A, C), 'C reconnected on a new socket');
    assert.deepStrictEqual(A.hub.heard.replay(A.hub.sessions.get(C.id)), [], 'old socket state forgotten after reconnect');

    A.hub.select(C.id);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(A.sound.sending, null, 'reconnected C does not inherit old socket audio.policy');
    console.log(`passed: ${platform}/sound.js starts on deferred C audio.policy, tears down B, and rejects replaced socket`);
  } finally {
    close(A, B, C);
  }
}

(async () => {
  await run('windows');
  await run('linux');
  await runDeferredAdvertisement('windows');
  await runDeferredAdvertisement('linux');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
