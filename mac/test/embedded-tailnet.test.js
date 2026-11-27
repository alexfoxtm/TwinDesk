// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws');
const { EmbeddedTailnet } = require('../embedded-tailnet.js');
const { NativeScreen } = require('../../shared/nativescreen.js');
const { FolderShare } = require('../../shared/foldershare.js');

test('embedded control and TURN require a current engine witness and TURN follows the owning session', { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-embedded-test-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=TwinDesk Fixture', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const wss = new WebSocketServer({ noServer: true });
  const server = Object.assign(new EventEmitter(), { wss, tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  server.send = (ctx, msg) => { ctx.ws.send(JSON.stringify(msg)); return true; };
  const host = new EmbeddedTailnet({
    server, dir, identity: { macId: 'fixture-mac', macName: 'Fixture Mac', fp: 'a'.repeat(64) },
    openLogin() { assert.fail('no real login'); }, onChange() {}, remember() {},
  });
  t.after(() => {
    host.close();
    wss.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let peer = null;
  let port;
  host._request = async (op, request) => {
    if (op === 'serve') {
      port = request.port;
      return { ok: true, generation: 'fixture' };
    }
    assert.equal(op, 'claimIngress');
    assert.equal(request.port, port);
    assert.equal(request.generation, 'fixture');
    assert.ok(request.sourcePort > 0);
    return peer ? { ok: true, peer } : { ok: false };
  };
  assert.equal(await host._serve(host.epoch), true);
  let accepted = 0;
  wss.on('connection', (ws, req) => {
    assert.equal(server.embeddedPeer(req.socket), 'fixture-phone');
    accepted++;
    server.current = { ws, authed: true, deviceId: 'fixture-pair', embeddedPeer: 'fixture-phone', embeddedMediaWanted: true };
    ws.ctx = server.current;
    ws.on('message', (data) => server.emit('message', JSON.parse(data), ws.ctx, ws));
    server.emit('client', server.current);
  });
  const dial = (route = '/', headers) => new WebSocket(`wss://127.0.0.1:${port}${route}`, { ca: server.tls.cert, headers });
  const rejected = dial();
  await assert.rejects(once(rejected, 'open'));
  assert.equal(accepted, 0);

  peer = 'fixture-phone';
  const ws = dial();
  const [ready] = await once(ws, 'message');
  const media = JSON.parse(ready.toString());
  assert.equal(media.t, 'embedded.media');
  assert.match(media.key, /^[0-9a-f]{64}$/);
  assert.equal(server.current.embeddedIce.iceTransportPolicy, 'relay');
  assert.equal(accepted, 1);

  const headers = { 'X-TwinDesk-Media': media.key };
  peer = 'other-fixture-phone';
  await assert.rejects(once(dial('/embedded/turn', headers), 'open'));
  peer = 'fixture-phone';
  const relay = dial('/embedded/turn', headers);
  await once(relay, 'open');
  const binding = Buffer.from('000100002112a4420102030405060708090a0b0c', 'hex');
  const reply = once(relay, 'message');
  relay.send(binding.subarray(0, 4));
  relay.send(binding.subarray(4));
  const [result, binary] = await reply;
  assert.equal(binary, true);
  assert.equal(result.readUInt16BE(0), 0x0101, 'the real TURN worker answered over the child');
  assert.deepEqual(result.subarray(8, 20), binding.subarray(8, 20));

  server.current.os = 'android';
  server.sendToClient = (msg) => server.send(server.current, msg);
  const screen = new NativeScreen(server);
  t.after(() => screen.stop());
  const sharing = screen.start();
  screen.state({ on: true, w: 100, h: 100 });
  await sharing;
  const upload = () => new Promise((resolve, reject) => {
    const req = https.request(`https://127.0.0.1:${port}/twindesk/mirror`, {
      method: 'POST', ca: server.tls.cert, headers: { 'x-twindesk-mirror': screen.secret },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    const frame = Buffer.alloc(13);
    frame.writeUInt32BE(1, 8);
    frame[12] = 42;
    req.end(frame);
  });
  peer = 'other-fixture-phone';
  assert.equal(await upload(), 403);
  peer = 'fixture-phone';
  const frame = once(screen, 'video');
  assert.equal(await upload(), 200);
  assert.deepEqual((await frame)[0].data, Buffer.from([42]));

  const folder = path.join(dir, 'shared');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'fixture.txt'), 'shared file');
  const hub = { get phone() { return server.current; }, server, settings: { shareServe: true }, save() {} };
  const share = new FolderShare(hub, { defaultFolder: folder });
  t.after(() => share.stop());
  const offerMessage = once(ws, 'message');
  await share.host();
  const offer = JSON.parse((await offerMessage)[0]);
  assert.equal(offer.embedded, 1);
  const folderResponse = () => new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${port}/embedded/folder/${offer.token}/file?p=fixture.txt`,
      { ca: server.tls.cert }, async (res) => {
        const chunks = [];
        for await (const data of res) chunks.push(data);
        resolve([res.statusCode, Buffer.concat(chunks).toString()]);
      }).on('error', reject);
  });
  peer = 'other-fixture-phone';
  assert.equal((await folderResponse())[0], 403);
  peer = 'fixture-phone';
  assert.deepEqual(await folderResponse(), [200, 'shared file']);

  const phone = https.createServer(server.tls, (_req, res) => res.end('phone folder'));
  phone.listen(0, '127.0.0.1');
  await once(phone, 'listening');
  t.after(() => phone.close());
  const phonePort = phone.address().port;
  const proxy = await share._proxy({
    host: '127.0.0.1', port: phonePort, cert: server.tls.cert,
    open: (callback) => server.current.openEmbeddedDav('fixture-share', callback),
  });
  const ticketMessage = once(ws, 'message');
  const listing = new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxy}/fixture`, async (res) => {
      const chunks = [];
      for await (const data of res) chunks.push(data);
      resolve([res.statusCode, Buffer.concat(chunks).toString()]);
    }).on('error', reject);
  });
  const ticket = JSON.parse((await ticketMessage)[0]);
  assert.equal(ticket.t, 'embedded.dav.open');
  assert.equal(ticket.share, 'fixture-share');
  const headersDav = { 'X-TwinDesk-Dav': ticket.key };
  const reverse = dial('/embedded/dav', headersDav);
  await once(reverse, 'open');
  const reverseStream = createWebSocketStream(reverse);
  const localDav = net.connect({ host: '127.0.0.1', port: phonePort });
  reverseStream.pipe(localDav).pipe(reverseStream);
  reverseStream.on('error', () => localDav.destroy());
  reverseStream.on('close', () => localDav.destroy());
  assert.deepEqual(await listing, [200, 'phone folder']);
  await assert.rejects(once(dial('/embedded/dav', headersDav), 'open'), 'a consumed ticket cannot open another socket');

  await t.test('ADB uses a single same-node child and closes it with the port grant', async () => {
    const owner = server.current.ws;
    const state = { t: 'adb.state', wifi: true, net: true, embeddedPort: 37123 };
    server.emit('message', state, server.current, {});
    assert.equal(server.embeddedAdbGrant(owner), null);
    const granted = once(server, 'message');
    ws.send(JSON.stringify(state));
    await granted;
    const grant = server.embeddedAdbGrant(owner);
    assert.equal(grant.port, state.embeddedPort);
    let closed = 0;
    const tunnel = grant.open(() => true, () => { closed++; });
    const ticketMessage = once(ws, 'message');
    const tcp = net.connect({ host: '127.0.0.1', port: await tunnel.ready });
    const ticket = JSON.parse((await ticketMessage)[0]);
    assert.match(ticket.key, /^[0-9a-f]{64}$/);
    assert.deepEqual(ticket, { t: 'embedded.adb.open', key: ticket.key, port: state.embeddedPort });
    const headers = { 'X-TwinDesk-Adb': ticket.key };
    peer = 'other-fixture-phone';
    await assert.rejects(once(dial('/embedded/adb', headers), 'open'));
    peer = 'fixture-phone';
    const child = dial('/embedded/adb', headers);
    await once(child, 'open');
    await assert.rejects(once(dial('/embedded/adb', headers), 'open'));
    let size = 0;
    const payload = Buffer.alloc(65553, 42);
    const echoed = new Promise((resolve) => {
      const received = [];
      tcp.on('data', (chunk) => {
        received.push(chunk);
        size += chunk.length;
        if (size >= payload.length) resolve(Buffer.concat(received));
      });
    });
    child.on('message', (data, binary) => {
      assert.ok(binary && data.length >= 1 && data.length <= 32768);
      child.send(data);
    });
    tcp.write(payload);
    assert.deepEqual(await echoed, payload);
    const retired = Promise.all([once(tcp, 'close'), once(child, 'close')]);
    ws.send(JSON.stringify({ ...state, embeddedPort: 37124 }));
    await retired;
    assert.equal(closed, 1);
    assert.equal(server.embeddedAdbGrant(owner).port, 37124);
    assert.equal(grant.open(() => true, assert.fail), null);
  });

  const closing = Promise.all([once(ws, 'close'), once(relay, 'close'), once(reverse, 'close')]);
  host.close();
  await closing;
  assert.equal(server.current.embeddedIce, null);
});
