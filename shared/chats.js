// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages' chat apps (Mac, PC and Linux): WhatsApp, Instagram, Telegram, Messenger and Signal
// conversations from a phone, kept here per phone so they're there after a restart.
//   chat.want {on, messaging?}          to the phone: send them (Messages › Chat apps in Messages)
//   chat.conv {key, app, appName, name, group, id?, reply, items: [{at, from, text, me}]}
//                                       from the phone: a conversation's recent messages, as its
//                                       notification shows them (MessagingStyle); on chat.want, the
//                                       ones open on the phone now; afterwards each one as it changes
//   notif.reply {id, text}              to the phone: an answer, through the notification's own Reply
//   chat.gone {id}                      from the phone: a Messages notification's Reply expired
//   chat.match {ref, items: [{id, at, match}]} to the phone: check Messages projections against Telephony
//   chat.match {ref, ids}               from the phone: the exact matches for that request
//   chat.pic {ref, id, app, chat, image, text}
//                                       to the phone (one whose chat.conv says pic): a picture (a JPEG
//                                       data: URL), through the Reply where it takes one, else the app
//                                       opens on that conversation with it attached, to send there
//   chat.picd {ref, ok, opened, error?} from the phone: how that went (opened: waiting on the phone)
// A phone without them (an older TwinDesk) never sends chat.conv: Messages then builds the chats
// from the notifications (shared/ui-messages.js), as before.
// link: on('welcome' | 'closed' | type, fn), send(msg), current?: {deviceId}; want(): the switch.
'use strict';

const fs = require('fs');
const path = require('path');
const { messagePeerOf } = require('./notifacts');

const T = { WANT: 'chat.want', CONV: 'chat.conv', GONE: 'chat.gone', MATCH: 'chat.match', PIC: 'chat.pic', PICD: 'chat.picd' };
const PICTURE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const DIGEST = /^[a-f0-9]{64}$/;
const APPS = /^(?:com\.whatsapp(?:\.w4b)?|com\.instagram\.android|org\.telegram\.messenger(?:\.web)?|org\.thunderdog\.challegram|com\.facebook\.orca|org\.thoughtcrime\.securesms)$/;
// Any other app's conversations too (Viber, LINE, Discord, Slack…: the phone sends those in Android's
// conversation style), never a texting app's: those are Messages' texts.
const PKG = /^[A-Za-z][\w]*(?:\.[\w]+)+$/;
const SMS_APPS = /^(?:com\.google\.android\.apps\.messaging|com\.samsung\.android\.messaging|com\.android\.mms|com\.android\.messaging)$/;
const MESSAGING = /^(?:com\.google\.android\.apps\.messaging|com\.samsung\.android\.messaging)$/;
const exactPeer = (c) => !!(c.messagePeer && !c.group && c.items.length);
const isChatApp = (app) => APPS.test(app) || (PKG.test(app) && app.length <= 200 && !SMS_APPS.test(app));
const MAX_CONVS = 100; // per phone
const MAX_ITEMS = 150; // per conversation
const VIEW_CONVS = 60;
const VIEW_ITEMS = 80;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const same = (a, b) => a.me === b.me && a.text === b.text && Math.abs(a.at - b.at) < (a.local || b.local ? 5 * 60000 : 1500);

