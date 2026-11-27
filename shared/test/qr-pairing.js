// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The pairing QR link is single-use: a pairing that went through consumes the nonce, so a link
// seen twice pairs only once. All three hostpair implementations, driven with a fake server and a
// stub store (paired.json never touches disk).
// Run with: node shared/test/qr-pairing.js
'use strict';

const assert = require('assert');
const path = require('path');
const P = require('../protocol.js');

// hostpair.js and pairing.js require('./store'): hand them a stub instead of the real one.
for (const dir of ['windows', 'linux', 'mac']) {
  const p = require.resolve(path.join(__dirname, '..', '..', dir, 'store.js'));
  require.cache[p] = { exports: { read: (n, fb) => fb, write: () => {}, remove: () => {} }, loaded: true, id: p, filename: p };
}
const impls = {
  windows: require('../../windows/hostpair.js').Pairing,
  linux: require('../../linux/hostpair.js').Pairing,
  mac: require('../../mac/pairing.js').Pairing,
};

const fakeServer = (sent) => {
  const { EventEmitter } = require('events');
  const s = new EventEmitter();
  s.sent = sent;
  s.send = (ctx, m) => sent.push(m);
  s.fail = (ctx, code, why) => { throw new Error(`server.fail ${code}: ${why}`); };
  s.closeDevice = () => {};
  s.current = null;
  s.phoneGrace = null;
  s.phoneHolds = () => false;
  s.endPhoneGrace = () => {};
  return s;
};

const ctx = { address: '203.0.113.7', ws: { close() {} } };

// A QR-style pairing to completion on one implementation: start with the nonce in `wired`
// (as mains pass it to isWired and isQr), reveal, confirm, Allow. Returns the pairing object.
function pairOnce(Pairing, qrPairBox, sent) {
  const pairing = new Pairing(fakeServer(sent), { id: 'host-id', name: 'Host', fp: '00' });
  // What the mains wire: the predicate knows the nonce, the consume hook drops it.
  pairing.isQr = (n) => !!qrPairBox.qrPair && n === qrPairBox.qrPair.nonce && Date.now() < qrPairBox.qrPair.until;
  pairing.consumeQr = () => { qrPairBox.qrPair = null; };
  const nw = P.randomHex(16);
  pairing._onMessage(ctx, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'phone-1', name: 'Phone', os: P.OS.ANDROID, commit: P.commitOf(nw), wired: 'scanned-nonce' });
  assert.ok(pairing.pending && pairing.pending.qr, 'a valid QR nonce marks the pair qr');
  pairing._onMessage(ctx, { t: P.T.PAIR_REVEAL, nonce: nw });
  assert.ok(pairing.pending.code, 'reveal produced the code');
  pairing._onMessage(ctx, { t: P.T.PAIR_CONFIRM });
  pairing.respond(true);
  assert.strictEqual(pairing.pending, null, 'pairing finished');
  assert.ok(sent.some((m) => m.t === P.T.PAIR_OK), 'PAIR_OK went out');
  return pairing;
}

for (const [name, Pairing] of Object.entries(impls)) {
  const sent = [];
  const box = { qrPair: { nonce: 'scanned-nonce', until: Date.now() + 600000 } };
  const pairing = pairOnce(Pairing, box, sent);
  assert.strictEqual(box.qrPair, null, `${name}: a completed QR pairing consumes the nonce`);
  // The same link seen again: no qr flag, so it is an ordinary pair.start.
  const nw = P.randomHex(16);
  pairing._onMessage(ctx, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'phone-2', name: 'Phone', os: P.OS.ANDROID, commit: P.commitOf(nw), wired: 'scanned-nonce' });
  assert.ok(pairing.pending && !pairing.pending.qr, `${name}: a reused link no longer counts as QR`);
  pairing._onMessage(ctx, { t: P.T.PAIR_CANCEL });
}


