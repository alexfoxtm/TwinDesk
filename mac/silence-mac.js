// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This Mac's part of Notifications › Silence together (shared/silence.js): whether a Focus is on,
// and turning one on and off. macOS gives an app neither:
//   - INFocusStatusCenter answers only an app with the Communication Notifications entitlement (a
//     provisioning profile, which TwinDesk's builds don't have): without it macOS says "allowed"
//     and then "no Focus" whatever the Mac is doing. With it, a Focus that doesn't share its
//     status is still left out, so a Focus of the person's own would be turned on over and then
//     off. It isn't used, and its private files aren't read.
//   - nothing sets a Focus.
// What there is: the person's own shortcuts, run with /usr/bin/shortcuts by identifier, as
// arguments (no shell). Three, picked on the page:
//   probe   says what is on (Shortcuts' Get Current Focus, macOS 13+). Apple documents the action
//           but not what it puts out, so its whole output must be exactly one of
//             twindesk-focus off
//             twindesk-focus on <the Focus's name>
//           An error, no output or anything else is "unknown", and unknown does nothing.
//   on/off  turn one Focus on and off: one the person made for TwinDesk alone and says so
//           (dedicated). A Focus they use themselves couldn't be told from theirs.
// Nothing is believed until the person checks it here, on this Mac (check()):
//   read  the probe was seen to say "off", and to name a Focus of the person's own (not ours);
//   set   … and, from "off", the on shortcut was seen to turn on a Focus (its name is then ours),
//         and the off shortcut to turn it off again.
// Another shortcut picked is checked again. Until then caps() says neither, so nothing is told or
// followed. Then, each time:
//   on   only from a probe that says "off" just before (a Focus that is on is the person's: left);
//        the record `held` is saved before the shortcut runs, and it counts only once the probe
//        names our Focus. A different Focus afterwards isn't ours: left on, and the set is
//        unchecked again.
//   off  only when the probe names exactly our Focus just before. Another Focus, none, or unknown:
//        the off shortcut isn't run.
// `held` outlives the process: what was left on is found at the next start and undone the same
// way (shared/silence.js's "stuck"), never when the probe can't say it is ours.
// macOS has no event for a Focus either: the probe runs every POLL_MS, only while watched.
//
// cfg() → settings.silence {on, off, probe: {id, name} | null, dedicated, proof, held}; save().
// The Focus's name stays on this Mac (settings, to know ours again): it is never sent or shown.
// Events: 'change'.
'use strict';

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHORTCUTS = '/usr/bin/shortcuts';
const UUID = /^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;
const RUN_TIMEOUT_MS = 15000; // a shortcut that takes longer isn't one that only reads or sets a Focus
const SEEN_MS = 6000; // the probe says the Focus changed within this, or the run did nothing we can claim
const LOOK_MS = 500;
const POLL_MS = 15000;
const WHICH = ['on', 'off', 'probe'];

const exec = (cmd, args, timeout) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, out) => resolve({ ok: !err, out: String(out || '') }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (name) => crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 16); // a Focus of the person's, known again without its name

// `shortcuts list --show-identifiers`: "Name (UUID)" a line.
function parseList(out) {
  const list = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^(.*) \(([0-9A-Fa-f-]{36})\)\s*$/.exec(line);
    if (m && UUID.test(m[2]) && m[1].trim()) list.push({ id: m[2].toUpperCase(), name: m[1].trim().slice(0, 200) });
  }
  return list.slice(0, 500);
}

// The probe's whole output → {on: false} | {on: true, name} | null (not the answer asked for).
function parseProbe(out) {
  const s = String(out == null ? '' : out).replace(/^﻿/, '').replace(/\s+$/, '');
  if (s === 'twindesk-focus off') return { on: false };
  const m = /^twindesk-focus on (\S[^\r\n]{0,99})$/.exec(s);
  return m ? { on: true, name: m[1] } : null;
}

