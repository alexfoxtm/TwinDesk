// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Linux Full KVM (#311): with Full KVM enabled on Linux, keep the input lane on JS from startup
// through delayed service connection and reconnect so the app's own helper never binds a native
// lane that survives service takeover (receiving motion while the service owns armReturn).
// Run with: node shared/test/fullkvm-linux-lane.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { InputLane, LaneDriven, MoveTotals } = require('../inputlane.js');

const REAL_PLATFORM = process.platform;
const EDITION_PATH = require.resolve('../edition.js');
const ROUTE_PATH = require.resolve('../fullkvm/route.js');

function waitFor(cond, what, ms = 3000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const poll = () => {
      if (cond()) return resolve();
      if (Date.now() > end) return reject(new Error('timed out: ' + what));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function setPlatform(plat) {
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
}

class FakeOwnHelper extends EventEmitter {
  constructor() {
    super();
    this.proc = {};
    this.backend = 'x11';
    this.sent = [];
    this.moves = [];
    this.requests = [];
  }

  send(cmd, args = {}) {
    this.sent.push({ cmd, args });
    return true;
  }

  sendMove(dx, dy) {
    this.moves.push({ dx, dy });
    return true;
  }

  request(cmd, args = {}) {
    this.requests.push({ cmd, args });
    if (cmd === 'lane') return Promise.resolve({ ok: true, port: 47871, ...(args.lane ? { lane: args.lane } : {}) });
    return Promise.resolve({ ok: true, from: 'own', cmd });
  }
}

async function createStubService(sockPath) {
  const received = [];
  const sockets = new Set();
  let current = null;

  const server = net.createServer((sock) => {
    sockets.add(sock);
    current = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        received.push(msg);
        if (msg.id !== undefined) {
          sock.write(JSON.stringify({ id: msg.id, ok: true, from: 'service', cmd: msg.cmd }) + '\n');
        }
      }
    });
    sock.on('close', () => {
      sockets.delete(sock);
      if (current === sock) current = null;
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    received,
    connected: () => !!current,
    sendReady(backend = 'uinput') {
      assert.ok(current, 'stub service has a connected client');
      current.write(JSON.stringify({ event: 'ready', backend }) + '\n');
    },
    sendEvent(event, extra = {}) {
      assert.ok(current, 'stub service has a connected client');
      current.write(JSON.stringify({ event, ...extra }) + '\n');
    },
    disconnect() {
      if (current) current.destroy();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function loadRoute(sockPath, { platform, moduleOff = false }) {
  const prevSock = process.env.TWINDESK_KVM_SOCK;
  const prevNo = process.env.TWINDESK_NO_FULLKVM;
  setPlatform(platform);
  process.env.TWINDESK_KVM_SOCK = sockPath;
  delete process.env.TWINDESK_NO_FULLKVM;
  delete require.cache[EDITION_PATH];
  delete require.cache[ROUTE_PATH];
  const edition = require(EDITION_PATH);
  edition.moduleOff(moduleOff);
  const route = require(ROUTE_PATH);
  return {
    FullKvmHelper: route(FakeOwnHelper),
    restore() {
      edition.moduleOff(false);
      setPlatform(REAL_PLATFORM);
      if (prevSock === undefined) delete process.env.TWINDESK_KVM_SOCK;
      else process.env.TWINDESK_KVM_SOCK = prevSock;
      if (prevNo === undefined) delete process.env.TWINDESK_NO_FULLKVM;
      else process.env.TWINDESK_NO_FULLKVM = prevNo;
      delete require.cache[EDITION_PATH];
      delete require.cache[ROUTE_PATH];
    },
  };
}

function makeSockDir() {
  const base = REAL_PLATFORM !== 'win32' && path.join(os.tmpdir(), 'fk-XXXXXX', 'k.s').length > 96 ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'fk-'));
}

test('Linux Full KVM stays on the JS lane across startup, delayed service ready, and reconnect', async (t) => {
  const dir = makeSockDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = REAL_PLATFORM === 'win32'
    ? `\\\\.\\pipe\\td-fk-linux-${process.pid}-${Date.now()}`
    : path.join(dir, 'k.s');
  const stub = await createStubService(sockPath);
  const loaded = loadRoute(sockPath, { platform: 'linux', moduleOff: false });
  const helper = new loaded.FullKvmHelper();
  const lane = new InputLane();
  const directLane = new InputLane();

  t.after(async () => {
    lane.close();
    directLane.close();
    if (helper.svc) helper.svc.stop();
    await stub.close();
    loaded.restore();
  });

  await lane.bind();
  await waitFor(() => stub.connected(), 'stub service socket connected');
  assert.equal(helper.viaService, false, 'service has not emitted ready yet');

  // Startup before service ready: native lane binds must be rejected on Linux Full KVM.
  const boundAtStartup = await lane.useNativeLane(helper, 1);
  assert.equal(boundAtStartup, false, 'Linux Full KVM must stay on JS lane before service connects');
  assert.equal(Boolean(lane.native), false, 'lane must not become native before service connects');
  assert.equal(lane._natPending || null, null, 'no pending native lane swap');
  assert.equal(await directLane.useNative(helper), false, 'one-to-one also keeps its JS lane');
  assert.equal(Boolean(directLane.native), false);
  assert.equal(helper.requests.filter((r) => r.cmd === 'lane').length, 0, 'own helper never receives lane bind');

  // Ordinary requests, motion, and armReturn still route to the active own helper before service ready.
  assert.deepEqual(await helper.request('imGet', {}), { ok: true, from: 'own', cmd: 'imGet' });
  assert.deepEqual(await helper.request('info', {}), { ok: true, from: 'own', cmd: 'info' });
  helper.send('armReturn', { on: true, side: 'left' });
  helper.sendMove(5, -2);
  assert.equal(helper.sent.filter((s) => s.cmd === 'armReturn').length, 1);
  assert.deepEqual(helper.moves, [{ dx: 5, dy: -2 }]);

  // Delayed service takeover: service emits ready; motion and armReturn both route to the service.
  let readyCount = 0;
  const returns = [];
  helper.on('ready', () => { readyCount++; });
  helper.on('event', (name, msg) => { if (name === 'return') returns.push(msg); });
  stub.sendReady('uinput');
  await waitFor(() => helper.viaService && readyCount === 1, 'service takeover ready');
  assert.equal(helper.kvmBackend, 'uinput');
  assert.equal(await lane.useNativeLane(helper, 1), false, 'still JS lane after service takeover');
  assert.equal(Boolean(lane.native), false);

  const ownMovesBefore = helper.moves.length;
  const driven = new LaneDriven({
    route: () => 7,
    move: (dx, dy) => helper.sendMove(dx, dy),
    deliver: () => {},
    native: () => (lane.native ? lane : null),
  });
  const totals = new MoveTotals();
  totals.reset(7);
  driven.take(7);
  helper.send('armReturn', { on: true, side: 'left', sides: ['left'] });
  driven.move(totals.add(12, -4));

  await waitFor(
    () => stub.received.some((m) => m.cmd === 'armReturn' && m.on === true)
      && stub.received.some((m) => m.cmd === 'inject' && m.ev && m.ev.t === 'k.mm' && m.ev.dx === 12 && m.ev.dy === -4),
    'service receives both armReturn and JS-lane motion',
  );
  assert.equal(helper.moves.length, ownMovesBefore, 'own helper gets no motion while service owns KVM');
  assert.deepEqual(await helper.request('imGet', {}), { ok: true, from: 'own', cmd: 'imGet' }, 'non-KVM request stays on own helper');
  const svcInfo = await helper.request('info', {});
  assert.equal(svcInfo.ok, true, 'KVM request succeeds via service');
  assert.equal(svcInfo.from, 'service', 'KVM request routes to service');
  assert.equal(svcInfo.cmd, 'info', 'KVM request preserves command');

  stub.sendEvent('return', { side: 'left', offset: 0.5 });
  await waitFor(() => returns.length === 1, 'return event delivered from service');
  assert.equal(returns[0].side, 'left');

  // Disconnect and reconnect: lane stays JS across disconnect window and returns cleanly to service.
  stub.disconnect();
  await waitFor(() => !helper.viaService && readyCount === 2, 'service disconnect fallback to own helper');
  assert.equal(await lane.useNativeLane(helper, 1), false, 'still JS lane while service is disconnected');
  assert.equal(Boolean(lane.native), false);
  helper.send('armReturn', { on: true, side: 'right' });
  helper.sendMove(-3, 6);
  assert.deepEqual(helper.moves.at(-1), { dx: -3, dy: 6 }, 'motion falls back to own helper when service is gone');

  stub.received.length = 0;
  await waitFor(() => stub.connected(), 'stub service reconnected on its own', 6000);
  stub.sendReady('uinput');
  await waitFor(() => helper.viaService && readyCount === 3, 'service reconnect ready');
  assert.equal(Boolean(lane.native), false, 'lane stays JS after service reconnect');
  helper.send('armReturn', { on: true, side: 'left' });
  driven.move(totals.add(8, 2));
  await waitFor(
    () => stub.received.some((m) => m.cmd === 'armReturn' && m.on === true)
      && stub.received.some((m) => m.cmd === 'inject' && m.ev && m.ev.dx === 8 && m.ev.dy === 2),
    'reconnected service receives both armReturn and motion',
  );
  assert.equal(helper.requests.filter((r) => r.cmd === 'lane').length, 0, 'own helper never bound a native lane');
});

test('Linux Full KVM module-off and Windows preserve existing native lane and routing behavior', async (t) => {
  const dir = makeSockDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = REAL_PLATFORM === 'win32'
    ? `\\\\.\\pipe\\td-fk-win-${process.pid}-${Date.now()}`
    : path.join(dir, 'w.s');

  // 1. Linux with General > Modules > Full KVM off: native lane works as default.
  const offLoaded = loadRoute(sockPath, { platform: 'linux', moduleOff: true });
  const offHelper = new offLoaded.FullKvmHelper();
  const offLane = new InputLane();
  try {
    await offLane.bind();
    assert.equal(offHelper.svc, null, 'module-off creates no service link');
    assert.equal(offHelper.viaService, false);
    assert.equal(await offLane.useNativeLane(offHelper, 2), true, 'module-off keeps native lane');
    assert.equal(offLane.native, true);
    assert.equal(offLane.port, 47871);
    assert.deepEqual(await offHelper.request('info', {}), { ok: true, from: 'own', cmd: 'info' });
    offHelper.send('armReturn', { on: true, side: 'left' });
    offHelper.sendMove(2, 3);
    assert.equal(offHelper.sent.some((s) => s.cmd === 'armReturn'), true);
    assert.deepEqual(offHelper.moves, [{ dx: 2, dy: 3 }]);
  } finally {
    offLane.close();
    offLoaded.restore();
  }

  // 2. Windows Full KVM: preserves pre-ready native bind and post-ready service rejection.
  const stub = await createStubService(sockPath);
  const winLoaded = loadRoute(sockPath, { platform: 'win32', moduleOff: false });
  const winHelper = new winLoaded.FullKvmHelper();
  t.after(async () => {
    if (winHelper.svc) winHelper.svc.stop();
    await stub.close();
    winLoaded.restore();
  });

  await waitFor(() => stub.connected(), 'Windows stub service socket connected');
  assert.equal(winHelper.viaService, false);
  assert.deepEqual(
    await winHelper.request('lane', { op: 'bind', lane: 3 }),
    { ok: true, port: 47871, lane: 3 },
    'Windows preserves pre-ready native lane request routing',
  );
  assert.deepEqual(await winHelper.request('info', {}), { ok: true, from: 'own', cmd: 'info' });

  stub.sendReady('win');
  await waitFor(() => winHelper.viaService, 'Windows stub service ready');
  await assert.rejects(() => winHelper.request('lane', { op: 'bind', lane: 4 }), /no native lane through Full KVM/);
  assert.deepEqual(await winHelper.request('imGet', {}), { ok: true, from: 'own', cmd: 'imGet' });
  const winSvcInfo = await winHelper.request('info', {});
  assert.equal(winSvcInfo.ok, true);
  assert.equal(winSvcInfo.from, 'service');
  assert.equal(winSvcInfo.cmd, 'info');
  winHelper.send('armReturn', { on: true, side: 'left' });
  winHelper.sendMove(9, -1);
  await waitFor(
    () => stub.received.some((m) => m.cmd === 'armReturn' && m.on === true)
      && stub.received.some((m) => m.cmd === 'inject' && m.ev && m.ev.dx === 9 && m.ev.dy === -1),
    'Windows service receives armReturn and motion once connected',
  );
});
