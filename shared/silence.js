// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications silenced on one device are silenced on the other, both ways, per pair. Only
// "silenced or not" is shared: never which Focus or mode, never its name.
//
//   silence.hello {v: 1, sid, read, set, send, follow}
//     either side, at the start of a session and whenever one of them changes. sid: this side's
//     word for this session (random); read: it can tell whether it is silenced; set: it can
//     silence itself and undo that; send / follow: what its person switched on for this pair
//     (send: tell the other side; follow: do as the other side). A side that doesn't know these
//     messages never answers: nothing is shared with it.
//   silence.state {sid, to, seq, on}
//     the sender's own state, to the other side's sid: true (silenced by its person), false, or
//     null (it can't tell any more). Only while the sender sends and the receiver follows. What a
//     side silenced because the other asked is never told back as its own (no echo).
//   silence.ack   {sid, to, seq, r}
//     what the follower did with that state: applied | kept (it was silenced already, by its own
//     person) | released | overridden (its person turned it off) | refused | failed. A follower
//     that doesn't send says nothing of its own state this way either: "kept" isn't told, and
//     "overridden" is told as "released".
//
// The policy, the same on every platform (Android's is Silence.kt):
//   - Nothing happens until the person switches a direction on, on that device, for that pair.
//   - A follower silences itself only when it is not silenced: that is its lease, held for the
//     other device and that session alone. It turns off only what it holds a lease for, so a
//     Focus or Do not disturb its own person switched on is never switched off.
//   - Its person turning the silence off while the lease is held ends the lease, and the device
//     isn't silenced again until the other side has been off and on again.
//   - Unknown is off: a state that can't be read, a permission taken away, a direction switched
//     off or a message for another session (sid, to, seq) releases the lease or is dropped.
//   - A session that drops keeps the lease GRACE_MS for the same device to come back; Stop, Forget,
//     another device and quitting release it at once (Stop tells the other side, which releases
//     its own too). A lease is never taken over.
//   - A silence of ours that outlived its lease (an undo that failed or couldn't be seen, a process
//     that ended) is "stuck": never told as the person's, and undone only by a local that keeps
//     the record and sees that what is on is exactly what it turned on. Unknown is left alone.
//
// link:  on(type | 'welcome' | 'closed', fn(msg | ctx, ctx)), send(msg), current ({deviceId})
// local: this device's own way (mac/silence-mac.js; Windows and Linux need only this part):
//   caps() → {read, set}; state() → true | false | null, as last seen;
//   apply(on) → Promise<{ok, why?}>: silence this device, or undo exactly that; resolves once the
//     new state is seen (ok) or it isn't (never ok on a guess). why 'theirs': it was found
//     silenced by its own person at the last moment, and left;
//   watch(on): look for changes (off: nothing runs); on('change', fn);
//   scoped (optional): undoing can't touch a silence that isn't ours, so it's safe when unknown;
//   mine() (optional): false once the silence is no longer the one apply(true) made;
//   held() (optional): true while a silence apply(true) made is, or may still be, on. The local
//     keeps that record itself, written before it acts and kept across restarts, so what a
//     process that ended left on is found again (and, with scoped, undone once seen to be it).
// opts(deviceId) → {send, follow}: the pair's switches.   allow(ctx): which devices at all.
// Events: 'change'.
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const T = { HELLO: 'silence.hello', STATE: 'silence.state', ACK: 'silence.ack' };
const V = 1;
const GRACE_MS = 30000; // a dropped session's lease, kept for the same device to return
const APPLY_TIMEOUT_MS = 30000; // an apply that never answers counts as failed
const MAX_APPLIES = 6; // … in APPLY_WINDOW_MS: two sides that keep undoing each other stop here
const APPLY_WINDOW_MS = 60000;
const MAX_UNSTICKS = 3; // a stuck silence is undone this many times at most: after that it is the person's to turn off
const ACKS = ['applied', 'kept', 'released', 'overridden', 'refused', 'failed'];
const sidOk = (v) => typeof v === 'string' && /^[0-9a-f]{8,32}$/.test(v);

