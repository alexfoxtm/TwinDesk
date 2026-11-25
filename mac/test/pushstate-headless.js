// With no control window, pushState still does the work that is not for that window
// (tray, screen state, lock view, preview shots, the lock key, file shortcuts, pair sync)
// and does not build the window snapshots. Run: node mac/test/pushstate-headless.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = main.indexOf('let pushQueued = false;');
const end = main.indexOf('// Tell the viewer what we share', start);
assert.ok(start > 0 && end > start, 'pushState in mac/main.js');
const source = main.slice(start, end);

function bag() {
  const fn = function () { return bag(); };
  return new Proxy(fn, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (typeof key === 'symbol') return undefined;
      return bag();
    },
  });
}

function run({ win }) {
  const calls = [];
  let windowBuilds = 0;
  const slot = { win };
  const touch = (name) => {
    windowBuilds += 1;
    calls.push(name);
    return {};
  };
  const counted = (name) => ({
    get view() { return touch(name); },
    view() { return touch(name); },
    state: {},
  });
  const svcTarget = {
    kvm: { get view() { return { where: 'home' }; }, server: { current: { id: 'phone' } } },
    fileClip: { syncConnected(on) { calls.push(['clip', !!on]); }, get view() { return {}; } },
    notifs: counted('notifs'),
    history: counted('history'),
    chats: { ...counted('chats'), messaging: () => false },
    googleMessages: { sync() {}, view: () => null },
    drop: counted('drop'),
    fileSend: counted('fileSend'),
  };
  const svc = new Proxy(svcTarget, {
    get(target, key) {
      if (key in target) return target[key];
      return bag();
    },
  });
  const state = { helper: {}, notifs: { stale: true } };
  const sent = [];
  const box = {
    server: { lockviewRefresh() { calls.push('lockview'); } },
    setImmediate(fn) { fn(); },
    get win() { return slot.win; },
    peer: { current: { deviceId: 'phone', name: 'Phone', os: 'android', role: 'guest', address: '10.0.0.8', rttMs: 12, transport: 'ip' }, il: null, lane() { return null; }, fx: null, fx2: null },
    state,
    interfaces() { return [{ name: 'en0', address: '10.0.0.2' }]; },
    settings: {
      modules: {}, net: { hotspots: {}, ble: true, relay: {} }, sharing: { on: false, remote: true }, virtual: {},
      audio: {}, streamInput: true, kvm: {}, keys: { lockKeys: '' }, clipboard: {}, camera: {}, rezume: {}, ui: {}, app: {},
      terminal: {}, files: {}, drive: {}, notifs: {}, smb: {}, apps: {}, receive: {}, papps: {}, phone: {}, mount: {},
      hub: {}, web: {}, localsend: {}, bitrateMbps: 8, streamMaxHeight: 0,
    },
    Mods: { view() { return {}; } },
    modulesAtStart: [],
    pairing: { pendingView() { return null; }, list() { return []; } },
    discovery: { status: { on: true }, list() { calls.push('found'); return [{ id: 'pc', name: 'PC', os: 'mac' }]; } },
    link: { view() { return { status: {}, hosts: [] }; } },
    svc,
    lanType() { return 'wifi'; },
    P: { isPhoneOs: (os) => os === 'android' || os === 'ios' },
    displayMode() { return 'mirror'; },
    Look: { view() { return {}; } },
    systemPreferences: {},
    Engines: { snapshot() { return {}; } },
    lockKey: { sync() { calls.push('lockKey'); }, error: '' },
    path: require('node:path'),
    phoneHub: null,
    photoBackup: { view() { return touch('photoBackup'); } },
    updates: null,
    web: null,
    localsend: null,
    pairSync: { check() { calls.push('pair'); } },
    sendScreenState() { calls.push('screen'); },
    updateTray() { calls.push('tray'); },
    require: (id) => require(path.join(__dirname, '..', id)),
  };
  const attach = (w) => {
    if (w && !w.webContents) w.webContents = { send(ch, body) { sent.push([ch, body]); } };
  };
  attach(slot.win);
  const sandbox = new Proxy(box, {
    has() { return true; },
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return undefined;
      return bag();
    },
  });
  vm.runInNewContext(source, sandbox);
  box.pushState();
  return {
    calls, get windowBuilds() { return windowBuilds; }, state, sent,
    setWindow(w) { attach(w); slot.win = w; },
    push() { box.pushState(); },
  };
}

test('no control window skips the window snapshots and still runs the side effects', () => {
  const headless = run({ win: null });
  assert.equal(headless.windowBuilds, 0, 'notifs, history, chats and the other window snapshots are not built');
  assert.equal(headless.state.notifs.stale, true, 'the previous window snapshot is left untouched');
  assert.equal(headless.state.client && headless.state.client.name, 'Phone');
  assert.deepEqual(headless.state.found.map((d) => d.id), ['pc']);
  assert.equal(headless.state.input.where, 'home');
  for (const step of ['lockview', 'lockKey', 'screen', 'tray', 'pair', 'found']) {
    assert.ok(headless.calls.includes(step), step);
  }
  assert.deepEqual(headless.calls.filter((c) => Array.isArray(c) && c[0] === 'clip'), [['clip', true]]);
  assert.equal(headless.sent.length, 0);

  const open = run({ win: { isDestroyed: () => false } });
  assert.ok(open.windowBuilds > 0, 'an open window still gets the snapshots');
  assert.equal(open.sent.length, 1);
  assert.equal(open.sent[0][0], 'state');
  assert.ok(open.calls.includes('screen') && open.calls.includes('tray') && open.calls.includes('lockview'));
});

test('a window opened after a headless push gets a full state', () => {
  const live = run({ win: null });
  assert.equal(live.windowBuilds, 0);
  assert.equal(live.sent.length, 0);
  assert.equal(live.state.notifs.stale, true);
  assert.equal(live.state.addresses, undefined, 'the headless push did not build the window fields');
  live.setWindow({ isDestroyed: () => false });
  live.push();
  assert.ok(live.windowBuilds > 0, 'the next push builds the window snapshots');
  assert.equal(live.sent.length, 1);
  assert.equal(live.sent[0][0], 'state');
  assert.equal(live.sent[0][1], live.state);
  assert.equal(live.state.client.name, 'Phone');
  assert.ok(Array.isArray(live.state.addresses) && live.state.addresses.includes('10.0.0.2'));
  assert.equal(live.state.notifs.stale, undefined, 'the stale headless snapshot is not what the window is sent');
  assert.ok(live.state.chats && live.state.history && live.state.photoBackup);
});
