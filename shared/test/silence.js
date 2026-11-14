// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/silence.js: a Mac and a phone back to back. Nothing until a direction is switched on;
// then silenced on one is silenced on the other, both ways, without an echo; a silence the person
// set themselves is never undone; their turning it off holds; a short drop doesn't flap.
// Run with: node shared/test/silence.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SilenceSync, T } = require('../silence.js');

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// A device's own Do not disturb: apply() is what the sync does, user() what its person does.
class Dnd extends EventEmitter {
  constructor() { super(); this.on_ = false; this.calls = []; this.c = { read: true, set: true }; }
  caps() { return { ...this.c }; }
  state() { return this.on_; }
  watch(on) { this.watched = on; }
  async apply(on) { this.calls.push(on); this.on_ = on; this.emit('change'); return { ok: true }; }
  user(on) { this.on_ = on; this.emit('change'); }
}

// Two ends of one session: what one sends the other hears, as the session's own messages.
function pair() {
  const ends = {};
  let up = false;
  const mk = (me, other, peerId) => {
    const bus = new EventEmitter();
    const e = { bus, ctx: null, local: new Dnd(), opts: { send: false, follow: false }, enabled: true, sent: [] };
    e.link = {
      on: (t, fn) => bus.on(t, fn),
      send: (m) => { e.sent.push(m); if (up) ends[other].bus.emit(m.t, JSON.parse(JSON.stringify(m)), ends[other].ctx); },
      get current() { return up ? e.ctx : null; },
    };
    e.sync = new SilenceSync({ link: e.link, local: e.local, opts: () => e.enabled ? e.opts : null, allow: () => e.enabled, grace: 60 });
    e.connect = () => { e.ctx = { deviceId: peerId }; };
    ends[me] = e;
    return e;
  };
  const mac = mk('mac', 'phone', 'phone-1');
  const phone = mk('phone', 'mac', 'mac-1');
  const connect = () => { mac.connect(); phone.connect(); up = true; mac.bus.emit('welcome', mac.ctx); phone.bus.emit('welcome', phone.ctx); };
  const drop = () => { up = false; mac.bus.emit('closed', mac.ctx); phone.bus.emit('closed', phone.ctx); };
  const set = (e, o) => { Object.assign(e.opts, o); e.sync.refresh(); };
  return { mac, phone, connect, drop, set };
}

