// TwinDesk Drive when a session drops and comes back (shared/drive-link.js, shared/drive.js): only
// what changed since goes across, an older TwinDesk still gets everything, a download that failed
// still comes, the index goes in parts a little apart, and a link that keeps coming back waits.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Drive } = require('../drive.js');
const { DriveLink } = require('../drive-link.js');
const { create } = require('../drive-host.js');
const P = require('../protocol.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-drivereconnect-'));
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=td', '-keyout', path.join(base, 'k.pem'), '-out', path.join(base, 'c.pem')], { stdio: 'ignore' });
} catch {
  console.log('drive-reconnect: skipped (no openssl)');
  process.exit(0);
}
const key = fs.readFileSync(path.join(base, 'k.pem'));
const cert = fs.readFileSync(path.join(base, 'c.pem'));
const fp = P.normFingerprint(new crypto.X509Certificate(cert).fingerprint256);
const token = crypto.randomBytes(16).toString('hex');
const later = Date.now() + 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engine(id) {
  const dir = path.join(base, id, 'Drive');
  const d = new Drive({ me: id, meName: id, folder: () => dir, indexFile: path.join(base, id, 'i.json'), watch: false, now: () => later, trash: async (a) => fs.rmSync(a) });
  d.dir = dir;
  return d;
}
const write = (d, rel, text, ago = 10000) => {
  const f = path.join(d.dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(later - ago);
  fs.utimesSync(f, t, t);
};
const read = (d, rel) => { try { return fs.readFileSync(path.join(d.dir, rel), 'utf8'); } catch { return null; } };
const wait = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
};
const idle = (l) => wait(() => !l.merging && !l.queue.length && !l.active && !l.candidate);

// The index entries each side sent, per session.
const sent = { host: [], guest: [] };
const indexed = (who) => sent[who].filter((m) => m.t === P.T.DRIVE_INDEX).reduce((n, m) => n + m.entries.length, 0);

