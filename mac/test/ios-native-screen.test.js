// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');
const { PhonePreviews } = require('../phone-preview.js');
const { test, after } = require('node:test');
const P = require('../../shared/protocol.js');
const { NativeScreen } = require('../../shared/nativescreen.js');

const ipcMain = new EventEmitter();
class Window extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bounds = { x: 1180, y: 105, width: options.width, height: options.height };
    this.resizes = [];
    this.webContents = new EventEmitter();
  }
  loadFile(_file, options) { this.query = options.query; }
  isDestroyed() { return !!this.destroyed; }
  isVisible() { return !!this.visible; }
  isAlwaysOnTop() { return false; }
  isNormal() { return true; }
  getBounds() { return this.bounds; }
  getContentBounds() { return { ...this.bounds, width: this.bounds.width - 4, height: this.bounds.height - 16 }; }
  getMinimumSize() { return [this.options.minWidth, this.options.minHeight]; }
  setAspectRatio(ratio, extra) { this.aspect = { ratio, extra }; }
  setBounds(bounds) { this.bounds = bounds; this.resizes.push(bounds); }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  close() { this.destroyed = true; this.emit('closed'); }
}
const app = Object.assign(new EventEmitter(), { getLocale: () => 'en' });
const workArea = { x: 1000, y: 90, width: 735, height: 690 };
const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 900 } }),
  getDisplayMatching: () => ({ workArea }),
};
const realLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app, screen, ipcMain, BrowserWindow: Window };
  if (name === './iosusb.js') return { list: async () => [] };
  return realLoad.call(this, name, ...args);
};
const viewsFor = [require('../phoneview.js'), require('../../windows/phoneview.js'), require('../../linux/phoneview.js')];
after(() => { Module._load = realLoad; });

const tick = () => new Promise((resolve) => setImmediate(resolve));
const mirror = `t:${P.T.PHONE_MIRROR}`;
function fixture({ platform = 0, mesh = false, os = 'ios', autoRotate = true, control = false } = {}) {
  ipcMain.removeAllListeners();
  NativeScreen.airplay = () => ''; // no platform probes / opening System Settings
  const peer = (id) => ({ deviceId: id, os, authed: true, name: id, transport: 'ip', conn: control ? { readyState: 1 } : {} });
  let current = peer('tablet');
  const server = new EventEmitter();
  Object.defineProperty(server, 'current', { get: () => mesh ? { ...current } : current });
  if (mesh) server.route = { session: { hostUp: true, ctx: current } };
  const wire = [];
  server.sendToClient = (msg) => { wire.push({ msg, to: current.deviceId }); return true; };
  const bridge = Object.assign(new EventEmitter(), {
    views: null, _tellPhone() {}, _sound() {}, mirrorVia: 'native', sessionOpts: () => ({}),
  });
  const phone = Object.assign(new EventEmitter(), { info: { platform: 'ipados' }, infoId: 'tablet' });
  const pairing = Object.assign(new EventEmitter(), { paired: [{ id: 'tablet', os }] });
  if (control) pairing.list = () => pairing.paired;
  phone.pairing = pairing;
  pairing.previews = new PhonePreviews(pairing);
  pairing.previews.authorize(current, pairing.paired[0]);
  const { PhoneViews } = viewsFor[platform];
  const views = new PhoneViews({ server, bridge, phone, getSettings: () => ({ phone: { autoRotate } }) });
  const open = () => server.emit(mirror, { open: true }, server.current);
  return {
    server, phone, views, open, wire, current: () => [...views.views.values()][0],
    offers: () => wire.filter(({ msg }) => msg.on && !msg.sync),
    click: (v) => ipcMain.emit('phoneview:in', { sender: v.win.webContents }, { t: 'retryIpad' }),
    state: (v, m) => NativeScreen.state({ key: v.session.secret, ...m }, server),
    preview: (sender, m) => ipcMain.emit('phoneview:in', { sender }, { t: 'mirrorPreview', ...m }),
    retire() {
      if (mesh) current.conn = null;
      else current.released = true;
    },
    replace(id) {
      current = peer(id);
      if (mesh) server.route.session.ctx = current;
    },
  };
}

test('dead iOS screens ask again, while an active window only takes focus', async () => {
  for (const options of [{}, { mesh: true }, { platform: 1 }, { platform: 2 }]) {
    const f = fixture(options);
    try {
      f.open();
      await tick();
      const first = f.current();
      f.views.openScreen();
      await tick();
      assert.equal(f.offers().length, 1);
      assert.equal(first.win.focused, true);
      f.state(first, { on: false, error: 'Declined' });
      await tick();
      f.open(); // production iOS notification, including when started from Control Center
      await tick();
      assert.equal(f.offers().length, 2);
      assert.equal(first.win.isDestroyed(), true);
      const next = f.current();
      assert.notEqual(next.session.secret, first.session.secret);
      if (options.platform) {
        NativeScreen.state({ key: first.session.secret, on: false, error: 'stale' });
        assert.equal(next.session.closed, false, 'a retired screen key cannot close the new viewer');
      }
      if (!options.platform) {
        f.server.emit(mirror, { open: false }, f.server.current); // legacy tail of the previous generation
        assert.equal(f.views.views.size, 1);
      }
    } finally { f.views.closeAll(); }
  }
});

