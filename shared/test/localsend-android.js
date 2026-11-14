// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's LocalSend-compatible core (android/.../LocalSendCore.kt) against the computers' one
// (shared/localsend/core.js), offline on 127.0.0.1: the Kotlin file is compiled as it is and run on
// a plain JVM (android/tools/LocalSendHarness.kt), and the two send to each other in both directions.
// A client written here from the protocol text also talks to the Kotlin server (names, tokens, sizes).
//
// It needs Java and the Kotlin compiler and org.json that Gradle downloaded for the Android build
// (~/.gradle); where they aren't, it says so and is skipped. Nothing is downloaded.
'use strict';

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');
const tls = require('tls');
const ls = require('../localsend/core.js');

const { LocalSend, API } = ls;
const ROOT = path.join(__dirname, '../..');
const CORE = path.join(ROOT, 'android/app/src/main/java/com/twindesk/android/LocalSendCore.kt');
const HARNESS = path.join(ROOT, 'android/tools/LocalSendHarness.kt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- the tools, from Gradle's cache ----

function tools() {
  if (spawnSync('java', ['-version'], { stdio: 'ignore' }).status !== 0) return { missing: 'Java' };
  const cache = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'), 'caches/modules-2/files-2.1');
  const versions = (group, name) => { try { return fs.readdirSync(path.join(cache, group, name)); } catch { return []; } };
  const jar = (group, name, version) => {
    const dir = path.join(cache, group, name, version);
    try {
      for (const hash of fs.readdirSync(dir)) {
        const f = path.join(dir, hash, `${name}-${version}.jar`);
        if (fs.existsSync(f)) return f;
      }
    } catch { /* not there */ }
    return null;
  };
  const newest = (group, name) => versions(group, name).map((v) => jar(group, name, v)).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop() || null;
  const K = 'org.jetbrains.kotlin';
  for (const v of versions(K, 'kotlin-compiler-embeddable').sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
    const need = [jar(K, 'kotlin-compiler-embeddable', v), jar(K, 'kotlin-stdlib', v), jar(K, 'kotlin-script-runtime', v), jar(K, 'kotlin-daemon-embeddable', v),
      newest(K, 'kotlin-reflect'), newest('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'), newest('org.jetbrains', 'annotations')];
    const json = newest('org.json', 'json');
    if (need.every(Boolean) && json) return { compiler: need, stdlib: need[1], json };
  }
  return { missing: 'the Kotlin compiler and org.json in Gradle’s cache' };
}

const t = tools();
if (t.missing) {
  console.log(`localsend-android: skipped (${t.missing} not found)`);
  return;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-localsend-android-')));
const classes = path.join(tmp, 'classes');
const built = spawnSync('java', ['-cp', t.compiler.join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-nowarn',
  '-jvm-target', '17', '-cp', [t.stdlib, t.json].join(path.delimiter), '-d', classes, CORE, HARNESS], { encoding: 'utf8' });
assert.strictEqual(built.status, 0, `LocalSendCore.kt compiles without Android:\n${built.stdout}${built.stderr}`);

// ---- the Kotlin node ----

function kotlin(name, ...args) {
  const dir = path.join(tmp, name);
  // UTF-8 for file names whatever the shell's locale is.
  const child = spawn('java', ['-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8', '-cp', [classes, t.stdlib, t.json].join(path.delimiter), 'com.twindesk.android.LocalSendHarnessKt', dir, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
  const k = { child, dir, offers: [], ended: [], seen: new Map(), replies: new Map(), policy: (o) => k.cmd('answer', { id: o.id, accept: true }), ready: null, err: '' };
  child.stderr.on('data', (d) => { k.err += d; if (process.env.LS_DEBUG) console.error(`kotlin! ${d}`); });
  let tag = 0;
  k.cmd = (cmd, extra = {}) => new Promise((resolve) => {
    const id = `t${++tag}`;
    k.replies.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ cmd, tag: id, ...extra })}\n`);
  });
  const lines = readline.createInterface({ input: child.stdout });
  k.started = new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`the Kotlin node ended (${code}): ${k.err}`)));
    lines.on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (process.env.LS_DEBUG) console.error('kotlin:', line);
      if (m.ev === 'ready') { k.ready = m; resolve(m); }
      if (m.ev === 'offer') { k.offers.push(m); k.policy(m); }
      if (m.ev === 'offerEnd') k.ended.push(m);
      if (m.ev === 'transfer') k.seen.set(m.id, m);
      if (m.ev === 'reply') { const r = k.replies.get(m.tag); k.replies.delete(m.tag); if (r) r(m); }
    });
  });
  k.started.catch(() => {});
  return k;
}

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(15);
  }
}
const finished = (n, id) => until(() => { const x = n.seen.get(id); return x && x.state !== 'waiting' && x.state !== 'running' ? x : null; }, `transfer ${id}`);

// A request as the protocol text describes it, with nothing of ours. o.identity: the client
// certificate it presents (none by default). o.hold: a promise the second half of the body waits for.
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
        resolve({ status: res.statusCode, json, fp });
      });
      res.on('error', () => resolve({ status: 0 }));
    });
    req.on('error', () => resolve({ status: 0 }));
    if (o.hold && data) { req.write(data.subarray(0, 10)); o.hold.then(() => req.end(data.subarray(10))); } else req.end(data || undefined);
  });
}
const rawInfo = { alias: 'Raw Client', version: '2.1', deviceModel: 'Test', deviceType: 'headless', fingerprint: 'ab'.repeat(32), port: 53317, protocol: 'https', download: false };
const offerOf = (files, info = rawInfo) => ({ info, files: Object.fromEntries(files.map((f) => [f.id, { id: f.id, fileName: f.fileName, size: f.size ?? f.data.length, fileType: 'application/octet-stream', ...(f.sha256 ? { sha256: f.sha256 } : {}) }])) });
const up = (port, s, id, tok, data, headers) => raw(port, 'POST', `${API}/upload?sessionId=${encodeURIComponent(s)}&fileId=${encodeURIComponent(id)}&token=${encodeURIComponent(tok)}`, data, headers);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

async function main() {
  const k = kotlin('phone', '60000', '300');
  const ready = await k.started;
  assert.ok(ready.receiving && ready.port > 0 && /^[0-9a-f]{64}$/.test(ready.fingerprint));
  const kReceived = fs.realpathSync(ready.received);

  const save = path.join(tmp, 'mac-received');
  fs.mkdirSync(save);
  const mac = new LocalSend({ dir: path.join(tmp, 'mac-data'), alias: () => 'Node Mac', saveDir: () => save, port: 0, host: '127.0.0.1', multicast: false, cooldownMs: 300 });
  mac.seen = new Map();
  mac.offered = [];
  mac.ended = [];
  mac.policy = (o) => mac.answer(o.id, true);
  mac.on('transfer', (x) => mac.seen.set(x.id, x));
  mac.on('offer', (o) => { mac.offered.push(o); mac.policy(o); });
  mac.on('offerEnd', (e) => mac.ended.push(e));
  await mac.start();

  // ---- what was sent out, for comparing ----
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'album/day 1'), { recursive: true });
  const files = {
    'album/a.txt': Buffer.from('hello from the other side\n'),
    'album/day 1/big.bin': crypto.randomBytes(5 * 1024 * 1024 + 123),
    'album/day 1/empty': Buffer.alloc(0),
    'привет мир.txt': Buffer.from('юникод'),
  };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(src, name), data);

  // ---- the certificate is the identity: the same fingerprint over the wire as each says ----
  const info = await raw(ready.port, 'GET', `${API}/info`);
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.fp, ready.fingerprint, 'the Kotlin certificate is its fingerprint');
  assert.strictEqual(info.json.fingerprint, ready.fingerprint);
  assert.strictEqual(info.json.alias, 'Kotlin node');
  assert.strictEqual(info.json.protocol, 'https');
  assert.strictEqual(info.json.version, '2.2');
  assert.strictEqual(info.json.download, false);

  // ---- finding each other: Node asks Kotlin (/register), which then checks Node back over TLS ----
  const phone = await mac.probe('127.0.0.1', ready.port);
  assert.ok(phone.verified && phone.supported);
  assert.strictEqual(phone.fingerprint, ready.fingerprint);
  assert.strictEqual(phone.alias, 'Kotlin node');
  assert.strictEqual(phone.deviceType, 'mobile');
  const macPeer = await until(async () => (await k.cmd('peers')).peers.find((p) => p.fingerprint === mac.fingerprint && p.verified), 'Kotlin verified Node');
  assert.strictEqual(macPeer.alias, 'Node Mac');
  assert.strictEqual(macPeer.port, mac.port);

  // ---- Node → Kotlin: a folder, a large file, an empty one, a name that isn't ASCII ----
  let tid = mac.send(phone.id, [path.join(src, 'album'), path.join(src, 'привет мир.txt')]);
  let done = await finished(mac, tid);
  assert.strictEqual(done.state, 'done', done.error);
  assert.strictEqual(k.offers.length, 1);
  assert.strictEqual(k.offers[0].alias, 'Node Mac');
  // Who it is comes from the certificate Node's connection presented; known is a device accepted before.
  assert.deepStrictEqual([k.offers[0].verified, k.offers[0].known, k.offers[0].imitates, k.offers[0].fingerprint], [true, false, false, mac.fingerprint]);
  assert.strictEqual(k.offers[0].files, 4);
  assert.deepStrictEqual(k.offers[0].names.sort(), ['album', 'привет мир.txt']);
  let got = await until(() => [...k.seen.values()].find((x) => x.incoming && x.state === 'done'), 'Kotlin received');
  assert.strictEqual(got.arrived, 4);
  assert.strictEqual(got.done, got.total);
  for (const [name, data] of Object.entries(files)) assert.strictEqual(sha(fs.readFileSync(path.join(kReceived, name))), sha(data), `Kotlin has ${name}`);

  // ---- Kotlin → Node: the same back ----
  const list = Object.keys(files).map((name) => ({ name, path: path.join(src, name) }));
  list[0].sha256 = sha(files['album/a.txt']); // one with its hash, as some apps send
  let r = await k.cmd('send', { peer: macPeer.id, files: list });
  assert.ok(r.id, r.error);
  let sent = await finished(k, r.id);
  assert.strictEqual(sent.state, 'done', sent.error);
  assert.strictEqual(sent.done, sent.total);
  assert.strictEqual(mac.offered.length, 1);
  assert.strictEqual(mac.offered[0].alias, 'Kotlin node');
  // Kotlin's connection presented Kotlin's certificate; Node sent it files before, so it knows it.
  assert.deepStrictEqual([mac.offered[0].verified, mac.offered[0].known, mac.offered[0].fingerprint], [true, true, ready.fingerprint]);
  for (const [name, data] of Object.entries(files)) assert.strictEqual(sha(fs.readFileSync(path.join(save, name))), sha(data), `Node has ${name}`);

  // ---- no: nothing is written on either side ----
  const before = walk(kReceived).length;
  k.policy = (o) => k.cmd('answer', { id: o.id, accept: false });
  tid = mac.send(phone.id, [path.join(src, 'album/a.txt')]);
  done = await finished(mac, tid);
  assert.strictEqual(done.state, 'declined');
  assert.strictEqual(k.offers.at(-1).known, true, 'accepted once: known from then on');
  assert.strictEqual(walk(kReceived).length, before);
  assert.strictEqual((await raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'a', fileName: 'a', data: Buffer.from('x') }]))).status, 429, 'after a no, that address waits');
  await sleep(350);
  k.policy = (o) => k.cmd('answer', { id: o.id, accept: true });

  const macBefore = walk(save).length;
  mac.policy = (o) => mac.answer(o.id, false);
  r = await k.cmd('send', { peer: macPeer.id, files: [list[0]] });
  sent = await finished(k, r.id);
  assert.strictEqual(sent.state, 'declined');
  assert.strictEqual(walk(save).length, macBefore);
  await sleep(350);

  // ---- the sender gives up while the person is asked: the question goes away ----
  mac.policy = () => {};
  r = await k.cmd('send', { peer: macPeer.id, files: [list[0]] });
  await until(() => mac.offers().length === 1, 'Node is asked');
  assert.strictEqual((await k.cmd('cancel', { id: r.id })).ok, true);
  sent = await finished(k, r.id);
  assert.strictEqual(sent.state, 'cancelled');
  await until(() => mac.offers().length === 0, 'Node’s question ended');
  assert.strictEqual(mac.ended[mac.ended.length - 1].why, 'gone');

  k.policy = () => {};
  const asked = k.offers.length;
  tid = mac.send(phone.id, [path.join(src, 'album/a.txt')]);
  await until(() => k.offers.length === asked + 1, 'Kotlin is asked');
  mac.cancel(tid);
  done = await finished(mac, tid);
  assert.strictEqual(done.state, 'cancelled');
  await until(() => k.ended.some((e) => e.id === k.offers[asked].id && e.why === 'gone'), 'Kotlin’s question ended');
  mac.policy = (o) => mac.answer(o.id, true);
  k.policy = (o) => k.cmd('answer', { id: o.id, accept: true });

  // ---- the receiver stops a transfer that's arriving: the rest isn't kept as a whole file ----
  // (The body is held back by a client of ours, so the stop always lands mid-file.)
  {
    const data = crypto.randomBytes(300000);
    const p = await raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'slow', fileName: 'slow.bin', data }]));
    assert.strictEqual(p.status, 200);
    const count = walk(kReceived).length;
    const half = new Promise((resolve) => {
      const req = https.request({ host: '127.0.0.1', port: ready.port, method: 'POST', rejectUnauthorized: false, agent: false,
        path: `${API}/upload?sessionId=${p.json.sessionId}&fileId=slow&token=${p.json.files.slow}`, headers: { 'Content-Length': data.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0));
      req.write(data.subarray(0, 100000));
    });
    const running = await until(() => [...k.seen.values()].find((x) => x.incoming && x.state === 'running' && x.names[0] === 'slow.bin' && x.done > 0), 'the upload is arriving');
    assert.strictEqual((await k.cmd('cancel', { id: running.id })).ok, true);
    const end = await finished(k, running.id);
    assert.strictEqual(end.state, 'cancelled');
    assert.ok([0, 409].includes(await half), 'the upload was cut');
    assert.strictEqual(walk(kReceived).length, count, 'nothing of a stopped file is kept');
    assert.strictEqual((await up(ready.port, p.json.sessionId, 'slow', p.json.files.slow, data)).status, 403, 'the session is over');
  }

  // ---- a client that isn't ours, against the Kotlin server ----
  {
    const evil = [
      { id: 'a', fileName: '../../evil.txt', data: Buffer.from('one') },
      { id: 'b', fileName: '..\\..\\win\\CON.txt', data: Buffer.from('two') },
      { id: 'c', fileName: '/abs/secret:name?.txt ', data: Buffer.from('three') },
      { id: 'd', fileName: 'ok/sum.bin', data: Buffer.from('four'), sha256: sha(Buffer.from('other')) },
      { id: 'e', fileName: 'short.bin', data: Buffer.from('12345678') },
    ];
    const p = await raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf(evil));
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.fp, ready.fingerprint);
    const offer = k.offers[k.offers.length - 1];
    assert.deepStrictEqual([offer.verified, offer.known, offer.fingerprint], [false, false, ''], 'no certificate: nobody checked who it is, and what it wrote is not shown as its');
    assert.strictEqual(offer.alias, 'Raw Client');
    const { sessionId, files: tokens } = p.json;
    assert.strictEqual(Object.keys(tokens).length, 5);
    assert.strictEqual((await up(ready.port, sessionId, 'a', 'wrong', evil[0].data)).status, 403, 'a wrong token');
    assert.strictEqual((await up(ready.port, 'nope', 'a', tokens.a, evil[0].data)).status, 403, 'a session that isn’t');
    assert.strictEqual((await up(ready.port, sessionId, 'a', tokens.b, evil[0].data)).status, 403, 'another file’s token');
    assert.strictEqual((await raw(ready.port, 'POST', `${API}/upload?sessionId=${sessionId}`, Buffer.from('x'))).status, 400, 'no file named');
    assert.strictEqual((await up(ready.port, sessionId, 'e', tokens.e, Buffer.from('1234'))).status, 400, 'fewer bytes than offered');
    assert.strictEqual((await up(ready.port, sessionId, 'e', tokens.e, Buffer.from('123456789'))).status, 400, 'more bytes than offered');
    assert.strictEqual((await up(ready.port, sessionId, 'e', tokens.e, Buffer.from('123456789abc'), { 'Transfer-Encoding': 'chunked' })).status, 400, 'more bytes, in chunks');
    assert.strictEqual((await up(ready.port, sessionId, 'e', tokens.e, Buffer.from('123'), { 'Transfer-Encoding': 'chunked' })).status, 400, 'fewer bytes, in chunks');
    assert.strictEqual((await up(ready.port, sessionId, 'd', tokens.d, evil[3].data)).status, 422, 'not the bytes its hash promised');
    for (const f of evil.slice(0, 3)) assert.strictEqual((await up(ready.port, sessionId, f.id, tokens[f.id], f.data)).status, 200);
    assert.strictEqual((await up(ready.port, sessionId, 'a', tokens.a, evil[0].data)).status, 403, 'a file is taken once');
    assert.strictEqual((await up(ready.port, sessionId, 'e', tokens.e, Buffer.from('12345678'), { 'Transfer-Encoding': 'chunked' })).status, 200, 'the right bytes in chunks');
    assert.strictEqual(fs.readFileSync(path.join(kReceived, 'evil.txt'), 'utf8'), 'one');
    assert.strictEqual(fs.readFileSync(path.join(kReceived, 'win/_CON.txt'), 'utf8'), 'two');
    assert.strictEqual(fs.readFileSync(path.join(kReceived, 'abs/secret_name_.txt'), 'utf8'), 'three');
    assert.ok(!fs.existsSync(path.join(kReceived, 'ok/sum.bin')), 'a file with the wrong hash is not kept');
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')) && !fs.existsSync(path.join(k.dir, 'evil.txt')), 'nothing left the folder');
    for (const f of walk(k.dir)) assert.ok(fs.realpathSync(f).startsWith(fs.realpathSync(k.dir) + path.sep));
    assert.strictEqual((await raw(ready.port, 'POST', `${API}/cancel?sessionId=${sessionId}`)).status, 200);
    const end = await until(() => [...k.seen.values()].find((x) => x.id === `in-${sessionId}` && x.state === 'cancelled'), 'the session ended');
    assert.strictEqual(end.arrived, 4);
    assert.strictEqual(end.done, 3 + 3 + 5 + 8, 'only what was kept is counted');
    assert.ok([...k.seen.values()].every((x) => x.done >= 0 && x.done <= x.total));

    // What isn't an offer.
    for (const bad of [
      { info: rawInfo, files: {} },
      { info: rawInfo },
      { info: rawInfo, files: { a: { id: 'a', fileName: 'a', size: -1, fileType: 'x' } } },
      { info: rawInfo, files: { a: { id: 'a', fileName: 'a', size: 1.5, fileType: 'x' } } },
      { info: rawInfo, files: { a: { id: 'a', fileName: 'a', size: '1e9', fileType: 'x' } } },
      { info: rawInfo, files: { a: { id: 'a', fileName: '', size: 1, fileType: 'x' } } },
      { info: rawInfo, files: { a: { id: 'same', fileName: 'a', size: 1, fileType: 'x' }, b: { id: 'same', fileName: 'b', size: 1, fileType: 'x' } } },
    ]) assert.strictEqual((await raw(ready.port, 'POST', `${API}/prepare-upload`, bad)).status, 400, JSON.stringify(bad.files));
    assert.strictEqual((await raw(ready.port, 'POST', `${API}/prepare-upload`, Buffer.from('{not json'))).status, 400);
    assert.strictEqual((await raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'x', fileName: 'huge.bin', size: 900000000000000, data: Buffer.alloc(0) }]))).status, 507, 'more than fits');
    assert.strictEqual((await raw(ready.port, 'GET', '/api/localsend/v1/info')).status, 404, 'v1 is not spoken');
    assert.strictEqual((await raw(ready.port, 'GET', `${API}/nothing`)).status, 404);
  }

  // ---- one question per address at a time ----
  {
    k.policy = () => {};
    const first = raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'a', fileName: 'q.txt', data: Buffer.from('q') }]));
    const n = k.offers.length;
    await until(() => k.offers.length === n + 1, 'the first question');
    assert.strictEqual((await raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf([{ id: 'a', fileName: 'q2.txt', data: Buffer.from('q') }]))).status, 429);
    await k.cmd('answer', { id: k.offers[n].id, accept: false });
    assert.strictEqual((await first).status, 403);
    await sleep(350);

    // A sender that keeps its connection open after the answer doesn't keep ours: we hang up.
    const body = JSON.stringify(offerOf([{ id: 'a', fileName: 'held.txt', data: Buffer.from('h') }]));
    const sock = tls.connect({ host: '127.0.0.1', port: ready.port, rejectUnauthorized: false });
    let answer = '';
    const closed = new Promise((resolve) => { sock.on('data', (d) => { answer += d; }); sock.on('end', () => resolve(true)); sock.on('error', () => resolve(true)); });
    sock.write(`POST ${API}/prepare-upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await until(() => k.offers.length === n + 2, 'the held question');
    await k.cmd('answer', { id: k.offers[n + 1].id, accept: false });
    assert.strictEqual(await Promise.race([closed, sleep(3000).then(() => false)]), true, 'the connection is closed from our side');
    assert.match(answer, /^HTTP\/1\.1 403 /);
    sock.destroy();
    k.policy = (o) => k.cmd('answer', { id: o.id, accept: true });
    await sleep(350);
  }

  // ---- who is asking: the certificate, never what the request says ----
  {
    k.policy = () => {};
    const one = [{ id: 'a', fileName: 'who.txt', data: Buffer.from('w') }];
    const ask = async (info, identity) => {
      const n = k.offers.length;
      const p = raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf(one, info), {}, { identity });
      const offer = await until(() => k.offers[n], 'asked');
      await k.cmd('answer', { id: offer.id, accept: false });
      assert.strictEqual((await p).status, 403);
      await sleep(350);
      return offer;
    };
    // Someone without Node's key says Node's name, fingerprint and address.
    const forged = await ask(mac.info(), null);
    assert.deepStrictEqual([forged.alias, forged.verified, forged.known, forged.imitates, forged.fingerprint], ['Node Mac', false, false, true, '']);
    // Someone with a certificate of their own and that name, dressed up.
    const other = ls.makeIdentity();
    const dressed = await ask({ ...mac.info(), alias: '\u202eNODE\u00a0MAC\u200b' }, other);
    assert.deepStrictEqual([dressed.alias, dressed.verified, dressed.known, dressed.imitates, dressed.fingerprint], ['NODE\u00a0MAC', true, false, true, other.fingerprint]);
    // Node itself, whatever it writes about itself.
    const real = await ask({ ...mac.info(), fingerprint: 'ab'.repeat(32) }, mac.identity);
    assert.deepStrictEqual([real.verified, real.known, real.imitates, real.fingerprint], [true, true, false, mac.fingerprint]);

    // ---- ten at once from one address: one question ----
    let release;
    const hold = new Promise((res) => { release = res; });
    const n = k.offers.length;
    const flood = Array.from({ length: 10 }, () => raw(ready.port, 'POST', `${API}/prepare-upload`, offerOf(one), {}, { hold }));
    await sleep(300);
    release();
    await until(() => k.offers.length > n, 'one of them is asked about');
    await sleep(300);
    assert.strictEqual(k.offers.length, n + 1);
    await k.cmd('answer', { id: k.offers[n].id, accept: true }); // and that one still gets its yes
    const answers = await Promise.all(flood);
    assert.deepStrictEqual(answers.map((x) => x.status).sort(), [200, ...Array(9).fill(429)]);
    await raw(ready.port, 'POST', `${API}/cancel?sessionId=${answers.find((x) => x.status === 200).json.sessionId}`);
    k.policy = (o) => k.cmd('answer', { id: o.id, accept: true });
  }

  // ---- Kotlin's client against a receiver that takes no connection without a client certificate ----
  // (What the review says the reference app does since 1.17; a stand-in written here, not that app.)
  {
    const id = ls.makeIdentity();
    const seen = { certs: [], refused: 0, uploads: 0 };
    const about = { alias: 'Strict', version: '2.1', deviceModel: 'x', deviceType: 'desktop', fingerprint: id.fingerprint, download: false };
    const strict = https.createServer({ key: id.keyPem, cert: id.certPem, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const c = req.socket.getPeerCertificate();
      if (!c || !c.raw) { seen.refused++; return req.socket.destroy(); }
      seen.certs.push(sha(c.raw));
      const url = new URL(req.url, 'https://x');
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const send = (obj) => { res.writeHead(200, obj ? { 'Content-Type': 'application/json' } : {}); res.end(obj ? JSON.stringify(obj) : undefined); };
        if (url.pathname === `${API}/prepare-upload`) return send({ sessionId: 's', files: Object.fromEntries(Object.keys(JSON.parse(Buffer.concat(chunks).toString()).files).map((f) => [f, 'tok'])) });
        if (url.pathname === `${API}/upload`) { seen.uploads++; return send(null); }
        return send(about);
      });
    });
    await new Promise((res) => strict.listen(0, '127.0.0.1', res));
    const added = await k.cmd('probe', { host: '127.0.0.1', port: strict.address().port });
    assert.ok(added.id, added.error);
    r = await k.cmd('send', { peer: added.id, files: [list[0]] });
    assert.strictEqual((await finished(k, r.id)).state, 'done');
    assert.strictEqual(seen.uploads, 1);
    assert.ok(seen.certs.length >= 3 && seen.certs.every((c) => c === ready.fingerprint), 'every request presented Kotlin’s certificate');
    assert.strictEqual(seen.refused, 0);
    assert.strictEqual((await raw(strict.address().port, 'GET', `${API}/info`)).status, 0, 'a client with none gets nothing there');
    strict.close();
    strict.closeAllConnections();
  }

  // ---- an announce is only a claim: another certificate at that address gets nothing ----
  {
    const lie = { ...mac.info(true), alias: 'Node Mac', fingerprint: 'cd'.repeat(32) };
    await k.cmd('heard', { text: JSON.stringify(lie), from: '127.0.0.1' });
    const fake = await until(async () => (await k.cmd('peers')).peers.find((p) => p.fingerprint === 'cd'.repeat(32)), 'the claim is listed');
    await sleep(300); // its check has run by now
    const peers = (await k.cmd('peers')).peers;
    assert.strictEqual(peers.find((p) => p.id === fake.id).verified, false, 'a claim that can’t be proven stays unverified');
    assert.strictEqual(peers.find((p) => p.id === macPeer.id).verified, true, 'the device that was proven is still there');
    const offers = mac.offered.length;
    r = await k.cmd('send', { peer: fake.id, files: [list[0]] });
    sent = await finished(k, r.id);
    assert.strictEqual(sent.state, 'failed');
    assert.strictEqual(sent.error, 'fingerprint');
    assert.strictEqual(mac.offered.length, offers, 'nothing was offered to the wrong device');

    // What we don't speak is listed as that, and nothing is sent to it.
    await k.cmd('heard', { text: JSON.stringify({ alias: 'Plain', version: '2.1', fingerprint: 'whatever', port: 53999, protocol: 'http' }), from: '127.0.0.1' });
    await k.cmd('heard', { text: JSON.stringify({ alias: 'Old', version: '1.0', fingerprint: 'ef'.repeat(32), port: 53998, protocol: 'https' }), from: '127.0.0.1' });
    await k.cmd('heard', { text: JSON.stringify({ alias: 'Far', version: '2.1', fingerprint: '12'.repeat(32), port: 53997, protocol: 'https' }), from: '8.8.8.8' });
    const all = (await k.cmd('peers')).peers;
    const plain = all.find((p) => p.alias === 'Plain');
    const old = all.find((p) => p.alias === 'Old');
    assert.ok(plain && !plain.supported && plain.why === 'plain');
    assert.ok(old && !old.supported && old.why === 'v1');
    assert.ok(!all.some((p) => p.alias === 'Far'), 'an address that isn’t local is not listed');
    assert.strictEqual((await k.cmd('send', { peer: plain.id, files: [list[0]] })).error, 'plain');
    assert.strictEqual((await k.cmd('send', { peer: old.id, files: [list[0]] })).error, 'v1');
    assert.strictEqual((await k.cmd('send', { peer: 'nobody', files: [list[0]] })).error, 'peer');
    assert.strictEqual((await k.cmd('send', { peer: macPeer.id, files: [] })).error, 'empty');
    assert.strictEqual((await k.cmd('probe', { host: '8.8.8.8', port: 53317 })).error, 'address');
    assert.strictEqual((await k.cmd('probe', { host: 'example.com', port: 53317 })).error, 'address');
    assert.strictEqual((await k.cmd('probe', { host: '10.999.1.1', port: 53317 })).error, 'address');
  }

  // ---- Kotlin adds Node by its address ----
  {
    const again = await k.cmd('probe', { host: '127.0.0.1', port: mac.port });
    assert.strictEqual(again.id, macPeer.id);
    const closed = await k.cmd('probe', { host: '127.0.0.1', port: 9 });
    assert.strictEqual(closed.error, 'unreachable');
  }

  // ---- a flood of claims fills the list, and a device that proves itself still gets in ----
  {
    for (let i = 0; i < 100; i++) {
      await k.cmd('heard', { text: JSON.stringify({ alias: `Claim ${i}`, version: '2.1', fingerprint: sha(Buffer.from(`claim ${i}`)), port: 9, protocol: 'https', announce: false }), from: '127.0.0.1' });
    }
    assert.strictEqual((await k.cmd('peers')).peers.length, 64);
    const save2 = path.join(tmp, 'mac2-received');
    fs.mkdirSync(save2);
    const mac2 = new LocalSend({ dir: path.join(tmp, 'mac2-data'), alias: () => 'Second Mac', saveDir: () => save2, port: 0, host: '127.0.0.1', multicast: false });
    await mac2.start();
    const real = await k.cmd('probe', { host: '127.0.0.1', port: mac2.port });
    assert.ok(real.id, real.error);
    const peers = (await k.cmd('peers')).peers;
    assert.strictEqual(peers.length, 64);
    assert.ok(peers.some((p) => p.id === real.id && p.verified && p.alias === 'Second Mac'), 'the proven device is listed');
    assert.ok(peers.some((p) => p.id === macPeer.id && p.verified), 'and the one proven before stays');
    mac2.stop();
  }

  mac.stop();
  await k.cmd('stop');
  k.child.removeAllListeners('exit');
  await new Promise((resolve) => { k.child.on('exit', resolve); k.child.stdin.end(); });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('localsend-android: ok');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref();
});
