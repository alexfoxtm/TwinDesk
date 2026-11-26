// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A phone's notification in TwinDesk's own small window (Notifications › Style: TwinDesk), instead
// of the system's: its app, title and text, a picture when it has one, a progress bar that fills in
// place (a download, a timer), a one-time code's Copy, the phone's own buttons (Mark as read…) and
// Reply, typed right there. What the system's notifications can't do on Windows and Linux.
// One window per notification, stacked in the corner the system's use (top right on a Mac and
// Linux, bottom right on Windows), at most MAX; they never take the keyboard until Reply is clicked.
//
//   const pop = new NotifPop({ corner, getLanguage, act(id, i), reply(item, text), dismiss(id), open(item), copy(code) })
//   pop.show(item, { icon, from, code })   new, or the same id again: changed in place
//   pop.gone(id, from?)                    gone from the phone (from: that origin only): its window
//                                          goes; one with Reply open stays, Reply off, its text kept
//   pop.closeAll()
// item: {id, app, appName, title, subtitle, body, at, reply, actions, pic?, avatar?, live?}
//   live: {v, max, ind?, done?} a progress bar (ind: no known end; done: it finished)
// Main process only (Electron). richOf(m) checks what the phone sent; used without Electron too.
'use strict';

const path = require('path');

const W = 380;
const GAP = 8;
const MAX = 3;
const SHOW_MS = 7000; // as long as a system notification stays
const DONE_MS = 4000; // a finished progress bar, then it goes

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const PIC = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

// The extras a phone's notif may carry, checked: a picture (big picture style), a person's or a
// chat's picture (avatar), and a live progress bar.
function richOf(m) {
  const out = {};
  if (typeof m.pic === 'string' && m.pic.length < 400000 && PIC.test(m.pic)) out.pic = m.pic;
  if (typeof m.avatar === 'string' && m.avatar.length < 60000 && PIC.test(m.avatar)) out.avatar = m.avatar;
  const l = m.live;
  if (l && typeof l === 'object') {
    const max = Math.max(0, Math.round(Number(l.max) || 0));
    const v = Math.max(0, Math.min(max, Math.round(Number(l.v) || 0)));
    out.live = { v, max, ind: l.ind === true, done: l.done === true };
  }
  return out;
}

class NotifPop {
  constructor(opts) {
    this.opts = opts || {};
    this.wins = []; // newest first: {id, win, item, extra, timer, hover, typing, h}
    this.closed = new Set(); // live ones closed here: their next updates don't bring them back
    this._wired = false;
  }

  _wire() {
    if (this._wired) return;
    this._wired = true;
    const { ipcMain } = require('electron');
    const of = (e) => this.wins.find((w) => w.win && !w.win.isDestroyed() && w.win.webContents === e.sender);
    ipcMain.handle('notifpop:get', (e) => { const w = of(e); return w ? this._view(w) : null; });
    ipcMain.on('notifpop:size', (e, h) => {
      const w = of(e);
      if (!w) return;
      w.h = Math.max(60, Math.min(560, Math.round(Number(h) || 0)));
      this._place();
      if (!w.shown && w.win && !w.win.isDestroyed()) { w.shown = true; w.win.showInactive(); }
    });
    ipcMain.on('notifpop:hover', (e, on) => {
      const w = of(e);
      if (!w) return;
      w.hover = !!on;
      this._arm(w);
      if (w.hover && w.extra.otpId && this.opts.armTarget) void this.opts.armTarget(w.extra.otpId);
    });
    ipcMain.on('notifpop:typing', (e) => {
      const w = of(e);
      if (!w) return;
      w.typing = true;
      this._arm(w);
      try { w.win.setFocusable(true); w.win.focus(); w.win.webContents.focus(); } catch (_) { /* typed after a click */ }
    });
    ipcMain.on('notifpop:act', (e, i) => {
      const w = of(e);
      if (!w || w.expired || !this.opts.act) return;
      this.opts.act(w.id, Number(i), w.item); // its own origin's notification only
      this._close(w);
    });
    ipcMain.on('notifpop:reply', (e, text) => {
      const w = of(e);
      if (!w || w.expired || !this.opts.reply || typeof text !== 'string' || !text.trim()) return;
      // Refused: the window stays with the typed text and says so; it never retries by itself.
      const done = (ok) => {
        if (ok !== false) return this._close(w);
        w.notice = 'refused';
        this._state(w);
      };
      const ok = this.opts.reply(w.item, text.slice(0, 5000));
      if (ok && typeof ok.then === 'function') ok.then(done, () => done(false));
      else done(ok);
    });
    ipcMain.on('notifpop:copy', (e) => {
      const w = of(e);
      if (!w || !w.extra.code) return;
      if (this.opts.copy) this.opts.copy(w.extra.code);
      else require('./otp.js').quietCopy(w.extra.code);
    });
    ipcMain.handle('notifpop:useCode', async (e) => {
      const w = of(e);
      if (!w || w.expired || !w.extra.code || !w.extra.otpId || !this.opts.useCode) return { ok: false, mode: 'refused' };
      const res = await Promise.resolve(this.opts.useCode(w.extra.otpId, w.extra.code, w.item)).catch(() => ({ ok: false, mode: 'refused' }));
      if (res && res.ok && res.mode === 'filled') {
        const t = setTimeout(() => this._close(w), 450);
        if (t && typeof t.unref === 'function') t.unref();
      }
      return res || { ok: false, mode: 'refused' };
    });
    ipcMain.on('notifpop:open', (e) => { const w = of(e); if (w) { if (this.opts.open) this.opts.open(w.item); this._close(w); } });
    ipcMain.on('notifpop:close', (e) => { const w = of(e); if (w) this._close(w); });
    ipcMain.on('notifpop:dismiss', (e) => { const w = of(e); if (w) { if (this.opts.dismiss && !w.expired) this.opts.dismiss(w.id, w.item); this._close(w); } });
  }

