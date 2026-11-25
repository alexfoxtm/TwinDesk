// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages' carrier requests name the phone and session they were made for. A send that names
// none, or names a replaced one, never reaches the phone; reads that name a stale one are refused
// while ordinary reads still work. A group is sent whole or refused, never cut down to 20.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const P = require('../protocol.js');
const { PhoneHub } = require('../phonehub.js');

function setup() {
  const sent = [];
  const server = Object.assign(new EventEmitter(), {
    current: { deviceId: 'fixture-phone', os: P.OS.ANDROID, name: 'Fixture' },
    sendToClient: (m) => sent.push(m),
  });
  const settings = { hub: { media: false, files: false, calls: false, messages: true } };
  const hub = new PhoneHub({ server, getSettings: () => settings, save() {} });
  hub.phoneSession = 3;
  hub.state = { messages: { perm: 'ok', missing: [] } };
  return { hub, sent, phone: { deviceId: 'fixture-phone', session: 3 } };
}

const many = (n) => Array.from({ length: n }, (_, i) => `+120255501${String(i).padStart(2, '0')}`);

test('a carrier send must name the connected phone and session', () => {
  const { hub, sent, phone } = setup();
  const msg = { t: P.T.SMS_SEND, to: '+12025550100', body: 'Synthetic', ref: 'r1' };
  assert.equal(hub.ask(msg), false, 'no phone named');
  assert.equal(hub.ask({ ...msg, phone: { ...phone, session: 2 } }), false, 'a replaced session');
  assert.equal(hub.ask({ ...msg, phone: { ...phone, deviceId: 'other-phone' } }), false, 'another phone');
  assert.equal(sent.length, 0);
  assert.equal(hub.ask({ ...msg, phone }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, undefined, 'the binding is not forwarded to the phone');
  hub.state = { messages: { perm: 'ok', missing: ['send'] } };
  assert.equal(hub.ask({ ...msg, phone }), false, 'carrier permission still gates it');
  assert.equal(sent.length, 1);
});

test('history and list reads naming a stale phone are refused; ordinary reads still work', () => {
  const { hub, sent, phone } = setup();
  for (const m of [{ t: P.T.SMS_THREADS, n: 80 }, { t: P.T.SMS_THREAD, id: '12', before: 0, n: 50 }, { t: P.T.SMS_PART, id: '7' }]) {
    assert.equal(hub.ask({ ...m, phone: { ...phone, session: 1 } }), false, `${m.t} for a replaced session`);
    assert.equal(hub.ask({ ...m, phone: { ...phone, deviceId: 'other-phone' } }), false, `${m.t} for another phone`);
    assert.equal(hub.ask({ ...m, phone }), true, `${m.t} for this phone`);
    assert.equal(hub.ask(m), true, `${m.t} without a binding (ordinary refresh)`);
  }
  assert.equal(sent.length, 6);
  assert.ok(sent.every((m) => m.phone === undefined));
});

test('a group is sent whole or refused: 21 members or a blank member never reach the phone', () => {
  const { hub, sent, phone } = setup();
  const msg = { t: P.T.SMS_SEND, to: '+12025550100', body: 'Synthetic', ref: 'r1', phone };
  assert.equal(hub.ask({ ...msg, addrs: many(21) }), false);
  assert.equal(hub.ask({ ...msg, addrs: [...many(3), '  '] }), false);
  assert.equal(sent.length, 0);
  assert.equal(hub.ask({ ...msg, addrs: many(20) }), true);
  assert.equal(sent[0].addrs.length, 20);
});