// Runs the probe. Its output goes to a file of ours (--output-path), read and removed.
async function probeOutput(id) {
  let dir = '';
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'twindesk-focus-'));
    const file = path.join(dir, 'out.txt');
    const r = await exec(SHORTCUTS, ['run', id, '--output-path', file], RUN_TIMEOUT_MS);
    if (!r.ok) return { ok: false, out: '' };
    return { ok: true, out: (await fs.promises.readFile(file, 'utf8')).slice(0, 4096) };
  } catch (_) {
    return { ok: false, out: '' }; // no output written: unknown
  } finally {
    if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

class MacSilence extends EventEmitter {
  constructor({ cfg, save, run = exec, probe = probeOutput, seenMs = SEEN_MS, lookMs = LOOK_MS, pollMs = POLL_MS, now = Date.now }) {
    super();
    Object.assign(this, { cfg, save, run, probe, seenMs, lookMs, pollMs, now });
    this.scoped = true; // apply(false) undoes only a Focus the probe names as ours: safe to ask whatever is known
    this.focus = null; // the probe's last answer {on, name?} (null: unknown), while watched
    this.list = null; // this Mac's shortcuts [{id, name}] (null: not looked at)
    this.watching = false;
    this.timer = null;
    this.polling = false;
    this.q = Promise.resolve(); // one shortcut at a time
    this.checking = false;
    this.applying = 0;
    this.closing = false;
    this.fail = ''; // why the last check, or the last turn on, stopped (for the page)
    if (WHICH.some((w) => this._picked(w))) this.loadShortcuts(); // set up before: still there?
  }

  _serial(fn) {
    const p = this.q.then(fn);
    this.q = p.then(() => {}, () => {});
    return p;
  }

  _picked(which) {
    const p = (this.cfg() || {})[which];
    return p && typeof p.id === 'string' && UUID.test(p.id) ? p : null;
  }

  _id(which) {
    const p = this._picked(which);
    return p ? p.id.toUpperCase() : '';
  }

  // Picked, and still among this Mac's shortcuts.
  _has(which) {
    const id = this._id(which);
    return !!id && !!this.list && this.list.some((x) => x.id === id);
  }

  // What the check showed, for the probe picked now.
  _proof() {
    const p = (this.cfg() || {}).proof;
    return p && typeof p === 'object' && this._has('probe') && p.probe === this._id('probe') ? p : null;
  }

  _reads() {
    const p = this._proof();
    return !!p && p.none === true && typeof p.other === 'string' && !!p.other && (!p.name || p.other !== tag(p.name));
  }

  _sets() {
    const p = this._proof();
    return this._reads() && (this.cfg() || {}).dedicated === true && this._has('on') && this._has('off')
      && p.on === this._id('on') && p.off === this._id('off') && typeof p.name === 'string' && !!p.name;
  }

  // The probe, once: {on, name?} | null. Nothing here is kept.
  async _read() {
    if (!this._has('probe')) return null;
    let r = null;
    try { r = await this.probe(this._id('probe')); } catch (_) { /* unknown */ }
    return r && r.ok === true ? parseProbe(r.out) : null;
  }

  // … and kept as this Mac's state.
  async _probe() {
    const f = await this._read();
    const was = this.focus;
    this.focus = f;
    if (!was !== !f || (f && (was.on !== f.on || was.name !== f.name))) this.emit('change');
    return f;
  }

  // Asked until `done` says so or the time is up: the last answer.
  async _until(done, read = () => this._probe()) {
    const end = this.now() + this.seenMs;
    for (;;) {
      const f = await read();
      if (done(f) || this.now() >= end) return f;
      await sleep(this.lookMs);
    }
  }

  // A definite answer that isn't our Focus: nothing of ours is on any more.
  _settle(f) {
    const c = this.cfg();
    const h = c && c.held;
    if (!f || !h || (f.on && (!h.name || f.name === h.name))) return;
    c.held = null;
    this.save();
    this.emit('change');
  }

  _poll() {
    if (this.polling) return;
    this.polling = true;
    this._serial(async () => {
      this.polling = false;
      if (this.watching) this._settle(await this._probe());
    });
  }

  // ---- shared/silence.js's local ----

  caps() {
    return { read: this._reads(), set: this._sets() };
  }

  state() {
    return this.watching && this.focus ? this.focus.on : null;
  }

  held() {
    return !!(this.cfg() || {}).held;
  }

  mine() {
    const h = (this.cfg() || {}).held;
    return !!h && !!this.focus && this.focus.on === true && this.focus.name === h.name;
  }

  watch(on) {
    this.watching = !!on;
    clearInterval(this.timer);
    this.timer = null;
    if (!this.watching) return void (this.focus = null);
    this.timer = setInterval(() => this._poll(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
    this._poll();
  }

  apply(on) {
    this.applying++;
    return this._serial(() => (on ? this._on() : this._off())).finally(() => { this.applying--; });
  }

  close() {
    this.closing = true;
    this.watch(false);
    return this._serial(() => this._off());
  }

  async _on() {
    const c = this.cfg();
    if (this.closing || !c || !this._sets()) return { ok: false, why: 'setup' };
    if (c.held) return { ok: false, why: 'held' }; // ours from before may still be on: undone first
    const name = c.proof.name;
    let f = await this._probe();
    if (!f) return { ok: false, why: 'unknown' };
    if (f.on) return { ok: false, why: 'theirs' }; // a Focus is on: the person's, never turned on over
    c.held = { name, at: this.now() }; // before it runs: found again whatever happens next
    this.save();
    const r = await this.run(SHORTCUTS, ['run', this._id('on')], RUN_TIMEOUT_MS);
    f = await this._until((x) => !!x && x.on);
    if (f && f.on && f.name === name) return { ok: true };
    if (!f) return { ok: false, why: 'unknown' }; // it may be on: `held` stays, undone once the probe names it
    c.held = null;
    let why = r.ok ? 'unconfirmed' : 'shortcut';
    if (f.on) { // another Focus: not ours to turn off, and the shortcut is no longer the one checked
      Object.assign(c.proof, { on: null, off: null, name: null });
      why = 'other';
    }
    this.fail = why === 'unconfirmed' ? 'on' : why;
    this.save();
    if (!r.ok) this.loadShortcuts(); // deleted or renamed away: the page says so
    return { ok: false, why };
  }

  async _off() {
    const c = this.cfg();
    const h = c && c.held;
    if (!h) return { ok: true }; // nothing of ours is on
    const gone = (x) => !!x && !(x.on && x.name === h.name);
    let f = await this._probe();
    if (!f) return { ok: false, why: 'unknown' }; // can't be seen to be ours: nothing is run
    if (f.on && !h.name) return { ok: false, why: 'unknown' }; // a check ended before it could identify what came on
    if (!gone(f)) {
      const checked = this._sets() && c.proof.name === h.name;
      const checking = h.checking === true && c.dedicated === true && this._has('off')
        && h.off === this._id('off') && h.probe === this._id('probe');
      if (!checked && !checking) return { ok: false, why: 'setup' };
      const r = await this.run(SHORTCUTS, ['run', this._id('off')], RUN_TIMEOUT_MS);
      f = await this._until(gone);
      if (!gone(f)) {
        if (!r.ok) this.loadShortcuts();
        return { ok: false, why: !f ? 'unknown' : r.ok ? 'unconfirmed' : 'shortcut' };
      }
    }
    c.held = null; // ours is off; a Focus on now is the person's
    this.save();
    return { ok: true };
  }

  // ---- the page ----

  async loadShortcuts() {
    const r = await this.run(SHORTCUTS, ['list', '--show-identifiers'], RUN_TIMEOUT_MS);
    this.list = r.ok ? parseList(r.out) : [];
    this.emit('change');
    if (this.watching) this._poll();
  }

  // which: 'on' | 'off' | 'probe'; id: one of the list's ('' = none). Another shortcut is checked again.
  pick(which, id) {
    const c = this.cfg();
    if (!c || this.held() || this.checking || this.applying || this.closing || !WHICH.includes(which)) return;
    const found = (this.list || []).find((x) => x.id === String(id || '').toUpperCase());
    if ((found ? found.id : '') === this._id(which)) return;
    c[which] = found ? { id: found.id, name: found.name } : null;
    if (which === 'probe') c.proof = null;
    else this._unpair(c);
    this.fail = '';
    this.save();
    this.emit('change');
  }

  _unpair(c) {
    c.dedicated = false;
    if (c.proof && typeof c.proof === 'object') Object.assign(c.proof, { on: null, off: null, name: null });
  }

  // The person's word that the two shortcuts set a Focus made for TwinDesk alone.
  setDedicated(on) {
    const c = this.cfg();
    if (!c || this.held() || this.checking || this.applying || this.closing || (c.dedicated === true) === (on === true)) return;
    if (on === true) c.dedicated = true;
    else this._unpair(c);
    this.save();
    this.emit('change');
  }

  // The person's click. Each step counts only as the probe shows it.
  check() {
    if (this.checking || this.applying || this.closing) return this.q;
    this.checking = true;
    this.fail = '';
    this.emit('change');
    return this._serial(async () => {
      let fail = 'output';
      try { fail = await this._check(); } catch (_) { /* as unknown */ }
      this.fail = fail;
      this.checking = false;
      this.save();
      if (this.watching) await this._probe();
      this.emit('change');
    });
  }

  // '' or why it stopped: probe | held | output | on | off | unseen | shortcut.
  async _check() {
    await this.loadShortcuts();
    if (this.closing) return 'held';
    const c = this.cfg();
    if (!c || !this._has('probe')) return 'probe';
    if (c.held) return 'held';
    const pid = this._id('probe');
    if (!c.proof || typeof c.proof !== 'object' || c.proof.probe !== pid) c.proof = { probe: pid, none: false, other: '', on: null, off: null, name: null };
    const p = c.proof;
    const read = () => this._read(); // not this Mac's state meanwhile: a Focus turned on to check isn't told to the phone
    let f = await read();
    if (!f) return 'output';
    if (f.on) { // a Focus of the person's own, seen (ours, turned on by hand, isn't one)
      if (f.name !== p.name) p.other = tag(f.name);
      return '';
    }
    p.none = true;
    const on = this._id('on');
    const off = this._id('off');
    if (c.dedicated !== true || !this._has('on') || !this._has('off') || (p.on === on && p.off === off && p.name)) return '';
    Object.assign(p, { on: null, off: null, name: null });
    c.held = { name: null, at: this.now(), checking: true, probe: pid, off };
    this.save(); // before the first test run too: a crash must leave a visible recovery record
    const r = await this.run(SHORTCUTS, ['run', on], RUN_TIMEOUT_MS);
    f = await this._until((x) => !!x && x.on, read);
    if (!f) return 'unseen'; // it ran and can't be seen: nothing is run blind after it
    if (!f.on) { c.held = null; this.save(); return r.ok ? 'on' : 'shortcut'; }
    const name = f.name;
    c.held.name = name;
    this.save(); // only this observed Focus can be undone, now or after a restart
    await this.run(SHORTCUTS, ['run', off], RUN_TIMEOUT_MS);
    f = await this._until((x) => !!x && (!x.on || x.name !== name), read);
    if (!f) return 'unseen';
    if (f.on && f.name === name) return 'off';
    c.held = null;
    this.save();
    if (f.on) return 'other';
    Object.assign(p, { on, off, name });
    return '';
  }

  get view() {
    const pk = (w) => {
      const x = this._picked(w);
      return x ? { id: x.id.toUpperCase(), name: String(x.name || '').slice(0, 200), missing: !!this.list && !this._has(w) } : null;
    };
    const p = this._proof();
    return {
      shortcuts: this.list, on: pk('on'), off: pk('off'), probe: pk('probe'),
      dedicated: (this.cfg() || {}).dedicated === true,
      // what the check has shown so far: no Focus read; a Focus of the person's read; the pair turned ours on and off
      seen: { none: !!p && p.none === true, other: !!p && !!p.other && (!p.name || p.other !== tag(p.name)), pair: !!p && !!p.name && p.on === this._id('on') && p.off === this._id('off') },
      reads: this._reads(), sets: this._sets(), held: this.held(), checking: this.checking, fail: this.fail,
    };
  }
}

module.exports = { MacSilence, parseList, parseProbe };
