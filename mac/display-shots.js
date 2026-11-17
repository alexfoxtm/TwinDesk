// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Session-memory pictures of the desktops the catalog already allows.
//
// Each shot is one helper displayShot of one display id. The helper uses ScreenCaptureKit
// on macOS 14 and refuses everywhere else. This file does not ask Electron for a thumbnail.
// Before the request and after it returns, the same authenticated socket, capture session,
// view generation, current space, unlocked screen, and hidden Mission Control must still
// hold. A miss, a late reply, or a timeout drops the bytes. The cache is not written to disk.
'use strict';

const P = require('../shared/protocol.js');
const Preview = require('../shared/display-preview.js');

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (timer.unref) timer.unref();
  return timer;
}

class DisplayShots {
  constructor({ helper, readLocked, freshLook, sample, send, wait, schedule, clearTimer, now }) {
    this.helper = helper;
    this.readLocked = readLocked;
    this.freshLook = freshLook;
    this.sample = sample;
    this.send = send;
    this.wait = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.schedule = schedule || defaultSchedule;
    this.clearTimer = clearTimer || ((timer) => clearTimeout(timer));
    this.now = now || (() => Date.now());
    this.bags = new Map();
    this.ticket = 0;
    this.running = false;
    this.again = false;
    this.pending = Promise.resolve();
    this.timer = null;
    this.lastAt = 0;
  }

  kick() {
    if (this.running) {
      this.again = true;
      return this.pending;
    }
    this.pending = this._run();
    return this.pending;
  }

  _sample() {
    try {
      const value = this.sample();
      if (!value || typeof value !== 'object') return null;
      // Copy the fence. The caller's object stays live, so a later read has to see a new
      // socket or capture session instead of the one this pass started with.
      return {
        conn: value.conn,
        ws: value.conn ? value.conn.ws : null,
        sharing: value.sharing === true,
        catalog: value.catalog,
        capture: value.capture,
        viewGen: value.viewGen,
      };
    } catch (_) {
      return null;
    }
  }

  _bag(conn) {
    let bag = this.bags.get(conn);
    if (!bag) {
      bag = { shots: new Map(), bytes: 0, sent: false, notice: '', noticeAt: 0 };
      this.bags.set(conn, bag);
      this._capBags(conn);
    }
    return bag;
  }

  _capBags(keep) {
    while (this.bags.size > Preview.MAX_BAGS) {
      let drop = null;
      for (const conn of this.bags.keys()) {
        if (conn !== keep) { drop = conn; break; }
      }
      if (!drop) break;
      this.bags.delete(drop);
    }
  }

  _prune() {
    for (const conn of this.bags.keys()) {
      if (!Preview.liveConn(conn)) this.bags.delete(conn);
    }
  }

  _same(started, now) {
    return !!(now && started && now.conn === started.conn && now.conn && now.ws === started.ws
      && now.conn.ws === started.ws
      && now.capture === started.capture && now.viewGen === started.viewGen
      && now.sharing === true && Preview.liveConn(now.conn));
  }

  _clear(sample, bag) {
    if (!bag || (!bag.sent && bag.shots.size === 0)) return;
    bag.shots.clear();
    bag.bytes = 0;
    bag.sent = false;
    if (sample && Preview.liveConn(sample.conn)) {
      try { this.send(sample.conn, { t: P.T.SCREEN_PREVIEW, clear: true }); } catch (_) { /* the socket is already gone */ }
    }
  }

  _notice(sample, bag, code) {
    if (code !== 'os' && code !== 'permission') return;
    bag.notice = code;
    bag.noticeAt = this.now();
    if (!Preview.liveConn(sample.conn)) return;
    try { this.send(sample.conn, { t: P.T.SCREEN_PREVIEW, unavailable: code }); } catch (_) { /* the socket is already gone */ }
  }

  _retain(bag, catalog) {
    const allowed = new Set(Preview.currentTargets(catalog).concat(this._listed(catalog)).map((t) => Preview.key(t.displayId, t.spaceId)));
    for (const id of bag.shots.keys()) {
      if (!allowed.has(id)) {
        bag.bytes -= bag.shots.get(id).jpeg.length;
        bag.shots.delete(id);
      }
    }
  }

  // Every space the catalog still lists, so a last-seen image of a desktop that is no
  // longer current can stay. A display that left the catalog cannot.
  _listed(catalog) {
    const out = [];
    const displays = catalog && Array.isArray(catalog.displays) ? catalog.displays : [];
    for (const d of displays) {
      if (!d || typeof d.id !== 'string') continue;
      const spaces = Array.isArray(d.spaces) ? d.spaces : [];
      for (const spaceId of spaces) {
        if (typeof spaceId === 'string') out.push({ displayId: d.id, spaceId });
      }
    }
    return out;
  }

  _store(bag, fence, jpeg, width, height) {
    const id = Preview.key(fence.displayId, fence.spaceId);
    const prev = bag.shots.get(id);
    if (prev) bag.bytes -= prev.jpeg.length;
    bag.shots.set(id, { jpeg, width, height, at: this.now(), capture: fence.capture, viewGen: fence.viewGen });
    bag.bytes += jpeg.length;
    while (bag.shots.size > Preview.MAX_SHOTS || bag.bytes > Preview.MAX_STORE_BYTES) {
      let oldest = null;
      for (const [shotId, shot] of bag.shots) {
        if (!oldest || shot.at < oldest.at) oldest = { shotId, at: shot.at };
      }
      if (!oldest) break;
      bag.bytes -= bag.shots.get(oldest.shotId).jpeg.length;
      bag.shots.delete(oldest.shotId);
    }
  }

