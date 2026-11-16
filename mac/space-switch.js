// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// screen.space from a viewer. Runs only while stream input is allowed for the authenticated
// session that sent it, and only for a desktop the helper can prove belongs to the display
// that viewer is being shown.
//
// The viewed display is recorded when the message arrives. A queued action does not
// pick up whatever display is current when it runs, and a generation change refuses
// even when the id has returned to the same display.
// The helper opens Mission Control only for that display and AXPresses one thumbnail.
// spacesSwitch replies when the tree is armed, before the press. This waits for that,
// checks the session again, and only then sends spacesCommit. If the session is gone,
// replaced, or input is off, spacesAbort is sent and awaited before any commit. Commit
// itself does not press on the helper's current turn: the helper defers one main-queue
// turn, and an abort that arrived is applied first. Checking the session only after
// the helper has finished the press is not the gate.
//
// This does not inject Control-arrow or any other key. The phone is offered the buttons
// only when offerSpaces says this picture's display has its own other desktop and the
// helper's composition read is clean. A window still visible from another desktop is a
// refusal here, before spacesSwitch, so Mission Control is not opened.
'use strict';

const P = require('../shared/protocol.js');
const S = require('../shared/mac-spaces.js');

const SWITCH_WHY = new Set(['spans', 'display', 'unavailable', 'overview', 'stale', 'ambiguous', 'composed', 'accessibility']);

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function mapWhy(error) {
  const message = error && error.message;
  if (message === 'shared') return 'spans';
  return SWITCH_WHY.has(message) ? message : 'unavailable';
}

class SpaceSwitch {
  constructor({ listen, helper, enabled, authorize, targetFor, reply }) {
    this.helper = helper;
    this.enabled = enabled;
    this.authorize = authorize;
    this.targetFor = targetFor;
    this.reply = reply;
    this.tail = Promise.resolve();
    this.seq = 0;
    listen((msg, ctx) => {
      // Bind the originating session, and the display it was looking at, before queuing.
      // A later connection with the same device id must not inherit the action, and a
      // queued action must not switch whatever display is current when it dequeues.
      const still = this.authorize(ctx);
      let captured = null;
      try { captured = S.viewToken(this.targetFor(ctx)); } catch (_) { captured = null; }
      const run = this.tail.then(() => this._one(msg, ctx, still, captured));
      this.tail = run.catch((e) => console.error('[spaces]', e && e.message));
    });
  }

  handle(msg, ctx) {
    let captured = null;
    try { captured = S.viewToken(this.targetFor(ctx)); } catch (_) { captured = null; }
    return this._one(msg, ctx, this.authorize(ctx), captured);
  }

