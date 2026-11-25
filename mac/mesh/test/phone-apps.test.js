// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { node, close, waitFor, pairPhone, rawConnect } = require('./lib/mesh.js');
const { PhoneDir, PhoneSet } = require('../phones.js');
const { Phone } = require('../../phone.js');
const P = require('../../../shared/protocol.js');
const T = P.T;

test('an authenticated phone refreshes apps after presentation, reuses its cache, and keeps legacy inventory', async () => {
  const mac = await node('Fixture Mac');
  const clients = [];
  try {
    const dir = new PhoneDir(mac.hub, mac.server);
    const set = new PhoneSet({ hub: mac.hub, link: dir, make(server) {
      return { phone: new Phone({ server }), bridge: {}, views: {} };
    } });
    const pair = await pairPhone(mac);
    clients.push(pair.client);
    pair.client.close();
    async function dial(pa) {
      const c = await rawConnect(mac.port);
      clients.push(c);
      c.send({ t: T.HELLO, v: P.PROTOCOL_VERSION, os: P.OS.ANDROID, id: pair.id, token: pair.token, pa });
      const welcome = await c.until(m => m.t === T.WELCOME);
      assert.equal(welcome.pa, pa ? 1 : undefined);
      return c;
    }
    async function watch(c, phone) {
      c.send({ t: T.SCREEN_POLICY, accept: true });
      await waitFor(() => phone.appsSession?.waitingForFrame, 'viewer admission');
      phone.refreshApps(); // the bridge's setup refresh follows the same gate
      assert.equal(c.count(T.PHONE_APPS_LIST), 0);
      c.send({ t: T.PHONE_APPS_READY });
      return c.until(m => m.t === T.PHONE_APPS_LIST);
    }

    let client = await dial(1);
    const unit = set.unit(pair.id), phone = unit.phone;
    assert.equal((await watch(client, phone)).version, undefined);
    const version = 'a'.repeat(64);
    client.send({ t: T.PHONE_APPS, version, apps: [{ id: 'fixture.one', name: 'One' }] });
    await waitFor(() => phone.apps.length === 1, 'first inventory');
    const former = unit.link.current;
    client.close();
    await waitFor(() => phone.apps.length === 0, 'inventory hidden when disconnected');

    client = await dial(1);
    assert.equal(phone.apps[0].id, 'fixture.one');
    unit.link.route.emit(`t:${T.PHONE_APPS}`, { apps: [] }, former);
    assert.equal(phone.apps.length, 1, 'stale response cannot replace this inventory');
    const request = await watch(client, phone);
    assert.equal(request.version, version);
    client.send({ t: T.PHONE_APPS, version });
    assert.equal(phone.apps[0].id, 'fixture.one');
    client.close();
    await waitFor(() => !unit.link.current, 'disconnected');

    client = await dial(1);
    const idleRequest = await client.until(m => m.t === T.PHONE_APPS_LIST);
    assert.equal(idleRequest.version, version, 'without a viewer the idle deadline refreshes the cache');
    client.send({ t: T.PHONE_APPS, version: 'b'.repeat(64), apps: [{ id: 'fixture.two', name: 'Two' }] });
    await waitFor(() => phone.apps[0]?.id === 'fixture.two', 'a changed version replaces the old inventory');
    client.close();
    await waitFor(() => !unit.link.current, 'disconnected');

    client = await dial(0);
    assert.equal((await client.until(m => m.t === T.PHONE_APPS_LIST)).version, undefined);
  } finally {
    for (const client of clients) client.close();
    close(mac);
  }
});
