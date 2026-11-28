// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos (shared/ui-media.js): Select mode local-calendar day selection over loaded items,
// preserved flows, Remove disarming, and the 300-item selection cap.
// Run: node --test shared/test/ui-media.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
// These fixtures cross UTC midnight so UTC grouping cannot pass by coincidence.
process.env.TZ = 'America/Los_Angeles';

const source = fs.readFileSync(require.resolve('../ui-media.js'), 'utf8');
const I18n = require('../i18n.js');
const P = require('../protocol.js');
const { PhoneHub } = require('../phonehub.js');

function mountMedia({ canRemove = true, canTrash = false, deviceId = 'fixture-phone', session = 0 } = {}) {
  const received = new Map();
  const asked = [];
  const deviceListeners = [];
  const docListeners = new Map();
  const winListeners = new Map();

  function makeEmitter(map) {
    return {
      addEventListener(type, fn, opts) {
        const cap = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
        if (!map.has(type)) map.set(type, []);
        map.get(type).push({ fn, cap });
      },
      removeEventListener(type, fn) {
        const list = map.get(type);
        if (!list) return;
        const i = list.findIndex((x) => x.fn === fn);
        if (i >= 0) list.splice(i, 1);
      },
      dispatch(type, event = {}) {
        const ev = { defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...event };
        const list = (map.get(type) || []).slice();
        for (const l of list.filter((x) => x.cap)) l.fn(ev);
        if (!ev.stopped) for (const l of list.filter((x) => !x.cap)) l.fn(ev);
        return ev;
      },
    };
  }

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
    const listeners = new Map();
    const em = makeEmitter(listeners);
    const node = {
      tag: String(tag).toLowerCase(),
      children: [],
      parentNode: null,
      attrs: { ...(props.attrs || {}) },
      dataset: {},
      style: {},
      hidden: false,
      disabled: false,
      value: '',
      title: '',
      textContent: '',
      _className: '',
      _rect: null,
      capturedPointers: new Set(),
      setPointerCapture(id) { this.capturedPointers.add(id); },
      releasePointerCapture(id) { this.capturedPointers.delete(id); },
      getBoundingClientRect() { return typeof this._rect === 'function' ? this._rect() : (this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }); },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (cur.matches && cur.matches(sel)) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      addEventListener: em.addEventListener,
      removeEventListener: em.removeEventListener,
      dispatch: em.dispatch,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; },
      remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      },
      matches(selector) {
        return selector.split(',').map((s) => s.trim()).some((s) => {
          if (s.startsWith('.')) return this.classList.contains(s.slice(1));
          if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1) in this.attrs || s.slice(1, -1).replace(/^data-/, '') in this.dataset;
          return this.tag === s.toLowerCase();
        });
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
      querySelectorAll(selector) {
        const out = [];
        const stack = [...this.children];
        while (stack.length) {
          const cur = stack.shift();
          if (!cur || typeof cur !== 'object') continue;
          if (cur.matches(selector)) out.push(cur);
          if (cur.children) stack.unshift(...cur.children);
        }
        return out;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n == null || n === false) continue;
          if (typeof n === 'object') n.parentNode = this;
          this.children.push(n);
        }
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
    hub: {
      media: true, connected: true,
      ...(deviceId ? { deviceId, session } : {}),
      perm: { media: { perm: 'ok', remove: canRemove, trash: canTrash, alerts: false } },
      name: 'Galaxy',
    },
  };
  const UI = {
    el,
    state,
    api: { hub() {}, photoBackup() {} },
    tab(def) { tab = def; },
    hubTop: () => ({ el: el('div'), render() {} }),
    segmented(options, onChange) {
      const box = el('div', { class: 'seg' });
      const btns = options.map((o) => {
        const b = el('button', { text: o.label });
        b.onclick = () => onChange(o.value);
        box.append(b);
        return [o.value, b];
      });
      return {
        el: box,
        set(v) { for (const [val, b] of btns) b.classList.toggle('on', val === v); },
        click(v) { btns.find(([val]) => val === v)[1].onclick(); },
      };
    },
    button(label, onClick, cls = '') {
      const b = el('button', { class: `btn ${cls}`.trim(), text: label });
      b.onclick = onClick;
      return b;
    },
    switch: () => { const s = el('input', { type: 'checkbox' }); return { el: s, set(v) { s.checked = !!v; }, disable() {} }; },
    saveFolderButton() {
      const b = el('button', { class: 'btn small' });
      b.update = () => {};
      return b;
    },
    row(label, hint, controls = []) {
      const r = el('div', { class: 'row' }, controls.map((c) => (c && c.el) || c));
      r.setHint = () => {};
      return r;
    },
    card(title, rows) { return el('div', { class: 'card-wrap' }, rows); },
    fill: (s) => String(s || '').replace('{me}', 'Mac'),
    receivedName: () => 'Downloads',
    duration: (s) => `0:${String(Math.floor(s)).padStart(2, '0')}`,
    bytes: (n) => `${n} B`,
    hubOn: (type, fn) => received.set(type, fn),
    hubAsk: (msg) => asked.push(JSON.parse(JSON.stringify(msg))),
    hubReady: (s) => !!(s && s.hub && s.hub.media && s.hub.connected),
    onBle: () => false,
    onShown() {},
    onDeviceChange: (fn) => deviceListeners.push(fn),
  };

  class FakeObserver {
    observe() {}
    unobserve() {}
  }

  const contentEl = el('div', { attrs: { id: 'content' } });
  const winEm = makeEmitter(winListeners);
  const docEm = makeEmitter(docListeners);
  const win = { I18n: I18n.create('en'), addEventListener: winEm.addEventListener, removeEventListener: winEm.removeEventListener, dispatch: winEm.dispatch };
  const doc = {
    getElementById: (id) => (id === 'content' ? contentEl : null),
    addEventListener: docEm.addEventListener,
    removeEventListener: docEm.removeEventListener,
    dispatch: docEm.dispatch,
  };
  vm.runInNewContext(source, {
    UI,
    window: win,
    document: doc,
    navigator: { platform: 'MacIntel' },
    IntersectionObserver: FakeObserver,
    setTimeout,
    clearTimeout,
    console,
  });

  const body = el('section');
  const page = el('div');
  const render = tab.build(body, page);
  render(state);

  const wrap = body.children[3];
  const viewer = body.children[4];
  const [viewerStage, viewerBar] = viewer.children;
  const [prevBtn, bigImg, nextBtn] = viewerStage.children;
  const [, bigRemove] = viewerBar.children;
  const [albumList, main] = wrap.children;
  const [bar, grid] = main.children;
  const [filterEl, , status, dayWrap, , removeBtn, saveBtn, selectBtn, selectionLimit] = bar.children;
  const [daySelect, dayBtn] = dayWrap.children;

  const tiles = () => grid.children.filter((n) => n.classList.contains('hub-tile'));
  const tileIds = () => tiles().map((t) => t.dataset.id);
  const chosenIds = () => tiles().filter((t) => t.classList.contains('chosen')).map((t) => t.dataset.id);
  const tileById = (id) => tiles().find((t) => t.dataset.id === id);
  const dragBox = () => grid.children.find((n) => n.classList.contains('hub-drag-box'));
  const deliverList = (items, extra = {}) => {
    const { deviceId, session } = state.hub;
    received.get('media.list')({ kind: 'all', before: '', more: false, next: '', items, phone: { deviceId, session }, ...extra });
  };
  const deliver = (type, msg) => {
    const { deviceId, session } = state.hub;
    received.get(type)({ phone: { deviceId, session }, ...msg });
  };
  const deliverAlbums = (items) => deliver('media.albums', { items });
  const deliverDelete = (m) => deliver('media.delete', m);
  const deliverView = (m) => deliver('media.view', m);
  const deliverThumb = (m) => deliver('media.thumb', m);
  const pickDay = (key) => { daySelect.value = key; daySelect.onchange(); };
  const clickFilter = (label) => filterEl.children.find((b) => b.textContent === label).onclick();
  const changeDevice = () => { page.hidden = true; for (const fn of deviceListeners) fn(); };

  return {
    state, asked, wrap, viewer, viewerStage, prevBtn, bigImg, nextBtn, bigRemove, grid, contentEl, doc, win,
    albumList, status, selectionLimit, dayWrap, daySelect, dayBtn, removeBtn, saveBtn, selectBtn, dragBox,
    tiles, tileIds, chosenIds, tileById, deliverList, deliverAlbums, deliverDelete, deliverView, deliverThumb, pickDay, clickFilter, changeDevice, render,
  };
}

