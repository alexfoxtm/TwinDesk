// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Login-screen access uses macOS Screen Sharing, never Chromium capture or stored credentials.
'use strict';

const net = require('net');
const os = require('os');
const { execFile } = require('child_process');
const { LockTunnel } = require('../shared/locktunnel');
const Quiet = require('../shared/quiet');
const P = require('../shared/protocol');
const DAEMON = '/System/Library/CoreServices/RemoteManagement/screensharingd.bundle/Contents/MacOS/screensharingd';

function run(file, args, input) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function lockedConsole(users, uid) {
  if (!Array.isArray(users)) return false;
  const consoleUsers = users.filter((u) => u && u.kCGSSessionOnConsoleKey === true);
  return consoleUsers.length === 1 && consoleUsers[0].kCGSSessionUserIDKey === uid &&
    consoleUsers[0].kCGSessionLoginDoneKey === true && consoleUsers[0].CGSSessionScreenIsLocked === true;
}

async function readLocked(execute = run, uid = process.getuid()) {
  const plist = await execute('/usr/sbin/ioreg', ['-a', '-n', 'Root', '-d1']);
  if (plist === null) return null;
  let json = await execute('/usr/bin/plutil', ['-extract', 'IOConsoleUsers', 'json', '-o', '-', '-'], plist);
  if (json === null) json = await execute('/usr/bin/plutil', ['-extract', '0.IOConsoleUsers', 'json', '-o', '-', '-'], plist);
  try {
    const users = JSON.parse(json);
    return Array.isArray(users) ? lockedConsole(users, uid) : null;
  } catch { return null; }
}

function primaryView(displays, primaryId) {
  if (!Array.isArray(displays) || !displays.length || displays.length > 16) return null;
  const usable = (d) => d && Number.isInteger(d.id) && d.id > 0 &&
    Number.isFinite(d.scaleFactor) && d.scaleFactor > 0 && d.scaleFactor <= 4 &&
    d.bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(d.bounds[key])) &&
    d.bounds.width > 0 && d.bounds.height > 0;
  if (!displays.every(usable)) return null;
  const primary = displays.find((d) => d.id === primaryId), scale = displays[0].scaleFactor;
  if (!primary || !displays.every((d) => d.scaleFactor === scale)) return null;
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const b = primary.bounds;
  const x = Math.round((b.x - left) * scale), y = Math.round((b.y - top) * scale);
  const value = { x, y, width: Math.round((b.x + b.width - left) * scale) - x,
    height: Math.round((b.y + b.height - top) * scale) - y,
    desktopWidth: Math.round((right - left) * scale), desktopHeight: Math.round((bottom - top) * scale) };
  return Object.values(value).every((n) => Number.isInteger(n) && n >= 0 && n <= 32768) &&
    value.width > 0 && value.height > 0 && value.desktopWidth > 0 && value.desktopHeight > 0 ? value : null;
}

// Account/display metadata is sent only with a ticket for this freshly verified locked console.
function ticketMetadata() {
  const value = {};
  try {
    const user = os.userInfo();
    if (user.uid === process.getuid() && user.uid > 0 && typeof user.username === 'string' &&
        user.username.length && Buffer.byteLength(user.username, 'utf8') <= 63 && !/[\x00-\x1f\x7f]/.test(user.username)) value.account = user.username;
  } catch {}
  try {
    const { screen } = require('electron');
    const view = primaryView(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
    if (view) value.primaryView = view;
  } catch {}
  return value;
}

function displayEvents() {
  try { return require('electron').screen; } catch { return null; }
}

function servicePid(job) {
  if (typeof job !== 'string' || !job.startsWith('system/com.apple.screensharing = {') ||
      !/^\s*path = \/System\/Library\/LaunchDaemons\/com\.apple\.screensharing\.plist\s*$/m.test(job) ||
      !/^\s*state = running\s*$/m.test(job) ||
      !job.split('\n').some((line) => line.trim() === `program = ${DAEMON}`)) return null;
  const pids = [...job.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gm)];
  const pid = pids.length === 1 ? Number(pids[0][1]) : 0;
  return Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff ? pid : null;
}