test('a retiring iOS connection cannot fall through to an unowned native screen', async () => {
  for (const mesh of [false, true]) {
    const f = fixture({ mesh });
    try {
      f.open();
      await tick();
      const first = f.current();
      f.retire();
      f.views.openScreen();
      await tick();
      assert.equal(first.win.isDestroyed(), true);
      assert.equal(f.views.views.size, 0);
      assert.equal(f.offers().length, 1);
    } finally { f.views.closeAll(); }
  }
});

test('Ask iPad again uses only the failed window and its exact authenticated owner', async () => {
  const f = fixture({ mesh: true });
  try {
    f.open();
    await tick();
    const first = f.current();
    f.state(first, { on: false, error: 'Declined' });
    await tick();
    assert.equal(first.queue.at(-1)[1].retryIpad, true);
    f.click(first);
    const second = f.current();
    assert.notEqual(second, first);
    f.click(first); // destroyed sender
    f.click(second); // waiting
    NativeScreen.state({ key: first.session.secret, on: false, error: 'stale' }, f.server);
    assert.equal(second.session.closed, false);
    assert.equal(f.offers().length, 2);
    f.state(second, { on: false, error: 'Declined' });
    await tick();
    f.replace('replacement');
    f.click(second);
    assert.equal(f.offers().length, 2);
    f.views.openScreen();
    assert.equal(f.offers().at(-1).to, 'replacement');
    f.views.close(f.current().id);
    assert.equal(f.wire.at(-1).msg.on, false);
    assert.equal(f.wire.at(-1).to, 'replacement');
  } finally { f.views.closeAll(); }
});

test('the iPad window fits ReplayKit size, then packet orientation, without moving on equal aspect', async () => {
  const f = fixture({ autoRotate: false });
  f.phone.info = null;
  try {
    f.open();
    await tick();
    const v = f.current();
    assert.equal(v.win.options.width, Math.round((v.win.options.height - 32) * 3 / 4));
    f.state(v, { on: true, w: '900', h: 0, sw: -1, sh: 200 });
    assert.equal(v.win.resizes.length, 0);
    f.state(v, { on: true, w: 900, h: 1200, sw: 1536, sh: 2048 });
    assert.equal(v.win.resizes.length, 1);
    assert.equal(v.win.bounds.height, workArea.height, 'outer frame is clamped to the window display');
    assert.deepEqual(v.win.aspect, { ratio: 3 / 4, extra: { width: 0, height: 32 } });
    const req = new EventEmitter();
    req.destroy = () => {};
    req.method = 'POST';
    req.url = '/twindesk/mirror';
    req.headers = { 'x-twindesk-mirror': v.session.secret };
    const res = { writeHead(code) { assert.equal(code, 200); }, end() {} };
    assert.equal(NativeScreen.request(req, res), true);
    const sizePacket = (w, h) => {
      const packet = Buffer.alloc(12);
      packet[0] = 0x80;
      packet.writeUInt32BE(w, 4);
      packet.writeUInt32BE(h, 8);
      req.emit('data', packet);
    };
    sizePacket(1200, 900);
    assert.equal(v.win.resizes.length, 2);
    assert.equal(v.win.aspect.ratio, 4 / 3);
    const b = v.win.bounds;
    assert.equal(b.width, 646, 'rotation keeps the long side of the video');
    assert.ok(b.x >= workArea.x && b.x + b.width <= workArea.x + workArea.width);
    assert.ok(b.y >= workArea.y && b.y + b.height <= workArea.y + workArea.height);
    assert.ok(Math.abs((b.width - 4) / (b.height - 48) - 4 / 3) < 0.01);
    f.state(v, { on: true, w: 900, h: 1200, sw: 1536, sh: 2048 });
    sizePacket(800, 600);
    sizePacket(50000, 1);
    assert.equal(v.win.resizes.length, 2, 'no resize for late state, same ratio, or invalid packet');
  } finally { f.views.closeAll(); }
});

