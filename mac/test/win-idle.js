// Closing the settings window hides it. It is destroyed IDLE_MS later unless it was
// opened again, and Quit is allowed to close it. Run: node mac/test/win-idle.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const timers = [];
let now = 0;
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

const { attach, IDLE_MS, LEAVE_FULLSCREEN_MS } = require('../win-idle.js');

class Win extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.visible = true;
    this.full = false;
    this.fullAsked = null; // setFullScreen does not clear this.full: the timeout must see a stuck full screen
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  isFullScreen() { return this.full === true; }
  setFullScreen(v) { this.fullAsked = v; }
  hide() { this.visible = false; this.emit('hide'); }
  show() { this.visible = true; this.emit('show'); }
  focus() {}
  destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
}

function close(win) {
  let prevented = false;
  win.emit('close', { preventDefault() { prevented = true; } });
  return prevented;
}

test('the idle wait is five minutes', () => {
  assert.equal(IDLE_MS, 5 * 60 * 1000);
});

test('close hides the window, a re-open inside the idle time reuses it, and the idle time destroys it', () => {
  const dead = [];
  let quitting = false;
  const win = new Win();
  attach(win, { quitting: () => quitting, onDead: (w) => { dead.push(w); w.destroy(); } });

  assert.equal(close(win), true);
  assert.equal(win.isVisible(), false);
  assert.equal(win.destroyed, false, 'close does not destroy it');
  advance(IDLE_MS - 1);
  assert.equal(dead.length, 0, 'one millisecond early it is still the same window');
  assert.equal(win.destroyed, false);

  win.show(); // opened again: the same BrowserWindow
  assert.equal(win.isVisible(), true);
  advance(IDLE_MS);
  assert.equal(dead.length, 0, 'the re-open cancelled the destroy');
  assert.equal(win.destroyed, false);

  assert.equal(close(win), true);
  advance(IDLE_MS - 1);
  assert.equal(win.destroyed, false);
  advance(1);
  assert.deepEqual(dead, [win]);
  assert.equal(win.destroyed, true);

  quitting = true;
  const other = new Win();
  attach(other, { quitting: () => quitting, onDead: () => { throw new Error('quit must not hide the window'); } });
  assert.equal(close(other), false, 'Quit is not cancelled');
  assert.equal(other.isVisible(), true, 'Quit closes it the ordinary way');
  advance(IDLE_MS);
});

test('main keeps a hidden settings window and destroys it from the idle helper', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /require\('\.\/win-idle'\)/);
  assert.match(main, /attachIdle\(w,/);
  assert.match(main, /quitting:\s*\(\)\s*=>\s*quitting/);
  assert.match(main, /if \(!win \|\| win\.isDestroyed\(\)\) createWindow\(\)/, 'opening again reuses the hidden window');
  assert.match(main, /w\.on\('hide', \(\) => \{ dockIcon\(\); controlWatch\.unsee\(\); \}\)/);
  assert.doesNotMatch(main, /w\.on\('hide'[\s\S]{0,120}win = null/, 'hide leaves the window to be shown again');
  const show = main.slice(main.indexOf('function showWindow'), main.indexOf('function showUpdateWindow'));
  const holdAt = show.indexOf('idleCtl.hold()');
  assert.ok(holdAt >= 0 && holdAt < show.indexOf('win.show()'), 'opening again cancels a close that is still leaving full screen');
});

function attached() {
  const dead = [];
  let quitting = false;
  const win = new Win();
  const ctl = attach(win, { quitting: () => quitting, onDead: (w) => { dead.push(w); w.destroy(); } });
  return { dead, win, ctl, setQuitting(v) { quitting = v; } };
}

test('close in full screen leaves full screen before it hides, and the reopen is not full screen', () => {
  const { dead, win } = attached();
  win.full = true; // this Space, or a full-screen window on another Space: isFullScreen is still true
  assert.equal(close(win), true);
  assert.equal(win.fullAsked, false, 'close asks to leave full screen');
  assert.equal(win.isVisible(), true, 'it stays up until full screen has finished');
  assert.equal(win.destroyed, false);
  advance(LEAVE_FULLSCREEN_MS - 1);
  assert.equal(dead.length, 0, 'the five minutes have not started, and the bound has not run');
  assert.equal(win.isVisible(), true);
  win.full = false; // the OS finished leaving
  win.emit('leave-full-screen');
  assert.equal(win.isFullScreen(), false, 'it comes back not in full screen');
  assert.equal(win.isVisible(), false);
  assert.equal(win.destroyed, false);
  advance(IDLE_MS - 1);
  assert.equal(win.destroyed, false);
  advance(1);
  assert.deepEqual(dead, [win]);
});

test('a missing leave-full-screen destroys a window that is still full screen', () => {
  const { dead, win } = attached();
  win.full = true;
  close(win);
  advance(LEAVE_FULLSCREEN_MS - 1);
  assert.equal(win.destroyed, false, 'the bound has not run');
  assert.equal(win.isVisible(), true);
  advance(1);
  assert.deepEqual(dead, [win], 'still full screen: destroy it, which releases the Space');
  assert.equal(win.fullAsked, false);
});

test('a leave that finished without the event still hides, and the five minutes start then', () => {
  const { dead, win } = attached();
  win.full = true;
  close(win);
  win.full = false; // left full screen, the event never arrived
  advance(LEAVE_FULLSCREEN_MS);
  assert.equal(win.isVisible(), false);
  assert.equal(win.destroyed, false, 'it did leave, so the window is kept');
  advance(IDLE_MS - 1);
  assert.equal(dead.length, 0);
  advance(1);
  assert.deepEqual(dead, [win]);
});

test('showing the window while it is leaving full screen does not hide it afterwards', () => {
  const { dead, win, ctl } = attached();
  win.full = true;
  close(win);
  ctl.hold(); // menu bar, while the window is still on screen: show() may not emit show
  win.full = false;
  win.emit('leave-full-screen');
  assert.equal(win.isVisible(), true);
  assert.equal(win.destroyed, false);
  advance(IDLE_MS);
  assert.equal(dead.length, 0);

  const again = attached();
  again.win.full = true;
  close(again.win);
  again.win.show();
  again.win.full = false;
  again.win.emit('leave-full-screen');
  assert.equal(again.win.isVisible(), true);
  advance(IDLE_MS);
  assert.equal(again.dead.length, 0);
});

test('minimized, or on another Space that is not full screen, still hides at once', () => {
  const mini = attached();
  mini.win.visible = false; // minimized: not full screen
  assert.equal(close(mini.win), true);
  assert.equal(mini.win.fullAsked, null, 'minimized does not leave full screen');
  assert.equal(mini.win.destroyed, false);
  advance(IDLE_MS);
  assert.deepEqual(mini.dead, [mini.win]);

  const space = attached();
  space.win.full = false;
  space.win.visible = true;
  assert.equal(close(space.win), true);
  assert.equal(space.win.isVisible(), false, 'another Space that is not full screen hides now');
  assert.equal(space.win.destroyed, false);
});

test('quit while leaving full screen is not cancelled and does not hide later', () => {
  const { win, setQuitting } = attached();
  win.full = true;
  assert.equal(close(win), true);
  setQuitting(true);
  assert.equal(close(win), false, 'Quit is not cancelled');
  win.full = false;
  win.emit('leave-full-screen');
  assert.equal(win.isVisible(), true, 'the late leave does not hide a window Quit is closing');
  assert.equal(win.destroyed, false);
});