function localTs(y, m, d, h, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

test('Select mode selects loaded items for one local-calendar day without fetching, preserves order/flows, and disarms Remove', () => {
  const f = mountMedia({ canRemove: true });
  const day27Late = localTs(2026, 11, 27, 23, 55);
  const day27Early = localTs(2026, 11, 27, 0, 5);
  const day26Late = localTs(2026, 11, 26, 23, 50);
  const day26Noon = localTs(2026, 11, 26, 12, 0);

  f.deliverList([
    // A photo recently copied onto the phone can have an older capture date than the next row.
    { id: 'i3', video: false, at: day26Late, name: 'IMG_3.jpg', size: 100 },
    { id: 'i1', video: false, at: day27Late, name: 'IMG_1.jpg', size: 100 },
    { id: 'i2', video: false, at: day27Early, name: 'IMG_2.jpg', size: 100 },
    { id: 'v4', video: true, at: day26Noon, name: 'VID_4.mp4', size: 200, dur: 4000 },
  ], { more: true, next: '100:4' });

  // Outside Select mode: day selector hidden, tile click still opens preview.
  assert.equal(f.dayWrap.hidden, true);
  assert.deepEqual(f.tileIds(), ['i3', 'i1', 'i2', 'v4']);
  f.tileById('i1').onclick();
  assert.equal(f.viewer.hidden, false);
  // Close viewer before entering Select mode.
  f.viewer.hidden = true;

  const asksBeforeSelect = f.asked.length;
  f.selectBtn.onclick();
  assert.equal(f.dayWrap.hidden, false);
  assert.equal(f.daySelect.getAttribute('aria-label'), 'Loaded day to select');
  assert.equal(f.dayBtn.textContent, 'Select loaded day');
  assert.equal(f.dayBtn.getAttribute('aria-label'), undefined, 'the visible label is the accessible name');
  assert.equal(f.daySelect.children.length, 2);
  assert.equal(f.daySelect.children[0].value, '2026-11-27');
  assert.match(f.daySelect.children[0].textContent, /\(2 loaded\)$/);
  assert.equal(f.daySelect.children[1].value, '2026-11-26');
  assert.match(f.daySelect.children[1].textContent, /\(2 loaded\)$/);

  // Selecting the newest loaded day adds its loaded items without fetching or reordering.
  f.dayBtn.onclick();
  assert.equal(f.asked.length, asksBeforeSelect, 'day selection must not fetch more pages');
  assert.deepEqual(f.tileIds(), ['i3', 'i1', 'i2', 'v4'], 'list order preserved');
  assert.deepEqual(f.chosenIds(), ['i1', 'i2']);
  assert.equal(f.dayBtn.disabled, true, 'already-selected day disables no-op re-add');

  // Per-tile toggle still works alongside day selection.
  f.tileById('i2').onclick();
  assert.deepEqual(f.chosenIds(), ['i1']);
  assert.equal(f.dayBtn.disabled, false);

  // Arm permission-gated two-step Remove, then additively select another loaded day -> disarms Remove.
  f.removeBtn.onclick();
  assert.equal(f.removeBtn.textContent, 'Remove 1 item from the phone?');
  assert.equal(f.removeBtn.classList.contains('danger'), true);

  f.pickDay('2026-11-26');
  assert.equal(f.dayBtn.disabled, false);
  f.dayBtn.onclick();
  assert.deepEqual(f.chosenIds(), ['i3', 'i1', 'v4']);
  assert.equal(f.removeBtn.textContent, 'Remove', 'additive day selection disarms Remove');
  assert.equal(f.removeBtn.classList.contains('danger'), false);
  assert.equal(f.asked.length, asksBeforeSelect, 'additive day selection still does not fetch');

  // Fresh two-step Remove sends media.delete for the combined selection.
  f.removeBtn.onclick();
  assert.equal(f.removeBtn.textContent, 'Remove 3 items from the phone?');
  f.removeBtn.onclick();
  assert.deepEqual(f.asked.at(-1), { t: 'media.delete', ids: ['i1', 'i3', 'v4'], phone: { deviceId: 'fixture-phone', session: 0 } });

  // Save flow works with day-selected items and respects remove permission hiding.
  f.state.hub.perm.media.remove = false;
  f.selectBtn.onclick();
  assert.equal(f.removeBtn.hidden, true, 'Remove remains permission-gated');
  f.pickDay('2026-11-27');
  f.dayBtn.onclick();
  f.saveBtn.onclick();
  assert.deepEqual(f.asked.at(-1), { t: 'media.save', ids: ['i1', 'i2'] });

  // Album, filter, and device changes scope loaded days cleanly.
  f.deliverAlbums([{ id: '10', name: 'Camera', n: 1, cover: 'i9' }]);
  f.selectBtn.onclick();
  f.albumList.children[1].onclick();
  assert.equal(f.dayWrap.hidden, true, 'album switch clears previous loaded days');
  f.deliverList([{ id: 'i9', video: false, at: localTs(2026, 11, 20, 9), name: 'CAM.jpg', size: 50 }], { album: '10' });
  assert.equal(f.dayWrap.hidden, false);
  assert.deepEqual(f.daySelect.children.map((o) => o.value), ['2026-11-20']);

  f.clickFilter('Videos');
  assert.equal(f.dayWrap.hidden, true, 'filter switch clears previous loaded days');
  f.deliverList([{ id: 'v5', video: true, at: day27Late }], { kind: 'videos', album: '10' });
  assert.equal(f.dayWrap.hidden, false, 'there are day controls to retire');
  f.dayBtn.onclick();
  assert.deepEqual(f.chosenIds(), ['v5']);
  f.changeDevice();
  assert.equal(f.dayWrap.hidden, true, 'device switch exits Select mode and clears days');
  assert.equal(f.selectBtn.textContent, 'Select');
  assert.deepEqual(f.tileIds(), [], 'old photos are retired even while the page is hidden');
});

test('300-item selection cap disables over-limit loaded days with clear feedback and never truncates silently', () => {
  const f = mountMedia({ canRemove: true });

  // Day A has 305 loaded items (>300); Day B has 250; Day C has 60; Day D has 50.
  const makeItems = (prefix, count, ts) => Array.from({ length: count }, (_, idx) => ({
    id: `${prefix}${idx + 1}`, video: false, at: ts - idx * 1000, name: `${prefix}_${idx + 1}.jpg`, size: 10,
  }));
  f.deliverList([
    ...makeItems('i10', 305, localTs(2026, 11, 27, 18)),
    ...makeItems('i20', 250, localTs(2026, 11, 26, 18)),
    ...makeItems('i30', 60, localTs(2026, 11, 25, 18)),
    ...makeItems('i40', 50, localTs(2026, 11, 24, 18)),
  ]);

  f.selectBtn.onclick();
  // Default picked day (2026-11-27, 305 items) exceeds 300 immediately.
  assert.equal(f.daySelect.value, '2026-11-27');
  assert.equal(f.dayBtn.disabled, true);
  assert.equal(f.selectionLimit.textContent, 'Can’t select more than 300 items at once');
  assert.equal(f.status.textContent, '665 items');
  // Guard also blocks direct invocation without mutating selection.
  f.dayBtn.onclick();
  assert.equal(f.chosenIds().length, 0);

  // Day B (250 items) fits cleanly.
  f.pickDay('2026-11-26');
  assert.equal(f.dayBtn.disabled, false);
  assert.equal(f.selectionLimit.textContent, '');
  f.dayBtn.onclick();
  assert.equal(f.chosenIds().length, 250);

  // Additive Day C (250 + 60 = 310 > 300) is disabled with visible feedback and leaves selection at 250.
  f.pickDay('2026-11-25');
  assert.equal(f.dayBtn.disabled, true);
  assert.equal(f.selectionLimit.textContent, 'Can’t select more than 300 items at once');
  assert.equal(f.status.textContent, '665 items');
  f.dayBtn.onclick();
  assert.equal(f.chosenIds().length, 250);

  // Additive Day D (250 + 50 = 300) fits exactly at the cap.
  f.pickDay('2026-11-24');
  assert.equal(f.dayBtn.disabled, false);
  f.dayBtn.onclick();
  assert.equal(f.chosenIds().length, 300);

  // Per-tile selection also refuses a 301st item visibly instead of creating >300 IDs.
  f.tileById('i301').onclick();
  assert.equal(f.chosenIds().length, 300);
  assert.equal(f.selectionLimit.textContent, 'Can’t select more than 300 items at once');
  assert.equal(f.status.textContent, '665 items');
});

function setupPhoneHub(os = P.OS.ANDROID) {
  const sent = [];
  const data = [];
  const ws = { readyState: 1 };
  const phone = { deviceId: 'phone-1', os, name: 'Pixel', authed: true, ws };
  const server = Object.assign(new EventEmitter(), {
    current: phone,
    sendToClient: (m) => sent.push(m),
  });
  const settings = { hub: { media: true, calls: false, messages: false, files: false } };
  const hub = new PhoneHub({ server, getSettings: () => settings, save() {} });
  hub.on('data', (m) => data.push(m));
  hub.started();
  const deliverState = (media, ctx = phone) => server.emit(`t:${P.T.HUB_STATE}`, { t: P.T.HUB_STATE, media }, ctx, ctx.ws);
  return { hub, server, phone, sent, data, deliverState };
}

test('Trash capability labels Move to Trash, keeps previews until consent, and reconciles on confirmation', () => {
  const { hub, server, phone, sent, data, deliverState } = setupPhoneHub(P.OS.ANDROID);
  deliverState({ perm: 'ok', remove: true, trash: true, alerts: false });
  assert.equal(hub.view.perm.media.trash, true);

  const f = mountMedia({ canRemove: true, canTrash: true, deviceId: phone.deviceId, session: hub.view.session });
  f.deliverAlbums([{ id: '1', name: 'Camera', n: 2, cover: 'i1' }]);
  f.deliverList([
    { id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 },
    { id: 'i2', video: false, at: localTs(2026, 11, 27, 11), name: 'IMG_2.jpg', size: 100 },
  ]);

  // Viewer confirmation uses Move to Trash wording and forwards scoped trash action.
  f.tileById('i1').onclick();
  assert.equal(f.bigRemove.textContent, 'Move to Trash');
  f.bigRemove.onclick();
  assert.equal(f.bigRemove.textContent, 'Move to Trash?');
  assert.equal(f.bigRemove.classList.contains('danger'), true);
  f.bigRemove.onclick();
  const req = f.asked.at(-1);
  assert.deepEqual(req, { t: 'media.delete', ids: ['i1'], action: 'trash', phone: { deviceId: phone.deviceId, session: hub.view.session } });
  assert.equal(hub.ask(req), true);
  assert.deepEqual(sent.at(-1), { t: 'media.delete', ids: ['i1'], action: 'trash' });

  // Before on-phone consent: preview and tile stay intact.
  server.emit(`t:${P.T.MEDIA_DELETE}`, { t: P.T.MEDIA_DELETE, ids: [], failed: 0, confirm: 1, action: 'trash' }, phone, phone.ws);
  f.deliverDelete(data.at(-1));
  assert.equal(f.viewer.hidden, false, 'viewer stays open before confirmation');
  assert.deepEqual(f.tileIds(), ['i1', 'i2'], 'tiles stay until confirmation');
  assert.equal(f.status.textContent, 'Tap the notification on the phone to move 1 to Trash');

  // After on-phone consent: confirmed media.delete reply retires item and refreshes albums.
  const asksBefore = f.asked.length;
  server.emit(`t:${P.T.MEDIA_DELETE}`, { t: P.T.MEDIA_DELETE, ids: ['i1'], failed: 0, confirm: 0, action: 'trash' }, phone, phone.ws);
  f.deliverDelete(data.at(-1));
  assert.deepEqual(f.tileIds(), ['i2']);
  assert.equal(f.asked.slice(asksBefore).some((m) => m.t === 'media.albums'), true, 'albums refresh after reconciled trash');
});

test('PhoneHub and Photos never fall back to permanent delete on failed/unsupported Trash and keep legacy/iOS unchanged', () => {
  // Older Android without trash capability & iOS never expose trash and refuse action:'trash'.
  for (const os of [P.OS.ANDROID, P.OS.IOS]) {
    const { hub, server, phone, sent, data, deliverState } = setupPhoneHub(os);
    sent.length = 0; // ignore initial hub.policy
    deliverState({ perm: 'ok', remove: true, ...(os === P.OS.IOS ? { trash: true } : {}) });
    const list = { t: P.T.MEDIA_LIST, kind: 'all', items: [] };
    const retired = { ...phone, ws: { readyState: 1 } };
    server.emit(`t:${P.T.MEDIA_LIST}`, list, retired, retired.ws);
    assert.equal(data.length, 0, 'same device ID on a retired socket cannot publish the listing');
    server.emit(`t:${P.T.MEDIA_LIST}`, list, { ...phone }, phone.ws);
    assert.deepEqual(data.at(-1), { ...list, phone: { deviceId: phone.deviceId, session: hub.view.session } });
    assert.equal(hub.view.perm.media.trash, false, `${os} without Android 11+ trash does not expose trash`);
    assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: ['i1'], action: 'trash', phone: { deviceId: phone.deviceId, session: hub.view.session } }), false);
    assert.equal(sent.length, 0, 'refused Trash must never fall back to permanent delete');
    assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: ['i1'] }), true, 'explicit legacy remove still works');
    assert.deepEqual(sent.at(-1), { t: P.T.MEDIA_DELETE, ids: ['i1'] });
  }

  // Android 11+ with trash capability enforces permission, current session, scoped action, and <=300 valid IDs.
  const { hub, phone, sent, data, deliverState } = setupPhoneHub(P.OS.ANDROID);
  sent.length = 0;
  deliverState({ perm: 'ok', remove: true, trash: true });
  const binding = { deviceId: phone.deviceId, session: hub.view.session };
  assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: ['i1'], action: 'trash' }), false, 'Trash requires exact renderer binding');
  assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: ['i1'], action: 'delete', phone: binding }), false, 'unscoped action rejected');
  assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: ['i1'], action: 'trash', phone: { ...binding, session: 999 } }), false, 'stale session rejected');
  assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: Array.from({ length: 301 }, (_, i) => `i${i + 1}`), action: 'trash', phone: binding }), false, '>300 IDs rejected');
  assert.equal(hub.ask({ t: P.T.MEDIA_DELETE, ids: ['bad'], action: 'trash', phone: binding }), false, 'invalid ID rejected');
  deliverState({ perm: 'ask', remove: true, trash: true });
  const refused = { t: P.T.MEDIA_DELETE, ids: ['i1'], action: 'trash', phone: binding };
  assert.equal(hub.act({ do: 'send', msg: refused }), false, 'missing media permission rejected');
  assert.deepEqual(data.at(-1), { t: P.T.MEDIA_DELETE, ids: [], failed: 1, confirm: 0, phone: binding, action: 'trash' },
    'fire-and-forget IPC still gets a scoped failure reply');
  assert.equal(sent.length, 0);

  const f = mountMedia({ canRemove: true, canTrash: true, deviceId: phone.deviceId, session: hub.view.session });
  const items = [{ id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 }];
  f.deliverList(items);
  f.tileById('i1').onclick();
  f.bigRemove.onclick();
  assert.equal(f.bigRemove.textContent, 'Move to Trash?');
  const deletes = () => f.asked.filter((m) => m.t === 'media.delete');
  f.state.hub.perm.media.trash = false;
  f.bigRemove.onclick();
  assert.deepEqual(deletes(), [], 'a Trash prompt cannot switch into permanent deletion');
  assert.equal(f.bigRemove.textContent, 'Remove');

  // Even reporting a new phone without an intermediate unavailable render retires the old IDs.
  const oldPicture = 'data:image/jpeg;base64,QUFB';
  f.deliverThumb({ id: 'i1', data: oldPicture });
  assert.equal(f.tileById('i1').querySelector('img').src, oldPicture);
  f.state.hub.perm.media.trash = true;
  f.bigRemove.onclick();
  f.state.hub.deviceId = 'different-phone-with-overlapping-media-ids';
  f.state.hub.session++;
  f.bigRemove.onclick();
  assert.deepEqual(deletes(), [], 'an armed request is refused after a phone or session change');
  assert.equal(f.viewer.hidden, true);
  assert.deepEqual(f.tileIds(), []);
  f.deliverList(items, { phone: binding });
  assert.deepEqual(f.tileIds(), [], 'a queued reply from the previous phone is also refused');
  f.deliverList(items);
  f.deliverThumb({ id: 'i1', data: oldPicture, phone: binding });
  assert.equal(f.tileById('i1').querySelector('img').src, undefined, 'no cached or delayed thumbnail from a different phone');
  const replacementPicture = 'data:image/jpeg;base64,QkJC';
  f.deliverThumb({ id: 'i1', data: replacementPicture });
  assert.equal(f.tileById('i1').querySelector('img').src, replacementPicture);
  f.tileById('i1').onclick();

  // Failed Trash reply keeps previews and reports Trash failure wording.
  f.deliverDelete({ t: 'media.delete', ids: [], failed: 1, confirm: 0, action: 'trash' });
  assert.equal(f.viewer.hidden, false);
  assert.deepEqual(f.tileIds(), ['i1']);
  assert.equal(f.status.textContent, '1 couldn’t be moved to Trash');
});

