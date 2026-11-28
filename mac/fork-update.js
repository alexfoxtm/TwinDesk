// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const CHUNK = 512 * 1024;
const MAX_APK = 256 * 1024 * 1024;
const PACKAGE = 'io.github.alexfoxtm.twindesk.android';
const apkStamp = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

// Serves only this installation's bundled APK, over the authenticated control socket.
// The phone checks the APK's actual version and signing certificates before installation.
class ForkUpdate {
  constructor({ server, apkPath = path.join(__dirname, 'vendor/twindesk-android-full.apk'),
    configPath = path.join(__dirname, '../ios/ForkBuild.xcconfig'), version = '3.2.1' }) {
    this.server = server;
    this.apkPath = apkPath;
    this.configPath = configPath;
    this.version = version;
    this.sessions = new WeakMap();
    server.on('message', (m, ctx, ws) => {
      if (typeof m.t === 'string' && m.t.startsWith('fork.update.')) {
        void this.receive(m, ctx, ws).catch(() => {
          if (!this.current(ctx, ws)) return;
          const check = m.t === 'fork.update.check' && m.check;
          const id = m.t === 'fork.update.request' && m.id;
          server.send(ctx, { t: 'fork.update.error', ...(check ? { check } : { id }) });
        });
      }
    });
  }

  current(ctx, ws) {
    const current = this.server.clients ? this.server.clients.get(ctx?.deviceId) : this.server.current;
    return ctx && ctx === current && ctx.authed === true && ctx.os === 'android' &&
      !ctx.released && !ctx.expectedClose && ctx.ws === ws && !!ws && !ws.detached &&
      !ws.released && ws.transport !== 'ble' && ws.readyState === (ws.OPEN ?? 1);
  }

  async metadata() {
    const config = await fs.promises.readFile(this.configPath, 'utf8');
    const build = Number(/^CURRENT_PROJECT_VERSION = ([1-9][0-9]{0,3})$/m.exec(config)?.[1]);
    if (!Number.isInteger(build) || build < 1) throw Error('build');
    const file = await fs.promises.open(this.apkPath, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_APK) throw Error('apk');
      const stamp = apkStamp(stat);
      if (this.cached?.stamp === stamp && this.cached.build === build) return this.cached;
      const hash = crypto.createHash('sha256');
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
      if (apkStamp(await file.stat()) !== stamp) throw Error('changed');
      return (this.cached = { stamp, build, size: stat.size, digest: hash.digest('hex'), versionCode: 100000 + build });
    } finally { await file.close(); }
  }

  async receive(m, ctx, ws) {
    if (!this.current(ctx, ws)) return;
    if (m.t === 'fork.update.check') {
      if (!Number.isSafeInteger(m.versionCode) || m.package !== PACKAGE || !/^[a-f0-9]{32}$/.test(m.check || '')) return;
      const meta = await this.metadata();
      if (!this.current(ctx, ws)) return;
      if (meta.versionCode <= m.versionCode) {
        this.server.send(ctx, { t: 'fork.update.offer', check: m.check, available: false });
        return;
      }
      const offer = { ...meta, id: crypto.randomBytes(16).toString('hex'), check: m.check,
        until: Date.now() + 15 * 60 * 1000, offset: 0, busy: false };
      this.sessions.set(ws, offer);
      this.server.send(ctx, { t: 'fork.update.offer', check: m.check, available: true, id: offer.id,
        package: PACKAGE, version: this.version, build: meta.build, versionCode: meta.versionCode,
        size: meta.size, sha256: meta.digest, chunk: CHUNK });
      return;
    }
    const offer = this.sessions.get(ws);
    if (!offer || m.id !== offer.id || Date.now() >= offer.until) return;
    if (m.t === 'fork.update.cancel') { this.sessions.delete(ws); return; }
    if (m.t !== 'fork.update.request' || offer.busy || !Number.isSafeInteger(m.offset) ||
        m.offset !== offer.offset || m.offset < 0 || m.offset >= offer.size) return;
    offer.busy = true;
    try {
      const file = await fs.promises.open(this.apkPath, 'r');
      let result;
      try {
        if (apkStamp(await file.stat()) !== offer.stamp) throw Error('changed');
        const bytes = Buffer.alloc(Math.min(CHUNK, offer.size - m.offset));
        result = await file.read(bytes, 0, bytes.length, m.offset);
        if (result.bytesRead !== bytes.length || apkStamp(await file.stat()) !== offer.stamp) throw Error('changed');
      } finally { await file.close(); }
      if (!this.current(ctx, ws) || this.sessions.get(ws) !== offer) return;
      const offset = offer.offset;
      offer.offset += result.bytesRead;
      this.server.send(ctx, { t: 'fork.update.chunk', id: offer.id, offset, data: result.buffer.toString('base64'),
        done: offer.offset === offer.size });
      if (offer.offset === offer.size) this.sessions.delete(ws);
    } finally { offer.busy = false; }
  }
}

module.exports = { ForkUpdate };
