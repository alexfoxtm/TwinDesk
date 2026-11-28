// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A phone's notifications here (notifs.js on Mac, PC and Linux) kept in step with the phone
// (Notifs.kt there):
//   notif {..., actions?: [title]}   from the phone: its buttons that need no typing (Mark as read…)
//   notif.act {id, i}                to the phone: one of them, clicked here
//   notif.dismiss {id}               to the phone: dismissed here, gone from the phone too
//   notif.gone {id}                  from the phone: gone there (swiped, opened, answered), gone here
// An older phone app sends no actions and no notif.gone, and ignores the other two.
'use strict';

const { randomUUID } = require('crypto');

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

const isMessagingApp = (app) => /^(?:com\.google\.android\.apps\.messaging|com\.samsung\.android\.messaging)$/.test(app);

// Optional identity from Android's one-to-one MessagingStyle projection.
function messagePeerOf(m) {
  return isMessagingApp(m.app) &&
    typeof m.messagePeer === 'string' && /^\+[1-9][0-9]{6,14}$/.test(m.messagePeer) ? m.messagePeer : '';
}

function messageIdentityOf(m, phone) {
  const messagePeer = phone && messagePeerOf(m);
  return messagePeer && Number.isSafeInteger(m.messageAt) && m.messageAt > 0
    ? { messagePeer, messageAt: m.messageAt, messagePhone: phone } : {};
}

// Different phone messages with identical text must still show their own recent Reply.
function noticeScope(m, origin) {
  return isMessagingApp(m.app) ? JSON.stringify([origin, m.id, m.messageAt || m.at, m.replyVersion]) : '';
}

// The buttons of a notif message: up to 3 short titles.
function actionsOf(m) {
  return Array.isArray(m && m.actions) ? m.actions.filter((a) => typeof a === 'string' && a.trim()).slice(0, 3).map((a) => a.slice(0, 40)) : [];
}

// A re-post continues the earlier offer only for the same notification, origin, socket, app and
// verified one-to-one peer. A reused ID or title alone never carries an open draft to it.
function sameProvenOffer(prev, item, from, socket) {
  return !!(prev && prev.reply && prev.replySession && prev.from === from && prev.replySocket === socket &&
    prev.id === item.id && prev.app === item.app && item.messagePeer && prev.messagePeer === item.messagePeer &&
    prev.messagePhone === from && item.messagePhone === from);
}

// The renderer carries an opaque offer ID. The socket stays in the main process.
// history: the list before this item, so a proven re-post keeps its open drafts sendable.
function bindReply(item, from, socket, message, history) {
  if (from && socket) {
    item.copySession = randomUUID();
    Object.defineProperty(item, 'copySocket', { value: socket });
  }
  item.reply = !!(item.reply && message.id && from && socket);
  if (!item.reply) return;
  item.from = from;
  const prev = (history || []).find((h) => h.id === item.id && h.from === from);
  item.replySession = sameProvenOffer(prev, item, from, socket) ? prev.replySession : randomUUID();
  Object.defineProperties(item, {
    replySocket: { value: socket },
    replyVersion: { value: str(message.replyVersion, 40) },
  });
}

function replyIsCurrent(n, item) {
  return !!(item.reply && item.replySocket && n.replySocket(item.from) === item.replySocket);
}

function replyHistory(n) {
  return (n.history || []).map((item) => {
    const reply = item.reply && replyIsCurrent(n, item);
    const copySession = item.copySession && copyIsCurrent(n, item) ? item.copySession : undefined;
    return reply === item.reply && copySession === item.copySession ? item : { ...item, reply, copySession };
  });
}

function copyIsCurrent(n, item) {
  return !!(n.cfg?.receive && item.copySocket && n.replySocket(item.from) === item.copySocket && !hidden(n, item));
}

