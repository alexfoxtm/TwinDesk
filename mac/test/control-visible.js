// A lost visibility report must not leave an on-screen settings window without
// state. The page reports visibilitychange, the main process ignores a foreign
// sender, restore still asks once, and focus clears a flag stuck on hidden.
// Run: node --test mac/test/control-visible.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createWatch } = require('../win-watch.js');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../ui-start.js'), 'utf8');

function windowOnScreen() {
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 'ours' } };
}

function loadListeners() {
  const start = main.indexOf("w.on('show'");
  const end = main.indexOf("w.on('closed'", start);
  assert.ok(start > 0 && end > start, 'show/restore/focus listeners');
  const w = new EventEmitter();
  const watch = createWatch();
  const win = windowOnScreen();
  const pushes = [];
  vm.runInNewContext(main.slice(start, end), {
    w,
    dockIcon() {},
    controlWatch: watch,
    refreshPermissions() {},
    noteControlVisible(visible) {
      if (watch.note(win, visible)) pushes.push(visible);
    },
  });
  return { w, watch, win, pushes };
}

test('the page reports visibilitychange, and a hidden page does not paint', () => {
  const start = ui.indexOf('if (api.pageVisible)');
  const end = ui.indexOf("$('pair-allow')", start);
  assert.ok(start > 0 && end > start, 'reportVis in ui-start.js');
  const events = {};
  let vis = 'visible';
  const reported = [];
  const rendered = [];
  vm.runInNewContext(ui.slice(start, end), {
    api: { pageVisible(v) { reported.push(v); } },
    document: {
      get visibilityState() { return vis; },
      addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    },
    UI: { state: { n: 1 } },
    render(s) { rendered.push(s); },
  });
  assert.deepEqual(reported, [true], 'the page reports visible when it loads');
  assert.equal(rendered.length, 1, 'a visible page paints the state it already has');
  assert.ok(events.visibilitychange && events.visibilitychange.length === 1, 'visibilitychange is reported');
  vis = 'hidden';
  events.visibilitychange[0]();
  assert.deepEqual(reported, [true, false]);
  assert.equal(rendered.length, 1, 'a hidden page does not paint');
  vis = 'visible';
  events.visibilitychange[0]();
  assert.deepEqual(reported, [true, false, true]);
  assert.equal(rendered.length, 2, 'becoming visible paints the stored state');
});

test('a foreign sender cannot mark the page hidden, and this window can', () => {
  const start = main.indexOf("require('electron').ipcMain.on('control-visible'");
  const end = main.indexOf('function showWindow()', start);
  assert.ok(start > 0 && end > start, 'control-visible handler');
  const handlers = {};
  const watch = createWatch();
  const win = windowOnScreen();
  const pushes = [];
  vm.runInNewContext(main.slice(start, end), {
    require(id) {
      if (id === 'electron') return { ipcMain: { on(ch, fn) { handlers[ch] = fn; } } };
      throw new Error('unexpected require ' + id);
    },
    get win() { return win; },
    noteControlVisible(visible) {
      if (watch.note(win, visible)) pushes.push(visible);
    },
  });
  const fn = handlers['control-visible'];
  assert.equal(typeof fn, 'function');
  fn({ sender: { id: 'other' } }, false);
  assert.equal(watch.watching(win), true, 'a foreign hidden report is ignored');
  assert.deepEqual(pushes, []);
  fn({ sender: win.webContents }, false);
  assert.equal(watch.watching(win), false, 'this window reporting hidden stops the push');
  fn({ sender: win.webContents }, true);
  assert.equal(watch.watching(win), true);
  assert.deepEqual(pushes, [true], 'hidden to visible is one push');
  fn({ sender: win.webContents }, true);
  assert.deepEqual(pushes, [true], 'a repeat visible report does not push again');
});

test('restore asks once when the page has not reported, and does not clear a covered page', () => {
  const { w, watch, win, pushes } = loadListeners();
  watch.unsee();
  w.emit('restore');
  assert.deepEqual(pushes, [null], 'restore of an unreported page asks for one push');
  assert.equal(watch.watching(win), true);
  w.emit('restore');
  assert.deepEqual(pushes, [null], 'a second restore does not push again');

  const covered = loadListeners();
  covered.watch.note(covered.win, false);
  covered.w.emit('restore');
  assert.equal(covered.watch.watching(covered.win), false, 'restore does not treat a covered window as on screen');
  assert.deepEqual(covered.pushes, []);
});

test('focus clears a hidden flag that got stuck while the window is on screen', () => {
  const { w, watch, win, pushes } = loadListeners();
  watch.note(win, false);
  assert.equal(watch.watching(win), false);
  w.emit('focus');
  assert.equal(watch.watching(win), true, 'a focused window is on screen');
  assert.deepEqual(pushes, [true], 'the window gets the push the lost visibilitychange did not send');
  w.emit('focus');
  assert.deepEqual(pushes, [true], 'focus again does not push');
});
