// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Production Server route + lock adapter with disposable sockets; no credentials or OS changes.
'use strict';
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const net = require('net');
const { spawnSync } = require('child_process');
process.env.NODE_PATH = [process.env.NODE_PATH, path.join(__dirname, '../../mac/node_modules')].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();
const { Server } = require('../../mac/server');
const { startLockView, verifyScreenSharingPeer, lockedConsole, ownsTuple, servicePid, readLocked, primaryView } = require('../../mac/lockview');
const { LockTunnel, ArdGate } = require('../locktunnel');
const P = require('../protocol');
const REQUEST = 'ab'.repeat(16);
const turn = () => new Promise(setImmediate);

class Socket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(data, opts, cb) { this.sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : JSON.parse(data)); if (cb) cb(); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}
class Tcp extends EventEmitter {
  constructor() { super(); this.written = []; this.writableLength = 0; }
  write(data) { this.written.push(data); return !this.blocked; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  setNoDelay() {}
  destroy() { this.destroyed = true; }
}
function fixture(permitted = true, options = {}) {
  const server = Object.create(Server.prototype);
  EventEmitter.call(server);
  Object.assign(server, { sockets: new Set(), wss: { close() {} }, https: { close() {} } });
  const control = new Socket();
  const ctx = { ws: control, authed: true, deviceId: 'phone', os: 'android', transport: 'ip',
    resumeKey: 'session-generation', address: '100.70.0.2', released: false };
  control.ctx = ctx;
  server.current = ctx;
  server.sockets.add(ctx);
  const power = new EventEmitter(), connections = [];
  let allowed = permitted;
  const adapter = startLockView({ server, powerMonitor: power, remoteAllowed: () => allowed,
    readLock: async () => true, probe: async () => true, verifyPeer: async () => true, metadata: () => ({}), screens: null,
    connect: (target) => { const tcp = new Tcp(); connections.push({ target, tcp }); return tcp; }, ...options });
  const send = (msg, from = ctx) => server._onMessage(from, Buffer.from(JSON.stringify(msg)), false, from.ws);
  const accept = (ticket, extra = {}) => {
    const ws = new Socket();
    server._onConnection(ws, { url: P.LOCK_PATH, headers: { [P.LOCK_TICKET_HEADER]: ticket }, socket: { remoteAddress: ctx.address }, ...extra });
    return ws;
  };
  return { server, ctx, control, power, connections, adapter, send, accept,
    permit(on) { allowed = on; server.lockviewRefresh(); } };
}
async function open(f) {
  await turn();
  f.send({ t: P.T.LOCK_OPEN, request: REQUEST });
  await turn();
  const ticket = f.control.sent.findLast((m) => m.t === P.T.LOCK_TICKET);
  assert(ticket, 'current paired Android receives a ticket');
  return ticket;
}

async function until(fn) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > 2000) throw new Error('fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

// Real TCP framing and teardown; only the WSS endpoint and OS-identity query are disposable doubles.
async function wireCase(trusted, selection) {
  const sockets = new Set(), received = [];
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let version = Buffer.alloc(0), phase = 'version';
    socket.write('RFB 00');
    setImmediate(() => { if (!socket.destroyed) socket.write('3.889\n'); });
    socket.on('data', (bytes) => {
      received.push(Buffer.from(bytes));
      if (phase === 'version') {
        version = Buffer.concat([version, bytes]);
        if (version.length < 12) return;
        assert.strictEqual(version.toString(), 'RFB 003.008\n');
        phase = 'choice';
        socket.write(Buffer.from([3, 1]));
        socket.write(Buffer.from([2, 30]));
      } else if (phase === 'choice') {
        assert.strictEqual(bytes[0], 30);
        phase = 'ard';
        socket.write(Buffer.from('opaque-fixture'));
      }
    });
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const ctx = { authed: true, os: 'android', transport: 'ip', resumeKey: 'key', ws: new Socket(), address: '100.70.0.2' };
  let peer;
  const tunnel = new LockTunnel({ current: () => ctx, allowed: () => true, verifyPeer: async () => trusted,
    connect: (target) => { assert.deepStrictEqual(target, { host: '127.0.0.1', port: 5900 }); return peer = net.connect(listener.address().port, '127.0.0.1'); } });
  const ws = new Socket();
  try {
    const ticket = tunnel.issue(ctx, REQUEST);
    assert(tunnel.accept(ws, { url: P.LOCK_PATH, headers: { [P.LOCK_TICKET_HEADER]: ticket.ticket }, socket: { remoteAddress: ctx.address } }));
    if (!trusted) {
      await until(() => ws.readyState === 3);
      assert.strictEqual(ws.sent.length, 0, 'untrusted TCP peer gets no banner or client bytes');
      assert.strictEqual(received.length, 0);
      return;
    }
    await until(() => ws.sent.length === 1);
    if (process.platform === 'darwin') {
      const sample = spawnSync('/usr/bin/nettop', ['-n', '-L', '1', '-m', 'tcp', '-p', String(process.pid), '-J', 'state'], { encoding: 'utf8', timeout: 3000 });
      assert.strictEqual(sample.status, 0);
      assert(ownsTuple(sample.stdout, peer.localPort, process.pid, listener.address().port, 'node'), 'real Node-spawned metadata attributes this disposable accepted TCP socket');
    }
    assert.deepStrictEqual(ws.sent[0], Buffer.from('RFB 003.889\n'));
    ws.emit('message', Buffer.from('RFB 003.'), true);
    ws.emit('message', Buffer.from('008\n'), true);
    await until(() => ws.sent.length === 2);
    assert.deepStrictEqual(ws.sent[1], Buffer.from([1, 30]));
    ws.emit('message', Buffer.from([selection]), true);
    if (selection === 30) {
      await until(() => ws.sent.length === 3);
      assert.deepStrictEqual(ws.sent[2], Buffer.from('opaque-fixture'));
    } else {
      await until(() => ws.readyState === 3);
      assert.strictEqual(Buffer.concat(received).length, 12, 'legacy choice never reaches TCP peer');
    }
  } finally {
    tunnel.close();
    if (peer) peer.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => listener.close(resolve));
  }
}

