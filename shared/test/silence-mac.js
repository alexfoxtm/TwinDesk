// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/silence-mac.js under shared/silence.js, on a Mac that is only pretended (no shortcut is run):
// nothing is said or done until the person's check has shown, on this Mac, that the probe reads no
// Focus, a Focus of their own, and the Focus the two shortcuts turn on and off. Then the phone's
// silence turns that Focus on and off, the person's own Focus is told to the phone, and a Focus
// left on by a process that ended is found at the next start and turned off.
// Run with: node shared/test/silence-mac.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SilenceSync, T } = require('../silence.js');
const { MacSilence, parseProbe } = require('../../mac/silence-mac.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ON = 'AAAAAAAA-0000-4000-8000-000000000001';
const OFF = 'AAAAAAAA-0000-4000-8000-000000000002';
const PROBE = 'AAAAAAAA-0000-4000-8000-000000000003';

// The Mac: one Focus on at a time. Its shortcuts are the bluntest there could be: "on" turns
// TwinDesk's Focus on over anything, "off" turns off whatever is on.
function fakeMac() {
  const m = { focus: '', ran: [], settings: { on: null, off: null, probe: null, dedicated: false, proof: null, held: null } };
  m.run = async (cmd, args) => {
    if (args[0] === 'list') return { ok: true, out: `On (${ON})\nOff (${OFF})\nProbe (${PROBE})\n` };
    m.ran.push(args[1] === ON ? 'on' : 'off');
    m.focus = args[1] === ON ? 'TwinDesk' : '';
    return { ok: true, out: '' };
  };
  m.probe = async () => ({ ok: true, out: m.focus ? `twindesk-focus on ${m.focus}\n` : 'twindesk-focus off\n' });
  m.make = () => new MacSilence({ cfg: () => m.settings, save: () => {}, run: m.run, probe: m.probe, seenMs: 60, lookMs: 5, pollMs: 20 });
  return m;
}

// This Mac's end of a session with a phone that sends and follows.
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
  assert.deepStrictEqual(parseProbe('twindesk-focus on Do Not Disturb\n'), { on: true, name: 'Do Not Disturb' });
  assert.deepStrictEqual(parseProbe('twindesk-focus off'), { on: false });

  const m = fakeMac();
  const mac = m.make();
  await mac.loadShortcuts();
  mac.pick('probe', PROBE);
  mac.pick('on', ON);
  mac.pick('off', OFF);
  mac.setDedicated(true);
  assert.deepStrictEqual(mac.caps(), { read: false, set: false }, 'picked isn’t checked: nothing is said to be possible');
  assert.deepStrictEqual(m.ran, [], 'and no shortcut is run before the person’s click');

  // The check, with no Focus on: the probe reads "off", the pair is seen to turn a Focus on and off.
  await mac.check();
  assert.deepStrictEqual(m.ran, ['on', 'off']);
  assert.deepStrictEqual(mac.view.seen, { none: true, other: false, pair: true });
  assert.deepStrictEqual(mac.caps(), { read: false, set: false }, 'a Focus of the person’s own hasn’t been seen read yet');
  // … and with one of their own on: read, never touched.
  m.focus = 'Work';
  await mac.check();
  assert.strictEqual(mac.view.fail, '');
  assert.deepStrictEqual(mac.caps(), { read: true, set: true });
  assert.deepStrictEqual(m.ran, ['on', 'off'], 'the person’s Focus was only read');
  assert.strictEqual(m.focus, 'Work');
  assert.ok(!/Work|TwinDesk/.test(JSON.stringify(mac.view)), 'no Focus’s name leaves silence-mac.js');
  m.focus = '';

  // The phone's silence here: our Focus on, and off again; never told back as this Mac's own.
  const s = session(mac, { send: true, follow: true });
  s.connect();
  await wait(60);
  s.phone(true);
  await wait(120);
  assert.strictEqual(m.focus, 'TwinDesk');
  assert.strictEqual(s.sync.view.leased, true);
  assert.strictEqual(m.settings.held.name, 'TwinDesk', 'what was turned on is on record');
  mac.pick('probe', '');
  mac.pick('off', '');
  mac.setDedicated(false);
  assert.strictEqual(m.settings.probe.id, PROBE, 'setup cannot invalidate release while a Focus is held');
  assert.strictEqual(m.settings.off.id, OFF);
  assert.strictEqual(m.settings.dedicated, true);
  assert.ok(s.sent.some((x) => x.t === T.ACK && x.r === 'applied'));
  assert.ok(!s.sent.some((x) => x.t === T.STATE && x.on === true), 'no echo');
  s.phone(false);
  await wait(120);
  assert.strictEqual(m.focus, '');
  assert.strictEqual(m.settings.held, null);
  assert.strictEqual(s.sync.view.leased, false);

  // The person's own Focus is told to the phone, and nothing is run for it.
  const ran = m.ran.length;
  m.focus = 'Work';
  await wait(80);
  assert.ok(s.sent.some((x) => x.t === T.STATE && x.on === true), 'this Mac’s own Focus silences the phone');
  assert.strictEqual(m.ran.length, ran);
  m.focus = '';
  await wait(80);

  // The process ends while our Focus is on: found at the next start, seen to be ours, turned off.
  s.phone(true);
  await wait(120);
  assert.strictEqual(m.focus, 'TwinDesk');
  mac.watch(false); // (the old process is gone)
  const next = m.make();
  const s2 = session(next, { send: true, follow: true });
  assert.strictEqual(s2.sync.view.stale, true, 'known at once, from the record');
  await wait(200);
  assert.strictEqual(m.focus, '', 'the Focus the last process left on is turned off');
  assert.strictEqual(m.settings.held, null);
  assert.strictEqual(s2.sync.view.stale, false);
  next.watch(false);
  m.focus = '';
  assert.deepStrictEqual(await next.apply(true), { ok: true });
  await next.close();
  assert.strictEqual(m.focus, '', 'quit waits for its own Focus to be released');
  assert.strictEqual(m.settings.held, null);
  console.log('silence-mac: nothing until checked on this Mac, then our own Focus on and off with the phone, the person’s told and never run over, and a Focus left on found and turned off');
})().catch((e) => { console.error(e); process.exit(1); });
