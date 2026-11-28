// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function fixture(deviceId, saved = new Map()) {
  class Element {
    constructor() { this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.style = { setProperty: (k, v) => { this.attrs[k] = v; } }; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    append(...children) {
      for (const child of children) {
        if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
        this.children.push(child);
        child.parent = this;
      }
    }
    insertBefore(child, before) { this.append(child); this.children.splice(this.children.indexOf(child), 1); this.children.splice(this.children.indexOf(before), 0, child); }
    querySelector() { return tools; }
    setAttribute(k, v) { this.attrs[k] = v; }
    get options() { return this.children; }
    getBoundingClientRect() { return { height: 72 }; }
  }
  const body = new Element(), bar = new Element(), tools = new Element(), nav = new Element();
  bar.append(tools);
  body.append(bar, nav);
  const sent = [];
  const root = {
    localStorage: { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, v) },
    ResizeObserver: class { observe() {} },
    PlayerI18n: { t: (s) => s },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mirror-toolbar'), 'utf8'), {
    window: root, document: { body, getElementById: () => bar, createElement: () => new Element() },
  });
  const ui = root.MirrorToolbar({ deviceId, rail: { nav }, api: { send: (m) => sent.push(m) } });
  const select = (value) => { ui.select.value = value; ui.select.onchange(); };
  return { body, bar, tools, nav, ui, select, saved, sent };
}

test('dock moves the real controls and rail, reserves picture space, and persists only for the paired device', () => {
  const f = fixture('phone-A');
  assert.equal(f.tools.parent, f.bar);
  f.select('above');
  assert.equal(f.tools.parent, f.ui.dock);
  assert.equal(f.nav.parent, f.ui.dock);
  assert.equal(f.body.dataset.toolbar, 'above');
  assert.equal(f.body.attrs['--toolbar-height'], '72px');
  assert.equal(f.sent.at(-1).height, 72);
  f.select('below');
  assert.equal(f.body.dataset.toolbar, 'below');
  assert.equal(fixture('phone-A', f.saved).body.dataset.toolbar, 'below');
  assert.equal(fixture('phone-B', f.saved).body.dataset.toolbar, 'window');
  f.select('window');
  assert.equal(f.tools.parent, f.bar);
  assert.equal(f.nav.parent, f.body);
  assert.equal(f.sent.at(-1).height, 0);
  assert.equal(f.ui.select.attrs['aria-label'], 'Toolbar position');
  let stopped = 0;
  f.ui.select.listeners.keydown({ stopPropagation() { stopped++; } });
  f.ui.select.listeners.keyup({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 2, 'local selector keys never become phone input');
});

test('corrupt saved positions fall back safely and an unidentified viewer writes no shared preference', () => {
  const saved = new Map([['twindesk.mirrorToolbar.phone-A', 'unexpected']]);
  const f = fixture('phone-A', saved);
  assert.equal(f.body.dataset.toolbar, 'window');
  f.select('not-a-position');
  assert.equal(f.tools.parent, f.bar);
  const unknown = fixture('');
  unknown.select('below');
  assert.equal(unknown.saved.size, 0);
  assert.equal(unknown.body.dataset.toolbar, 'below');
});
