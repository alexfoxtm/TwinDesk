// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Signing TwinDesk for iPhone and iPad with the person's own Apple ID, and installing it (opt in;
// Mac, PC and Linux). The work is the signing helper's (ios-signer/: Apple's sign-in, the
// certificate, the signature, the install through the device's cable or Wi-Fi sync); this runs it
// and carries its conversation to whoever answers:
//
//   the iPhone  (the usual way). Its app keeps the signing state in its Keychain: Apple's
//               developer session (good for about a year, in place of the password), the
//               certificate's key and the anisette identity. For a refresh it seals them for the
//               helper (ios/TwinDesk/Core/Signer.swift), so this app, whose console goes to a log
//               file, only passes boxes along and never sees them. Any paired computer can do the
//               refresh, and none keeps a thing.
//   this window (the first install, or an app that expired and can't answer). The Apple ID and its
//               password are typed here, go to the helper's stdin and are gone when it ends; the
//               state it made is handed to the iPhone the next time its app is connected.
//   a kept copy (cfg.keep, on unless switched off; only while the feature is on). This computer keeps the state
//               too, sealed by the system (vault), and refreshes without the iPhone's app: closed,
//               locked or expired. Never the password.
//
// Messages (shared/protocol.js): sign.state (what the iPhone holds), sign.info (what this side
// shows it), sign.start → sign.key → sign.box (a sealed run), sign.ev (the helper's events),
// sign.want (time to refresh), sign.keep (the state, to keep), sign.stop.
//
// Updates: the latest release is looked up (every 6 hours while this is on). When the TwinDesk on the
// device is older, Update TwinDesk (here, or on the iPhone: sign.start {update}) signs and installs
// the release's IPA, downloaded fresh, in place of the refresh's kept copy; the app's data stays.
// cfg.update: do that by itself (the same ways as a refresh: the kept copy, or the iPhone's app).
//
// link: on(type | 'welcome' | 'closed', fn), send(msg), current (the session's ctx: os, id, name).
// near: {list() → [{id, name, os}], invite(id)}: devices linked over Bluetooth (blepipe.js BleHost),
// for an iPhone that isn't in a session: an invite wakes TwinDesk there, which comes back (Ble.swift).
// bins: where the helper may be (the first that exists). usbSerials(): UDIDs on a cable whose app
// is on this session (shared/iosnet.js). cfg()/setCfg(patch): {auto, days, keep, device: {phoneId: udid}}.
// vault: {load() → string, save(string)} sealed by the system, or null where it can't.
// Events: 'change' (this.view).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const T = {
  STATE: 'sign.state', INFO: 'sign.info', START: 'sign.start', KEY: 'sign.key', BOX: 'sign.box',
  EV: 'sign.ev', WANT: 'sign.want', KEEP: 'sign.keep', STOP: 'sign.stop', SET: 'sign.set',
};
const TWINDESK = /^com\.twindesk\.ios\.[A-Z0-9]{6,20}$/; // as signed: its bundle id and the team's
const TWINDESK_IPA = 'TwinDesk.ipa'; // TwinDesk's own IPA in the kept IPAs (cacheDir)
const LOOK_MS = 30 * 60 * 1000; // how often the devices and their apps are looked at
const RETRY_HOURS = [1, 3, 6, 12, 24]; // an automatic refresh isn't tried again sooner (cfg.retry)
const INVITE_MS = 60 * 1000; // an iPhone near over Bluetooth is invited at most this often for a refresh
const DEVICE_WAIT_MS = 30 * 1000; // a refresh the iPhone asked for waits this long for the system to see it
const MAX_LINE = 256 * 1024;
const MAX_STATE = 64 * 1024;
const MAX_IPA = 4 * 1024 * 1024 * 1024;
const RELEASE_API = 'https://api.github.com/repos/InukaAsith/TwinDesk/releases/latest';
const RELEASE_MS = 6 * 60 * 60 * 1000;
const { compare } = require('./updates.js');
const DEVICE_UDID = /^(?:[a-f0-9]{8}-[a-f0-9]{16}|[a-f0-9]{40})$/i;
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const storedView = (info) => (info ? { kind: info.kind === 'bundled' ? 'bundled' : 'stored', version: str(info.version, 40), valid: info.valid === true } : null);
const b64 = (v, n) => (typeof v === 'string' && v.length <= n && /^[A-Za-z0-9+/]+=*$/.test(v) ? v : '');

// The canonical UDID joins the two inventories; usbmuxd's original spelling is used on its wire.
function mergeDevices(mux, core) {
  const devices = new Map();
  const classes = ['iPhone', 'iPad'];
  for (const d of [...mux.map((d) => ({ ...d, muxUdid: d?.udid, wifi: !!d?.ip })), ...core]) {
    if (!DEVICE_UDID.test(d?.udid)) continue;
    const udid = d.udid.toUpperCase();
    const old = devices.get(udid) || {};
    devices.set(udid, {
      udid, muxUdid: old.muxUdid || d.muxUdid, coreId: old.coreId || d.coreId,
      name: str(d.coreId ? d.name || old.name : old.name || d.name, 80),
      klass: (classes.includes(d.klass) && d.klass) || old.klass || '',
      usb: !!(old.usb || d.usb), wifi: !!(old.wifi || d.wifi),
    });
  }
  return [...devices.values()].sort((a, b) => a.udid.localeCompare(b.udid))
    .map((d) => ({ ...d, name: d.name || d.klass || 'iPhone or iPad' }));
}

// A state as the helper gives it: short strings by name, nothing else.
function cleanState(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  let size = 0;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string' || k.length > 200) return null;
    size += k.length + v.length;
    out[k] = v;
  }
  return size && size <= MAX_STATE ? out : null;
}

// What a state says without giving anything away: whose it is and how long its session lasts.
function stateFacts(state) {
  const until = Number(state && state.xcode_token_expiry) || 0;
  return { email: str(state && state.email, 200), until, signedIn: !!(state && state.xcode_token && until > Date.now()) };
}