  async _one(msg, ctx, still, captured) {
    const dir = S.dirOf(msg);
    if (!still) return this._reply(ctx, { ok: false, why: 'unauthorized', dir });
    if (!this.enabled()) return this._reply(ctx, { ok: false, why: 'input', dir });
    if (!still()) return this._reply(ctx, { ok: false, why: 'stale', dir });
    if (!dir) return this._reply(ctx, { ok: false, why: 'dir', dir });
    if (!captured) return this._reply(ctx, { ok: false, why: 'target', dir });
    const resolved = S.resolveTarget({ id: captured.displayId }, msg);
    if (!resolved.ok) return this._reply(ctx, { ok: false, why: resolved.why, dir });
    const liveToken = () => {
      try { return S.viewToken(this.targetFor(ctx)); } catch (_) { return null; }
    };
    if (!S.sameView(captured, liveToken())) return this._reply(ctx, { ok: false, why: 'display', dir });
    if (!still() || !this.enabled()) return this._reply(ctx, { ok: false, why: still() ? 'input' : 'stale', dir });
    let look;
    try {
      look = await this.helper.request('spacesLook', {});
    } catch (_) {
      return this._reply(ctx, { ok: false, why: 'unavailable', dir });
    }
    if (!still()) return this._reply(ctx, { ok: false, why: 'stale', dir });
    if (!this.enabled()) return this._reply(ctx, { ok: false, why: 'input', dir });
    if (!S.sameView(captured, liveToken())) return this._reply(ctx, { ok: false, why: 'display', dir });
    if (!look || look.ax !== true) return this._reply(ctx, { ok: false, why: 'accessibility', dir });
    if (look.inputHeld === true) {
      return this._reply(ctx, { ok: false, why: look.holdWhy === 'overview' ? 'overview' : 'accessibility', dir });
    }
    const plan = S.planSwitch(look, { displayId: resolved.displayId, dir });
    if (!plan.ok) return this._reply(ctx, { ok: false, why: plan.why, edge: plan.edge, dir });
    if (!still() || !this.enabled()) return this._reply(ctx, { ok: false, why: still() ? 'input' : 'stale', dir });
    const token = String(++this.seq);
    const sameTarget = () => S.sameView(captured, liveToken());
    const failWhy = () => {
      if (!still()) return 'stale';
      if (!this.enabled()) return 'input';
      if (!sameTarget()) return 'display';
      return null;
    };
    let stopWatch = false;
    let aborting = null;
    const abortOnce = () => {
      if (!aborting) aborting = this.helper.request('spacesAbort', { token }).catch(() => {});
      return aborting;
    };
    // Runs while the helper is polling and while commit is deferred, so a dead
    // session is a helper command before AXPress rather than a look at the result.
    void (async () => {
      try {
        while (!stopWatch) {
          await tick();
          if (stopWatch) return;
          if (failWhy()) await abortOnce();
        }
      } catch (_) { /* the reply below is the one the viewer sees */ }
    })();
    const payload = {
      displayId: Number(plan.displayId),
      spaceId: plan.spaceId,
      index: plan.index,
      count: plan.count,
      token,
    };
    try {
      let armed;
      try {
        armed = await this.helper.request('spacesSwitch', payload);
      } catch (e) {
        await abortOnce();
        return this._reply(ctx, { ok: false, why: mapWhy(e), dir });
      }
      if (aborting || failWhy() || !armed || armed.phase !== 'armed' || armed.token !== token) {
        await abortOnce();
        return this._reply(ctx, { ok: false, why: failWhy() || 'stale', dir });
      }
      try {
        await this.helper.request('spacesCommit', { token });
      } catch (e) {
        await abortOnce();
        return this._reply(ctx, { ok: false, why: failWhy() || mapWhy(e), dir });
      }
      return this._reply(ctx, { ok: true, dir });
    } finally {
      stopWatch = true;
    }
  }

  _reply(ctx, body) {
    const msg = { t: P.T.SCREEN_SPACE_RESULT, ok: body.ok === true };
    if (!msg.ok && body.why) msg.why = body.why;
    if (body.edge === 'first' || body.edge === 'last') msg.edge = body.edge;
    if (body.dir === -1) msg.dir = 'prev';
    else if (body.dir === 1) msg.dir = 'next';
    try { this.reply(ctx, msg); } catch (_) { /* the session is already gone */ }
    return msg;
  }
}

// The last spacesLook. refresh asks again at most once a second, and only while a
// screen.state is being sent. It never asks for a switch. onChange runs only when the
// fields that decide the buttons changed, so a steady desktop does not push state again.
class SpaceLook {
  constructor(helper, onChange) {
    this.helper = helper;
    this.onChange = onChange;
    this.look = null;
    this.finger = '';
    this.at = 0;
    this.busy = false;
    this.again = false;
  }

  current() {
    return this.look;
  }

  refresh() {
    if (!this.helper) return;
    if (this.busy) { this.again = true; return; }
    if (this.at && Date.now() - this.at < 1000) return;
    this.busy = true;
    const finish = (look) => {
      this.look = look;
      this.at = Date.now();
      this.busy = false;
      const finger = spaceFinger(look);
      const diff = finger !== this.finger;
      this.finger = finger;
      const again = this.again;
      this.again = false;
      try { if (diff) this.onChange(); } catch (_) { /* the window may already be gone */ }
      if (again) this.refresh();
    };
    this.helper.request('spacesLook', {}).then((look) => {
      finish(look && typeof look === 'object' ? look : null);
    }).catch(() => finish(null));
  }
}

function spaceFinger(look) {
  if (!look) return '';
  const displays = Array.isArray(look.displays) ? look.displays.map((d) => ({
    cgId: d && d.cgId != null ? String(d.cgId) : '',
    current: d && d.current != null ? String(d.current) : '',
    spaces: Array.isArray(d && d.spaces) ? d.spaces.map(String) : [],
  })) : [];
  return JSON.stringify({
    composed: look.composed === true,
    spans: look.spans === true,
    ax: look.ax === true,
    inputHeld: look.inputHeld === true,
    holdWhy: look.holdWhy === 'overview' || look.holdWhy === 'accessibility' ? look.holdWhy : '',
    displays,
  });
}

module.exports = { SpaceSwitch, SpaceLook };