// Adds gone(id), act(id, i) and dismiss(id) to a notifs.js class. Its instances have history
// (newest first), live (an Array or a Set of shown Notifications, each with tdId), a way to send
// (send(m)) and to say they changed (changed()).
function withPhoneActions(Cls) {
  Object.assign(Cls.prototype, {
    copyText(id, from, session, includeTitle = false) {
      const item = (this.history || []).find((h) => h.id === id && h.from === from && h.copySession === session);
      if (!item || !session || !copyIsCurrent(this, item)) return false;
      const text = [includeTitle ? item.title : '', item.subtitle, item.body].filter(Boolean).join('\n');
      if (!text) return false;
      const otp = require('./otp.js');
      if (otp.otpOf([item.title, item.subtitle, item.body].filter(Boolean).join(' ')) || otp.otpOf(text)) {
        return typeof this.copyOtp === 'function' ? this.copyOtp(text) : otp.quietCopy(text);
      }
      otp.invalidateQuietCopy();
      require('electron').clipboard.writeText(text);
      return true;
    },
    // Gone here: from the list, and its notification closed.
    gone(id) {
      id = str(id, 200);
      if (!id) return;
      if (this.pop) this.pop.gone(id);
      const had = (this.history || []).length;
      this.history = (this.history || []).filter((h) => h.id !== id);
      for (const n of [...(this.live || [])]) {
        if (n.tdId !== id) continue;
        try { n.close(); } catch {}
        if (this.live instanceof Set) this.live.delete(n);
        else this.live = this.live.filter((x) => x !== n);
      }
      if (this.history.length !== had) this.changed();
    },
    reply(id, text, from, session) {
      const item = (this.history || []).find((h) => h.id === id && h.from === from && h.replySession === session);
      if (!item || !this.cfg.receive || !replyIsCurrent(this, item) || typeof text !== 'string' || !text.trim()) return false;
      const msg = { t: 'notif.reply', id, text: text.slice(0, 5000) };
      if (item.replyVersion) msg.replyVersion = item.replyVersion;
      if (this.sendReply(item, msg) === false) return false;
      item.replies = [...(item.replies || []), { text: msg.text, at: Date.now() }].slice(-20);
      this.changed();
      return true;
    },
    act(id, i) {
      const item = (this.history || []).find((h) => h.id === id);
      if (!item || !Number.isInteger(i) || !(item.actions || [])[i]) return false;
      this.send({ t: 'notif.act', id: item.id, i });
      return true;
    },
    dismiss(id) {
      const item = (this.history || []).find((h) => h.id === id);
      if (!item) return false;
      this.send({ t: 'notif.dismiss', id: item.id });
      this.gone(item.id);
      return true;
    },
  });
}

// Multi-device (mac|windows|linux/mesh/notifs.js): the same list, for every device's notifications.
// Each item keeps the device it came from (`from`); its buttons, Reply and dismiss go back to that
// device only, and only while it is connected here (a notification relayed by another computer has
// none). Its instances have bus (send(id, m), connectedIds()) and changed().
function withMeshPhoneActions(Cls) {
  withPhoneActions(Cls);
  Object.assign(Cls.prototype, {
    // A notification just shown: into the list (newest first, 50 kept). `direct` = it came from the
    // device it started on. Returns the item.
    remember(m, { from, origin, on, direct, copy = direct, socket }) {
      if (!this.history) this.history = [];
      if (!this.historyIcons) this.historyIcons = new Map();
      const appName = str(m.appName, 100);
      const item = {
        id: str(m.id, 200) || String(Date.now()),
        app: str(m.app, 200), appName,
        title: str(m.title, 200) || appName || str(on, 100),
        subtitle: str(m.subtitle, 200), body: str(m.body, 1000),
        at: Math.round(Number(m.at)) || Date.now(),
        on: str(on, 100), from: str(origin || from, 200),
        reply: direct && m.reply === true,
        actions: direct ? actionsOf(m) : [],
        ...messageIdentityOf(m, direct && socket && from),
      };
      bindReply(item, copy && from, socket, m, this.history);
      if (item.app && typeof m.icon === 'string' && m.icon.startsWith('data:image/') && m.icon.length < 200000) {
        this.historyIcons.delete(item.app);
        this.historyIcons.set(item.app, m.icon);
        if (this.historyIcons.size > 60) this.historyIcons.delete(this.historyIcons.keys().next().value);
      }
      this.history = [item, ...this.history.filter((x) => !(x.id === item.id && x.from === item.from))].slice(0, 50);
      return item;
    },
    // notif.gone for one origin. The same notification id on another origin keeps its reply offer,
    // and only that origin's current session can still answer it.
    expireOrigin(id, origin) {
      id = str(id, 200);
      origin = str(origin, 200);
      if (!id || !origin) return false;
      const before = (this.history || []).length;
      this.history = (this.history || []).filter((h) => h.id !== id || h.from !== origin);
      for (const n of [...(this.live || [])]) {
        if (n.tdId !== id || n.tdOrigin !== origin) continue;
        try { n.close(); } catch (_) { /* already closed */ }
        if (this.live instanceof Set) this.live.delete(n);
        else this.live = this.live.filter((x) => x !== n);
      }
      // Only that origin's windows: another origin's same-ID window keeps its offer.
      const pop = this.pop;
      if (pop && typeof pop.gone === 'function' && Array.isArray(pop.wins) &&
          pop.wins.some((w) => w && w.id === id && w.item && w.item.from === origin)) pop.gone(id, origin);
      if ((this.history || []).length !== before) this.changed();
      return (this.history || []).length !== before;
    },
    // One notification by origin and ID. Without an origin, only an ID no other origin shares.
    offerOf(id, from) {
      id = str(id, 200);
      const all = (this.history || []).filter((h) => h.id === id);
      if (typeof from === 'string' && from) return all.find((h) => h.from === from) || null;
      return all.length === 1 ? all[0] : null;
    },
    act(id, i, from) {
      const item = this.offerOf(id, from);
      if (!item || !Number.isInteger(i) || !(item.actions || [])[i]) return false;
      return this.sendTo(item, { t: 'notif.act', id: item.id, i });
    },
    dismiss(id, from) {
      const item = this.offerOf(id, from);
      if (!item) return false;
      this.sendTo(item, { t: 'notif.dismiss', id: item.id });
      if (item.from) this.expireOrigin(item.id, item.from);
      else this.gone(item.id);
      return true;
    },
    // notif.act / notif.dismiss: to the device the notification came from, only while connected.
    sendTo(item, m) {
      if (!item || !item.from || !this.bus.connectedIds().includes(item.from)) return false;
      this.bus.send(item.from, m);
      return true;
    },
    send(m, from) {
      return this.sendTo(this.offerOf(m && m.id, from), m);
    },
    replySocket(from) { return this.bus.replySocket?.(from); },
    sendReply(item, msg) { return this.bus.send(item.from, msg); },
    clearHistory() {
      this.history = [];
      this.changed();
    },
    // For view(): the list and the icons of its apps.
    historyView() {
      const h = replyHistory(this);
      const icons = this.historyIcons || new Map();
      return {
        history: h,
        historyIcons: Object.fromEntries([...new Set(h.map((x) => x.app))].filter((a) => icons.has(a)).map((a) => [a, icons.get(a)])),
      };
    },
  });
}

