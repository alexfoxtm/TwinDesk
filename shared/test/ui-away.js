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

// Steady cues that used to repaint or reflow every frame, now transform and opacity only.
// The upstream rules stay (a later sheet replaces them) so a sync does not have to merge them.
const calm = fs.readFileSync(path.join(root, 'shared/ui-away.css'), 'utf8');
function frameBody(css, name) {
  const m = new RegExp('@keyframes\\s+' + name + '\\s*\\{').exec(css);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < css.length && depth) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(start, i - 1);
}
function props(body) {
  return [...body.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:/g)].map((x) => x[1]);
}
const frames = {};
for (const name of ['td-breathe', 'td-dash', 'td-travel']) frames[name] = frameBody(calm, name);
for (const [sel, name, timing] of [
  ['.dot.good::after', 'td-breathe', '2.8s ease-in-out infinite'],
  ['.hero-link:not(.up)::before', 'td-dash', '1.6s linear infinite'],
  ['.hero-link.up .hero-pulse', 'td-travel', '2.2s var(--ease) infinite'],
]) {
  const rule = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(calm);
  assert.ok(rule, `missing override ${sel}`);
  assert.ok(rule[1].includes(`animation: ${name} ${timing}`), `${sel} keeps the upstream timing`);
  assert.ok(frames[name], `missing @keyframes ${name}`);
  const used = props(';' + frames[name]);
  assert.ok(used.length > 0, `${name} has no declarations`);
  for (const p of used) assert.ok(p === 'transform' || p === 'opacity', `${name} animates ${p}, not only transform and opacity`);
}
assert.ok(paused.includes('.dot.good::after'), 'the dot ring pauses while the window is away');
assert.ok(paused.includes('.hero-link:not(.up)::before'), 'the connecting dashes pause while the window is away');
assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(calm) && /animation: none !important/.test(
  fs.readFileSync(path.join(root, 'mac/control.css'), 'utf8')), 'reduced motion still turns the cues off');
const breathe = fs.readFileSync(path.join(root, 'mac/control.css'), 'utf8');
assert.ok(/@keyframes breathe \{[^}]*box-shadow:/.test(breathe), 'upstream breathe stays put');
const pagesCss = fs.readFileSync(path.join(root, 'mac/control-pages.css'), 'utf8');
assert.ok(/@keyframes dash \{[^}]*background-position:/.test(pagesCss), 'upstream dash stays put');
assert.ok(/@keyframes travel \{[^}]*left:/.test(pagesCss), 'upstream travel stays put');
for (const other of ['windows/app.html', 'linux/app.html', 'mac/mesh/control.html', 'windows/mesh/app.html', 'linux/mesh/app.html']) {
  assert.ok(!fs.readFileSync(path.join(root, other), 'utf8').includes('ui-away.css'), `${other} does not load the Mac-only overrides`);
}

// Every other endless animation: already transform/opacity, work in progress, or not a steady
// screen (and said so). A new paint or layout loop has to be named here or converted above.
const LEFT = {
  breathe: 'replaced by td-breathe',
  dash: 'replaced by td-dash',
  travel: 'replaced by td-travel',
  'fa-march': 'stroke-dashoffset on curved feature-art paths',
  'ios-draw': 'a check that draws itself',
  'tour-pulse': 'box-shadow on a hole the size of whatever the tour points at',
  'tour-fill': 'the tour\'s picture of a bar filling, not the settled window',
  'mg-pulse': 'box-shadow on one step of the mirroring guide',
  'mg-swipe': 'top on one step of the mirroring guide',
  'npop-ind': 'indeterminate progress',
};
for (const href of sheets) {
  if (href.endsWith('ui-away.css')) continue;
  const css = fs.readFileSync(path.join(root, 'mac', href), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/[^{}]*animation:\s*([a-z0-9-]+)[^;}]*infinite/g)) {
    const body = frameBody(css, m[1]);
    assert.ok(body, `${href}: @keyframes ${m[1]}`);
    const paint = props(body).filter((p) => p !== 'transform' && p !== 'opacity');
    if (!paint.length) continue;
    assert.ok(LEFT[m[1]], `${href}: ${m[1]} animates ${paint.join(', ')} on a steady screen; move it to transform and opacity`);
  }
}
function ruleBody(css, sel) {
  const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{').exec(css);
  assert.ok(m, `missing ${sel}`);
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < css.length && depth) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(start, i - 1);
}
function decl(body, prop) {
  const m = new RegExp('(?:^|[;{])\\s*' + prop + '\\s*:\\s*([^;]+)', 'm').exec(';' + body);
  assert.ok(m, `missing ${prop} in ${body}`);
  return m[1].trim();
}

