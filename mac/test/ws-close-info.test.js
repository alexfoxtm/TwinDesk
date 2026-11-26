// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

for (const [name, { Server }] of [['Direct', require('../server')], ['Mesh', require('../mesh/server')]]) {
  test(`${name} logs WebSocket status and TCP errors without changing the closed event`, (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const server = Object.create(Server.prototype);
    EventEmitter.call(server);
    Object.assign(server, {
      sockets: new Set(), clients: new Map(), blePorts: new Map(), ilPool: { drop() {} },
      _arm() {}, _now: () => 1000, send() {},
    });
    const closed = [];
    server.on('closed', (ctx, unexpected) => closed.push([ctx, unexpected]));
    function connect() {
      const socket = Object.assign(new EventEmitter(), { remoteAddress: '100.101.1.2' });
      const ws = Object.assign(new EventEmitter(), {
        close() { ws.emit('close', 1006, Buffer.alloc(0)); },
      });
      server._onConnection(ws, { socket });
      Object.assign(ws.ctx, { authed: true, deviceId: 'synthetic-device' });
      if (name === 'Direct') server.current = ws.ctx;
      server.clients.set(ws.ctx.deviceId, ws.ctx);
      return { socket, ws };
    }
    const first = connect();
    first.socket.emit('error', Object.assign(new Error('socket payload'), { code: 'ECONNRESET' }));
    first.ws.emit('close', 1006, Buffer.alloc(0));
    assert.match(log.mock.calls[0].arguments[0], /code=1006 reason=abnormal .*by=socket-error tcp=ECONNRESET .*via=tailscale/);
    assert.doesNotMatch(log.mock.calls[0].arguments[0], /100\.101\.1\.2|synthetic-device|socket payload/);
    assert.deepEqual(closed[0], [first.ws.ctx, true]);

    const second = connect();
    second.ws.emit('close', 1009, Buffer.from('private close message'));
    assert.match(log.mock.calls[1].arguments[0], /code=1009 reason=message-too-big peerText=yes/);
    assert.doesNotMatch(log.mock.calls[1].arguments[0], /private close message/);
    assert.deepEqual(closed[1], [second.ws.ctx, false]);

    const third = connect();
    server.fail(third.ws.ctx, 'asleep', 'Asleep');
    assert.match(log.mock.calls[2].arguments[0], /code=1006 .*by=local-asleep/);
    assert.deepEqual(closed[2], [third.ws.ctx, false]);
  });
}
