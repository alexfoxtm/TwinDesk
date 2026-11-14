// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/silence.js when something is missing or wrong: it does nothing rather than guess. A side
// that can't read or set, a shortcut that fails, a state that became unknown, a message from
// another session, Stop, Forget, a session that never comes back and another device in its place.
// Run with: node shared/test/silence-fail.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SilenceSync, T } = require('../silence.js');

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Dnd extends EventEmitter {
  constructor() { super(); this.on_ = false; this.calls = []; this.c = { read: true, set: true }; this.fail = ''; }
  caps() { return { ...this.c }; }
  state() { return this.on_; }
  watch() {}
  async apply(on) {
    this.calls.push(on);
    if (this.fail) return { ok: false, why: this.fail };
    this.on_ = on;
    this.emit('change');
    return { ok: true };
  }
  user(on) { this.on_ = on; this.emit('change'); }
}

// The Mac sends, the phone follows; `phone` is the side under test.
function pair() {
  const ends = {};
  let up = false;
  const mk = (me, other, peerId, opts) => {
    const bus = new EventEmitter();
    const e = { bus, ctx: null, local: new Dnd(), opts, sent: [], peerId };
    e.link = {
      on: (t, fn) => bus.on(t, fn),
      send: (m) => { e.sent.push(m); if (up) ends[other].bus.emit(m.t, JSON.parse(JSON.stringify(m)), ends[other].ctx); },
      get current() { return up ? e.ctx : null; },
    };
    e.sync = new SilenceSync({ link: e.link, local: e.local, opts: () => e.opts, grace: 40 });
    ends[me] = e;
    return e;
  };
  const mac = mk('mac', 'phone', 'phone-1', { send: true, follow: false });
  const phone = mk('phone', 'mac', 'mac-1', { send: false, follow: true });
  const connect = (macId = 'mac-1') => {
    mac.ctx = { deviceId: 'phone-1' };
    phone.ctx = { deviceId: macId };
    up = true;
    mac.bus.emit('welcome', mac.ctx);
    phone.bus.emit('welcome', phone.ctx);
  };
  const drop = () => { up = false; mac.bus.emit('closed', mac.ctx); phone.bus.emit('closed', phone.ctx); };
  return { mac, phone, connect, drop };
}