function parseTransform(tr) {
  const m = /^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)$/.exec(tr || '');
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : { x: 0, y: 0, z: 1 };
}

function bindViewerRects(f, baseW = 400, baseH = 300, stageW = 400, stageH = 300) {
  f.viewerStage._rect = () => ({ left: 100, top: 50, right: 100 + stageW, bottom: 50 + stageH, width: stageW, height: stageH });
  f.bigImg._rect = () => {
    const { x, y, z } = parseTransform(f.bigImg.style.transform);
    const w = baseW * z;
    const h = baseH * z;
    const cx = 100 + stageW / 2 + x;
    const cy = 50 + stageH / 2 + y;
    return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, width: w, height: h };
  };
}

test('Viewer supports cursor-centered wheel zoom, double-click fit/reset, clamped drag-to-pan, and usable controls', () => {
  const f = mountMedia();
  bindViewerRects(f);
  f.deliverList([
    { id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 },
    { id: 'i2', video: false, at: localTs(2026, 11, 27, 11), name: 'IMG_2.jpg', size: 100 },
  ]);
  f.tileById('i1').onclick();
  const asksAfterOpen = f.asked.length;

  // Wheel zoom centered at (400, 200) — 100px right of unscaled center (300, 200).
  f.viewerStage.dispatch('wheel', { target: f.bigImg, deltaY: -200, deltaMode: 0, clientX: 400, clientY: 200 });
  const z1 = parseTransform(f.bigImg.style.transform);
  assert.ok(z1.z > 1.5 && z1.z <= 4, `zoomed in: ${z1.z}`);
  assert.equal(f.viewerStage.classList.contains('zoomed'), true);
  // Image point dx=+100 stays pinned under clientX=400: 300 + panX + z * 100 ≈ 400.
  assert.ok(Math.abs((300 + z1.x + z1.z * 100) - 400) < 1, 'cursor-centered zoom keeps point under cursor');
  assert.equal(f.asked.length, asksAfterOpen, 'zooming triggers no extra network requests');

  // Drag-to-pan moves and clamps cleanly within bounds.
  f.viewerStage.dispatch('pointerdown', { target: f.bigImg, button: 0, pointerId: 7, clientX: 300, clientY: 200 });
  assert.equal(f.viewerStage.classList.contains('panning'), true);
  f.viewerStage.dispatch('pointermove', { target: f.bigImg, pointerId: 7, clientX: 1200, clientY: -800 });
  const panned = parseTransform(f.bigImg.style.transform);
  const maxX = (400 * z1.z - 400) / 2;
  const maxY = (300 * z1.z - 300) / 2;
  assert.ok(Math.abs(panned.x - maxX) < 1, 'panX clamped to positive bound');
  assert.ok(Math.abs(panned.y + maxY) < 1, 'panY clamped to negative bound');
  f.viewerStage.dispatch('pointerup', { target: f.bigImg, pointerId: 7 });
  assert.equal(f.viewerStage.classList.contains('panning'), false);

  // Double-click while zoomed resets to fit; double-click at fit zooms in.
  f.viewerStage.dispatch('dblclick', { target: f.bigImg, clientX: 300, clientY: 200 });
  assert.equal(f.bigImg.style.transform, '');
  assert.equal(f.viewerStage.classList.contains('zoomed'), false);
  f.viewerStage.dispatch('dblclick', { target: f.bigImg, clientX: 300, clientY: 200 });
  assert.equal(parseTransform(f.bigImg.style.transform).z, 2);

  // Buttons and keyboard navigation remain usable while zoomed.
  f.viewerStage.dispatch('wheel', { target: f.nextBtn, deltaY: -100, deltaMode: 0, clientX: 520, clientY: 200 });
  assert.equal(parseTransform(f.bigImg.style.transform).z, 2, 'wheel on button ignored');
  f.doc.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(f.bigImg.style.transform, '', 'stepping via keyboard resets zoom');
  f.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.viewer.hidden, true, 'Escape closes viewer');
});

