// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's incoming wheel events with the real IPC, store and KVM listeners.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { InputLane } = require('../inputlane.js');

const ipcMain = Object.assign(new EventEmitter(), { handle() {} });
const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ id: 1 }),
  getAllDisplays: () => [],
});
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { ipcMain, screen };
  return load.call(this, id, ...args);
};

async function verify(dir, mesh) {
  const base = mesh ? '../../mac/mesh' : '../../mac';
  const store = require(base + '/store');
  const { setupIpc } = require(base + '/ipc');
  const { Kvm } = require(base + '/kvm');
  store.init(dir);
  store.write('settings.json', { kvm: { speed: 2 } }); // a profile saved before this preference existed
  const settings = store.loadSettings();
  assert.equal(settings.kvm.scrollSpeed, 1);

  const injected = [];
  const helper = Object.assign(new EventEmitter(), {
    send(cmd, args) { if (cmd === 'inject') injected.push(args.ev); },
    async request(cmd, args) { if (cmd === 'lane') return { port: 47871, lane: args.lane }; },
  });
  const lane = new InputLane();
  const server = Object.assign(new EventEmitter(), { il: lane, lane: () => lane });
  const bus = Object.assign(new EventEmitter(), { onPeer() {} });
  const hub = Object.assign(new EventEmitter(), { bus, sessions: new Map([['pc', server]]) });
  const kvm = new Kvm({
    server, hub, helper,
    getSettings: () => settings,
    fileSend: new EventEmitter(),
    drop: { dragIn: {} },
  });
  // The PC already owns the cursor. Deliver messages as the authenticated session does.
  Object.assign(kvm, { mode: 'driven', partner: 'pc', peerRoute: 9 });
  const wire = (m) => mesh ? bus.emit(m.t, m, 'pc') : server.emit('t:' + m.t, m);
  const wheel = { t: 'k.wh', dx: 1, dy: -2, mode: 'line' };
  ipcMain.removeAllListeners('setKvm');
  setupIpc({ settings, server, state: { connect: {} }, pushState() {}, kvm: { settingsChanged() {} } });
  const setKvm = (partial) => ipcMain.emit('setKvm', {}, partial);

  try {
    // Default, then reversed line notches via the legacy wire and numbered pixel deltas via the lane.
    wire(wheel);
    setKvm({ scrollSpeed: 3, reverseScroll: true });
    assert.equal(store.loadSettings().kvm.scrollSpeed, 3);
    assert.ok(mesh ? await lane.useNativeLane(helper, 1) : await lane.useNative(helper));
    assert.ok(lane.offer({ v: 1, port: 47872 }, '127.0.0.1'));
    wire(wheel);
    const first = { ...wheel, es: 1, route: 9 };
    const second = { ...first, es: 2, dx: -1.25, dy: 0.5, mode: 'pixel' };
    helper.emit('event', 'laneEv', { msg: second, ...(mesh ? { lane: 1 } : {}) });
    assert.equal(injected.length, 2, 'the lane holds a wheel event until its predecessor');
    wire(first);
    assert.deepEqual(injected, [
      wheel,
      { ...wheel, dx: -3, dy: 6 },
      { ...wheel, dx: -3, dy: 6 },
      { t: 'k.wh', dx: 3.75, dy: -1.5, mode: 'pixel' },
    ]);
    wire(second);
    assert.equal(injected.length, 4, 'the wire duplicate does not inject the lane event again');

    // Fractional values from IPC or disk fall back to the original speed.
    setKvm({ scrollSpeed: 2.5 });
    assert.equal(settings.kvm.scrollSpeed, 1);
    wire(wheel);
    assert.deepEqual(injected.at(-1), { ...wheel, dx: -1, dy: 2 });
    store.write('settings.json', { kvm: { scrollSpeed: 2.5 } });
    assert.equal(store.loadSettings().kvm.scrollSpeed, 1);
  } finally {
    lane.close();
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-scroll-speed-'));
  try {
    await verify(path.join(dir, 'direct'), false);
    await verify(path.join(dir, 'mesh'), true);
    console.log('mac-scroll-speed: direct and Mesh IPC, profile and ordered wheel input passed');
  } finally {
    Module._load = load;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
