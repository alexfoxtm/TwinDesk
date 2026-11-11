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
}

try {
  actionsStayWithOrigin();
  refusesRelayAndDisconnectedActions();
  console.log('notif-actions: ok');
} finally {
  Module._load = load;
}
