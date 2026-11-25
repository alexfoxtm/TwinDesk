// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Colliding notification ids on Windows and Linux mesh: expiry removes only that origin's offer.
// Run with: node shared/test/mesh-notif-origin-expiry.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');

const load = Module._load;
Module._load = function (name) {
  if (name === 'electron') return {};
  return load.apply(this, arguments);
};

const WindowsNotifs = require('../../windows/mesh/notifs.js');
const LinuxNotifs = require('../../linux/mesh/notifs.js');

const ID = 'fixture-collide';
const OTHER = 'fixture-other';
const OLD = 'origin-old';
const NEW = 'origin-new';

function harness(Cls) {
  const sent = [];
  const connected = new Set([OLD, NEW]);
  const sockets = new Map([[OLD, { n: 1 }], [NEW, { n: 2 }]]);
  const mesh = new Mesh({ selfId: 'desk' });
  const bus = new EventEmitter();
  bus.onPeer = () => {};
  bus.connectedIds = () => [...connected];
  bus.replySocket = (id) => connected.has(id) ? sockets.get(id) : null;
  bus.send = (id, msg) => { sent.push({ id, msg }); return connected.has(id); };
  for (const id of [OLD, NEW]) {
    mesh.addPeer({ id, os: P.OS.ANDROID, mesh: true, send: () => true });
  }
  const settings = { notifs: { receive: true, send: false, muted: [], hideText: false } };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(opts) { super(); this.opts = opts; }
    show() {}
    close() { this.emit('close'); }
  }
  const opts = {
    bus, mesh, settings, save: () => {}, onChange: () => {}, onClick: () => {},
    Notification, selfName: 'Desk', peerName: () => '',
  };
  if (Cls === WindowsNotifs) opts.helper = new EventEmitter();
  const notifs = new Cls(opts);
  const show = (origin, id, version) => {
    bus.emit(P.T.NOTIF, {
      id, app: 'com.google.android.apps.messaging', appName: 'Fixture', title: 'Fixture', body: 'Fixture',
      reply: true, replyVersion: version, actions: ['Mark read'], at: 1000,
    }, origin, sockets.get(origin));
  };
  return { notifs, bus, sent, sockets, show };
}

function offers(notifs, id) {
  return (notifs.history || []).filter((item) => item.id === id).map((item) => item.from);
}

function collision(Cls, expired) {
  const f = harness(Cls);
  f.show(OLD, ID, 'offer-old');
  f.show(NEW, ID, 'offer-new');
  f.show(OLD, OTHER, 'offer-keep');
  const older = f.notifs.history.find((item) => item.id === ID && item.from === OLD);
  const newer = f.notifs.history.find((item) => item.id === ID && item.from === NEW);
  const kept = f.notifs.history.find((item) => item.id === OTHER && item.from === OLD);
  assert.ok(older && older.reply && older.replySession, 'older origin has a reply offer');
  assert.ok(newer && newer.reply && newer.replySession, 'newer origin has a reply offer');
  assert.notStrictEqual(older.replySession, newer.replySession);
  assert.ok(kept && kept.reply, 'a different id on the older origin stays addressable');
  const survivor = expired === OLD ? newer : older;
  f.notifs.pop = {
    wins: [{ id: ID, item: { from: survivor.from } }],
    gone(id) { this.closed = (this.closed || []).concat(id); this.wins = this.wins.filter((w) => w.id !== id); },
  };
  f.bus.emit('notif.gone', { id: ID }, expired);

  assert.deepStrictEqual(offers(f.notifs, ID), [survivor.from], 'expiry removes only the matching origin');
  assert.strictEqual(f.notifs.history.find((item) => item.id === ID && item.from === expired), undefined);
  const still = f.notifs.history.find((item) => item.id === ID && item.from === survivor.from);
  assert.strictEqual(still, survivor, 'the other origin keeps the same offer object');
  assert.strictEqual(still.reply, true);
  assert.strictEqual(still.replySession, survivor.replySession);
  assert.strictEqual((still.actions || []).length, 1);
  assert.ok(f.notifs.history.includes(kept), 'the same origin keeps its other notification');
  assert.deepStrictEqual(f.notifs.pop.closed, undefined, 'the other origin\'s window stays up');
  assert.ok([...f.notifs.live].some((n) => n.tdId === ID && n.tdOrigin === survivor.from), 'the other origin\'s toast stays');
  assert.ok(![...f.notifs.live].some((n) => n.tdId === ID && n.tdOrigin === expired), 'only the expired origin\'s toast closes');

  assert.strictEqual(f.notifs.reply(ID, 'Fixture reply', survivor.from, survivor.replySession), true, 'the surviving offer still answers on its session');
  assert.deepStrictEqual(f.sent.map((row) => [row.id, row.msg.t, row.msg.replyVersion]), [[survivor.from, 'notif.reply', survivor === newer ? 'offer-new' : 'offer-old']]);
  assert.strictEqual(f.notifs.reply(ID, 'Fixture reply', expired, expired === OLD ? older.replySession : newer.replySession), false, 'the expired origin cannot reply');
  f.sockets.set(survivor.from, { n: 3 });
  assert.strictEqual(f.notifs.reply(ID, 'Fixture reply', survivor.from, survivor.replySession), false, 'a replaced socket is not the current session');
  assert.strictEqual(f.sent.length, 1);
}

const cases = [
  ['windows', WindowsNotifs, OLD],
  ['windows', WindowsNotifs, NEW],
  ['linux', LinuxNotifs, OLD],
  ['linux', LinuxNotifs, NEW],
];

try {
  for (const [platform, Cls, expired] of cases) {
    try {
      collision(Cls, expired);
    } catch (err) {
      err.message = platform + ' ' + expired + ': ' + err.message;
      throw err;
    }
  }
  console.log('mesh-notif-origin-expiry: ' + cases.length + ' cases passed');
} finally {
  Module._load = load;
}
