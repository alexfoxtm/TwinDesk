// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');
const { EmbeddedTailnet } = require('../embedded-tailnet.js');

test('the embedded backend passes pinned WebSockets only after a current engine witness', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-embedded-test-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=TwinDesk Fixture', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const wss = new WebSocketServer({ noServer: true });
  const server = { wss, tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } };
  const host = new EmbeddedTailnet({
    server, dir, identity: { macId: 'fixture-mac', macName: 'Fixture Mac', fp: 'a'.repeat(64) },
    openLogin() { assert.fail('no real login'); }, onChange() {}, remember() {},
  });
  t.after(() => {
    host.close();
    wss.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let granted = false;
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
    return granted ? { ok: true, peer: 'fixture-phone' } : { ok: false };
  };
  assert.equal(await host._serve(host.epoch), true);
  let accepted = 0;
  wss.on('connection', (ws, req) => {
    assert.equal(server.embeddedPeer(req.socket), 'fixture-phone');
    accepted++;
    ws.send('hello');
  });
  const dial = () => new WebSocket(`wss://127.0.0.1:${port}/`, { ca: server.tls.cert });
  const rejected = dial();
  await assert.rejects(once(rejected, 'open'));
  assert.equal(accepted, 0);

  granted = true;
  const ws = dial();
  const [hello] = await once(ws, 'message');
  assert.equal(hello.toString(), 'hello');
  assert.equal(accepted, 1);
  const closing = once(ws, 'close');
  host.close();
  await closing;
});
