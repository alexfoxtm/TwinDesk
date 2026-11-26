// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Notifications across every connected device (docs/mesh.md, one pool): this Mac's notifications go
// to every device that accepts them (`notif.policy`); the other devices' show here as native
// notifications from TwinDesk. Reading needs Full Disk Access (the helper reads the Notification
// Center database). Port of windows/notifs.js; the Mac keeps the subtitle line.
//
// Events: 'change' — this.view changed; 'click' ({app, appName, originId}) — one of the others' was clicked.
'use strict';

const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { Pool } = require('../../shared/mesh.js');
const { NotifGuard, isOwn } = require('../../shared/notif-guard.js');
const { IconsOut, IconsIn } = require('../../shared/notificon.js');
const { actionsOf, noticeScope, withMeshPhoneActions, hidden, present } = require('../../shared/notifacts.js');
const { modeOf } = require('../../shared/notifrules.js');
const { otpOf, quietCopy } = require('../../shared/otp.js');
const { OtpOfferTracker } = require('../../shared/otp-offer.js');

const T = P.T;
const RELAYABLE_OS = new Set([P.OS.MAC, P.OS.WIN, P.OS.LINUX]);
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

function formatFallback(key, vars) {
  return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(key);
}

// The Pool's view of the mesh for notifications. Items from a device are always shown here; items
// go only to devices whose notif.policy accepted (mesh entry .notifPool === true), checked in send().
function notifPeers(mesh, notifs) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => {
      if (e.notifPool !== true) return false;
      // The app's icon (sent once per app and device session), kept out of the pool's own copies.
      const { _icon, ...rest } = msg;
      const icon = _icon ? notifs.iconsOut.take(e.id, rest.app, _icon) : undefined;
      return e.send(icon ? { ...rest, icon } : rest);
    },
  }));
}

class Notifs extends EventEmitter {
  // opts:
  //   bus, mesh      as in clipboard.js
  //   getSettings()  -> settings (settings.notifs is used); saveSettings() persists it
  //   helper         the helper process: running, on('ready'|'event'), request(name, args) -> Promise
  //   selfName       this device's name (string or function): sent as `on` with our notifications
  //   peerName(id)   fallback name of a device when the mesh does not know it
  //   Notification   optional; default Electron's
  constructor(opts) {
    super();
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.getSettings = opts.getSettings;
    this.saveSettings = opts.saveSettings || (() => {});
    this.helper = opts.helper;
    this.selfName = opts.selfName;
    this.peerName = opts.peerName;
    this.Notification = opts.Notification || require('electron').Notification;
    this.iconsOut = new IconsOut(); // our app icons go with the first notification of each app per device session
    this.iconsIn = new IconsIn(require('electron').nativeImage); // none: macOS shows TwinDesk's icon with every notification
    this.pool = new Pool({ name: 'notif', selfId: this.mesh.selfId, peers: () => notifPeers(this.mesh, this) });
    this.access = 'unknown'; // 'ok' | 'noAccess' (Full Disk Access) | 'unknown'
    this.apps = new Map(); // app -> {app, appName, at} seen here (newest first in the view)
    this.sent = 0;
    this.shown = 0;
    this.live = new Set(); // shown toasts, kept alive until closed
    this.otpToasts = new Map(); // offer id -> synthetic native Notification
    this.otp = new OtpOfferTracker({
      copy: (code) => this.copyOtp(code),
      fill: (code, token) => this._fillOtp(code, token),
      captureTarget: () => this._captureOtpTarget(),
      cancelTarget: (token) => this.helper?.send?.('otpCancel', { token }),
      presentOffer: (offer) => this._presentOtpOffer(offer),
      dismissOffer: (offer) => this._dismissOtpOffer(offer),
      onChange: () => this.emit('change'),
    });
    this.nativePermission = new (require('../notification-permission').NotificationPermission)();
    this.nativePermission.on('change', () => this.emit('change'));
    this.nativeFailure = false;
    void this.nativePermission.refresh();
    this.guard = new NotifGuard(); // the same text from the same app within seconds goes once (a loop between devices)
    this.echoes = []; // {title, body, until}: shown here from another device, never sent back

    const bus = this.bus;
    bus.on(T.NOTIF, (m, from, _conn, ws) => this._show(m, from, ws));
    bus.on('notif.gone', (m, from) => this._goneFrom(m.id, from));
    bus.on(T.NOTIF_POLICY, (m, from) => {
      const e = this.mesh.get(from);
      if (e) e.notifPool = m.accept === true;
      this._watch();
      this.emit('change');
    });
    bus.onPeer('welcome', (id) => {
      this._expireActions(id);
      this.otp.clearPhone(id);
      const e = this.mesh.get(id);
      if (e) e.notifPool = false; // until its notif.policy says otherwise
      this._sendPolicy(id);
      this._watch();
    });
    bus.onPeer('closed', (id) => {
      this._expireActions(id);
      this.otp.clearPhone(id);
      const e = this.mesh.get(id);
      if (e) e.notifPool = false;
      this._watch();
    });
    bus.onPeer('forgotten', (id) => {
      this._expireActions(id);
      this.otp.clearPhone(id);
    });
    this.helper.on('ready', () => this._watch());
    this.helper.on('event', (name, ev) => {
      if (name === 'notif') this._local(ev);
      else if (name === 'notifState') this._setAccess(ev.state === 'ok' ? 'ok' : 'noAccess');
    });
  }

