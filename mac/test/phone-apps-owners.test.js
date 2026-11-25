// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { Server } = require('../server.js');
const { Pairing } = require('../pairing.js');
const { Peer } = require('../peer.js');
const { Phone } = require('../phone.js');
const store = require('../store.js');
const P = require('../../shared/protocol.js');
const { loadTestCert, rawConnect, waitFor } = require('../mesh/test/lib/mesh.js');

const { T } = P;
const id = 'fixture-phone';
const token = 'fixture-phone-token';

async function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-phone-apps-'));
  store.init(profile);
  store.write('paired.json', [{ id, name: 'Fixture phone', os: P.OS.ANDROID, tokenHash: P.sha256Hex(token) }]);
  const tls = loadTestCert();
  const raw = new Server(tls, { hold: true });
  const pairing = new Pairing(raw, { macId: 'fixture-mac', macName: 'Fixture Mac', fp: tls.fp });
  const outgoing = new EventEmitter();
  outgoing.poke = () => {};
  const off = { TWINDESK_NO_FX2: process.env.TWINDESK_NO_FX2, TWINDESK_NO_IL: process.env.TWINDESK_NO_IL };
  for (const key of Object.keys(off)) process.env[key] = '1';
  let peer;
  try { peer = new Peer(raw, outgoing); }
  finally {
    for (const [key, saved] of Object.entries(off)) {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
  }
  const phone = new Phone({ server: peer, raw, pairing });
  const clients = [];
  t.after(() => {
    for (const client of clients) client.close();
    raw.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  raw.https.listen(0, '127.0.0.1');
  await once(raw.https, 'listening');
  return { phone, raw, peer, async dial() {
    const client = await rawConnect(raw.https.address().port);
    clients.push(client);
    client.send({ t: T.HELLO, v: P.PROTOCOL_VERSION, id, token, os: P.OS.ANDROID, pa: 1 });
    assert.equal((await client.until(m => m.t === T.WELCOME)).pa, 1);
    return client;
  } };
}

test('a late one-to-one close preserves the replacement inventory and rejects stale responses', async t => {
  const f = await fixture(t);
  const old = await f.dial();
  const oldCtx = f.raw.current;
  const version = 'a'.repeat(64);
  old.send({ t: T.PHONE_APPS, version, apps: [{ id: 'fixture.first' }] });
  await waitFor(() => f.phone.apps.length === 1, 'cached inventory');
  const closed = once(f.peer, 'closed');
  const client = await f.dial();
  assert.ok((await closed)[0] === oldCtx, 'the close belongs to the old authenticated context');
  assert.ok(f.phone.appsSession?.owner === f.raw.current.ws, 'old close cannot cancel the replacement inventory');
  assert.equal(f.phone.apps[0]?.id, 'fixture.first');

  f.peer.emit(`t:${T.PHONE_APPS}`, { version, apps: [] }, oldCtx, oldCtx.ws);
  assert.equal(f.phone.apps[0]?.id, 'fixture.first');
  client.send({ t: T.SCREEN_POLICY, accept: true });
  await waitFor(() => f.phone.appsSession?.waitingForFrame, 'viewer admission');
  client.send({ t: T.PHONE_APPS_READY });
  assert.equal((await client.until(m => m.t === T.PHONE_APPS_LIST)).version, version);
  assert.equal(old.count(T.PHONE_APPS_LIST), 0, 'an unsolicited valid list cleared the old timers');
  client.close();
  await waitFor(() => !f.phone.appsSession && !f.phone.apps.length, 'normal disconnect clears inventory');
});

test('a stalled viewer cannot postpone inventory beyond the authenticated session deadline', { timeout: 18_000 }, async t => {
  const f = await fixture(t);
  const start = performance.now();
  const client = await f.dial();
  client.send({ t: T.SCREEN_POLICY, accept: true });
  await waitFor(() => f.phone.appsSession?.waitingForFrame, 'viewer admission');
  await sleep(7500);
  client.send({ t: T.SCREEN_POLICY, accept: false });
  client.send({ t: T.SCREEN_POLICY, accept: true });
  assert.equal(client.count(T.PHONE_APPS_LIST), 0);
  await client.until(m => m.t === T.PHONE_APPS_LIST, 8500);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 13_750 && elapsed < 15_750, `session deadline elapsed ${elapsed} ms`);
  client.send({ t: T.PHONE_APPS_READY });
  await sleep(60);
  assert.equal(client.count(T.PHONE_APPS_LIST), 1, 'presentation after deadline does not replay inventory');
});