test('Viewer ignores drag at 1x, cancels pan on pointercancel, and clears zoom on load/close/filter/album/device changes', () => {
  const f = mountMedia();
  bindViewerRects(f);
  f.deliverAlbums([{ id: '1', name: 'Camera', n: 2, cover: 'i1' }]);
  f.deliverList([
    { id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 },
    { id: 'i2', video: false, at: localTs(2026, 11, 27, 11), name: 'IMG_2.jpg', size: 100 },
  ]);
  f.tileById('i1').onclick();

  // Dragging at 1x does not pan.
  f.viewerStage.dispatch('pointerdown', { target: f.bigImg, button: 0, pointerId: 1, clientX: 300, clientY: 200 });
  assert.equal(f.viewerStage.classList.contains('panning'), false);
  f.viewerStage.dispatch('pointermove', { target: f.bigImg, pointerId: 1, clientX: 380, clientY: 260 });
  assert.equal(f.bigImg.style.transform, '');

  // Zoom, start pan, then pointercancel releases capture cleanly.
  f.viewerStage.dispatch('dblclick', { target: f.bigImg, clientX: 300, clientY: 200 });
  f.viewerStage.dispatch('pointerdown', { target: f.bigImg, button: 0, pointerId: 2, clientX: 300, clientY: 200 });
  assert.equal(f.viewerStage.classList.contains('panning'), true);
  f.viewerStage.dispatch('pointercancel', { target: f.bigImg, pointerId: 2 });
  assert.equal(f.viewerStage.classList.contains('panning'), false);

  // Preview load (media.view) resets zoom cleanly.
  f.deliverView({ t: 'media.view', id: 'i1', data: 'data:image/jpeg;base64,AAAA' });
  assert.equal(f.bigImg.style.transform, '');

  // Filter, album, and device changes clear zoom.
  f.viewerStage.dispatch('dblclick', { target: f.bigImg, clientX: 300, clientY: 200 });
  assert.equal(f.viewerStage.classList.contains('zoomed'), true);
  f.clickFilter('Photos');
  assert.equal(f.bigImg.style.transform, '');
  f.deliverList([{ id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 }], { kind: 'photos' });
  f.tileById('i1').onclick();
  f.viewerStage.dispatch('dblclick', { target: f.bigImg, clientX: 300, clientY: 200 });
  f.albumList.children[1].onclick();
  assert.equal(f.bigImg.style.transform, '');
  f.deliverList([{ id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 }], { kind: 'photos', album: '1' });
  f.tileById('i1').onclick();
  f.viewerStage.dispatch('dblclick', { target: f.bigImg, clientX: 300, clientY: 200 });
  f.changeDevice();
  assert.equal(f.viewer.hidden, true);
  assert.equal(f.bigImg.style.transform, '');
});