  get cfg() {
    return this.getSettings().notifs;
  }

  // True when some connected device shows our notifications.
  get peerAccepts() {
    return this._anyAccepts();
  }

  _anyAccepts() {
    return this.bus.connectedIds().some((id) => {
      const e = this.mesh.get(id);
      return !!e && e.notifPool === true;
    });
  }

  _selfName() {
    const n = typeof this.selfName === 'function' ? this.selfName() : this.selfName;
    return str(n, 100);
  }

  // Our notif.policy to every connected device.
  sendPolicy() {
    for (const id of this.bus.connectedIds()) this._sendPolicy(id);
  }

  _sendPolicy(id) {
    this.bus.send(id, { t: T.NOTIF_POLICY, accept: !!this.cfg.receive, rich: require('../../shared/notifpop.js').popupOn(this.cfg) }); // rich: pictures and live progress, only for TwinDesk's pop-ups
  }

  applySettings() {
    if (!this.cfg.receive) this.otp.clearSource('notif');
    else this.otp.revalidate();
    this.sendPolicy();
    this._watch();
    this.emit('change');
  }

  _tr(key, vars) {
    try {
      const I18n = require('../../shared/i18n.js');
      const s = this.getSettings() || {};
      let sys = 'en';
      try { sys = require('electron').app.getLocale(); } catch {}
      const lang = I18n.resolveLanguage((s.ui && s.ui.language) || '', sys);
      return I18n.create(lang).t(key, vars);
    } catch {
      return formatFallback(key, vars);
    }
  }

  _peerOs(id) {
    if (typeof id !== 'string' || !id) return '';
    const direct = this.mesh.get(id);
    if (direct && typeof direct.os === 'string' && direct.os) return direct.os;
    if (typeof this.mesh.known === 'function') {
      const known = this.mesh.known().find((k) => k && k.id === id);
      if (known && typeof known.os === 'string' && known.os) return known.os;
    }
    return '';
  }

  // Only ordinary computer-origin notifications (Mac/Windows/Linux) may be pooled across peers.
  // Android-origin (sensitive or unknown content approved for this Mac only), phone-origin, and
  // unknown-origin notifications stay local to this Mac.
  _canRelay(m, from) {
    if (!m || typeof m !== 'object') return false;
    const senderOs = this._peerOs(from);
    if (!RELAYABLE_OS.has(senderOs)) return false;
    const originId = m.o === undefined ? from : (typeof m.o === 'string' ? m.o : '');
    const originOs = this._peerOs(originId);
    return RELAYABLE_OS.has(originOs);
  }

