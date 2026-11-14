// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/localsend/core.js: files with LocalSend-compatible apps, offline on 127.0.0.1.
// Two of our nodes send to each other; a client written here from the protocol text (not our client
// code) talks to our server; our client talks to a receiver written here from the protocol text.
// No multicast is used: an announce is handed to the node as the datagram it would have received.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const ls = require('../localsend/core.js');

const { execFileSync } = require('child_process');
const { quarantine } = require('../localsend/wire.js');
const { LocalSend, API } = ls;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-localsend-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const closers = [];

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

function node(name, extra = {}) {
  const save = path.join(tmp, `${name}-received`);
  fs.mkdirSync(save);
  const n = new LocalSend({ dir: path.join(tmp, `${name}-data`), alias: () => name, saveDir: () => save, port: 0, host: '127.0.0.1', multicast: false, cooldownMs: 300, log: process.env.LS_DEBUG ? console.error : () => {}, ...extra });
  n.save = save;
  n.seen = new Map(); // transfer id -> the last state seen
  n.offered = [];
  n.ended = [];
  n.policy = (o) => n.answer(o.id, true);
  n.on('transfer', (t) => n.seen.set(t.id, t));
  n.on('offer', (o) => { n.offered.push(o); n.policy(o); });
  n.on('offerEnd', (e) => n.ended.push(e));
  closers.push(() => n.stop());
  return n;
}
const finished = (n, id) => until(() => { const t = n.seen.get(id); return t && t.state !== 'waiting' && t.state !== 'running' ? t : null; }, `transfer ${id}`);
const arrived = (n, count) => until(() => { const done = [...n.seen.values()].filter((t) => t.dir === 'in' && t.state !== 'running'); return done.length >= count ? done : null; }, `${count} arrivals`);

// A request as the protocol text describes it, with nothing of ours: → { status, body, json, fp }.
// o.identity: the client certificate it presents (none by default: a client older than 1.17, or
// anything that only says who it is). o.hold: a promise the second half of the body waits for.
function raw(port, method, target, body, headers = {}, o = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const h = { ...headers };
    if (data && !('Transfer-Encoding' in h) && !('Content-Length' in h)) h['Content-Length'] = data.length;
    const mine = o.identity ? { key: o.identity.keyPem, cert: o.identity.certPem } : {};
    const req = https.request({ host: '127.0.0.1', port, method, path: target, rejectUnauthorized: false, agent: false, headers: h, ...mine }, (res) => {
      const fp = sha(res.socket.getPeerCertificate().raw);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* no body */ }
        resolve({ status: res.statusCode, body: buf, json, fp });
      });
      res.on('error', () => resolve({ status: 0, error: true }));
    });
    req.on('error', (e) => { if (process.env.LS_DEBUG) console.error('raw:', method, target, e.code, e.message); resolve({ status: 0, error: true }); });
    if (o.hold && data) { req.write(data.subarray(0, 10)); o.hold.then(() => req.end(data.subarray(10))); } else req.end(data || undefined);
  });
}
const rawInfo = { alias: 'Raw Client', version: '2.1', deviceModel: 'Test', deviceType: 'headless', fingerprint: 'ab'.repeat(32), port: 53317, protocol: 'https', download: false };
const offerOf = (files, info = rawInfo) => ({ info, files: Object.fromEntries(files.map((f) => [f.id, { id: f.id, fileName: f.fileName, size: f.data.length, fileType: 'application/octet-stream', ...(f.sha256 ? { sha256: f.sha256 } : {}) }])) });
const up = (port, s, id, tok, data, headers) => raw(port, 'POST', `${API}/upload?sessionId=${encodeURIComponent(s)}&fileId=${encodeURIComponent(id)}&token=${encodeURIComponent(tok)}`, data, headers);