function ownsTuple(csv, port, pid, serverPort = 5900, processName = 'screensharingd') {
  if (typeof csv !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return false;
  const rows = csv.trim().split(/\r?\n/);
  // nettop is PID-filtered before parsing. Do not derive identity from process names or whitespace
  // columns. Its fixed one-column CSV must have exactly the expected process group and tuple.
  if (rows[0] !== ',state,' || rows[1] !== `${processName}.${pid},,`) return false;
  let matches = 0;
  for (const row of rows.slice(2)) {
    const fields = row.split(',');
    if (fields.length !== 3 || fields[2] !== '' || !/^tcp[46] /.test(fields[0])) return false;
    if (fields[0] === `tcp4 127.0.0.1:${serverPort}<->127.0.0.1:${port}` && fields[1] === 'Established') ++matches;
  }
  return matches === 1;
}

// Attribute THIS accepted TCP peer, not a listener observed before connecting. The kernel tuple
// must belong to the running root system job and its protected Apple-signed executable. Missing
// process visibility or changed output fails closed. The same live TCP socket is kept afterward.
async function verifyScreenSharingPeer(socket, execute = run) {
  const port = socket.localPort;
  const live = () => !socket.destroyed && socket.localAddress === '127.0.0.1' && socket.remoteAddress === '127.0.0.1' && socket.remotePort === 5900 && socket.localPort === port;
  if (!live()) return false;
  let pid = null;
  const until = Date.now() + 2000;
  do {
    pid = servicePid(await execute('/bin/launchctl', ['print', 'system/com.apple.screensharing']));
    if (pid || !live() || Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 200)); // launchd may still be starting the daemon
  } while (live());
  if (!pid || !live()) return false;
  const process = await execute('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'comm=']);
  if (!process || process.trim() !== `0 ${DAEMON}`) return false;
  const signature = await execute('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "com.apple.screensharing.daemon" and anchor apple', DAEMON]);
  if (signature === null || !live()) return false;
  const args = ['-n', '-L', '1', '-m', 'tcp', '-p', String(pid), '-J', 'state'];
  let owned = false;
  for (let attempt = 0; attempt < 4 && live(); ++attempt) {
    owned = ownsTuple(await execute('/usr/bin/nettop', args), port, pid);
    if (owned) break;
    await new Promise((resolve) => setTimeout(resolve, 100)); // wait for accept, never trust launchd's listener
  }
  if (!owned || !live() || servicePid(await execute('/bin/launchctl', ['print', 'system/com.apple.screensharing'])) !== pid) return false;
  return ownsTuple(await execute('/usr/bin/nettop', args), port, pid) && live();
}

// Check only public version/security metadata, on an independently verified accepted socket.
// Do not select any authentication type. The actual ticket redemption verifies its own socket.
function ardAvailable({ connect = net.connect, verifyPeer = verifyScreenSharingPeer } = {}) {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0), version = false, done = false, trusted = false;
    const socket = connect({ host: '127.0.0.1', port: 5900 });
    const finish = (ok) => { if (done) return; done = true; clearTimeout(limit); socket.destroy(); resolve(ok); };
    const limit = setTimeout(() => finish(false), 6000);
    limit.unref?.();
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('connect', async () => {
      socket.pause();
      let ok = false;
      try { ok = await verifyPeer(socket); } catch {}
      if (done) return;
      if (!ok) return finish(false);
      trusted = true;
      socket.resume();
    });
    socket.on('data', (chunk) => {
      if (!trusted || data.length + chunk.length > 512) return finish(false);
      data = Buffer.concat([data, chunk]);
      if (!version) {
        if (data.length < 12) return;
        if (data.length !== 12 || !/^RFB 003\.(008|889)\n$/.test(data.toString('ascii'))) return finish(false);
        data = Buffer.alloc(0);
        version = true;
        socket.write('RFB 003.008\n');
        return;
      }
      if (!data.length || data.length < data[0] + 1) return;
      finish(data[0] > 0 && data.length === data[0] + 1 && data.subarray(1).includes(30));
    });
  });
}

