// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac control window behind other windows stops its ambient animations (shared/ui-away.js,
// shared/ui-away.css). The class follows the window's focus, and every endless animation in the
// stylesheets the window loads is either paused by ui-away.css or named here as work in progress.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const { watch } = require('../ui-away.js');

// The class follows focus: on when the window opens unfocused, off on focus, on again on blur.
{
  const on = {};
  const cls = new Set();
  const win = { addEventListener: (k, f) => { on[k] = f; } };
  const doc = { hasFocus: () => false, documentElement: { classList: { toggle: (c, v) => { if (v) cls.add(c); else cls.delete(c); } } } };
  watch(win, doc);
  assert.ok(cls.has('td-away'), 'a window opened behind another starts away');
  on.focus();
  assert.ok(!cls.has('td-away'), 'focused: the animations run');
  on.blur();
  assert.ok(cls.has('td-away'), 'behind again: paused');
  const cls2 = new Set();
  watch({ addEventListener() {} }, { hasFocus: () => true, documentElement: { classList: { toggle: (c, v) => { if (v) cls2.add(c); else cls2.delete(c); } } } });
  assert.ok(!cls2.has('td-away'), 'a window opened in front starts with its animations running');
}

// Work in progress keeps moving behind other windows: a still spinner reads as a hang.
const WORK = ['.spin', '.ios-spin', '.npop-live.ind .npop-fill'];

const page = fs.readFileSync(path.join(root, 'mac/control.html'), 'utf8');
assert.ok(/<script src="\.\.\/shared\/ui-away\.js"><\/script>/.test(page), 'the control window loads ui-away.js');
const sheets = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
assert.ok(sheets.includes('../shared/ui-away.css'), 'the control window loads ui-away.css');

const away = fs.readFileSync(path.join(root, 'shared/ui-away.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const paused = away.slice(0, away.indexOf('{')).split(',').map((s) => s.trim().replace(/^\.td-away /, ''));
assert.ok(/animation-play-state: paused !important/.test(away));

let endless = 0;
for (const href of sheets) {
  if (href.endsWith('ui-away.css')) continue;
  const css = fs.readFileSync(path.join(root, 'mac', href), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*animation:[^;}]*infinite[^{}]*)\}/g)) {
    for (const sel of m[1].split(',').map((s) => s.trim())) {
      endless++;
      const known = paused.some((p) => sel.endsWith(p)) || WORK.some((w) => sel.endsWith(w));
      assert.ok(known, `${href}: "${sel}" animates without end; pause it in shared/ui-away.css or name it as work in progress here`);
    }
  }
}
assert.ok(endless >= 15, `found only ${endless} endless animations: the stylesheet reading broke`);
console.log('ui-away: ok');
