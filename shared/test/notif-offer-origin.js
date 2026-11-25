// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/notifacts.js, shared/notifpop.js and the Windows/Linux Mesh notifReply IPC: a proven re-post
// keeps an open draft sendable, refusal and expiry never drop typed text, and buttons, dismissal,
// popups and expiry are keyed by origin and notification ID (synthetic fixtures only).
// Run with: node --test shared/test/notif-offer-origin.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test, after } = require('node:test');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');

// One Electron stand-in for every module loaded here.
const handlers = {};
const windows = [];
class BrowserWindow {
  constructor() { this.sent = []; this.webContents = { send: (n, v) => this.sent.push([n, v]), focus() {} }; windows.push(this); }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} on() {} setBounds() {}
  showInactive() {} setFocusable() {} focus() {}
  close() { this.closed = true; }
  isDestroyed() { return !!this.closed; }
}
const ipcHandlers = {};
const electron = {
  ipcMain: {
    handle: (n, f) => { handlers[n] = f; ipcHandlers[n] = f; },
    on: (n, f) => { handlers[n] = f; },
  },
  BrowserWindow, nativeTheme: {}, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
  dialog: {}, shell: {}, clipboard: {}, Menu: {}, app: { getLocale: () => 'en' },
};
// notifpop.js asks for Electron lazily, so the stand-in stays for this file's tests.
const load = Module._load;
Module._load = function (name, ...rest) { return name === 'electron' ? electron : load.call(this, name, ...rest); };
after(() => { Module._load = load; });
const { NotifPop } = require('../notifpop.js');
const { sameProvenOffer } = require('../notifacts.js');
const WindowsNotifs = require('../../windows/mesh/notifs.js');
const LinuxNotifs = require('../../linux/mesh/notifs.js');
const LinuxDirect = require('../../linux/notifs.js');
const Peer = require('../../linux/peer.js');
const windowsIpc = require('../../windows/mesh/ipc.js');
const linuxIpc = require('../../linux/mesh/ipc.js');
process.env.TWINDESK_NO_FX2 = '1';
process.env.TWINDESK_NO_IL = '1';

const APP = 'com.google.android.apps.messaging';
const PEER = '+12025550100';

// ---- (1) a proven re-post keeps the open draft's session; an unproven one never inherits it ----

function direct() {
  const peer = new Peer({ on() {}, onState() {} });
  const server = new EventEmitter();
  const socket = { readyState: 1 };
  const phone = { authed: true, deviceId: 'fixture-phone', os: P.OS.ANDROID, ws: socket };
  server.https = new EventEmitter();
  server.current = phone;
  const sent = [];
  server.send = (context, msg) => sent.push({ context, msg });
  peer.attachHost(server, new EventEmitter());
  server.emit('client', phone);
  const notifs = new LinuxDirect({ link: peer, settings: { notifs: { receive: true, style: 'none' } }, peerName: () => '', onChange() {} });
  const receive = (extra) => server.emit('message', { t: P.T.NOTIF, id: 'fixture-notif', app: APP, reply: true, at: 1000, ...extra }, phone, socket);
  return { notifs, sent, receive };
}

test('a re-post of the same proven conversation keeps the open draft sendable on the newest offer', () => {
  const { notifs, sent, receive } = direct();
  receive({ messagePeer: PEER, messageAt: 1000, replyVersion: 'v1' });
  const draft = notifs.view().history[0];
  receive({ messagePeer: PEER, messageAt: 2000, replyVersion: 'v2', body: 'newer' });
  const newest = notifs.view().history[0];
  assert.equal(newest.replySession, draft.replySession, 'the same conversation keeps its session');
  assert.equal(notifs.reply(draft.id, 'Synthetic draft', draft.from, draft.replySession), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.replyVersion, 'v2', 'it answers the newest offer of that conversation');
});