// A receiver as the protocol text describes it (what an app on a phone is to us).
// strict: it takes no connection without a client certificate, which is what the review says the
// reference app does since 1.17 (a stand-in written here, not the reference app itself).
function fakeReceiver(strict = false) {
  const id = ls.makeIdentity();
  const r = { id, mode: 'ok', prepares: [], uploads: [], cancels: [], registers: [], requests: 0, stalled: [], certs: [], refused: 0 };
  const info = { alias: 'Fake Phone', version: '2.1', deviceModel: 'Pixel', deviceType: 'mobile', fingerprint: id.fingerprint, download: true };
  r.server = https.createServer({ key: id.keyPem, cert: id.certPem, ...(strict ? { requestCert: true, rejectUnauthorized: false } : {}) }, (req, res) => {
    if (strict) {
      const c = req.socket.getPeerCertificate();
      if (!c || !c.raw) { r.refused++; return req.socket.destroy(); }
      r.certs.push(sha(c.raw));
    }
    r.requests++;
    const url = new URL(req.url, 'https://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, obj) => { res.writeHead(status, obj ? { 'Content-Type': 'application/json' } : {}); res.end(obj ? JSON.stringify(obj) : undefined); };
      if (req.method === 'GET' && url.pathname === `${API}/info`) return send(200, info);
      if (url.pathname === `${API}/register`) { r.registers.push(JSON.parse(body.toString())); return send(200, info); }
      if (url.pathname === `${API}/prepare-upload`) {
        if (r.mode === 'pin' && url.searchParams.get('pin') !== '4321') return send(401, { message: 'PIN required' });
        if (r.mode === 'busy') return send(409, { message: 'Blocked by another session' });
        if (r.mode === 'no') return send(403, { message: 'Rejected' });
        const dto = JSON.parse(body.toString());
        r.prepares.push(dto);
        const ids = Object.keys(dto.files);
        return send(200, { sessionId: 'S 1', files: Object.fromEntries((r.mode === 'partial' ? ids.slice(0, 1) : ids).map((k) => [k, `tok-${k}`])) });
      }
      if (url.pathname === `${API}/upload`) {
        const fileId = url.searchParams.get('fileId');
        if (url.searchParams.get('sessionId') !== 'S 1' || url.searchParams.get('token') !== `tok-${fileId}`) return send(403, { message: 'Invalid token or IP address' });
        if (r.mode === 'stall') { r.stalled.push(res); return undefined; }
        r.uploads.push({ fileId, body, length: req.headers['content-length'] });
        return send(200);
      }
      if (url.pathname === `${API}/cancel`) { r.cancels.push(url.searchParams.get('sessionId')); return send(200); }
      return send(404);
    });
  });
  closers.push(() => { r.server.close(); r.server.closeAllConnections(); });
  return new Promise((resolve) => r.server.listen(0, '127.0.0.1', () => { r.port = r.server.address().port; resolve(r); }));
}
const accepts = (port) => new Promise((resolve) => {
  const c = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

async function main() {
  // ---- names: what a sender calls a file never decides where it lands ----
  // Nor how it reads: a character that turns the text around ("invoice‮fdp.exe" shown as "invoiceexe.pdf") is taken out.
  assert.deepStrictEqual(ls.splitName('invoice\u202Efdp.exe'), { folder: [], name: 'invoice_fdp.exe' });
  assert.strictEqual(ls.skeleton('M\u200bac\u00a0A'), ls.skeleton('mac a'));
  assert.deepStrictEqual(ls.splitName('../../evil.txt'), { folder: [], name: 'evil.txt' });
  assert.deepStrictEqual(ls.splitName('..\\..\\win\\CON.txt'), { folder: ['win'], name: '_CON.txt' });
  assert.deepStrictEqual(ls.splitName('/abs/./a:b?.txt. '), { folder: ['abs'], name: 'a_b_.txt' });
  assert.deepStrictEqual(ls.splitName('a/b/c.jpg'), { folder: ['a', 'b'], name: 'c.jpg' });
  assert.deepStrictEqual(ls.splitName('..'), { folder: [], name: 'file' });
  assert.deepStrictEqual(ls.splitName('x\u0000y\n.txt'), { folder: [], name: 'x_y_.txt' });
  assert.strictEqual(ls.splitName(`${'d/'.repeat(100)}f`).folder.length, 32);
  const long = ls.cleanSegment(`${'я'.repeat(400)}.jpeg`);
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.jpeg'));
  for (const [addr, ok] of [['192.168.1.4', true], ['10.0.0.1', true], ['172.16.0.1', true], ['172.32.0.1', false], ['169.254.3.3', true], ['100.64.0.1', true], ['127.0.0.1', true], ['::ffff:192.168.0.2', true], ['8.8.8.8', false], ['fe80::1', false], ['', false]]) {
    assert.strictEqual(ls.isLocalAddress(addr), ok, addr);
  }
  assert.strictEqual(ls.versionWhy('2.0'), '');
  assert.strictEqual(ls.versionWhy('2.2'), '');
  assert.strictEqual(ls.versionWhy('1.0'), 'v1');
  assert.strictEqual(ls.versionWhy('3.0'), 'newer');

  // ---- the identity: a certificate TLS accepts, whose hash is the fingerprint, kept between starts ----
  const a = node('Mac A');
  const b = node('Phone B');
  await a.start();
  await b.start();
  assert.ok(a.receiving && b.receiving && a.port > 0 && a.port !== b.port);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a.fingerprint, b.fingerprint);
  const idFile = path.join(tmp, 'Mac A-data', 'localsend-identity.json');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(idFile).mode & 0o777, 0o600);
  assert.strictEqual(ls.loadIdentity(path.join(tmp, 'Mac A-data')).fingerprint, a.fingerprint);
  const x = new crypto.X509Certificate(JSON.parse(fs.readFileSync(idFile, 'utf8')).certPem);
  assert.strictEqual(sha(x.raw), a.fingerprint);
  assert.ok(x.subject.includes('CN=TwinDesk') && x.verify(x.publicKey));
  const seenCert = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: a.port, rejectUnauthorized: false }, () => { const fp = sha(s.getPeerCertificate().raw); s.destroy(); resolve(fp); });
    s.on('error', reject);
  });
  assert.strictEqual(seenCert, a.fingerprint);

  // ---- /info, as the protocol text has it ----
  const info = await raw(b.port, 'GET', `${API}/info`);
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.fp, b.fingerprint);
  assert.deepStrictEqual(info.json, { alias: 'Phone B', version: '2.2', deviceModel: info.json.deviceModel, deviceType: 'desktop', fingerprint: b.fingerprint, port: b.port, protocol: 'https', download: false });
  assert.strictEqual((await raw(b.port, 'GET', '/api/localsend/v1/info')).status, 404);

  // ---- discovery: an announce is only a claim; the device is listed as verified after its certificate was seen ----
  a._onDatagram(Buffer.from(JSON.stringify(b.info(true))), { address: '127.0.0.1' });
  const peerB = await until(() => a.peers().find((p) => p.fingerprint === b.fingerprint && p.verified), 'A verifies B');
  assert.strictEqual(peerB.alias, 'Phone B');
  assert.strictEqual(peerB.port, b.port);
  // B learned of A from A's /register and checked it the same way.
  const peerA = await until(() => b.peers().find((p) => p.fingerprint === a.fingerprint && p.verified), 'B verifies A');
  assert.strictEqual(peerA.port, a.port);
  // Our own announce, one from outside the local networks and one that isn't JSON are nothing.
  a._onDatagram(Buffer.from(JSON.stringify(a.info(true))), { address: '127.0.0.1' });
  a._onDatagram(Buffer.from(JSON.stringify({ ...b.info(true), fingerprint: 'cd'.repeat(32) })), { address: '8.8.8.8' });
  a._onDatagram(Buffer.from('{nope'), { address: '127.0.0.1' });
  assert.strictEqual(a.peers().length, 1);

  // ---- the main path: files and a folder from A to B, asked first ----
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'album', 'sub'), { recursive: true });
  const big = crypto.randomBytes(700 * 1024 + 13);
  fs.writeFileSync(path.join(src, 'hello.txt'), 'hello from A');
  fs.writeFileSync(path.join(src, 'album', 'a.bin'), big);
  fs.writeFileSync(path.join(src, 'album', 'sub', 'b.txt'), 'deep');
  fs.writeFileSync(path.join(src, 'album', 'empty.dat'), '');
  if (process.platform !== 'win32') fs.symlinkSync(idFile, path.join(src, 'album', 'link.json')); // a link is never followed
  const t1 = a.send(peerB.id, [path.join(src, 'hello.txt'), path.join(src, 'album')]);
  const out1 = await finished(a, t1);
  assert.strictEqual(out1.state, 'done', out1.detail);
  assert.strictEqual(out1.done, out1.total);
  const [in1] = await arrived(b, 1);
  assert.strictEqual(in1.state, 'done');
  assert.strictEqual(b.offered.length, 1);
  const o1 = b.offered[0];
  assert.strictEqual(o1.alias, 'Mac A');
  assert.strictEqual(o1.files, 4);
  assert.strictEqual(o1.total, big.length + 12 + 4);
  assert.deepStrictEqual(o1.names, ['album', 'hello.txt']);
  // Who it is comes from the certificate its connection presented. Known is a device the person
  // here said yes to before: not yet, the first time.
  assert.deepStrictEqual([o1.verified, o1.known, o1.imitates], [true, false, false]);
  assert.strictEqual(o1.fingerprint, a.fingerprint);
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'hello.txt'), 'utf8'), 'hello from A');
  assert.ok(fs.readFileSync(path.join(b.save, 'album', 'a.bin')).equals(big));
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'album', 'sub', 'b.txt'), 'utf8'), 'deep');
  assert.strictEqual(fs.statSync(path.join(b.save, 'album', 'empty.dat')).size, 0);
  assert.ok(!fs.existsSync(path.join(b.save, 'album', 'link.json')));
  assert.deepStrictEqual(in1.saved.map((p) => path.basename(p)).sort(), ['album', 'hello.txt']);
  assert.ok(!fs.existsSync(path.join(tmp, 'Phone B-data', 'localsend-incoming', in1.id.slice(3)))); // nothing left on its way

  // The same again: nothing is replaced, and the folder is a new one.
  const t2 = a.send(peerB.id, [path.join(src, 'hello.txt'), path.join(src, 'album')]);
  assert.strictEqual((await finished(a, t2)).state, 'done');
  await arrived(b, 2);
  assert.deepStrictEqual([b.offered[1].verified, b.offered[1].known], [true, true]); // accepted once: known from then on
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'Phone B-data', 'localsend-known.json'), 'utf8'))[a.fingerprint]); // and after a restart
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'hello (2).txt'), 'utf8'), 'hello from A');
  assert.ok(fs.readFileSync(path.join(b.save, 'album (2)', 'a.bin')).equals(big));
  assert.deepStrictEqual(fs.readdirSync(path.join(b.save, 'album')).sort(), ['a.bin', 'empty.dat', 'sub']);

  // And the other way, B to A.
  const t3 = b.send(peerA.id, [path.join(src, 'album', 'sub', 'b.txt')]);
  assert.strictEqual((await finished(b, t3)).state, 'done');
  await arrived(a, 1);
  assert.strictEqual(fs.readFileSync(path.join(a.save, 'b.txt'), 'utf8'), 'deep');
  assert.strictEqual(a.offered[0].alias, 'Phone B');
  assert.strictEqual(a.offered[0].known, true); // A sent files to B before: a device it knows

  // ---- a failure path: the person says no ----
  a.policy = (o) => a.answer(o.id, false);
  const t4 = b.send(peerA.id, [path.join(src, 'hello.txt')]);
  const out4 = await finished(b, t4);
  assert.strictEqual(out4.state, 'declined');
  assert.strictEqual(out4.done, 0);
  assert.deepStrictEqual(fs.readdirSync(a.save), ['b.txt']);
  assert.strictEqual(a.ended.at(-1).why, 'declined');
  assert.strictEqual(a._sessions.size, 0);
  // Asking again at once is refused without a question; a little later it's asked again.
  const asked = a.offered.length;
  const out5 = await finished(b, b.send(peerA.id, [path.join(src, 'hello.txt')]));
  assert.strictEqual(out5.state, 'failed');
  assert.strictEqual(out5.error, 'rate');
  assert.strictEqual(a.offered.length, asked);
  await sleep(350);
  a.policy = (o) => a.answer(o.id, true);
  assert.strictEqual((await finished(b, b.send(peerA.id, [path.join(src, 'hello.txt')]))).state, 'done');
  await arrived(a, 2);

  // ---- a client written from the protocol text against our server ----
  const good = Buffer.from('checked bytes');
  const files = [
    { id: 'e1', fileName: '../../evil.txt', data: Buffer.from('evil') },
    { id: 'e2', fileName: '..\\..\\win\\CON.txt', data: Buffer.from('con') },
    { id: 'e3', fileName: '/abs/secret:name?.txt ', data: Buffer.from('abs') },
    { id: 'e4', fileName: 'sha.bin', data: good, sha256: sha(good) },
  ];
  const before = fs.readdirSync(tmp).sort();
  const prep = await raw(b.port, 'POST', `${API}/prepare-upload`, offerOf(files));
  assert.strictEqual(prep.status, 200);
  // No certificate: nobody checked who 'Raw Client' is, and the fingerprint it wrote is not shown as its.
  assert.deepStrictEqual([b.offered.at(-1).verified, b.offered.at(-1).known, b.offered.at(-1).fingerprint], [false, false, '']);
  const sid = prep.json.sessionId;
  const tok = prep.json.files;
  assert.deepStrictEqual(Object.keys(tok).sort(), ['e1', 'e2', 'e3', 'e4']);
  assert.strictEqual(new Set(Object.values(tok)).size, 4);
  // No parameters, a wrong token, another file's token, another session.
  assert.strictEqual((await raw(b.port, 'POST', `${API}/upload?sessionId=${sid}`, Buffer.from('evil'))).status, 400);
  assert.strictEqual((await up(b.port, sid, 'e1', 'wrong', files[0].data)).status, 403);
  assert.strictEqual((await up(b.port, sid, 'e1', tok.e2, files[0].data)).status, 403);
  assert.strictEqual((await up(b.port, 'no-such-session', 'e1', tok.e1, files[0].data)).status, 403);
  // More or fewer bytes than were offered: refused, and nothing is kept.
  assert.strictEqual((await up(b.port, sid, 'e1', tok.e1, Buffer.from('evil+'))).status, 400);
  assert.strictEqual((await up(b.port, sid, 'e1', tok.e1, Buffer.from('ev'), { 'Transfer-Encoding': 'chunked' })).status, 400);
  const over = await up(b.port, sid, 'e1', tok.e1, Buffer.alloc(4096, 1), { 'Transfer-Encoding': 'chunked' });
  assert.ok(over.status === 400 || over.error, `oversize: ${over.status}`);
  assert.strictEqual(b.seen.get(`in-${sid}`).done, 0, 'bytes of a refused body are not counted as received');
  // Bytes that aren't what the hash promised: 422, and the file may be sent again.
  assert.strictEqual((await up(b.port, sid, 'e4', tok.e4, Buffer.from('changed bytes'))).status, 422);
  assert.deepStrictEqual(fs.readdirSync(b.save).filter((n) => /evil|sha|win|abs/.test(n)), []);
  // From another address: the same 403, and it can't cancel the session either.
  const session = b._sessions.get(sid);
  session.ip = '10.9.9.9';
  assert.strictEqual((await up(b.port, sid, 'e1', tok.e1, files[0].data)).status, 403);
  assert.strictEqual((await raw(b.port, 'POST', `${API}/cancel?sessionId=${sid}`)).status, 200);
  assert.ok(b._sessions.has(sid));
  session.ip = '127.0.0.1';
  // The real ones.
  for (const f of files) assert.strictEqual((await up(b.port, sid, f.id, tok[f.id], f.data)).status, 200, f.id);
  assert.strictEqual((await up(b.port, sid, 'e1', tok.e1, files[0].data)).status, 403); // a file arrives once
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'evil.txt'), 'utf8'), 'evil');
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'win', '_CON.txt'), 'utf8'), 'con');
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'abs', 'secret_name_.txt'), 'utf8'), 'abs');
  assert.ok(fs.readFileSync(path.join(b.save, 'sha.bin')).equals(good));
  assert.deepStrictEqual(fs.readdirSync(tmp).sort(), before); // nothing beside the folder
  assert.ok(!b._sessions.has(sid)); // all here: the session is over
  assert.strictEqual((await arrived(b, 3)).at(-1).state, 'done');

  // What isn't an offer.
  const one = { id: 'k', fileName: 'k.txt', data: Buffer.from('k') };
  assert.strictEqual((await raw(b.port, 'POST', `${API}/prepare-upload`, Buffer.from('{not json'))).status, 400);
  assert.strictEqual((await raw(b.port, 'POST', `${API}/prepare-upload`, { info: rawInfo, files: {} })).status, 400);
  assert.strictEqual((await raw(b.port, 'POST', `${API}/prepare-upload`, { info: rawInfo, files: { x: { id: 'same', fileName: 'x', size: 1 }, y: { id: 'same', fileName: 'y', size: 1 } } })).status, 400);
  assert.strictEqual((await raw(b.port, 'POST', `${API}/prepare-upload`, { info: rawInfo, files: { x: { id: 'x', fileName: 'x', size: -1 } } })).status, 400);
  assert.strictEqual((await raw(b.port, 'POST', `${API}/prepare-upload`, { info: rawInfo, files: { x: { id: 'x', fileName: 'x', size: 2 ** 60 } } })).status, 400);
  const asked2 = b.offered.length;
  assert.strictEqual(b.offered.length, asked2);

  // One question at a time from one address; the sender that gives up ends its question.
  b.policy = () => {};
  const waiting = raw(b.port, 'POST', `${API}/prepare-upload`, offerOf([one]));
  await until(() => b.offers().length === 1, 'an offer waits');
  assert.strictEqual((await raw(b.port, 'POST', `${API}/prepare-upload`, offerOf([one]))).status, 429);
  b.answer(b.offers()[0].id, true);
  const held = await waiting;
  assert.strictEqual(held.status, 200);
  // The receiving side stops it: the token is worth nothing now, and what was on its way is gone.
  const inId = [...b.seen.values()].find((t) => t.dir === 'in' && t.state === 'running').id;
  assert.ok(b.cancel(inId));
  assert.strictEqual((await up(b.port, held.json.sessionId, 'k', held.json.files.k, one.data)).status, 403);
  assert.strictEqual(b.seen.get(inId).state, 'cancelled');
  assert.ok(!fs.existsSync(path.join(b.save, 'k.txt')));
  // The sender stops it.
  b.policy = (o) => b.answer(o.id, true);
  const two = [{ id: 'p', fileName: 'p.txt', data: Buffer.from('p') }, { id: 'q', fileName: 'q.txt', data: Buffer.from('q') }];
  const prep2 = await raw(b.port, 'POST', `${API}/prepare-upload`, offerOf(two));
  assert.strictEqual((await up(b.port, prep2.json.sessionId, 'p', prep2.json.files.p, two[0].data)).status, 200);
  assert.strictEqual((await raw(b.port, 'POST', `${API}/cancel?sessionId=${prep2.json.sessionId}`)).status, 200);
  assert.strictEqual((await up(b.port, prep2.json.sessionId, 'q', prep2.json.files.q, two[1].data)).status, 403);
  const cancelled = [...b.seen.values()].at(-1);
  assert.strictEqual(cancelled.state, 'cancelled');
  assert.strictEqual(cancelled.arrived, 1); // what had arrived is kept
  assert.strictEqual(fs.readFileSync(path.join(b.save, 'p.txt'), 'utf8'), 'p');

  // Nobody answers: declined by itself.
  const slow = node('Slow', { approvalMs: 150 });
  slow.policy = () => {};
  await slow.start();
  assert.strictEqual((await raw(slow.port, 'POST', `${API}/prepare-upload`, offerOf([one]))).status, 403);
  assert.strictEqual(slow.ended[0].why, 'timeout');
  // An address that isn't on a local network gets nothing at all.
  const shut = node('Shut', { allow: () => false });
  await shut.start();
  assert.strictEqual((await raw(shut.port, 'GET', `${API}/info`)).status, 403);
  assert.strictEqual((await raw(shut.port, 'POST', `${API}/prepare-upload`, offerOf([one]))).status, 403);
  assert.strictEqual(shut.offered.length, 0);

  // ---- who is asking: the certificate, never what the request says ----
  {
    const gate = node('Gate');
    gate.policy = () => {};
    await gate.start();
    const ask = async (info, identity, accept) => {
      const n = gate.offered.length;
      const p = raw(gate.port, 'POST', `${API}/prepare-upload`, offerOf([one], info), {}, { identity });
      const offer = await until(() => gate.offered[n], 'asked');
      gate.answer(offer.id, accept);
      const res = await p;
      if (accept) await raw(gate.port, 'POST', `${API}/cancel?sessionId=${res.json.sessionId}`, null, {}, { identity });
      else await sleep(350); // the pause after a no
      return offer;
    };
    const phoneId = ls.makeIdentity();
    const phoneInfo = { ...rawInfo, alias: 'Anna\u2019s Phone', fingerprint: phoneId.fingerprint };
    // The device itself, twice: accepted the first time, known the second.
    const first = await ask(phoneInfo, phoneId, true);
    assert.deepStrictEqual([first.verified, first.known, first.imitates, first.fingerprint], [true, false, false, phoneId.fingerprint]);
    const again = await ask(phoneInfo, phoneId, false);
    assert.deepStrictEqual([again.verified, again.known, again.imitates], [true, true, false]);
    // Someone without its key says the same name, fingerprint and address: no certificate, so not
    // verified, not known, no fingerprint shown, and named as using a known device's name.
    const forged = await ask(phoneInfo, null, false);
    assert.deepStrictEqual([forged.alias, forged.verified, forged.known, forged.imitates, forged.fingerprint], ['Anna\u2019s Phone', false, false, true, '']);
    // Someone with a certificate of their own and that name (dressed up): its own fingerprint, a stranger, and named as that too.
    const other = ls.makeIdentity();
    const dressed = await ask({ ...phoneInfo, alias: '\u202eANNA\u2019S\u00a0PHONE\u200b' }, other, false);
    assert.deepStrictEqual([dressed.alias, dressed.verified, dressed.known, dressed.imitates, dressed.fingerprint], ['ANNA\u2019S\u00a0PHONE', true, false, true, other.fingerprint]);
    // The fingerprint a request writes about itself is never the one shown.
    const liar = await ask({ ...phoneInfo, alias: 'Somebody' }, other, false);
    assert.deepStrictEqual([liar.fingerprint, liar.known, liar.imitates], [other.fingerprint, false, false]);

    // /register from a certificate that isn't the one it says: not listed. From the device itself: listed.
    await raw(gate.port, 'POST', `${API}/register`, { ...phoneInfo, port: 9 }, {}, { identity: other });
    assert.strictEqual(gate.peers().length, 0);
    await raw(gate.port, 'POST', `${API}/register`, { ...phoneInfo, port: 9 }, {}, { identity: phoneId });
    assert.strictEqual(gate.peers().length, 1);

    // ---- ten at once from one address: one question ----
    // Every body is held back half-sent, so each request is past the first check before any is asked about.
    let release;
    const hold = new Promise((r) => { release = r; });
    const asked3 = gate.offered.length;
    const flood = Array.from({ length: 10 }, () => raw(gate.port, 'POST', `${API}/prepare-upload`, offerOf([one]), {}, { hold }));
    await sleep(200);
    release();
    await until(() => gate.offers().length >= 1, 'one of them is asked about');
    await sleep(200);
    assert.strictEqual(gate.offers().length, 1);
    assert.strictEqual(gate.offered.length, asked3 + 1);
    gate.answer(gate.offers()[0].id, true); // and that one still gets its yes
    const answers = (await Promise.all(flood)).map((r) => r.status).sort();
    assert.deepStrictEqual(answers, [200, ...Array(9).fill(429)]);
  }

  // ---- on, then off before the port was open: nothing stays listening; on again works ----
  {
    const race = node('Race');
    const starting = race.start();
    race.stop();
    await starting;
    await sleep(50);
    assert.deepStrictEqual([race.running, race.receiving, !!race._server], [false, false, false]);
    const late = node('Race 2');
    const s2 = late.start();
    setImmediate(() => late.stop());
    await s2;
    await sleep(50);
    assert.strictEqual(late.receiving, false);
    if (late.port) assert.strictEqual(await accepts(late.port), false);
    await race.start();
    assert.strictEqual((await raw(race.port, 'GET', `${API}/info`)).status, 200);
  }

  // ---- a connection that came in on an address that isn't a local network's is closed before TLS ----
  {
    const wan = node('Wan', { allowLocal: () => false });
    await wan.start();
    assert.strictEqual(await accepts(wan.port), false);
    assert.ok((await raw(wan.port, 'GET', `${API}/info`)).error);
  }

  // ---- macOS: what arrives is marked as downloaded, the file and the folder made for it ----
  if (process.platform === 'darwin') {
    const q = node('Quarantine', { mark: quarantine });
    await q.start();
    const prepQ = await raw(q.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'x', fileName: 'Tool.app/Contents/MacOS/run', data: Buffer.from('#!/bin/sh\n') }]));
    assert.strictEqual((await up(q.port, prepQ.json.sessionId, 'x', prepQ.json.files.x, Buffer.from('#!/bin/sh\n'))).status, 200);
    const mark = (f) => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', f]).toString().trim();
    assert.match(mark(path.join(q.save, 'Tool.app', 'Contents', 'MacOS', 'run')), /^0081;[0-9a-f]+;TwinDesk;$/);
    assert.match(mark(path.join(q.save, 'Tool.app')), /^0081;[0-9a-f]+;TwinDesk;$/);
    // The mark can't be made: said in the log, and the file still arrives (it was accepted).
    const lines = [];
    const q2 = node('Unmarked', { mark: () => Promise.reject(new Error('no xattr')), log: (l) => lines.push(l) });
    await q2.start();
    const prepU = await raw(q2.port, 'POST', `${API}/prepare-upload`, offerOf([one]));
    assert.strictEqual((await up(q2.port, prepU.json.sessionId, 'k', prepU.json.files.k, one.data)).status, 200);
    assert.ok(fs.existsSync(path.join(q2.save, 'k.txt')) && lines.some((l) => /no xattr/.test(l)));
  }

  // Cancellation during quarantine must not publish the completed part.
  {
    let entered, release;
    const marking = new Promise((r) => { entered = r; });
    const hold = new Promise((r) => { release = r; });
    const receiver = node('Cancel while marking', { mark: async () => { entered(); await hold; } });
    await receiver.start();
    const data = Buffer.from('cancelled');
    const prep = await raw(receiver.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'x', fileName: 'cancelled.txt', data }]));
    const upload = up(receiver.port, prep.json.sessionId, 'x', prep.json.files.x, data);
    await marking;
    receiver._endSession(receiver._sessions.get(prep.json.sessionId), 'cancelled');
    release();
    await upload;
    assert.strictEqual(fs.existsSync(path.join(receiver.save, 'cancelled.txt')), false);
  }

  // ---- our client against a receiver that takes no connection without a client certificate ----
  {
    const strict = await fakeReceiver(true);
    const peerS = await a.probe('127.0.0.1', strict.port);
    assert.ok(peerS.verified);
    assert.strictEqual((await finished(a, a.send(peerS.id, [path.join(src, 'hello.txt')]))).state, 'done');
    assert.strictEqual(strict.uploads.length, 1);
    assert.ok(strict.certs.length >= 3 && strict.certs.every((c) => c === a.fingerprint), 'every request presented our certificate');
    assert.strictEqual(strict.refused, 0);
    // What that receiver does to a client with none (what ours was before): nothing gets through.
    assert.ok((await raw(strict.port, 'GET', `${API}/info`)).error);
    assert.strictEqual(strict.refused, 1);
  }

  // ---- our client against a receiver written from the protocol text ----
  const phone = await fakeReceiver();
  const peerP = await a.probe('127.0.0.1', phone.port);
  assert.strictEqual(peerP.alias, 'Fake Phone');
  assert.strictEqual(peerP.deviceType, 'mobile');
  assert.strictEqual(peerP.fingerprint, phone.id.fingerprint);
  assert.ok(peerP.verified && peerP.supported);
  assert.strictEqual(phone.registers[0].fingerprint, a.fingerprint);
  assert.strictEqual(phone.registers[0].protocol, 'https');
  const t6 = a.send(peerP.id, [path.join(src, 'album')]);
  assert.strictEqual((await finished(a, t6)).state, 'done');
  const dto = phone.prepares[0];
  assert.strictEqual(dto.info.alias, 'Mac A');
  assert.strictEqual(dto.info.fingerprint, a.fingerprint);
  assert.strictEqual(dto.info.version, '2.2');
  const sent = Object.values(dto.files);
  assert.deepStrictEqual(sent.map((f) => f.fileName).sort(), ['album/a.bin', 'album/empty.dat', 'album/sub/b.txt']);
  for (const [key, f] of Object.entries(dto.files)) assert.strictEqual(f.id, key);
  const bin = sent.find((f) => f.fileName === 'album/a.bin');
  assert.strictEqual(bin.size, big.length);
  assert.strictEqual(bin.sha256, sha(big));
  assert.match(bin.metadata.modified, /^\d{4}-\d\d-\d\dT/);
  assert.strictEqual(phone.uploads.length, 3);
  const gotBin = phone.uploads.find((u) => u.fileId === bin.id);
  assert.ok(gotBin.body.equals(big));
  assert.strictEqual(Number(gotBin.length), big.length);
  // A PIN: said so, then sent with it.
  phone.mode = 'pin';
  const out7 = await finished(a, a.send(peerP.id, [path.join(src, 'hello.txt')]));
  assert.deepStrictEqual([out7.state, out7.error], ['failed', 'pin']);
  assert.strictEqual((await finished(a, a.send(peerP.id, [path.join(src, 'hello.txt')], { pin: '4321' }))).state, 'done');
  phone.mode = 'busy';
  assert.strictEqual((await finished(a, a.send(peerP.id, [path.join(src, 'hello.txt')]))).error, 'busy');
  phone.mode = 'no';
  assert.strictEqual((await finished(a, a.send(peerP.id, [path.join(src, 'hello.txt')]))).state, 'declined');
  // It took only one of the files: that one is sent, and it's done.
  phone.mode = 'partial';
  const ups = phone.uploads.length;
  assert.strictEqual((await finished(a, a.send(peerP.id, [path.join(src, 'album')]))).state, 'done');
  assert.strictEqual(phone.uploads.length, ups + 1);
  // We stop while it's on its way: the other side is told.
  phone.mode = 'stall';
  const t8 = a.send(peerP.id, [path.join(src, 'album', 'a.bin')]);
  await until(() => phone.stalled.length === 1, 'the upload is on its way');
  assert.ok(a.cancel(t8));
  assert.strictEqual((await finished(a, t8)).state, 'cancelled');
  await until(() => phone.cancels.includes('S 1'), 'the cancel arrives');
  phone.mode = 'ok';
  assert.throws(() => a.send(peerP.id, [path.join(src, 'nothing-here')]), (e) => e.code === 'empty');
  assert.throws(() => a.send('nobody', [path.join(src, 'hello.txt')]), (e) => e.code === 'peer');

  // ---- a failure path: another device says it's B ----
  const impostor = await fakeReceiver();
  const claim = Buffer.from(JSON.stringify({ ...b.info(true), port: impostor.port }));
  // To A, who has checked B: B stays where it was proven to be.
  a._onDatagram(claim, { address: '127.0.0.1' });
  await sleep(300);
  const stillB = a.peers().find((p) => p.fingerprint === b.fingerprint);
  assert.ok(stillB.verified && stillB.port === b.port);
  // Nor is a proven device renamed by a datagram that has its address as the source.
  a._onDatagram(Buffer.from(JSON.stringify({ ...b.info(true), alias: 'Printer (do not use)' })), { address: '127.0.0.1' });
  assert.strictEqual(a.peers().find((p) => p.fingerprint === b.fingerprint).alias, 'Phone B');
  // To a device that has never seen B: it's listed as said, never as verified, and nothing is sent to it.
  const fresh = node('Fresh');
  await fresh.start();
  fresh._onDatagram(claim, { address: '127.0.0.1' });
  const fake = await until(() => fresh.peers().find((p) => p.fingerprint === b.fingerprint), 'the claim is listed');
  await sleep(300);
  assert.strictEqual(fresh.peers()[0].verified, false);
  const out9 = await finished(fresh, fresh.send(fake.id, [path.join(src, 'hello.txt')]));
  assert.deepStrictEqual([out9.state, out9.error], ['failed', 'fingerprint']);
  assert.strictEqual(impostor.requests, 0); // not one request went to it, only the handshake
  await assert.rejects(ls.request({ ip: '127.0.0.1', port: impostor.port, fingerprint: b.fingerprint, method: 'GET', path: `${API}/info` }), (e) => e.code === 'fingerprint');

  // ---- what we don't speak is listed as that, and nothing is sent ----
  const other = node('Other');
  await other.start();
  const said = (o) => other._onDatagram(Buffer.from(JSON.stringify({ alias: 'x', version: '2.1', deviceModel: 'm', deviceType: 'mobile', fingerprint: 'ee'.repeat(32), port: 53317, protocol: 'https', announce: true, ...o })), { address: '192.168.7.7' });
  said({ alias: 'Plain', protocol: 'http', fingerprint: 'random string' });
  said({ alias: 'Old', version: '1.0', fingerprint: '11'.repeat(32) });
  said({ alias: 'Future', version: '3.0', fingerprint: '22'.repeat(32) });
  said({ alias: 'No fingerprint', fingerprint: 'short' }); // not a device over HTTPS
  const by = Object.fromEntries(other.peers().map((p) => [p.alias, p]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['Future', 'Old', 'Plain']);
  assert.deepStrictEqual([by.Plain.supported, by.Plain.why], [false, 'plain']);
  assert.deepStrictEqual([by.Old.supported, by.Old.why], [false, 'v1']);
  assert.deepStrictEqual([by.Future.supported, by.Future.why], [false, 'newer']);
  assert.throws(() => other.send(by.Plain.id, [path.join(src, 'hello.txt')]), (e) => e.code === 'plain');
  assert.throws(() => other.send(by.Old.id, [path.join(src, 'hello.txt')]), (e) => e.code === 'v1');
  // A device known over HTTPS isn't moved to HTTP by someone using its name.
  const known = ls.peerFrom(b.info(), '127.0.0.1');
  assert.strictEqual(ls.downgrades(known, ls.peerFrom({ ...b.info(), protocol: 'http' }, '127.0.0.1')), true);
  assert.strictEqual(ls.downgrades(known, ls.peerFrom(b.info(), '127.0.0.1')), false);
  a._onDatagram(Buffer.from(JSON.stringify({ ...b.info(true), protocol: 'http' })), { address: '127.0.0.1' });
  assert.ok(a.peers().find((p) => p.fingerprint === b.fingerprint).supported);
  // By address: a device with encryption off is named as that; nothing there is 'unreachable'.
  const plain = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ alias: 'Plain', version: '2.1', fingerprint: 'r' })); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  closers.push(() => { plain.close(); plain.closeAllConnections(); });
  await assert.rejects(a.probe('127.0.0.1', plain.address().port), (e) => e.code === 'plain');
  const free = plain.address().port;
  plain.close();
  plain.closeAllConnections();
  await assert.rejects(a.probe('127.0.0.1', free), (e) => e.code === 'unreachable');
  await assert.rejects(a.probe('8.8.8.8'), (e) => e.code === 'address');
  await assert.rejects(a.probe('example.com'), (e) => e.code === 'address');
  await assert.rejects(a.probe('10.999.1.1'), (e) => e.code === 'address'); // never a name to look up

  // ---- the port is another app's: we still find and send, and say we don't receive ----
  const second = node('Second', { port: a.port });
  await second.start();
  assert.deepStrictEqual([second.receiving, second.error], [false, 'port']);
  const viaInfo = await second.probe('127.0.0.1', b.port); // GET /info, since there's nothing to register
  assert.ok(viaInfo.verified);
  assert.strictEqual((await finished(second, second.send(viaInfo.id, [path.join(src, 'hello.txt')]))).state, 'done');

  // ---- a flood of claims fills the list, and a device that proves itself still gets in ----
  const crowd = node('Crowd');
  await crowd.start();
  for (let i = 0; i < 100; i++) {
    crowd._onDatagram(Buffer.from(JSON.stringify({ alias: `Claim ${i}`, version: '2.1', fingerprint: sha(Buffer.from(`claim ${i}`)), port: free, protocol: 'https', announce: false })), { address: '127.0.0.1' });
  }
  assert.strictEqual(crowd.peers().length, 64);
  assert.ok(crowd.peers().every((p) => !p.verified));
  const real = await crowd.probe('127.0.0.1', b.port);
  assert.ok(real.verified);
  assert.strictEqual(crowd.peers().length, 64);
  assert.ok(crowd.peers().some((p) => p.id === real.id && p.verified), 'the proven device is listed');

  // ---- off means off ----
  b.stop();
  assert.strictEqual(b.peers().length, 0);
  assert.ok((await raw(b.port, 'GET', `${API}/info`)).error);
  console.log('localsend: ok');
}

main().then(() => 0, (e) => { console.error(e); return 1; }).then((code) => {
  for (const c of closers) { try { c(); } catch { /* closed */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
});
