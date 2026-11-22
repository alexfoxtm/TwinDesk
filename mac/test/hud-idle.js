// A linked session does not keep the popup window. The window is made for a show and
// destroyed IDLE_MS after it hides. Run: node mac/test/hud-idle.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const timers = [];
let now = 0;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = (fn, ms) => {
  const t = { fn, at: now + (ms || 0) };
  timers.push(t);
  return t;
};
global.clearTimeout = (t) => {
  const i = timers.indexOf(t);
  if (i >= 0) timers.splice(i, 1);
};
function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = null;
    for (const t of timers) if (t.at <= end && (!next || t.at < next.at)) next = t;
    if (!next) break;
    now = next.at;
    timers.splice(timers.indexOf(next), 1);
    next.fn();
  }
  now = end;
}

const windows = [];
class BrowserWindow {
  constructor() {
    this.destroyed = false;
    this.visible = false;
    this.webContents = { send() {} };
    windows.push(this);
  }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; this.visible = false; }
  setBounds() {}
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setContentProtection() {}
}
const electron = {
  app: { getLocale: () => 'en' },
  BrowserWindow,
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1400, height: 900 } }),
  },
};
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') return electron;
  return realRequire.apply(this, arguments);
};
const { Hud } = require('../hud.js');

function wire() {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('hud = new Hud');
  const end = main.indexOf("svc.kvm.on('where'", start);
  assert.ok(start > 0 && end > start, 'popup wiring in mac/main.js');
  const peer = new EventEmitter();
  peer.current = null;
  const box = { peer, settings: { app: { hud: true } }, Hud };
  vm.runInNewContext(main.slice(start, end), box);
  return { peer, hud: box.hud };
}

test('a linked phone does not keep the popup window, and a shown one is dropped after idle', async () => {
  const { peer, hud } = wire();
  peer.current = { name: 'Phone' };
  peer.emit('client');
  assert.equal(hud.win, null, 'connecting does not create the popup window');
  assert.equal(hud.keep(), false, 'a session alone does not pin the window');

  await hud.show('home', { key: 'Back on {me}', vars: { me: 'Mac' } });
  assert.equal(hud.win && hud.win.isVisible(), true);
  advance(1400 + 400);
  assert.equal(hud.win.isVisible(), false, 'the popup hides itself');
  assert.ok(hud.win && !hud.win.isDestroyed(), 'it stays through the idle wait so the next popup is quick');
  advance(30000);
  assert.equal(hud.win, null, 'after idle the renderer is gone even though the phone is still linked');
  assert.equal(windows.at(-1).destroyed, true);
});

test('keep() still holds the window when a popup is about to show', async () => {
  const hud = new Hud(() => ({ app: { hud: true } }));
  hud.keep = () => true;
  await hud.show('home', 'hi');
  advance(1400 + 400);
  assert.equal(hud.win.isVisible(), false);
  advance(30000);
  assert.ok(hud.win && !hud.win.isDestroyed(), 'an explicit keep is the only pin');
});

process.on('exit', () => {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
});