class IosSign extends EventEmitter {
  // seed: a state made outside the app (ios-signer/try.sh), handed to the iPhone's app like one made here.
  // cacheDir: where the IPAs installed from here are kept (cfg.cache, on), so each can be signed again.
  constructor({ link, near, bins, usbSerials, cfg, setCfg, vault, seed, cacheDir, developer }) {
    super();
    Object.assign(this, { link, near: near || null, usbSerials: usbSerials || (() => []), cfg, setCfg, vault: vault || null, cacheDir: cacheDir || '' });
    this.developer = developer || null;
    this.results = new Map(); // mode and UDID -> last result
    this.bin = (bins || []).find((b) => { try { return fs.statSync(b).isFile(); } catch { return false; } }) || '';
    this.info = null; // the helper's {anyIpa, anisette, version}
    this.devices = []; // [{udid, name, usb}]
    this.apps = {}; // udid -> [{bundleId, name, version, team, teamName, expires}]
    this.phone = null; // sign.state: {signedIn, email, until, auto}
    this.run = null; // {from: 'phone'|'here'|'kept', udid, step, percent, need, error, done, proc}
    this.last = null; // how the last run ended: {error} | {done}
    this.pending = null; // {udid, state}: made here, for the iPhone's app when it's connected
    this.tried = new Map(); // udid -> when an automatic refresh last started
    this._kept = null; // udid -> state, read from the vault the first time it's needed (kept)
    this.switched = false; // on/off was just changed here: said to the iPhone once (sign.info)
    this.queued = null; // a refresh asked for while the iPhone was only near: {now, app}, sent once it connects
    this.invitedAt = 0;
    this.ipa = ''; // an IPA chosen in this window for the next run (builds that install other apps)
    this.seed = cleanState(seed);
    this.stopped = false;
    this.latest = ''; // TwinDesk's latest release ('' not known yet)
    this.latestAt = 0;

    link.on('welcome', () => {
      this.phone = null;
      if (this.run?.from === 'phone' && this.run.owner !== this.link.current)
        this._end({ kind: 'gone', message: 'The device disconnected' });
      this._look();
    });
    link.on('closed', () => {
      this.phone = null;
      this.phoneStart = null;
      if (this.run && this.run.from === 'phone') this._end({ kind: 'gone', message: 'The iPhone disconnected' });
      this.emit('change');
    });
    const on = (t, fn) => link.on(t, (m) => !this._local() && this._ios() && m && typeof m === 'object' && fn(m));
    on(T.STATE, (m) => {
      this.phone = { signedIn: m.signedIn === true, email: str(m.email), until: Number(m.until) || 0, auto: m.auto !== false, expires: Number(m.expires) || 0 };
      this._handOver();
      if (this.queued && this.phone.signedIn && (!this.developer || this._udid({ session: true }) === this.queued.udid)) { this._want(this.queued); this.queued = null; }
      this._tellPhone();
      this._auto();
      this.emit('change');
    });
    on(T.START, (m) => this._phoneStart(m));
    // Switched on or off in the iPhone's app (after its own warning): the same here, so the two agree.
    on(T.SET, (m) => { if (m && typeof m.on === 'boolean') this.set({ on: m.on }, { fromPhone: true }); });
    on(T.BOX, (m) => {
      const r = this.run;
      if (!r || r.from !== 'phone' || r.owner !== this.link.current || !r.proc) return;
      const box = b64(m.box, MAX_LINE);
      if (!box) return;
      const pub = b64(m.pub, 64);
      this._write(pub ? { pub, box } : { box });
    });
    on(T.KEEP, (m) => {
      // The iPhone's copy of the state, for this computer to keep: only when that was switched on here.
      const state = cleanState(m.state);
      const udid = this._udid({ session: true });
      if (!state || !udid || !this._keep()) return;
      this._putKept(udid, state);
      this.emit('change');
    });
    on(T.STOP, () => {
      this.phoneStart = null;
      if (this.run?.from === 'phone' && this.run.owner === this.link.current) this.stop();
    });

    // Off: the helper isn't run at all (not even to ask what it can do). On: it is, now and then.
    if (this.cfg().on === true) this._boot();
  }

