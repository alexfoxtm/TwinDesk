// Glass makes the settings window opaque, in the same base colour the page paints.
// Simple stays transparent so the sidebar vibrancy shows. Run: node mac/test/win-chrome.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('the window is opaque for Glass and transparent for Simple, including a live switch', () => {
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'mac/main.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'shared/ui-glass.css'), 'utf8');
  assert.match(css, /--base: #f2f2f5/);
  assert.match(css, /--base: #18181c/);
  assert.match(main, /backgroundColor: glass \? \(dark \? '#18181c' : '#f2f2f5'\) : '#00000000'/);
  assert.match(main, /win\.setVibrancy\(chrome\.vibrancy\)/);
  assert.match(main, /win\.setBackgroundColor\(chrome\.backgroundColor\)/);
  assert.match(main, /vibrancy: chrome\.vibrancy \|\| undefined/);
  assert.match(main, /nativeTheme\.on\('updated', \(\) => \{ applyLook\(\); pushState\(\); \}\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'mac/mesh/main.js'), 'utf8'), /setBackgroundColor\(chrome\.backgroundColor\)/);
});
