// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const { pathToFileURL } = require('node:url');
const { Mesh } = require('../../../shared/mesh.js');
const P = require('../../../shared/protocol.js');

const copied = [];
const ipcMain = new EventEmitter();
const handlers = new Map();
ipcMain.handle = (name, fn) => handlers.set(name, fn);
const load = Module._load;
Module._load = function (name) {
  if (name === 'electron') return { ipcMain, clipboard: { writeText: (text) => copied.push(text) } };
  return load.apply(this, arguments);
};
const { Notifs } = require('../notifs.js');
const { setupIpc } = require('../ipc.js');

function fixture() {
  const sent = [];
  const shown = [];
  const connected = new Set(['phone', 'other']);
  const mesh = new Mesh({ selfId: 'mac' });
  mesh.addPeer({ id: 'phone', name: 'Phone', os: P.OS.ANDROID, send: () => true });
  mesh.addPeer({ id: 'other', name: 'Other', os: P.OS.MAC, mesh: true, send: () => true });
  const bus = new EventEmitter();
  bus.onPeer = () => {};
  bus.connectedIds = () => [...connected];
  bus.send = (id, msg) => { sent.push({ id, msg }); return connected.has(id); };
  const sockets = new Map([['phone', {}], ['other', {}]]);
  bus.replySocket = (id) => connected.has(id) ? sockets.get(id) : null;
  bus.selectedId = () => 'other';
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(opts) { super(); this.opts = opts; shown.push(this); }
    show() {}
  }
  const settings = { notifs: { receive: true, send: false } };
  const notifs = new Notifs({ bus, mesh, helper: new EventEmitter(), getSettings: () => settings, Notification });
  return { notifs, bus, mesh, shown, sent, connected, settings, sockets };
}

function actionsStayWithOrigin() {
  const f = fixture();
  f.bus.emit(P.T.NOTIF, { id: 'n1', app: 'mail', title: 'Verification', subtitle: 'Your code is 482913', actions: ['Mark read'] }, 'phone');
  assert.deepStrictEqual(f.shown[0].opts.actions.map((a) => a.text), ['Use code', 'Copy 482913', 'Mark read']);
  f.shown[0].emit('action', {}, 1);
  assert.deepStrictEqual(copied, ['482913'], 'Copy writes the Mac clipboard via quietCopy');
  assert.strictEqual(require('../../../shared/otp.js').isQuiet('482913'), true, 'manual Copy is marked quiet (local-only, sync-exempt)');
  assert.deepStrictEqual(f.sent, [], 'Copy does not run a phone action');
  f.shown[0].emit('action', {}, 2);
  assert.deepStrictEqual(f.sent, [{ id: 'phone', msg: { t: 'notif.act', id: 'n1', i: 0 } }], 'selection cannot change the action recipient');
  require('../../../shared/otp.js').invalidateQuietCopy();
}

function refusesRelayAndDisconnectedActions() {
  const f = fixture();
  f.bus.emit(P.T.NOTIF, { id: 'relay', app: 'mail', title: 'Code 714285', actions: ['Mark read'], o: 'phone', s: 1, d: [], h: 1 }, 'other');
  assert.deepStrictEqual(f.shown[0].opts.actions.map((a) => a.text), ['Copy 714285'], 'relay gets local Copy only');
  f.shown[0].emit('action', {}, 1);
  f.bus.emit(P.T.NOTIF, { id: 'direct', app: 'chat', title: 'New message', actions: ['Mark read'] }, 'phone');
  f.connected.delete('phone');
  f.shown[1].emit('action', {}, 0);
  f.connected.add('phone');
  f.bus.emit(P.T.NOTIF, { id: 'direct', app: 'chat', title: 'New message', actions: ['Delete'] }, 'phone');
  f.shown[1].emit('action', {}, 0);
  assert.deepStrictEqual(f.shown[2].opts.actions.map((a) => a.text), ['Delete']);
  f.mesh.removePeer('phone');
  f.mesh.addPeer({ id: 'phone', os: P.OS.ANDROID, send: () => true });
  f.shown[1].emit('action', {}, 0);
  f.settings.notifs.receive = false;
  f.shown[1].emit('action', {}, 0);
  assert.deepStrictEqual(f.sent, [], 'neither a relay, a disconnected source nor a disabled receiver sends an action');
  assert.strictEqual(f.notifs.dismiss('relay'), true, 'a relayed notification can be dismissed locally');
  assert(!f.notifs.history.some((item) => item.id === 'relay'));
  assert.strictEqual(f.notifs.dismiss('direct'), true, 'a stale notification can be dismissed locally');
  assert(!f.notifs.history.some((item) => item.id === 'direct'));
  assert.deepStrictEqual(f.sent, [], 'local dismiss does not send to a disconnected or replaced session');
}

