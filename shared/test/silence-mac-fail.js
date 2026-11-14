// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/silence-mac.js when it can't be sure, on a Mac that is only pretended: it does nothing.
// An unchecked setup says and does nothing; a probe that doesn't answer as asked proves nothing;
// a Focus of the person's own is never turned on over, nor turned off (even by an "off" shortcut
// that would turn anything off); a probe that stops answering leaves our Focus on rather than
// run "off" blind, across a restart too, until it is seen to be ours; an "on" shortcut that turns
// on another Focus than the one checked is left alone and the setup is unchecked again; and a
// follower that doesn't send tells nothing of its own state in its answers.
// Run with: node shared/test/silence-mac-fail.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SilenceSync, T } = require('../silence.js');
const { MacSilence } = require('../../mac/silence-mac.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ON = 'AAAAAAAA-0000-4000-8000-000000000001';
const OFF = 'AAAAAAAA-0000-4000-8000-000000000002';
const PROBE = 'AAAAAAAA-0000-4000-8000-000000000003';

function fakeMac() {
  const m = { focus: '', sets: 'TwinDesk', answers: true, ran: [], settings: { on: null, off: null, probe: null, dedicated: false, proof: null, held: null } };
  m.run = async (cmd, args) => {
    if (args[0] === 'list') return { ok: true, out: `On (${ON})\nOff (${OFF})\nProbe (${PROBE})\n` };
    m.ran.push(args[1] === ON ? 'on' : 'off');
    m.focus = args[1] === ON ? m.sets : ''; // "off" turns off whatever is on
    return { ok: true, out: '' };
  };
  m.probe = async () => (m.answers ? { ok: true, out: m.focus ? `twindesk-focus on ${m.focus}\n` : 'twindesk-focus off\n' } : { ok: false, out: '' });
  m.make = () => new MacSilence({ cfg: () => m.settings, save: () => {}, run: m.run, probe: m.probe, seenMs: 60, lookMs: 5, pollMs: 20 });
  // Picked and, unless told not to, checked: with no Focus, then with one of the person's own.
  m.ready = async (check = true) => {
    const mac = m.make();
    await mac.loadShortcuts();
    for (const [w, id] of [['probe', PROBE], ['on', ON], ['off', OFF]]) mac.pick(w, id);
    mac.setDedicated(true);
    if (check) {
      await mac.check();
      m.focus = 'Work';
      await mac.check();
      m.focus = '';
      assert.deepStrictEqual(mac.caps(), { read: true, set: true });
    }
    m.ran.length = 0;
    return mac;
  };
  return m;
}

function session(mac, opts) {
  const bus = new EventEmitter();
  const ctx = { deviceId: 'phone-1' };
  const sent = [];
  const sync = new SilenceSync({ link: { on: (t, fn) => bus.on(t, fn), send: (x) => sent.push(x), current: ctx }, local: mac, opts: () => opts, grace: 40 });
  const sid = 'feedfacefeedface';
  let seq = 0;
  return {
    sync, sent,
    connect() { bus.emit('welcome', ctx); bus.emit(T.HELLO, { v: 1, sid, read: true, set: true, send: true, follow: true }, ctx); },
    phone(on) { bus.emit(T.STATE, { sid, to: sent.filter((x) => x.t === T.HELLO).pop().sid, seq: ++seq, on }, ctx); },
  };
}

(async () => {
  // Setup uses the same recovery record as normal use, even before the pair is proven.
  {
    const m = fakeMac();
    const run = m.run;
    let failOff = true;
    m.run = async (cmd, args) => {
      if (args[0] === 'run' && args[1] === ON) assert.ok(m.settings.held, 'recorded before the test can turn anything on');
      if (args[0] === 'run' && args[1] === OFF && failOff) return { ok: false, out: '' };
      return run(cmd, args);
    };
    const mac = await m.ready(false);
    await mac.check();
    assert.strictEqual(mac.view.fail, 'off');
    assert.strictEqual(m.settings.held.name, 'TwinDesk', 'failed setup release survives process exit');
    mac.pick('off', '');
    assert.strictEqual(m.settings.off.id, OFF, 'the recovery shortcut cannot be changed while held');
    failOff = false;
    const next = m.make();
    await next.loadShortcuts();
    await next.close();
    assert.strictEqual(m.focus, '', 'next process releases only the Focus identified by the check');
    assert.strictEqual(m.settings.held, null);
  }

  // Picked but never checked: neither way is offered, and no shortcut is run.
  {
    const m = fakeMac();
    const mac = await m.ready(false);
    const s = session(mac, { send: true, follow: true });
    s.connect();
    await wait(60);
    s.phone(true);
    m.focus = 'Work';
    await wait(100);
    const hello = s.sent.filter((x) => x.t === T.HELLO).pop();
    assert.deepStrictEqual([hello.read, hello.set], [false, false], 'unproven: not advertised');
    assert.deepStrictEqual(m.ran, [], 'and nothing is run');
    assert.ok(!s.sent.some((x) => x.t === T.STATE), 'nor is an unproven reading told');
    mac.watch(false);
  }

  // A probe that answers something else (the Focus's bare name): nothing is proven by it.
  {
    const m = fakeMac();
    m.probe = async () => ({ ok: true, out: 'Work\n' });
    const mac = await m.ready(false);
    await mac.check();
    assert.strictEqual(mac.view.fail, 'output');
    assert.deepStrictEqual(mac.caps(), { read: false, set: false });
    assert.deepStrictEqual(m.ran, [], 'the two shortcuts aren’t run when the Focus can’t be read');
  }

  // The person's own Focus is on when the phone asks: not turned on over, not turned off after.
  // This Mac follows without sending, so its answer doesn't say it was silenced already.
  {
    const m = fakeMac();
    const mac = await m.ready();
    m.focus = 'Work';
    const s = session(mac, { send: false, follow: true });
    s.connect();
    await wait(60);
    s.phone(true);
    await wait(100);
    s.phone(false);
    await wait(100);
    assert.deepStrictEqual(m.ran, [], 'neither shortcut is run over the person’s Focus');
    assert.strictEqual(m.focus, 'Work');
    assert.strictEqual(s.sync.view.last.r, 'kept', '(known here as kept)');
    assert.ok(!s.sent.some((x) => x.t === T.ACK && x.r === 'kept'), 'but not told: "send" is off here');
    mac.watch(false);
  }

  // Ours is on for the phone, then the person switches to a Focus of their own: theirs from then on.
  {
    const m = fakeMac();
    const mac = await m.ready();
    const s = session(mac, { send: true, follow: true });
    s.connect();
    await wait(60);
    s.phone(true);
    await wait(120);
    assert.strictEqual(s.sync.view.leased, true);
    m.focus = 'Work';
    await wait(80);
    assert.strictEqual(s.sync.view.leased, false);
    assert.strictEqual(m.settings.held, null, 'nothing of ours is on any more');
    s.phone(false);
    await wait(100);
    assert.deepStrictEqual(m.ran, ['on'], 'the off shortcut is never run over the person’s Focus');
    assert.strictEqual(m.focus, 'Work');
    mac.watch(false);
  }

  // The probe stops answering while ours is on: "off" isn't run blind, now or after a restart;
  // it is once the probe names our Focus again.
  {
    const m = fakeMac();
    const mac = await m.ready();
    const s = session(mac, { send: true, follow: true });
    s.connect();
    await wait(60);
    s.phone(true);
    await wait(120);
    m.answers = false;
    await wait(50);
    s.phone(false);
    await wait(150);
    assert.deepStrictEqual(m.ran, ['on'], 'unknown: no off');
    assert.strictEqual(s.sync.view.stale, true, 'the page says it was left on');
    assert.ok(m.settings.held, 'and it stays on record');
    mac.watch(false);
    const next = m.make(); // the next start, the probe still silent
    const s2 = session(next, { send: true, follow: true });
    await wait(150);
    assert.deepStrictEqual(m.ran, ['on'], 'still no off');
    assert.strictEqual(s2.sync.view.stale, true);
    m.answers = true;
    await wait(200);
    assert.deepStrictEqual(m.ran, ['on', 'off'], 'seen to be ours: turned off, once');
    assert.strictEqual(m.focus, '');
    assert.strictEqual(m.settings.held, null);
    next.watch(false);
  }

  // The "on" shortcut no longer turns on the Focus it was checked with: what came on isn't ours.
  {
    const m = fakeMac();
    const mac = await m.ready();
    m.sets = 'Sleep';
    const s = session(mac, { send: true, follow: true });
    s.connect();
    await wait(60);
    s.phone(true);
    await wait(150);
    assert.deepStrictEqual(m.ran, ['on'], 'no off for a Focus that isn’t the one checked');
    assert.strictEqual(m.focus, 'Sleep');
    assert.strictEqual(s.sync.view.leased, false);
    assert.strictEqual(m.settings.held, null);
    assert.strictEqual(mac.view.fail, 'other', 'the page says to turn it off and check again');
    assert.strictEqual(mac.caps().set, false, 'and the setup is unchecked again');
    mac.watch(false);
  }
  console.log('silence-mac-fail: unchecked, unreadable, the person’s own Focus, a silent probe, a restart and a changed shortcut all leave the person’s Focus alone and run no off blind');
})().catch((e) => { console.error(e); process.exit(1); });
