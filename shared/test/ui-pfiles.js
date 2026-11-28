// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone Files (shared/ui-pfiles.js): Shift-click range selection, preserved flows,
// anchor invalidation and Delete confirmation via the production click handlers.
// Run: node shared/test/ui-pfiles.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../ui-pfiles.js'), 'utf8');

function mountPfiles() {
  const received = new Map();
  const asked = [];
  const deviceListeners = [];

  function makeClassList(node) {
    const set = new Set();
    const sync = (cls) => {
      set.clear();
      for (const c of String(cls || '').split(/\s+/).filter(Boolean)) set.add(c);
    };
    return {
      sync,
      add(...cls) { for (const c of cls) if (c) set.add(c); node._className = [...set].join(' '); },
      remove(...cls) { for (const c of cls) set.delete(c); node._className = [...set].join(' '); },
      toggle(c, force) {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        node._className = [...set].join(' ');
        return on;
      },
      contains(c) { return set.has(c); },
    };
  }

  const el = (tag, props = {}, children = []) => {
    const node = {
      tag: String(tag).toLowerCase(),
      children: [],
      parentNode: null,
      attrs: { ...(props.attrs || {}) },
      dataset: {},
      style: {},
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      textContent: '',
      _className: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(type, fn) {
        this._listeners = this._listeners || {};
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      focus() {},
      select() {},
      setSelectionRange() {},
      contains(target) {
        for (let cur = target; cur; cur = cur.parentNode) if (cur === this) return true;
        return false;
      },
      matches(selector) {
        return selector.split(',').map((s) => s.trim()).some((s) => {
          if (s.startsWith('.')) return this.classList.contains(s.slice(1));
          return this.tag === s.toLowerCase();
        });
      },
      closest(selector) {
        for (let cur = this; cur; cur = cur.parentNode) if (cur.matches(selector)) return cur;
        return null;
      },
      querySelector(selector) {
        const stack = [...this.children];
        while (stack.length) {
          const cur = stack.shift();
          if (!cur || typeof cur !== 'object') continue;
          if (cur.matches(selector)) return cur;
          if (cur.children) stack.unshift(...cur.children);
        }
        return null;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n == null || n === false) continue;
          if (typeof n === 'object') n.parentNode = this;
          this.children.push(n);
        }
      },
      prepend(...nodes) {
        const valid = nodes.filter((n) => n != null && n !== false);
        for (const n of valid) if (typeof n === 'object') n.parentNode = this;
        this.children.unshift(...valid);
      },
      replaceChildren(...nodes) {
        for (const c of this.children) if (c && typeof c === 'object') c.parentNode = null;
        this.children = [];
        this.append(...nodes);
      },
    };
    node.classList = makeClassList(node);
    Object.defineProperty(node, 'className', {
      get() { return node._className; },
      set(v) { node._className = String(v || ''); node.classList.sync(node._className); },
    });
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'attrs') continue;
      else node[k] = v;
    }
    node.append(...[].concat(children));
    return node;
  };

  let tab;
  const state = {
    hub: { files: true, connected: true, perm: { files: { perm: 'ok' } }, name: 'Pixel' },
    files: {},
  };
  const UI = {
    el,
    state,
    api: { hub() {} },
    tab(def) { tab = def; },
    hubTop: () => ({ el: el('div'), render() {} }),
    icon: (name, cls) => el('svg', { class: cls || '' }),
    button(label, onClick, cls = '') {
      const b = el('button', { class: `btn ${cls}`.trim(), text: label });
      b.onclick = onClick;
      return b;
    },
    switch: () => { const s = el('input', { type: 'checkbox' }); return { el: s, set(v) { s.checked = !!v; } }; },
    saveFolderButton() {
      const b = el('button', { class: 'btn small' });
      b.update = () => {};
      return b;
    },
    row(label, hint, controls = [], { onClick, literal = false } = {}) {
      const lab = el('span', { class: 'label', text: label || '' });
      const hintEl = el('span', { class: 'hint', text: hint || '' });
      const r = el('div', { class: 'row' }, [
        el('div', { class: 'text' }, [lab, hintEl]),
        el('div', { class: 'controls' }, [].concat(controls).map((c) => (c && c.el) || c)),
      ]);
      if (literal) r.dataset.literal = '';
      r.label = lab;
      r.hint = hintEl;
      r.setHint = (t) => { hintEl.textContent = t || ''; hintEl.hidden = !t; };
      if (onClick) {
        r.classList.add('clickable');
        r.onclick = (e) => { if (!e.target.closest('input,button,select')) onClick(); };
      }
      return r;
    },
    card(title, rows, { cls = '' } = {}) {
      const card = el('div', { class: `card ${cls}`.trim() }, rows);
      const wrap = el('div', { class: 'card-wrap' }, [card]);
      wrap.card = card;
      return wrap;
    },
    fill: (s) => String(s || '').replace('{me}', 'Mac'),
    receivedName: () => 'Downloads',
    phoneName: (s) => (s && s.hub && s.hub.name) || 'your phone',
    clock: () => '10:00',
    bytes: (n) => `${n} B`,
    hubOn: (type, fn) => received.set(type, fn),
    hubAsk: (msg) => asked.push(JSON.parse(JSON.stringify(msg))),
    hubReady: (s) => !!(s && s.hub && s.hub.files && s.hub.connected),
    onBle: () => false,
    onShown() {},
    onDeviceChange: (fn) => deviceListeners.push(fn),
  };

  vm.runInNewContext(source, { UI, window: {}, navigator: { platform: 'MacIntel' }, setTimeout, clearTimeout, console });
  const body = el('section');
  const page = el('div');
  const render = tab.build(body, page);
  render(state);

  const wrap = body.children[2];
  const [, selBar, , listCard] = wrap.children;
  const list = listCard.card.children[0];
  const [selText, , , saveBtn, renameBtn, deleteBtn, clearBtn] = selBar.children;

  // Simulate browser click dispatch (including native checkbox toggle + bubbling to row.onclick).
  function clickNode(target, mods = {}) {
    let defaultPrevented = false;
    const isCheckbox = target.tag === 'input' && target.type === 'checkbox';
    const prevChecked = isCheckbox ? target.checked : false;
    if (isCheckbox) target.checked = !prevChecked;

    const e = {
      target,
      shiftKey: !!mods.shiftKey,
      ctrlKey: !!mods.ctrlKey,
      metaKey: !!mods.metaKey,
      preventDefault() { defaultPrevented = true; },
      stopPropagation() { this._stopped = true; },
    };
    const path = [];
    for (let cur = target; cur; cur = cur.parentNode) path.push(cur);
    for (const cur of path) {
      if (typeof cur.onclick === 'function') cur.onclick(e);
      if (e._stopped) break;
    }
    if (isCheckbox) {
      if (defaultPrevented) {
        target.checked = prevChecked;
      } else if (typeof target.onchange === 'function') {
        target.onchange({ target });
      }
    }
    return { defaultPrevented };
  }

  const rows = () => list.children.filter((n) => n.classList.contains('hub-fs-row'));
  const rowByName = (name) => rows().find((r) => r.label && r.label.textContent === name);
  const checkOf = (r) => r.querySelector('input');
  const chosenNames = () => rows().filter((r) => r.classList.contains('chosen')).map((r) => r.label.textContent);
  const checkedNames = () => rows().filter((r) => checkOf(r).checked).map((r) => r.label.textContent);
  const deliverList = (path, items, extra = {}) => received.get('fs.list')({ path, items, ...extra });
  const changeDevice = () => {
    // Check the reset itself before showing the page can request another listing.
    page.hidden = true;
    for (const fn of deviceListeners) fn();
  };

  return {
    asked, list, selBar, selText, saveBtn, renameBtn, deleteBtn, clearBtn,
    rows, rowByName, checkOf, chosenNames, checkedNames, clickNode, deliverList, changeDevice,
  };
}