// Ring: a 7px dot, a 13px disc (the 3px breathe shadow), scale 7/13 to 1, opacity 1 to 0.
{
  const dot = fs.readFileSync(path.join(root, 'mac/control.css'), 'utf8');
  assert.match(dot, /\.dot\s*\{[^}]*width:\s*7px;\s*height:\s*7px/);
  const ring = ruleBody(calm, '.dot.good::after');
  assert.equal(decl(ring, 'width'), '13px');
  assert.equal(decl(ring, 'height'), '13px');
  assert.equal(decl(ring, 'background'), 'rgba(48, 185, 77, 0.45)');
  assert.equal(decl(ring, 'z-index'), '-1', 'the disc sits below the dot centre');
  const centre = ruleBody(calm, '.dot.good::before');
  assert.deepEqual(['position', 'inset', 'border-radius', 'background'].map(property => decl(centre, property)),
    ['absolute', '0', 'inherit', 'inherit'], 'the unanimated centre covers the disc');
  assert.match(ruleBody(calm, '.dot.good'), /isolation:\s*isolate/);
  const b = frames['td-breathe'].replace(/\s+/g, ' ');
  assert.match(b, /0%, 100% \{ transform: scale\(calc\(7 \/ 13\)\); opacity: 1; \}/);
  assert.match(b, /50% \{ transform: scale\(1\); opacity: 0; \}/);
  assert.doesNotMatch(calm, /@starting-style/, 'a new dot is green at once; only a class change fades');
}

// Pulse: a 40px streak. The box starts at -40 and is W+40 wide, so translate 0 to 100%
// matches upstream left -40px to left 100%. Fully outside the link at both ends.
{
  const pulse = ruleBody(calm, '.hero-link.up .hero-pulse');
  assert.equal(decl(pulse, 'left'), '-40px');
  assert.equal(decl(pulse, 'width'), 'calc(100% + 40px)');
  const streak = ruleBody(calm, '.hero-link.up .hero-pulse::before');
  assert.equal(decl(streak, 'width'), '40px');
  const travel = frames['td-travel'].replace(/\s+/g, ' ');
  assert.match(travel, /from \{ transform: translateX\(0\); \}/);
  assert.match(travel, /to \{ transform: translateX\(100%\); \}/);
  const W = 200;
  for (const p of [0, 0.5, 1]) {
    const shift = p * (W + 40);
    const x0 = -40 + shift;
    const x1 = x0 + 40;
    if (p === 0) assert.ok(x1 <= 0, 'the pulse starts fully left of the link');
    else if (p === 1) assert.ok(x0 >= W, 'the pulse ends fully right of the link');
    else assert.ok(x0 < W && x1 > 0, 'the pulse crosses the link in the middle');
  }
}

// Dashes: one 24px tile, starting one tile left of the link, so [0, W] stays painted
// at every translate. left: 0 leaves [0, t) empty.
{
  const bar = ruleBody(calm, '.hero-link:not(.up)::before');
  const left = Number(decl(bar, 'left').replace('px', ''));
  const extra = Number((decl(bar, 'width').match(/calc\(100% \+ (\d+)px\)/) || [])[1]);
  assert.equal(extra, 24, 'the streak is one dash tile wider than the link');
  assert.equal(decl(bar, 'background-size'), '24px 3px');
  const dash = frames['td-dash'].replace(/\s+/g, ' ');
  assert.match(dash, /from \{ transform: translateX\(0\); \}/);
  assert.match(dash, /to \{ transform: translateX\(24px\); \}/);
  assert.equal(left, -24, 'the streak starts one tile left of the link');
  const W = 200;
  for (const t of [0, 6, 12, 24]) {
    const x0 = left + t;
    const x1 = x0 + W + extra;
    assert.ok(x0 <= 0 && x1 >= W, `translate ${t}px covers [${x0}, ${x1}], which does not contain [0, ${W}]`);
  }
}

console.log('ui-away: ok');
