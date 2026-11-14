// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// New camera photos and videos as a notification on the computer (phonehub.js onMediaNew,
// mac/photoalert.js): no phone here, the session and Electron's Notification are stand-ins.
// One that works, and one where nothing may happen.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../protocol.js');
const { PhoneHub } = require('../phonehub.js');
const { photoAlerts } = require('../../mac/photoalert.js');
const { Route } = require('../hub-route.js');
const { Peer } = require('../../mac/mesh/peer.js');

const T = P.T;

// A paired phone's session, as mac/peer.js gives it: what the phone sends arrives with its ctx.
function setup({ hub = {}, alerts = true } = {}) {
  const server = new EventEmitter();
  server.current = null;
  server.sent = [];
  server.sendToClient = (m) => server.sent.push(m);
  const settings = { hub: { calls: false, messages: false, media: true, files: false, mediaAlerts: true, ...hub } };
  const shown = [];
  const opened = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(o) { super(); Object.assign(this, o); }
    show() { shown.push(this); }
    close() { this.closed = true; }
  }
  const mediaAlert = photoAlerts({ Notification, t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)), open: (tab) => opened.push(tab) });
  const phoneHub = new PhoneHub({ server, getSettings: () => settings, save() {}, ...(alerts ? { mediaAlert } : {}) });
  const connect = (ctx) => { server.current = ctx; server.emit('client', ctx); return ctx; };
  const from = (ctx, m) => server.emit(`t:${m.t}`, m, ctx);
  const state = (ctx, media) => from(ctx, { t: T.HUB_STATE, media });
  return { server, settings, shown, opened, phoneHub, connect, from, state };
}

const pixel = () => ({ os: P.OS.ANDROID, name: 'Pixel', deviceId: 'a1' });

// ---- it works: switched on here, Photos on and allowed, from the session connected now ----
{
  const { server, shown, opened, phoneHub, connect, from, state } = setup();
  const phone = connect(pixel());
  assert.strictEqual(server.sent.find((m) => m.t === T.HUB_POLICY).mediaAlerts, true, 'the phone hears it was switched on');
  state(phone, { perm: 'ok', remove: true, alerts: true });
  assert.strictEqual(phoneHub.view.canMediaAlerts && phoneHub.view.mediaAlerts && phoneHub.view.perm.media.alerts, true, 'the page shows its switch, on');

  // Whatever else the phone puts in, only the two counts get through.
  const sentBefore = server.sent.length;
  from(phone, { t: T.MEDIA_NEW, photos: 1, videos: 0, id: 'i42', name: 'IMG_0042.jpg', path: 'DCIM/Camera/IMG_0042.jpg', data: 'data:image/jpeg;base64,AAAA', lat: 43.2, lon: 76.9 });
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].title, 'New photo on Pixel');
  assert.strictEqual(shown[0].body, 'Click to open Photos');
  assert.ok(!shown[0].silent, 'the first one makes its sound');
  assert.ok(!/IMG_0042|DCIM|base64|43\.2|76\.9|i42/.test(JSON.stringify(shown[0])), 'no name, path, place or picture in the notification');
  assert.strictEqual(server.sent.length, sentBefore, 'nothing is asked of the phone because of it: no list, thumbnail or file');

  // More in the same minute: the one notification, quietly, with the count so far.
  from(phone, { t: T.MEDIA_NEW, photos: 2, videos: 1 });
  assert.strictEqual(shown.length, 2);
  assert.ok(shown[0].closed && shown[1].silent);
  assert.strictEqual(shown[1].title, '4 new photos and videos on Pixel');

  // A click opens Photos while that session is the one connected; after it's gone, nothing.
  shown[1].emit('click');
  assert.deepStrictEqual(opened, ['media']);
  from(phone, { t: T.MEDIA_NEW, photos: 0, videos: 2 });
  assert.strictEqual(shown[2].title, '2 new videos on Pixel', 'seen: counted from the start again');
  server.current = null;
  server.emit('closed', phone);
  connect(pixel()); // the same phone again is another session
  shown[2].emit('click');
  assert.deepStrictEqual(opened, ['media'], 'a notification from an earlier session opens nothing');
}