const DAEMON = '/System/Library/CoreServices/RemoteManagement/screensharingd.bundle/Contents/MacOS/screensharingd';
const peerSocket = () => ({ localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 45678, remotePort: 5900, destroyed: false });
const ownership = (pid = 123) => `,state,\nscreensharingd.${pid},,\ntcp4 127.0.0.1:5900<->127.0.0.1:45678,Established,\n`;
function identityCommands(overrides = {}) {
  let reads = 0, jobs = 0;
  return async (file, args) => {
    if (file === '/usr/bin/nettop') {
      assert.deepStrictEqual(args, ['-n', '-L', '1', '-m', 'tcp', '-p', '123', '-J', 'state']);
      return overrides.table === undefined ? ownership(++reads === 2 ? (overrides.finalPid || 123) : 123) : overrides.table;
    }
    if (file === '/bin/launchctl') {
      if (overrides.cold && ++jobs === 1) return 'system/com.apple.screensharing = {\n state = not running\n}';
      return overrides.job || `system/com.apple.screensharing = {\n path = /System/Library/LaunchDaemons/com.apple.screensharing.plist\n state = running\n pid = 123\n program = ${DAEMON}\n}`;
    }
    if (file === '/bin/ps') return `${overrides.uid || '0'} ${DAEMON}\n`;
    if (file === '/usr/bin/codesign') {
      assert(args.includes('-R=identifier "com.apple.screensharing.daemon" and anchor apple'));
      return overrides.badSignature ? null : '';
    }
    throw new Error('unexpected fixture command');
  };
}

