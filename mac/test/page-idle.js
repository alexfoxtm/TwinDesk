// The page being shown is built before the others. Search (and the same hook the
// deep link, the tour and the keyboard use) builds the rest immediately.
// Run: node mac/test/page-idle.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createQueue } = require('../page-idle.js');

test('the shown page is built first, idle builds the rest, and search forces every page', () => {
  const built = [];
  const q = createQueue((id) => built.push(id));
  for (const id of ['overview', 'connection', 'files', 'general']) q.add(id);
  assert.equal(q.ensure('files'), true, 'the saved tab');
  assert.deepEqual(built, ['files']);
  assert.deepEqual(q.pending(), ['overview', 'connection', 'general']);
  const turns = [];
  q.schedule((step) => turns.push(step));
  assert.equal(turns.length, 1, 'the rest wait for an idle turn');
  turns[0]();
  assert.deepEqual(built, ['files', 'overview'], 'one page per idle turn');
  assert.deepEqual(q.ensureAll(), ['connection', 'general'], 'search builds whatever is left');
  assert.deepEqual(built, ['files', 'overview', 'connection', 'general']);
  const n = built.length;
  turns.at(-1)();
  assert.equal(built.length, n, 'a late idle turn does not build again');
  assert.equal(q.ensure('files'), false);
  assert.deepEqual(q.ensureAll(), []);
});

test('the window wires that order, and search, go, the tour and the keyboard force every page', () => {
  const root = path.join(__dirname, '..', '..');
  const start = fs.readFileSync(path.join(root, 'mac/ui-start.js'), 'utf8');
  const search = fs.readFileSync(path.join(root, 'shared/ui-search.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'mac/control.html'), 'utf8');
  assert.match(html, /<script src="page-idle\.js"><\/script>\s*<script src="ui-start\.js"><\/script>/);
  assert.match(start, /window\.PageIdle\.createQueue/);
  assert.match(start, /requestIdleCallback/);
  assert.match(start, /UI\.ensureAllBuilt = ensureAllBuilt/);
  assert.match(start, /pageQueue\.ensure\(/, 'show builds the page it is about to open');
  assert.match(search, /if \(UI\.ensureAllBuilt\) UI\.ensureAllBuilt\(\)/, 'search is inert where ensureAllBuilt is absent');
  assert.match(start, /macshare-go[\s\S]{0,120}ensureAllBuilt\(\)/, 'deep links and the tour (UI.go) build every page first');
  assert.match(start, /api\.onGo\([\s\S]{0,280}ensureAllBuilt\(\)/);
  assert.match(start, /ArrowDown[\s\S]{0,240}ensureAllBuilt\(\)/);
  assert.match(start, /new URLSearchParams\(location\.search\)/);
  assert.match(start, /pageQueue\.ensure\([\s\S]{0,500}requestIdleCallback/, 'the shown page is built before the idle queue starts');
  const main = fs.readFileSync(path.join(root, 'mac/main.js'), 'utf8');
  assert.match(main, /tab: \(settings\.ui && settings\.ui\.tab\) \|\| ''/, 'the saved tab is the page built first');
  const go = main.slice(main.indexOf('function goTab'), main.indexOf("app.on('second-instance'"));
  assert.match(go, /const hidden = !!\(win && !win\.isDestroyed\(\) && !win\.isVisible\(\)\)/);
  assert.match(go, /if \(hidden\) win\.webContents\.send\('go', tab\)/);
  assert.match(go, /if \(!hidden && win && !win\.isDestroyed\(\)\) win\.webContents\.send\('go', tab\)/, 'a hidden window is not sent go twice');
});
