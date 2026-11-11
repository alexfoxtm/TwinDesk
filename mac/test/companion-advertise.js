// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { CompanionAdvertise } = require('../companion-advertise');
const { BleHost } = require('../../shared/blepipe');
const P = require('../../shared/protocol');

function fixture(mesh = false) {
  const server = new EventEmitter();
  const pairing = new EventEmitter();
  const helper = new EventEmitter();
  const paired = new Set(['phone']);
  const sent = [], commands = [], timers = [];
  let now = 0;
  let normal = false;
  helper.running = true;
  helper.request = (name, args) => { commands.push({ name, args }); return Promise.resolve({}); };
  pairing.list = () => [...paired].map((id) => ({ id }));
  server.send = (ctx, msg) => sent.push({ ctx, msg });
  if (mesh) server.clients = new Map();
  const phone = () => ({ authed: true, deviceId: 'phone', os: P.OS.ANDROID, ws: { OPEN: 1, readyState: 1 } });
  const attach = (ctx) => { if (mesh) server.clients.set(ctx.deviceId, ctx); else server.current = ctx; };
  let ble;
  const approval = new CompanionAdvertise({
    server, pairing, apply: () => ble && ble.apply(), now: () => now,
    setTimer: (fn) => { const timer = { fn }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  ble = new BleHost({ helper, server, info: () => ({ id: 'mac', os: P.OS.MAC }), enabled: () => approval.active || normal });
  const request = (ctx, requestId, on) => server.emit('message', { t: 'companion.advertise', requestId, on }, ctx);
  return { server, pairing, paired, sent, commands, timers, approval, ble, phone, attach, request,
    setNow: (value) => { now = value; }, setNormal: (value) => { normal = value; } };
}

function boundedLeaseRestoresPolicy() {
  for (const mesh of [false, true]) {
    const f = fixture(mesh), ctx = f.phone();
    f.attach(ctx);
    f.request(ctx, 'first', true);
    assert(f.approval.active);
    assert(f.approval.accepts('phone'));
    assert(!f.approval.accepts('other'));
    assert.strictEqual(f.commands.at(-1).name, 'bleStart');
    assert.strictEqual(f.sent.at(-1).msg.expiresInMs, 60000);
    f.setNow(15000);
    f.request(ctx, 'first', true);
    assert.strictEqual(f.sent.at(-1).msg.expiresInMs, 45000, 'repeat cannot renew the window');
    assert.strictEqual(f.timers.length, 1);
    f.request(ctx, 'first', false);
    assert.strictEqual(f.commands.at(-1).name, 'bleStop');
    f.request(ctx, 'second', true);
    f.request(ctx, 'first', false);
    f.timers[0].fn();
    assert(f.approval.active, 'old cancellation and timeout cannot stop the new lease');
    f.setNormal(true);
    f.setNow(75000);
    f.timers[1].fn();
    assert(!f.approval.active);
    assert(f.ble.wanted, 'expiry restores the current BLE preference, not the old snapshot');
  }
}

function refusesAndRevokesWrongOwner() {
  for (const mesh of [false, true]) {
    const f = fixture(mesh), ctx = f.phone();
    f.attach(ctx);
    for (const bad of [{ ...ctx, authed: false }, { ...ctx, os: P.OS.MAC }, f.phone()]) f.request(bad, 'bad', true);
    f.request(ctx, '<invalid>', true);
    assert.strictEqual(f.sent.length, 0);
    f.request(ctx, 'one', true);
    const replacement = f.phone();
    f.attach(replacement);
    f.server.emit('client', replacement);
    assert(!f.approval.active);
    assert.strictEqual(f.commands.at(-1).name, 'bleStop');
    f.request(replacement, 'two', true);
    f.server.emit('closed', ctx);
    assert(f.approval.active, 'late old close does not revoke the new owner');
    f.paired.clear();
    f.pairing.emit('change');
    assert(!f.approval.active, 'Forget immediately restores quiet BLE');
    assert.strictEqual(f.commands.at(-1).name, 'bleStop');
    f.request(replacement, 'three', true);
    assert(!f.approval.active, 'forgotten peer cannot restart advertising');
  }
}

boundedLeaseRestoresPolicy();
refusesAndRevokesWrongOwner();
console.log('companion-advertise: ok');