function goneClosesOnlyThatSessionsPopup() {
  const f = fixture();
  const closed = [];
  f.notifs.history = [
    { id: 'n1', from: 'phone', title: 'Phone' },
    { id: 'n1', from: 'other', title: 'Other' },
  ];
  f.notifs.pop = {
    wins: [{ id: 'n1', item: { from: 'phone' } }],
    gone(id) { closed.push(id); this.wins = this.wins.filter((w) => w.id !== id); },
  };
  f.bus.emit('notif.gone', { id: 'n1' }, 'other');
  assert.deepStrictEqual(closed, [], 'a different session does not close this popup');
  assert.ok(f.notifs.history.some((item) => item.from === 'phone'));
  assert.ok(!f.notifs.history.some((item) => item.from === 'other'), 'that session still leaves its own history');
  f.bus.emit('notif.gone', { id: 'n1' }, 'phone');
  assert.deepStrictEqual(closed, ['n1'], 'the phone dismiss closes its TwinDesk window');
  assert.ok(!f.notifs.history.some((item) => item.from === 'phone'));

  const dismissed = [];
  f.notifs.history = [{ id: 'n2', from: 'phone', title: 'Again' }];
  f.notifs.pop = {
    wins: [{ id: 'n2', item: { from: 'phone' } }],
    gone(id) { dismissed.push(id); this.wins = this.wins.filter((w) => w.id !== id); },
  };
  assert.strictEqual(f.notifs.dismiss('n2'), true);
  assert.deepStrictEqual(dismissed, ['n2'], 'a local dismiss closes the popup too');
  assert.ok(!f.notifs.history.some((item) => item.id === 'n2'));

  const stayed = [];
  f.notifs.history = [{ id: 'n3', from: 'phone', title: 'No origin' }];
  f.notifs.pop = {
    wins: [{ id: 'n3', item: {} }],
    gone(id) { stayed.push(id); },
  };
  assert.strictEqual(f.notifs.dismiss('n3'), true, 'history can still be dismissed');
  assert.deepStrictEqual(stayed, [], 'a popup with no origin stays up');
}

function goneClosesPopupAfterHistoryCleared() {
  const f = fixture();
  const closed = [];
  f.notifs.history = [];
  f.notifs.live = new Set();
  f.notifs.pop = {
    wins: [
      { id: 'n1', item: { from: 'phone' } },
      { id: 'bare', item: {} },
      { id: 'blank', item: { from: '' } },
      { id: 'other', item: { from: 'other' } },
      { id: 'both', item: { from: 'phone' } },
      { id: 'both', item: { from: 'other' } },
    ],
    gone(id) { closed.push(id); this.wins = this.wins.filter((w) => w.id !== id); },
  };
  f.bus.emit('notif.gone', { id: 'n1' }, 'phone');
  assert.deepStrictEqual(closed, ['n1'], 'a cleared history still closes the matching popup');
  f.bus.emit('notif.gone', { id: 'bare' }, 'phone');
  f.bus.emit('notif.gone', { id: 'blank' }, 'phone');
  f.bus.emit('notif.gone', { id: 'other' }, 'phone');
  f.bus.emit('notif.gone', { id: 'both' }, 'phone');
  f.bus.emit('notif.gone', { id: 'n1' }, '');
  assert.deepStrictEqual(closed, ['n1'], 'absent, blank, mismatched, and ambiguous origins stay up');
  assert.strictEqual(f.notifs.dismiss('n1'), false, 'dismiss does not invent an origin');
  f.notifs.pop.wins = [{ id: 'left', item: { from: 'phone' } }];
  assert.strictEqual(f.notifs.dismiss('left'), true);
  assert.deepStrictEqual(closed, ['n1', 'left'], 'dismiss uses the popup origin when history is gone');
  assert.deepStrictEqual(f.sent, [], 'no device is notified from a cleared history');
  f.notifs.pop = { gone(id) { closed.push('untracked:' + id); } };
  f.bus.emit('notif.gone', { id: 'n1' }, 'phone');
  assert.deepStrictEqual(closed, ['n1', 'left'], 'a popup that does not expose origins is left alone');
}

