// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { Mesh } = require('../../shared/mesh.js');
const { OS, T } = require('../../shared/protocol.js');

let electron;
const load = Module._load;
Module._load = function (id, ...args) {
  return id === 'electron' ? electron : load.call(this, id, ...args);
};
test.after(() => { Module._load = load; });

function bridge(mode) {
  const root = mode === 'Mesh' ? '../mesh' : '..';
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const frame = { url: pathToFileURL(path.resolve(__dirname, root, 'control.html')).href + '?tab=messages' };
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  let api;
  electron = {
    ipcMain,
    contextBridge: { exposeInMainWorld: (_, methods) => { api = methods; } },
    ipcRenderer: {
      send(channel, arg) { ipcMain.emit(channel, event, arg); },
      async invoke(channel, arg) {
        const handler = handlers.get(channel);
        if (!handler) throw new Error('IPC handler unavailable');
        return handler(event, arg);
      },
    },
  };
  require(root + '/preload-control.js');
  const { setupIpc } = require(root + '/ipc.js');
  return { api, setupIpc, handlers, event, frame };
}

for (const mode of ['Direct', 'Mesh']) {
  test(`${mode} control IPC returns the notification reply dispatch result`, async () => {
    const { api, setupIpc, handlers, event, frame } = bridge(mode);
    const settings = { notifs: { receive: true, style: 'none' } };
    const server = new EventEmitter();
    const helper = new EventEmitter();
    const phone = 'fixture-device';
    const socket = {};
    let accept = false;
    const sent = [];
    const send = (msg) => { sent.push({ type: msg.t, version: msg.replyVersion }); return accept; };
    const offer = { id: 'fixture-offer', app: 'com.google.android.apps.messaging', reply: true, replyVersion: 'fixture-version', actions: ['Action'] };
    let notifs;
    if (mode === 'Mesh') {
      const { Notifs } = require('../mesh/notifs.js');
      const mesh = new Mesh({ selfId: 'fixture-mac' });
      mesh.addPeer({ id: phone, os: OS.ANDROID, send: () => true });
      const bus = Object.assign(new EventEmitter(), {
        onPeer() {},
        connectedIds: () => [phone],
        replySocket: () => socket,
        send(id, msg) { assert.ok(id === phone, 'dispatch stayed with the offering device'); return send(msg); },
      });
      notifs = new Notifs({ bus, mesh, helper, getSettings: () => settings, Notification: { isSupported: () => true } });
      bus.emit(T.NOTIF, offer, phone, null, socket);
    } else {
      const { Notifs } = require('../notifs.js');
      server.current = { deviceId: phone };
      server.outbound = () => socket;
      server.sendToClient = send;
      notifs = new Notifs({ server, helper, getSettings: () => settings });
      server.emit(`t:${T.NOTIF}`, offer, server.current, socket);
    }
    const item = notifs.history[0];
    const { id, from, replySession } = item;
    const reply = { id, from, replySession, text: 'Synthetic draft' };
    const chat = { reply: (key, _text, _image, remove) => key === 'fixture-chat' && remove };
    const ctx = { state: { connect: {} }, server, notifs, chats: mode === 'Mesh' ? () => chat : chat };
    setupIpc(ctx);

    assert.equal(await api.notifReply(reply), false, 'a refused dispatch returns false to preserve the draft');
    assert.equal(sent.length, 1, 'the transport was tried');
    assert.equal(item.replies, undefined, 'a refused reply is absent from local history');
    accept = true;
    assert.equal(await api.notifReply({ ...reply, replySession: 'stale' }), false);
    event.senderFrame = { url: frame.url };
    assert.equal(await api.notifReply(reply), false, 'a subframe cannot dispatch');
    event.senderFrame = frame;
    const controlURL = frame.url;
    frame.url = 'about:blank';
    assert.equal(await api.notifReply(reply), false, 'a different page cannot dispatch');
    frame.url = controlURL;
    assert.equal(await api.notifReply(null), false);
    assert.equal(await api.notifReply({ chat: 'fixture-chat' }), false, 'chat refusal returns false');
    assert.equal(sent.length, 1, 'invalid requests never reached the transport');

    assert.equal(await api.notifReply(reply), true);
    assert.equal(item.replies.length, 1);
    assert.deepEqual(sent[1], { type: 'notif.reply', version: 'fixture-version' });
    assert.equal(await api.notifReply({ id, act: 0 }), true);
    assert.equal(await api.notifReply({ id, dismiss: true }), true);
    assert.deepEqual(sent.slice(2).map(({ type }) => type), ['notif.act', 'notif.dismiss']);
    assert.equal(await api.notifReply({ chat: 'fixture-chat', remove: true }), true);
    delete ctx.notifs;
    assert.equal(await api.notifReply(reply), false, 'a missing notification service returns false');
    handlers.delete('notifReply');
    assert.equal(await api.notifReply(reply), false, 'a missing IPC handler returns false');
  });
}
