// No state is sent while the settings window is covered, minimized or hidden,
// and one fresh state is due when it becomes visible again. The 5 s address
// poll does not run when the interface list is unchanged.
// Run: node mac/test/win-visible.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createWatch, watching } = require('../win-watch.js');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

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

// The same slice as mac/test/pushstate-headless.js, with a real visibility watch.
function run({ win, controlWatch }) {
  const start = main.indexOf('let pushQueued = false;');
  const end = main.indexOf('// Tell the viewer what we share', start);
  assert.ok(start > 0 && end > start, 'pushState in mac/main.js');
  const calls = [];
  const sent = [];
  const slot = { win };
  const touch = (name) => { calls.push(name); return {}; };
  const counted = (name) => ({ get view() { return touch(name); }, view() { return touch(name); }, state: {} });
  const svcTarget = {
    kvm: { get view() { return { where: 'home' }; }, server: { current: { id: 'phone' } } },
    fileClip: { syncConnected(on) { calls.push(['clip', !!on]); }, get view() { return {}; } },
    notifs: counted('notifs'), history: counted('history'), chats: counted('chats'),
    drop: counted('drop'), fileSend: counted('fileSend'),
  };
  const svc = new Proxy(svcTarget, { get(target, key) { return key in target ? target[key] : bag(); } });
  const box = {
    server: { lockviewRefresh() { calls.push('lockview'); } },
    setImmediate(fn) { fn(); },
    get win() { return slot.win; },
    controlWatch,
    peer: { current: { deviceId: 'phone', name: 'Phone', os: 'android', role: 'guest', address: '10.0.0.8', rttMs: 12, transport: 'ip' }, il: null, lane() { return null; }, fx: null, fx2: null },
    state: { helper: {}, notifs: { stale: true } },
    interfaces() { return [{ name: 'en0', address: '10.0.0.2' }]; },
    settings: {
      modules: {}, net: { hotspots: {}, ble: true, relay: {} }, sharing: { on: false, remote: true }, virtual: {},
      audio: {}, streamInput: true, kvm: {}, keys: { lockKeys: '' }, clipboard: {}, camera: {}, rezume: {}, ui: {}, app: {},
      terminal: {}, files: {}, drive: {}, notifs: {}, smb: {}, apps: {}, receive: {}, papps: {}, phone: {}, mount: {},
      hub: {}, web: {}, localsend: {}, bitrateMbps: 8, streamMaxHeight: 0,
    },
    Mods: { view() { return {}; } }, modulesAtStart: [],
    pairing: { pendingView() { return null; }, list() { return []; } },
    discovery: { status: { on: true }, list() { calls.push('found'); return []; } },
    link: { view() { return { status: {}, hosts: [] }; } },
    svc, lanType() { return 'wifi'; },
    P: { isPhoneOs: (os) => os === 'android' || os === 'ios' },
    displayMode() { return 'mirror'; },
    Look: { view() { return {}; } }, systemPreferences: {},
    Engines: { snapshot() { return {}; } },
    lockKey: { sync() { calls.push('lockKey'); }, error: '' },
    path: require('node:path'), phoneHub: null,
    photoBackup: { view() { return touch('photoBackup'); } },
    updates: null, web: null, localsend: null,
    pairSync: { check() { calls.push('pair'); } },
    sendScreenState() { calls.push('screen'); },
    updateTray() { calls.push('tray'); },
    require: (id) => require(path.join(__dirname, '..', id)),
  };
  if (slot.win && !slot.win.webContents) slot.win.webContents = { send(ch, body) { sent.push([ch, body]); } };
  const sandbox = new Proxy(box, {
    has() { return true; },
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return undefined;
      return bag();
    },
  });
  vm.runInNewContext(main.slice(start, end), sandbox);
  box.pushState();
  return { calls, sent, push() { box.pushState(); } };
}

function covered() {
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
}

