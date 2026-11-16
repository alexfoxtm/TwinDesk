// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Previous/next macOS desktop on the display a viewer is being shown.
// Run with: node shared/test/mac-spaces.js
// The helper is a fake. This does not switch a desktop on this Mac.
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const S = require('../mac-spaces.js');
const { SpaceSwitch } = require('../../mac/space-switch.js');

const SEPARATE = {
  spans: false,
  composed: true,
  ax: true,
  displays: [
    { uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11', '12'] },
    { uuid: 'BBB', cgId: 2, current: '20', spaces: ['20', '21'] },
  ],
};

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(fn) {
  for (let i = 0; i < 40; i++) {
    if (fn()) return;
    await tick();
  }
  assert.fail('timed out');
}

// The fake models the helper's contract and does not touch Mission Control.
// spacesSwitch blocks until released, then resolves armed without pressing.
// spacesCommit presses on a later turn unless spacesAbort has already set cancelled.
// deferPress leaves that later turn in the test's hands. killOnCommit drops the
// session at the moment commit arrives, before that turn.
function harness(look, { holdLook = false, already = false, deferPress = false, killOnCommit = false } = {}) {
  const calls = [];
  const blocked = [];
  const replies = [];
  const presses = [];
  const actions = [];
  let alive = true;
  let input = true;
  let authed = true;
  let target = { id: 1 };
  let openLook = null;
  let session = null;
  let pressGate = null;
  const helper = {
    request(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'spacesLook') {
        const finish = () => (look instanceof Error ? Promise.reject(look) : Promise.resolve(look));
        if (!holdLook) return finish();
        return new Promise((resolve, reject) => {
          openLook = () => (look instanceof Error ? reject(look) : resolve(look));
        });
      }
      if (cmd === 'spacesAbort') {
        const before = !(session && session.pressed);
        if (session && args && args.token === session.token && !session.pressed) {
          session.cancelled = true;
          if (!session.settled) {
            session.settled = true;
            if (session.opened) actions.push('close');
            if (session.held) { actions.push('restore'); session.held = false; }
          }
          if (!session.armed && blocked.length) blocked.shift().reject(new Error('stale'));
        }
        return Promise.resolve({ aborted: !!(session && session.cancelled && before), beforePress: before && !(session && session.pressed) });
      }
      if (cmd === 'spacesSwitch') {
        if (already) return Promise.reject(new Error('overview'));
        session = { token: args.token, cancelled: false, pressed: false, armed: false, settled: false, held: true, opened: true };
        actions.push('hold', 'open');
        return new Promise((resolve, reject) => {
          blocked.push({
            args,
            resolve: () => {
              if (!session || session.cancelled) reject(new Error('stale'));
              else {
                session.armed = true;
                resolve({ phase: 'armed', token: args.token });
              }
            },
            reject,
          });
        });
      }
      if (cmd === 'spacesCommit') {
        if (killOnCommit) alive = false;
        return new Promise((resolve, reject) => {
          const run = () => {
            if (!session || session.cancelled || session.pressed || !args || args.token !== session.token) {
              reject(new Error('stale'));
              return;
            }
            session.pressed = true;
            session.settled = true;
            if (session.held) { actions.push('restore'); session.held = false; }
            actions.push('press');
            presses.push(args);
            resolve({ switched: true });
          };
          if (deferPress) { pressGate = run; return; }
          setImmediate(run);
        });
      }
      return Promise.reject(new Error('key'));
    },
  };
  let deliver;
  new SpaceSwitch({
    listen(fn) { deliver = fn; },
    helper,
    enabled: () => input,
    authorize: () => (authed ? () => alive : null),
    targetFor: () => target,
    reply: (_ctx, msg) => replies.push(msg),
  });
  return {
    calls, blocked, replies, presses, actions, deliver,
    get session() { return session; },
    get pressGate() { return pressGate; },
    releaseLook() { if (openLook) openLook(); },
    set alive(v) { alive = v; },
    set input(v) { input = v; },
    set authed(v) { authed = v; },
    set target(v) { target = v; },
    get target() { return target; },
  };
}