class Chats {
  constructor({ link, dir, want, who, socket, onChange }) {
    Object.assign(this, { link, want, socket, onChange: onChange || (() => {}) });
    this.who = who || (() => (link.current && link.current.deviceId) || '');
    this.file = path.join(dir, 'chats.json');
    this.phones = {}; // deviceId -> {key -> conv}
    this.messagingPhones = {}; // deviceId -> true once this phone has sent a structured messaging projection
    this.sessionUp = false;
    this.sentWant = null; // what the phone was told (null: nothing this session)
    this.heard = false; // the phone sent one this session: it knows chat.conv
    this.heardMessaging = false; // a Google/Samsung projection arrived this session
    this.messageReplies = new Map(); // live notification tokens, never from disk
    this.matchCount = 0;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j.phones === 'object') this.phones = j.phones;
      if (j && j.messaging && typeof j.messaging === 'object') this.messagingPhones = j.messaging;
    } catch {}
    for (const [dev, convs] of Object.entries(this.phones)) {
      if (convs && Object.values(convs).some((c) => MESSAGING.test(c.app))) this.messagingPhones[dev] = true;
    }
    link.on('welcome', () => {
      this.sessionUp = true;
      this.sentWant = null;
      this.heardMessaging = false;
      this.messageReplies.clear();
      this.matchRequest = null;
      this.sync();
    });
    link.on('closed', () => {
      this.sessionUp = false;
      this.sentWant = null;
      this.heardMessaging = false;
      this.messageReplies.clear();
      this.matchRequest = null;
    });
    const exact = (ws) => this.socket && ws && ws === this.socket() && ws === this.chatSocket;
    link.on(T.CONV, (m, ws) => {
      if (m && (!MESSAGING.test(m.app) || exact(ws))) this._conv(m);
    });
    if (socket) {
      link.on(T.GONE, (m, ws) => {
        if (exact(ws) && m && this.messageReplies.delete(m.id)) this.onChange();
      });
      link.on(T.MATCH, (m, ws) => { if (exact(ws)) this._matches(m || {}); });
      link.on('hub.state', (m, ws) => { if (exact(ws)) this._requestMatches(true); });
    }
    link.on(T.PICD, (m) => this._picd(m || {}));
  }

  // Tell the phone whether to send them (the switch changed, or a new session).
  sync() {
    const on = !!this.want();
    if (this.socket) {
      const socket = this.socket();
      if (socket !== this.chatSocket) {
        this.chatSocket = socket;
        this.sentWant = null;
        this.heardMessaging = false;
        this.messageReplies.clear();
        this.matchRequest = null;
      }
      if (!socket) return;
    }
    if (!this.sessionUp || on === this.sentWant) return;
    this.sentWant = on;
    if (!on) {
      this.messageReplies.clear();
      this.matchRequest = null;
    }
    this.link.send({ t: T.WANT, on, ...(this.socket ? { messaging: true } : {}) });
    if (on) this._requestMatches();
  }

  _conv(m) {
    const app = str(m.app, 80);
    const messaging = MESSAGING.test(app);
    const key = str(m.key, 300);
    const dev = this.who();
    if (!key || !dev || !Array.isArray(m.items)) return;
    if (messaging ? (m.source !== 'messaging' || !this.sessionUp || !this.want()) : !isChatApp(app)) return;
    this.heard = true;
    if (messaging) {
      this.heardMessaging = true;
      this.messagingPhones[dev] = true;
    }
    const convs = (this.phones[dev] = this.phones[dev] || {});
    const routeKey = app + '|' + key;
    const peer = messaging && !m.group ? messagePeerOf(m) : '';
    const previous = convs[routeKey];
    const split = messaging && previous &&
      ((previous.messagePeer || '') !== peer || !!previous.group !== (m.group === true));
    const variant = JSON.stringify([routeKey, m.group === true, peer]);
    const k = messaging && (split || convs[variant]) ? variant : routeKey;
    const c = convs[k] || { key: k, app, items: [] };
    c.appName = str(m.appName, 60) || c.appName || app;
    c.name = str(m.name, 200) || c.name || '';
    c.group = m.group === true;
    c.pic = !messaging && m.pic === true;
    if (typeof m.avatar === 'string' && m.avatar.length < 60000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.avatar)) c.avatar = m.avatar; // the contact's or group's picture
    if (messaging) {
      c.messagePeer = peer;
      for (const [id, bind] of this.messageReplies) {
        if (bind.dev === dev && bind.routeKey === routeKey) this.messageReplies.delete(id);
      }
      if (m.reply === true && typeof m.id === 'string' && /^r:[\w-]{1,100}$/.test(m.id)) {
        this.messageReplies.set(m.id, { dev, key: k, routeKey });
      }
    } else if (typeof m.id === 'string' && m.id) {
      c.id = str(m.id, 200);
      c.reply = m.reply === true;
    }
    for (const x of m.items.slice(-60)) {
      if (!x || typeof x !== 'object') continue;
      const it = { at: Number(x.at) > 0 ? Math.round(Number(x.at)) : Date.now(), from: str(x.from, 120), text: str(x.text, 4000), me: x.me === true };
      if (!it.text) continue;
      if (messaging) {
        if (typeof x.id !== 'string' || !DIGEST.test(x.id) || !Number.isSafeInteger(x.at) || x.at <= 0) continue;
        it.id = x.id;
        if (typeof x.match === 'string' && DIGEST.test(x.match)) it.match = x.match;
        if (x.attachment === true) it.attachment = true;
      }
      const i = c.items.findIndex((y) => messaging ? y.id === it.id : same(y, it));
      if (messaging && i >= 0 && c.items[i].carrier) it.carrier = true;
      if (i >= 0) c.items[i] = it; // the phone's copy replaces one typed here
      else c.items.push(it);
    }
    c.items.sort((a, b) => a.at - b.at);
    c.items = c.items.slice(-MAX_ITEMS);
    c.at = c.items.length ? c.items[c.items.length - 1].at : Date.now();
    convs[k] = c;
    const keys = Object.keys(convs);
    if (keys.length > MAX_CONVS) {
      keys.sort((a, b) => convs[a].at - convs[b].at);
      for (const old of keys.slice(0, keys.length - MAX_CONVS)) delete convs[old];
    }
    this._save();
    if (messaging) this._requestMatches();
    this.onChange();
  }

  _requestMatches(force = false) {
    const dev = this.who();
    if (!dev || !this.sessionUp || !this.want() || !this.socket || !this.chatSocket || this.socket() !== this.chatSocket) return;
    const items = Object.values(this.phones[dev] || {}).filter((c) => MESSAGING.test(c.app))
      .flatMap((c) => c.items).filter((i) => i.match).sort((a, b) => b.at - a.at).slice(0, 120)
      .map(({ id, at, match }) => ({ id, at, match }));
    if (!items.length && !this.matchRequest) return;
    const key = JSON.stringify(items);
    if (!force && this.matchRequest?.dev === dev && this.matchRequest.key === key) return;
    const ref = String(++this.matchCount);
    this.matchRequest = { ref, dev, key, ids: new Set(items.map((i) => i.id)) };
    this.link.send({ t: T.MATCH, ref, items });
  }

  _matches(m) {
    const request = this.matchRequest;
    if (!request || request.ref !== m.ref || request.dev !== this.who() || !this.sessionUp || !this.want() || !Array.isArray(m.ids)) return;
    const matched = new Set(m.ids);
    let changed = false;
    for (const c of Object.values(this.phones[request.dev] || {})) {
      if (!MESSAGING.test(c.app)) continue;
      for (const i of c.items) {
        if (!request.ids.has(i.id) || !!i.carrier === matched.has(i.id)) continue;
        i.carrier = matched.has(i.id);
        changed = true;
      }
    }
    if (changed) {
      this._save();
      this.onChange();
    }
  }

  _messageReply(key) {
    if (!this.sessionUp || !this.want() || !this.socket || !this.chatSocket || this.socket() !== this.chatSocket) return '';
    const dev = this.who();
    for (const [id, bind] of this.messageReplies) if (bind.dev === dev && bind.key === key) return id;
    return '';
  }

  // An answer typed here: through the conversation's notification Reply; shown at once, the
  // phone's own copy (its notification updates with it) replaces it.
  reply(key, text, image, remove, from, session) {
    if (remove) return this.remove(key); // Messages › Delete chat (from this list; a new message brings it back)
    const c = (this.phones[this.who()] || {})[key];
    const t = typeof text === 'string' ? text.trim().slice(0, 5000) : '';
    if (c && MESSAGING.test(c.app)) {
      const id = this._messageReply(key);
      return !!(id && from === this.who() && session === id && t && !image && (c.items.some((i) => !i.carrier) || exactPeer(c)) &&
        this.link.send({ t: 'notif.reply', id, text: t }) !== false);
    }
    if (image) return this.picture(c, t, image);
    if (!c || !c.id || !c.reply || !t || !this.sessionUp) return false;
    this.link.send({ t: 'notif.reply', id: c.id, text: t });
    c.items.push({ at: Date.now(), from: '', text: t, me: true, local: true });
    c.at = Date.now();
    this._save();
    this.onChange();
    return true;
  }

  // A picture (and its caption) to a conversation: shown at once as "Picture", its state after it
  // as the phone says (chat.picd): sent, or open on the phone to send there, or not sent.
  picture(c, text, image) {
    if (!c || !c.pic || !this.sessionUp || typeof image !== 'string' || image.length > 6000000 || !PICTURE.test(image)) return false;
    const ref = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.link.send({ t: T.PIC, ref, id: c.id || '', app: c.app, chat: c.key.slice(c.app.length + 1), image, text });
    c.items.push({ at: Date.now(), from: '', text, me: true, local: true, pic: 'sending', ref });
    c.at = Date.now();
    this._save();
    this.onChange();
    return true;
  }

  _picd(m) {
    const ref = str(m.ref, 60);
    for (const c of Object.values(this.phones[this.who()] || {})) {
      const it = c.items.find((x) => x.ref === ref);
      if (!it) continue;
      it.pic = m.ok ? (m.opened ? 'opened' : 'sent') : 'failed';
      if (!m.ok) it.error = str(m.error, 120);
      this._save();
      this.onChange();
      return;
    }
  }

  // Off this computer's list (the chat on the phone stays). A new message from it starts it again.
  remove(key) {
    const convs = this.phones[this.who()];
    if (!convs || !convs[key]) return false;
    delete convs[key];
    this._requestMatches();
    this._save();
    this.onChange();
    return true;
  }

  clear() {
    delete this.phones[this.who()];
    delete this.messagingPhones[this.who()];
    this._requestMatches();
    this._save();
    this.onChange();
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = this.file + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify({ phones: this.phones, messaging: this.messagingPhones }));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.log('[chats] save: ' + e.message);
      }
    }, 1500);
  }

  // True once this session's exact socket has delivered a Google/Samsung projection.
  messaging() {
    return !!(this.socket && this.messagingPhones[this.who()]);
  }

  // For the state: this phone's, newest first (null: the phone hasn't sent any, ever).
  view(includeMatches = false) {
    this.sync();
    const convs = this.phones[this.who()];
    if (!convs && !this.heard) return null;
    return Object.values(convs || {}).flatMap((c) => {
      const messaging = MESSAGING.test(c.app);
      const items = messaging ? c.items.filter((i) => !i.carrier) : c.items;
      const replySession = messaging ? this._messageReply(c.key) : '';
      // Every item matched carrier history: the row stays only for a live exact phone Reply, without items.
      if (messaging && !items.length && !(replySession && exactPeer(c))) return [];
      const reply = messaging ? !!replySession : !!(c.reply && this.sessionUp);
      const at = messaging ? (items.at(-1) || c.items.at(-1))?.at || c.at : c.at;
      const shown = items.slice(-VIEW_ITEMS);
      return [{ key: c.key, app: c.app, appName: c.appName, name: c.name, group: c.group, reply, pic: !!(c.pic && this.sessionUp), avatar: c.avatar || '', at,
        ...(replySession ? { from: this.who(), replySession } : {}),
        ...(messaging && c.messagePeer && !c.group ? { messagePeer: c.messagePeer } : {}),
        items: messaging ? shown.map(({ id, at, from, text, me, match, attachment }) => ({
          id, at, from, text, me, ...(includeMatches && match ? { match } : {}), ...(attachment ? { attachment } : {}),
        })) : shown }];
    }).sort((a, b) => b.at - a.at).slice(0, VIEW_CONVS);
  }

  stop() {
    clearTimeout(this.saveTimer);
    try { fs.writeFileSync(this.file, JSON.stringify({ phones: this.phones, messaging: this.messagingPhones })); } catch {}
  }
}

module.exports = { Chats, T, APPS, isChatApp };
