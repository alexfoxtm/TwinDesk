// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: this Mac's notifications go to the peer
// while it accepts them (`notif.policy`); the peer's show here as native notifications from
// TwinDesk. Reading needs Full Disk Access (the helper reads the Notification Center database).
//
// Events: 'change' — this.view changed; 'click' ({app, appName}) — one of the peer's was clicked.
'use strict';

const { Notification, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { IconsOut, IconsIn } = require('../shared/notificon.js');
const { actionsOf, messageIdentityOf, bindReply, replyHistory, withPhoneActions, hidden, present } = require('../shared/notifacts.js');
const { richOf, popupOn } = require('../shared/notifpop.js');
const { modeOf } = require('../shared/notifrules.js');
const { otpOf, quietCopy } = require('../shared/otp.js');
const { OtpOfferTracker } = require('../shared/otp-offer.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

function formatFallback(key, vars) {
  return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(key);
}

class Notifs extends EventEmitter {
  constructor({ server, helper, getSettings, saveSettings }) {
    super();
    this.iconsOut = new IconsOut();
    this.iconsIn = new IconsIn(nativeImage); // none: macOS shows TwinDesk's icon with every notification
    Object.assign(this, { server, helper, getSettings, saveSettings });
    this.peerAccepts = false;
    this.access = 'unknown'; // 'ok' | 'noAccess' (Full Disk Access) | 'unknown'
    this.apps = new Map(); // app -> {app, appName, at} seen here (newest first in the view)
    this.sent = 0;
    this.shown = 0;
    this.live = []; // keep shown Notification objects alive until closed
    this.otpToasts = new Map(); // offer id -> synthetic native Notification
    this.otp = new OtpOfferTracker({
      copy: (code) => this.copyOtp(code),
      fill: (code, token) => this._fillOtp(code, token),
      captureTarget: () => this._captureOtpTarget(),
      presentOffer: (offer) => this._presentOtpOffer(offer),
      dismissOffer: (offer) => this._dismissOtpOffer(offer),
      onChange: () => this.emit('change'),
    });
    this.nativePermission = new (require('./notification-permission').NotificationPermission)();
    this.nativePermission.on('change', () => this.emit('change'));
    this.nativeFailure = false;
    void this.nativePermission.refresh();

    server.on('client', () => {
      this.otp.clearAll();
      this.peerAccepts = false;
      this.sendPolicy();
      this._watch();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.otp.clearAll();
      this.peerAccepts = false;
      this._watch();
    });
    server.on(`t:${T.NOTIF_POLICY}`, (m) => {
      this.peerAccepts = !!m.accept;
      this._watch();
      this.emit('change');
    });
    server.on(`t:${T.NOTIF}`, (m, ctx, ws) => this._show(m, ctx?.deviceId, ws));
    server.on('t:notif.gone', (m) => {
      const offer = m && typeof m.id === 'string' ? this.otp.findByNotif(m.id) : null;
      if (offer && offer.source === 'notif' && offer.sources.size === 1) this.otp.clearSource('notif', offer.phoneId);
      this.gone(m.id);
    }); // gone from the phone (shared/notifacts.js)
    helper.on('ready', () => this._watch());
    helper.on('event', (name, ev) => {
      if (name === 'notif') this._local(ev);
      else if (name === 'notifState') this._setAccess(ev.state === 'ok' ? 'ok' : 'noAccess');
    });
  }

  get cfg() {
    return this.getSettings().notifs;
  }

  sendPolicy() {
    this.server.sendToClient({ t: T.NOTIF_POLICY, accept: !!this.cfg.receive, rich: popupOn(this.cfg) }); // rich: pictures and live progress, only for TwinDesk's pop-ups (notifpop.js)
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
      const I18n = require('../shared/i18n.js');
      const s = this.getSettings() || {};
      let sys = 'en';
      try { sys = require('electron').app.getLocale(); } catch {}
      const lang = I18n.resolveLanguage((s.ui && s.ui.language) || '', sys);
      return I18n.create(lang).t(key, vars);
    } catch {
      return formatFallback(key, vars);
    }
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

  clearOtp() {
    this.otp.clearAll();
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
    return this.helper.request('otpFill', { code, token }, 1000).catch(() => ({ filled: false, reason: 'helper-unavailable' }));
  }

  _presentOtpOffer(offer) {
    if (modeOf(this.cfg, {}) !== 'show') return false;
    const peer = this.server.current ? this.server.current.name : '';
    const item = {
      id: `otp:${offer.id}`, app: '', appName: '',
      title: offer.label || this._tr('Verification code'),
      subtitle: '', body: '', at: offer.at, from: offer.phoneId, reply: false, actions: [],
    };
    const how = present(this, item, {}, { from: peer, code: offer.code, otpId: offer.id, autoCopy: false });
    if (how === 'popup') return true;
    if (how !== 'native' || !Notification.isSupported()) return false;
    const n = new Notification({
      title: item.title,
      subtitle: peer,
      body: '',
      actions: [this._tr('Use code'), this._tr('Copy {code}', { code: offer.code })].map((text) => ({ type: 'button', text })),
    });
    n.on('action', (_e, i) => {
      if (i === 0) return void this.useOtp(offer.id);
      if (i === 1) return void this.otp.copyOffer(offer.id);
    });
    const drop = () => {
      if (this.otpToasts.get(offer.id) === n) this.otpToasts.delete(offer.id);
      this.live = this.live.filter((x) => x !== n);
    };
    n.on('close', drop);
    this.otpToasts.set(offer.id, n);
    this.live.push(n);
    const t = setTimeout(drop, 60000);
    if (t && t.unref) t.unref();
    n.show();
    return true;
  }

  _dismissOtpOffer(offer) {
    const id = `otp:${offer.id}`;
    if (this.pop) this.pop.gone(id);
    const n = this.otpToasts.get(offer.id);
    if (n) {
      this.otpToasts.delete(offer.id);
      try { n.close(); } catch {}
      this.live = this.live.filter((x) => x !== n);
    }
  }

  onSmsNew(ev, hub) {
    if (!ev || !ev.phoneId || !ev.msg || ev.msg.out || !hub) return null;
    if (!this.getSettings().hub?.messages) return null;
    if (!hub.samePhone({ deviceId: ev.phoneId, session: ev.session })) return null;
    return this.otp.ingest({
      source: 'sms',
      phoneId: ev.phoneId,
      session: `sms:${ev.session}`,
      text: ev.msg.body,
      at: ev.msg.at,
      label: (ev.summary && ev.summary.name) || ev.msg.from || '',
      autoCopy: !!this.cfg.otpCopy,
      isAuthorized: () => !!this.getSettings().hub?.messages && hub.samePhone({ deviceId: ev.phoneId, session: ev.session }),
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

  // Read the database only while something would be sent; else just check access for the tab.
  _watch() {
    if (!this.helper.running) return;
    const on = !!(this.cfg.send && this.peerAccepts && this.server.current) || !!this.webWant;
    this.helper.request('notifWatch', { on }).then((r) => this._setAccess(r.readable ? 'ok' : 'noAccess'), () => {});
  }

  _setAccess(a) {
    if (this.access === a) return;
    this.access = a;
    this.emit('change');
  }

  // TwinDesk Web's devices that show this Mac's notifications (shared/web/webhub.js notifSource).
  want(on) {
    if (!!on === !!this.webWant) return;
    this.webWant = !!on;
    this._watch();
  }

  _local(ev) {
    const app = str(ev.app, 200);
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.webWant && !(this.cfg.muted || []).includes(app)) {
      this.emit('notif', { id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle), body: this.cfg.hideText ? '' : str(ev.body), at: Number(ev.at) || Date.now() });
    }
    if (!this.cfg.send || !this.peerAccepts || !this.server.current || (this.cfg.muted || []).includes(app)) return this.emit('change');
    this.server.sendToClient({
      t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
      body: this.cfg.hideText ? '' : str(ev.body), at: Number(ev.at) || Date.now(),
      icon: this.iconsOut.take(this.server.current, app, ev.icon),
    });
    this.sent++;
    this.emit('change');
  }

  _show(m, from, socket) {
    if (!this.cfg.receive || hidden(this, m)) return; // an app set to Hide: not kept either
    const peer = this.server.current ? this.server.current.name : '';
    const appName = str(m.appName, 100);
    // The recent ones, for Overview and Messages' chat apps (as the PC keeps them).
    const item = { id: str(m.id, 200) || String(Date.now()), app: str(m.app, 200), appName, title: str(m.title, 200) || appName || peer, subtitle: str(m.subtitle, 200), body: str(m.body, 1000), at: Math.round(Number(m.at)) || Date.now(), reply: m.reply === true, actions: actionsOf(m), ...messageIdentityOf(m, socket && socket === this.replySocket(from) && from), ...richOf(m) };
    if (!this.historyIcons) this.historyIcons = new Map();
    if (item.app && typeof m.icon === 'string' && m.icon.startsWith('data:image/') && m.icon.length < 200000) {
      this.historyIcons.delete(item.app);
      this.historyIcons.set(item.app, m.icon);
      if (this.historyIcons.size > 60) this.historyIcons.delete(this.historyIcons.keys().next().value);
    }
    if (from) item.from = from;
    bindReply(item, from, socket && socket === this.replySocket(from) ? socket : null, m, this.history);
    this.history = [item, ...(this.history || []).filter((x) => x.id !== item.id)].slice(0, 50);
    // A one-time code: a local-only expiring Copy button, plus short-lived Use code on authorized phone sessions.
    const code = otpOf([item.title, item.subtitle, item.body].join(' '));
    const isPhoneSource = !!(this.server.current && P.isPhoneOs(this.server.current.os) && this.server.current.deviceId === from && (!socket || socket === this.replySocket(from)));
    let otpOffer = null;
    let handledAutoCopy = false;
    if (code && isPhoneSource) {
      const boundSocket = socket && socket === this.replySocket(from) ? socket : null;
      const res = this.otp.ingest({
        source: 'notif',
        phoneId: from,
        session: boundSocket || this.server.current,
        code,
        at: item.at,
        label: item.appName || item.title,
        notifId: item.id,
        autoCopy: !!this.cfg.otpCopy,
        isAuthorized: () => !!this.cfg.receive && !hidden(this, m) && this.server.current?.deviceId === from && (!boundSocket || this.replySocket(from) === boundSocket),
      });
      if (res) {
        otpOffer = res.offer;
        handledAutoCopy = true;
      }
    }
    // TwinDesk's window (Reply, buttons, picture, progress), the Mac's own, or none (quiet).
    const how = present(this, item, m, { from: peer, code, icon: m.icon || this.historyIcons.get(item.app), otpId: otpOffer ? otpOffer.id : '', autoCopy: !handledAutoCopy });
    if (how === 'popup') this.shown++;
    if (how !== 'native' || !Notification.isSupported()) return void this.emit('change');
    const otpActions = [
      ...(otpOffer ? [this._tr('Use code')] : []),
      ...(code ? [this._tr('Copy {code}', { code })] : []),
    ];
    const n = new Notification({
      title: item.title,
      subtitle: [appName, peer].filter(Boolean).join(' · '),
      body: [str(m.subtitle, 200), str(m.body)].filter(Boolean).join('\n'),
      icon: this.iconsIn.for(m),
      // A one-time code's Use/Copy, then the phone's own buttons (Mark as read…), tapped there.
      actions: [...otpActions, ...item.actions].map((text) => ({ type: 'button', text })),
      // A chat's Reply, typed in the notification itself.
      ...(item.reply ? { hasReply: true, replyPlaceholder: 'Reply' } : {}),
    });
    n.on('reply', (_e, text) => {
      if (this.reply(item.id, text, item.from, item.replySession) !== false || typeof text !== 'string' || !text.trim()) return;
      // Refused (its offer expired or moved): the typed words come back here, never silently lost.
      try {
        new Notification({ title: item.title, subtitle: 'Not sent', body: text.slice(0, 5000) }).show();
      } catch (_) { /* no notification centre */ }
    });
    n.tdId = item.id;
    n.on('action', (_e, i) => {
      if (otpOffer && i === 0) return void this.useOtp(otpOffer.id);
      const copyIndex = otpOffer ? 1 : 0;
      if (code && i === copyIndex) return void this.copyOtp(code);
      this.act(item.id, i - otpActions.length);
    });
    this.live.push(n);
    const drop = () => { this.live = this.live.filter((x) => x !== n); };
    n.on('close', drop);
    n.on('show', () => { this.nativeFailure = false; this.shown++; this.emit('change'); });
    n.on('failed', () => { this.nativeFailure = true; void this.nativePermission.refresh(); this.emit('change'); });
    n.on('click', () => this.emit('click', { app: str(m.app, 200), appName }));
    setTimeout(drop, 60000);
    n.show();
    this.emit('change');
  }

  replySocket(from) {
    const c = this.server.current;
    return c?.deviceId === from ? this.server.outbound(c) : null;
  }

  sendReply(_item, m) { return this.server.sendToClient(m); }

  send(m) { if (this.server.current) this.server.sendToClient(m); }
  changed() { this.emit('change'); }

  get view() {
    return {
      access: this.access,
      nativeAccess: this.nativePermission.view,
      nativeFailure: this.nativeFailure,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      history: replyHistory(this),
      otp: this.otp.view,
      historyIcons: Object.fromEntries([...new Set((this.history || []).map((h) => h.app))]
        .filter((a) => this.historyIcons && this.historyIcons.has(a)).map((a) => [a, this.historyIcons.get(a)])),
    };
  }
}

withPhoneActions(Notifs);

module.exports = { Notifs };
