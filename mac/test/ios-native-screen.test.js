// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test, after } = require('node:test');
const P = require('../../shared/protocol.js');
const { NativeScreen } = require('../../shared/nativescreen.js');

const ipcMain = new EventEmitter();
class Window extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new EventEmitter();
  }
  loadFile(_file, options) { this.query = options.query; }
  isDestroyed() { return !!this.destroyed; }
  isVisible() { return !!this.visible; }
  isAlwaysOnTop() { return false; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  close() { this.destroyed = true; this.emit('closed'); }
}
const app = Object.assign(new EventEmitter(), { getLocale: () => 'en' });
const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 900 } }) };
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
function fixture({ platform = 0, mesh = false, os = 'ios' } = {}) {
  ipcMain.removeAllListeners();
  NativeScreen.airplay = () => ''; // no platform probes / opening System Settings
  const peer = (id) => ({ deviceId: id, os, authed: true, name: id, transport: 'ip', conn: {} });
  let current = peer('tablet');
  const server = new EventEmitter();
  Object.defineProperty(server, 'current', { get: () => mesh ? { ...current } : current });
  if (mesh) server.route = { session: { hostUp: true, ctx: current } };
  const wire = [];
  server.sendToClient = (msg) => { wire.push({ msg, to: current.deviceId }); return true; };
  const bridge = Object.assign(new EventEmitter(), {
    views: null, _tellPhone() {}, _sound() {}, mirrorVia: 'native', sessionOpts: () => ({}),
  });
  const phone = { info: { platform: 'ipados' } };
  const { PhoneViews } = viewsFor[platform];
  const views = new PhoneViews({ server, bridge, phone, getSettings: () => ({ phone: {} }) });
  const open = () => server.emit(mirror, { open: true }, server.current);
  return {
    server, phone, views, open, wire, current: () => [...views.views.values()][0],
    offers: () => wire.filter(({ msg }) => msg.on && !msg.sync),
    click: (v) => ipcMain.emit('phoneview:in', { sender: v.win.webContents }, { t: 'retryIpad' }),
    state: (v, m) => NativeScreen.state({ key: v.session.secret, ...m }, server),
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
      assert.notEqual(f.current().session.secret, first.session.secret);
      if (!options.platform) {
        f.server.emit(mirror, { open: false }, f.server.current); // legacy tail of the previous generation
        assert.equal(f.views.views.size, 1);
      }
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