test('Shift-click selects inclusive sorted ranges across files/directories and preserves navigation, toggles, Save and two-step Delete', () => {
  const f = mountPfiles();
  // Deliver unsorted entries so visible sorted order differs from input order:
  // Sorted: Alpha (dir), Zebra (dir), file1.txt, file2.txt, file10.txt
  f.deliverList('', [
    { name: 'file10.txt', dir: false, size: 10 },
    { name: 'file2.txt', dir: false, size: 2 },
    { name: 'Zebra', dir: true, n: 1 },
    { name: 'file1.txt', dir: false, size: 1 },
    { name: 'Alpha', dir: true, n: 2 },
  ]);
  assert.deepEqual(f.rows().map((r) => r.label.textContent), ['Alpha', 'Zebra', 'file1.txt', 'file2.txt', 'file10.txt']);

  // 1. Plain file row click sets anchor; forward Shift-click spans visible sorted rows inclusively.
  f.clickNode(f.rowByName('file1.txt').label);
  assert.deepEqual(f.chosenNames(), ['file1.txt']);
  f.clickNode(f.rowByName('file10.txt').label, { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['file1.txt', 'file2.txt', 'file10.txt']);
  assert.deepEqual(f.checkedNames(), ['file1.txt', 'file2.txt', 'file10.txt']);
  assert.equal(f.selBar.hidden, false);
  assert.equal(f.selText.textContent, '3 chosen');
  assert.equal(f.renameBtn.hidden, true);

  // 2. Reverse Shift-click onto a directory row selects upward across directories without navigating.
  const askCountBeforeDirShift = f.asked.length;
  f.clickNode(f.rowByName('Alpha').label, { shiftKey: true });
  assert.equal(f.asked.length, askCountBeforeDirShift, 'Shift-clicking a directory row must not open it');
  assert.deepEqual(f.chosenNames(), ['Alpha', 'Zebra', 'file1.txt', 'file2.txt', 'file10.txt']);

  // 3. Independent Ctrl/Cmd toggling removes and adds single items without clearing others.
  f.clickNode(f.rowByName('file2.txt').label, { ctrlKey: true });
  assert.deepEqual(f.chosenNames(), ['Alpha', 'Zebra', 'file1.txt', 'file10.txt']);
  f.clickNode(f.rowByName('file2.txt').label, { metaKey: true });
  assert.deepEqual(f.chosenNames(), ['Alpha', 'Zebra', 'file1.txt', 'file2.txt', 'file10.txt']);

  // An armed Delete for this selection cannot apply to an expanded range.
  f.clickNode(f.checkOf(f.rowByName('Alpha')));
  const asksBeforeDelete = f.asked.length;
  f.clickNode(f.deleteBtn);
  assert.equal(f.asked.length, asksBeforeDelete);
  assert.equal(f.deleteBtn.textContent, 'Delete 4 items?');

  f.clickNode(f.rowByName('Alpha').label, { shiftKey: true });
  assert.equal(f.deleteBtn.textContent, 'Delete', 'Shift-click disarms pending Delete');
  assert.equal(f.deleteBtn.classList.contains('danger'), false);
  f.clickNode(f.deleteBtn);
  assert.equal(f.asked.length, asksBeforeDelete, 'expanded selection requires a fresh confirmation');
  assert.equal(f.deleteBtn.textContent, 'Delete 5 items?');
  f.clickNode(f.deleteBtn);
  assert.equal(f.asked.at(-1).t, 'fs.do');
  assert.equal(f.asked.at(-1).a, 'delete');
  assert.deepEqual(f.asked.at(-1).paths.sort(), ['Alpha', 'Zebra', 'file1.txt', 'file10.txt', 'file2.txt']);
  assert.deepEqual(f.chosenNames(), []);

  // Native checkbox activation also supports Shift clicks.
  f.clickNode(f.checkOf(f.rowByName('Zebra')));
  assert.deepEqual(f.chosenNames(), ['Zebra']);
  const shiftCheck = f.clickNode(f.checkOf(f.rowByName('file2.txt')), { shiftKey: true });
  assert.equal(shiftCheck.defaultPrevented, true);
  assert.deepEqual(f.chosenNames(), ['Zebra', 'file1.txt', 'file2.txt']);
  // Shift-clicking an already-checked checkbox keeps it selected.
  f.clickNode(f.checkOf(f.rowByName('file2.txt')), { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['Zebra', 'file1.txt', 'file2.txt']);

  // Save emits fs.save for the range and retires its selection and Delete confirmation.
  f.clickNode(f.deleteBtn);
  f.clickNode(f.saveBtn);
  assert.equal(f.asked.at(-1).t, 'fs.save');
  assert.deepEqual(f.asked.at(-1).paths, ['Zebra', 'file1.txt', 'file2.txt']);
  assert.deepEqual(f.chosenNames(), []);

  f.clickNode(f.checkOf(f.rowByName('file10.txt')), { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['file10.txt'], 'Save clears the range anchor');
  assert.equal(f.deleteBtn.textContent, 'Delete');

  // Plain click on a directory row preserves normal folder navigation.
  f.clickNode(f.rowByName('Alpha').label);
  assert.deepEqual(f.asked.at(-1), { t: 'fs.list', path: 'Alpha', hidden: false });
});

test('navigation, refresh and device changes retire stale selection and pending deletes', () => {
  const f = mountPfiles();
  f.deliverList('', [
    { name: 'Sub', dir: true, n: 2 },
    { name: 'a.txt', dir: false, size: 1 },
    { name: 'b.txt', dir: false, size: 2 },
    { name: 'c.txt', dir: false, size: 3 },
  ]);

  // Selection reset via Done invalidates anchor.
  f.clickNode(f.rowByName('a.txt').label);
  f.clickNode(f.clearBtn);
  f.clickNode(f.rowByName('c.txt').label, { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['c.txt'], 'Done clears anchor so Shift-click does not select a..c');

  // Refresh removes the anchor. A returned file with the same name is not the old anchor.
  f.clickNode(f.rowByName('a.txt').label);
  f.clickNode(f.deleteBtn);
  f.deliverList('', [
    { name: 'Sub', dir: true, n: 2 },
    { name: 'b.txt', dir: false, size: 2 },
    { name: 'c.txt', dir: false, size: 3 },
  ]);
  assert.deepEqual(f.chosenNames(), ['c.txt']);
  assert.equal(f.deleteBtn.textContent, 'Delete', 'refresh disarms Delete when it prunes selection');
  f.deliverList('', [
    { name: 'Sub', dir: true, n: 2 },
    { name: 'a.txt', dir: false, size: 1 },
    { name: 'b.txt', dir: false, size: 2 },
    { name: 'c.txt', dir: false, size: 3 },
  ]);
  f.clickNode(f.rowByName('b.txt').label, { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['b.txt', 'c.txt']);

  f.clickNode(f.rowByName('Sub').label);
  assert.deepEqual(f.asked.at(-1), { t: 'fs.list', path: 'Sub', hidden: false });
  assert.equal(f.rows().length, 0, 'the pending folder cannot show selectable rows from the previous folder');
  assert.equal(f.list.children[0].textContent, 'Loading…');
  assert.equal(f.selBar.hidden, true);

  // Destination folder happens to contain same-named file 'b.txt': old anchor must NOT apply.
  f.deliverList('Sub', [
    { name: 'b.txt', dir: false, size: 2 },
    { name: 'd.txt', dir: false, size: 4 },
    { name: 'e.txt', dir: false, size: 5 },
  ]);
  f.clickNode(f.rowByName('e.txt').label, { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['e.txt'], 'navigation invalidated anchor even with same-named entry');

  // Device change invalidates anchor even when the new device has identical filenames.
  f.clickNode(f.rowByName('b.txt').label); // anchor: b.txt
  f.clickNode(f.deleteBtn);
  f.changeDevice();
  assert.equal(f.rows().length, 0);
  assert.equal(f.selBar.hidden, true);
  assert.equal(f.deleteBtn.textContent, 'Delete');
  f.deliverList('', [
    { name: 'b.txt', dir: false, size: 2 },
    { name: 'd.txt', dir: false, size: 4 },
    { name: 'e.txt', dir: false, size: 5 },
  ]);
  f.clickNode(f.rowByName('e.txt').label, { shiftKey: true });
  assert.deepEqual(f.chosenNames(), ['e.txt'], 'device change invalidated anchor before Shift-click');
});
