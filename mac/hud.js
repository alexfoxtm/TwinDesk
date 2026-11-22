// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The popup that says where the mouse and keyboard are: a small pill at
// the bottom of the screen under the pointer, like the volume HUD. Click-through, on every Space,
// never captured into a screen stream (content protection), off with General › "Show a popup".
// The window is created on the first popup (that show waits for loadFile) and goes IDLE_MS after
// it hides, unless keep() says one is about to show. A linked session does not keep it.
'use strict';

const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const I18n = require('../shared/i18n.js');

const W = 360, H = 64, SHOW_MS = 1400;
const BIG_W = 460, BIG_H = 230, BIG_MS = 2200; // the sharing on/off card
const IDLE_MS = 30000;

class Hud {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.win = null;
    this.ready = null;
    this.timer = null;
    this.idleTimer = null;
    this.keep = () => false; // main leaves this false: a session is not a popup
  }

  // A popup is about to show: the window now, so that show does not wait for loadFile.
  warm() {
    if (this.getSettings().app.hud === false) return;
    clearTimeout(this.idleTimer);
    this._ensure();
  }

  // The window goes when nothing needs it: keep() is false, nothing showing, for IDLE_MS.
  idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.keep() || !this.win || this.win.isDestroyed() || this.win.isVisible()) return;
      const w = this.win;
      this.win = null;
      this.ready = null;
      w.destroy();
    }, IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _ensure() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, transparent: true, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, type: 'panel', alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload-hud.js'), contextIsolation: true, nodeIntegration: false },
    });
    this.win.setIgnoreMouseEvents(true);
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setContentProtection(true); // never in a screen share or Monitor 2
    this.ready = this.win.loadFile(path.join(__dirname, 'hud.html'), { query: { language: I18n.resolveLanguage((this.getSettings().ui || {}).language, app.getLocale()) } });
    return this.ready;
  }

  _forget() {
    // A page that failed to load leaves a live window behind: close it with the reference.
    const w = this.win;
    this.win = null;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) { /* already gone */ }
    this.ready = null;
  }

  // kind: 'away' (we use the other computer), 'driven' (it uses this Mac), 'home';
  // 'linkOn' / 'linkOff': the big card in the middle of the screen (sharing switched on/off), with `sub`.
  // 'lock': cursor lock on/off.
  show(kind, text, sub = '') {
    const big = kind === 'linkOn' || kind === 'linkOff';
    if (this.getSettings().app.hud === false && !big && kind !== 'lock') return Promise.resolve(); // the on/off card and the lock always show
    // A popup asked while the idle timer is pending must not be destroyed by it, including
    // one that is still queued behind a popup whose page is loading.
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // The first of a burst starts now, so its window exists before this returns. A later one
    // waits until that show has finished, which keeps them in order.
    const run = () => this._show(kind, text, sub);
    const next = this._showChain ? this._showChain.then(run, run) : run();
    const settled = next.then(() => {}, () => {});
    this._showChain = settled;
    settled.then(() => { if (this._showChain === settled) this._showChain = null; });
    return next;
  }

  async _show(kind, text, sub = '') {
    const big = kind === 'linkOn' || kind === 'linkOff';
    if (this.getSettings().app.hud === false && !big && kind !== 'lock') return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      await this._ensure();
    } catch {
      this._forget();
    }
    // The page load can outlive the window (it was destroyed while loading). Make another.
    if (!this.win || this.win.isDestroyed()) {
      this._forget();
      try { await this._ensure(); } catch { return; }
    }
    if (!this.win || this.win.isDestroyed()) return;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = big ? [BIG_W, BIG_H] : [W, H];
    const y = big ? d.y + (d.height - h) / 2 - d.height * 0.08 : d.y + d.height - h - 72;
    this.win.setBounds({ x: Math.round(d.x + (d.width - w) / 2), y: Math.round(y), width: w, height: h });
    this.win.webContents.send('hud', { kind, text, sub });
    this.win.showInactive();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('hud', { kind: 'hide' });
      this.timer = setTimeout(() => {
        if (this.win && !this.win.isDestroyed()) this.win.hide();
        if (!this.keep()) this.idle();
      }, 400);
    }, big ? BIG_MS : SHOW_MS);
  }
}

module.exports = { Hud };