  copyOtp(code) {
    return quietCopy(code, {
      readChangeCount: this.helper && this.helper.running && typeof this.helper.request === 'function'
        ? () => this.helper.request('clipboardInfo', {}, 500).then((r) => (r && typeof r.changeCount === 'number' ? r.changeCount : null), () => null)
        : null,
    });
  }

  armOtpTarget(id) {
    return this.otp.armTarget(id);
  }

  useOtp(id) {
    return this.otp.use(id);
  }

  clearOtpSource(source, phoneId) {
    this.otp.clearSource(source, phoneId);
  }

  clearOtp(phoneId) {
    if (phoneId) this.otp.clearPhone(phoneId);
    else this.otp.clearAll();
  }

  _captureOtpTarget() {
    if (!this.helper || !this.helper.running || typeof this.helper.request !== 'function') {
      return Promise.resolve({ valid: false, reason: 'helper-unavailable' });
    }
    return this.helper.request('otpTarget', {}, 500).catch(() => ({ valid: false, reason: 'helper-unavailable' }));
  }

  _fillOtp(code, token) {
    if (!this.helper || !this.helper.running || typeof this.helper.request !== 'function') {
      return Promise.resolve({ filled: false, reason: 'helper-unavailable' });
    }
    return this.helper.request('otpFill', { code, token }, 1000).catch(() => {
      this.helper?.send?.('otpCancel', { token });
      return { filled: false, reason: 'helper-unavailable' };
    });
  }

  _presentOtpOffer(offer) {
    if (modeOf(this.cfg, {}) !== 'show') return false;
    const origin = this._nameOf(offer.phoneId, '', offer.phoneId);
    const item = {
      id: `otp:${offer.id}`, app: '', appName: '',
      title: offer.label || this._tr('Verification code'),
      subtitle: '', body: '', at: offer.at, from: offer.phoneId, reply: false, actions: [],
    };
    const how = present(this, item, {}, { from: origin, code: offer.code, otpId: offer.id, autoCopy: false });
    if (how === 'popup') return true;
    if (how !== 'native' || !this.Notification || !this.Notification.isSupported()) return false;
    const n = new this.Notification({
      title: item.title,
      subtitle: origin,
      body: '',
      actions: [this._tr('Use code'), this._tr('Copy {code}', { code: offer.code })].map((text) => ({ type: 'button', text })),
    });
    n.tdOrigin = offer.phoneId;
    n.tdId = item.id;
    n.on('action', (_e, i) => {
      if (i === 0) return void this.useOtp(offer.id);
      if (i === 1) return void this.otp.copyOffer(offer.id);
    });
    const drop = () => {
      if (this.otpToasts.get(offer.id) === n) this.otpToasts.delete(offer.id);
      this.live.delete(n);
    };
    n.on('close', drop);
    this.otpToasts.set(offer.id, n);
    this.live.add(n);
    const t = setTimeout(drop, 60000);
    if (t && t.unref) t.unref();
    n.show();
    return true;
  }

  _dismissOtpOffer(offer) {
    const id = `otp:${offer.id}`;
    this._closeMatchingPopup(id, offer.phoneId);
    const n = this.otpToasts.get(offer.id);
    if (n) {
      this.otpToasts.delete(offer.id);
      try { n.close(); } catch {}
      this.live.delete(n);
    }
  }

  onSmsNew(ev, hub) {
    if (!ev || !ev.phoneId || !ev.msg || ev.msg.out || !hub) return null;
    const isAuthorized = () => !!this.getSettings().hub?.messages &&
      ['ok', 'partial'].includes(hub.state?.messages?.perm) &&
      hub.samePhone({ deviceId: ev.phoneId, session: ev.session });
    if (!isAuthorized()) return null;
    return this.otp.ingest({
      source: 'sms',
      phoneId: ev.phoneId,
      session: `sms:${ev.session}`,
      text: ev.msg.body,
      at: ev.msg.at,
      label: (ev.summary && ev.summary.name) || ev.msg.from || '',
      autoCopy: !!this.cfg.otpCopy,
      isAuthorized,
    });
  }