async function main() {
  // Planner: one display's next desktop, and the refusals that must not move anything.
  {
    const next = S.planSwitch(SEPARATE, { displayId: '1', dir: 1 });
    assert.deepStrictEqual(next, { ok: true, spaceId: '11', displayId: '1', index: 1, count: 3 });
    const prev = S.planSwitch({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '11', spaces: ['10', '11'] }],
    }, { displayId: '1', dir: -1 });
    assert.deepStrictEqual(prev, { ok: true, spaceId: '10', displayId: '1', index: 0, count: 2 });
    assert.deepStrictEqual(S.planSwitch(SEPARATE, { displayId: '1', dir: -1 }), { ok: false, why: 'edge', edge: 'first' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '12', spaces: ['10', '11', '12'] }],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'edge', edge: 'last' });

    // One display can move even when the spans-displays preference is on: nothing else exists.
    assert.strictEqual(S.planSwitch({
      spans: true,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] }],
    }, { displayId: '1', dir: 1 }).ok, true);

    assert.deepStrictEqual(S.planSwitch({ ...SEPARATE, spans: true }, { displayId: '1', dir: 1 }), { ok: false, why: 'spans' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [
        { uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] },
        { uuid: 'BBB', cgId: 2, current: '10', spaces: ['10', '21'] },
      ],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'spans' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [
        { uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] },
        { uuid: 'BBB', cgId: '', current: '20', spaces: ['20'] },
      ],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'unavailable' });
    assert.deepStrictEqual(S.planSwitch(SEPARATE, { displayId: '9', dir: 1 }), { ok: false, why: 'display' });
    assert.deepStrictEqual(S.planSwitch(SEPARATE, { displayId: '1', dir: 0 }), { ok: false, why: 'dir' });
    assert.deepStrictEqual(S.planSwitch({ spans: false, displays: [] }, { displayId: '1', dir: 1 }), { ok: false, why: 'unavailable' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      displays: [{ uuid: 'AAA', cgId: 1, current: '99', spaces: ['10', '11'] }],
    }, { displayId: '1', dir: 1 }), { ok: false, why: 'unavailable' });
    assert.deepStrictEqual(S.planSwitch({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: '1', current: '10', spaces: ['10', '0', 'nope', '10', '11'] }],
    }, { displayId: '1', dir: 1 }), { ok: true, spaceId: '11', displayId: '1', index: 1, count: 2 });

    // Windows still visible from another desktop: no button, and no switch.
    const mixed = {
      spans: false,
      composed: false,
      displays: [
        { uuid: 'LEFT', cgId: 5, current: '9', spaces: ['7', '8', '9', '10', '11', '12'] },
        { uuid: 'RIGHT', cgId: 1, current: '15', spaces: ['236', '18', '14', '15', '17'] },
      ],
    };
    assert.deepStrictEqual(S.planSwitch(mixed, { displayId: '5', dir: 1 }), { ok: false, why: 'composed' });
    assert.strictEqual(S.offerSpaces(mixed, { id: 5 }), false);
    assert.strictEqual(S.offerSpaces({ ...SEPARATE, composed: false }, { id: 1 }), false);
    assert.strictEqual(S.offerSpaces(SEPARATE, { id: 1 }), true);
    assert.strictEqual(S.offerSpaces({ ...SEPARATE, ax: false }, { id: 1 }), false);
    const noAx = { ...SEPARATE };
    delete noAx.ax;
    assert.strictEqual(S.offerSpaces(noAx, { id: 1 }), false);
    assert.strictEqual(S.offerSpaces({ ...SEPARATE, inputHeld: true }, { id: 1 }), false);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1, generation: 1 }), S.viewToken({ id: 1, generation: 3 })), false);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1 }), S.viewToken({ id: 1 })), true);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1, generation: 1 }), S.viewToken({ id: 1 })), false);
    assert.strictEqual(S.sameView(S.viewToken({ id: 1, generation: null }), S.viewToken({ id: 1, generation: null })), false);
    const slot = { key: null, generation: 0 };
    assert.strictEqual(S.noteGeneration(slot, 'default:1'), 1);
    assert.strictEqual(S.noteGeneration(slot, 'default:1'), 1);
    assert.strictEqual(S.noteGeneration(slot, 'default:2'), 2);
    assert.strictEqual(S.noteGeneration(slot, 'default:1'), 3);
    assert.strictEqual(S.noteGeneration(slot, 'none:1'), 4);
    assert.strictEqual(S.spaceHold({ inputHeld: true, holdWhy: 'overview' }), 'overview');
    assert.strictEqual(S.spaceHold({ inputHeld: true }), 'accessibility');
    assert.strictEqual(S.spaceHold({ inputHeld: false, holdWhy: 'overview' }), '');
    assert.strictEqual(S.offerSpaces(SEPARATE, { id: 2 }), true);
    assert.strictEqual(S.offerSpaces(SEPARATE, null), false);
    assert.strictEqual(S.offerSpaces({
      spans: false,
      composed: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '10', spaces: ['10'] }],
    }, { id: 1 }), false);
  }

  // The picture that is actually up. A missing or previous capture is not a target.
  {
    const want = { id: 2, label: 'LG' };
    const live = { viewer: true, waitingPolicy: false, sharing: true, activeId: 2, want };
    assert.strictEqual(S.viewedDisplay(live), want);
    assert.strictEqual(S.viewedDisplay({ ...live, viewer: null }), want);
    assert.strictEqual(S.viewedDisplay({ ...live, viewer: false }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, waitingPolicy: true }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, sharing: false }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, choiceMode: 'none' }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, activeId: 1 }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, activeId: null }), null);
    assert.strictEqual(S.viewedDisplay({ ...live, want: null }), null);
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next' }), { ok: true, displayId: '2' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: '' }), { ok: true, displayId: '2' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: '2' }), { ok: true, displayId: '2' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: '1' }), { ok: false, why: 'display' });
    assert.deepStrictEqual(S.resolveTarget(want, { dir: 'next', displayId: 'side' }), { ok: false, why: 'display' });
    assert.deepStrictEqual(S.resolveTarget(null, { dir: 'next' }), { ok: false, why: 'target' });
    assert.deepStrictEqual(S.resolveTarget({ id: 0 }, { dir: 'next' }), { ok: false, why: 'target' });
    assert.strictEqual(S.dirOf({ dir: 'prev' }), -1);
    assert.strictEqual(S.dirOf({ dir: 'next' }), 1);
    assert.strictEqual(S.dirOf({ dir: 'left' }), 0);
  }

  // One-to-one and mesh session gates. A later check fails once the socket is no longer that session.
  {
    const ws = { readyState: 1 };
    const ctx = { authed: true, ws, deviceId: 'phone' };
    const current = { authed: true, ws, deviceId: 'phone' };
    let read = current;
    const still = S.streamInputGate(ctx, () => read);
    assert.strictEqual(typeof still, 'function');
    assert.strictEqual(still(), true);
    ctx.released = true;
    assert.strictEqual(still(), false);
    ctx.released = false;
    ws.readyState = 2;
    assert.strictEqual(still(), false);
    ws.readyState = 1;
    read = { authed: true, ws: {}, deviceId: 'phone' };
    assert.strictEqual(still(), false);
    assert.strictEqual(S.streamInputGate({ ...ctx, authed: false }, () => current), null);
    assert.strictEqual(S.streamInputGate(ctx, () => null), null);
    assert.strictEqual(S.streamInputGate(ctx, () => ({ authed: true, ws, deviceId: 'other' })), null);

    const link = { authed: true, ws: { readyState: 1 } };
    const hostWs = { readyState: 1 };
    const host = { authed: true, ws: hostWs };
    let session = { connected: true, linkUp: true, link, hostUp: false, ctx: null };
    const meshStill = S.meshGate(() => session);
    assert.strictEqual(meshStill(), true);
    link.ws.readyState = 2;
    assert.strictEqual(meshStill(), false);
    link.ws.readyState = 1;
    session = { ...session, link: { authed: true } };
    assert.strictEqual(meshStill(), false);
    session = { connected: true, linkUp: false, hostUp: true, ctx: host };
    const hostStill = S.meshGate(() => session);
    assert.strictEqual(hostStill(), true);
    session = { ...session, ctx: { authed: true, ws: {} } };
    assert.strictEqual(hostStill(), false);
    session = { connected: true, linkUp: true, link, hostUp: true, ctx: host };
    assert.strictEqual(hostStill(), false);
    assert.strictEqual(S.meshGate(() => ({ connected: false })), null);
    assert.strictEqual(S.meshGate(() => ({ connected: true, linkUp: true, link: { authed: false } })), null);
    assert.strictEqual(S.meshGate(() => ({ connected: true, linkUp: false, hostUp: true, ctx: { authed: true } })), null);
  }

  // Main path: arm names the viewed display and the exact next index. The press is the commit, after the arm.
  {
    const h = harness(SEPARATE);
    h.deliver({ t: 'screen.space', dir: 'next', displayId: '1' }, { id: 'phone' });
    await until(() => h.blocked.length === 1);
    assert.deepStrictEqual(h.calls.map((c) => c.cmd), ['spacesLook', 'spacesSwitch']);
    assert.deepStrictEqual(h.calls[1].args, { displayId: 1, spaceId: '11', index: 1, count: 3, token: '1' });
    assert.strictEqual(h.presses.length, 0);
    assert.deepStrictEqual(h.actions, ['hold', 'open']);
    h.blocked[0].resolve();
    await until(() => h.replies.length === 1);
    assert.deepStrictEqual(h.replies[0], { t: P.T.SCREEN_SPACE_RESULT, ok: true, dir: 'next' });
    assert.strictEqual(h.presses.length, 1);
    assert.strictEqual(h.presses[0].token, '1');
    assert.deepStrictEqual(h.actions, ['hold', 'open', 'restore', 'press']);
    assert.ok(!h.actions.includes('close'));
  }

  // Unauthorized, stale, input off, the wrong display, and a shared-desktop snapshot do not switch.
  {
    const refused = async (setup, msg, why) => {
      const h = harness(SEPARATE);
      setup(h);
      h.deliver(msg, { id: 'phone' });
      await until(() => h.replies.length === 1);
      assert.strictEqual(h.replies[0].ok, false, why);
      assert.strictEqual(h.replies[0].why, why);
      assert.ok(!h.calls.some((c) => c.cmd === 'spacesSwitch'), why);
      return h;
    };
    const none = await refused((h) => { h.authed = false; h.input = false; }, { dir: 'next' }, 'unauthorized');
    assert.strictEqual(none.calls.length, 0);
    const early = await refused((h) => { h.alive = false; }, { dir: 'next' }, 'stale');
    assert.strictEqual(early.calls.length, 0);
    const off = await refused((h) => { h.input = false; }, { dir: 'next' }, 'input');
    assert.strictEqual(off.calls.length, 0);
    const mismatch = await refused(() => {}, { dir: 'next', displayId: '2' }, 'display');
    assert.strictEqual(mismatch.calls.length, 0);
    const badDir = await refused(() => {}, { dir: 'left' }, 'dir');
    assert.strictEqual(badDir.calls.length, 0);
    const gone = await refused((h) => { h.target = null; }, { dir: 'next' }, 'target');
    assert.strictEqual(gone.calls.length, 0);

    const stale = harness(SEPARATE, { holdLook: true });
    stale.deliver({ dir: 'next', displayId: '1' }, {});
    await until(() => stale.calls.some((c) => c.cmd === 'spacesLook'));
    stale.alive = false;
    stale.releaseLook();
    await until(() => stale.replies.length === 1);
    assert.strictEqual(stale.replies[0].why, 'stale');
    assert.ok(!stale.calls.some((c) => c.cmd === 'spacesSwitch'));

    // Queued requests remain bound to the session that sent them, even if that device reconnects.
    {
      let session = { connected: true, linkUp: true, link: { authed: true, ws: { readyState: 1 } } };
      let deliver, release;
      const calls = [], replies = [];
      new SpaceSwitch({
        listen(fn) { deliver = fn; },
        authorize: () => S.meshGate(() => session),
        enabled: () => true,
        targetFor: () => ({ id: 1 }),
        reply: (_ctx, msg) => replies.push(msg),
        helper: { request(cmd) { calls.push(cmd); return new Promise((resolve) => { release = () => resolve(SEPARATE); }); } },
      });
      deliver({ dir: 'next' }, { id: 'phone' });
      deliver({ dir: 'next' }, { id: 'phone' });
      await until(() => calls.length === 1);
      session = { connected: true, linkUp: true, link: { authed: true, ws: { readyState: 1 } } };
      release();
      await until(() => replies.length === 2);
      assert.deepStrictEqual(calls, ['spacesLook']);
      assert.ok(replies.every((r) => r.why === 'stale'));
    }

    const moved = harness(SEPARATE, { holdLook: true });
    moved.deliver({ dir: 'next', displayId: '1' }, {});
    await until(() => moved.calls.some((c) => c.cmd === 'spacesLook'));
    moved.target = { id: 2 };
    moved.releaseLook();
    await until(() => moved.replies.length === 1);
    assert.strictEqual(moved.replies[0].why, 'display');
    assert.ok(!moved.calls.some((c) => c.cmd === 'spacesSwitch'));

    const spans = harness({ ...SEPARATE, spans: true });
    spans.deliver({ dir: 'next' }, {});
    await until(() => spans.replies.length === 1);
    assert.strictEqual(spans.replies[0].why, 'spans');
    assert.deepStrictEqual(spans.calls.map((c) => c.cmd), ['spacesLook']);

    const mixed = harness({ ...SEPARATE, composed: false });
    mixed.deliver({ dir: 'next' }, {});
    await until(() => mixed.replies.length === 1);
    assert.strictEqual(mixed.replies[0].why, 'composed');
    assert.deepStrictEqual(mixed.calls.map((c) => c.cmd), ['spacesLook']);

    const edge = harness({
      spans: false,
      composed: true,
      ax: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '10', spaces: ['10', '11'] }],
    });
    edge.deliver({ dir: 'prev' }, {});
    await until(() => edge.replies.length === 1);
    assert.deepStrictEqual(edge.replies[0], { t: P.T.SCREEN_SPACE_RESULT, ok: false, why: 'edge', edge: 'first', dir: 'prev' });
    assert.ok(!edge.calls.some((c) => c.cmd === 'spacesSwitch'));
  }

  // Helper errors stay inside the why set. A thrown look never reaches a switch.
  {
    const missing = harness(new Error('unavailable'));
    missing.deliver({ dir: 'next' }, {});
    await until(() => missing.replies.length === 1);
    assert.strictEqual(missing.replies[0].why, 'unavailable');
    assert.deepStrictEqual(missing.calls.map((c) => c.cmd), ['spacesLook']);

    for (const [message, why] of [['shared', 'spans'], ['display', 'display'], ['nope', 'unavailable'], ['overview', 'overview'], ['ambiguous', 'ambiguous'], ['stale', 'stale']]) {
      const h = harness(SEPARATE);
      h.deliver({ dir: 'next' }, {});
      await until(() => h.blocked.length === 1);
      h.blocked[0].reject(new Error(message));
      await until(() => h.replies.length === 1);
      assert.strictEqual(h.replies[0].why, why, message);
      assert.deepStrictEqual(h.calls.map((c) => c.cmd), ['spacesLook', 'spacesSwitch', 'spacesAbort']);
      assert.strictEqual(h.presses.length, 0, message);
    }
  }

  // Mission Control already open: the helper refuses. We do not commit or press.
  {
    const open = harness(SEPARATE, { already: true });
    open.deliver({ dir: 'next' }, {});
    await until(() => open.replies.length === 1);
    assert.strictEqual(open.replies[0].why, 'overview');
    assert.deepStrictEqual(open.calls.map((c) => c.cmd), ['spacesLook', 'spacesSwitch', 'spacesAbort']);
    assert.deepStrictEqual(open.actions, []);
    assert.strictEqual(open.presses.length, 0);
  }

  // The session dies while the helper is still arming. Abort is acknowledged before any press.
  {
    const h = harness(SEPARATE);
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    h.alive = false;
    await until(() => h.calls.some((c) => c.cmd === 'spacesAbort'));
    await until(() => h.replies.length === 1);
    assert.strictEqual(h.replies[0].why, 'stale');
    assert.ok(!h.calls.some((c) => c.cmd === 'spacesCommit'));
    assert.strictEqual(h.presses.length, 0);
    assert.strictEqual(h.session.cancelled, true);
    assert.ok(h.actions.indexOf('close') > h.actions.indexOf('open'));
    assert.strictEqual(h.actions[h.actions.length - 1], 'restore');
    assert.ok(!h.actions.includes('press'));
  }

  // Replaced mesh session while the overview is arming: the abort command reaches the helper.
  {
    let session = { connected: true, linkUp: true, link: { authed: true, ws: { readyState: 1 } } };
    let deliver;
    const calls = [];
    const replies = [];
    let blocked = null;
    let cancelled = false;
    let pressed = false;
    new SpaceSwitch({
      listen(fn) { deliver = fn; },
      authorize: () => S.meshGate(() => session),
      enabled: () => true,
      targetFor: () => ({ id: 1 }),
      reply: (_ctx, msg) => replies.push(msg),
      helper: {
        request(cmd, args) {
          calls.push(cmd);
          if (cmd === 'spacesLook') return Promise.resolve(SEPARATE);
          if (cmd === 'spacesAbort') {
            cancelled = true;
            if (blocked) blocked.reject(new Error('stale'));
            return Promise.resolve({ aborted: true, beforePress: !pressed });
          }
          if (cmd === 'spacesSwitch') {
            return new Promise((resolve, reject) => { blocked = { resolve, reject }; });
          }
          if (cmd === 'spacesCommit') {
            pressed = !cancelled;
            return cancelled ? Promise.reject(new Error('stale')) : Promise.resolve({ switched: true });
          }
          return Promise.reject(new Error('key'));
        },
      },
    });
    deliver({ dir: 'next' }, { id: 'phone' });
    await until(() => calls.includes('spacesSwitch'));
    session = { connected: true, linkUp: true, link: { authed: true, ws: { readyState: 1 } } };
    await until(() => calls.includes('spacesAbort') && cancelled);
    assert.strictEqual(pressed, false);
    await until(() => replies.length === 1);
    assert.strictEqual(replies[0].why, 'stale');
    assert.ok(!calls.includes('spacesCommit'));
  }

  // Commit has reached the helper and the session is replaced before the deferred press.
  // Abort is applied to the helper before that press is allowed to run.
  {
    const h = harness(SEPARATE, { deferPress: true, killOnCommit: true });
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    h.blocked[0].resolve();
    await until(() => h.calls.some((c) => c.cmd === 'spacesCommit'));
    await until(() => h.calls.some((c) => c.cmd === 'spacesAbort') && h.session.cancelled);
    assert.strictEqual(h.presses.length, 0);
    assert.strictEqual(typeof h.pressGate, 'function');
    h.pressGate();
    await until(() => h.replies.length === 1);
    assert.strictEqual(h.replies[0].why, 'stale');
    assert.strictEqual(h.presses.length, 0);
    assert.ok(!h.actions.includes('press'));
    assert.ok(h.actions.includes('restore'));
  }

  // Two requests stay in order. The second look runs only after the first switch settles.
  {
    const h = harness({
      spans: false,
      composed: true,
      ax: true,
      displays: [{ uuid: 'AAA', cgId: 1, current: '11', spaces: ['10', '11', '12'] }],
    });
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    h.deliver({ dir: 'prev' }, {});
    await tick();
    assert.strictEqual(h.calls.length, 2);
    h.blocked[0].resolve();
    await until(() => h.blocked.length === 2);
    assert.strictEqual(h.calls[4].args.spaceId, '10');
    assert.strictEqual(h.calls[4].args.index, 0);
    assert.strictEqual(h.calls[4].args.count, 3);
    h.blocked[1].resolve();
    await until(() => h.replies.length === 2);
    assert.deepStrictEqual(h.replies.map((m) => m.dir), ['next', 'prev']);
    assert.ok(h.replies.every((m) => m.ok === true && m.t === 'screen.space.result'));
  }

  // Two Next actions queued on display 1. The first lookup is held, then the viewer
  // target becomes display 2. The second action was aimed at 1 and must not switch 2.
  {
    const h = harness(SEPARATE, { holdLook: true });
    h.target = { id: 1, generation: 1 };
    h.deliver({ dir: 'next' }, {});
    h.deliver({ dir: 'next' }, {});
    await until(() => h.calls.filter((c) => c.cmd === 'spacesLook').length === 1);
    assert.strictEqual(h.calls.length, 1);
    h.target = { id: 2, generation: 2 };
    h.releaseLook();
    await until(() => h.replies.length === 2);
    assert.ok(h.replies.every((r) => r.ok === false && r.why === 'display'));
    assert.ok(!h.calls.some((c) => c.cmd === 'spacesSwitch'));
    assert.ok(!h.calls.some((c) => c.args && c.args.displayId === 2));
  }

  // A→B→A while the first lookup is held. The id is 1 again, but the generation moved.
  {
    const h = harness(SEPARATE, { holdLook: true });
    h.target = { id: 1, generation: 1 };
    h.deliver({ dir: 'next' }, {});
    h.deliver({ dir: 'next' }, {});
    await until(() => h.calls.filter((c) => c.cmd === 'spacesLook').length === 1);
    h.target = { id: 2, generation: 2 };
    h.target = { id: 1, generation: 3 };
    h.releaseLook();
    await until(() => h.replies.length === 2);
    assert.ok(h.replies.every((r) => r.ok === false && r.why === 'display'));
    assert.ok(!h.calls.some((c) => c.cmd === 'spacesSwitch'));
  }

  // The same id and the same generation still switches that display.
  {
    const h = harness(SEPARATE);
    h.target = { id: 1, generation: 4 };
    h.deliver({ dir: 'next' }, {});
    await until(() => h.blocked.length === 1);
    assert.strictEqual(h.calls[1].args.displayId, 1);
    assert.strictEqual(h.calls[1].args.spaceId, '11');
    h.blocked[0].resolve();
    await until(() => h.replies.length === 1);
    assert.strictEqual(h.replies[0].ok, true);
  }

  // Accessibility is not trusted, or input is already paused: do not open Mission Control.
  {
    const untrusted = harness({ ...SEPARATE, ax: false });
    untrusted.deliver({ dir: 'next' }, {});
    await until(() => untrusted.replies.length === 1);
    assert.strictEqual(untrusted.replies[0].why, 'accessibility');
    assert.ok(!untrusted.calls.some((c) => c.cmd === 'spacesSwitch'));

    const bareLook = { ...SEPARATE };
    delete bareLook.ax;
    const bare = harness(bareLook);
    bare.deliver({ dir: 'next' }, {});
    await until(() => bare.replies.length === 1);
    assert.strictEqual(bare.replies[0].why, 'accessibility');
    assert.ok(!bare.calls.some((c) => c.cmd === 'spacesSwitch'));

    const held = harness({ ...SEPARATE, inputHeld: true, holdWhy: 'overview' });
    held.deliver({ dir: 'next' }, {});
    await until(() => held.replies.length === 1);
    assert.strictEqual(held.replies[0].why, 'overview');
    assert.ok(!held.calls.some((c) => c.cmd === 'spacesSwitch'));

    const unknownHold = harness({ ...SEPARATE, inputHeld: true });
    unknownHold.deliver({ dir: 'next' }, {});
    await until(() => unknownHold.replies.length === 1);
    assert.strictEqual(unknownHold.replies[0].why, 'accessibility');
    assert.ok(!unknownHold.calls.some((c) => c.cmd === 'spacesSwitch'));
  }

  assert.strictEqual(P.T.SCREEN_SPACE, 'screen.space');
  assert.strictEqual(P.T.SCREEN_SPACE_RESULT, 'screen.space.result');
  console.log('mac-spaces: fake helper only; arm, abort-before-press, and refusals. Not a live desktop switch.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