function startLockView({ server, powerMonitor, remoteAllowed, readLock = readLocked, probe = ardAvailable, connect, verifyPeer = verifyScreenSharingPeer, metadata = ticketMetadata, screens = displayEvents() }) {
  let locked = false, available = false, stopped = false, epoch = 0, lastOpen = -Infinity, sent = '', request = null;
  let probing = null, nextProbe = 0, reading = false;
  let displayKey = null;
  const allowed = () => locked && available && remoteAllowed();
  const tunnel = new LockTunnel({ current: () => server.current, allowed, verifyPeer,
    ended: (ctx, id, reason) => { if (request?.id === id) { request = null; displayKey = null; } server.send(ctx, { t: P.T.LOCK_END, request: id, reason }); },
    hold: (on) => Quiet.hold('lockview', on), ...(connect ? { connect } : {}) });
  server.lockview = tunnel;
  const cancel = (reason) => {
    ++epoch;
    const pending = request, active = !!tunnel.active;
    request = null;
    displayKey = null;
    tunnel.end(reason);
    if (pending && !active) server.send(pending.ctx, { t: P.T.LOCK_END, request: pending.id, reason });
  };
  const state = () => {
    if (stopped) return;
    if (!allowed() && (request || tunnel.active || tunnel.pending)) cancel(locked ? 'unavailable' : 'unlocked');
    const ctx = server.current;
    if (!ctx || ctx.os !== P.OS.ANDROID) return;
    const value = { t: P.T.LOCK_STATE, locked, can: tunnel.eligible(ctx) };
    const key = JSON.stringify(value);
    if (key !== sent) { sent = key; server.send(ctx, value); }
  };
  const refresh = (force = false) => {
    if (!locked || !remoteAllowed() || stopped) return Promise.resolve(false);
    if (probing) return probing.generation === epoch ? probing.promise : probing.promise.then(() => refresh(force));
    if (!force && (available || Date.now() < nextProbe)) return Promise.resolve(available);
    const generation = epoch;
    nextProbe = Date.now() + 30000;
    const flight = { generation };
    flight.promise = Promise.resolve().then(() => probe()).catch(() => false).then((ok) => {
      if (stopped || generation !== epoch) return false;
      available = !!ok;
      state();
      return available;
    }).finally(() => { if (probing === flight) probing = null; });
    probing = flight;
    return flight.promise;
  };
  let lastAllowed = remoteAllowed();
  server.lockviewRefresh = () => {
    const permitted = remoteAllowed();
    if (permitted !== lastAllowed) {
      lastAllowed = permitted;
      available = false;
      if (!permitted) cancel('unavailable');
      else { nextProbe = 0; void refresh(); }
    }
    state();
  };
  const changed = (on) => {
    if (locked !== on) { locked = on; available = false; nextProbe = 0; cancel(on ? 'ended' : 'unlocked'); }
    state();
    if (locked && !tunnel.active) void refresh();
  };
  const lock = () => changed(true), unlock = () => changed(false);
  const inspectLock = async () => {
    if (reading || stopped) return;
    reading = true;
    const generation = epoch;
    let on = null;
    try { on = await readLock(); } catch {}
    reading = false;
    if (!stopped && generation === epoch && typeof on === 'boolean') changed(on);
  };
  const client = () => { cancel('session-ended'); available = false; nextProbe = 0; sent = ''; void inspectLock(); };
  const closed = (ctx) => { if (request?.ctx === ctx || tunnel.pending?.ctx === ctx || tunnel.active?.ctx === ctx) cancel('session-ended'); };
  const revoked = (ctx) => { if (ctx === server.current || request?.ctx === ctx || tunnel.pending?.ctx === ctx || tunnel.active?.ctx === ctx) cancel('session-ended'); };
  const deviceClosed = (id) => { if (server.current?.deviceId === id || request?.ctx.deviceId === id) cancel('session-ended'); };
  const transport = () => { cancel('session-ended'); sent = ''; state(); };
  const message = async (msg, ctx, source) => {
    if (msg.t !== P.T.LOCK_OPEN && msg.t !== P.T.LOCK_END) return;
    if (ctx !== server.current || source !== ctx.ws || source.transport === 'ble' || !ctx.authed || ctx.released || ctx.os !== P.OS.ANDROID || ctx.transport !== 'ip') return;
    const id = typeof msg.request === 'string' && /^[a-f0-9]{32}$/.test(msg.request) ? msg.request : undefined;
    if (msg.t === P.T.LOCK_END) { if (id && id === request?.id) cancel('ended'); return; }
    const refuse = (reason = 'unavailable') => server.send(ctx, { t: P.T.LOCK_END, ...(id ? { request: id } : {}), reason });
    if (!id || !locked || !remoteAllowed() || Date.now() - lastOpen < 2000 || tunnel.active) return refuse();
    lastOpen = Date.now();
    cancel('ended');
    request = { id, ctx, ws: ctx.ws, key: ctx.resumeKey };
    const pending = request, generation = epoch;
    const ok = await refresh(true);
    const currentLock = ok ? await Promise.resolve().then(() => readLock()).catch(() => null) : null;
    if (request !== pending) return; // cancellation already answered this request
    if (stopped || generation !== epoch || ctx !== server.current || ctx.ws !== pending.ws || ctx.resumeKey !== pending.key || !locked || !remoteAllowed()) {
      request = null;
      return refuse(locked ? 'session-ended' : 'unlocked');
    }
    if (currentLock === false) { changed(false); return; }
    const ticket = ok && currentLock === true && tunnel.issue(ctx, id);
    if (ticket) {
      const details = metadata();
      displayKey = JSON.stringify(details.primaryView || null);
      server.send(ctx, { t: P.T.LOCK_TICKET, ...ticket, ...details });
    }
    else { request = null; refuse(); }
    state();
  };
  server.on('message', message);
  server.on('client', client);
  server.on('closed', closed);
  server.on('revoked', revoked);
  server.on('deviceClosed', deviceClosed);
  server.on('noreclaim', deviceClosed);
  server.on('transport', transport);
  powerMonitor.on('lock-screen', lock);
  powerMonitor.on('unlock-screen', unlock);
  powerMonitor.on('resume', inspectLock);
  const topology = () => {
    if (displayKey === null || stopped || !(request || tunnel.pending || tunnel.active)) return;
    const key = JSON.stringify(metadata().primaryView || null);
    if (key === displayKey) return;
    displayKey = key;
    cancel('display-changed');
    available = false; nextProbe = 0;
    state();
    void refresh();
  };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screens?.on(event, topology);
  // Recover from transient probe failure and a missed unlock event; never rely on a five-minute cap.
  const poll = setInterval(() => {
    if (server.current?.os !== P.OS.ANDROID || !remoteAllowed() || !(locked || request || tunnel.active || tunnel.pending)) return;
    void inspectLock();
    if (locked && !tunnel.active && !available && Date.now() >= nextProbe) void refresh();
  }, 5000);
  poll.unref?.();
  const close = () => {
    if (stopped) return;
    stopped = true;
    cancel('session-ended');
    tunnel.close();
    clearInterval(poll);
    delete server.lockview;
    delete server.lockviewRefresh;
    for (const [event, fn] of [['message', message], ['client', client], ['closed', closed], ['revoked', revoked], ['deviceClosed', deviceClosed], ['noreclaim', deviceClosed], ['transport', transport], ['closing', close]]) server.off(event, fn);
    powerMonitor.off('lock-screen', lock);
    powerMonitor.off('unlock-screen', unlock);
    powerMonitor.off('resume', inspectLock);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screens?.off(event, topology);
  };
  server.on('closing', close);
  void inspectLock();
  return { close };
}

module.exports = { startLockView, ardAvailable, verifyScreenSharingPeer, lockedConsole, ownsTuple, servicePid, readLocked, primaryView };