async function mainPath() {
  const screens = [
    { id: 1, scaleFactor: 2, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } },
    { id: 2, scaleFactor: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  ];
  const primary = primaryView(screens, 2);
  assert.deepStrictEqual(primary, { x: 5120, y: 0, width: 5120, height: 2880, desktopWidth: 10240, desktopHeight: 2880 });
  assert(ownsTuple(ownership(), 45678, 123));
  assert.strictEqual(await verifyScreenSharingPeer(peerSocket(), identityCommands()), true);
  assert.strictEqual(await verifyScreenSharingPeer(peerSocket(), identityCommands({ cold: true })), true, 'wait for the actual daemon after socket activation');
  if (process.platform === 'darwin') {
    const signed = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "com.apple.screensharing.daemon" and anchor apple', DAEMON], { encoding: 'utf8', timeout: 3000 });
    assert.strictEqual(signed.status, 0, signed.stderr);
  }
  const users = [{ kCGSSessionOnConsoleKey: true, kCGSSessionUserIDKey: 502, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true }];
  for (const envelope of ['IOConsoleUsers', '0.IOConsoleUsers']) {
    assert.strictEqual(await readLocked(async (file, args) => file === '/usr/sbin/ioreg' ? 'disposable plist' : args[1] === envelope ? JSON.stringify(users) : null, 502), true);
  }
  await wireCase(true, 30);
  const f = fixture(false, { metadata: () => ({ account: 'fixture-account', primaryView: primary }) });
  try {
    await turn();
    assert.strictEqual(f.control.sent.at(-1).can, false);
    f.permit(true); // opening the screen after locking must reprobe and advertise access
    await turn();
    assert.strictEqual(f.control.sent.at(-1).can, true);
    const ticket = await open(f);
    assert.strictEqual(ticket.account, 'fixture-account');
    assert.deepStrictEqual(ticket.primaryView, primary);
    assert(f.control.sent.filter((m) => m.t !== P.T.LOCK_TICKET).every((m) => m.account === undefined && m.primaryView === undefined), 'metadata is ticket-only');
    assert.strictEqual(ticket.path, '/lockview');
    assert.strictEqual(ticket.expiresIn, 10000);
    assert.strictEqual(ticket.request, REQUEST);
    assert.strictEqual(f.server.lockview.pending.ticket, undefined, 'pending ticket stores only a hash');
    const ws = f.accept(ticket.ticket);
    assert.strictEqual(f.server.sockets.size, 1, 'binary tunnel is not a paired control socket');
    assert.strictEqual(f.server.lockview.pending, null);
    assert.deepStrictEqual(f.connections[0].target, { host: '127.0.0.1', port: 5900 });
    const tcp = f.connections[0].tcp;
    tcp.emit('connect');
    await turn();
    tcp.emit('data', Buffer.from('RFB 00'));
    tcp.emit('data', Buffer.from('3.889\n'));
    assert.deepStrictEqual(ws.sent[0], Buffer.from('RFB 003.889\n'));
    ws.emit('message', Buffer.from('RFB 003.'), true);
    ws.emit('message', Buffer.from('008\n'), true);
    tcp.emit('data', Buffer.from([3, 1]));
    tcp.emit('data', Buffer.from([2, 30]));
    assert.deepStrictEqual(ws.sent[1], Buffer.from([1, 30]), 'only ARD is advertised');
    ws.emit('message', Buffer.from([30]), true);
    const bytes = Buffer.from([0, 1, 255, 10]);
    tcp.emit('data', bytes);
    assert.deepStrictEqual(ws.sent.at(-1), bytes);
    tcp.blocked = true;
    ws.emit('message', bytes, true);
    assert.deepStrictEqual(tcp.written.at(-1), bytes);
    assert.strictEqual(ws.paused, true, 'TCP backpressure pauses inbound WSS');
    tcp.emit('drain');
    assert.strictEqual(ws.paused, false);
    assert.strictEqual(f.accept(ticket.ticket).readyState, 3, 'ticket is single use');
    f.power.emit('unlock-screen');
    assert(tcp.destroyed);
    assert.strictEqual(ws.readyState, 3);
    assert(f.control.sent.some((m) => m.t === P.T.LOCK_END && m.reason === 'unlocked'));
    assert.strictEqual(f.control.sent.at(-1).locked, false);
  } finally { f.server.close(); }
  // A user open during an obsolete availability probe must perform a fresh probe, not inherit failure.
  let release, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = fixture(true, { probe: async () => ++calls === 1 ? gate : true });
  try {
    await turn();
    pending.send({ t: P.T.LOCK_OPEN, request: REQUEST });
    release(true);
    await turn();
    assert(pending.control.sent.some((m) => m.t === P.T.LOCK_TICKET));
    assert.strictEqual(calls, 2);
  } finally { pending.server.close(); }
}