// An embedded route has its own one-use QR and transport identity. Once paired,
// the exact saved node can resume by an ordinary authenticated hello.
for (const mode of ['direct', 'mesh']) {
  const Pairing = mode === 'direct' ? impls.mac : require('../../mac/mesh/pairing.js').Pairing;
  const sent = [];
  const server = fakeServer(sent);
  server.authenticate = (socket, who, _welcome, gate) => {
    if (gate) {
      const decision = gate();
      if (!decision.ok) return server.fail(socket, decision.code, decision.message);
    }
    socket.authed = true;
    server.accepted = who.deviceId;
  };
  const pairing = new Pairing(server, { macId: 'host-id', macName: 'Mac', fp: '00' },
    { store: require('../../mac/store.js') });
  let remoteNonce = 'embed-nonce';
  pairing.isQr = (nonce) => nonce === 'lan-nonce';
  pairing.isWired = pairing.isQr;
  pairing.embeddedTailnet = {
    knows: (nonce) => nonce === remoteNonce,
    consume: () => { remoteNonce = null; },
  };
  const embedded = { ...ctx, embeddedPeer: 'node-phone' };
  const nw = P.randomHex(16);
  const start = { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'embedded-phone',
    name: 'Phone', os: P.OS.ANDROID, commit: P.commitOf(nw) };
  assert.throws(() => pairing._onMessage(embedded, { ...start, wired: 'lan-nonce' }), /fresh embedded Tailscale/);
  pairing._onMessage(embedded, { ...start, wired: remoteNonce });
  assert.strictEqual(pairing.pending.qr, true);
  assert.strictEqual(pairing.pending.wired, false);
  pairing._onMessage(embedded, { t: P.T.PAIR_REVEAL, nonce: nw });
  pairing._onMessage(embedded, { t: P.T.PAIR_CONFIRM });
  assert(!sent.some((m) => m.t === P.T.PAIR_OK), 'Tailnet eligibility alone does not pair');
  pairing.respond(true);
  const payload = sent.find((m) => m.t === P.T.PAIR_OK);
  assert(payload);
  assert.strictEqual(remoteNonce, null);
  const hello = { t: P.T.HELLO, v: P.PROTOCOL_VERSION, id: start.id, token: payload.token,
    os: P.OS.ANDROID, il: {}, fx: 1, fx2: 1 };
  assert.throws(() => pairing._onMessage({ ...embedded, embeddedPeer: 'other-node' }, hello), /Not paired/);
  pairing._onMessage(embedded, hello);
  assert.strictEqual(server.accepted, start.id);
  assert.strictEqual(embedded.fxWanted, false, 'the verified WSS tunnel does not advertise a second TCP path');
  assert.strictEqual(embedded.ilWanted, null, 'the tunnel does not advertise a direct UDP lane');

  const lanToken = P.randomHex(32);
  const lanPair = { id: 'lan-phone', name: 'LAN Phone', os: P.OS.ANDROID, tokenHash: P.sha256Hex(lanToken) };
  pairing.paired.push(lanPair);
  const lanHello = { ...hello, id: lanPair.id, token: lanToken };
  const remote = { ...ctx, embeddedPeer: 'node-lan-phone' };
  assert.throws(() => pairing._onMessage(remote, { ...lanHello, token: P.randomHex(32) }), /Not paired/);
  assert.strictEqual(lanPair.tailNode, undefined, 'a failed hello cannot claim the binding');
  if (mode === 'direct') {
    pairing.returnPhone = lanPair.id;
    Object.assign(lanHello, { rc: 1, resume: '0' });
    server.current = { authed: true, deviceId: 'another-phone' };
    assert.throws(() => pairing._onMessage(remote, lanHello), /in use by another device/i);
    assert.strictEqual(lanPair.tailNode, undefined, 'a busy Mac does not learn a binding');
    server.current = null;
  }
  pairing._onMessage(remote, lanHello);
  assert.strictEqual(server.accepted, lanPair.id, 'the existing LAN token authenticates directly');
  assert.strictEqual(lanPair.tailNode, remote.embeddedPeer);
  assert.strictEqual(pairing.pending, null, 'reusing a pairing never starts the QR flow');
  assert.throws(() => pairing._onMessage({ ...ctx, embeddedPeer: 'other-node' }, lanHello), /Not paired/);
}

console.log('qr-pairing: ok');
process.exit(0);
