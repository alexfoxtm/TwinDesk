// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const P = require('../../../shared/protocol');
const { sleepWake } = require('../../../shared/sleepwake');
const { Server } = require('../server');

test('suspend closes every guest and wake invites an eligible computer at its discovered address', (t) => {
  const server = Object.assign(Object.setPrototypeOf(new EventEmitter(), Server.prototype), {
    sockets: new Set(), clients: new Map(), busyFlags: new Map(), authSeq: 0, _now: Date.now,
    ilPool: { drop() {} },
  });
  server.on('preauth', (ctx) => server.authenticate(ctx, { deviceId: 'phone', name: 'Phone', os: P.OS.ANDROID }, { t: P.T.WELCOME }));
  const powerMonitor = new EventEmitter();
  const invites = [];
  const found = new Map();
  const ended = [];
  const sleep = server.sleep.bind(server);
  server.sleep = (on) => {
    const ids = sleep(on);
    if (on) ended.push(...ids);
    return ids;
  };
  const socket = () => {
    const sent = [];
    const ws = {
      OPEN: 1, readyState: 1,
      send(raw) { sent.push(JSON.parse(raw)); },
      close() { this.readyState = 3; server._onSocketClose(this); },
      terminate() { this.close(); },
    };
    const ctx = { ws, transport: 'ip', address: '127.0.0.1' };
    ws.ctx = ctx;
    server.sockets.add(ctx);
    return { ctx, ws, sent };
  };
  const hello = (sock, fields = {}) => {
    server._onMessage(sock.ctx, Buffer.from(JSON.stringify({ t: P.T.HELLO, ...fields })), false, sock.ws);
  };
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const discovery = { get: (id) => found.get(id), invite: (address) => invites.push(address) };
    sleepWake({
      powerMonitor, server: () => server, discovery: () => discovery,
      canInvite: (d) => !P.isPhoneOs(d.os),
    });
    const guests = [];
    for (const os of [P.OS.ANDROID, P.OS.IOS, P.OS.WIN]) {
      const guest = socket();
      server.authenticate(guest.ctx, { deviceId: os, name: os, os }, { t: P.T.WELCOME });
      found.set(os, { os, address: '192.0.2.' + found.size });
      guests.push(guest);
    }
    powerMonitor.emit('suspend');
    assert.deepEqual(ended, [P.OS.ANDROID, P.OS.IOS, P.OS.WIN]);
    assert.equal(server.clients.size, 0);
    for (const guest of guests) assert.equal(guest.sent.at(-1).code, P.E.ASLEEP);
    for (const fields of [{}, { rc: 1, resume: '0' }]) {
      const refused = socket();
      hello(refused, fields);
      assert.equal(refused.sent.at(-1).code, P.E.ASLEEP);
    }
    powerMonitor.emit('resume');
    found.get(P.OS.WIN).address = '192.0.2.50';
    t.mock.timers.tick(2000);
    assert.deepEqual(invites, ['192.0.2.50']);
    const awake = socket();
    hello(awake, { v: P.PROTOCOL_VERSION });
    assert.equal(awake.sent.at(-1).t, P.T.WELCOME);
  } finally {
    powerMonitor.emit('suspend');
  }
});
