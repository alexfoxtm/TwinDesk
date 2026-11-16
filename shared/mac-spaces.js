// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which macOS desktop (Space) a phone may move, on the display it is being shown.
//
// macOS has no public per-display desktop switch. Control-Left and Control-Right follow keyboard
// focus, and with "Displays have separate Spaces" turned off they move every display. This module
// never asks for those keys. A switch is allowed only when the helper's snapshot shows the
// destination desktop on the viewed display and on no other display. The index is that desktop's
// place in the list the helper reads. Anything short of one owned destination is a refusal:
// the helper must not be told to open Mission Control. `composed` must be true as well:
// a read of the on-screen windows says each one belongs to a desktop that is current.
// Anything short of that is a refusal, including a missing flag. `ax` must be true:
// a missing or false accessibility read hides the buttons, because every press would fail.
// `inputHeld` hides them too. Remote input stays paused until a fresh read says Mission
// Control is hidden; an unknown read does not resume it and does not send a touch.
//
// A switch records the viewed display when the message arrives, not when the queued
// action runs. `generation`, when the target has one, changes on every selection change,
// so a return to the same display id (A→B→A) is still a different selection. Without a
// generation, only the id can be compared.
'use strict';

const SPACE_ID = /^\d{1,20}$/;

function dirOf(msg) {
  if (!msg || typeof msg !== 'object') return 0;
  if (msg.dir === 'prev' || msg.dir === -1) return -1;
  if (msg.dir === 'next' || msg.dir === 1) return 1;
  return 0;
}

function askedDisplay(msg) {
  if (!msg || typeof msg !== 'object' || !Object.prototype.hasOwnProperty.call(msg, 'displayId')) return '';
  if (msg.displayId == null || msg.displayId === '') return '';
  const id = typeof msg.displayId === 'number' ? String(msg.displayId) : String(msg.displayId);
  return /^-?\d+$/.test(id) ? id : '';
}

// The display the open viewer is actually being shown. Null when the picture is off, still
// settling, or the capture has not caught up with a new choice: a desktop move must not land
// on the display that was on screen a moment ago.
function viewedDisplay(state) {
  if (!state || state.viewer === false || state.waitingPolicy === true || state.sharing !== true) return null;
  if (state.choiceMode === 'none') return null;
  const want = state.want;
  if (!want || want.id == null) return null;
  // No picture yet, or the capture is still the previous display: do not move a desktop.
  if (state.activeId == null || state.activeId !== want.id) return null;
  return want;
}

// target is that viewed display. A displayId on the message must name it; a different id is refused.
function resolveTarget(target, msg) {
  if (!target || target.id == null) return { ok: false, why: 'target' };
  const id = String(target.id);
  if (!/^\d+$/.test(id) || id === '0') return { ok: false, why: 'target' };
  const asked = askedDisplay(msg);
  if (Object.prototype.hasOwnProperty.call(msg || {}, 'displayId') && msg.displayId != null && msg.displayId !== '' && !asked) {
    return { ok: false, why: 'display' };
  }
  if (asked && asked !== id) return { ok: false, why: 'display' };
  return { ok: true, displayId: id };
}

// The display a screen.space message was aimed at. generation is kept only when the
// target object has one. An unusable generation fails closed later.
function viewToken(target) {
  const resolved = resolveTarget(target, {});
  if (!resolved.ok) return null;
  const token = { displayId: resolved.displayId };
  if (target && Object.prototype.hasOwnProperty.call(target, 'generation')) {
    const g = target.generation;
    token.generation = (typeof g === 'number' && Number.isSafeInteger(g) && g >= 0) ? g : null;
  }
  return token;
}

// True only when the live view is still the one recorded at receipt. A different id
// refuses. When either side has a generation, both must be the same number, so
// A→B→A refuses. Two tokens with no generation compare ids only.
function sameView(captured, live) {
  if (!captured || !live || captured.displayId !== live.displayId) return false;
  const cap = Object.prototype.hasOwnProperty.call(captured, 'generation');
  const now = Object.prototype.hasOwnProperty.call(live, 'generation');
  if (!cap && !now) return true;
  if (!cap || !now) return false;
  if (captured.generation == null || live.generation == null) return false;
  return captured.generation === live.generation;
}

// Bump when the selected display or per-device choice key changes. The same key
// keeps the number, so a later read of an unchanged selection still matches.
function noteGeneration(slot, key) {
  const next = key == null ? '' : String(key);
  if (!slot) return 0;
  if (slot.key === next) return slot.generation || 0;
  slot.key = next;
  slot.generation = (slot.generation || 0) + 1;
  return slot.generation;
}

function cleanLook(look) {
  const displays = [];
  for (const d of look && Array.isArray(look.displays) ? look.displays : []) {
    if (!d || typeof d.uuid !== 'string' || !d.uuid) continue;
    const spaces = [];
    for (const id of Array.isArray(d.spaces) ? d.spaces : []) {
      if (typeof id === 'string' && SPACE_ID.test(id) && id !== '0' && !spaces.includes(id)) spaces.push(id);
    }
    if (!spaces.length) continue;
    const current = typeof d.current === 'string' && spaces.includes(d.current) ? d.current : '';
    let cgId = '';
    if (typeof d.cgId === 'number' && Number.isSafeInteger(d.cgId) && d.cgId > 0) cgId = String(d.cgId);
    else if (typeof d.cgId === 'string' && /^\d+$/.test(d.cgId) && d.cgId !== '0') cgId = d.cgId;
    displays.push({ uuid: d.uuid, cgId, current, spaces });
  }
  return displays;
}

