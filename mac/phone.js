// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone as the peer: which paired phones are nearby (the sidebar tile), connecting one on
// purpose (it takes the session from the computer), letting it go, and what it tells about
// itself (phone.info, adb.state, phone.apps). The screen, input and app windows go through the
// adb bridge (phone-bridge.js), which this hub starts while a phone is connected.
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const T = P.T;
const CONNECT_WAIT_MS = 8000; // an invited phone that doesn't say hello by then isn't coming
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const APPS_IDLE_MS = 4000;
const isPhone = (ctx) => !!ctx && P.isPhoneOs(ctx.os);
const socketOf = (ctx) => ctx?.conn || ctx?.ws;
const appVersion = (version) => typeof version === 'string' && /^[a-f0-9]{64}$/.test(version);

class Phone extends EventEmitter {
  constructor({ server, raw, discovery, pairing }) {
    super();
    Object.assign(this, { server, raw, discovery, pairing });
    this.info = null; // phone.info
    this.adb = null; // adb.state
    this.apps = []; // phone.apps
    this.appsCache = null; // shown again only after the same authenticated pairing returns
    this.appsSession = null;
    this.assets = 0; // bumps when the wallpaper or the app list changed (the window fetches them: assetsView)
    this.connecting = null; // {id, name, timer}
    this.message = '';
    this.bridge = null; // set by services.js
    this.wired = null; // wired.js: phones on a USB cable

    server.on('client', (ctx) => {
      if (!isPhone(ctx)) return this._reset();
      this._doneConnecting('');
      if (ctx.os === P.OS.ANDROID) this._startApps(ctx);
      this.emit('change');
    });
    server.on('closed', () => {
      this._endApps();
      if (isPhone(server.current)) return;
      this._reset();
    });
    server.on('transport', () => {
      const current = server.current;
      if (current?.os === P.OS.ANDROID && this.appsSession && this.appsSession.owner !== socketOf(current)) {
        this._startApps(current);
      }
    });
    const on = (t, fn) => server.on(`t:${t}`, (m, ctx) => isPhone(ctx) && fn(m, ctx));
    on(T.PHONE_INFO, (m) => {
      const colors = Array.isArray(m.colors) ? m.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3) : [];
      const wallpaper = typeof m.wallpaper === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(m.wallpaper) && m.wallpaper.length < 400000 ? m.wallpaper : (this.info && this.info.wallpaper) || '';
      const prev = this.info;
      const display = m.display && Number.isInteger(m.display.w) && Number.isInteger(m.display.h)
        ? { w: m.display.w, h: m.display.h, rot: m.display.rot | 0, dpi: m.display.dpi | 0 } : null;
      this.info = {
        model: str(m.model, 80), maker: str(m.maker, 40), release: str(m.release, 20), sdk: m.sdk | 0,
        battery: Number.isFinite(m.battery) ? Math.max(0, Math.min(100, Math.round(m.battery))) : null,
        charging: !!m.charging, colors, wallpaper, display, platform: str(m.platform, 10),
        // This app's version and what it can do without wireless debugging (shared/phonemodes.js caps): an older app sends neither.
        app: str(m.app, 40), caps: Array.isArray(m.caps) ? m.caps.filter((c) => typeof c === 'string').slice(0, 50).map((c) => c.slice(0, 40)) : [],
      };
      if (wallpaper !== ((prev && prev.wallpaper) || '')) this.assets++;
      this.emit('info', this.info);
      this.emit('change');
    });
    on(T.ADB_STATE, (m) => {
      // full: the build with notification access; net: on a Wi-Fi network, without which Android keeps
      // wireless debugging off. Older apps said neither (they all had notification access).
      this.adb = { devOptions: !!m.devOptions, wifi: !!m.wifi, canEnable: !!m.canEnable, address: str(m.address, 64), full: m.full !== false, port: Number(m.port) | 0, net: m.net !== false };
      this.emit('adb', this.adb);
      this.emit('change');
    });
    on(T.SCREEN_POLICY, (m, ctx) => {
      const s = this._appsFor(ctx);
      if (!s || s.requested) return;
      s.waitingForFrame = m.accept === true;
      clearTimeout(s.timer);
      if (m.accept !== true) this._idleApps(s);
    });
    on(T.PHONE_APPS_READY, (_m, ctx) => {
      const s = this._appsFor(ctx);
      if (!s?.waitingForFrame) return;
      s.waitingForFrame = false;
      this._requestApps(s);
    });
    on(T.PHONE_APPS, (m, ctx) => {
      const s = this._appsFor(ctx);
      const source = socketOf(ctx);
      if ((source && source !== socketOf(this.server.current)) ||
          (!s && (this.appsSession || (source?.ctx || ctx).appsPair))) return;
      if (!Array.isArray(m.apps)) return;
      this.apps = m.apps.slice(0, 2000).filter((a) => a && typeof a.id === 'string' && /^[\w.]{1,200}$/.test(a.id)).map((a) => ({
        id: a.id, name: str(a.name, 100) || a.id,
        icon: typeof a.icon === 'string' && a.icon.startsWith('data:image/png;base64,') && a.icon.length < 60000 ? a.icon : '',
      })).sort((a, b) => a.name.localeCompare(b.name));
      if (s) this.appsCache = appVersion(m.version) ? { pair: s.pair, version: m.version, apps: this.apps } : null;
      this.assets++;
      this.emit('change');
    });
  }

  _endApps() {
    clearTimeout(this.appsSession?.timer);
    this.appsSession = null;
  }

  _startApps(ctx) {
    this._endApps();
    const owner = socketOf(ctx);
    const pair = (owner?.ctx || ctx).appsPair;
    if (this.appsCache?.pair !== pair) this.appsCache = null;
    if (!pair || !owner) return this.server.sendToClient({ t: T.PHONE_APPS_LIST });
    const apps = this.appsCache?.apps || [];
    if (this.apps !== apps) { this.apps = apps; this.assets++; }
    const s = this.appsSession = { owner, pair, requested: false, waitingForFrame: false };
    this._idleApps(s);
  }

  _appsFor(ctx) {
    const s = this.appsSession;
    if (!s || socketOf(ctx) !== s.owner || socketOf(this.server.current) !== s.owner ||
        s.owner.readyState !== (s.owner.OPEN ?? 1) || s.owner.ctx?.released || ctx.released || ctx.authed === false) return null;
    return s;
  }

  _idleApps(s) {
    s.timer = setTimeout(() => this._requestApps(s), APPS_IDLE_MS);
    s.timer.unref?.();
  }

  _requestApps(s) {
    if (this._appsFor(this.server.current) !== s || s.requested) return;
    clearTimeout(s.timer);
    const version = this.appsCache?.pair === s.pair ? this.appsCache.version : undefined;
    s.requested = this.server.sendToClient({ t: T.PHONE_APPS_LIST, version }) === true;
  }

  // The bridge refreshes inventory after setup. It must use the same deadline and cache.
  refreshApps() {
    const s = this._appsFor(this.server.current);
    if (!s) return this.server.sendToClient({ t: T.PHONE_APPS_LIST });
    s.requested = false;
    clearTimeout(s.timer);
    if (!s.waitingForFrame) this._idleApps(s);
  }

  get connected() {
    return isPhone(this.server.current);
  }

  // Paired phones that discovery sees right now, plus the connected one.
  nearby() {
    const paired = new Map(this.pairing.list().filter((p) => P.isPhoneOs(p.os)).map((p) => [p.id, p]));
    const out = [];
    const c = this.server.current;
    if (isPhone(c)) out.push({ id: c.deviceId, name: c.name, os: c.os, connected: true, usb: !!c.ice });
    // On the cable (it connected through it before): no Wi-Fi needed to show it.
    for (const id of this.wired ? this.wired.byDevice.keys() : []) {
      if (paired.has(id) && !out.some((x) => x.id === id)) out.push({ id, name: paired.get(id).name, os: paired.get(id).os, connected: false, usb: true });
    }
    for (const d of this.discovery.list()) {
      if (!P.isPhoneOs(d.os) || !paired.has(d.id) || out.some((x) => x.id === d.id)) continue;
      out.push({ id: d.id, name: d.name || paired.get(d.id).name, os: d.os, address: d.address, connected: false });
    }
    return out;
  }

  // The tile was clicked: ask the phone to connect. Its hello takes the session from the computer.
  connect(id) {
    if (this.wired && !this.connected && this.wired.connect(String(id))) {
      const p = this.pairing.list().find((x) => x.id === String(id));
      clearTimeout(this.connecting && this.connecting.timer);
      this.connecting = { id: String(id), name: p ? p.name : 'The phone', timer: setTimeout(() => this._doneConnecting(`${p ? p.name : 'The phone'} didn’t answer. Open TwinDesk on it.`), CONNECT_WAIT_MS) };
      this.message = '';
      return this.emit('change');
    }
    const d = this.discovery.get(String(id));
    if (!d || !P.isPhoneOs(d.os)) return this._fail('That phone isn’t nearby any more.');
    if (this.connected && this.server.current.deviceId === d.id) return;
    clearTimeout(this.connecting && this.connecting.timer);
    this.connecting = { id: d.id, name: d.name, timer: setTimeout(() => this._doneConnecting(`${d.name} didn’t answer. Open TwinDesk on it.`), CONNECT_WAIT_MS) };
    this.message = '';
    this.discovery.invite(d.address);
    setTimeout(() => this.connecting && this.connecting.id === d.id && this.discovery.invite(d.address), 700); // UDP may drop one
    this.emit('change');
  }

  // Let the phone go: it won't resume, and the computer reconnects by itself.
  // A dropped phone that is only inside the grace window has no socket to bye, so the block is
  // recorded here too. release() records it again when a session is up.
  // A hello whose welcome is still deferred has no current session yet. releasePending records
  // that phone and closes the socket, so the callback cannot welcome after Disconnect.
  disconnect() {
    const c = this.raw && this.raw.current;
    const grace = this.raw && this.raw.phoneGrace;
    const id = c && P.isPhoneOs(c.os) ? c.deviceId : ((grace && grace.id) || this.pairing.returnPhone);
    if (this.raw && typeof this.raw.releasePending === 'function') this.raw.releasePending(id);
    if (id && this.raw && typeof this.raw.noteReleased === 'function') this.raw.noteReleased(id);
    if (this.raw.current && P.isPhoneOs(this.raw.current.os)) this.raw.release();
    else this.raw.endPhoneGrace(); // dropped and waiting to resume: let it go too
    this.emit('change');
  }

  _fail(message) {
    this.message = message;
    this.emit('change');
  }

  _doneConnecting(message) {
    if (!this.connecting && !message) return;
    clearTimeout(this.connecting && this.connecting.timer);
    this.connecting = null;
    this.message = message;
    this.emit('change');
  }

  _reset() {
    if (!this.info && !this.adb && !this.apps.length) return this.emit('change');
    this.info = null;
    this.adb = null;
    this.apps = [];
    this.assets++;
    this.emit('change');
  }

  // Big things the state push leaves out (it goes out every second): fetched when `assets` bumps.
  assetsView() {
    return { wallpaper: (this.info && this.info.wallpaper) || '', apps: this.apps };
  }

  get view() {
    const c = this.server.current;
    const returning = !isPhone(c) && this.pairing.returnPhone && this.pairing.list().find((p) => p.id === this.pairing.returnPhone);
    return {
      nearby: this.nearby(),
      connected: isPhone(c) ? { id: c.deviceId, name: c.name, os: c.os, rttMs: c.rttMs, usb: !!c.ice } : null,
      connecting: this.connecting ? { id: this.connecting.id, name: this.connecting.name } : null,
      returning: returning ? { id: returning.id, name: returning.name } : null,
      message: this.message,
      held: !isPhone(c) && this.raw.phoneHolds(), // the phone dropped and may come back
      info: this.info && { ...this.info, wallpaper: !!this.info.wallpaper },
      adb: this.adb,
      apps: this.apps.length,
      assets: this.assets,
      bridge: this.bridge ? this.bridge.view : null,
    };
  }
}

module.exports = { Phone };