  _view(w) {
    const it = w.item;
    return {
      app: it.appName || it.app || '', from: w.extra.from || '', title: it.title || '', subtitle: it.subtitle || '', body: it.body || '',
      at: it.at || Date.now(), icon: w.extra.icon || '', pic: it.pic || '', avatar: it.avatar || '', live: it.live || null,
      code: w.extra.code || '', canUseCode: !!(w.extra.code && w.extra.otpId && this.opts.useCode && !w.expired),
      actions: w.expired ? [] : it.actions || [], reply: !!(it.reply && this.opts.reply && !w.expired),
      dismiss: !!this.opts.dismiss && !w.expired, notice: w.expired ? 'expired' : w.notice || '',
    };
  }

  _state(w) {
    if (w.win && !w.win.isDestroyed()) w.win.webContents.send('notifpop:state', this._view(w));
  }

  show(item, extra = {}) {
    if (!item || !item.id) return;
    this._wire();
    if (item.live && this.closed.has(item.id)) return; // closed while it was filling
    // An open Reply draft stays bound to its own device, session and offer: a reused ID from
    // another phone or a new offer gets its own window instead of replacing the draft's target.
    const had = this.wins.find((w) => w.id === item.id && !w.pinned);
    if (had && had.typing && (had.item.from !== item.from || had.item.replySession !== item.replySession)) had.pinned = true;
    else if (had) {
      had.item = item;
      had.extra = { ...had.extra, ...extra };
      had.expired = false;
      had.notice = '';
      this._state(had);
      this._arm(had);
      return;
    }
    // A finished progress bar never seen start: nothing to show it filling, a plain one is enough.
    const w = { id: item.id, item, extra, h: 120 };
    this.wins.unshift(w);
    while (this.wins.length > MAX) this._close(this.wins[this.wins.length - 1]);
    if (extra && extra.otpId && this.opts.armTarget) void this.opts.armTarget(extra.otpId);
    this._open(w);
    this._arm(w);
  }

  gone(id, from) {
    for (const w of this.wins.filter((x) => x.id === id && (from === undefined || (x.item && x.item.from === from)))) {
      if (!w.typing) { this._close(w); continue; }
      // A Reply being typed: its offer is gone, but the words stay until closed here.
      w.expired = true;
      this._state(w);
    }
  }

  closeAll() {
    for (const w of [...this.wins]) this._close(w);
  }

  // Closes by itself: SHOW_MS after it last changed, never while the pointer is on it or Reply is
  // open; a progress bar stays until it's done.
  _arm(w) {
    clearTimeout(w.timer);
    if (w.hover || w.typing) return;
    const l = w.item.live;
    if (l && !l.done) return;
    w.timer = setTimeout(() => this._close(w), l && l.done ? DONE_MS : SHOW_MS);
  }

  _open(w) {
    const { BrowserWindow, nativeTheme } = require('electron');
    const win = new BrowserWindow({
      width: W, height: w.h, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, title: 'TwinDesk',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#2a2a2c' : '#ffffff',
      webPreferences: { preload: path.join(__dirname, 'preload-notifpop.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.win = win;
    win.setAlwaysOnTop(true, 'pop-up-menu');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'notifpop.html'), { query: { language: this.opts.getLanguage ? this.opts.getLanguage() : 'en' } });
    win.on('closed', () => {
      clearTimeout(w.timer);
      w.win = null;
      this.wins = this.wins.filter((x) => x !== w);
      this._place();
    });
    this._place();
  }

  _close(w) {
    clearTimeout(w.timer);
    if (w.item.live && !w.item.live.done) {
      this.closed.add(w.id);
      if (this.closed.size > 50) this.closed.delete(this.closed.values().next().value);
    }
    this.wins = this.wins.filter((x) => x !== w);
    if (w.win && !w.win.isDestroyed()) w.win.close();
    w.win = null;
    this._place();
  }

  // The newest nearest the corner, the others stacked away from it.
  _place() {
    const { screen } = require('electron');
    const a = screen.getPrimaryDisplay().workArea;
    const bottom = this.opts.corner === 'bottom';
    let off = 12;
    for (const w of this.wins) {
      if (!w.win || w.win.isDestroyed()) continue;
      const y = bottom ? a.y + a.height - off - w.h : a.y + off;
      try { w.win.setBounds({ x: a.x + a.width - W - 12, y: Math.round(y), width: W, height: w.h }); } catch (_) { /* closing */ }
      off += w.h + GAP;
    }
  }
}

// Notifications › Pop-ups: 'twindesk' (this window) or 'system'. Unset: the system's, the lightest
// (no window, and the phone sends no pictures or progress: notifs.js's policy, rich).
function popupOn(cfg) {
  return !!cfg && cfg.style === 'twindesk';
}

module.exports = { NotifPop, richOf, popupOn, str };
