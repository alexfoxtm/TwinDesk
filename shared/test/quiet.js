// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Quiet links (shared/quiet.js, #143): an idle session stops pinging every second only when both ends
// say idle; an older app keeps today's pings; anything live makes it active at once, its silence limit
// counted from then; holds, the partner flag and Keep pinging keep it active.
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const Q = require('../quiet.js');

const realNow = Date.now;
let clock = 1_000_000_000_000;
Date.now = () => clock;

function sock() {
  const out = [];
  const ws = { out };
  ws.raw = (m) => out.push(m);
  return ws;
}
const run = (ws, rx, busy) => Q.tick(ws, clock, rx, ws.raw, busy);

try {
  // An older app never says idle: never quiet, whatever the time. We say idle once (it ignores it).
  Q._reset();
  {
    const ws = sock();
    let r = run(ws, clock);
    assert.equal(r.quiet, false);
    assert.equal(ws.quietReason, 'recent-wake');
    assert.equal(ws.out.length, 0, 'nothing said while busy (the default an older app assumes)');
    clock += Q.ACTIVE_MS;
    r = run(ws, clock - 500);
    assert.equal(r.quiet, false);
    assert.deepEqual(ws.out, [{ t: 'idle', on: true }]);
    assert.equal(ws.quietReason, 'peer-not-idle');
    Q.hold('kvm', true);
    clock += 1;
    run(ws, clock);
    assert.equal(ws.quietReason, 'peer-not-idle', 'reason changes are rate-limited');
    clock += 5000;
    run(ws, clock);
    assert.equal(ws.quietReason, 'kvm');
    Q.hold('kvm', false);
    run(ws, clock);
    ws.out.splice(1);
    clock += 60 * 60 * 1000;
    r = run(ws, clock - 500);
    assert.equal(r.quiet, false, 'an older peer: never quiet');
    assert.equal(ws.out.length, 1, 'said once, not every tick');
  }

  // Both idle: quiet; a ping every QUIET_PING_MS, closed after QUIET_TIMEOUT_MS of silence.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    assert.equal(Q.seen(ws, { t: 'idle', on: true }), true, '`idle` is consumed');
    clock += Q.ACTIVE_MS;
    const quietAt = clock;
    let r = run(ws, clock);
    assert.equal(r.quiet, true);
    assert.equal(r.ping, false);
    clock += Q.QUIET_PING_MS - 1000;
    r = run(ws, quietAt);
    assert.equal(r.ping, false, 'no ping before the interval');
    clock += 1000;
    r = run(ws, quietAt);
    assert.equal(r.ping, true, 'the safety ping');
    r = run(ws, quietAt);
    assert.equal(r.ping, false, 'once per interval');
    assert.equal(r.dead, false, 'minutes of silence are fine while quiet');
    clock = quietAt + Q.QUIET_TIMEOUT_MS + 1;
    r = run(ws, quietAt);
    assert.equal(r.dead, true, 'gone for good: closed');
  }

  // Messages don't wake the link (a battery level going by costs one message, not a burst of pings).
  // One sent while quiet is followed by a probe: answered, still quiet; unanswered, closed.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    let heard = clock;
    assert.equal(run(ws, heard).quiet, true);
    clock += 60 * 1000;
    Q.seen(ws, { t: 'dev.state', vol: 3 });
    assert.equal(run(ws, heard).quiet, true, 'a message in: still quiet');
    Q.sent(ws, { t: 'clip.text', text: 'x' });
    let r = run(ws, heard);
    assert.equal(r.quiet, true, 'a message out: still quiet');
    assert.equal(r.ping, true, '… with a probe');
    Q.sent(ws, { t: 'clip.text', text: 'y' });
    r = run(ws, heard);
    assert.equal(r.ping, false, 'one probe at a time');
    clock += 300;
    heard = clock; // the pong
    r = run(ws, heard);
    assert.equal(r.dead, false);
    clock += Q.PROBE_MS + 1;
    assert.equal(run(ws, heard).dead, false, 'answered: alive');
    // unanswered
    Q.sent(ws, { t: 'clip.text', text: 'z' });
    assert.equal(run(ws, heard).ping, true);
    clock += Q.PROBE_MS - 1;
    assert.equal(run(ws, heard).dead, false);
    clock += 2;
    assert.equal(run(ws, heard).dead, true, 'no answer to the probe: closed (and reconnects)');
  }

  // Leaving quiet: the silence limit counts from then, not from the last ping minutes ago.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    const heard = clock;
    assert.equal(run(ws, heard).quiet, true);
    clock += 4 * 60 * 1000;
    Q.seen(ws, { t: 'idle', on: false });
    const r = run(ws, heard);
    assert.equal(r.quiet, false, 'the other end busy: not quiet here either');
    assert.equal(r.rx, clock, 'rx raised past the quiet spell: no instant timeout');
    assert.equal(Q.seen(ws, { t: 'ping', ts: 1 }), false);
  }

  // Holds (input shared, files moving), the partner flag and Keep pinging keep it active.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    assert.equal(run(ws, clock).quiet, true);
    let changes = 0;
    Q.onChange(() => changes++);
    Q.hold('kvm', true);
    assert.equal(changes, 1, 'the timers hear of a hold at once');
    assert.equal(run(ws, clock).quiet, false);
    Q.hold('kvm', true);
    assert.equal(changes, 1, 'the same hold twice: one change');
    Q.hold('kvm', false);
    clock += 1;
    assert.equal(run(ws, clock).quiet, true);
    assert.equal(run(ws, clock, true).quiet, false, 'the input partner\'s link (multi-device)');
    Q.setKeep(true);
    assert.equal(run(ws, clock).quiet, false, 'General › Advanced › Keep pinging');
    Q.setKeep(false);
    assert.equal(run(ws, clock).quiet, true);
    Q.wake();
    assert.equal(run(ws, clock).quiet, false, 'woke: active for a while, so a dead link is found');
    clock += Q.ACTIVE_MS;
    assert.equal(run(ws, clock).quiet, true);
  }

  // use(): the app's settings, read live; a throwing getter keeps pinging (the safe side).
  Q._reset();
  {
    const settings = { app: { keepPinging: false } };
    Q.use(() => settings.app.keepPinging === true);
    assert.equal(Q.keep(), false);
    settings.app.keepPinging = true;
    assert.equal(Q.keep(), true, 'a change applies on the next tick');
    Q.use(() => { throw new Error('not loaded'); });
    assert.equal(Q.keep(), true);
  }

  // Prioritize performance and both ends idle: 3 s / 10 s, and only when the peer said perf.
  // The four combinations of the setting and "both idle". Times are literals so a mutated constant fails.
  Q._reset();
  {
    assert.equal(P.PING_MS_IDLE_PERF, 3000);
    assert.equal(P.TIMEOUT_MS_IDLE_PERF, 10000);
    const ws = sock();
    run(ws, clock);
    clock += Q.ACTIVE_MS;
    let r = run(ws, clock);
    assert.equal(r.quiet, false, 'keep off, peer not idle: the 1 s tier');
    assert.deepEqual(ws.out, [{ t: 'idle', on: true }]);

    Q.seen(ws, { t: 'idle', on: true });
    r = run(ws, clock);
    assert.equal(r.quiet, true, 'keep off, both idle, no perf: the 5 min quiet');
    const quietAt = clock;
    clock += 3000;
    assert.equal(run(ws, quietAt).ping, false, 'the 5 min quiet does not ping at 3 s');

    Q._reset();
    Q.setKeep(true);
    const held = sock();
    run(held, clock);
    Q.seen(held, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    r = run(held, clock);
    assert.equal(r.quiet, false, 'keep on, peer idle without perf: still the 1 s tier');
    assert.deepEqual(held.out, [{ t: 'idle', on: false, perf: 1 }], 'capability only; on stays false');
    clock += 3000;
    assert.equal(run(held, clock).quiet, false, 'still not the 3 s tier 3 s later');

    Q._reset();
    Q.setKeep(true);
    const perf = sock();
    run(perf, clock);
    Q.seen(perf, { t: 'idle', on: true, perf: 1, keep: 1 });
    clock += Q.ACTIVE_MS;
    const started = clock;
    r = run(perf, clock);
    assert.equal(r.quiet, true, 'keep on, both idle, peer said perf: the 3 s tier');
    assert.equal(r.ping, false, 'no ping on the tick the tier starts');
    assert.equal(r.dead, false);
    assert.deepEqual(perf.out[perf.out.length - 1], { t: 'idle', on: true, perf: 1, keep: 1 });
    clock += 2999;
    assert.equal(run(perf, started).ping, false, 'no ping before 3 s');
    clock += 1;
    assert.equal(run(perf, started).ping, true, 'idle performance: a ping every 3 s');
    clock = started + 10000;
    assert.equal(run(perf, started).dead, false, '10 s of silence is inside the limit');
    clock += 1;
    assert.equal(run(perf, started).dead, true, 'idle performance: closed after 10 s');
  }

  // A hold, a busy partner link, or idle {off} is the 1 s tier on this tick.
  Q._reset();
  {
    Q.setKeep(true);
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true, perf: 1, keep: 1 });
    clock += Q.ACTIVE_MS;
    assert.equal(run(ws, clock).quiet, true);
    const heard = clock - 9000; // would already be dead on the 8 s limit
    Q.hold('files', true);
    let r = run(ws, heard);
    assert.equal(r.quiet, false, 'a file transfer is the 1 s tier at once');
    assert.equal(r.rx, clock, 'leaving the 3 s tier raises rx, so 9 s of quiet is not an 8 s timeout');
    assert.deepEqual(ws.out[ws.out.length - 1], { t: 'idle', on: false });
    Q.hold('files', false);
    clock += 1;
    assert.equal(run(ws, clock, true).quiet, false, 'the input partner stays on the 1 s tier');
    Q.seen(ws, { t: 'idle', on: false });
    r = run(ws, heard);
    assert.equal(r.quiet, false, 'idle {off} is the 1 s tier at once');
    assert.ok(r.rx > heard, 'idle off keeps the raised baseline, not the 9 s-old silence');
  }

  // Only the other end has Prioritize performance: 3 s, not the 5 min quiet (that would outlast its 10 s).
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true, perf: 1, keep: 1 });
    clock += Q.ACTIVE_MS;
    const started = clock;
    const r = run(ws, clock);
    assert.equal(r.quiet, true, 'peer keep: the 3 s tier here too');
    assert.equal(r.ping, false);
    clock += 3000;
    assert.equal(run(ws, started).ping, true, 'peer keep: a ping at 3 s, not at 5 min');
    assert.deepEqual(ws.out[ws.out.length - 1], { t: 'idle', on: true, perf: 1 });
  }

  // Into the 3 s tier from a long quiet. The next tick is handed the old last-heard time again.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true, perf: 1 });
    clock += Q.ACTIVE_MS;
    const heard = clock;
    assert.equal(run(ws, heard).quiet, true, 'full quiet first');
    clock += 4 * 60 * 1000;
    Q.setKeep(true);
    let r = run(ws, heard);
    assert.equal(r.dead, false, 'the tick that leaves the long quiet does not trip 10 s');
    clock += 1000;
    r = run(ws, heard);
    assert.equal(r.dead, false, 'the next tick, given the old last-heard time, does not trip 10 s either');
    assert.equal(r.quiet, true);
  }

  // One side has Prioritize performance, the other does not. The keep=false side must re-announce
  // {on:true, perf:1} once it hears perf, or both stay on the 1 s tier forever.
  Q._reset();
  {
    function freshQuiet() {
      const id = require.resolve('../quiet.js');
      delete require.cache[id];
      return require('../quiet.js');
    }
    function sides(keepA, keepB) {
      const A = freshQuiet();
      const B = freshQuiet();
      A._reset();
      B._reset();
      if (keepA) A.setKeep(true);
      if (keepB) B.setKeep(true);
      const a = sock();
      const b = sock();
      A.tick(a, clock, clock, a.raw);
      B.tick(b, clock, clock, b.raw);
      clock += A.ACTIVE_MS;
      return { A, B, a, b };
    }
    function pump(A, B, a, b, rx) {
      let ia = 0;
      let ib = 0;
      let ra;
      let rb;
      for (let n = 0; n < 8; n++) {
        ra = A.tick(a, clock, rx, a.raw);
        rb = B.tick(b, clock, rx, b.raw);
        assert.equal(ra.dead, false, 'A did not time out during the handshake');
        assert.equal(rb.dead, false, 'B did not time out during the handshake');
        const fromA = a.out.slice(ia).filter((m) => m.t === 'idle');
        const fromB = b.out.slice(ib).filter((m) => m.t === 'idle');
        ia = a.out.length;
        ib = b.out.length;
        if (!fromA.length && !fromB.length) break;
        for (const m of fromA) B.seen(b, m);
        for (const m of fromB) A.seen(a, m);
      }
      return { ra, rb };
    }
    function lastIdle(ws, pred) {
      const found = ws.out.filter((m) => m.t === 'idle' && pred(m));
      assert.ok(found.length, 'expected an idle');
      return found[found.length - 1];
    }
    function assertBothOnPerf(A, B, a, b, heard) {
      const started = clock;
      const step = (at) => [A.tick(a, at, heard, a.raw), B.tick(b, at, heard, b.raw)];
      let [ra, rb] = step(started);
      assert.equal(ra.quiet, true, 'A on the 3 s tier');
      assert.equal(rb.quiet, true, 'B on the 3 s tier');
      assert.equal(ra.dead, false);
      assert.equal(rb.dead, false);
      assert.equal(ra.ping, false);
      assert.equal(rb.ping, false);
      clock = started + 2999;
      [ra, rb] = step(clock);
      assert.equal(ra.ping, false, 'A no ping before 3 s');
      assert.equal(rb.ping, false, 'B no ping before 3 s');
      clock = started + 3000;
      [ra, rb] = step(clock);
      assert.equal(ra.ping, true, 'A pings at 3 s');
      assert.equal(rb.ping, true, 'B pings at 3 s');
      assert.equal(ra.dead, false);
      assert.equal(rb.dead, false);
      clock = started + 10000;
      [ra, rb] = step(clock);
      assert.equal(ra.dead, false, 'A: 10 s of silence is inside the limit');
      assert.equal(rb.dead, false, 'B: 10 s of silence is inside the limit');
      clock = started + 10001;
      [ra, rb] = step(clock);
      assert.equal(ra.dead, true, 'A closed after 10 s');
      assert.equal(rb.dead, true, 'B closed after 10 s');
    }

    {
      const { A, B, a, b } = sides(true, false);
      const heard = clock;
      pump(A, B, a, b, heard);
      assert.deepEqual(lastIdle(a, (m) => m.keep === 1), { t: 'idle', on: true, perf: 1, keep: 1 });
      assert.deepEqual(lastIdle(b, (m) => m.on === true), { t: 'idle', on: true, perf: 1 },
        'keep=false re-announces perf once it hears it');
      assertBothOnPerf(A, B, a, b, heard);
    }

    {
      const { A, B, a, b } = sides(false, true);
      const heard = clock;
      pump(A, B, a, b, heard);
      assert.deepEqual(lastIdle(b, (m) => m.keep === 1), { t: 'idle', on: true, perf: 1, keep: 1 });
      assert.deepEqual(lastIdle(a, (m) => m.on === true), { t: 'idle', on: true, perf: 1 },
        'keep=false re-announces perf once it hears it');
      assertBothOnPerf(A, B, a, b, heard);
    }

    {
      const { A, B, a, b } = sides(false, false);
      const entered = clock;
      let r = pump(A, B, a, b, entered);
      assert.equal(r.ra.quiet, true, 'both keep off: the 5 min quiet');
      assert.equal(r.rb.quiet, true, 'both keep off: the 5 min quiet');
      clock += 4 * 60 * 1000;
      A.setKeep(true);
      r = pump(A, B, a, b, entered);
      assert.equal(r.ra.dead, false, 'turning keep on does not trip 10 s');
      assert.equal(r.rb.dead, false, 'the other side does not trip 10 s');
      assert.deepEqual(lastIdle(a, (m) => m.keep === 1), { t: 'idle', on: true, perf: 1, keep: 1 });
      assert.deepEqual(lastIdle(b, (m) => m.on === true && m.perf === 1), { t: 'idle', on: true, perf: 1 });
      assertBothOnPerf(A, B, a, b, entered);
    }

    {
      const { A, B, a, b } = sides(true, false);
      const heard = clock;
      pump(A, B, a, b, heard);
      assert.deepEqual(lastIdle(b, (m) => m.on === true), { t: 'idle', on: true, perf: 1 });
      const before = b.out.length;
      B.tick(b, clock, heard, b.raw, true);
      assert.equal(b.out.length, before + 1, 'leaving on-perf tells the peer idle is off');
      assert.deepEqual(b.out[b.out.length - 1], { t: 'idle', on: false });
    }
  }

  console.log('quiet: ok');
} finally {
  Date.now = realNow;
  Q._reset();
}