class SilenceSync extends EventEmitter {
  constructor({ link, local, opts, allow = () => true, grace = GRACE_MS, applyTimeout = APPLY_TIMEOUT_MS, now = Date.now }) {
    super();
    Object.assign(this, { link, local, opts, allow, grace, applyTimeout, now });
    this.peer = null; // the session: {id, ctx, sid, their, seq, rseq, remote, sent, hello, episode, ack}
    this.lease = null; // {id, until?}: this device is silenced for that device
    this.override = null; // the device whose silence the person here turned off (until it is off itself)
    this.forgot = null; // the device last forgotten
    this.stale = false; // a silence of ours that couldn't be undone: not told as the person's (a local without held())
    this.unsticks = 0;
    this.busy = false;
    this.applies = [];
    this.last = null; // {r, why?, at}: the last thing done here, for the page
    this.dropped = 0; // messages that weren't for this session
    this.graceTimer = null;
    this.watching = false;

    link.on('welcome', (ctx) => this._welcome(ctx));
    link.on('closed', (ctx) => this._closed(ctx));
    link.on(T.HELLO, (m, ctx) => this._hello(m || {}, ctx));
    link.on(T.STATE, (m, ctx) => this._state(m || {}, ctx));
    link.on(T.ACK, (m, ctx) => this._ack(m || {}, ctx));
    local.on('change', () => this._localChanged());
    if (this.stuck) this._sync(); // left on by the last process: looked at, and undone once seen to be ours
  }

  // ---- the session ----

  _welcome(ctx) {
    this.peer = null;
    const id = ctx && ctx.deviceId;
    if (this.lease && this.lease.id !== id) this._release('other'); // never another device's, whichever it is
    if (!id || !this.allow(ctx)) return this._sync();
    if (this.forgot === id) this.forgot = null; // paired again
    if (this.lease && !this.lease.until) this._graceStart(); // a new session without the old one's end: it has the grace to say
    this.peer = {
      id: ctx.deviceId, ctx, sid: crypto.randomBytes(8).toString('hex'), their: null,
      seq: 0, rseq: 0, remote: undefined, sent: undefined, hello: '', episode: 'idle', ack: null,
    };
    this._sync();
  }

  _closed(ctx) {
    const p = this.peer;
    if (!p || (ctx && ctx !== p.ctx && ctx.deviceId !== p.id)) return;
    if (this.link.current && this.link.current.deviceId === p.id && this.link.current !== ctx) return; // another socket of the same session went
    this.peer = null;
    if (this.lease && !this.lease.until) this._graceStart();
    this._sync();
  }

  // The session this message came in on is the one we hold.
  _mine(ctx) {
    const p = this.peer;
    if (!p) return false;
    const cur = this.link.current;
    return !!cur && cur.deviceId === p.id && (!ctx || ctx === cur);
  }

  _hello(m, ctx) {
    const p = this.peer;
    if (!this._mine(ctx) || m.v !== V || !sidOk(m.sid)) return void this.dropped++;
    const first = !p.their || p.their.sid !== m.sid;
    if (first) Object.assign(p, { rseq: 0, remote: undefined, sent: undefined, ack: null });
    p.their = { sid: m.sid, read: m.read === true, set: m.set === true, send: m.send === true, follow: m.follow === true };
    if (!p.their.send || !p.their.read) p.remote = undefined; // it tells nothing (any more): unknown
    if (first) p.hello = ''; // ours again: it may have missed the one sent before it listened
    this._sync();
  }

  _state(m, ctx) {
    const p = this.peer;
    if (!this._mine(ctx) || !p.their || m.sid !== p.their.sid || m.to !== p.sid || !Number.isInteger(m.seq) || m.seq <= p.rseq
      || !(m.on === true || m.on === false || m.on === null)) return void this.dropped++;
    p.rseq = m.seq;
    if (!p.their.send || !p.their.read) return; // it said it doesn't tell
    p.remote = m.on;
    if (m.on === false && this.override === p.id) this.override = null; // off there: the next on counts again
    this._sync();
  }

  _ack(m, ctx) {
    const p = this.peer;
    if (!this._mine(ctx) || !p.their || m.sid !== p.their.sid || m.to !== p.sid || !Number.isInteger(m.seq) || !ACKS.includes(m.r)) return void this.dropped++;
    if (m.seq !== p.seq) return; // about a state we have since replaced
    p.ack = { r: m.r, on: p.sent };
    this.emit('change');
  }

  _tell(r) {
    const p = this.peer;
    this.last = { r, at: this.now() };
    if (!p || !p.their || !p.rseq || !this._mine()) return;
    // Its own state is told only where its person switched "send" on: that it was silenced already,
    // or that its person turned the silence off, isn't the other side's to learn from an answer.
    let wire = r;
    if (!this._opts(p.id).send) {
      if (r === 'kept') return;
      if (r === 'overridden') wire = 'released';
    }
    this.link.send({ t: T.ACK, sid: p.sid, to: p.their.sid, seq: p.rseq, r: wire });
  }

  // ---- this device ----