(async () => {
  // It can't set here (no access, no shortcut): nothing is tried, and the Mac tells nothing.
  {
    const { mac, phone, connect } = pair();
    phone.local.c.set = false;
    connect();
    mac.local.user(true);
    await settle();
    assert.deepStrictEqual(phone.local.calls, [], 'no access: nothing tried');
    assert.ok(!mac.sent.some((m) => m.t === T.STATE), 'a side that can’t follow is told nothing');
    assert.strictEqual(mac.sync.view.ack, null, 'and the Mac never shows it as done');
    // It can set but not read: the same (what can't be seen isn't set).
    phone.local.c = { read: false, set: true };
    phone.sync.refresh();
    await settle();
    assert.deepStrictEqual(phone.local.calls, []);
    assert.deepStrictEqual(phone.sync.view.can, { read: false, set: false });
  }

  // The setter fails (a shortcut that is gone): no lease, and the Mac hears "failed", never "applied".
  {
    const { mac, phone, connect } = pair();
    phone.local.fail = 'shortcut';
    connect();
    mac.local.user(true);
    await settle();
    assert.deepStrictEqual(phone.local.calls, [true], 'tried once, not again and again');
    assert.strictEqual(phone.sync.view.leased, false);
    assert.strictEqual(phone.sync.view.last.r, 'failed');
    assert.strictEqual(phone.sync.view.last.why, 'shortcut');
    assert.deepStrictEqual(mac.sync.view.ack, { r: 'failed', on: true });
    mac.local.user(false);
    await settle();
    assert.deepStrictEqual(phone.local.calls, [true], 'nothing of ours to undo');
  }

  // The Mac can't tell any more (permission taken away, or it stops sending): unknown is off.
  {
    const { mac, phone, connect } = pair();
    connect();
    mac.local.user(true);
    await settle();
    assert.strictEqual(phone.sync.view.leased, true);
    mac.local.c.read = false;
    mac.sync.refresh();
    await settle();
    assert.strictEqual(phone.local.state(), false, 'the Mac can’t read its state any more: released');
    mac.local.c.read = true;
    mac.sync.refresh();
    await settle();
    assert.strictEqual(phone.local.state(), true, '(and back when it can)');
    phone.opts.follow = false; // the phone's person switches following off
    phone.sync.refresh();
    await settle();
    assert.strictEqual(phone.local.state(), false, 'switched off here: released at once');
  }

  // Its own state became unknown while holding the lease, and undoing isn't scoped: not undone blindly.
  {
    const { mac, phone, connect } = pair();
    connect();
    mac.local.user(true);
    await settle();
    phone.local.on_ = null; // can't be read any more
    mac.local.user(false);
    await settle();
    assert.deepStrictEqual(phone.local.calls, [true], 'no blind off: it could be the person’s own by now');
    assert.strictEqual(phone.sync.view.leased, false);
    assert.strictEqual(phone.sync.view.stale, true, 'the page says it was left');
  }

  // Messages that aren't this session's: another sid, an old seq, a state replayed after a reconnect.
  {
    const { mac, phone, connect, drop } = pair();
    connect();
    mac.local.user(true);
    await settle();
    const old = mac.sent.filter((m) => m.t === T.STATE).pop();
    mac.local.user(false);
    await settle();
    assert.strictEqual(phone.local.state(), false);
    const before = phone.sync.dropped;
    phone.bus.emit(T.STATE, { ...old }, phone.ctx); // the same message again: its seq is behind
    phone.bus.emit(T.STATE, { ...old, seq: old.seq + 10, sid: 'deadbeefdeadbeef' }, phone.ctx); // not the Mac's session
    phone.bus.emit(T.STATE, { ...old, seq: old.seq + 10, to: 'deadbeefdeadbeef' }, phone.ctx); // not for ours
    phone.bus.emit(T.STATE, { ...old, seq: old.seq + 10 }, { deviceId: 'mac-1' }); // from a socket that isn't the session
    phone.bus.emit(T.STATE, { ...old, seq: old.seq + 10, on: 'yes' }, phone.ctx);
    await settle();
    assert.strictEqual(phone.sync.dropped - before, 5);
    assert.strictEqual(phone.local.state(), false, 'none of them silences the phone');
    drop();
    await wait(60);
    connect();
    await settle();
    phone.bus.emit(T.STATE, { ...old, seq: 99 }, phone.ctx); // the last session's "on", in the new one
    await settle();
    assert.strictEqual(phone.local.state(), false, 'a state from the last session is not replayed into this one');
  }

  // Stop and Forget: released at once. A session that never returns: after the grace.
  {
    const { mac, phone, connect, drop } = pair();
    connect();
    mac.local.user(true);
    await settle();
    phone.sync.stop();
    await settle();
    assert.strictEqual(phone.local.state(), false, 'Stop releases it now');
    assert.deepStrictEqual(phone.local.calls, [true, false]);
    drop();
    connect();
    await settle();
    assert.strictEqual(phone.local.state(), true, '(a new session is a new start)');
    phone.sync.forget('mac-1');
    await settle();
    assert.strictEqual(phone.local.state(), false, 'Forget releases it now');
    assert.strictEqual(phone.sync.view.peerId, '', 'and the session is no longer its own');
    drop();
    connect();
    await settle();
    assert.strictEqual(phone.local.state(), true);
    drop();
    await settle();
    assert.strictEqual(phone.local.state(), true, 'a drop keeps it for the grace');
    await wait(70);
    assert.strictEqual(phone.local.state(), false, 'and no longer');
    assert.strictEqual(phone.sync.view.leased, false);
  }

  // Another device in the grace: the lease isn't its to take over.
  {
    const { mac, phone, connect, drop } = pair();
    connect();
    mac.local.user(true);
    await settle();
    drop();
    await settle();
    const n = phone.local.calls.length;
    connect('mac-2'); // paired too, but its switches are its own (off)
    phone.opts = { send: false, follow: false };
    phone.sync.refresh();
    await settle();
    assert.strictEqual(phone.local.calls[n], false, 'released as soon as another device holds the session');
    assert.strictEqual(phone.local.state(), false);
    assert.strictEqual(phone.sync.view.leased, false);
    assert.strictEqual(phone.local.calls.length, n + 1, 'and not silenced for that one');
  }
  console.log('silence-fail: no access, a failed setter, unknown states, other sessions’ messages, Stop, Forget, the grace and another device all end off');
})().catch((e) => { console.error(e); process.exit(1); });