function layoutGrid(f, cols = 2, tileSize = 100, scrollOffsetRef = { y: 0 }) {
  f.grid._rect = () => {
    const rows = Math.max(1, Math.ceil(f.tiles().length / cols));
    const top = 100 - scrollOffsetRef.y;
    return { left: 20, top, right: 20 + cols * tileSize, bottom: top + rows * tileSize, width: cols * tileSize, height: rows * tileSize };
  };
  f.tiles().forEach((t, idx) => {
    t._rect = () => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const left = 20 + col * tileSize;
      const top = 100 - scrollOffsetRef.y + row * tileSize;
      return { left, top, right: left + tileSize, bottom: top + tileSize, width: tileSize, height: tileSize };
    };
  });
}

test('Select mode drag-box draws clipped rectangle, additively intersects across scroll, preserves click, and disarms Remove', () => {
  const f = mountMedia({ canRemove: true });
  const scroll = { y: 0 };
  f.deliverList([
    { id: 'i1', video: false, at: localTs(2026, 11, 27, 12), name: 'IMG_1.jpg', size: 100 },
    { id: 'i2', video: false, at: localTs(2026, 11, 27, 11), name: 'IMG_2.jpg', size: 100 },
    { id: 'i3', video: false, at: localTs(2026, 11, 26, 12), name: 'IMG_3.jpg', size: 100 },
    { id: 'i4', video: false, at: localTs(2026, 11, 26, 11), name: 'IMG_4.jpg', size: 100 },
  ], { more: true, next: '1:4' });
  layoutGrid(f, 2, 100, scroll);

  // Enter Select mode, pick i1 by click, and arm Remove.
  f.selectBtn.onclick();
  f.tileById('i1').onclick();
  f.removeBtn.onclick();
  assert.equal(f.removeBtn.classList.contains('danger'), true);
  const asksBefore = f.asked.length;

  // Start drag on i2 (130, 130), scroll down by 80px mid-drag, drag past grid right edge to (400, 200) -> covers i2 and i4!
  f.grid.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 130, clientY: 130 });
  f.grid.dispatch('pointermove', { buttons: 1, pointerId: 3, clientX: 150, clientY: 150 });
  assert.equal(f.dragBox().hidden, false, 'drag box visible once past threshold');
  scroll.y = 80;
  f.contentEl.dispatch('scroll');
  f.grid.dispatch('pointermove', { buttons: 1, pointerId: 3, clientX: 400, clientY: 200 });
  // Clipped to grid right edge (20 + 200 = 220 -> width 220 - 130 = 90px).
  assert.equal(f.dragBox().style.left, '110px');
  assert.equal(f.dragBox().style.width, '90px');
  f.grid.dispatch('pointerup', { button: 0, pointerId: 3 });

  assert.equal(f.dragBox().hidden, true);
  assert.deepEqual(f.chosenIds(), ['i1', 'i2', 'i4'], 'additive intersection kept i1 and added i2 + i4 across scroll');
  assert.equal(f.removeBtn.classList.contains('danger'), false, 'armed Remove disarmed on changed selection');
  assert.equal(f.asked.length, asksBefore, 'drag-box never fetches more pages');

  // Post-drag click is suppressed once, then normal click toggle still works.
  const suppressed = f.grid.dispatch('click', {});
  assert.equal(suppressed.defaultPrevented, true);
  f.tileById('i2').onclick();
  assert.deepEqual(f.chosenIds(), ['i1', 'i4']);
});