test('a paired iPad snapshot reaches the oriented card, stays after Stop and clears on identity removal', async () => {
  const f = fixture({ mesh: true });
  const previews = f.phone.pairing.previews;
  try {
    f.open();
    const v = f.current();
    assert.equal(v.win.query.screenOS, 'ios');
    assert.equal(v.queue[0][1].mirrorPreview, v.id);
    f.state(v, { on: true, w: 1200, h: 900, sw: 2048, sh: 1536 });
    await tick();
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/twindesk/mirror',
      headers: { 'x-twindesk-mirror': v.session.secret }, destroy() {} });
    NativeScreen.request(req, { writeHead() {}, end() {} });
    const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
    const capture = { capture: v.id, jpeg };
    f.preview(new EventEmitter(), capture);
    f.preview(v.win.webContents, { ...capture, capture: v.id + 1 });
    assert.deepEqual(previews.list(), []);
    f.preview(v.win.webContents, capture);
    f.preview(v.win.webContents, { ...capture, jpeg: 'data:image/jpeg;base64,/9j/1Q==' });
    assert.equal(previews.list(true)[0].data, jpeg, 'main rate limit preserves the first snapshot');
    f.views.close(v.id);
    assert.equal(previews.list(true)[0].data, jpeg, 'Stop keeps the last snapshot');

    const UI = { phoneAssets: { iosPreviews: previews.list(true) } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../../shared/ui-device-parts.js'), 'utf8'), { UI, window: {} });
    const classes = new Set();
    const style = new Map();
    const card = {
      classList: { add: (k) => classes.add(k), toggle: (k, on) => on ? classes.add(k) : classes.delete(k) },
      style: { setProperty: (k, v) => style.set(k, v), removeProperty: (k) => style.delete(k) },
    };
    const D = UI.deviceParts;
    const info = f.phone.info;
    D.phonePic(card, info, D.iosPreview({ iosPreviews: previews.list() }, 'tablet'));
    assert.ok(classes.has('ios-frame') && classes.has('has-preview'));
    assert.equal(style.get('--ios-width'), '140px');
    assert.equal(style.get('--ios-height'), '105px');
    assert.equal(style.get('--phone-wall'), `url("${jpeg}")`);
    assert.equal(D.iosPreview({ iosPreviews: previews.list() }, 'other-tablet'), null);

    // Replace the pairing record while the UI still holds the old reply.
    f.phone.pairing.paired = [{ id: 'tablet', os: 'ios' }];
    f.phone.pairing.emit('change');
    assert.deepEqual(previews.list(true), []);
    f.open();
    assert.equal(f.current().queue[0][1].mirrorPreview, null, 'old authentication cannot fill the new record');
    D.phonePic(card, info, D.iosPreview({ iosPreviews: previews.list() }, 'tablet'));
    assert.ok(classes.has('ios-frame') && !classes.has('has-preview'));
    assert.equal(style.get('--ios-width'), '105px');
    assert.equal(style.get('--ios-height'), '140px');
    assert.equal(style.has('--phone-wall'), false);
  } finally { f.views.closeAll(); }
});

test('the paired viewer keeps ReplayKit retry, preview and sizing on the exact owner', async () => {
  const f = fixture({ mesh: true, control: true });
  try {
    f.open();
    const v = f.current();
    const owner = f.server.current;
    const state = { key: v.session.secret, on: true, w: 1200, h: 900, sw: 2048, sh: 1536 };
    const mirrorState = `t:${P.T.PHONE_MIRROR_STATE}`;
    assert.equal(v.win.query.screenOS, 'ios');
    assert.equal(v.win.webContents.listenerCount('before-input-event'), 0);
    assert.equal(v.ipadOwner.socket, owner.conn);
    assert.equal(v.queue[0][1].mirrorPreview, v.id);
    f.server.emit(mirrorState, state, { ...owner, conn: { readyState: 1 } });
    assert.equal(v.ipadGeometry, undefined);
    f.server.emit(mirrorState, state, owner);
    assert.deepEqual(v.ipadGeometry, { w: 2048, h: 1536 });
    f.state(v, state);
    await tick();
    assert.deepEqual(v.win.aspect, { ratio: 4 / 3, extra: { width: 0, height: 32 } });
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/twindesk/mirror',
      headers: { 'x-twindesk-mirror': v.session.secret }, destroy() {} });
    NativeScreen.request(req, { writeHead() {}, end() {} });
    f.preview(v.win.webContents, { capture: v.id, jpeg: 'data:image/jpeg;base64,/9j/2Q==' });
    assert.equal(f.phone.pairing.previews.list(true).length, 1);
    const abort = new AbortController();
    v.ipadLease = { abort, stream: req, closed() {} };
    f.state(v, { on: false });
    assert.equal(abort.signal.aborted, true);
    assert.equal(v.ipadLease, null);
    f.click(v);
    assert.notEqual(f.current(), v);
    assert.equal(f.current().ipadOwner.socket, owner.conn);
    assert.equal(f.current().ipadLease, undefined);
    assert.equal(f.offers().length, 2);
  } finally { f.views.closeAll(); }
});