test('an unproven or different-peer re-post never inherits the draft session, and refusal is reported', () => {
  for (const next of [{ replyVersion: 'v2' }, { messagePeer: '+12025550101', messageAt: 2000, replyVersion: 'v2' }]) {
    const { notifs, sent, receive } = direct();
    receive({ messagePeer: PEER, messageAt: 1000, replyVersion: 'v1' });
    const draft = notifs.view().history[0];
    receive(next);
    assert.notEqual(notifs.view().history[0].replySession, draft.replySession);
    assert.equal(notifs.reply(draft.id, 'Synthetic draft', draft.from, draft.replySession), false, 'refused, so the caller keeps the text');
    assert.equal(sent.length, 0);
  }
  const prev = { reply: true, replySession: 's', from: 'a', replySocket: 1, id: 'n', app: APP, messagePeer: PEER, messagePhone: 'a' };
  const item = { id: 'n', app: APP, messagePeer: PEER, messagePhone: 'a' };
  assert.equal(sameProvenOffer(prev, item, 'a', 1), true);
  assert.equal(sameProvenOffer(prev, item, 'a', 2), false, 'another socket');
  assert.equal(sameProvenOffer(prev, item, 'b', 1), false, 'another phone');
  assert.equal(sameProvenOffer(prev, { ...item, app: 'com.whatsapp' }, 'a', 1), false, 'another app');
  assert.equal(sameProvenOffer({ ...prev, messagePeer: undefined }, { ...item, messagePeer: undefined }, 'a', 1), false, 'a title alone proves nothing');
});

// ---- (5) Windows/Linux Mesh: act, dismiss, popup and expiry keyed by origin + ID ----

const ID = 'fixture-collide';
const OLD = 'origin-old';
const NEW = 'origin-new';

function mesh(Cls) {
  const sent = [];
  const connected = new Set([OLD, NEW]);
  const sockets = new Map([[OLD, { n: 1 }], [NEW, { n: 2 }]]);
  const m = new Mesh({ selfId: 'desk' });
  const bus = new EventEmitter();
  bus.onPeer = () => {};
  bus.connectedIds = () => [...connected];
  bus.replySocket = (id) => connected.has(id) ? sockets.get(id) : null;
  bus.send = (id, msg) => { sent.push({ id, msg }); return connected.has(id); };
  for (const id of [OLD, NEW]) m.addPeer({ id, os: P.OS.ANDROID, mesh: true, send: () => true });
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    show() {}
    close() { this.emit('close'); }
  }
  const opts = { bus, mesh: m, settings: { notifs: { receive: true, send: false, muted: [], hideText: false } },
    save() {}, onChange() {}, onClick() {}, Notification, selfName: 'Desk', peerName: () => '' };
  if (Cls === WindowsNotifs) opts.helper = new EventEmitter();
  const notifs = new Cls(opts);
  const show = (origin, extra = {}) => bus.emit(P.T.NOTIF, { id: ID, app: APP, appName: 'Fixture', title: 'Fixture', body: 'Fixture',
    reply: true, actions: ['Mark read'], at: 1000, ...extra }, origin, sockets.get(origin));
  return { notifs, bus, sent, show };
}

