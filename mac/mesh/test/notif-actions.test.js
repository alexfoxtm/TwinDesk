// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const { Mesh } = require('../../../shared/mesh.js');
const P = require('../../../shared/protocol.js');

const copied = [];
const load = Module._load;
Module._load = function (name) {
  if (name === 'electron') return { clipboard: { writeText: (text) => copied.push(text) } };
  return load.apply(this, arguments);
};
const { Notifs } = require('../notifs.js');

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
  bus.selectedId = () => 'other';
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(opts) { super(); this.opts = opts; shown.push(this); }
    show() {}
  }
  const settings = { notifs: { receive: true, send: false } };
  const notifs = new Notifs({ bus, mesh, helper: new EventEmitter(), getSettings: () => settings, Notification });
  return { notifs, bus, mesh, shown, sent, connected, settings };
}

function actionsStayWithOrigin() {
  const f = fixture();
  f.bus.emit(P.T.NOTIF, { id: 'n1', app: 'mail', title: 'Verification', subtitle: 'Your code is 482913', actions: ['Mark read'] }, 'phone');
  assert.deepStrictEqual(f.shown[0].opts.actions.map((a) => a.text), ['Copy 482913', 'Mark read']);
  f.shown[0].emit('action', {}, 0);
  assert.deepStrictEqual(copied, ['482913'], 'Copy writes the Mac clipboard');
  assert.deepStrictEqual(f.sent, [], 'Copy does not run a phone action');
  f.shown[0].emit('action', {}, 1);
  assert.deepStrictEqual(f.sent, [{ id: 'phone', msg: { t: 'notif.act', id: 'n1', i: 0 } }], 'selection cannot change the action recipient');
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

try {
  actionsStayWithOrigin();
  refusesRelayAndDisconnectedActions();
  goneClosesOnlyThatSessionsPopup();
  goneClosesPopupAfterHistoryCleared();
  console.log('notif-actions: ok');
} finally {
  Module._load = load;
}