// ---- nothing may happen: off, not allowed, not the connected session, or a computer without it ----
{
  const count = { t: T.MEDIA_NEW, photos: 3, videos: 1 };
  const full = { perm: 'ok', remove: true, alerts: true };

  // Never switched on here: the phone isn't asked, and what it sends anyway is dropped.
  let s = setup({ hub: { mediaAlerts: false } });
  let phone = s.connect(pixel());
  assert.ok(!('mediaAlerts' in s.server.sent.find((m) => m.t === T.HUB_POLICY)), 'hub.policy is what it was before');
  s.state(phone, full);
  s.from(phone, count);
  // Photos itself off, with the option left on from before.
  s.settings.hub.mediaAlerts = true;
  s.settings.hub.media = false;
  s.phoneHub.policy();
  assert.ok(!('mediaAlerts' in s.server.sent[s.server.sent.length - 1]));
  s.from(phone, count);
  assert.strictEqual(s.shown.length, 0);

  // On, but: the permission not there (or taken back), only chosen photos, a phone app that doesn't
  // say it does this, a count that isn't one.
  s = setup();
  phone = s.connect(pixel());
  s.from(phone, count); // before the phone said what's allowed
  for (const media of [{ perm: 'ask', alerts: true }, { perm: 'partial', alerts: true }, { perm: 'ok', remove: true }]) {
    s.state(phone, media);
    s.from(phone, count);
  }
  s.state(phone, full);
  for (const bad of [{}, { photos: 0, videos: 0 }, { photos: -4 }, { photos: '7' }, { photos: 1.5 }]) s.from(phone, { t: T.MEDIA_NEW, ...bad });
  // Not the session connected now: another device's socket, a computer, and the phone after it left.
  s.from({ os: P.OS.ANDROID, name: 'Other', deviceId: 'b2' }, count);
  s.server.current = null;
  s.server.emit('closed', phone);
  s.from(phone, count);
  const pc = s.connect({ os: P.OS.WIN, name: 'PC', deviceId: 'c3' });
  s.from(pc, count);
  assert.strictEqual(s.shown.length, 0);

  // A computer that shows none (Windows and Linux today): no switch, the option can't be set, the
  // phone is never asked, and media.new is dropped.
  s = setup({ alerts: false, hub: { mediaAlerts: false } });
  phone = s.connect(pixel());
  s.phoneHub.act({ do: 'opt', mediaAlerts: true });
  assert.strictEqual(s.settings.hub.mediaAlerts, false);
  assert.strictEqual(s.phoneHub.view.canMediaAlerts, false);
  assert.ok(s.server.sent.filter((m) => m.t === T.HUB_POLICY).every((m) => !('mediaAlerts' in m)));
  s.state(phone, full);
  s.from(phone, count);
  assert.strictEqual(s.shown.length, 0);
}

// Mesh creates fresh views for every delivery; only the authenticated session may notify.
{
  const sessions = new Map();
  const socket = {};
  const session = { id: 'mesh-phone', connected: true, hostUp: true, peerOs: P.OS.ANDROID,
    role: 'guest', transport: 'ip', status: {}, ctx: { ws: socket }, displayName: () => 'Phone', send: () => true };
  sessions.set(session.id, session);
  const route = new Route({ sessions }, () => session.id);
  const peer = new Peer(route), shown = [];
  const settings = { hub: { media: true, mediaAlerts: true } };
  const hub = new PhoneHub({ server: peer, getSettings: () => settings, save() {}, mediaAlert: a => shown.push(a) });
  route.refresh();
  route.deliver({ t: T.HUB_STATE, media: { perm: 'ok', alerts: true } });
  const old = peer.current;
  route.deliver({ t: T.MEDIA_NEW, photos: 1 });
  assert.equal(shown.length, 1, 'mesh route accepts the live authenticated session');
  assert.equal(shown[0].current(), true);
  session.ctx = { ws: {} }; // the same device reconnected on a different socket
  assert.equal(shown[0].current(), false, 'old notification cannot open after socket replacement');
  hub.onMediaNew({ photos: 1 }, old);
  assert.equal(shown.length, 1, 'old socket cannot send an alert');
}

console.log('photo-alerts: counts only to the notification, and none when off, not allowed or from another session');