async function failurePath() {
  assert.strictEqual(primaryView([{ id: -1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 100, height: 100 } }], -1), null);
  assert.strictEqual(primaryView([
    { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    { id: 2, scaleFactor: 2, bounds: { x: 100, y: 0, width: 100, height: 100 } },
  ], 1), null, 'mixed-scale layout must not invent a crop');
  let reads = 0, details = 0;
  const changedConsole = fixture(true, { readLock: async () => ++reads === 1, metadata: () => { details++; return { account: 'must-not-send' }; } });
  try {
    await turn(); changedConsole.send({ t: P.T.LOCK_OPEN, request: REQUEST }); await turn();
    assert.strictEqual(details, 0, 'fresh console verification precedes account metadata');
    assert(!changedConsole.control.sent.some((m) => m.t === P.T.LOCK_TICKET));
  } finally { changedConsole.server.close(); }
  const topology = new EventEmitter();
  let view = { x: 0, y: 0, width: 100, height: 100, desktopWidth: 200, desktopHeight: 100 };
  const movedScreen = fixture(true, { screens: topology, metadata: () => ({ primaryView: view }) });
  try {
    const ticket = await open(movedScreen), ws = movedScreen.accept(ticket.ticket), tcp = movedScreen.connections[0].tcp;
    tcp.emit('connect'); await turn();
    view = { ...view, x: 100 };
    topology.emit('display-metrics-changed');
    assert(tcp.destroyed, 'a changed primary layout invalidates the crop before more input');
    assert.strictEqual(ws.readyState, 3);
  } finally { movedScreen.server.close(); }
  for (const identity of [{ table: null }, { table: ownership(1) }, { uid: '502' }, { badSignature: true }, { finalPid: 999 }]) {
    assert.strictEqual(await verifyScreenSharingPeer(peerSocket(), identityCommands(identity)), false);
  }
  assert.strictEqual(servicePid('untrusted job'), null);
  for (const name of ['fake screensharingd.123', 'fake:123 actual:999', 'screensharingd.123,extra', 'screensharingd.123\nextra']) {
    assert.strictEqual(ownsTuple(ownership().replace('screensharingd.123', name), 45678, 123), false, 'process-name text cannot supply the trusted PID');
  }
  assert.strictEqual(ownsTuple(ownership() + 'untrusted.999,,\n', 45678, 123), false);
  if (process.platform === 'darwin') {
    const wrong = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "not.the.apple.daemon" and anchor apple', DAEMON], { encoding: 'utf8', timeout: 3000 });
    assert.notStrictEqual(wrong.status, 0, 'real codesign must enforce the supplied requirement');
  }
  assert.strictEqual(lockedConsole([{ kCGSSessionOnConsoleKey: false, kCGSSessionUserIDKey: 502, CGSSessionScreenIsLocked: true }], 502), false);
  assert.strictEqual(await readLocked(async () => null, 502), null, 'a failed lock read must remain unknown');
  assert.strictEqual(lockedConsole([{ kCGSSessionOnConsoleKey: true, kCGSSessionUserIDKey: 501, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true }], 502), false);
  for (const choice of [2, 1, 0]) {
    const gate = new ArdGate();
    gate.fromServer(Buffer.from('RFB 003.889\n'));
    gate.fromClient(Buffer.from('RFB 003.008\n'));
    gate.fromServer(Buffer.from([2, 2, 30]));
    assert.throws(() => gate.fromClient(Buffer.from([choice])), /ARD required/);
  }
  const pipelined = new ArdGate();
  pipelined.fromServer(Buffer.from('RFB 003.889\n'));
  assert.throws(() => pipelined.fromClient(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([30, 1])])), /Pipelined/);
  await wireCase(false, 30);
  await wireCase(true, 2);
  let release;
  const pending = fixture(true, { probe: () => new Promise((resolve) => { release = resolve; }) });
  try {
    await turn();
    pending.send({ t: P.T.LOCK_OPEN, request: REQUEST });
    pending.power.emit('unlock-screen');
    assert(pending.control.sent.some((m) => m.t === P.T.LOCK_END && m.request === REQUEST && m.reason === 'unlocked'), 'unlock answers an in-flight request immediately');
    release(true);
    await turn();
    assert(!pending.control.sent.some((m) => m.t === P.T.LOCK_TICKET));
  } finally { pending.server.close(); }
  for (const mutate of [
    (f) => { f.server.current = { ...f.ctx }; f.server.emit('client', f.server.current); },
    (f) => f.server.release(),
    (f) => f.server.closeDevice('phone', P.E.BAD_TOKEN, 'Forgotten'),
    (f) => f.server.noteReleased('phone'),
    (f) => { f.ctx.transport = 'ble'; f.server.emit('transport', f.ctx); },
    (f) => f.permit(false),
    (f) => f.send({ t: P.T.LOCK_END, request: REQUEST }),
    (f) => f.server.close(),
  ]) {
    const f = fixture();
    try {
      const ticket = await open(f), ws = f.accept(ticket.ticket), tcp = f.connections[0].tcp;
      mutate(f); // release/replacement/revoke wins even while TCP connect is pending
      tcp.emit('connect');
      tcp.emit('data', Buffer.from('not a real credential'));
      assert(tcp.destroyed);
      assert.strictEqual(ws.sent.length, 0);
      assert.strictEqual(f.server.lockview?.active || null, null);
    } finally { if (!f.server.closed) f.server.close(); }
  }
  const f = fixture();
  try {
    const ticket = await open(f);
    assert.strictEqual(f.accept(ticket.ticket, { socket: { remoteAddress: '100.70.0.3' } }).readyState, 3);
    assert.strictEqual(f.accept(ticket.ticket, { url: '/lockview?ticket=forbidden' }).readyState, 3);
    const stale = { ...f.ctx, ws: new Socket() };
    f.send({ t: P.T.LOCK_OPEN, request: REQUEST }, stale);
    const alt = new Socket();
    alt.transport = 'ble';
    f.server._onMessage(f.ctx, Buffer.from(JSON.stringify({ t: P.T.LOCK_OPEN, request: REQUEST })), false, alt);
    await turn();
    assert.strictEqual(stale.ws.sent.length, 0);
    assert.strictEqual(f.control.sent.filter((m) => m.t === P.T.LOCK_TICKET).length, 1, 'fallback BLE cannot request an IP-only tunnel');
    const ws = f.accept(ticket.ticket), tcp = f.connections[0].tcp;
    tcp.emit('connect');
    await turn();
    f.send({ t: P.T.LOCK_END, request: 'cd'.repeat(16) });
    assert.strictEqual(tcp.destroyed, undefined, 'old activity teardown cannot close this request');
    ws.emit('message', Buffer.from('text forbidden'), false);
    assert(tcp.destroyed);
  } finally { f.server.close(); }
  let now = 0;
  const ctx = { authed: true, os: 'android', transport: 'ip', resumeKey: 'key', ws: new Socket(), address: '100.70.0.2' };
  const tunnel = new LockTunnel({ current: () => ctx, allowed: () => true, now: () => now,
    connect: () => { throw new Error('expired tickets cannot connect'); } });
  try {
    const ticket = tunnel.issue(ctx, REQUEST);
    now = P.LOCK_TICKET_MS;
    const ws = new Socket();
    assert.strictEqual(tunnel.accept(ws, { url: P.LOCK_PATH, headers: { [P.LOCK_TICKET_HEADER]: ticket.ticket }, socket: { remoteAddress: ctx.address } }), false);
    assert.strictEqual(ws.readyState, 3);
  } finally { tunnel.close(); }
}

(async () => { await mainPath(); await failurePath(); console.log('locktunnel: ok'); })().catch((err) => { console.error(err); process.exitCode = 1; });