  _localChanged() {
    const st = this.local.state();
    if (st === false) this.stale = false;
    const L = this.lease;
    if (L && !this.busy && (st === false || (st === true && typeof this.local.mine === 'function' && !this.local.mine()))) {
      // Its person turned the silence off (or made it theirs): theirs to keep, not ours to undo.
      this.lease = null;
      this._graceStop();
      this.override = L.id;
      this._tell('overridden');
    }
    this._sync();
  }

  // A silence of ours still on (or possibly on) without a lease. The local's own record where it
  // keeps one (across restarts), else what was seen here.
  get stuck() {
    return typeof this.local.held === 'function' ? !this.lease && !this.busy && !!this.local.held() : this.stale;
  }

  // Silenced by us, not by the person here: never told to the other side as this device's own.
  get ours() {
    return !!this.lease || this.busy || this.stuck;
  }

  _sync() {
    const p = this.peer;
    const o = p ? this._opts(p.id) : { send: false, follow: false };
    const watch = !!this.lease || this.stuck || (!!p && (o.send || o.follow));
    if (watch !== this.watching) {
      this.watching = watch;
      try { this.local.watch(watch); } catch (_) { /* not looked for: state() stays unknown */ }
    }
    if (p && this._mine()) {
      const c = this._caps();
      const hello = { t: T.HELLO, v: V, sid: p.sid, read: c.read, set: c.set, send: o.send, follow: o.follow };
      const k = JSON.stringify(hello);
      if (k !== p.hello) {
        p.hello = k;
        this.link.send(hello);
      }
      const th = p.their;
      // Ours, to a side that follows.
      if (p.stopped) { /* Stop: nothing more is told or followed in this session */ } else if (o.send && c.read && th && th.follow && th.set) {
        const st = this.local.state();
        const on = st === null || st === undefined ? null : st === true && !this.ours;
        if (on !== p.sent) {
          p.sent = on;
          p.ack = null;
          this.link.send({ t: T.STATE, sid: p.sid, to: th.sid, seq: ++p.seq, on });
        }
      } else p.sent = undefined;
      this._follow(p, o, c);
    }
    this._unstick();
    this.emit('change');
  }

  // Ours, left on without a lease: undone once it is seen to be exactly ours, by a local that
  // keeps the record and confirms it before it undoes anything. Never on a guess, and not for ever.
  async _unstick() {
    if (typeof this.local.held !== 'function') return;
    if (!this.local.held()) return void (this.unsticks = 0);
    if (this.lease || this.busy || !this.local.scoped || this.unsticks >= MAX_UNSTICKS || this.local.state() !== true
      || (typeof this.local.mine === 'function' && !this.local.mine())) return;
    this.unsticks++;
    this.busy = true;
    const r = await this._run(false);
    this.busy = false;
    this.last = r.ok === true ? { r: 'released', at: this.now() } : { r: 'failed', why: r.why || 'unconfirmed', at: this.now() };
    this._sync();
  }

  // Theirs, here.
  _follow(p, o, c) {
    const th = p.their;
    const can = !p.stopped && o.follow && c.set && c.read;
    const want = can && !!th && th.send && th.read && p.remote === true;
    const L = this.lease;
    if (L && L.id !== p.id) return void (this.busy || this._release('other')); // another device's: undone first
    if (!want) {
      p.episode = 'idle';
      if (!L) return;
      // Back within the grace, and it hasn't said yet: the timer decides, not this.
      if (L.until && L.id === p.id && can && p.remote === undefined) return;
      return this._release('peer');
    }
    if (L) {
      if (L.until) this._graceStop(); // the same device, the same state: the lease goes on
      p.episode = 'done';
      return;
    }
    if (p.episode !== 'idle' || this.busy) return;
    const st = this.local.state();
    if (st !== true && st !== false) return; // unknown: nothing done, asked again when it's known
    p.episode = 'done';
    if (this.override === p.id) return this._tell('overridden');
    if (st === true) { // silenced by its own person: theirs. (Or by us, stuck: not done again over it.)
      if (!this.stuck) return this._tell('kept');
      this._tell('failed');
      this.last.why = 'stuck';
      return;
    }
    this._act(true, p.id);
  }

  _release(why) {
    const L = this.lease;
    if (!L) return;
    const st = this.local.state();
    if (st === false) { // off already
      this.lease = null;
      this._graceStop();
      return this._tell('released');
    }
    if (st !== true && !this.local.scoped) { // unknown, and undoing could switch off the person's own
      this.lease = null;
      this._graceStop();
      this.stale = true;
      this.last = { r: 'failed', why: 'unknown', at: this.now() };
      return;
    }
    this._act(false, L.id);
  }

