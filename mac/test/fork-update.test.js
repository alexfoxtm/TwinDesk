'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ForkUpdate } = require('../fork-update');

async function fixture(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'td-fork-update-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const apkPath = path.join(dir, 'app.apk');
  const configPath = path.join(dir, 'build');
  const bytes = Buffer.alloc(512 * 1024 + 31, 0x72);
  await fs.promises.writeFile(apkPath, bytes);
  await fs.promises.writeFile(configPath, 'CURRENT_PROJECT_VERSION = 78\n');
  const server = new EventEmitter();
  const ws = { readyState: 1, OPEN: 1 };
  const ctx = { authed: true, deviceId: 'phone', os: 'android', ws };
  const replies = [];
  server.current = ctx;
  server.send = (target, message) => { assert.equal(target, ctx); replies.push(message); return true; };
  const update = new ForkUpdate({ server, apkPath, configPath });
  const check = { t: 'fork.update.check', check: 'a'.repeat(32), package: 'io.github.alexfoxtm.twindesk.android', versionCode: 100077 };
  return { update, ctx, ws, replies, check, bytes, server, apkPath };
}

test('a newer same-version fork APK streams in exact bounded chunks to its authenticated Android owner', async (t) => {
  const f = await fixture(t);
  await f.update.receive(f.check, f.ctx, f.ws);
  const offer = f.replies.shift();
  assert.equal(offer.version, '3.2.1');
  assert.equal(offer.versionCode, 100078);
  assert.equal(offer.size, f.bytes.length);
  const received = [];
  for (let offset = 0; offset < offer.size;) {
    await f.update.receive({ t: 'fork.update.request', id: offer.id, offset }, f.ctx, f.ws);
    const chunk = f.replies.shift();
    assert.equal(chunk.offset, offset);
    const bytes = Buffer.from(chunk.data, 'base64');
    assert.ok(bytes.length <= 512 * 1024);
    offset += bytes.length;
    assert.equal(chunk.done, offset === offer.size);
    received.push(bytes);
  }
  assert.deepEqual(Buffer.concat(received), f.bytes);
  await f.update.receive({ ...f.check, versionCode: 100078 }, f.ctx, f.ws);
  assert.equal(f.replies.shift().available, false);
});

test('wrong, retired, cancelled, replayed and changed-file requests cannot yield APK bytes', async (t) => {
  const f = await fixture(t);
  await f.update.receive(f.check, f.ctx, {});
  assert.equal(f.replies.length, 0);
  await f.update.receive(f.check, f.ctx, f.ws);
  const offer = f.replies.shift();
  const request = { t: 'fork.update.request', id: offer.id, offset: 0 };
  await f.update.receive({ ...request, id: 'b'.repeat(32) }, f.ctx, f.ws);
  await f.update.receive({ ...request, offset: 17 }, f.ctx, f.ws);
  assert.equal(f.replies.length, 0);
  f.ctx.ws = { readyState: 1 };
  await f.update.receive(request, f.ctx, f.ws);
  assert.equal(f.replies.length, 0);
  f.ctx.ws = f.ws;
  await f.update.receive(request, f.ctx, f.ws);
  f.replies.length = 0;
  await f.update.receive(request, f.ctx, f.ws);
  assert.equal(f.replies.length, 0);
  await f.update.receive({ t: 'fork.update.cancel', id: offer.id }, f.ctx, f.ws);
  await f.update.receive({ ...request, offset: 512 * 1024 }, f.ctx, f.ws);
  assert.equal(f.replies.length, 0);
  await f.update.receive(f.check, f.ctx, f.ws);
  const second = f.replies.shift();
  await fs.promises.appendFile(f.apkPath, 'changed');
  await assert.rejects(f.update.receive({ ...request, id: second.id }, f.ctx, f.ws));
  assert.equal(f.replies.length, 0);
});