// How a phone's notification is shown here (shared/notifrules.js, shared/notifpop.js), for every
// notifs.js. Before anything: hidden(n, m) → true for an app set to Hide (not kept either). After
// it's in the list: present(n, item, m, {from, code, icon}) → 'popup' (TwinDesk's window showed it),
// 'native' (the caller shows the system's) or 'none' (quiet: the list only). A one-time code goes
// on the clipboard by itself when that's on. A progress bar's updates fill TwinDesk's window in
// place; with the system's, only its first one and its end show.
const rules = () => require('./notifrules.js');
function hidden(n, m) {
  return rules().modeOf(n.cfg, m) === 'hide';
}
function present(n, item, m, { from, code, icon, otpId, autoCopy = true } = {}) {
  const r = rules();
  const mode = r.modeOf(n.cfg, m);
  const copyCode = (c) => (typeof n.copyOtp === 'function' ? n.copyOtp(c) : require('./otp.js').quietCopy(c));
  if (autoCopy && code && n.cfg.otpCopy && mode !== 'hide') { try { copyCode(code); } catch (_) { /* no clipboard (tests) */ } }
  if (mode !== 'show') return 'none';
  const pop = require('./notifpop.js');
  let electron = null;
  try { electron = require('electron'); } catch (_) { /* plain node */ }
  if (pop.popupOn(n.cfg) && electron && typeof electron === 'object' && electron.BrowserWindow) { // under plain node (tests): the system's
    if (!n.pop) {
      n.pop = new pop.NotifPop({
        corner: process.platform === 'win32' ? 'bottom' : 'top',
        getLanguage: () => languageOf(n),
        // Keyed by origin and ID: another origin's same-ID notification never takes the click.
        act: (id, i, it) => n.act(id, i, it && it.from),
        reply: (it, text) => n.reply(it.id, text, it.from, it.replySession),
        dismiss: (id, it) => n.dismiss(id, it && it.from),
        open: (it) => { const c = { app: it.app, appName: it.appName, ...(it.from ? { originId: it.from } : {}) }; if (n.onClick) n.onClick(c); else if (n.emit) n.emit('click', c); },
        copy: (c) => copyCode(c),
        useCode: typeof n.useOtp === 'function' ? (id, c) => n.useOtp(id, c) : null,
        armTarget: typeof n.armOtpTarget === 'function' ? (id) => n.armOtpTarget(id) : null,
      });
    }
    n.pop.show(item, { from, code, icon, otpId: otpId || '' });
    return 'popup';
  }
  if (item.live) {
    if (!n.liveSeen) n.liveSeen = new Set();
    const seen = n.liveSeen.has(item.id);
    n.liveSeen.add(item.id);
    if (n.liveSeen.size > 100) n.liveSeen.delete(n.liveSeen.values().next().value);
    if (seen && !item.live.done) return 'none';
  }
  return 'native';
}
// Gone from the phone: its TwinDesk window too (only that origin's, when given).
function popGone(n, id, from) {
  if (n.pop) n.pop.gone(id, from);
}
function languageOf(n) {
  try {
    const s = n.settings || (n.getSettings && n.getSettings()) || {};
    const I18n = require('./i18n.js');
    return I18n.resolveLanguage((s.ui && s.ui.language) || '', require('electron').app.getLocale());
  } catch (_) {
    return 'en';
  }
}

module.exports = { actionsOf, noticeScope, messagePeerOf, messageIdentityOf, bindReply, sameProvenOffer, replyHistory, withPhoneActions, withMeshPhoneActions, hidden, present, popGone };