  async _act(on, id) {
    if (this.busy) return; // the one running ends in _sync, which asks again
    const t = this.now();
    this.applies = this.applies.filter((x) => t - x < APPLY_WINDOW_MS);
    if (on && this.applies.length >= MAX_APPLIES) return void (this.last = { r: 'failed', why: 'flapping', at: t });
    this.applies.push(t);
    this.busy = true;
    const r = await this._run(on);
    this.busy = false;
    const st = this.local.state();
    if (on) {
      if (r.ok === true && st === true) {
        this.lease = { id };
        this._tell('applied');
      } else if (r.why === 'theirs') {
        this._tell('kept'); // its own person silenced it meanwhile: theirs, and nothing of ours is on
      } else {
        this._tell('failed');
        this.last.why = r.why || 'unconfirmed';
        if (st === true) this.stale = true; // it came on after all, late: still not the person's
      }
    } else {
      this.lease = null;
      this._graceStop();
      if (r.ok === true) this._tell('released');
      else {
        this._tell('failed');
        this.last.why = r.why || 'unconfirmed';
        if (st !== false) this.stale = true;
      }
    }
    if (!this.peer && this.lease) { // the session went meanwhile
      if (this.forgot === this.lease.id) this._release('forget');
      else this._graceStart();
    }
    this._sync();
  }

  // The local's apply, which may throw or never answer: always {ok, why?}.
  _run(on) {
    let timer;
    return Promise.race([
      Promise.resolve().then(() => this.local.apply(on)),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), this.applyTimeout); }),
    ]).catch((e) => ({ ok: false, why: (e && e.message) || 'error' })).then((r) => {
      clearTimeout(timer);
      return r && typeof r === 'object' ? r : { ok: false };
    });
  }

  _graceStart() {
    if (!this.lease) return;
    this._graceStop();
    if (!(this.grace > 0)) return this._release('closed');
    this.lease.until = this.now() + this.grace;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.lease) { delete this.lease.until; this._release('grace'); this._sync(); }
    }, this.grace);
    if (this.graceTimer.unref) this.graceTimer.unref();
  }

  _graceStop() {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.lease) delete this.lease.until;
  }

  _opts(id) {
    let o = null;
    try { o = this.opts(id); } catch (_) { /* none */ }
    return { send: !!(o && o.send === true), follow: !!(o && o.follow === true) };
  }

  _caps() {
    let c = null;
    try { c = this.local.caps(); } catch (_) { /* none */ }
    const read = !!(c && c.read === true);
    return { read, set: read && !!(c && c.set === true) }; // nothing is set that can't be seen
  }

  // ---- from the app ----

  // A switch, a permission or a shortcut changed.
  refresh() {
    this._sync();
  }

  // Stop (the person disconnected) and quitting: the lease ends now, not after the grace.
  stop() {
    const p = this.peer;
    if (p && !p.stopped) {
      p.stopped = true;
      // The other side's lease for us ends too: told now, so it doesn't wait out the grace.
      if (p.their && typeof p.sent === 'boolean' && this._mine()) this.link.send({ t: T.STATE, sid: p.sid, to: p.their.sid, seq: ++p.seq, on: null });
      p.sent = undefined;
    }
    this._graceStop();
    if (this.lease) this._release('stop');
    this._sync();
  }

  // The pairing was forgotten: nothing of that device's is kept.
  forget(id) {
    this.forgot = id; // … nor a lease an apply still running would take for it
    if (this.override === id) this.override = null;
    if (this.lease && this.lease.id === id) { this._graceStop(); this._release('forget'); }
    if (this.peer && this.peer.id === id) this.peer = null;
    this._sync();
  }

  get view() {
    const p = this.peer;
    const o = p ? this._opts(p.id) : { send: false, follow: false };
    const th = p && p.their;
    return {
      peerId: p ? p.id : '',
      send: o.send, follow: o.follow, can: this._caps(),
      state: this.watching ? this.local.state() : null, // whether this device is silenced, while looked at
      peer: th ? { read: th.read, set: th.set, send: th.send, follow: th.follow } : null, // null: it doesn't know these messages (yet)
      remote: p && th && th.send && th.read && o.follow && typeof p.remote === 'boolean' ? p.remote : null,
      ack: p && p.ack ? p.ack : null,
      leased: !!this.lease, stale: this.stuck, overridden: !!p && this.override === p.id,
      last: this.last,
    };
  }
}

module.exports = { SilenceSync, T, V, GRACE_MS, ACKS };