  _arm(ms) {
    if (this.timer) return;
    const delay = Math.max(250, Math.min(ms, Preview.REFRESH_MS));
    this.timer = this.schedule(() => {
      this.timer = null;
      this.kick();
    }, delay);
  }

  _scheduleNext(targets, bag) {
    const due = Preview.dueIn(targets, bag.shots, this.now());
    if (due == null) return;
    const gap = Math.max(0, Preview.MIN_GAP_MS - (this.now() - this.lastAt));
    this._arm(due === 0 ? Math.max(gap, 250) : Math.max(due, gap));
  }

  async _run() {
    this.running = true;
    try {
      do {
        this.again = false;
        await this._pass();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  async _pass() {
    this._prune();
    const sample = this._sample();
    if (!sample || !sample.conn) return;
    const bag = this._bag(sample.conn);
    if (!sample.sharing || !Preview.liveConn(sample.conn)) {
      this._clear(sample, bag);
      return;
    }
    let locked;
    try { locked = await this.readLocked(); } catch (_) { return; }
    if (!this._same(sample, this._sample())) return;
    if (!Preview.screenUnlocked(locked)) {
      this._clear(sample, bag);
      return;
    }
    if (!sample.catalog) return;
    this._retain(bag, sample.catalog);
    if (bag.notice === 'os') return;
    if (bag.notice === 'permission' && this.now() - bag.noticeAt < Preview.REFRESH_MS) {
      this._arm(Preview.REFRESH_MS - (this.now() - bag.noticeAt));
      return;
    }
    const targets = Preview.currentTargets(sample.catalog);
    const gapOk = this.now() - this.lastAt >= Preview.MIN_GAP_MS;
    const want = Preview.choose(targets, bag.shots, this.now(), gapOk);
    if (!want) {
      this._scheduleNext(targets, bag);
      return;
    }
    const displayNum = Preview.displayNumber(want.displayId);
    if (displayNum == null || !Preview.fenceReady({
      conn: sample.conn, capture: sample.capture, viewGen: sample.viewGen,
      displayId: want.displayId, spaceId: want.spaceId,
    })) return;
    let look;
    try { look = await this.freshLook(); } catch (_) { return; }
    if (!this._same(sample, this._sample())) return;
    let lockedAgain;
    try { lockedAgain = await this.readLocked(); } catch (_) { return; }
    if (!this._same(sample, this._sample())) return;
    if (!Preview.screenUnlocked(lockedAgain) || !Preview.missionHidden(look)) return;
    if (Preview.currentSpaceId(look, want.displayId) !== want.spaceId) return;
    if (!Preview.catalogPermits(sample.catalog, want.displayId)) return;
    const ticket = ++this.ticket;
    this.lastAt = this.now();
    let result;
    try {
      result = await Promise.race([
        this.helper.request('displayShot', { displayId: displayNum }, Preview.TIMEOUT_MS + 250)
          .then((value) => ({ value }))
          .catch((error) => ({ error })),
        this.wait(Preview.TIMEOUT_MS).then(() => ({ timeout: true })),
      ]);
    } catch (_) {
      return;
    }
    if (ticket !== this.ticket) return;
    if (!result || result.timeout) {
      this.ticket += 1;
      this._scheduleNext(targets, bag);
      return;
    }
    const after = this._sample();
    if (!this._same(sample, after)) return;
    if (result.error || !result.value) return;
    const body = result.value;
    if (body.unavailable) {
      this._clear(after, bag);
      this._notice(after, bag, body.unavailable);
      // macOS 13 stays refused. A missing Screen Recording permission is checked again later.
      if (bag.notice === 'permission') this._arm(Preview.REFRESH_MS);
      return;
    }
    let afterLocked;
    let afterLook;
    try {
      afterLocked = await this.readLocked();
      afterLook = await this.freshLook();
    } catch (_) {
      return;
    }
    if (ticket !== this.ticket) return;
    const again = this._sample();
    if (!this._same(sample, again)) return;
    if (!Preview.screenUnlocked(afterLocked) || !Preview.missionHidden(afterLook)) return;
    if (Preview.currentSpaceId(afterLook, want.displayId) !== want.spaceId) return;
    if (!Preview.catalogPermits(again.catalog, want.displayId)) return;
    if (String(body.displayId) !== want.displayId) return;
    const jpeg = Preview.decodeJpeg(body.jpeg);
    if (!Preview.acceptJpeg(jpeg, body.width, body.height)) return;
    this._store(bag, {
      displayId: want.displayId,
      spaceId: want.spaceId,
      capture: sample.capture,
      viewGen: sample.viewGen,
    }, jpeg, body.width, body.height);
    try {
      this.send(again.conn, {
        t: P.T.SCREEN_PREVIEW,
        displayId: want.displayId,
        spaceId: want.spaceId,
        capture: sample.capture,
        viewGen: sample.viewGen,
        width: body.width,
        height: body.height,
        jpeg: jpeg.toString('base64'),
      });
      bag.sent = true;
      bag.notice = '';
    } catch (_) { /* the socket is already gone */ }
    this._scheduleNext(Preview.currentTargets(again.catalog), bag);
  }
}

module.exports = { DisplayShots };