(async () => {
  const H = engine('host'), G = engine('guest');
  await H.start();
  await G.start();
  for (let i = 0; i < 30; i++) write(H, `h/${i}.txt`, `host ${i}`);
  write(G, 'from-guest.txt', 'guest bytes');
  await H.scan();
  await G.scan();

  let guestFp = fp;
  let oldGuest = false; // the guest as an older TwinDesk: its hello says no have
  let host, guest;
  const server = https.createServer({ key, cert }, (req, res) => {
    if (!host.request(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let up = true;
  const across = (to) => (m) => {
    const c = JSON.parse(JSON.stringify(m));
    if (oldGuest && to === 'host' && c.t === P.T.DRIVE_HELLO) delete c.have;
    sent[to === 'host' ? 'guest' : 'host'].push(c);
    setImmediate(() => up && (to === 'host' ? host : guest).onMessage(c));
  };
  const memH = {}, memG = {};
  const link = () => {
    host = new DriveLink({ drive: H, send: across('guest'), session: () => (up ? { host: true, token, address: '127.0.0.1', transport: 'ip' } : null), peerName: () => 'guest', memory: memH, partGapMs: 0, stableMs: 0 });
    guest = new DriveLink({ drive: G, send: across('host'), session: () => (up ? { host: false, token, address: '127.0.0.1', port, fp: guestFp, transport: 'ip' } : null), peerName: () => 'host', memory: memG, partGapMs: 0, stableMs: 0 });
  };
  const connect = () => { sent.host = []; sent.guest = []; up = true; link(); host.start(); guest.start(); };
  const drop = () => { up = false; host.destroy(); guest.destroy(); };

  // The first time: everything, both ways.
  connect();
  assert.ok(await wait(() => read(G, 'h/29.txt') === 'host 29'), 'the guest gets the host\'s files');
  assert.ok(await wait(() => read(H, 'from-guest.txt') === 'guest bytes'), 'the host gets the guest\'s');
  await idle(host);
  await idle(guest);
  assert.strictEqual(indexed('host'), 30, 'first sync: the host sends everything it has');
  assert.ok(memG.have && memG.have.e === H.epoch, 'the guest knows where it is in the host\'s index');
  assert.ok(memH.have && memH.have.e === G.epoch);

  // Back with nothing changed: no entries either way, and neither index is written again.
  let saves = 0;
  for (const d of [H, G]) { const save = d._save.bind(d); d._save = () => { saves++; save(); }; }
  drop();
  connect();
  await sleep(400);
  await idle(host);
  await idle(guest);
  assert.strictEqual(indexed('host'), 0, 'nothing changed: the host sends no entries');
  assert.strictEqual(indexed('guest'), 0, 'nor the guest');
  assert.strictEqual(saves, 0, 'a merge that changed nothing doesn\'t write the index');
  assert.ok(sent.host.some((m) => m.t === P.T.DRIVE_INDEX && m.last && m.upto), 'an empty last part says where the index is');

  // A change while apart: only that one.
  drop();
  write(H, 'h/7.txt', 'edited while apart', 5000);
  await H.scan();
  connect();
  assert.ok(await wait(() => read(G, 'h/7.txt') === 'edited while apart'));
  await idle(guest);
  assert.strictEqual(indexed('host'), 1, 'only what changed goes');

  // A change while connected (an update), then back: nothing again.
  write(H, 'h/8.txt', 'edited while connected', 4000);
  await H.scan();
  assert.ok(await wait(() => read(G, 'h/8.txt') === 'edited while connected'));
  await idle(guest);
  drop();
  connect();
  await sleep(400);
  await idle(guest);
  assert.strictEqual(indexed('host'), 0, 'an update that followed on moved the guest along');

  // A download that fails (the wrong certificate): the guest doesn't move on, and it comes next time.
  drop();
  write(H, 'h/9.txt', 'needs a second try', 3000);
  await H.scan();
  guestFp = 'ab'.repeat(32);
  const before = memG.have;
  connect();
  await sleep(800);
  assert.strictEqual(read(G, 'h/9.txt'), 'host 9', 'not with the wrong certificate');
  assert.deepStrictEqual(memG.have, before, 'a failed download: the guest stays where it had all');
  drop();
  guestFp = fp;
  connect();
  assert.ok(await wait(() => read(G, 'h/9.txt') === 'needs a second try'), 'it comes with the next session');

  // An older TwinDesk (no have): everything, as before.
  await idle(guest);
  drop();
  oldGuest = true;
  connect();
  await sleep(400);
  assert.strictEqual(indexed('host'), 31, 'no have: the whole index');
  oldGuest = false;

  // The host restarted (a new epoch): everything once.
  drop();
  await H.stop();
  await H.start();
  connect();
  await sleep(400);
  assert.strictEqual(indexed('host'), 31, 'another epoch: the whole index');
  drop();

  await H.stop();
  await G.stop();
  server.close();

  // ---- the index's parts, a little apart (a fake engine with 2,500 entries) ----
  const fake = Object.assign(new EventEmitter(), {
    epoch: 'e1',
    entries: () => Array.from({ length: 2500 }, (_, i) => ({ p: `f${i}`, s: 1, m: 1, h: 'a'.repeat(64), d: false, v: { x: 1 }, by: 'x' })),
    cursor: () => ({ e: 'e1', n: 5 }),
    entriesSince: () => [],
    merge: async () => Object.defineProperty([], 'deferred', { value: false }),
    release: () => {},
  });
  let live = true;
  const times = [];
  const paced = new DriveLink({ drive: fake, send: (m) => { if (m.t === P.T.DRIVE_INDEX) times.push({ at: Date.now(), n: m.entries.length, last: m.last }); }, session: () => (live ? { host: true, token, transport: 'ip' } : null), partGapMs: 120 });
  paced.onMessage({ t: P.T.DRIVE_HELLO, v: 1 });
  assert.ok(await wait(() => times.length === 3, 2000), 'three parts');
  assert.deepStrictEqual(times.map((t) => t.n), [1000, 1000, 500]);
  assert.ok(times[1].at - times[0].at >= 100 && times[2].at - times[1].at >= 100, 'a gap between parts');
  assert.ok(times[2].last && !times[0].last);
  // The session ends while the parts go: the rest doesn't.
  times.length = 0;
  paced.kick();
  await sleep(30);
  live = false;
  await sleep(400);
  assert.strictEqual(times.length, 1, 'only the part before the session ended');
  paced.destroy();

  // A have of this epoch: only what changed since.
  const sinceAsked = [];
  fake.entriesSince = (n) => { sinceAsked.push(n); return []; };
  const lean = new DriveLink({ drive: fake, send: () => {}, session: () => ({ host: true, token, transport: 'ip' }), partGapMs: 0 });
  lean.onMessage({ t: P.T.DRIVE_HELLO, v: 1, have: { e: 'e1', n: 3 } });
  lean.onMessage({ t: P.T.DRIVE_HELLO, v: 1, have: { e: 'e1', n: 3 }, again: true });
  assert.deepStrictEqual(sinceAsked, [3, 3], 'again with a have: since it, not everything');
  lean.destroy();

  // An entry the engine left for later: no new place in their index.
  const mem = { have: { e: 'e9', n: 1 } };
  fake.merge = async () => Object.defineProperty([], 'deferred', { value: true });
  const deferring = new DriveLink({ drive: fake, send: () => {}, session: () => ({ host: true, token, transport: 'ip' }), memory: mem, partGapMs: 0 });
  deferring.onMessage({ t: P.T.DRIVE_HELLO, v: 1 });
  deferring.onMessage({ t: P.T.DRIVE_INDEX, entries: [], last: true, upto: { e: 'e9', n: 4 } });
  await sleep(50);
  assert.deepStrictEqual(mem.have, { e: 'e9', n: 1 }, 'deferred: stays where it had all');
  fake.merge = async () => Object.defineProperty([], 'deferred', { value: false });
  deferring.onMessage({ t: P.T.DRIVE_INDEX, entries: [], last: true, upto: { e: 'e9', n: 5 } });
  await sleep(50);
  assert.deepStrictEqual(mem.have, { e: 'e9', n: 5 }, 'all of it here: moves on');
  // An update that doesn't follow on from there (one went missing): no move.
  deferring.onMessage({ t: P.T.DRIVE_UPDATE, entries: [], r: { e: 'e9', from: 7, to: 8 } });
  await sleep(50);
  assert.deepStrictEqual(mem.have, { e: 'e9', n: 5 });
  deferring.onMessage({ t: P.T.DRIVE_UPDATE, entries: [], r: { e: 'e9', from: 5, to: 6 } });
  await sleep(50);
  assert.deepStrictEqual(mem.have, { e: 'e9', n: 6 }, 'one that follows on: moves on');

  // Completing a later part can't make a deferred earlier part disappear.
  fake.merge = async (entries) => Object.defineProperty([], 'deferred', { value: entries.length !== 0 });
  deferring.onMessage({ t: P.T.DRIVE_INDEX, part: 0, entries: [{}], last: false });
  await idle(deferring);
  deferring.onMessage({ t: P.T.DRIVE_INDEX, part: 1, entries: [], last: true, upto: { e: 'e9', n: 9 } });
  await idle(deferring);
  assert.deepStrictEqual(mem.have, { e: 'e9', n: 6 }, 'a checkpoint covers every index part');

  // An old merge resolving after a route change cannot poison the next checkpoint.
  let completeOld;
  fake.merge = () => new Promise((resolve) => { completeOld = resolve; });
  deferring.onMessage({ t: P.T.DRIVE_INDEX, part: 0, entries: [], last: true, upto: { e: 'e9', n: 9 } });
  deferring.kick();
  fake.merge = async () => [];
  deferring.onMessage({ t: P.T.DRIVE_INDEX, part: 0, entries: [], last: true, upto: { e: 'e9', n: 10 } });
  completeOld(Object.defineProperty([], 'deferred', { value: true }));
  await idle(deferring);
  assert.deepStrictEqual(mem.have, { e: 'e9', n: 10 }, 'the checkpoint belongs to the replacement route');
  deferring.destroy();

  // Direct mode reuses a link object when changing devices. Only the original peer gets its cursor.
  const directMessages = [];
  const events = new EventEmitter();
  let peerId = 'first';
  let peerConnected = true;
  const direct = create({
    settings: { drive: { on: false, folder: path.join(base, 'direct') } },
    save() {}, me: 'direct', userData: base, trash: async () => {},
    adapter: {
      on: (t, fn) => events.on(t, fn),
      onUp: (fn) => events.on('up', fn),
      onDown: (fn) => events.on('down', fn),
      onMoved() {},
      send: (m) => directMessages.push(m),
      session: () => peerConnected ? { host: true, token, transport: 'ip' } : null,
      peerId: () => peerConnected ? peerId : null,
      peerName: () => peerId,
      setRequest() {},
    },
  });
  await direct.setOn(true);
  events.emit(P.T.DRIVE_HELLO, { t: P.T.DRIVE_HELLO, v: 1 });
  events.emit(P.T.DRIVE_INDEX, { t: P.T.DRIVE_INDEX, entries: [], last: true, upto: { e: 'first-epoch', n: 5 } });
  await sleep(100);
  const switchPeer = (id) => {
    peerConnected = false;
    events.emit('down');
    peerId = id;
    peerConnected = true;
    events.emit('up');
    return directMessages.filter((m) => m.t === P.T.DRIVE_HELLO).at(-1);
  };
  assert.strictEqual(switchPeer('second').have, undefined);
  assert.deepStrictEqual(switchPeer('first').have, { e: 'first-epoch', n: 5 });
  await direct.stop();

  // ---- a link that keeps coming back waits before Drive says hello ----
  const flapMem = {};
  const hellos = [];
  let flapper = null;
  const log = console.log;
  const logged = [];
  console.log = (s) => logged.push(String(s));
  for (let i = 0; i < 3; i++) {
    if (flapper) flapper.destroy();
    flapper = new DriveLink({ drive: fake, send: (m) => { if (m.t === P.T.DRIVE_HELLO) hellos.push(i); }, session: () => ({ host: true, token, transport: 'ip' }), peerName: () => 'Ryzen9', memory: flapMem, partGapMs: 0, stableMs: 300 });
    flapper.start();
  }
  console.log = log;
  assert.deepStrictEqual(hellos, [0, 1], 'the third time within a minute: no hello yet');
  assert.ok(logged.some((s) => s.includes('[drive] Ryzen9: came back 3 times')), 'and it says so in the log');
  flapper.onMessage({ t: P.T.DRIVE_HELLO, v: 1 }); // theirs while waiting: kept, nothing sent
  assert.deepStrictEqual(hellos, [0, 1]);
  assert.ok(await wait(() => hellos.length === 3, 2000), 'hello once the link stayed up');
  // Gone before the wait is over: nothing.
  flapper.destroy();
  const quiet = new DriveLink({ drive: fake, send: (m) => { if (m.t === P.T.DRIVE_HELLO) hellos.push('late'); }, session: () => ({ host: true, token, transport: 'ip' }), memory: flapMem, partGapMs: 0, stableMs: 200 });
  console.log = () => {};
  quiet.start();
  console.log = log;
  quiet.destroy();
  await sleep(400);
  assert.ok(!hellos.includes('late'), 'a session that ended while waiting says nothing');

  fs.rmSync(base, { recursive: true, force: true });
  console.log('drive-reconnect: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