  _boot() {
    if (this.stopped || (!this.bin && !this.developer)) return;
    if (this.bin && !this.booted) {
      this.booted = true;
      this._once({ op: 'info' }).then((v) => {
        if (v && v.ev === 'info') this.info = { anyIpa: v.anyIpa === true, anisette: str(v.anisette), version: str(v.version, 20) };
        else this.booted = false; // tried again when switched on again
        this._changed();
        this._look();
      });
    }
    if (this.developer) this._look();
    this._release();
    if (!this.timer) {
      this.timer = setInterval(() => this._look(), LOOK_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  // The latest release's version, for Update TwinDesk (looked up at most every 6 hours).
  async _release(force = false) {
    if (this._local() || this.cfg().on !== true || this.releasing || (!force && Date.now() - this.latestAt < RELEASE_MS)) return;
    this.releasing = true;
    try {
      let f = (url, o) => fetch(url, o);
      try { const { net } = require('electron'); if (net && net.fetch) f = (url, o) => net.fetch(url, o); } catch {}
      const res = await f(`${RELEASE_API}?_=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TwinDesk' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const r = await res.json();
        const v = String(r.tag_name || '').replace(/^v/i, '');
        if (/^\d+(\.\d+)*/.test(v)) { this.latest = v.slice(0, 40); this.latestAt = Date.now(); }
      }
    } catch {} finally {
      this.releasing = false;
    }
    this._changed();
    this._auto();
  }

  // TwinDesk on this device, when a newer release is out: {version, latest}; null otherwise.
  _update(udid) {
    const app = (this.apps[udid] || []).find((a) => a.twindesk);
    return app && this.latest && app.version && compare(this.latest, app.version) > 0 ? { bundleId: app.bundleId, version: app.version, latest: this.latest } : null;
  }

  _local() {
    const c = this.cfg();
    return !!this.developer && (c.mode === 'developer' || (c.mode === undefined
      && c.on === undefined && this.developer.bundled()));
  }

  _ios() { return !!(this.link.current && this.link.current.os === 'ios'); }

  // This computer's copies, from the vault (sealed by the system: the Keychain on a Mac). Read only
  // with Keep a copy on, so the system isn't asked for the vault at all otherwise.
  get kept() {
    if (!this._kept) this._kept = this._keep() ? this._loadKept() : {};
    return this._kept;
  }

  set kept(v) { this._kept = v; }

  // What the window and the timers need about a kept copy (the Apple ID, how long the session lasts)
  // is kept in the plain settings, so the vault itself (a Keychain prompt on a Mac) is only opened
  // when a refresh actually uses the copy, or a new one is stored.
  _factsOf(udid, { exact = false } = {}) {
    if (!udid || !this._keep()) return null;
    const all = this.cfg().keptFacts;
    if (all && typeof all === 'object') return all[udid] || all[this._wireUdid(udid)] ||
      all[Object.keys(all).find((u) => u.toUpperCase() === udid)] || null;
    if (this._kept) return this._kept[udid] ? stateFacts(this._kept[udid]) : null;
    if (exact) return null;
    // Kept before these facts were: there is a copy when the vault file is there.
    return this.vault && this.vault.exists && this.vault.exists() ? { signedIn: true, email: '', until: 0 } : null;
  }

  _hasKept(udid) { return !!this._factsOf(udid); }

  // A state to keep: the vault is written only when it changed (the iPhone sends its copy each time).
  _putKept(udid, state) {
    const h = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
    if ((this.cfg().keptHash || {})[udid] === h) return;
    this.kept[udid] = state;
    this._saveKept();
  }

  // Keep a copy: on by default, but only ever while TwinDesk iPhone is on and there is a vault.
  _keep() {
    const c = this.cfg();
    return !this._local() && c.on === true && c.keep !== false && this._vaultOk();
  }

  // A vault this computer can use. vault.possible may ask the system (Linux: the login keyring), so
  // it is read only while TwinDesk iPhone is on.
  _vaultOk() { return !!this.vault && this.vault.possible !== false; }

  // iPhones linked over Bluetooth (paired with this computer, not in a session here).
  _near() {
    try {
      const cur = this.link.current;
      return ((this.near && this.near.list()) || []).filter((d) => d && d.os === 'ios' && !(cur && cur.id === d.id)).map((d) => ({ id: str(d.id, 64), name: str(d.name, 80) }));
    } catch {
      return [];
    }
  }

  _invite(list = this._near()) {
    if (!this.near || Date.now() - this.invitedAt < INVITE_MS) return false;
    if (!list.length) return false;
    this.invitedAt = Date.now();
    for (const d of list) { try { this.near.invite(d.id); } catch {} }
    return true;
  }

  // The iPhone's app is asked for a refresh: now (Refresh now here), or by itself (cfg.how: 'ask'
  // shows a notification there to tap; 'self' refreshes while it's unlocked, else the notification).
  _want({ now = false, app = '', expires = 0, update = '' } = {}) {
    const c = this.cfg();
    const m = { t: T.WANT, ask: c.how === 'ask', name: '' };
    if (now) m.now = true;
    if (update) { m.update = update; m.name = 'TwinDesk'; } // update: the version it goes to
    if (app) {
      m.app = app;
      const a = Object.values(this.apps).flat().find((x) => x.bundleId === app);
      if (a) m.name = a.name;
    }
    if (expires) m.expires = expires;
    this.link.send(m);
  }

  // ---- what the pages show ----

  get view() {
    const c = this.cfg();
    const udid = this._udid();
    const r = this.run;
    const local = this._local();
    const bound = this._boundUdid();
    const ipa = this._chosenIpa(udid);
    const devices = this.devices.map((d) => {
      const result = this.results.get(`${local}:${d.udid}`);
      const install = local ? (c.localInstalls || {})[d.udid] : (this.apps[d.udid] || []).find((a) => a.twindesk);
      return { ...d, expires: install?.expires || 0, installed: !!install || (local && !!this.localApps?.[d.udid]),
        refreshing: r?.udid === d.udid, result, auto: (c.deviceAuto || {})[d.udid] !== false };
    });
    return {
      mode: local ? 'developer' : 'apple', developer: !!this.developer, bundled: !!this.developer?.bundled(),
      appleReady: !!this.info,
      // available: this build has the helper (known without running it); ready: it answered.
      on: c.on === true, available: !!(this.bin || this.developer), ready: local ? !!this.developer?.bundled() : !!this.info, anyIpa: !local && !!(this.info && this.info.anyIpa), anisette: this.info ? this.info.anisette : '',
      auto: c.auto !== false, days: c.days || 3, how: c.how === 'ask' ? 'ask' : 'self', which: c.which === 'twindesk' ? 'twindesk' : 'all',
      retry: RETRY_HOURS.includes(c.retry) ? c.retry : 6, retries: RETRY_HOURS,
      keep: !local && c.keep !== false && (c.on === true ? this._vaultOk() : !!this.vault), canKeep: !local && (c.on === true ? this._vaultOk() : !!this.vault), cache: c.cache !== false,
      devices, udid, near: !local && c.on === true ? this._near() : [],
      session: !local && this._ios() ? {
        id: str(this.link.current.id, 64), name: str(this.link.current.name, 80),
        udid: this._udid({ session: true }), boundUdid: bound, auto: c.deviceAuto?.[bound] !== false,
      } : null,
      apps: (local ? [] : (udid && this.apps[udid]) || []).map((a) => ({ ...a, cached: !!this._cached(a.bundleId, udid) })),
      phone: !this.developer || udid === this._udid({ session: true }) ? this.phone : null,
      kept: this._factsOf(udid, { exact: !!this.developer }),
      pending: !!(this.pending && this.pending.udid === udid),
      ids: this.ids || null, twindeskIpa: !!this._twindeskIpa(udid),
      update: this._update(udid), latest: this.latest, autoUpdate: c.update === true,
      ipa: ipa ? path.basename(ipa) : '',
      run: r ? { from: r.from, step: r.step, percent: r.percent, need: r.need, seen: r.seen.slice(), note: r.note || '', ipa: r.ipa ? path.basename(r.ipa) : '' } : null,
      last: this.developer ? this.results.get(`${local}:${udid}`) || (!this.last?.udid ? this.last : null) : this.last,
      // Developer mode: the stored TwinDesk build (kind 'stored' | 'bundled', its checked version) and
      // the selected device's last Xcode profile renewal.
      stored: local ? storedView(this.developer.storedInfo?.()) : null,
      renewal: local && udid && this.renewal?.udid === udid ? { state: this.renewal.state, message: this.renewal.message, at: this.renewal.at } : null,
    };
  }

  _boundUdid(peer = this._ios() ? this.link.current.id : '') {
    return peer ? str((this.cfg().device || {})[peer], 64).toUpperCase() : '';
  }

  // The picker may suggest the sole eligible device. Apple ID sessions always use their exact binding.
  _udid({ session = false } = {}) {
    const c = this.cfg();
    const local = this._local();
    const have = new Set(this.devices.filter((d) => local ? d.coreId : !this.developer || d.muxUdid).map((d) => d.udid));
    const bound = this._boundUdid();
    if (this.developer && session) return !local && have.has(bound) ? bound : '';
    const picked = local ? c.localDevice : this.developer ? c.appleDevice || bound || c.alone : this._ios() ? bound : c.alone;
    const exact = str(picked, 64).toUpperCase();
    if (!this.developer) {
      const wired = this.usbSerials().map((u) => u.toUpperCase()).find((u) => have.has(u));
      if (wired) return wired;
    }
    if (have.has(exact)) return exact;
    return have.size === 1 ? [...have][0] : '';
  }

  _wireUdid(udid) { return this.devices.find((d) => d.udid === udid)?.muxUdid || udid; }

  // Older Mac caches have no record of the device that supplied the IPA.
  _cacheDirectory(udid) {
    if (!this.cacheDir || !this.developer) return this.cacheDir;
    return DEVICE_UDID.test(udid) ? path.join(this.cacheDir, udid) : '';
  }

  // The IPA kept for an app, by its bundle id as installed ('' none).
  _cached(bundleId, udid) {
    const dir = this._cacheDirectory(udid);
    if (!dir || !/^[A-Za-z0-9.-]{1,200}$/.test(bundleId || '')) return '';
    const f = path.join(dir, `${bundleId}.ipa`);
    try { return fs.statSync(f).isFile() ? f : ''; } catch { return ''; }
  }

  // After an install: the IPA it came from is kept (or, TwinDesk's own release installed, its older copy goes).
  _cache(r, done) {
    const dir = this._cacheDirectory(r.udid);
    if (!dir || !/^[A-Za-z0-9.-]{1,200}$/.test(done.bundleId || '')) return;
    // A TwinDesk build installed from a file becomes the TwinDesk this computer refreshes with.
    const to = path.join(dir, TWINDESK.test(done.bundleId) ? TWINDESK_IPA : `${done.bundleId}.ipa`);
    try {
      if (!r.ipa) return; // TwinDesk from the kept copy, or downloaded and kept by the helper
      if (this.cfg().cache === false || path.resolve(r.ipa) === to) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(r.ipa, to);
    } catch {}
  }

  _tellPhone() {
    if (!this._ios()) return;
    if (this._local()) {
      this.link.send({ t: T.INFO, on: false, available: false });
      return;
    }
    const v = this.view;
    const udid = this._udid({ session: true });
    this.link.send({
      // Available once switched on here: the device is looked for when a refresh starts (it may be
      // seen over Wi-Fi only then). seen: the system sees it now (cable or Wi-Fi sync).
      // on: switched on here (the iPhone's app follows it); switched: just now, by the person here
      // (only then does an iPhone that is on follow it off).
      on: v.on, switched: this.switched,
      t: T.INFO, available: v.on && v.ready, seen: !!udid, anyIpa: v.anyIpa, anisette: v.anisette, keep: v.on && v.keep && (!this.developer || !!udid), days: v.days,
      apps: (this.apps[udid] || []).map((a) => ({ ...a, cached: !!this._cached(a.bundleId, udid) })), busy: !!v.run, latest: v.latest, autoUpdate: v.autoUpdate,
    });
  }

  _changed() {
    this._tellPhone();
    this.switched = false;
    this.emit('change');
  }

  // ---- the helper ----

  // One question, one answer (info, devices, apps).
  async _once(req) {
    const all = await this._lines(req);
    return all.length ? all[all.length - 1] : null;
  }

  // Every line a short request answers with (appids: the state, then the list).
  _lines(req) {
    return new Promise((resolve) => {
      let out = '';
      let p;
      try { p = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return resolve([]); }
      const timer = setTimeout(() => p.kill(), 30000);
      p.stdout.on('data', (d) => { if (out.length < 4 * 1024 * 1024) out += d; });
      p.on('error', () => resolve([]));
      p.on('close', () => {
        clearTimeout(timer);
        resolve(out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === 'object'));
      });
      p.stdin.on('error', () => {});
      p.stdin.end(`${JSON.stringify(req)}\n`);
    });
  }

  // The Apple ID's app IDs, read with this computer's copy of the session (nothing is changed at Apple).
  async listIds() {
    if (this._local()) return;
    const udid = this._udid();
    const state = this._hasKept(udid) ? this.kept[udid] : null;
    if (!this.info || this.idsBusy) return;
    if (!state) { this.ids = { error: 'View app IDs needs the developer session stored on this computer' }; return this._changed(); }
    this.idsBusy = true;
    this.ids = { loading: true };
    this._changed();
    try {
      const out = await this._lines({ op: 'appids', state });
      if (this._local() || this._udid() !== udid || this.cfg().on !== true) return;
      const st = out.find((x) => x.ev === 'state');
      if (st && cleanState(st.state) && this._keep()) this._putKept(udid, cleanState(st.state));
      const v = out[out.length - 1] || {};
      this.ids = v.ev === 'appids' ? {
        at: Date.now(), team: str(v.team, 20), teamName: str(v.teamName, 100),
        max: Number.isFinite(v.max) ? v.max : null, available: Number.isFinite(v.available) ? v.available : null,
        list: (Array.isArray(v.ids) ? v.ids : []).slice(0, 200).map((a) => ({ id: str(a.id, 200), name: str(a.name, 100), expires: Number(a.expires) || 0 })),
      } : { error: str(v.message, 300) || 'Apple didn’t answer' };
    } finally {
      this.idsBusy = false;
    }
    this._changed();
  }

  // TwinDesk's own IPA as this computer keeps it (Store IPAs on): the last release downloaded, or a
  // build installed from a file. The helper checks it is TwinDesk before using it.
  _twindeskIpa(udid) {
    const dir = this._cacheDirectory(udid);
    if (!dir || this.cfg().cache === false) return '';
    const f = path.join(dir, TWINDESK_IPA);
    try { if (fs.statSync(f).isFile()) return f; } catch {}
    return this._cached(((this.apps[udid] || []).find((a) => a.twindesk) || {}).bundleId, udid);
  }

  // A refresh of an app that is on the device: the helper installs Apple's new profiles only, and
  // signs and installs the app again only when that can't be done (AltStore refreshes the same way).
  _refreshOnly(req, udid, bundleId) {
    const apps = this.apps[udid] || [];
    const app = bundleId ? apps.find((a) => a.bundleId === bundleId) : apps.find((a) => a.twindesk);
    if (app) req.profile_only = app.bundleId;
    return req;
  }

  // A run that installs TwinDesk itself: from the kept copy, else downloaded and then kept.
  // fresh (an update, or a kept copy older than the TwinDesk on the device would be): the latest
  // release is downloaded, and kept in place of the old copy.
  _twinDesk(req, udid, fresh = false) {
    const kept = fresh || this._update(udid) ? '' : this._twindeskIpa(udid);
    if (kept) req.twindesk_ipa = kept;
    else {
      const dir = this._cacheDirectory(udid);
      if (dir && this.cfg().cache !== false) req.save_ipa = path.join(dir, TWINDESK_IPA);
    }
    return req;
  }

  // The helper and CoreDevice can report the same hardware over different transports.
  _look() {
    if (!this.scanTask) this.scanTask = this._scan().finally(() => {
      this.scanTask = null;
      if (this.rescan) { this.rescan = false; this._look(); }
    });
    return this.scanTask;
  }

  async _scan() {
    if ((!this.bin && !this.developer) || this.stopped) return;
    if (this.cfg().on !== true) { this.devices = []; this.apps = {}; this.localApps = {}; return this._changed(); }
    const controller = new AbortController();
    this.scan = controller;
    const { signal } = controller;
    const local = this._local();
    this._release();
    try {
      const before = this._udid();
      const [mux, core] = await Promise.all([
        this.bin ? this._once({ op: 'devices' }) : null,
        this.developer ? this.developer.list(signal).catch(() => []) : [],
        local && this.developer.stored ? this.developer.stored(signal).catch(() => null) : null,
      ]);
      if (signal.aborted) return;
      this.devices = mergeDevices(Array.isArray(mux?.devices) ? mux.devices : [], core).slice(0, 20);
      const udid = this._udid();
      if (this.developer && before !== udid) this.ids = null;
      if (!local && udid && (!this.developer || udid === this._udid({ session: true })) && this.seed && !this.pending) { this.pending = { udid, state: this.seed }; this.seed = null; this._handOver(); }
      const devices = this.developer ? this.devices : this.devices.filter((d) => d.udid === udid);
      for (let i = 0; i < devices.length && !signal.aborted; i += 4) {
        await Promise.all(devices.slice(i, i + 4).map(async (d) => {
          if (local) {
            const checked = this.cfg().localInstalls?.[d.udid];
            if (!d.coreId || (d.udid !== udid && !this.cfg().localInstalls?.[d.udid])) return;
            try {
              const installed = await this.developer.apps(d, signal);
              if (signal.aborted || this.run?.udid === d.udid) return;
              (this.localApps ||= {})[d.udid] = !!installed;
              const receipts = this.cfg().localInstalls || {};
              const receipt = receipts[d.udid];
              if (receipt && receipt === checked && (!installed || (installed.version && installed.version !== receipt.version))) {
                const next = { ...receipts };
                delete next[d.udid];
                this.setCfg({ localInstalls: next });
                this.results.delete(`true:${d.udid}`);
              }
            } catch {} // A disconnected or locked device can't confirm its inventory.
            return;
          }
          if (!d.muxUdid) return;
          const a = await this._once({ op: 'apps', udid: d.muxUdid });
          if (signal.aborted || !Array.isArray(a?.apps)) return;
          this.apps[d.udid] = a.apps.slice(0, 50).filter((x) => x && typeof x.bundleId === 'string').map((x) => ({
            bundleId: str(x.bundleId), name: str(x.name, 100), version: str(x.version, 40), team: str(x.team, 20), teamName: str(x.teamName, 100),
            expires: Number(x.expires) || 0, twindesk: TWINDESK.test(x.bundleId),
          })).sort((p, q) => p.expires - q.expires);
        }));
      }
    } finally {
      this.scan = null;
    }
    if (signal.aborted) return;
    this._changed();
    this._auto();
  }

  _write(obj) {
    const p = this.run && this.run.proc;
    if (p && p.stdin.writable) p.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  // A signing run: the request's first line in, its events out to onEvent until it ends.
  _start(run, req) {
    this.last = null;
    this.run = { step: 'start', percent: 0, need: null, seen: [], ipa: req.ipa || '', ...run };
    const r = this.run;
    let buf = '';
    let p;
    try { p = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return this._end({ kind: 'other', message: 'The signing helper didn’t start' }); }
    r.proc = p;
    p.stdin.on('error', () => {});
    p.on('error', () => { if (this.run === r) this._end({ kind: 'other', message: 'The signing helper didn’t start' }); });
    p.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE * 2) return p.kill();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev = null;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev && typeof ev.ev === 'string' && this.run === r) this._event(r, ev);
      }
    });
    p.on('close', () => { if (this.run === r) this._end(r.failed || (r.finished ? null : { kind: 'other', message: 'The signing helper stopped' }), r.finished); });
    p.stdin.write(`${JSON.stringify({ ...req, udid: this._wireUdid(req.udid) })}\n`);
    this._changed();
  }

  _event(r, ev) {
    const toPhone = r.from === 'phone';
    if (toPhone && r.owner !== this.link.current) return this._end({ kind: 'gone', message: 'The device disconnected' });
    switch (ev.ev) {
      case 'key': if (toPhone) this.link.send({ t: T.KEY, pub: b64(ev.pub, 64) }); return;
      case 'step': r.step = str(ev.step, 20); r.percent = 0; r.need = null; if (!r.seen.includes(r.step)) r.seen.push(r.step); break;
      case 'progress': {
        const step = str(ev.step, 20) || 'install';
        if (step !== r.step) { r.step = step; r.need = null; if (!r.seen.includes(step)) r.seen.push(step); }
        r.percent = Math.max(0, Math.min(100, Number(ev.percent) || 0));
        break;
      }
      case 'need2fa':
        r.need = { what: 'code', sms: ev.sms === true, error: str(ev.error), numbers: Array.isArray(ev.numbers) ? ev.numbers.slice(0, 10).map((n) => ({ id: Number(n.id) || 0, number: str(n.number, 40) })) : [] };
        break;
      case 'needcert':
        // Any of them may be revoked, when the person picks it: another tool's only after a warning.
        r.need = { what: 'cert', certs: Array.isArray(ev.certs) ? ev.certs.slice(0, 20).map((c) => ({ serial: str(c.serial, 80), name: str(c.name, 100), machine: str(c.machine, 100), expires: Number(c.expires) || 0, ours: c.ours === true || c.machine === 'TwinDesk' })) : [] };
        break;
      case 'state':
        if (toPhone) break; // sealed: the iPhone's to open
        this._gotState(r.udid, cleanState(ev.state));
        return;
      case 'note': r.note = str(ev.message, 300); this._changed(); return; // said on this page only
      case 'done': r.finished = { expires: Number(ev.expires) || 0, bundleId: str(ev.bundleId), device: str(ev.device, 80), profileOnly: ev.profileOnly === true }; break;
      case 'error': r.failed = { kind: str(ev.kind, 20) || 'other', code: Number.isFinite(ev.code) ? ev.code : null, message: str(ev.message, 300), detail: str(ev.detail, 300) }; break;
      default: return;
    }
    // The iPhone gets the events as they are (its sealed state among them), cut to what it shows.
    if (toPhone) {
      const out = { t: T.EV, ev: ev.ev };
      if (ev.ev === 'state') out.box = b64(ev.box, MAX_LINE);
      else if (ev.ev === 'need2fa' || ev.ev === 'needcert') Object.assign(out, r.need);
      else if (ev.ev === 'done') Object.assign(out, r.finished);
      else if (ev.ev === 'error') Object.assign(out, r.failed);
      else Object.assign(out, { step: r.step, percent: r.percent });
      this.link.send(out);
    }
    // The helper's last word (its state came before it): the run is over, whatever it does next.
    if (r.finished || r.failed) return this._end(r.failed, r.finished);
    this._changed();
  }

  // A state made by a run answered here: for the iPhone's app (now, or when it connects) and, when
  // this computer keeps a copy, the vault.
  _gotState(udid, state) {
    if (!state || !udid) return;
    this.pending = { udid, state };
    if (this._keep()) this._putKept(udid, state);
    this._handOver();
  }

  _handOver() {
    if (!this.pending || !this._ios() || this._udid({ session: true }) !== this.pending.udid) return;
    this.link.send({ t: T.KEEP, state: this.pending.state });
    this.pending = null;
    this.emit('handed');
  }

  _end(failed, done) {
    const r = this.run;
    if (!r) return;
    this.run = null;
    if (r.proc && r.proc.exitCode === null) r.proc.kill();
    if (!failed && done) {
      this._cache(r, done);
      const app = (this.apps[r.udid] || []).find((a) => a.bundleId === done.bundleId);
      if (app && done.expires) app.expires = done.expires;
      // The device this iPhone's app is on, for the next time it isn't on its cable.
      const cur = this.link.current;
      if (r.from === 'phone' && cur && r.owner === cur && cur.id && this._ios() && r.udid) this.setCfg({ device: { ...(this.cfg().device || {}), [cur.id]: r.udid } });
    }
    this.last = failed ? { error: failed, from: r.from } : { done: done || {}, from: r.from, at: Date.now() };
    if (this.developer) {
      this.last.udid = r.udid;
      this.results.set(`${r.from === 'developer'}:${r.udid}`, this.last);
    }
    if (failed && r.from === 'phone' && failed.kind === 'gone') this.last = null;
    this._changed();
    this._look();
  }

  // ---- runs ----

  _ipa(ipa) {
    // An IPA the person picked: a file of theirs ending in .ipa, as it is on disk.
    try {
      let p = String(ipa.path || '');
      if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
      const real = fs.realpathSync(path.resolve(p));
      const st = fs.statSync(real);
      const home = fs.realpathSync(os.homedir());
      if (!/\.ipa$/i.test(real) || !st.isFile() || st.size > MAX_IPA) return '';
      if (ipa.fromPhone && (!real.startsWith(home + path.sep) || (ipa.size && st.size !== ipa.size))) return '';
      return real;
    } catch {
      return '';
    }
  }

  _ready(reply, udid = this._udid()) {
    const no = (message, kind = 'other') => { reply({ kind, message }); return ''; };
    if (this._local() || !this.info) return no('The signing helper isn’t in this build');
    if (this.cfg().on !== true) return no('TwinDesk iPhone is off on this computer');
    if (this.run) return no('A refresh is already running', 'busy');
    if (!udid) return no(this.devices.length ? 'Choose which iPhone this is on the computer' : 'This computer doesn’t see the iPhone: connect its cable once and tap Trust', 'device');
    return udid;
  }

  // The iPhone asks for a refresh (or an install of a file it sent): sealed from here on.
  // The iPhone just came to the front for it (a notification tapped): the system may see it over
  // Wi-Fi only a moment later, so it's looked for a while first.
  async _phoneStart(m) {
    const owner = this.link.current;
    const request = this.phoneStart = {};
    const fail = (e) => { if (this.link.current === owner) this.link.send({ t: T.EV, ev: 'error', ...e }); };
    const until = Date.now() + DEVICE_WAIT_MS;
    const udidForPhone = () => this._udid({ session: true });
    if (this.developer && !(this.cfg().device || {})[owner?.id]) {
      this.phoneStart = null;
      return fail({ kind: 'device', message: 'Link this TwinDesk session to the iPhone or iPad on the Mac' });
    }
    while (this.info && this.cfg().on === true && !this.run && !udidForPhone()
        && this.phoneStart === request && this.link.current === owner && !this._local() && Date.now() < until) {
      this.link.send({ t: T.EV, ev: 'step', step: 'find', percent: 0 });
      await this._look();
      if (!udidForPhone()) await new Promise((res) => setTimeout(res, 4000));
    }
    if (this.phoneStart !== request || this.link.current !== owner || this._local()) return;
    this.phoneStart = null;
    const udid = this._ready(fail, udidForPhone());
    if (!udid) return;
    const req = { op: 'install', sealed: true, udid };
    if (m.fresh === true) req.new_cert = true; // Start over, from the iPhone: TwinDesk's certificate revoked, a new one made
    // An app installed from here before, by its kept IPA; TwinDesk itself too when its IPA is kept
    // (a build installed from a file stays that build), else TwinDesk's latest release.
    const again = m.app ? this._cached(str(m.app), udid) : '';
    if (m.update === true && !m.app && !m.ipa) this._twinDesk(req, udid, true); // Update TwinDesk: the release, signed and installed
    else if (!m.app && !m.ipa) { this._twinDesk(req, udid); this._refreshOnly(req, udid); }
    else if (again && this.info.anyIpa) { req.ipa = again; this._refreshOnly(req, udid, str(m.app)); }
    else if (m.app && this.info.anyIpa && (this.apps[udid] || []).some((a) => a.bundleId === str(m.app))) { req.no_ipa = true; this._refreshOnly(req, udid, str(m.app)); }
    else if (m.app) return fail({ kind: 'other', message: 'That app isn’t on the device' });
    else if (m.ipa) {
      if (!this.info.anyIpa) return fail({ kind: 'other', message: 'This computer’s TwinDesk only installs TwinDesk' });
      req.ipa = this._ipa({ path: str(m.ipa.path, 1000), size: Number(m.ipa.size) || 0, fromPhone: true });
      if (!req.ipa) return fail({ kind: 'other', message: 'That file isn’t on the computer yet' });
    }
    this._start({ from: 'phone', udid, owner }, req);
  }

  // Typed in this window: {email, password}. Nothing of it is kept.
  signIn({ email, password, udid: expected }) {
    if (this.developer && expected !== this._udid()) return;
    const udid = this._ready((e) => { this.last = { error: e, from: 'here' }; this.emit('change'); });
    if (!udid) return;
    const req = { op: 'install', udid, email: str(email, 200), password: str(password, 500) };
    const known = (this.pending && this.pending.udid === udid && this.pending.state) || (this._hasKept(udid) ? this.kept[udid] : null);
    if (known) req.state = known; // the same certificate and identity as before
    const ipa = this._chosenIpa(udid);
    if (ipa) req.ipa = ipa;
    else this._twinDesk(req, udid);
    this.ipa = '';
    this._start({ from: 'here', udid }, req);
  }

  // With this computer's kept copy, no iPhone app needed.
  refreshKept({ update = false, target, automatic = false, app = '' } = {}) {
    const udid = this._ready((e) => { this.last = { error: e, from: 'kept' }; this.emit('change'); }, target);
    if (!udid) return;
    if (!this.kept[udid]) return;
    if (!this.cfg().keptFacts) this._saveFacts(); // a copy kept before the facts were
    const req = { op: 'install', udid, state: this.kept[udid] };
    if (update) {
      this._twinDesk(req, udid, true);
      this._start({ from: 'kept', udid, update: true, automatic }, req);
      return;
    }
    if (app) {
      const file = this._cached(app, udid);
      if (file) req.ipa = file;
      else req.no_ipa = true;
      this._refreshOnly(req, udid, app);
    } else if (!automatic && this._chosenIpa(udid)) {
      req.ipa = this._chosenIpa(udid);
      this.ipa = '';
    } else {
      this._twinDesk(req, udid);
      this._refreshOnly(req, udid);
    }
    this._start({ from: 'kept', udid, automatic }, req);
  }

  // Manual use targets the current selection. The scheduler can only reuse a successful
  // installation on this same paired device.
  async installDeveloper(udid, automatic = false) {
    const c = this.cfg();
    if (!this._local() || c.on !== true || this.stopped || this.run) return null;
    const selected = this.devices.find((d) => d.udid === udid);
    const previous = (c.localInstalls || {})[udid];
    if (!selected?.coreId || (automatic ? !previous || c.auto === false || c.deviceAuto?.[udid] === false : udid !== this._udid())) return null;
    this.tried.set(`developer ${udid}`, Date.now());
    const controller = new AbortController();
    const r = { from: 'developer', udid, automatic, step: 'start', seen: [], percent: 0, controller };
    this.run = r;
    this.results.delete(`true:${udid}`);
    this._changed();
    try {
      const done = await this.developer.install(selected, controller.signal, {
        minExpiry: previous?.expires || 0, requireNewer: automatic,
        // Profiles are renewed (profile-only) when they run out within cfg.days, and always on Refresh now.
        renewWithin: (Number.isInteger(c.days) && c.days >= 1 && c.days <= 6 ? c.days : 3) * 86400, force: !automatic,
        onRenewal: (renewal) => {
          if (this.run !== r || controller.signal.aborted) return;
          this.renewal = { udid, state: str(renewal?.state, 20), message: str(renewal?.message, 250), at: Date.now() };
          this._changed();
        },
      });
      controller.signal.throwIfAborted();
      if (!done) {
        this.run = null;
        this._changed();
        this._auto();
        return null;
      }
      this.setCfg({ localInstalls: { ...this.cfg().localInstalls, [udid]: done } });
      this._end(null, done);
      return done;
    } catch (error) {
      const failed = controller.signal.aborted ? { kind: 'stopped', message: 'Stopped' }
        : { kind: error.kind || 'other', message: error.kind === 'device' || !error.code ? str(error.message, 250) : 'Could not prepare or install TwinDesk' };
      this._end(failed);
      return null;
    }
  }

  // Refresh now, whichever way there is: the kept copy, or the iPhone's app.
  refresh(expected) {
    const udid = this._udid();
    if (this.developer && expected !== udid) return;
    if (this._local()) return;
    if (this._hasKept(udid)) return this.refreshKept();
    if (this._ios() && (!this.developer || (udid && udid === this._udid({ session: true }))) && this.phone && this.phone.signedIn && !this._chosenIpa(udid)) return this._want({ now: true });
    // The iPhone is only near over Bluetooth: it's invited, and asked once it's back.
    const near = this._near().filter((d) => !this.developer || (udid && this._boundUdid(d.id) === udid));
    if (!this._ios() && near.length) {
      this.queued = { now: true, udid };
      this.invitedAt = 0;
      this._invite(near);
      this.last = { info: 'Waking TwinDesk on the iPhone over Bluetooth…' };
      this.emit('change');
    }
  }

  // Update TwinDesk on the device to the latest release: this computer's copy, or the iPhone's app.
  updateTwinDesk(expected) {
    const udid = this._udid();
    if (this.developer && expected !== udid) return;
    if (this._local() || this.run || !this.info || !this._update(udid)) return;
    this.tried.set(`${udid} update`, Date.now());
    if ((this._factsOf(udid) || {}).signedIn) return this.refreshKept({ update: true });
    if (this._ios() && (!this.developer || udid === this._udid({ session: true })) && this.phone && this.phone.signedIn) this._want({ now: true, update: this.latest });
  }

  // One app again, from its kept IPA: with this computer's copy of the session, or by asking the iPhone.
  // Without its IPA too: a refresh installs Apple's new profiles only, and the IPA is needed only
  // when the app has to be signed again (the helper says so then).
  refreshApp(bundleId, expected) {
    const udid = this._udid();
    if (this.developer && expected !== udid) return;
    if (this._local() || !udid || this.run || !this.info || !this.info.anyIpa || !(this.apps[udid] || []).some((a) => a.bundleId === bundleId)) return;
    this.tried.set(`${udid} ${bundleId}`, Date.now());
    if ((this._factsOf(udid) || {}).signedIn) return this.refreshKept({ app: bundleId });
    if (this._ios() && (!this.developer || udid === this._udid({ session: true })) && this.phone && this.phone.signedIn) this._want({ now: true, app: bundleId });
  }

  // An IPA chosen in this window ('' none): the next run typed here, or with the kept copy, installs it.
  _chosenIpa(udid) {
    return !this.developer || (udid && udid === this.ipaDevice) ? this.ipa : '';
  }

  setIpa(file, udid = this._udid()) {
    if (this.developer && (!udid || udid !== this._udid())) return;
    this.ipaDevice = udid;
    this.ipa = !this._local() && file && this.info && this.info.anyIpa ? this._ipa({ path: file }) : '';
    this.emit('change');
  }

  // One action from the window: {a: 'look' | 'set' | 'signin' | 'refresh' | 'answer' | 'stop' | 'ipa', …}.
  act(o) {
    if (!o || typeof o !== 'object') return;
    if (o.a === 'look') this.look();
    else if (o.a === 'set') this.set(o);
    else if (o.a === 'signin') this.signIn(o);
    else if (o.a === 'refresh' && !this._local()) this.refresh(o.udid);
    else if (o.a === 'installDeveloper') this.installDeveloper(str(o.udid));
    else if (o.a === 'update') this.updateTwinDesk(o.udid);
    else if (o.a === 'release') this._release(true);
    else if (o.a === 'answer') this.answer(o);
    else if (o.a === 'stop') this.stop();
    else if (o.a === 'ipa') this.setIpa('');
    else if (o.a === 'app') this.refreshApp(str(o.bundleId), o.udid);
    else if (o.a === 'appids') this.listIds();
  }

  // An answer typed here to a run answered here: {code} | {sms} | {devices} | {resend} | {revoke: [serial]} | {abort}.
  answer(a) {
    const r = this.run;
    if (!r || r.from === 'phone' || !r.need || !a || typeof a !== 'object') return;
    const out = {};
    if (typeof a.code === 'string') out.code = a.code.replace(/\D/g, '').slice(0, 8);
    else if (Number.isInteger(a.sms)) out.sms = a.sms;
    else if (a.devices === true) out.devices = true;
    else if (a.resend === true) out.resend = true;
    else if (Array.isArray(a.revoke)) out.revoke = a.revoke.filter((s) => r.need.certs && r.need.certs.some((c) => c.serial === s)); // another tool's only after its warning (the window's dialog)
    else out.abort = true;
    r.need = null;
    this._write(out);
    this.emit('change');
  }

  stop() {
    if (this.run?.controller) this.run.controller.abort();
    else if (this.run) this._end({ kind: 'stopped', message: 'Stopped' });
    this.queued = null;
    this.phoneStart = null;
  }

  // Time for it? An app runs out within cfg.days (TwinDesk, and with cfg.which 'all' every app whose
  // IPA is kept here): this computer's copy does it, or the iPhone's app is asked (it decides: its
  // own switch, cfg.how, and only while it's unlocked). Not in a session but near over Bluetooth:
  // invited, and asked once it's back.
  _auto() {
    const c = this.cfg();
    if (c.on !== true || c.auto === false || this.run || this.stopped) return;
    const soon = (expires) => expires && expires * 1000 - Date.now() <= (c.days || 3) * 86400000;
    const again = (RETRY_HOURS.includes(c.retry) ? c.retry : 6) * 3600 * 1000;
    const rested = (key) => Date.now() - (this.tried.get(key) || 0) >= again;
    if (this._local()) {
      if (!this.developer.bundled()) return;
      const due = this.devices.filter((d) => d.coreId && c.deviceAuto?.[d.udid] !== false
        && soon(c.localInstalls?.[d.udid]?.expires) && rested(`developer ${d.udid}`))
        .sort((a, b) => c.localInstalls[a.udid].expires - c.localInstalls[b.udid].expires)[0];
      if (due) this.installDeveloper(due.udid, true);
      return;
    }
    if (!this.info) return;
    const selected = this._udid();
    const udid = this.developer && c.deviceAuto?.[selected] === false ? '' : selected;
    const bound = this._boundUdid();
    const sessionUdid = this._udid({ session: true });
    const canAskPhone = this._ios() && this.phone?.signedIn && this.phone.auto
      && (!this.developer || (bound && c.deviceAuto?.[bound] !== false));
    const viaPhone = canAskPhone && (!this.developer || udid === sessionUdid);
    const hasCopy = (u) => !!this._factsOf(u, { exact: !!this.developer })?.signedIn;
    const dueApp = (u) => (this.apps[u] || []).find((a) => soon(a.expires) && rested(`${u} ${a.bundleId}`)
      && (a.twindesk || (c.which !== 'twindesk' && this._cached(a.bundleId, u))));
    if (this.developer) {
      for (const d of this.devices) {
        if (!d.muxUdid || d.udid === selected || c.deviceAuto?.[d.udid] === false || !hasCopy(d.udid)) continue;
        const update = c.update === true && this._update(d.udid) && rested(`${d.udid} update`);
        const due = dueApp(d.udid);
        if (!update && (!due || (!due.twindesk && !this.info.anyIpa))) continue;
        this.tried.set(update ? `${d.udid} update` : `${d.udid} ${due.bundleId}`, Date.now());
        return this.refreshKept({
          update, target: d.udid, automatic: true, app: !update && !due.twindesk ? due.bundleId : '',
        });
      }
    }
    // Update TwinDesk by itself (cfg.update): before any refresh, as installing the release refreshes it too.
    const viaCopy = hasCopy(udid);
    if (c.update === true && this._update(udid) && rested(`${udid} update`) && (viaCopy || viaPhone)) {
      this.tried.set(`${udid} update`, Date.now());
      if (viaCopy) return this.refreshKept({ update: true, automatic: true });
      return this._want({ update: this.latest });
    }
    // The authenticated device may become visible over Wi-Fi after receiving the request.
    if (canAskPhone && !(this.developer ? sessionUdid : udid) && soon(this.phone.expires)) {
      const key = `phone ${this.link.current.id}`;
      if (rested(key)) {
        this.tried.set(key, Date.now());
        return this._want({ expires: this.phone.expires });
      }
    }
    const due = dueApp(udid);
    if (!due && !this._ios()) {
      const twinDue = (apps) => apps.some((a) => a.twindesk && soon(a.expires));
      if (this.developer) this._invite(this._near().filter((d) => {
        const u = this._boundUdid(d.id);
        return u && c.deviceAuto?.[u] !== false && twinDue(this.apps[u] || []);
      }));
      else if (Object.values(this.apps).some(twinDue)) this._invite();
    }
    if (!due || (!viaPhone && !viaCopy)) return;
    if (!due.twindesk && this.info.anyIpa) {
      this.tried.set(`${udid} ${due.bundleId}`, Date.now());
      if (viaCopy) return this.refreshKept({ automatic: true, app: due.bundleId });
      return this._want({ app: due.bundleId, expires: due.expires });
    }
    if (!due.twindesk) return;
    this.tried.set(`${udid} ${due.bundleId}`, Date.now());
    if (viaCopy) return this.refreshKept({ automatic: true });
    this._want({ expires: due.expires });
  }

  // ---- settings ----

  set(o, { fromPhone = false } = {}) {
    if (!o || typeof o !== 'object') return;
    const patch = {};
    if (typeof o.on === 'boolean') {
      patch.on = o.on;
      if (!fromPhone && o.on !== (this.cfg().on === true)) this.switched = true;
      if (o.on) setImmediate(() => this._boot());
      if (!o.on && !this._local()) { this._kept = {}; this._saveKept(); this.pending = null; this.queued = null; } // off: nothing of it stays here (the Keep a copy setting does)
    }
    if (typeof o.auto === 'boolean') patch.auto = o.auto;
    if (this.developer && ['apple', 'developer'].includes(o.mode)) {
      patch.mode = o.mode;
      if ((o.mode === 'developer') !== this._local()) {
        patch.on = false; // Each signing mode is enabled independently.
        this.switched = false;
      }
    } else if (this.developer && o.on === true && this.cfg().mode === undefined) {
      patch.mode = this._local() ? 'developer' : 'apple';
    }
    if (typeof o.update === 'boolean') patch.update = o.update;
    if (Number.isInteger(o.days) && o.days >= 1 && o.days <= 6) patch.days = o.days;
    if (o.how === 'ask' || o.how === 'self') patch.how = o.how;
    if (o.which === 'all' || o.which === 'twindesk') patch.which = o.which;
    if (RETRY_HOURS.includes(o.retry)) { patch.retry = o.retry; this.tried.clear(); }
    if (typeof o.cache === 'boolean') {
      patch.cache = o.cache;
      if (!o.cache && this.cacheDir) { try { fs.rmSync(this.cacheDir, { recursive: true, force: true }); } catch {} } // switched off: the kept IPAs go
    }
    if (!this._local() && typeof o.keep === 'boolean' && (this._vaultOk() || !o.keep)) {
      patch.keep = o.keep;
      if (!o.keep) { this._kept = {}; this._saveKept(); } // switched off: this computer's copies go
    }
    const selected = this.devices.find((d) => d.udid === o.udid);
    if (this.developer && typeof o.deviceAuto === 'boolean') {
      if (this._local() ? selected?.coreId : selected?.muxUdid || (o.udid && o.udid === this._boundUdid())) {
        patch.deviceAuto = { ...this.cfg().deviceAuto, [o.udid]: o.deviceAuto };
      }
    } else if (selected) {
      const cur = this.link.current;
      if (this._local()) {
        if (selected.coreId) patch.localDevice = selected.udid;
      } else if (selected.muxUdid || !this.developer) {
        if (this.developer) patch.appleDevice = selected.udid;
        if (cur && cur.id && this._ios() && (!this.developer || (o.bind === true && o.session === cur.id)))
          patch.device = { ...(this.cfg().device || {}), [cur.id]: selected.udid };
        else patch.alone = selected.udid;
      }
    }
    const local = this._local();
    const prior = this._udid();
    const priorSession = this._udid({ session: true });
    this.setCfg(patch);
    if (this.developer && prior !== this._udid()) {
      this.ipa = '';
      this.ids = null;
    }
    if (local !== this._local()) {
      this.phone = null;
      this.pending = null;
      this.ipa = '';
      this.queued = null;
      this.last = null;
    }
    if (patch.on === false || local !== this._local() || prior !== this._udid()
        || priorSession !== this._udid({ session: true })
        || (this.run?.automatic && (patch.auto === false || patch.deviceAuto?.[this.run.udid] === false))) this.stop();
    if ((patch.on === false || local !== this._local() || prior !== this._udid()) && this.scan) {
      this.rescan = true;
      this.scan.abort();
    }
    if ((patch.keep || patch.on) && this._keep() && this._ios()) this._tellPhone(); // the iPhone sends its copy
    this._look();
    this._changed();
  }

  look() { return this._look(); }

  _loadKept() {
    try {
      const o = JSON.parse((this.vault && this.vault.load()) || '{}');
      const out = {};
      for (const [k, v] of Object.entries(o)) { const s = cleanState(v); if (s) out[k.toUpperCase()] = s; }
      return out;
    } catch {
      return {};
    }
  }

  _saveFacts() {
    const kept = this._kept || {};
    const facts = {};
    const hash = {};
    for (const [u, st] of Object.entries(kept)) {
      facts[u] = stateFacts(st);
      hash[u] = crypto.createHash('sha256').update(JSON.stringify(st)).digest('hex');
    }
    this.setCfg({ keptFacts: facts, keptHash: hash });
  }

  _saveKept() {
    if (!this.vault) return;
    const kept = this._kept || {};
    this._saveFacts();
    this.vault.save(Object.keys(kept).length ? JSON.stringify(kept) : '');
  }

  close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.scan?.abort();
    this.stop();
  }
}

module.exports = { IosSign, T, cleanState, stateFacts, mergeDevices };