  onGoogleMessage(ev, gm) {
    if (!ev || !ev.owner || !ev.item || ev.item.me === true || !gm) return null;
    if (!this.getSettings().hub?.messages || !gm.active || gm.state !== 'connected' || gm.owner !== ev.owner || gm.session !== ev.session) return null;
    return this.otp.ingest({
      source: 'gmessages',
      phoneId: ev.owner,
      session: `gm:${ev.session}`,
      text: ev.item.text,
      at: ev.item.at,
      label: (ev.row && ev.row.name) || '',
      autoCopy: !!this.cfg.otpCopy,
      isAuthorized: () => !!this.getSettings().hub?.messages && gm.active && gm.state === 'connected' && gm.owner === ev.owner && gm.session === ev.session,
    });
  }

  setMuted(app, muted) {
    const list = new Set(this.cfg.muted || []);
    if (muted) list.add(String(app));
    else list.delete(String(app));
    this.cfg.muted = [...list].slice(0, 500);
    this.saveSettings();
    this.emit('change');
  }

  // Name of the device where a notification started: the mesh entry, else the `on` it carries,
  // else the sender's own name.
  _nameOf(origin, on, from) {
    const o = this.mesh.get(origin);
    if (o && o.name) return o.name;
    const name = str(on, 100);
    if (name) return name;
    const f = this.mesh.get(from);
    if (f && f.name) return f.name;
    return (this.peerName && this.peerName(from)) || from;
  }

  // The helper reads the database only while something would be sent; else just checks the access
  // for the Notifications tab.
  _watch() {
    if (!this.helper.running) return;
    const on = !!(this.cfg.send && this._anyAccepts()) || !!this.webWant;
    this.helper.request('notifWatch', { on }).then((r) => this._setAccess(r.readable ? 'ok' : 'noAccess'), () => {});
  }

  _setAccess(a) {
    if (this.access === a) return;
    this.access = a;
    this.emit('change');
  }

  _expireActions(id) {
    for (const item of this.history || []) {
      if (item.from !== id) continue;
      item.actionPeer = null;
      item.actions = [];
      item.reply = false;
    }
    this.emit('change');
  }

  // History can outlive a connection. Actions belong only to the exact origin session that
  // supplied the current item; restored history and relayed notifications have no such binding.
  _sendCurrent(item, message) {
    if (!this.cfg.receive || !item || !(this.history || []).includes(item) || !item.actionPeer ||
        this.mesh.get(item.from) !== item.actionPeer || !this.bus.connectedIds().includes(item.from)) return false;
    return this.bus.send(item.from, message) !== false;
  }

  _goneFrom(id, from) {
    const before = (this.history || []).length;
    this.history = (this.history || []).filter((item) => item.id !== id || item.from !== from);
    for (const n of [...this.live]) {
      if (n.tdId !== id || n.tdOrigin !== from) continue;
      n.tdActionCurrent = false;
      try { n.close(); } catch {}
      this.live.delete(n);
    }
    // The popup is independent of history and of the system toast. A cleared list still closes
    // a window whose origin is this session. A missing or different origin stays up.
    this._closeMatchingPopup(id, from);
    const offer = id ? this.otp.findByNotif(id, from) : null;
    if (offer && offer.source === 'notif' && offer.sources.size === 1) this.otp.clearSource('notif', from);
    if (this.history.length !== before) this.changed();
  }

