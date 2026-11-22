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

const { attach, IDLE_MS } = require('../win-idle.js');

class Win extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.visible = true;
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
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
});