for (const [platform, Cls, ipc] of [['windows', WindowsNotifs, () => windowsIpc], ['linux', LinuxNotifs, () => linuxIpc]]) {
  test(`${platform} Mesh act and dismiss reach only the named origin; an ambiguous ID reaches nobody`, () => {
    const f = mesh(Cls);
    f.show(OLD);
    f.show(NEW);
    assert.equal(f.notifs.act(ID, 0), false, 'two origins share the ID: no guess');
    assert.equal(f.notifs.dismiss(ID), false);
    assert.equal(f.sent.length, 0);
    assert.equal(f.notifs.act(ID, 0, NEW), true);
    assert.deepEqual(f.sent.map((s) => [s.id, s.msg.t]), [[NEW, 'notif.act']]);
    assert.equal(f.notifs.dismiss(ID, OLD), true);
    assert.deepEqual(f.sent.map((s) => [s.id, s.msg.t]), [[NEW, 'notif.act'], [OLD, 'notif.dismiss']]);
    assert.deepEqual(f.notifs.history.filter((h) => h.id === ID).map((h) => h.from), [NEW], 'only that origin is removed');
    assert.equal(f.notifs.act(ID, 0, OLD), false, 'the dismissed origin cannot act');
    assert.equal(f.notifs.act(ID, 0), true, 'a now-unique ID still works without an origin');
    assert.equal(f.sent.at(-1).id, NEW);
  });

  test(`${platform} Mesh notifReply IPC passes the origin for act and dismiss`, () => {
    const f = mesh(Cls);
    f.show(OLD);
    f.show(NEW);
    for (const k of Object.keys(ipcHandlers)) delete ipcHandlers[k];
    ipc()({ notifs: f.notifs, settings: {} });
    const notifReply = ipcHandlers.notifReply;
    assert.equal(typeof notifReply, 'function');
    assert.equal(notifReply({}, { id: ID, act: 0 }), false, 'no origin, shared ID: refused');
    assert.equal(notifReply({}, { id: ID, act: 0, from: OLD }), true);
    assert.equal(notifReply({}, { id: ID, dismiss: true, from: NEW }), true);
    assert.deepEqual(f.sent.map((s) => [s.id, s.msg.t]), [[OLD, 'notif.act'], [NEW, 'notif.dismiss']]);
    assert.deepEqual(f.notifs.history.filter((h) => h.id === ID).map((h) => h.from), [OLD]);
  });

  test(`${platform} Mesh expiry closes only its origin's same-ID popup, and the popup acts on its own origin`, () => {
    const f = mesh(Cls);
    f.show(OLD);
    f.show(NEW);
    const pop = new NotifPop({
      act: (id, i, it) => f.notifs.act(id, i, it && it.from),
      dismiss: (id, it) => f.notifs.dismiss(id, it && it.from),
      reply: (it, text) => f.notifs.reply(it.id, text, it.from, it.replySession),
    });
    f.notifs.pop = pop;
    const start = windows.length;
    for (const origin of [OLD, NEW]) pop.show(f.notifs.history.find((h) => h.id === ID && h.from === origin));
    assert.equal(windows.length - start, 1, 'presentation of a shared ID updates in place');
    pop.closeAll();
    pop.show(f.notifs.history.find((h) => h.id === ID && h.from === OLD));
    handlers['notifpop:typing']({ sender: windows.at(-1).webContents });
    pop.show(f.notifs.history.find((h) => h.id === ID && h.from === NEW));
    const [oldWin, newWin] = windows.slice(-2);
    f.bus.emit('notif.gone', { id: ID }, OLD);
    assert.equal(newWin.closed, undefined, 'the other origin keeps its window');
    assert.equal(oldWin.closed, undefined, 'a window with typed text stays');
    const state = oldWin.sent.at(-1)[1];
    assert.ok(state.notice === 'expired' && state.reply === false && state.actions.length === 0 && state.dismiss === false,
      'but it is no longer actionable');
    handlers['notifpop:act']({ sender: oldWin.webContents }, 0);
    handlers['notifpop:reply']({ sender: oldWin.webContents }, 'Synthetic draft');
    assert.equal(f.sent.length, 0, 'the expired origin\'s popup sends nothing');
    handlers['notifpop:act']({ sender: newWin.webContents }, 0);
    assert.deepEqual(f.sent.map((s) => [s.id, s.msg.t]), [[NEW, 'notif.act']], 'the live popup acts on its own origin');
    pop.closeAll();
  });
}

test('a refused popup Reply keeps its window and typed text, and never retries by itself', () => {
  let answer = false;
  const replies = [];
  const pop = new NotifPop({ reply: (it, text) => { replies.push(text); return answer; } });
  pop.show({ id: 'n1', app: APP, title: 'Fixture', reply: true, from: 'phone-a', replySession: 's1' });
  const win = windows.at(-1);
  handlers['notifpop:typing']({ sender: win.webContents });
  handlers['notifpop:reply']({ sender: win.webContents }, 'Synthetic draft');
  assert.equal(win.closed, undefined, 'the window stays');
  assert.equal(win.sent.at(-1)[1].notice, 'refused', 'and says so');
  assert.equal(replies.length, 1, 'no automatic retry');
  answer = true;
  handlers['notifpop:reply']({ sender: win.webContents }, 'Synthetic draft');
  assert.equal(win.closed, true, 'a sent Reply closes it');
  pop.closeAll();
});
