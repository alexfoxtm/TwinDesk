// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const P = require('../protocol.js');
const Peer = require('../../linux/peer.js');

const load = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? {} : load.call(this, name, ...args);
};
let Notifs;
try {
  Notifs = require('../../linux/notifs.js');
} finally {
  Module._load = load;
}

process.env.TWINDESK_NO_FX2 = '1';
process.env.TWINDESK_NO_IL = '1';

const message = {
  t: P.T.NOTIF, id: 'fixture-notif', app: 'com.google.android.apps.messaging',
  messagePeer: '+12025550100', messageAt: 1000, reply: true, replyVersion: 'fixture-version',
};

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

  const notifs = new Notifs({
    link: peer, settings: { notifs: { receive: true, style: 'none' } },
    peerName: () => '', onChange() {},
  });
  return { notifs, socket, phone, sent, receive: () => server.emit('message', message, phone, socket) };
}

test('Linux Direct retains one-to-one identity and replies on the active phone session', () => {
  const { notifs, phone, sent, receive } = direct();
  receive();

  const [item] = notifs.view().history;
  assert.ok(item, 'the notification reached Recent history');
  assert.equal(item.id, message.id);
  assert.ok(item.messagePeer === message.messagePeer, 'one-to-one destination was retained');
  assert.equal(item.messageAt, message.messageAt);
  assert.equal(item.messagePhone, phone.deviceId);
  assert.equal(item.reply, true);
  assert.ok(item.replySession, 'the current session has a reply offer');

  assert.equal(notifs.reply(item.id, 'fixture reply', item.from, item.replySession), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].context, phone);
  assert.equal(sent[0].msg.t, 'notif.reply');
  assert.equal(sent[0].msg.id, message.id);
  assert.equal(sent[0].msg.replyVersion, message.replyVersion);
});

test('Linux Direct revokes a reply when the physical socket is released', () => {
  const { notifs, socket, sent, receive } = direct();
  receive();
  const [item] = notifs.view().history;
  assert.equal(item.reply, true);

  socket.released = true;

  assert.equal(notifs.view().history[0].reply, false);
  assert.equal(notifs.reply(item.id, 'fixture reply', item.from, item.replySession), false);
  assert.equal(sent.length, 0);
});