function exactReplyAndPrivateRelay() {
  const f = fixture();
  const relay = [];
  f.mesh.get('other').notifPool = true;
  f.mesh.get('other').send = (m) => { relay.push(m); return true; };
  f.connected.add('second-phone');
  f.sockets.set('second-phone', {});
  f.mesh.addPeer({ id: 'second-phone', os: P.OS.ANDROID, send: () => true });
  const notice = { t: P.T.NOTIF, id: 'reused', app: 'com.google.android.apps.messaging',
    title: 'Fixture', reply: true, messagePeer: '+12025550100', messageAt: 100, replyVersion: 'fixture-1' };
  const show = (m, id) => f.bus.emit(P.T.NOTIF, m, id, {}, f.sockets.get(id));
  show(notice, 'phone');
  const old = f.notifs.history[0];
  show(notice, 'second-phone');
  const other = f.notifs.history[0];
  setupIpc({ state: { connect: {}, permissions: {} }, server: new EventEmitter(), notifs: f.notifs });
  const frame = { url: new URL('../control.html', pathToFileURL(__filename)).href };
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  const send = ({ id, from, replySession }) => handlers.get('notifReply')(event, { id, from, replySession, text: 'Fixture reply' });
  send(old);
  send(other);
  assert.deepStrictEqual(f.sent.map((x) => x.id), ['phone', 'second-phone']);
  assert.equal(f.sent[0].msg.replyVersion, notice.replyVersion);
  assert.ok(old.messagePeer && old.messageAt);
  assert.strictEqual(relay.length, 0, 'Android-origin notifications stay local and never relay to downstream peers');
  f.sockets.set('phone', {});
  send(old);
  assert.equal(f.sent.length, 2);
  show({ ...notice, replyVersion: 'fixture-2' }, 'phone');
  send(old);
  assert.equal(f.sent.length, 2);
  send(f.notifs.history[0]);
  assert.equal(f.sent.length, 3);
}

function privacyRelayBoundaries() {
  const f = fixture();
  const relayOther = [];
  const relayWin = [];
  f.mesh.get('other').notifPool = true;
  f.mesh.get('other').send = (m) => { relayOther.push(m); return true; };
  f.connected.add('pc');
  f.mesh.addPeer({ id: 'pc', name: 'PC', os: P.OS.WIN, mesh: true, send: (m) => { relayWin.push(m); return true; } });
  f.mesh.get('pc').notifPool = true;

  // 1. Android-origin stays local (dedupe still works).
  f.bus.emit(P.T.NOTIF, { t: P.T.NOTIF, id: 'a1', app: 'com.bank', title: 'Alert', body: 'Sensitive item', o: 'phone', s: 10, d: [], h: 0 }, 'phone');
  f.bus.emit(P.T.NOTIF, { t: P.T.NOTIF, id: 'a1', app: 'com.bank', title: 'Alert', body: 'Sensitive item', o: 'phone', s: 10, d: [], h: 0 }, 'phone');
  assert.strictEqual(f.shown.length, 1, 'Android notification is shown once and deduped');
  assert.strictEqual(relayOther.length, 0, 'Android notification is never relayed to other Mac');
  assert.strictEqual(relayWin.length, 0, 'Android notification is never relayed to PC');

  // 2. Relayed Android-origin or unknown-origin notifications stay local too.
  f.bus.emit(P.T.NOTIF, { t: P.T.NOTIF, id: 'a2', app: 'com.bank', title: 'Via other', o: 'phone', s: 11, d: [], h: 0 }, 'other');
  f.bus.emit(P.T.NOTIF, { t: P.T.NOTIF, id: 'u1', app: 'com.unknown', title: 'Unknown origin', o: 'mystery-device', s: 1, d: [], h: 0 }, 'other');
  assert.strictEqual(relayWin.length, 0, 'Android-origin and unknown-origin notifications never relay further');

  // 3. Hidden notifications (even from an allowed Mac/PC) never reach another peer.
  f.settings.notifs.phoneApps = { 'com.secret.app': { mode: 'hide', name: 'Secret' } };
  f.bus.emit(P.T.NOTIF, { t: P.T.NOTIF, id: 'h1', app: 'com.secret.app', title: 'Hidden', o: 'other', s: 1, d: [], h: 0 }, 'other');
  assert.strictEqual(relayWin.length, 0, 'hidden notification never relays to downstream peers');
  assert.ok(!f.notifs.history.some((x) => x.id === 'h1'), 'hidden notification is not kept in history');

  // 4. Ordinary allowed Mac/PC pooling still works (and strips Android-private fields).
  f.bus.emit(P.T.NOTIF, {
    t: P.T.NOTIF, id: 'm1', app: 'com.apple.mail', title: 'Hello', body: 'Allowed Mac notice',
    messagePeer: '+12025550100', messageAt: 100, replyVersion: 'v1', o: 'other', s: 2, d: [], h: 0,
  }, 'other');
  assert.strictEqual(relayWin.length, 1, 'ordinary allowed Mac notification relays to PC');
  assert.ok(!('messagePeer' in relayWin[0]) && !('messageAt' in relayWin[0]) && !('replyVersion' in relayWin[0]));
}


try {
  actionsStayWithOrigin();
  exactReplyAndPrivateRelay();
  privacyRelayBoundaries();
  refusesRelayAndDisconnectedActions();
  goneClosesOnlyThatSessionsPopup();
  goneClosesPopupAfterHistoryCleared();
  console.log('notif-actions: ok');
} finally {
  Module._load = load;
}