test('Select mode drag-box handles pointercancel and enforces 300-item cap without silent truncation', () => {
  const f = mountMedia({ canRemove: true });
  const makeItems = (count) => Array.from({ length: count }, (_, idx) => ({
    id: `i${idx + 1}`, video: false, at: localTs(2026, 11, 27, 18) - idx * 1000, name: `IMG_${idx + 1}.jpg`, size: 10,
  }));
  f.deliverList(makeItems(305));
  layoutGrid(f, 5, 20);

  f.selectBtn.onclick();
  f.tileById('i1').onclick();
  f.removeBtn.onclick();
  assert.equal(f.removeBtn.classList.contains('danger'), true);

  // Pointer cancellation hides box and leaves selection & armed Remove untouched.
  f.grid.dispatch('pointerdown', { button: 0, pointerId: 4, clientX: 25, clientY: 105 });
  f.grid.dispatch('pointermove', { buttons: 1, pointerId: 4, clientX: 80, clientY: 120 });
  assert.equal(f.dragBox().hidden, false);
  f.grid.dispatch('pointercancel', { pointerId: 4 });
  assert.equal(f.dragBox().hidden, true);
  assert.deepEqual(f.chosenIds(), ['i1']);
  assert.equal(f.removeBtn.classList.contains('danger'), true, 'cancelled drag keeps armed Remove unchanged');

  // If the button went up outside the grid before capture, re-entry is a hover only.
  f.grid.dispatch('pointerdown', { button: 0, pointerId: 6, clientX: 25, clientY: 105 });
  f.grid.dispatch('pointermove', { buttons: 0, pointerId: 6, clientX: 80, clientY: 120 });
  assert.equal(f.dragBox().hidden, true);
  f.grid.dispatch('pointerup', { button: 2, pointerId: 6 });
  assert.deepEqual(f.chosenIds(), ['i1'], 'hover and right-click cannot finish an abandoned drag');

  // Dragging over all 305 loaded items refuses exceeding 300 with clear feedback.
  f.grid.dispatch('pointerdown', { button: 0, pointerId: 5, clientX: 20, clientY: 100 });
  f.grid.dispatch('pointermove', { buttons: 1, pointerId: 5, clientX: 200, clientY: 2000 });
  assert.equal(f.selectionLimit.textContent, 'Can’t select more than 300 items at once');
  f.grid.dispatch('pointerup', { button: 0, pointerId: 5 });
  assert.deepEqual(f.chosenIds(), ['i1'], 'never silently truncates over-limit drag selection');
  assert.equal(f.selectionLimit.textContent, 'Can’t select more than 300 items at once');
});