(async () => {
  const { mac, phone, connect, drop, set } = pair();
  connect();
  await settle();

  // Nothing switched on: each knows the other speaks it, and nothing else is said or done.
  mac.local.user(true);
  await settle();
  assert.ok(mac.sync.view.peer && phone.sync.view.peer, 'each side heard the other’s hello');
  assert.ok(!mac.sent.some((m) => m.t === T.STATE) && !phone.sent.some((m) => m.t === T.STATE), 'no state is told before a direction is on');
  assert.deepStrictEqual(phone.local.calls, [], 'and nothing is silenced');
  assert.ok(!mac.local.watched && !phone.local.watched, 'nothing is looked at either');

  // One side alone isn't enough: the Mac sends, the phone doesn't follow.
  set(mac, { send: true });
  await settle();
  assert.deepStrictEqual(phone.local.calls, [], 'sending without the other side following does nothing');
  assert.ok(!mac.sent.some((m) => m.t === T.STATE), 'and tells nothing');

  // The Mac's silence on the phone.
  set(phone, { follow: true });
  await settle();
  assert.deepStrictEqual(phone.local.calls, [true], 'the phone is silenced as the Mac is');
  assert.strictEqual(phone.sync.view.leased, true);
  assert.deepStrictEqual(mac.sync.view.ack, { r: 'applied', on: true }, 'the Mac is told it was done');
  mac.local.user(false);
  await settle();
  assert.deepStrictEqual(phone.local.calls, [true, false], 'and not when the Mac no longer is');
  assert.strictEqual(phone.local.state(), false);
  assert.strictEqual(phone.sync.view.leased, false);

  // Both ways, and no echo: what a side silenced for the other is never told back as its own.
  set(phone, { send: true });
  set(mac, { follow: true });
  await settle();
  phone.local.user(true);
  await settle();
  assert.deepStrictEqual(mac.local.calls, [true], 'the phone’s silence on the Mac');
  assert.ok(!mac.sent.some((m) => m.t === T.STATE && m.on === true && m.seq > 2), 'the Mac doesn’t tell the phone’s own silence back');
  assert.deepStrictEqual(phone.local.calls, [true, false], 'so the phone does nothing more');
  phone.local.user(false);
  await settle();
  assert.deepStrictEqual(mac.local.calls, [true, false]);
  assert.strictEqual(mac.local.state(), false);

  // Silenced by its own person: kept when the other side comes and goes.
  phone.local.user(true);
  await settle(); // (the Mac follows: its lease)
  mac.local.user(false); // its person turns it off there: an override, the Mac stays off
  await settle();
  assert.strictEqual(mac.sync.view.leased, false);
  assert.strictEqual(mac.sync.view.overridden, true);
  assert.strictEqual(mac.local.state(), false, 'turned off by its person, it stays off while the phone is still silenced');
  assert.strictEqual(phone.local.state(), true, 'and the phone’s own silence is not touched');
  const macCalls = mac.local.calls.length;
  mac.local.user(true); // the Mac's person, themselves
  await settle();
  assert.deepStrictEqual(phone.local.calls, [true, false], 'the phone was silenced by its person already: kept, not taken');
  mac.local.user(false);
  await settle();
  assert.strictEqual(phone.local.state(), true, 'the Mac going off never turns off the phone’s own');
  assert.strictEqual(mac.local.calls.length, macCalls, 'nor is the Mac silenced again before the phone has been off');
  phone.local.user(false);
  await settle();
  phone.local.user(true); // off and on again: it counts again
  await settle();
  assert.strictEqual(mac.local.state(), true);
  assert.strictEqual(mac.sync.view.leased, true);
  phone.local.user(false);
  await settle();
  assert.strictEqual(mac.local.state(), false);

  // A short drop: the same device back within the grace, still silenced: the lease goes on.
  mac.local.user(true);
  await settle();
  const n = phone.local.calls.length;
  assert.strictEqual(phone.sync.view.leased, true);
  drop();
  await settle();
  assert.strictEqual(phone.local.state(), true, 'kept through the drop');
  connect();
  await settle();
  assert.strictEqual(phone.local.calls.length, n, 'neither undone nor done again');
  assert.strictEqual(phone.sync.view.leased, true);
  await new Promise((r) => setTimeout(r, 90)); // past the grace
  assert.strictEqual(phone.local.state(), true, 'the grace no longer applies once it is back');
  mac.local.user(false);
  await settle();
  assert.strictEqual(phone.local.state(), false, 'and it still ends with the Mac’s');
  {
    const p = pair();
    p.mac.enabled = false;
    p.mac.opts.follow = true;
    p.phone.opts.send = true;
    p.phone.local.user(true);
    p.connect();
    await settle();
    assert.strictEqual(p.mac.local.state(), false, 'Notifications off at startup does not follow');
    p.mac.enabled = true;
    p.mac.sync.start();
    await settle();
    assert.strictEqual(p.mac.local.state(), true, 'enabling Notifications starts the current session');
    p.mac.enabled = false;
    p.mac.sync.stop();
    await settle();
    assert.strictEqual(p.mac.local.state(), false, 'disabling Notifications releases its lease');
    assert.strictEqual(p.mac.opts.follow, true, 'the saved direction is preserved');
    p.mac.enabled = true;
    p.mac.sync.start();
    await settle();
    assert.strictEqual(p.mac.local.state(), true, 're-enabling resumes without reconnecting');
    p.mac.sync.stop();
    p.phone.sync.stop();
    await settle();
  }
  console.log('silence: off until switched on, both ways without an echo, the person’s own kept, their off held, no flap on a drop');
})().catch((e) => { console.error(e); process.exit(1); });
