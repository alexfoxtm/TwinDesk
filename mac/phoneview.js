// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone in windows on the Mac: its screen (mirror, with its sound), and phone apps each in a
// window of their own on a virtual display of the window's size (scrcpy new_display + flex, so
// resizing the window resizes the app). One scrcpy session per window (scrcpy.js); the window
// decodes the H.264 itself (phoneview-renderer.js) and sends touches, keys and scrolls back.
// A phone app with windows here has a Dock icon of its own (dockstub.js, like a PC app), and pin()
// keeps it in the Dock: opened from there, it asks TwinDesk for alexfoxtm-twindesk://pc-app/phone:<package>.
//
// A phone notification clicked on the Mac opens its app here (openNotified): the phone wakes and
// asks for its unlock first if it's locked (Wake.kt), as the app's window would show the lock screen.
//
// Events: 'change' — the window list changed.
'use strict';

const path = require('path');
const { existsSync } = require('node:fs');
const { app, BrowserWindow, clipboard, dialog, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const I18n = require('../shared/i18n.js');
const { Session, ACTION, TYPE } = require('./scrcpy');
const { NativeScreen, screenSize } = require('../shared/nativescreen.js');
const iosusb = require('./iosusb.js'); // an iPhone's screen over its cable
const { uhidKey } = require('../shared/uhidkbd.js');
const { KeyState, ANDROID } = require('./android-keys');
const chat = require('../shared/phonechat.js');
const { MirrorSave } = require('../shared/mirror-save.js');
const { DockStub, addToDock } = require('./dockstub');
const { AppPanel } = require('./app-panel.js');
const { startApp } = require('../shared/appstart.js');
const { pairedIPad, matchesIPad, stopIPad, handleIPad, installIPadQuitDrain } = require('./phoneview-ipad');
const { runnerTemplate } = require('./iosctl-xctest');

const T = P.T;
const PHONEVIEW_BAR = 32; // #stage inset in phoneview.css
const IPAD_CONTROL_BAR = 32;
const NOTIFIED_MS = 60000; // how long a clicked notification waits for the unlock and wireless debugging
let nextId = 1;
let quitting = false; // a camera's window hides on close, but not on quit
app.on('before-quit', () => { quitting = true; });
installIPadQuitDrain(app);

class PhoneViews extends EventEmitter {
  constructor({ bridge, phone, getSettings, server, fileSend }) {
    super();
    Object.assign(this, { bridge, phone, getSettings, server, fileSend });
    this.appPanel = new AppPanel(bridge, server);
    this.views = new Map(); // id -> {id, kind, app, title, win, session, keys, size}
    this.stubs = new Map(); // package -> DockStub, while that app has a window here
    bridge.views = this;
    this.on('change', () => bridge._tellPhone()); // its Screen and Camera pages follow the windows here
    this.on('change', () => bridge._sound()); // a Native screen window with its sound takes the phone's own capture
    this.notified = null; // {pkg, name, at, unlocked}: a clicked notification's app, waiting to open
    // The app in front on the phone, which its Accessibility says (the full app): Return in a chat
    // app sends (shared/phonechat.js); a11y: the phone clicks Send itself.
    this.activeApp = '';
    this.a11y = false;
    this.multipleApps = true;
    server.on(`t:${T.PHONE_ACTIVE_APP}`, (m) => {
      if (!m || typeof m.pkg !== 'string') return;
      if ((this.activeApp !== m.pkg || m.multi !== false) && this.bridge.pan) this.bridge.pan.end();
      this.activeApp = m.pkg.slice(0, 200);
      this.multipleApps = m.multi !== false;
      this.a11y = true;
    });
    server.on('closed', () => {
      for (const v of this.views.values()) stopIPad(this, v, 'lost');
      this.activeApp = '';
      this.multipleApps = true;
      this.a11y = false;
      if (!this.appPanel.owns(this.appPanel.current)) this.releaseAppPanel();
    });
    const checkIPads = () => {
      for (const v of this.views.values()) {
        if (v.ipadLease && !matchesIPad(this, v.ipadOwner)) stopIPad(this, v, 'lost');
      }
    };
    server.on('client', checkIPads);
    server.on('transport', checkIPads);
    server.on(`t:${T.PHONE_MIRROR_STATE}`, (m, ctx, ws) => {
      const socket = this.server.route ? ctx?.conn : ws;
      for (const v of this.views.values()) {
        if (!v.ipadOwner || !m || m.key !== v.session?.secret || ctx?.authed !== true || ctx.deviceId !== v.ipadOwner.pair.id
            || socket !== v.ipadOwner.socket || !v.session.owns() || !matchesIPad(this, v.ipadOwner) || !m.on || !Number.isInteger(m.sw) || !Number.isInteger(m.sh)) continue;
        if (v.ipadGeometry?.w !== m.sw || v.ipadGeometry?.h !== m.sh) v.ipadGeometry = { w: m.sw, h: m.sh };
      }
    });
    server.on(`t:${T.PHONE_AWAKE}`, (m) => this._awake(m));
    // The phone's own Show and Close (its Screen page): its screen in a window here (openScreen
    // decides how: wireless debugging, Wi-Fi first when on Bluetooth, or a popup saying what's
    // missing), or its windows here closed (not the hidden ones playing its sound).
    // The phone's own Camera page: its camera running here (the Camera tab's picture, the virtual
    // camera), back or front, or stopped.
    server.on(`t:${T.PHONE_CAMERA}`, (m) => {
      if (m && m.open === false) {
        for (const v of this.list()) if (v.kind === 'camera') this.close(v.id);
      } else this.openCamera({ facing: m && m.facing });
    });
    server.on(`t:${T.PHONE_MIRROR}`, (m, ctx) => {
      if (ctx?.os === P.OS.IOS && !this._currentIosMessage(ctx)) return;
      if (m && m.open === false) {
        this.openingIos = null;
        // ReplayKit sends a keyed state before this legacy close message.
        for (const v of this.views.values()) {
          if (['sound', 'netsound', 'mic'].includes(v.kind)) continue;
          if (ctx?.os === P.OS.IOS && (!v.ios || !v.session?.closed)) continue;
          this.close(v.id);
        }
      } else this.openScreen(ctx?.os === P.OS.IOS);
    });
    bridge.on('change', () => {
      if (this.appPanel.current && !this.appPanel.owns(this.appPanel.current)) this.releaseAppPanel();
      this._openNotified();
    });
    server.on('closed', () => { this.notified = null; });
    // The side rail's Screenshot and Record (shared/mirror-rail.js): copied and saved here.
    this.saver = new MirrorSave({
      electron: require('electron'),
      popup: (key, vars) => this.bridge.emit('popup', 'away', { key, vars }),
      name: () => (this.server.current && this.server.current.name) || this._i18n().t('Phone'),
    });
    ipcMain.on('phoneview:in', (e, m) => {
      const v = [...this.views.values()].find((x) => x.win && !x.win.isDestroyed() && x.win.webContents === e.sender);
      if (!v || (v.ipadOwner && (v.ending || e.senderFrame !== e.sender.mainFrame))) return;
      if (this.saver.handle(v.id, m)) return;
      if (m && typeof m === 'object') this._input(v, m);
    });
    // Files dropped on a phone window go to the phone (its Downloads).
    ipcMain.on('phoneview:drop', (e, paths) => {
      if (!Array.isArray(paths) || !paths.length || !this.server.current) return;
      const b = this.fileSend.sendBatch(paths.filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 1000), 'send');
      if (b) this.bridge.emit('popup', 'away', `Sending ${b.name} to ${this.server.current.name}`);
    });
  }

  // The phone's sound on its own (no screen window): an audio-only session in a hidden window.
  sound(on) {
    const open = [...this.views.values()].find((v) => v.kind === 'sound');
    if (on && !open && this.bridge.serial) {
      this._open({ kind: 'sound', title: this._i18n().t('Phone sound'), titleKey: 'Phone sound', width: 200, height: 100, hidden: true, opts: { video: false, audio: true, control: false, audioSource: 'output' } });
    } else if (!on && open) this.close(open.id);
  }

  // The phone's microphone as a microphone here (Audio › Microphone, Android 11 or later): an
  // audio-only session capturing the phone's mic, in a hidden window that plays it into the
  // TwinDesk Microphone (Linux) or a virtual audio cable (phoneview-renderer.js picks it).
  mic(on, out = '') {
    const open = [...this.views.values()].find((v) => v.kind === 'mic' && !v.net);
    if (open && on && open.sink !== out) this.close(open.id); // another output picked: start again
    else if (open && on) return;
    if (on && this.bridge.serial) {
      this._open({ kind: 'mic', title: this._i18n().t('Phone microphone'), titleKey: 'Phone microphone', width: 200, height: 100, hidden: true, sink: out, opts: { video: false, audio: true, control: false, audioSource: 'mic' } });
    } else if (!on && open) this.close(open.id);
  }

  // The phone's sound captured by the phone itself (no wireless debugging, phone-bridge.js): a
  // hidden window with no adb session, fed what comes through the session.
  netSound(on) {
    const open = [...this.views.values()].find((v) => v.kind === 'netsound');
    if (on && !open) this._open({ kind: 'netsound', title: this._i18n().t('Phone sound'), titleKey: 'Phone sound', width: 200, height: 100, hidden: true });
    else if (!on && open) this.close(open.id);
  }

  // An iPhone's microphone (its app captures it, phone.mic.want): the same hidden window as the
  // Android one above, fed what comes through the session (netMicAudio) instead of an adb session.
  netMic(on, out = '') {
    const open = [...this.views.values()].find((v) => v.kind === 'mic' && v.net);
    if (open && on && open.sink !== out) this.close(open.id);
    else if (open && on) return;
    if (on) this._open({ kind: 'mic', net: true, title: this._i18n().t('Phone microphone'), titleKey: 'Phone microphone', width: 200, height: 100, hidden: true, sink: out });
    else if (open) this.close(open.id);
  }

  netMicAudio(m) {
    const p = { codec: 'pcm', p: Array.isArray(m.p) ? m.p.filter((x) => typeof x === 'string').slice(0, 20) : [] };
    for (const v of this.views.values()) if (v.kind === 'mic' && v.net) this._send(v, 'phoneview:netaudio', p);
  }

  netAudio(m) {
    const p = { codec: m.codec === 'pcm' ? 'pcm' : 'opus', p: Array.isArray(m.p) ? m.p.filter((x) => typeof x === 'string').slice(0, 10) : [] };
    for (const v of this.views.values()) if (v.kind === 'netsound' || (v.native && v.session && v.session.opts.audio)) this._send(v, 'phoneview:netaudio', p);
  }

  // A Native screen window (Mirroring › Native) that plays the phone's sound: phone-bridge.js asks
  // the phone for it (phone.sound.want).
  get nativeScreenSound() {
    return [...this.views.values()].some((v) => v.kind === 'screen' && v.native && v.session && !v.session.closed && v.session.opts.audio);
  }

  list() {
    return [...this.views.values()].filter((v) => v.kind !== 'sound' && v.kind !== 'netsound' && v.kind !== 'mic').map((v) => ({ id: v.id, kind: v.kind, app: v.app || null, title: v.title, facing: v.facing || null, torch: !!v.torch, quality: v.kind === 'camera' ? this.camMax || 1920 : undefined, screenOff: !!v.screenOff, native: !!v.native, shown: !!(v.win && !v.win.isDestroyed() && v.win.isVisible()), error: v.error || '' }));
  }

  get focused() {
    return [...this.views.values()].some((v) => v.win && !v.win.isDestroyed() && v.win.isFocused());
  }

  _iosOwner(c = this.server.current) {
    if (c?.os !== P.OS.IOS || !c.authed || c.released) return null;
    const routed = this.server.route?.session;
    if (!this.server.route) return c;
    // The hosting context survives a transport resume. A newly authenticated context replaces it.
    return c.conn ? (routed?.linkUp ? c.conn : routed?.ctx) || null : null;
  }

  _currentIosMessage(ctx) {
    const c = this.server.current;
    return !!this._iosOwner(c) && (this.server.route ? !!ctx.conn && ctx.deviceId === c.deviceId : ctx === c);
  }

  _focusScreen(o = {}) {
    const v = [...this.views.values()].find((v) => v.kind === 'screen' && !v.ending && !v.win.isDestroyed());
    if (!v) return false;
    if (v.ios && (v.failed || v.session?.closed || v.ios.owner !== this._iosOwner())) {
      const owner = this._iosOwner();
      this.close(v.id);
      if (!owner) return false;
      this._openIosNative(o, owner);
    } else {
      v.win.show();
      v.win.focus();
    }
    return true;
  }

  openScreen(fromIos = false) {
    if (this._focusScreen()) return;
    const current = this.server.current;
    if (current?.os === P.OS.IOS) {
      const owner = this._iosOwner(current);
      if (!owner) return;
      if (fromIos === true) return this._openIosNative({}, owner);
      return void this.openIosScreen();
    }
    const info = this.phone.info || {};
    const d = info.display || { w: 1080, h: 2400 };
    const work = screen.getPrimaryDisplay().workAreaSize;
    const h = Math.min(860, work.height - 80);
    const w = Math.round(h * Math.min(d.w, d.h) / Math.max(d.w, d.h));
    const name = (this.server.current && this.server.current.name) || this._i18n().t('Phone');
    const titleKey = (this.server.current && this.server.current.name) ? '' : 'Phone';
    // Mirroring › Native (or Automatic without wireless debugging): the phone shares it itself.
    const native = this.bridge.mirrorVia === 'native';
    this._open({ kind: 'screen', native, title: name, titleKey, width: w, height: h, opts: this.bridge.sessionOpts('screen') });
  }

  // A direct open can use a cable. ReplayKit notifications and retries stay with their exact peer.
  async openIosScreen(o = {}) {
    if (this._focusScreen(o) || this.openingIos) return;
    const owner = this._iosOwner();
    const ipadOwner = pairedIPad(this);
    const pending = this.openingIos = {};
    const usb = ipadOwner && existsSync(this.ipadRunnerTemplate()) ? [] : await iosusb.list();
    if (this.openingIos !== pending) return;
    this.openingIos = null;
    if (this._iosOwner() !== owner || (ipadOwner && !matchesIPad(this, ipadOwner)) || this._focusScreen(o)) return;
    if (usb.length) {
      const { width, height } = this._iosSize(o, usb[0].model);
      return void this._open({ kind: 'screen', usb: usb[0].id, title: o.title || usb[0].name, width, height, opts: { maxSize: 0, videoBitRate: 12000000 } });
    }
    if (owner) this._openIosNative(o, owner);
  }

  _iosSize(o, usbModel = '', bar = PHONEVIEW_BAR) {
    const height = o.height || Math.min(860, screen.getPrimaryDisplay().workAreaSize.height - 80);
    const info = this.phone.info;
    const pad = info?.platform === 'ipados' || /^iPad/i.test(info?.model || usbModel);
    const iphone = !pad && (info?.platform === 'ios' || /^iPhone/i.test(info?.model || usbModel));
    const display = screenSize(info?.display?.w, info?.display?.h);
    const aspect = display ? display.width / display.height : iphone ? 9 / 19.5 : 3 / 4;
    return { pad, height, width: o.width || Math.round((height - bar) * aspect) };
  }

  _openIosNative(o, owner) {
    const c = this.server.current;
    if (!owner || owner !== this._iosOwner(c)) return;
    this.openingIos = null;
    const ipadOwner = pairedIPad(this, c);
    const bar = ipadOwner ? PHONEVIEW_BAR + IPAD_CONTROL_BAR : PHONEVIEW_BAR;
    const { pad, width, height } = this._iosSize(o, '', bar);
    return this._open({ kind: 'screen', native: true, ipadOwner, ios: { owner, pad, deviceId: c.deviceId }, title: c.name || this._i18n().t('Phone'),
      width, height, opts: this.bridge.sessionOpts('screen') });
  }

  _retryIos(v) {
    if (!v.ios?.pad || v.ending || v.ios.owner !== this._iosOwner() || !(v.failed || v.session?.closed)) return;
    const owner = v.ios.owner;
    this.close(v.id);
    this._openIosNative({}, owner);
  }

  ipadRunnerTemplate() {
    return runnerTemplate(app.getPath('userData'));
  }

  // The phone's camera (Camera's switch, or the phone's Camera page; scrcpy's camera source, Android
  // 12 or later): facing 'back' or 'front'; the camera picks its best size up to 1920 on the long
  // side (a size it doesn't have would fail), at 30 fps. Its window opens hidden: the picture goes
  // to the Camera tab and the virtual camera (shared/vcam.js); show: the window too (Camera ›
  // Window), its light and zoom from the window's buttons. Closing the window only hides it. The other facing with it
  // running: the same window switches (_flip).
  openCamera(opts) {
    if (!this.cameraOn) return; // Camera is off here: the phone's Camera page says so (cameraState)
    opts = opts && typeof opts === 'object' ? opts : {};
    const want = opts.facing === 'front' || opts.facing === 'back' ? opts.facing : null;
    const open = [...this.views.values()].find((v) => v.kind === 'camera' && !v.ending);
    if ([1280, 1920, 3840].includes(opts.quality)) { // Camera › Quality: the long side (restarts a running one)
      const was = this.camMax || 1920;
      this.camMax = opts.quality;
      if (open && was !== opts.quality) this._flip(open, open.facing);
      this.emit('change');
      return;
    }
    if (open && opts.do) return this._camDo(open, opts.do);
    if (opts.do) return;
    if (open) {
      if (want && want !== open.facing) this._flip(open, want);
      if (opts.show) {
        open.win.show();
        open.win.focus();
      }
      return;
    }
    const facing = want || 'back';
    const titleName = (this.server.current && this.server.current.name) || '';
    const titleKey = titleName ? '{name} Camera' : 'Phone Camera';
    const name = this._i18n().t(titleKey, { name: titleName });
    const v = this._open({ kind: 'camera', title: name, titleKey, titleName, width: 854, height: 512, opts: this._cameraOpts(facing, opts.size), hidden: !opts.show });
    if (!v) return;
    v.facing = facing;
    this.emit('change'); // with its facing, for the tab and the phone
  }

  // Camera page's buttons for a running phone camera: its light and zoom (as its window's).
  _camDo(v, what) {
    const s = v.session;
    if (!s) return;
    if (what === 'torch') {
      v.torch = !v.torch;
      s.setTorch(v.torch);
      this._send(v, 'phoneview:opts', { torch: v.torch });
      this.emit('change');
    } else if (what === 'zoomIn') s.zoomIn();
    else if (what === 'zoomOut') s.zoomOut();
  }

  _cameraOpts(facing, size) {
    const cam = { videoSource: 'camera', cameraFacing: facing, cameraFps: 30, maxSize: this.camMax || 1920 };
    if (/^\d{2,5}x\d{2,5}$/.test(String(size || ''))) cam.cameraSize = size;
    return this.bridge.sessionOpts('camera', cam);
  }

  // Front or back in the same window: the phone lets go of one camera a moment after its session
  // ends, and a session started before that can't open the other (it ended, and its window with it).
  async _flip(v, facing) {
    v.facing = facing;
    v.error = '';
    const token = (v.flips = (v.flips || 0) + 1);
    const old = v.session;
    v.session = null; // first: its end isn't the window's
    if (old) old.stop();
    this.bridge._tellPhone();
    this.emit('change');
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1200 + attempt * 1000));
      if (v.flips !== token || v.win.isDestroyed()) return;
      try {
        await this._start(v, this._cameraOpts(facing));
        return;
      } catch (e) {
        v.error = e.message;
      }
    }
    this.emit('change');
  }

  // For the phone's Camera page (phone-bridge.js): its camera here, which one, and the virtual camera.
  // The Camera tab's switch (settings.camera.on): off, no camera runs here.
  get cameraOn() {
    const c = this.getSettings().camera;
    return !c || c.on !== false;
  }

  cameraState() {
    if (!this.cameraOn) return { on: false, facing: null, error: 'Camera is off on this computer: turn it on in TwinDesk’s Camera tab there', virtual: false };
    const v = [...this.views.values()].find((x) => x.kind === 'camera' && !x.ending);
    return { on: !!v, facing: v ? v.facing : null, error: v ? v.error || '' : '', virtual: !!(this.vcam && this.vcam.ready) };
  }

  _showApp(view) {
    if (view.win.isMinimized()) view.win.restore();
    view.win.show();
    view.win.focus();
  }

  openApp(pkg, name) {
    const open = [...this.views.values()].find((v) => v.kind === 'app' && v.app === pkg);
    if (open) {
      const dark = this.getSettings().phone?.keepPanelOff === true;
      if (!open.session?.closed && open.keepPanelOff === dark && !(open.started && !open.session?.videoStarted)) {
        this._showApp(open);
        if (dark) this._resumeDarkApp(open);
        return;
      }
      this.close(open.id);
    }
    const w = 412;
    const h = 860;
    // At least 2 pixels per point (sharp at 100% scaling); the dpi keeps 1 dp = 1 point, so the
    // app's text is as big as this computer's. The window's resizes use the same rule.
    const scale = Math.max(2, screen.getPrimaryDisplay().scaleFactor || 1);
    const [dw, dh] = require('../shared/appsize.js').appSize(w * scale, (h - 32) * scale); // a phone-like size (shared/appsize.js)
    const newDisplay = `${dw}x${dh}/${Math.round(160 * scale)}`;
    this._open({ kind: 'app', app: pkg, title: name || pkg, width: w, height: h, opts: this.bridge.sessionOpts('app', { newDisplay }) });
  }

  // A notification from the phone was clicked: wake it (unlocked: it answers at once), then open
  // the app once the phone is unlocked and wireless debugging is back (MIUI drops it while locked).
  openNotified(pkg, name) {
    if (!pkg || !this.server.current) return;
    if (this.getSettings().phone?.keepPanelOff) return this.openApp(pkg, name);
    const n = { pkg, name, at: Date.now(), unlocked: false, answered: false };
    this.notified = n;
    this.server.sendToClient({ t: T.PHONE_WAKE });
    // An older app doesn't answer: open it anyway.
    setTimeout(() => {
      if (this.notified !== n || n.answered) return;
      n.unlocked = true;
      this._openNotified();
    }, 2000);
  }

  _awake(m) {
    const n = this.notified;
    if (!n) return;
    n.answered = true;
    if (!m.unlocked) {
      const phone = (this.server.current && this.server.current.name) || 'the phone';
      return void (m.waiting && this.bridge.emit('popup', 'away', `Unlock ${phone} to open ${n.name || 'the app'}`));
    }
    n.unlocked = true;
    this._openNotified();
  }

  _openNotified() {
    const n = this.notified;
    if (!n || !n.unlocked) return;
    if (Date.now() - n.at > NOTIFIED_MS) return void (this.notified = null);
    const ble = this.server.current && this.server.current.transport === 'ble'; // Wi-Fi first: onNoAdb
    if ((this.bridge.state !== 'ready' || !this.bridge.serial) && !(ble && this.onNoAdb)) return;
    this.notified = null;
    this.openApp(n.pkg, this._info(n.pkg, n.name).name);
  }

  // Mirroring's settings: the open phone screen window's Rotate and screen off ('rotate' | 'screenPower').
  screenAct(key) {
    if (key !== 'rotate' && key !== 'screenPower') return;
    const v = [...this.views.values()].find((x) => x.kind === 'screen' && !x.ending);
    if (!v) return;
    this._input(v, { t: 'nav', key });
    this.emit('change');
  }

  close(id) {
    const v = this.views.get(id);
    if (!v || !v.win || v.win.isDestroyed()) return;
    v.ending = true;
    stopIPad(this, v, 'off', quitting);
    v.win.close();
  }

  closeAll() {
    this.openingIos = null;
    this.releaseAppPanel();
    for (const v of [...this.views.values()]) this.close(v.id);
  }

  get screenWithSound() {
    return [...this.views.values()].some((v) => v.kind === 'screen' && v.session && v.session.opts.audio);
  }

  _i18n() {
    const settings = this.getSettings();
    return I18n.create(I18n.resolveLanguage(settings.ui && settings.ui.language, app.getLocale()));
  }

  _open({ kind, app, title, titleKey = '', titleName = '', width, height, opts, hidden = false, sink = '', native = false, net = false, usb = '', ios = null, ipadOwner = null }) {
    if (!this.bridge.serial && kind !== 'netsound' && !net && !native && !usb) {
      // Through Bluetooth: the phone's hotspot first (main.js), then this window.
      if (kind !== 'mic' && this.onNoAdb && this.onNoAdb({ kind, app, title, titleKey, titleName, width, height, opts, hidden })) return;
      return this.bridge.emit('popup', 'home', 'Set up wireless debugging on the Phone page first');
    }
    const id = nextId++;
    // backgroundThrottling stays off: a window that is only unfocused still decodes and plays
    // sound. Minimized is told to the page, which stops decoding until the window is shown.
    const win = new BrowserWindow({
      width, height, minWidth: 220, minHeight: 300, title, show: false,
      titleBarStyle: 'hiddenInset', backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload-phoneview.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const v = { id, kind, app, title, win, sink, native, net, usb, ios, ipadOwner, session: null, keys: new KeyState(), size: null, ready: false, queue: [], screenOff: false, eaten: new Set() };
    this._send(v, 'phoneview:opts', this._opts(v));
    this.views.set(id, v);
    if (kind === 'app') setImmediate(() => this._stubs());
    const tellMinimized = () => this._send(v, 'phoneview:opts', { minimized: win.isMinimized() });
    win.loadFile(path.join(__dirname, 'phoneview.html'), { query: { kind, title, titleKey, titleName, ...(ios || usb ? { screenOS: P.OS.IOS } : {}), ...(ipadOwner ? { ipad: '1' } : {}), ...(kind === 'mic' ? { sink, virtual: process.platform === 'linux' ? '1' : '' } : {}), language: this._i18n().locale } });
    if (!hidden) win.once('ready-to-show', () => win.show());
    win.webContents.once('did-finish-load', () => {
      v.ready = true;
      for (const [ch, m] of v.queue.splice(0)) win.webContents.send(ch, m);
      tellMinimized();
    });
    win.on('minimize', tellMinimized);
    win.on('restore', tellMinimized);
    win.on('show', tellMinimized);
    if (kind === 'screen') {
      const refit = () => {
        if (v.size && (v.ios || v.usb || require('../shared/appturn.js').autoRotate(this.getSettings()))) this._fitScreen(v, v.size);
      };
      for (const ev of ['restore', 'unmaximize', 'leave-full-screen']) win.on(ev, refit);
    }
    if (ipadOwner) {
      win.on('blur', () => v.ipadLease?.controller?.clearInput());
      win.webContents.on('before-input-event', (event, input) => {
        if (quitting || !win.isFocused() || input.type !== 'keyDown' || input.meta !== true || input.alt || input.control || input.isComposing) return;
        const accepted = v.ipadLease?.controller?.input({
          op: 'key', down: true, meta: true, key: input.key, code: input.code, shift: input.shift, repeat: input.isAutoRepeat,
        }, null, () => clipboard.readText());
        if (accepted) event.preventDefault();
      });
      win.on('close', () => stopIPad(this, v, 'off', quitting));
      win.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) stopIPad(this, v, 'off', quitting);
      });
      win.webContents.on('render-process-gone', () => stopIPad(this, v, 'lost'));
    }
    // A camera's window: closed, it only hides (the camera stops with Camera's switch).
    if (kind === 'camera') {
      win.on('close', (e) => {
        if (v.ending || quitting) return;
        e.preventDefault();
        win.hide();
        this.emit('change');
      });
      win.on('show', () => this.emit('change'));
    }
    win.on('closed', () => {
      if (v.swipeTimer) clearInterval(v.swipeTimer);
      if (this.appPanel.remove(v)) this._sendOpts();
      if (v.screenOff && v.session && !v.session.closed) {
        try { v.session.setDisplayPower(true); } catch {}
      }
      if (v.session) v.session.stop();
      this.saver.closed(id); // a recording keeps what it has
      this.views.delete(id);
      this._stubs();
      this.emit('change');
    });
    this.emit('change');
    if (kind !== 'netsound' && !net) this._start(v, opts).catch((e) => {
      if (v.ios && (v.ending || this.views.get(v.id) !== v || v.win.isDestroyed())) return;
      if (this.appPanel.remove(v)) this._sendOpts();
      if (v.kind === 'app') v.session?.stop();
      if (v.ios) v.failed = true;
      console.log(`[phone] ${kind} window: ${e.message}`);
      this._send(v, 'phoneview:status', { error: e.message, errorKey: e.messageKey, errorVars: e.messageVars,
        retryIpad: !!v.ios?.pad && v.ios.owner === this._iosOwner() });
    });
    return v;
  }

  _send(v, ch, m) {
    if (!v.win || v.win.isDestroyed()) return;
    if (!v.ready) return v.queue.push([ch, m]);
    v.win.webContents.send(ch, m);
  }

  async _start(v, opts) {
    const { adb, serial } = this.bridge;
    const dark = v.kind === 'app' && !v.native && this.getSettings().phone?.keepPanelOff === true;
    const appOwner = v.app && !v.native && !dark ? this.appPanel.capture() : null;
    v.keepPanelOff = dark;
    const owns = v.ios ? () => v.ios.owner === this._iosOwner() : null;
    const s = v.usb ? new iosusb.IosUsbScreen({ ...opts, id: v.usb }) : v.native ? new NativeScreen(this.server, opts, owns)
      : new Session(adb, serial, dark ? { ...opts, powerOn: false, keepActive: true } : opts);
    const current = () => this.views.get(v.id) === v && v.session === s && !v.ending && !s.closed
      && this.bridge.serial === serial && !v.win.isDestroyed();
    const via = v.native || v.usb ? null : this.bridge.via;
    if (v.native && !v.usb) setImmediate(() => this.bridge._sound()); // its sound, when it plays it
    if (v.native) s.on('waiting', () => {
      const errorKey = v.ios?.pad ? 'On the iPad tap Share Screen, then Start Broadcast with TwinDesk selected' : 'Tap Start on the phone to share its screen';
      this._send(v, 'phoneview:status', { error: errorKey, errorKey });
    });
    v.session = s;
    s.on('size', (size) => {
      v.size = size;
      this._send(v, 'phoneview:size', size);
      const auto = require('../shared/appturn.js').autoRotate(this.getSettings());
      if (v.kind === 'app') require('../shared/appturn.js').appSized(v, size, auto); // the app turned its display round (#258)
      else if (v.kind === 'screen' && (v.ios || v.usb || auto)) this._fitScreen(v, size);
      else if ((v.kind === 'camera' || !v.shaped) && v.win && !v.win.isDestroyed()) v.win.setAspectRatio(size.width / size.height); // Auto-rotate off: the window keeps its shape
      v.shaped = true;
    });
    s.on('video', (p) => this._send(v, 'phoneview:video', p));
    s.on('audio', (p) => !p.config && this._send(v, 'phoneview:audio', p.data));
    s.on('closed', (why, metadata) => {
      if (v.session !== s) return; // one a flip replaced
      stopIPad(this, v, 'lost', quitting);
      v.appFrame = null;
      if (this.appPanel.remove(v)) this._sendOpts();
      if (v.ios) v.failed = true;
      this._send(v, 'phoneview:status', { closed: why, closedKey: metadata && metadata.messageKey, closedVars: metadata && metadata.messageVars,
        retryIpad: !!v.ios?.pad && !v.ending && v.ios.owner === this._iosOwner() });
      if (v.kind === 'camera' && why !== 'stopped') {
        v.error = why;
        this.emit('change');
      }
    });
    const panel = dark ? this.appPanel.begin(v) : null;
    v.panelLease = panel;
    const live = () => current() && (!dark || this.appPanel.owns(panel));
    const waitForUnlock = async () => {
      const errorKey = 'Wake and unlock the phone to open this app.';
      const waiting = () => this._showUnlock(v);
      if (panel && await this.appPanel.waitUnlocked(panel, live, waiting)) return true;
      if (panel ? live() : current()) throw Object.assign(new Error(errorKey), { messageKey: errorKey });
      return false;
    };
    if (dark && !await waitForUnlock()) return;
    if (v.app && !live()) return;
    if (appOwner && !this.appPanel.wake(appOwner)) { s.stop(); return; }
    await s.start();
    if (v.ios && (v.ending || v.session !== s || s.closed || !owns() || v.win.isDestroyed())) return;
    if (v.app && !live()) { s.stop(); return; }
    v.started = true;
    this._send(v, 'phoneview:status', { ready: true, via });
    if (!v.app) return;

    // Give scrcpy time to announce the app display for the HyperOS full-screen launch.
    if (!dark && !v.native && !appOwner) s.tap(ANDROID.WAKEUP);
    const maker = this.phone?.info?.maker;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!live() || (dark && !await waitForUnlock()) || !live()) { s.stop(); return; }
    await startApp(s, { adb, serial, maker, app: v.app, live });
    if (!live()) { s.stop(); return; }
    if (dark) await this._blankAfterAppFrame(v, s, panel, live);
  }

  _fitScreen(v, size) {
    const win = v.win;
    if (!screenSize(size.width, size.height) || v.ending || win.isDestroyed() || !win.isNormal()) return;
    const aspect = size.width / size.height;
    // The encoder rounds scaled dimensions to even pixels.
    if (v.videoAspect && Math.abs(aspect / v.videoAspect - 1) < 0.01) return;
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    const work = screen.getDisplayMatching(bounds).workArea;
    const bar = v.ipadOwner ? PHONEVIEW_BAR + IPAD_CONTROL_BAR : PHONEVIEW_BAR;
    const extraW = bounds.width - content.width;
    const extraH = bounds.height - content.height + bar;
    const [minW, minH] = win.getMinimumSize();
    const long = Math.max(content.width, content.height - bar);
    const w = aspect >= 1 ? long : long * aspect;
    const h = w / aspect;
    const maxScale = Math.min((work.width - extraW) / w, (work.height - extraH) / h);
    const minScale = Math.max((minW - extraW) / w, (minH - extraH) / h);
    const scale = Math.min(maxScale, Math.max(1, minScale));
    const width = Math.min(work.width, Math.max(minW, Math.round(w * scale + extraW)));
    const height = Math.min(work.height, Math.max(minH, Math.round(h * scale + extraH)));
    const x = Math.max(work.x, Math.min(work.x + work.width - width, bounds.x + Math.round((bounds.width - width) / 2)));
    const y = Math.max(work.y, Math.min(work.y + work.height - height, bounds.y + Math.round((bounds.height - height) / 2)));
    v.videoAspect = aspect;
    win.setAspectRatio(aspect, { width: 0, height: bar });
    if (bounds.x !== x || bounds.y !== y || bounds.width !== width || bounds.height !== height) {
      win.setBounds({ x, y, width, height });
    }
  }

  _showUnlock(v) {
    const errorKey = 'Wake and unlock the phone to open this app.';
    this._send(v, 'phoneview:status', { error: errorKey, errorKey });
  }

  async _blankAfterAppFrame(v, s, panel, live) {
    if (!live() || this.appPanel.off || !await this.appPanel.waitForApp(s, v.app, live) || !live()) return false;
    v.appFrame = { panel, capture: s.scid };
    this._send(v, 'phoneview:status', { ready: true, appFrame: s.scid });
    s.simple(TYPE.RESET_VIDEO);
    return true;
  }

  async _resumeDarkApp(v) {
    const { session: s, panelLease: panel } = v;
    const live = () => this.views.get(v.id) === v && v.session === s && !v.ending && !s?.closed
      && this.appPanel.owns(panel);
    if (!live()) return;
    this.appPanel.retry(panel);
    // Before the first picture, the existing startup routine will notice the retry.
    if (!s?.videoStarted || v.resuming) return;
    v.appFrame = null;
    v.resuming = true;
    try {
      if (!await this.appPanel.waitUnlocked(panel, live, () => this._showUnlock(v))) {
        if (live()) this._showUnlock(v);
        return;
      }
      if (!await this._blankAfterAppFrame(v, s, panel, live) && live()) s.simple(TYPE.RESET_VIDEO);
    } catch (_) {
      if (live()) this._showUnlock(v);
    } finally {
      v.resuming = false;
    }
  }

  releaseAppPanel() {
    if (this.appPanel?.release()) this._sendOpts();
  }

  // The window's switches as they are now (its buttons light up).
  _opts(v) {
    const ph = this.getSettings().phone || {};
    const mirrorPreview = v.ios && this.phone.pairing?.previews?.owner(v.ios.owner) ? v.id : null;
    return { mirrorPreview, enterSends: ph.enterSends !== false, autoRotate: ph.autoRotate !== false, arrowSwipe: ph.arrowSwipe === true, screenOff: !!v.screenOff || (!v.native && (v.kind === 'app' || v.kind === 'screen') && this.appPanel?.off === true), pinned: !!(v.win && !v.win.isDestroyed() && v.win.isAlwaysOnTop()) };
  }

  // Return sends / Arrow keys swipe changed (here, or on the Phone page): every window shows it.
  applyOpts() {
    if (!this.getSettings().phone?.keepPanelOff) this.appPanel?.release();
    this._sendOpts();
  }

  panelPreferenceChanged() {
    this.applyOpts();
    if (this.getSettings().phone?.keepPanelOff !== true) return;
    // A black window has no app session to preserve. Retry it with the newly enabled wake path.
    for (const v of [...this.views.values()]) {
      if (v.kind === 'app' && !v.keepPanelOff && (v.session?.closed || (v.started && !v.session?.videoStarted))) {
        this.openApp(v.app, v.title);
      }
    }
  }

  _sendOpts() {
    for (const v of this.views.values()) if (v.kind !== 'sound' && v.kind !== 'netsound' && v.kind !== 'mic') this._send(v, 'phoneview:opts', this._opts(v));
  }

  // Return in a chat app, an arrow that swipes (shared/phonechat.js): done here, the key (and its
  // release) left out. True when the key was used up.
  _special(v, code, down) {
    if (!down) return v.eaten.delete(code);
    if (v.eaten.has(code)) return true; // held: once
    const ph = this.getSettings().phone || {};
    const s = v.session;
    let done = false;
    const dir = chat.swipeOf(code, ph.arrowSwipe === true, v.keys.held);
    if (dir) {
      this._swipe(v, dir);
      done = true;
    } else if (chat.isEnter(code)) {
      done = chat.enter({
        on: ph.enterSends !== false,
        pkg: v.app || this.activeApp,
        shift: v.keys.held.has('ShiftLeft') || v.keys.held.has('ShiftRight'),
        a11y: this.a11y,
        phoneSend: () => this.server.sendToClient({ t: T.PHONE_SEND }),
        tap: (k) => !s.closed && s.tap(k),
        text: (t) => s.text(t),
      });
    }
    if (done) v.eaten.add(code);
    return done;
  }

  _saveIosPreview(v, m) {
    const s = v.session;
    if (!v.ios || v.ending || v.id !== m.capture || !v.started || !s?.on_ || !s.req || s.closed || !s.owns?.()) return;
    const size = s.size;
    if (!size) return;
    const sw = s.screen?.w, sh = s.screen?.h;
    const display = sw && sh && Math.abs((sw / sh) / (size.width / size.height) - 1) < 0.01
      ? { width: sw, height: sh } : size;
    const info = this.phone.infoId === v.ios.deviceId ? this.phone.info : null;
    if (this.phone.pairing?.previews?.save(v.ios.owner, m.jpeg, display, info)) this.phone.emit('change');
  }

  _input(v, m) {
    if (quitting && v.ipadOwner) return;
    if (m.t === 'mirrorPreview') return this._saveIosPreview(v, m);
    if (m.t === 'retryIpad') return this._retryIos(v);
    if (handleIPad(this, v, m, dialog)) return;
    // Keep on top (the title bar's pin): the window's own, no phone needed. 'floating': over other
    // apps' windows, under menus and the Dock.
    if (m.t === 'pin') {
      const on = !v.win.isAlwaysOnTop();
      v.win.setAlwaysOnTop(on, 'floating');
      return this._send(v, 'phoneview:opts', { pinned: on });
    }
    if (m.t === 'toggle' && (m.what === 'enterSends' || m.what === 'arrowSwipe' || m.what === 'autoRotate')) {
      const ph = this.getSettings().phone;
      ph[m.what] = m.what === 'arrowSwipe' ? ph.arrowSwipe !== true : ph[m.what] === false; // the others are on unless switched off
      this.bridge.emit('save');
      this.applyOpts();
      return this.emit('change');
    }
    const s = v.session;
    const size = v.size;
    if (!s || s.closed) return;
    // A camera's picture isn't the phone's screen: touches and keys there would land on whatever the screen shows.
    if (v.kind === 'camera' && (m.t === 'touch' || m.t === 'scroll' || m.t === 'key')) return;
    const num = (x) => (Number.isFinite(x) ? x : 0);
    switch (m.t) {
      case 'appFrame': {
        const frame = v.appFrame;
        if (v.kind !== 'app' || v.ending || !frame || m.capture !== s.scid || frame.capture !== s.scid) break;
        v.appFrame = null;
        if (this.getSettings().phone?.keepPanelOff && ![...this.views.values()].some((window) => window.screenOff)
            && this.appPanel.blank(frame.panel, v)) this._sendOpts();
        break;
      }
      case 'touch': // a finger (pointer ≥ 0) or the mouse (-1) at video coordinates
        if (!size) return;
        s.touch(m.action | 0, Math.max(-3, Math.min(9, m.pointer | 0)), num(m.x), num(m.y), size.width, size.height,
          m.action === ACTION.UP ? 0 : 1, m.actionButton | 0, m.buttons | 0);
        break;
      case 'scroll':
        if (!size) return;
        s.scroll(num(m.x), num(m.y), size.width, size.height, num(m.hs), num(m.vs), 0);
        break;
      case 'key': {
        if (typeof m.code !== 'string') return;
        const swap = P.keySwapNeeded(P.OS.MAC, P.OS.ANDROID) && this.getSettings().keys?.swapCtrlCmd !== false;
        let code = swap ? P.mapKeyFromOtherPlatform(m.code) : m.code;
        if (this._special(v, code, !!m.down)) break;
        const uhid = (this.getSettings().phone || {}).uhid === true;
        if (!uhid) { // by what the key types here, not its place on Android's QWERTY (shared/phonetype.js, #260)
          const r = (v.type || (v.type = new (require('../shared/phonetype.js').PhoneType)())).fromWindow({ code, down: !!m.down, repeat: !!m.repeat, key: m.key, shift: !!m.shift, ctrl: !!m.ctrl, meta: !!m.meta, altGr: !!m.altGr });
          if (r.text) { s.text(r.text); break; }
          if (!r.code) break;
          code = r.code;
        }
        const e = v.keys.event(code, !!m.down);
        if (uhidKey(s, uhid, code, !!m.down)) break; // a HID keyboard (#123)
        if (e) s.key(m.down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta, m.repeat ? 1 : 0);
        break;
      }
      case 'nav': {
        const k = { back: ANDROID.BACK, home: ANDROID.HOME, recents: ANDROID.APP_SWITCH, power: ANDROID.POWER, volumeUp: ANDROID.VOLUME_UP, volumeDown: ANDROID.VOLUME_DOWN }[m.key];
        if (m.key === 'back') { s.backOrScreenOn(ACTION.DOWN); s.backOrScreenOn(ACTION.UP); } else if (k) s.tap(k);
        if (m.key === 'notifications') s.simple(TYPE.EXPAND_NOTIFICATIONS);
        if (m.key === 'rotate') s.simple(TYPE.ROTATE);
        // The phone's own screen off, its picture still here (scrcpy's display power).
        if (m.key === 'screenPower' && (v.kind === 'screen' || v.kind === 'app') && !v.native) { // an app window too: its app runs with the phone dark (#247)
          if (![...this.views.values()].some((window) => window.screenOff) && this.appPanel?.toggle()) {
            this._sendOpts();
            break;
          }
          v.screenOff = !v.screenOff;
          s.setDisplayPower(!v.screenOff);
          this._send(v, 'phoneview:opts', { screenOff: v.screenOff });
        }
        break;
      }
      case 'resetVideo': // the window skipped frames: a keyframe now
        s.simple(TYPE.RESET_VIDEO);
        break;
      case 'cameraTorch':
        if (v.kind === 'camera') { v.torch = !!m.on; s.setTorch(v.torch); }
        break;
      case 'cameraZoomIn':
        if (v.kind === 'camera') s.zoomIn();
        break;
      case 'cameraZoomOut':
        if (v.kind === 'camera') s.zoomOut();
        break;
      case 'cameraSwitch': { // the other camera: a session of its own
        if (v.kind !== 'camera') break;
        this._flip(v, v.facing === 'front' ? 'back' : 'front');
        break;
      }
      case 'resize': // an app window changed size: its virtual display follows (flex)
        if (v.kind === 'app' && m.w > 50 && m.h > 50) s.resizeDisplay(...require('../shared/appturn.js').appResized(v, m)); // a phone-like size (shared/appsize.js), swapped back while the app has it turned (#258)
        break;
      case 'swipe':
        if (typeof m.dir === 'string') this._swipe(v, m.dir);
        break;
      default: break;
    }
  }

  _swipe(v, dir) {
    const s = v.session;
    const size = v.size;
    if (!s || s.closed || !size) return;
    if (v.swiping) {
      // Buffer at most 1 subsequent swipe so rapid taps are never dropped
      v.pendingSwipe = dir;
      return;
    }
    v.swiping = true;

    const w = size.width;
    const h = size.height;
    let startX, startY, endX, endY;

    // Inverted directional swipe for natural navigation:
    // ArrowDown -> content moves down (finger swipes UP from bottom to top)
    // ArrowUp -> content moves up (finger swipes DOWN from top to bottom)
    // ArrowRight -> content moves right (finger swipes LEFT from right to left)
    // ArrowLeft -> content moves left (finger swipes RIGHT from left to right)
    switch (dir) {
      case 'down':
        startX = Math.round(w * 0.5);
        startY = Math.round(h * 0.78);
        endX = Math.round(w * 0.5);
        endY = Math.round(h * 0.22);
        break;
      case 'up':
        startX = Math.round(w * 0.5);
        startY = Math.round(h * 0.22);
        endX = Math.round(w * 0.5);
        endY = Math.round(h * 0.78);
        break;
      case 'right':
        startX = Math.round(w * 0.82);
        startY = Math.round(h * 0.5);
        endX = Math.round(w * 0.18);
        endY = Math.round(h * 0.5);
        break;
      case 'left':
        startX = Math.round(w * 0.18);
        startY = Math.round(h * 0.5);
        endX = Math.round(w * 0.82);
        endY = Math.round(h * 0.5);
        break;
      default:
        v.swiping = false;
        return;
    }

    const duration = 160; // ms: natural flick duration
    const startTime = Date.now();
    const dx = endX - startX;
    const dy = endY - startY;

    // Send touch down directly over control socket (pointer: -2 = FINGER)
    s.touch(ACTION.DOWN, -2, startX, startY, w, h, 1, 0, 0);

    const timer = setInterval(() => {
      if (s.closed) {
        clearInterval(timer);
        v.swiping = false;
        v.swipeTimer = null;
        v.pendingSwipe = null;
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      if (progress < 1) {
        // Mild ease-in curve (t^1.15): starts cleanly without jerk and maintains brisk velocity
        // right through release (ACTION.UP), ensuring Android's VelocityTracker detects a
        // natural fling and triggers a smooth inertia scroll.
        const ease = Math.pow(progress, 1.15);
        const curX = Math.round(startX + dx * ease);
        const curY = Math.round(startY + dy * ease);
        s.touch(ACTION.MOVE, -2, curX, curY, w, h, 1, 0, 0);
      } else {
        clearInterval(timer);
        v.swipeTimer = null;
        // Liftoff at terminal position with authentic release velocity
        s.touch(ACTION.UP, -2, endX, endY, w, h, 0, 0, 0);
        setTimeout(() => {
          v.swiping = false;
          if (v.pendingSwipe) {
            const next = v.pendingSwipe;
            v.pendingSwipe = null;
            this._swipe(v, next);
          }
        }, 30);
      }
    }, 10);
    v.swipeTimer = timer;
  }

  shutdown() {
    this.closeAll();
    for (const st of this.stubs.values()) st.stop();
    this.stubs.clear();
  }

  // ---- the Dock ----

  _info(pkg, name) {
    const a = (this.phone.apps || []).find((x) => x.id === pkg);
    return { id: `phone:${pkg}`, name: (a && a.name) || name || pkg, icon: (a && a.icon) || '' };
  }

  // One Dock icon per phone app with windows here: click brings them up, Quit closes them.
  _stubs() {
    const open = new Map();
    for (const v of this.views.values()) if (v.kind === 'app' && v.win && !v.win.isDestroyed()) open.set(v.app, [...(open.get(v.app) || []), v]);
    for (const [pkg, st] of this.stubs) if (!open.has(pkg)) { st.stop(); this.stubs.delete(pkg); }
    for (const [pkg, vs] of open) {
      if (!this.stubs.has(pkg)) {
        this.stubs.set(pkg, new DockStub(this._info(pkg, vs[0].title), (ev, i) => {
          const ws = [...this.views.values()].filter((v) => v.kind === 'app' && v.app === pkg && v.win && !v.win.isDestroyed());
          if (ev === 'quit') return ws.forEach((v) => v.win.close());
          const w = ws[ev === 'focus' ? i : 0];
          if (w) {
            app.focus({ steal: true }); // TwinDesk has no Dock icon of its own
            w.win.show();
            w.win.focus();
          }
        }));
      }
      this.stubs.get(pkg).menu(vs.map((v) => v.title));
    }
  }

  // Phone page › an app › Add to Dock (and ~/Applications/MacShare Apps, for Launchpad and Spotlight).
  async pin(pkg, name) {
    const info = this._info(pkg, name);
    const ok = await addToDock(info);
    this.bridge.emit('popup', ok ? 'home' : 'driven', ok ? `${info.name} is in the Dock` : `Couldn’t add ${info.name} to the Dock`);
  }
}

module.exports = { PhoneViews };