// { ok: true, spaceId, displayId, index, count } or { ok: false, why, edge? }.
// More than one display, a shared desktop id, or spans-displays: refuse. One display can move,
// because there is no other display to take with it.
function planSwitch(look, request) {
  const dir = request && request.dir;
  if (dir !== -1 && dir !== 1) return { ok: false, why: 'dir' };
  const displayId = request && request.displayId != null ? String(request.displayId) : '';
  if (!/^\d+$/.test(displayId) || displayId === '0') return { ok: false, why: 'display' };
  const displays = cleanLook(look);
  if (!displays.length) return { ok: false, why: 'unavailable' };
  const owner = new Map();
  let shared = false;
  for (const d of displays) {
    for (const id of d.spaces) {
      const prev = owner.get(id);
      if (prev && prev !== d.uuid) shared = true;
      else owner.set(id, d.uuid);
    }
  }
  const mine = displays.find((d) => d.cgId === displayId);
  if (!mine || !mine.current) return { ok: false, why: mine ? 'unavailable' : 'display' };
  if (!look || look.composed !== true) return { ok: false, why: 'composed' };
  const others = displays.some((d) => d.uuid !== mine.uuid);
  if (others && (look.spans === true || shared)) return { ok: false, why: 'spans' };
  if (others && displays.some((d) => !d.cgId)) return { ok: false, why: 'unavailable' };
  const index = mine.spaces.indexOf(mine.current);
  const next = index + dir;
  if (next < 0 || next >= mine.spaces.length) return { ok: false, why: 'edge', edge: dir < 0 ? 'first' : 'last' };
  const spaceId = mine.spaces[next];
  if (owner.get(spaceId) !== mine.uuid) return { ok: false, why: 'spans' };
  return { ok: true, spaceId, displayId, index: next, count: mine.spaces.length };
}

// The phone may show Previous and Next only when this viewed display has its own other
// desktop and the composition read is clean. An edge still shows both: the Mac answers
// which end it is. A missing picture, a shared desktop, or windows from another desktop
// show nothing.
function offerSpaces(look, viewed) {
  // Missing ax is not trust. Held input means a press would be refused and touches
  // are already paused, so the buttons stay off.
  if (!look || look.ax !== true || look.inputHeld === true) return false;
  if (!viewed || viewed.id == null) return false;
  const id = String(viewed.id);
  if (!/^\d+$/.test(id) || id === '0') return false;
  const next = planSwitch(look, { displayId: id, dir: 1 });
  const prev = planSwitch(look, { displayId: id, dir: -1 });
  return next.ok === true || prev.ok === true;
}

// One-to-one stream input. Null: this message is not the authenticated current session.
// The returned function is false once that session is gone or replaced (a stale socket).
function streamInputGate(ctx, readCurrent) {
  const live = (c) => !!(c && c.authed === true && !c.released && c.ws && c.ws.readyState === 1);
  if (!live(ctx) || ctx.deviceId == null) return null;
  const current = readCurrent();
  if (!live(current) || current.ws !== ctx.ws || current.deviceId !== ctx.deviceId) return null;
  const ws = ctx.ws;
  const deviceId = ctx.deviceId;
  return () => {
    const now = readCurrent();
    return !!(live(ctx) && live(now) && now.ws === ws && now.deviceId === deviceId);
  };
}

// Mesh session. The live connection is the guest link when that is up, otherwise the host
// socket. A replacement socket or a link that is no longer authenticated fails the later check.
function meshGate(readSession) {
  const live = (ctx) => !!(ctx && ctx.authed === true && !ctx.released && ctx.ws && ctx.ws.readyState === 1);
  const session = readSession();
  if (!session || session.connected !== true) return null;
  let token = null;
  if (session.linkUp === true) {
    if (!live(session.link)) return null;
    token = { kind: 'link', link: session.link, ws: session.link.ws };
  } else if (session.hostUp === true) {
    if (!live(session.ctx)) return null;
    token = { kind: 'ctx', ctx: session.ctx, ws: session.ctx.ws };
  }
  if (!token) return null;
  return () => {
    const now = readSession();
    if (!now || now.connected !== true) return false;
    if (token.kind === 'link') return now.link === token.link && now.linkUp === true && live(now.link) && now.link.ws === token.ws;
    return now.hostUp === true && now.linkUp !== true && now.ctx === token.ctx && live(now.ctx) && now.ctx.ws === token.ws;
  };
}

// '' when remote input is not paused. Otherwise the reason a touch must not be sent.
function spaceHold(look) {
  if (!look || look.inputHeld !== true) return '';
  return look.holdWhy === 'overview' ? 'overview' : 'accessibility';
}

module.exports = {
  dirOf, viewedDisplay, resolveTarget, viewToken, sameView, noteGeneration,
  planSwitch, offerSpaces, spaceHold, streamInputGate, meshGate,
};