  // The device id stored on the one popup for this id, or ''. Absent, empty, or ambiguous origins
  // fail closed. History is not consulted.
  _explicitPopupOrigin(id) {
    const pop = this.pop;
    if (!pop || !id || !Array.isArray(pop.wins)) return '';
    const wins = pop.wins.filter((w) => w && w.id === id);
    if (wins.length !== 1 || !wins[0].item) return '';
    const origin = wins[0].item.from;
    return typeof origin === 'string' && origin !== '' ? origin : '';
  }

  _closeMatchingPopup(id, from) {
    const pop = this.pop;
    if (!pop || typeof pop.gone !== 'function') return false;
    if (!from || this._explicitPopupOrigin(id) !== from) return false;
    pop.gone(id);
    return true;
  }

  // TwinDesk Web's devices that show this Mac's notifications (shared/web/webhub.js notifSource).
  want(on) {
    if (!!on === !!this.webWant) return;
    this.webWant = !!on;
    this._watch();
  }

  _local(ev) {
    const app = str(ev.app, 300);
    if (!app) return;
    // One we showed from another device, read back from this Mac's notifications: sending it would
    // bounce it between the devices forever.
    const now = Date.now();
    this.echoes = this.echoes.filter((e) => e.until > now);
    if (this.echoes.some((e) => e.title === str(ev.title, 200) && str(ev.body).includes(e.body))) return;
    if (isOwn(app, ev.appName)) return; // TwinDesk's own toasts are never forwarded
    if (this.guard.repeat('out', app, ev.title, ev.body)) return;
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.webWant && !(this.cfg.muted || []).includes(app)) {
      this.emit('notif', { id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle), body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now() });
    }
    if (this.cfg.send && !(this.cfg.muted || []).includes(app) && this._anyAccepts()) {
      const r = this.pool.publish({
        t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
        body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now(), on: this._selfName(),
        _icon: ev.icon, // stripped per device in notifPeers (the icon goes once per app and session)
      });
      if (r.sent.length) this.sent++;
    }
    this.emit('change');
  }

  // A notification from another device: hidden items never leave this Mac; only allowed
  // computer-origin notifications relay through the pool; Android/unknown stay local.
  _show(m, from, ws) {
    if (!this.cfg.receive) return;
    if (hidden(this, m)) return; // an app set to Hide (Notifications): not kept or relayed
    const relay = this._canRelay(m, from);
    const r = this.pool.receive(from, m, { relay });
    if (!r.fresh || !this.Notification || !this.Notification.isSupported()) return;
    const id = str(m.id, 200);
    let updated = false;
    for (const old of this.live) {
      if (id && old.tdOrigin === from && old.tdId === id) {
        old.tdActionCurrent = false;
        updated = true;
        try { old.close(); } catch {}
        this.live.delete(old);
      }
    }
    if (this.guard.repeat('in', m.app, m.title, m.body, noticeScope(m, r.msg.o)) && !updated) return; // a repeat of what was just shown
    const origin = this._nameOf(r.msg.o, m.on, from);
    const appName = str(m.appName, 100);
    // The recent ones, for Overview and Messages' chat apps; buttons and Reply go back to the device.
    const peer = this.mesh.get(from);
    const direct = (!r.msg.o || r.msg.o === from) && peer && peer.os === P.OS.ANDROID;
    const directPhone = (!r.msg.o || r.msg.o === from) && peer && P.isPhoneOs(peer.os);
    const socket = ws && ws === this.replySocket(from) ? ws : null;
    const item = this.remember(m, { from, origin: r.msg.o || from, on: origin, direct: !!direct, socket });
    Object.defineProperty(item, 'actionPeer', { value: direct ? peer : null, writable: true });
    const title = item.title;
    const body = str(m.body);
    const code = otpOf([title, str(m.subtitle, 200), body].join(' '));
    let otpOffer = null;
    if (code && directPhone && this.bus.connectedIds().includes(from)) {
      const res = this.otp.ingest({
        source: 'notif',
        phoneId: from,
        session: socket || peer,
        code,
        at: item.at,
        label: appName || title,
        notifId: item.id,
        autoCopy: !!this.cfg.otpCopy,
        isAuthorized: () => !!this.cfg.receive && !hidden(this, m) && this.mesh.get(from) === peer && this.bus.connectedIds().includes(from) && (!socket || this.replySocket(from) === socket),
      });
      otpOffer = res?.offer || null;
    }
    // Actions have no relay protocol: only the authenticated origin can run its buttons.
    const actions = id && direct ? actionsOf(m) : [];
    item.actions = actions;
    if (!id) item.reply = false;
    // TwinDesk's window (Reply, buttons, picture, progress), the system's, or none (quiet).
    const how = present(this, item, m, { from: origin, code, icon: m.icon || (this.historyIcons && this.historyIcons.get(item.app)), otpId: otpOffer ? otpOffer.id : '', autoCopy: !directPhone });
    if (how !== 'native') {
      if (how === 'popup') this.shown++;
      return void this.changed();
    }
    this.echoes.push({ title, body: body.slice(0, 80), until: Date.now() + 30000 });
    const otpActions = [
      ...(otpOffer ? [this._tr('Use code')] : []),
      ...(code ? [this._tr('Copy {code}', { code })] : []),
    ];
    // A one-time code: Use/Copy buttons on the notification; then the phone's own buttons (Mark as read…).
    const n = new this.Notification({
      title,
      icon: this.iconsIn.for(m),
      subtitle: [appName, origin].filter(Boolean).join(' · '),
      body: [str(m.subtitle, 200), body].filter(Boolean).join('\n'),
      actions: [...otpActions, ...actions].map((text) => ({ type: 'button', text })),
    });
    n.tdOrigin = from;
    n.tdId = id;
    n.tdActionCurrent = true;
    n.on('action', (_e, i) => {
      if (!this.cfg.receive || !n.tdActionCurrent) return;
      if (otpOffer && i === 0) return void this.useOtp(otpOffer.id);
      const copyIndex = otpOffer ? 1 : 0;
      if (code && i === copyIndex) return void this.copyOtp(code);
      const action = i - otpActions.length;
      if (!id || !Number.isInteger(action) || !actions[action]) return;
      this._sendCurrent(item, { t: 'notif.act', id, i: action });
    });
    this.live.add(n);
    const drop = () => { n.tdActionCurrent = false; this.live.delete(n); };
    n.on('close', drop);
    n.on('show', () => { this.nativeFailure = false; this.shown++; this.emit('change'); });
    n.on('failed', () => { this.nativeFailure = true; void this.nativePermission.refresh(); this.emit('change'); });
    n.on('click', () => this.emit('click', { app: str(m.app, 200), appName, originId: r.msg.o }));
    const timer = setTimeout(drop, 60000);
    if (timer && timer.unref) timer.unref();
    n.show();
    this.emit('change');
  }

  get view() {
    return {
      access: this.access,
      nativeAccess: this.nativePermission.view,
      nativeFailure: this.nativeFailure,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      otp: this.otp.view,
      ...this.historyView(),
    };
  }

  changed() { this.emit('change'); }
}

withMeshPhoneActions(Notifs);
Notifs.prototype.sendReply = function (item, message) {
  return this._sendCurrent(item, message);
};
Notifs.prototype.send = function (message) {
  const items = (this.history || []).filter((item) => item.id === message.id);
  return items.length === 1 && this._sendCurrent(items[0], message);
};
Notifs.prototype.dismiss = function (id) {
  const items = (this.history || []).filter((item) => item.id === id);
  // History can already be cleared while TwinDesk's window is still up. Close that window only
  // from its own origin, and do not invent a device to notify.
  if (!items.length) return this._closeMatchingPopup(id, this._explicitPopupOrigin(id));
  // A stale or ambiguous item can still be dismissed locally; never send to the wrong peer.
  if (items.length === 1) this._sendCurrent(items[0], { t: 'notif.dismiss', id });
  this._goneFrom(id, items[0].from);
  return true;
};

module.exports = { Notifs };