test('watching follows occlusion, hide and minimize, and an unreported page still counts', () => {
  const shown = covered();
  assert.equal(watching(shown, null), true);
  assert.equal(watching(shown, true), true);
  assert.equal(watching(shown, false), false, 'covered: the page is hidden, isVisible() stays true');
  assert.equal(watching({ isDestroyed: () => false, isVisible: () => false, isMinimized: () => false }, true), false);
  assert.equal(watching({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => true }, true), false);
  assert.equal(watching({ isDestroyed: () => true, isVisible: () => true }, true), false);
  assert.equal(watching({ isDestroyed: () => false }, null), true, 'a window with no visibility flags still receives state');
});

test('becoming visible asks for one push, and a second report does not', () => {
  const win = covered();
  const watch = createWatch();
  assert.equal(watch.note(win, false), false);
  assert.equal(watch.watching(win), false);
  assert.equal(watch.note(win, true), true, 'covered to visible');
  assert.equal(watch.note(win, true), false, 'already visible');
  watch.unsee();
  assert.equal(watch.note(win, null), true, 'shown again before the page reports');
  assert.equal(watch.note(win, null), false);
  watch.note(win, false);
  watch.unsee();
  assert.equal(watch.note(win, null), false, 'show does not forget a page that is still hidden');
  assert.equal(watch.note(win, true), true, 'the page reporting visible is the one push');
  watch.unsee();
  win.isMinimized = () => true;
  assert.equal(watch.note(win, true), false, 'still minimized');
  win.isMinimized = () => false;
  assert.equal(watch.note(win, null), true, 'restored');
});

test('no state push while the window is covered, and one when it becomes visible', () => {
  const win = covered();
  const watch = createWatch();
  watch.note(win, false);
  const live = run({ win, controlWatch: watch });
  assert.equal(live.sent.length, 0, 'covered window is not sent state');
  assert.ok(live.calls.includes('tray') && live.calls.includes('screen') && live.calls.includes('lockview'), 'tray and screen still update');
  live.push();
  assert.equal(live.sent.length, 0, 'a later push while covered still does not send');
  assert.equal(watch.note(win, true), true);
  live.push();
  assert.equal(live.sent.length, 1, 'one fresh state as it becomes visible');
  assert.equal(live.sent[0][0], 'state');
  live.push();
  assert.equal(live.sent.length, 2, 'while it stays visible the 1 Hz push still sends');
});

test('a minimized or hidden window is not sent state', () => {
  const watch = createWatch();
  const mini = run({
    win: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => true },
    controlWatch: watch,
  });
  assert.equal(mini.sent.length, 0, 'minimized');
  const hidden = run({
    win: { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false },
    controlWatch: createWatch(),
  });
  assert.equal(hidden.sent.length, 0, 'hidden');
});

test('the main process gates the window send, the rtt push and the address poll', () => {
  assert.match(main, /controlWatch\.watching\(win\)/, 'pushState sends only while the window is watched');
  assert.match(main, /control-visible/, 'the renderer reports document.visibilityState');
  assert.match(main, /controlWatch\.note\(win, visible\)/, 'show, restore and the page report push once on the edge');
  assert.match(main, /controlWatch\.unsee\(\)/, 'hide and minimize arm that edge');
  assert.match(main, /function pushWatched\(\)/);
  assert.match(main, /server\.on\('rtt', \(ctx\) => \{[\s\S]*?pushWatched\(\)/, 'rtt does not build a state while nobody is looking');
  assert.match(main, /peer\.on\('rtt', pushWatched\)/);
  const addr = main.slice(main.indexOf('let addrKey'));
  assert.match(addr, /if \(key === addrKey\) return;/, 'an unchanged interface list does not spawn route or push');
  assert.doesNotMatch(addr.slice(0, addr.indexOf('}, 5000)')), /isVisible\(\)/, 'the address poll is not "every 5 s while visible"');
});
