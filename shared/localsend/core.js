// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// SPDX-License-Identifier: MPL-2.0
//
// Portions adapted from NectarLink, core/nectarlink-core/src/localsend.rs and transfer.rs
// (https://github.com/thtbee/nectarlink, commit a1a7d885, MPL-2.0),
// Copyright (C) 2026 The NectarLink contributors: the self-signed certificate written as DER, the
// certificate fingerprint check on every connection, the refusal to move a known HTTPS device to
// HTTP, the upload session rules (one token per file, the body exactly the offered size, only the
// sender cancels) and the file name rules. Rewritten in JavaScript for Node by the TwinDesk authors,
// Copyright (C) 2026 inukaasith; changes from the original: no plain HTTP, every discovered device
// is checked over TLS before it is listed as verified, the hash is taken while the bytes arrive, our
// certificate is shown on the connections we make and a sender is the certificate it showed.
//
// The protocol is LocalSend Protocol v2.2 (https://github.com/localsend/protocol, MIT, Copyright (c)
// 2022-2024 Tien Do Nam). No LocalSend code is used. TwinDesk is not affiliated with LocalSend.
//
// The transport core for files with LocalSend-compatible apps: Node only (no Electron), the same on
// the Mac, Windows and Linux. The apps add a thin adapter (shared/localsend/wire.js and their own
// dialogs).
//
//   const ls = new LocalSend({ dir, alias: () => name, saveDir: () => folder });
//   ls.on('offer', (o) => ls.answer(o.id, true | false));    // nothing is taken without an answer
//   ls.on('transfer', (t) => …); ls.on('change', () => ls.peers());
//   await ls.start(); ls.send(peerId, [paths]); ls.cancel(transferId); ls.stop();
//
// What it does not speak, and says so (peer.why): 'plain' a device with encryption off (HTTP),
// 'v1' protocol v1, 'newer' a major version after 2. Not here: the browser download API (section 5)
// and the address scan of section 3.2 (a device is added by its address instead: probe()).
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const net = require('net');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = 53317;
const GROUP = '224.0.0.167';
const VERSION = '2.2';
const API = '/api/localsend/v2';

const APPROVAL_MS = 60 * 1000; // an offer nobody answers is declined
const ANSWER_WAIT_MS = 120 * 1000; // how long we wait for the other side's person
const CONNECT_MS = 6000;
const IO_MS = 30 * 1000; // no byte either way for this long: the connection is dropped
const SESSION_IDLE_MS = 10 * 60 * 1000; // an accepted session with no upload for this long is dropped
const ANNOUNCE_MS = 30 * 1000;
const PEER_TTL_MS = 150 * 1000;
const VERIFY_EVERY_MS = 5000; // per address: an announce is checked over TLS at most this often
const DECLINE_COOLDOWN_MS = 10 * 1000; // after a decline, that address waits before it may offer again
const PROGRESS_MS = 150;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_SMALL_JSON = 64 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 32;
const MAX_NAME_BYTES = 200;
const MAX_PEERS = 64;
const MAX_PENDING = 3; // offers waiting for an answer
const MAX_OFFERING = 2; // per address: offers still being read
const MAX_KNOWN = 256; // devices remembered as ones the person here exchanged files with
const MAX_SESSIONS = 4;
const MAX_CONNECTIONS = 64;
const MAX_VERIFYING = 8; // TLS checks of announced devices at one time
const SPACE_MARGIN = 64 * 1024 * 1024;
const HASH_UP_TO = 16 * 1024 * 1024; // files we send up to this size carry their SHA-256
const DEVICE_TYPES = ['mobile', 'desktop', 'web', 'headless', 'server'];

// ---- The identity: a self-signed certificate; its SHA-256 is the LocalSend fingerprint ----

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n <= 0xff) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const bitString = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utcTime = (d) => {
  const z = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${z(d.getUTCFullYear() % 100)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`));
};

const fingerprintOf = (der) => crypto.createHash('sha256').update(der).digest('hex');
const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

// ECDSA P-256, X.509 v3, CN=TwinDesk, ten years. → { keyPem, certPem, fingerprint }
function makeIdentity(now = Date.now()) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const sigAlg = seq(tlv(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))); // ecdsa-with-SHA256
  const name = seq(tlv(0x31, seq(tlv(0x06, Buffer.from([0x55, 0x04, 0x03])), tlv(0x0c, Buffer.from('TwinDesk'))))); // CN
  const validity = seq(utcTime(new Date(now - 24 * 3600 * 1000)), utcTime(new Date(now + 3650 * 24 * 3600 * 1000)));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial), sigAlg, name, validity, name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = seq(tbs, sigAlg, bitString(crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })));
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem: pem(der), fingerprint: fingerprintOf(der) };
}

// The saved identity (dir/localsend-identity.json, 0600), a new one when it's missing, broken or
// within a month of running out. A new one is a new device to the others.
function loadIdentity(dir) {
  const file = path.join(dir, 'localsend-identity.json');
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const x = new crypto.X509Certificate(s.certPem);
    if (x.checkPrivateKey(crypto.createPrivateKey(s.keyPem)) && Date.parse(x.validTo) - Date.now() > 30 * 24 * 3600 * 1000) {
      return { keyPem: s.keyPem, certPem: s.certPem, fingerprint: fingerprintOf(x.raw) };
    }
  } catch { /* none yet, or unreadable: a new one */ }
  const id = makeIdentity();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ keyPem: id.keyPem, certPem: id.certPem }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* runs anyway; the next start makes another */ }
  return id;
}

// The devices the person here took files from or sent files to (dir/localsend-known.json, 0600):
// fingerprint -> { alias, at }. Only these are "known" when they offer something; a device that
// merely answered on the network is not.
function loadKnown(dir) {
  const out = new Map();
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'localsend-known.json'), 'utf8'));
    for (const [fp, v] of Object.entries(s)) {
      if (out.size < MAX_KNOWN && /^[0-9a-f]{64}$/.test(fp) && v && typeof v === 'object') out.set(fp, { alias: typeof v.alias === 'string' ? v.alias.slice(0, 64) : '', at: Number(v.at) || 0 });
    }
  } catch { /* none yet */ }
  return out;
}

function saveKnown(dir, known) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'localsend-known.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(known)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* remembered until the app closes */ }
}

// ---- Names and addresses ----

// Characters that reorder or hide text: with them a name reads as another one ("fdp.exe" shown as
// "exe.pdf", or a name that only looks like a known device's).
const HIDDEN = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(HIDDEN, '').trim().slice(0, n) : '');
// What two names that read the same have in common: no case, no spaces, nothing invisible.
const skeleton = (v) => String(v || '').normalize('NFKC').replace(/[\p{C}\p{Z}]/gu, '').toLowerCase();
const isFp = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
const token = () => crypto.randomBytes(18).toString('base64url');
const v4 = (a) => String(a || '').replace(/^::ffff:/i, '');

// Only the networks LocalSend is for: private, link-local, carrier NAT (a tailnet) and this computer.
function isLocalAddress(addr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v4(addr));
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// One path segment as it may be stored on any of the three systems.
function cleanSegment(raw) {
  let s = String(raw).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '_').replace(HIDDEN, '_').replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') return '';
  if (Buffer.byteLength(s) > MAX_NAME_BYTES) { // the end (the extension) is what's kept
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    const chars = Array.from(s.slice(0, s.length - ext.length));
    while (chars.length && Buffer.byteLength(chars.join('') + ext) > MAX_NAME_BYTES) chars.pop();
    s = (chars.join('') + ext).replace(/[. ]+$/, '') || 'file';
  }
  const stem = s.split('.')[0].trim().toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/.test(stem)) s = `_${s}`;
  return s;
}

// A LocalSend fileName ("holiday/day 1/a.jpg", or with backslashes) → { folder: [segments], name }.
// Never a path that leaves the folder: '.', '..' and empty segments are gone.
function splitName(raw) {
  const parts = String(raw == null ? '' : raw).replace(/\\/g, '/').split('/').map(cleanSegment).filter(Boolean);
  if (!parts.length) return { folder: [], name: 'file' };
  const name = parts.pop();
  return { folder: parts.slice(0, MAX_DEPTH), name };
}

function uniquePath(dir, name) {
  const first = path.join(dir, name);
  if (path.dirname(first) !== dir) throw new Error('unsafe name');
  if (!fs.existsSync(first)) return first;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; n < 10000; n++) {
    const p = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${stem} (${token()})${ext}`);
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', zip: 'application/zip', apk: 'application/vnd.android.package-archive' };
const mimeOf = (name) => MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream';

// What a version string means to us: '' (we speak it), or why not.
function versionWhy(v) {
  const major = Number(String(v || '').split('.')[0]);
  if (major === 2) return '';
  return major === 1 ? 'v1' : 'newer';
}

const peerId = (fingerprint, ip, port) => crypto.createHash('sha256').update(`twindesk-localsend:v2:${fingerprint || `${ip}:${port}`}`).digest('hex').slice(0, 32);

// What a device says about itself (an announce, /register, /info, prepare-upload's info) as a peer,
// or null when it isn't usable. Nothing here is proven: `verified` is set by the TLS check.
function peerFrom(dto, ip, fallbackPort) {
  if (!dto || typeof dto !== 'object') return null;
  const alias = clip(dto.alias, 64);
  if (!alias) return null;
  const protocol = String(dto.protocol || 'https').toLowerCase() === 'http' ? 'http' : 'https';
  const port = Number.isInteger(dto.port) && dto.port > 0 && dto.port < 65536 ? dto.port : fallbackPort || PORT;
  // Over HTTPS the fingerprint is the certificate's hash; over HTTP it's any string the device made up.
  if (protocol === 'https' && !isFp(dto.fingerprint)) return null;
  const fingerprint = protocol === 'https' ? dto.fingerprint.toLowerCase() : clip(dto.fingerprint, 128);
  const version = clip(dto.version, 16) || '2.0';
  const why = protocol === 'http' ? 'plain' : versionWhy(version);
  return {
    id: peerId(fingerprint, ip, port), alias, deviceModel: clip(dto.deviceModel, 64),
    deviceType: DEVICE_TYPES.includes(dto.deviceType) ? dto.deviceType : 'desktop',
    fingerprint, ip, port, protocol, version, supported: !why, why, verified: false, seen: Date.now(),
  };
}

// Whether `update` would move a device known to speak HTTPS to plain HTTP. An unauthenticated
// announce claiming its name mustn't do that.
const downgrades = (known, update) => update.protocol === 'http' && !!known && known.protocol === 'https';

class LsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---- The client side: every connection is TLS and its certificate is checked first ----

// A TLS socket to ip:port whose certificate has `fingerprint` (null: any, the caller compares what
// the device then says). Nothing of HTTP is written before the check. identity: our certificate,
// shown when the device asks for one (LocalSend 1.17 and later take nothing from a sender without
// it); it is what every device gets from our server anyway. → { socket, fingerprint }
function pinnedSocket(ip, port, fingerprint, signal, identity) {
  return new Promise((resolve, reject) => {
    let done = false;
    // The certificate is self-signed by design: what's checked is its hash, below.
    const socket = tls.connect({ host: ip, port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], ...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}) });
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new LsError('unreachable', 'timed out')), CONNECT_MS);
    if (signal) {
      if (signal.aborted) return fail(new LsError('cancelled'));
      signal.addEventListener('abort', () => fail(new LsError('cancelled')), { once: true });
    }
    socket.once('error', (e) => fail(new LsError('unreachable', e.message)));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      const got = cert && cert.raw ? fingerprintOf(cert.raw) : '';
      if (!got || (fingerprint && got !== String(fingerprint).toLowerCase())) return fail(new LsError('fingerprint', 'the certificate is not that device’s'));
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ socket, fingerprint: got });
    });
  });
}

// One HTTP request over a checked socket. body: a Buffer, or a readable stream with `length`.
// → { status, body (Buffer, at most `max`), fingerprint }
async function request({ ip, port, fingerprint, method, path: target, body, length, type, signal, wait = IO_MS, max = MAX_SMALL_JSON, onSent, identity }) {
  const { socket, fingerprint: got } = await pinnedSocket(ip, port, fingerprint, signal, identity);
  return new Promise((resolve, reject) => {
    let settled = false;
    const end = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const headers = { Connection: 'close' };
    if (type) headers['Content-Type'] = type;
    if (body) headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : length;
    else if (method === 'POST') headers['Content-Length'] = 0;
    // No agent is named: Node then takes the socket from createConnection (with `agent: false` it would
    // make its own agent and a connection of its own, unchecked and in the clear).
    const req = http.request({ createConnection: () => socket, host: ip, port, method, path: target, headers });
    const stream = body && !Buffer.isBuffer(body) ? body : null;
    const drop = () => { req.destroy(); socket.destroy(); if (stream) stream.destroy(); };
    const onAbort = () => { drop(); end(reject, new LsError('cancelled')); };
    const late = () => { drop(); end(reject, new LsError('timeout', 'no answer')); };
    let timer = setTimeout(late, wait);
    const alive = () => { clearTimeout(timer); timer = setTimeout(late, wait); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => { if (stream) stream.destroy(); end(reject, e instanceof LsError ? e : new LsError('unreachable', e.message)); });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) { drop(); return end(reject, new LsError('answer', 'the answer is too long')); }
        chunks.push(c);
      });
      res.on('end', () => end(resolve, { status: res.statusCode, body: Buffer.concat(chunks), fingerprint: got }));
      res.on('error', (e) => end(reject, new LsError('unreachable', e.message)));
    });
    if (stream) {
      let sent = 0;
      stream.on('data', (c) => { alive(); sent += c.length; if (onSent) onSent(c.length); if (!req.write(c)) { stream.pause(); req.once('drain', () => stream.resume()); } });
      // Fewer bytes than promised (the file changed under us): the request can't be finished honestly.
      stream.on('end', () => { if (sent === length) req.end(); else { drop(); end(reject, new LsError('read', 'the file changed while it was sent')); } });
      stream.on('error', (e) => { drop(); end(reject, new LsError('read', e.message)); });
    } else req.end(body || undefined);
  });
}

// The certificate a client showed on this connection, as its fingerprint, or '' when it showed
// none. TLS has checked that the client holds that certificate's key; nothing else about it is
// checked (it is self-signed by design), so this says which device it is, not whether to trust it.
function clientFingerprint(socket) {
  try {
    const cert = socket.getPeerCertificate();
    return cert && cert.raw ? fingerprintOf(cert.raw) : '';
  } catch { return ''; }
}

const json = (buf) => { try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; } };

// ---- Files to send: every file under the picked paths, by relative name ----

function planFiles(paths) {
  const list = [];
  const names = [];
  const walk = (abs, rel, depth) => {
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isFile()) {
      if (list.length < MAX_FILES) list.push({ path: abs, name: rel, size: st.size, modified: st.mtime });
    } else if (st.isDirectory() && depth < MAX_DEPTH) {
      let entries = [];
      try { entries = fs.readdirSync(abs).sort(); } catch { /* unreadable: left out */ }
      for (const n of entries) {
        const seg = cleanSegment(n);
        if (n !== '.DS_Store' && seg) walk(path.join(abs, n), `${rel}/${seg}`, depth + 1);
      }
    } // links and the rest are left out
  };
  const seen = new Set();
  for (const p of paths) {
    const top = cleanSegment(path.basename(String(p)));
    if (!top || seen.has(top) || !path.isAbsolute(String(p))) continue;
    seen.add(top);
    const before = list.length;
    walk(String(p), top, 0);
    if (list.length > before) names.push(top);
  }
  return { list, names, total: list.reduce((n, f) => n + f.size, 0) };
}

const hashFile = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

// ---- The node ----

class LocalSend extends EventEmitter {
  // dir: where the identity and files on their way are kept. alias(): this device's name.
  // saveDir(): where accepted files go. port: 53317. host/multicast/allow: tests bind to loopback.
  // allowLocal(address): which of this computer's own addresses take connections. mark(path): the
  // app's own mark on what arrives, before it is in the folder (macOS: quarantine).
  constructor(opts) {
    super();
    this.o = { port: PORT, host: '0.0.0.0', multicast: true, allowLocal: isLocalAddress, deviceModel: os.type() === 'Darwin' ? 'macOS' : os.type() === 'Windows_NT' ? 'Windows' : 'Linux', deviceType: 'desktop', allow: isLocalAddress, cooldownMs: DECLINE_COOLDOWN_MS, approvalMs: APPROVAL_MS, log: () => {}, ...opts };
    this.identity = loadIdentity(this.o.dir);
    this.fingerprint = this.identity.fingerprint;
    this.running = false;
    this.receiving = false; // our server has the port (else another app on this computer receives)
    this.port = this.o.port;
    this.error = '';
    this._peers = new Map(); // id -> peer
    this._offers = new Map(); // offer id -> { offer, resolve }
    this._sessions = new Map(); // session id -> session
    this._out = new Map(); // transfer id -> { transfer, abort }
    this._verifiedAt = new Map(); // ip:port -> time of the last TLS check
    this._cooldown = new Map(); // ip -> until
    this._offering = new Map(); // ip -> offers of it still being read
    this._known = loadKnown(this.o.dir); // fingerprint -> { alias, at }: exchanged files with before
    this._gen = 0; // each start and each stop is another one: what an older one opened is closed
    this._life = Promise.resolve(); // starts, one after another
    this._finalize = Promise.resolve();
    this._verifying = 0;
    this._timers = [];
  }

  info(announce) {
    return {
      alias: clip(this.o.alias(), 64) || 'TwinDesk', version: VERSION, deviceModel: this.o.deviceModel, deviceType: this.o.deviceType,
      fingerprint: this.fingerprint, port: this.port, protocol: 'https', download: false,
      ...(announce === undefined ? {} : { announce }),
    };
  }

  status() {
    return { running: this.running, receiving: this.receiving, port: this.port, fingerprint: this.fingerprint, error: this.error };
  }

  peers() {
    return [...this._peers.values()].sort((a, b) => a.alias.localeCompare(b.alias) || a.ip.localeCompare(b.ip));
  }

  // ---- start and stop ----

  // One at a time and each under its own number: a stop() that comes while the port is being
  // opened closes it when it opens, and a start() after that waits for it.
  start() {
    if (this.running) return this._life;
    this.running = true;
    this.error = '';
    const gen = ++this._gen;
    this._life = this._life.then(() => this._open(gen)).catch((e) => this.o.log(`[localsend] start: ${e.message}`));
    return this._life;
  }

  async _open(gen) {
    if (gen !== this._gen) return; // stopped before anything was opened
    this._sweepStaging();
    await this._listen(gen);
    if (gen === this._gen && this.o.multicast) await this._openUdp(gen);
    if (gen !== this._gen) return;
    const tick = setInterval(() => { this._expire(); this.announce(); }, ANNOUNCE_MS);
    tick.unref();
    this._timers.push(tick);
    for (const ms of [100, 500, 2000]) { // a few at the start: one multicast packet is easily lost
      const t = setTimeout(() => this.announce(), ms);
      t.unref();
      this._timers.push(t);
    }
    this.emit('change');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.receiving = false;
    this._gen++;
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers = [];
    if (this._udp) { try { this._udp.close(); } catch { /* closed */ } this._udp = null; }
    if (this._server) { this._shut(this._server); this._server = null; }
    for (const id of [...this._offers.keys()]) this.answer(id, false);
    for (const s of [...this._sessions.values()]) this._endSession(s, 'cancelled');
    for (const id of [...this._out.keys()]) this.cancel(id);
    this._peers.clear();
    this.emit('change');
  }

  _shut(server) {
    try { server.close(); } catch { /* not open */ }
    if (server.closeAllConnections) server.closeAllConnections();
  }

  _listen(gen) {
    return new Promise((resolve) => {
      // requestCert: a sender is asked for its certificate and is the device that certificate is
      // (clientFingerprint); one that shows none is still heard, as a device nobody can name.
      const server = https.createServer({ key: this.identity.keyPem, cert: this.identity.certPem, minVersion: 'TLSv1.2', handshakeTimeout: 10 * 1000, requestCert: true, rejectUnauthorized: false }, (req, res) => {
        this._route(req, res).catch((e) => {
          this.o.log(`[localsend] ${req.method} ${req.url}: ${e.message}`);
          if (!res.headersSent) this._reply(res, 500, { message: 'error' });
          else res.destroy();
        });
      });
      server.maxConnections = MAX_CONNECTIONS;
      server.requestTimeout = 0; // a big file takes as long as it takes; silence is what ends it (IO_MS)
      server.headersTimeout = 10 * 1000;
      server.keepAliveTimeout = 5000;
      server.setTimeout(IO_MS, (s) => s.destroy());
      server.on('tlsClientError', () => {});
      // The port is open on every network this computer is on; a connection that came in on an
      // address that isn't a local one (a public one) is closed before a byte of it is read.
      server.on('connection', (s) => { if (!this.o.allowLocal(v4(s.localAddress))) s.destroy(); });
      server.once('error', (e) => {
        // The port is someone's (the LocalSend app on this computer): it receives, we still find and send.
        if (gen === this._gen) {
          this.receiving = false;
          this.error = e.code === 'EADDRINUSE' ? 'port' : e.message;
        }
        resolve();
      });
      server.listen(this.o.port, this.o.host, () => {
        server.on('error', (e) => this.o.log(`[localsend] server: ${e.message}`));
        if (gen !== this._gen) this._shut(server); // stopped while it was opening
        else {
          this._server = server;
          this.receiving = true;
          this.port = server.address().port;
        }
        resolve();
      });
    });
  }

  // ---- discovery ----

  _openUdp(gen) {
    return new Promise((resolve) => {
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let bound = false;
      udp.on('error', (e) => {
        this.o.log(`[localsend] discovery: ${e.message}`);
        if (!bound) { bound = true; try { udp.close(); } catch { /* closed */ } resolve(); }
      });
      udp.on('message', (buf, r) => this._onDatagram(buf, r));
      udp.bind(PORT, () => {
        bound = true;
        if (gen !== this._gen) { try { udp.close(); } catch { /* closed */ } return resolve(); } // stopped meanwhile
        this._udp = udp;
        this._joined = new Set();
        try { udp.setMulticastLoopback(true); } catch { /* as it is */ }
        this._join();
        resolve();
      });
    });
  }

  _ifaces() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    return out;
  }

  _join() {
    if (!this._udp) return;
    for (const addr of this._ifaces()) {
      if (this._joined.has(addr)) continue;
      try { this._udp.addMembership(GROUP, addr); this._joined.add(addr); } catch { /* that interface can't */ }
    }
  }

  // Says we're here on every network. The others answer with /register.
  announce() {
    if (!this.running || !this._udp) return;
    this._join();
    const msg = Buffer.from(JSON.stringify(this.info(this.receiving)));
    for (const addr of this._ifaces()) {
      try { this._udp.setMulticastInterface(addr); this._udp.send(msg, PORT, GROUP, () => {}); } catch { /* down */ }
    }
  }

  _onDatagram(buf, r) {
    if (!this.running || buf.length > 8192) return;
    const ip = v4(r.address);
    if (!this.o.allow(ip)) return;
    const dto = json(buf);
    if (!dto || dto.fingerprint === this.fingerprint) return;
    const peer = peerFrom(dto, ip);
    if (!peer) return;
    const announce = dto.announce === true || dto.announcement === true;
    this._heard(peer, announce);
  }

  // A device said it's at this address (an announce, or /register from it). It's listed as it says;
  // then its certificate is checked, which also tells it about us.
  _heard(peer, announce) {
    const known = this._peers.get(peer.id);
    if (downgrades(known, peer)) return;
    if (!peer.supported) return void this._upsert(peer);
    // A device that was proven keeps what was proven of it (its name too): a datagram is anyone's.
    // The check below is what brings a new name or address, from the device itself.
    if (!known || !known.verified) this._upsert(peer);
    const key = `${peer.ip}:${peer.port}`;
    const last = this._verifiedAt.get(key) || 0;
    if (Date.now() - last < VERIFY_EVERY_MS) return;
    if (this._verifying >= MAX_VERIFYING) return; // a flood of announces opens only so many connections
    this._verifiedAt.set(key, Date.now());
    if (this._verifiedAt.size > 1024) this._verifiedAt.clear();
    this._verifying++;
    this._verify(peer.ip, peer.port, peer.fingerprint).finally(() => { this._verifying--; }).catch(() => {
      // No server there (a device that only sends), or it isn't that device: the multicast answer.
      if (announce && this.receiving && this._udp) {
        const msg = Buffer.from(JSON.stringify(this.info(false)));
        try { this._udp.send(msg, PORT, GROUP, () => {}); } catch { /* down */ }
      }
    });
  }

  // Asks ip:port who it is over TLS (POST /register when we receive, so it learns of us; else GET
  // /info). fingerprint: what it must be; null: whatever its certificate is, if it says the same.
  async _verify(ip, port, fingerprint) {
    const register = this.receiving;
    const res = await this._request({
      ip, port, fingerprint, method: register ? 'POST' : 'GET', path: `${API}/${register ? 'register' : 'info'}`,
      body: register ? Buffer.from(JSON.stringify(this.info())) : null, type: register ? 'application/json' : '',
    });
    const dto = res.status >= 200 && res.status < 300 ? json(res.body) : null;
    if (!dto) throw new LsError('answer', `HTTP ${res.status}`);
    // What it says must be what its certificate is (HTTPS: the fingerprint in the body is ignored for trust).
    const peer = peerFrom({ ...dto, fingerprint: res.fingerprint, protocol: 'https', port: Number.isInteger(dto.port) ? dto.port : port }, ip, port);
    if (!peer || peer.fingerprint === this.fingerprint) throw new LsError('answer', 'not a device');
    peer.port = port; // the port that answered
    peer.id = peerId(peer.fingerprint, ip, port);
    peer.verified = true;
    this._upsert(peer);
    return peer;
  }

  // A request of ours: over TLS, to a checked certificate, showing our own.
  _request(o) {
    return request({ ...o, identity: this.identity });
  }

  // Add a device by its address (the network doesn't carry multicast): → the peer, or throws LsError
  // ('unreachable', 'fingerprint', 'plain': it answers without encryption, which we don't speak).
  async probe(host, port = PORT) {
    const ip = String(host || '').trim();
    if (!net.isIPv4(ip) || !this.o.allow(ip)) throw new LsError('address', 'not an address on this network');
    try {
      return await this._verify(ip, port, null);
    } catch (e) {
      if (e.code !== 'unreachable') throw e;
      const plain = await new Promise((resolve) => {
        const req = http.get({ host: ip, port, path: `${API}/info`, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
      });
      throw plain ? new LsError('plain', 'that device has encryption off') : e;
    }
  }

  _upsert(peer) {
    if (peer.fingerprint && peer.fingerprint === this.fingerprint) return;
    const known = this._peers.get(peer.id);
    if (downgrades(known, peer)) return;
    if (!known && this._peers.size >= MAX_PEERS) {
      // Full of claims: one that was never proven makes room for a device that was.
      const claim = peer.verified ? [...this._peers.values()].find((p) => !p.verified) : null;
      if (!claim) return;
      this._peers.delete(claim.id);
    }
    if (known && known.verified && !peer.verified) return; // what's proven isn't replaced by what's said
    this._peers.set(peer.id, peer);
    if (!known || ['alias', 'ip', 'port', 'verified', 'supported', 'why', 'deviceModel', 'deviceType'].some((k) => known[k] !== peer[k])) this.emit('change');
  }

  _expire() {
    let gone = false;
    for (const [id, p] of this._peers) if (Date.now() - p.seen > PEER_TTL_MS) { this._peers.delete(id); gone = true; }
    for (const [ip, until] of this._cooldown) if (until < Date.now()) this._cooldown.delete(ip);
    this._sweepIdle();
    if (gone) this.emit('change');
  }

  // ---- the server ----

  _reply(res, status, body) {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    res.writeHead(status, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : { 'Content-Length': 0 });
    res.end(data || undefined);
  }

  _body(req, max) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length']) > max) return reject(new LsError('big'));
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > max) { req.destroy(); return reject(new LsError('big')); }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async _route(req, res) {
    const ip = v4(req.socket.remoteAddress);
    if (!this.running || !this.o.allow(ip)) return this._reply(res, 403, { message: 'Not from this network' });
    const url = new URL(req.url, 'https://localsend');
    const route = `${req.method} ${url.pathname}`;
    if (route === `GET ${API}/info`) return this._reply(res, 200, this.info());
    if (route === `POST ${API}/register`) {
      const dto = json(await this._body(req, MAX_SMALL_JSON).catch(() => Buffer.alloc(0)));
      const peer = dto && dto.fingerprint !== this.fingerprint ? peerFrom(dto, ip) : null;
      // A sender that showed a certificate is that device: it can't register another one's fingerprint.
      const cert = clientFingerprint(req.socket);
      if (peer && (!cert || peer.protocol !== 'https' || cert === peer.fingerprint)) this._heard(peer, false);
      return this._reply(res, 200, this.info());
    }
    if (route === `POST ${API}/prepare-upload`) return this._prepare(req, res, ip);
    if (route === `POST ${API}/upload`) return this._upload(req, res, ip, url.searchParams);
    if (route === `POST ${API}/cancel`) {
      // Only the sender cancels its session. Anyone else gets the same answer, so it doesn't learn
      // which sessions exist.
      const s = this._sessions.get(url.searchParams.get('sessionId') || '');
      if (s && s.ip === ip) this._endSession(s, 'cancelled');
      return this._reply(res, 200);
    }
    return this._reply(res, 404, { message: 'Not found' });
  }

  // An offer: nothing is written and no token is given until the person here says yes.
  async _prepare(req, res, ip) {
    // Why this address isn't asked about now, or null. Looked at before the offer is read (a sender
    // that's refused uploads nothing) and again in the very turn that lists it: offers that arrive
    // together are read together, and only the first of them becomes a question.
    const refused = () => {
      if ((this._cooldown.get(ip) || 0) > Date.now()) return [429, 'Too many requests'];
      if (this._offers.size >= MAX_PENDING || [...this._offers.values()].some((o) => o.offer.ip === ip)) return [429, 'Too many requests'];
      return this._sessions.size >= MAX_SESSIONS ? [409, 'Blocked by another session'] : null;
    };
    let no = refused() || ((this._offering.get(ip) || 0) >= MAX_OFFERING ? [429, 'Too many requests'] : null);
    if (no) return this._reply(res, no[0], { message: no[1] });
    this._offering.set(ip, (this._offering.get(ip) || 0) + 1);
    let dto;
    let saveDir;
    try {
      dto = await this._offered(req, res);
      if (!dto) return undefined; // answered there
      saveDir = path.resolve(String(this.o.saveDir()));
      try {
        const st = fs.promises.statfs ? await fs.promises.statfs(saveDir) : null;
        if (st && st.bavail * st.bsize < dto.total + SPACE_MARGIN) return this._reply(res, 507, { message: 'Not enough space' });
      } catch { /* unknown: the write will say */ }
    } finally {
      const n = (this._offering.get(ip) || 1) - 1;
      if (n > 0) this._offering.set(ip, n);
      else this._offering.delete(ip);
    }
    if (res.destroyed) return undefined; // it hung up while it was read
    if (!this.running) return this._reply(res, 403, { message: 'Rejected' });
    no = refused();
    if (no) return this._reply(res, no[0], { message: no[1] });
    const { files, total, info } = dto;

    // Who it is: the certificate it showed on this connection, and nothing it says. The name is its
    // own word in any case; without a certificate nobody knows which device this is, whatever
    // fingerprint or address it gives, and it is never a known one.
    const cert = clientFingerprint(req.socket);
    const alias = clip(info.alias, 64) || ip;
    const names = [];
    for (const f of files) { const top = f.folder[0] || f.name; if (!names.includes(top)) names.push(top); }
    const offer = {
      id: token(), ip, alias, deviceModel: clip(info.deviceModel, 64), deviceType: DEVICE_TYPES.includes(info.deviceType) ? info.deviceType : 'desktop',
      fingerprint: cert, verified: !!cert, known: !!cert && this._known.has(cert), imitates: this._imitates(alias, cert),
      names, files: files.length, total, text: files.length === 1 ? files[0].text : '', at: Date.now(),
    };
    req.socket.setTimeout(0); // the person may take a minute; the offer's own timer ends the wait
    const [accepted, why] = await new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(offer.id, false, 'timeout'), this.o.approvalMs);
      const gone = () => this.answer(offer.id, false, 'gone');
      res.once('close', gone); // the sender gave up
      this._offers.set(offer.id, { offer, resolve: (v, w) => { clearTimeout(timer); res.off('close', gone); resolve([v, w]); } });
      this.emit('offer', offer);
    });
    if (!res.destroyed) req.socket.setTimeout(IO_MS);
    if (!accepted || !this.running || res.destroyed) {
      // After a no, that address waits before it may ask again (a sender that gave up itself doesn't).
      if (why !== 'gone') this._cooldown.set(ip, Date.now() + this.o.cooldownMs);
      return res.destroyed ? undefined : this._reply(res, 403, { message: 'Rejected' });
    }
    if (this._sessions.size >= MAX_SESSIONS) return this._reply(res, 409, { message: 'Blocked by another session' });
    if (cert) this._remember(cert, alias); // the person here said yes to this device
    const id = token();
    const session = {
      id, ip, files: new Map(files.map((f) => [f.id, f])), staging: path.join(this.o.dir, 'localsend-incoming', id), saveDir,
      roots: new Map(), saved: [], abort: new AbortController(), active: Date.now(), last: 0,
      transfer: { id: `in-${id}`, dir: 'in', peer: { alias: offer.alias, ip, known: offer.known, verified: offer.verified, fingerprint: cert }, names, files: files.length, total, done: 0, state: 'running', at: Date.now() },
    };
    try { fs.mkdirSync(session.staging, { recursive: true, mode: 0o700 }); } catch { return this._reply(res, 500, { message: 'Cannot store' }); }
    this._sessions.set(id, session);
    this.emit('transfer', { ...session.transfer });
    return this._reply(res, 200, { sessionId: id, files: Object.fromEntries(files.map((f) => [f.id, f.token])) });
  }

  // Whether another device the person here knows, or one proven on this network, has this name:
  // a name is free to take, so the question says when it is someone else's.
  _imitates(alias, fingerprint) {
    const name = skeleton(alias);
    if (!name) return false;
    for (const [fp, k] of this._known) if (fp !== fingerprint && skeleton(k.alias) === name) return true;
    for (const p of this._peers.values()) if (p.verified && p.fingerprint !== fingerprint && skeleton(p.alias) === name) return true;
    return false;
  }

  // A device the person here took files from or sent files to: known from now on, by its certificate.
  _remember(fingerprint, alias) {
    if (!isFp(fingerprint)) return;
    this._known.delete(fingerprint);
    this._known.set(fingerprint, { alias: clip(alias, 64), at: Date.now() });
    while (this._known.size > MAX_KNOWN) this._known.delete(this._known.keys().next().value); // the one longest ago
    saveKnown(this.o.dir, this._known);
  }

  // The offer in a prepare-upload request: { info, files, total }, or null when it was answered
  // here as not one.
  async _offered(req, res) {
    let dto;
    try { dto = json(await this._body(req, MAX_JSON)); } catch { this._reply(res, 400, { message: 'Invalid body' }); return null; }
    const entries = dto && dto.files && typeof dto.files === 'object' && !Array.isArray(dto.files) ? Object.entries(dto.files) : [];
    const bad = () => { this._reply(res, 400, { message: 'Invalid body' }); return null; };
    if (!dto || !dto.info || typeof dto.info !== 'object' || !entries.length || entries.length > MAX_FILES) return bad();
    const files = [];
    const ids = new Set();
    let total = 0;
    for (const [key, f] of entries) {
      const id = f && typeof f.id === 'string' && f.id ? f.id : key;
      if (!f || typeof f !== 'object' || id.length > 256 || ids.has(id) || typeof f.fileName !== 'string' || !f.fileName || f.fileName.length > 4096
        || !Number.isSafeInteger(f.size) || f.size < 0) return bad();
      ids.add(id);
      const { folder, name } = splitName(f.fileName);
      total += f.size;
      if (!Number.isSafeInteger(total)) return bad();
      files.push({
        id, name, folder, size: f.size, type: clip(f.fileType, 128), token: token(),
        sha256: isFp(f.sha256) ? f.sha256.toLowerCase() : '', // the sender's hash, when it gave a well-formed one
        text: typeof f.preview === 'string' && /^text\//.test(String(f.fileType)) ? clip(f.preview, 2000) : '', // a message: shown with the question
        state: 'waiting',
      });
    }
    files.sort((a, b) => [...a.folder, a.name].join('/').localeCompare([...b.folder, b.name].join('/')));
    return { info: dto.info, files, total };
  }

  // The person's answer to an offer. → whether there was such an offer.
  answer(id, accept, why = '') {
    const o = this._offers.get(id);
    if (!o) return false;
    this._offers.delete(id);
    o.resolve(!!accept, accept ? '' : why || 'declined');
    this.emit('offerEnd', { id, accepted: !!accept, why: accept ? '' : why || 'declined' });
    return true;
  }

  offers() {
    return [...this._offers.values()].map((o) => o.offer);
  }

  async _upload(req, res, ip, q) {
    const session = this._sessions.get(q.get('sessionId') || '');
    const fileId = q.get('fileId');
    const tok = q.get('token');
    if (!q.get('sessionId') || !fileId || !tok) return this._reply(res, 400, { message: 'Missing parameters' });
    const f = session && session.files.get(fileId);
    const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    // The same answer for no session, another address, a wrong token and a file already here.
    if (!f || session.ip !== ip || !same(tok, f.token) || f.state !== 'waiting') return this._reply(res, 403, { message: 'Invalid token or IP address' });
    // The body must be exactly the size that was offered and accepted: more could fill the disk,
    // less is a broken file.
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) !== f.size) { res.setHeader('Connection', 'close'); return this._reply(res, 400, { message: 'Size mismatch' }); }
    f.state = 'uploading';
    session.active = Date.now();
    const part = path.join(session.staging, `${crypto.randomBytes(8).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let got = 0;
    let counted = 0; // what of it the progress already shows
    const count = new Transform({
      transform: (chunk, _enc, cb) => {
        got += chunk.length;
        if (got > f.size) return cb(new LsError('size', 'more than was offered'));
        hash.update(chunk);
        session.active = Date.now();
        session.transfer.done += chunk.length;
        counted += chunk.length;
        this._progress(session);
        cb(null, chunk);
      },
    });
    let failed = null;
    try { await pipeline(req, count, fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal: session.abort.signal }); } catch (e) { failed = e; }
    if (!failed && got !== f.size) failed = new LsError('size', 'less than was offered');
    const bad = !failed && f.sha256 && hash.digest('hex') !== f.sha256;
    if (failed || bad) {
      fs.rm(part, { force: true }, () => {});
      session.transfer.done -= counted;
      if (!this._sessions.has(session.id)) return res.destroyed ? undefined : this._reply(res, 409, { message: 'Cancelled' });
      f.state = 'waiting'; // the sender may send this file again
      if (counted) this._progress(session, true); // what was shown of it is taken back
      if (bad) return this._reply(res, 422, { message: 'Checksum mismatch' });
      if (res.destroyed || !req.socket || req.socket.destroyed) return undefined; // it hung up: nobody to tell
      res.setHeader('Connection', 'close');
      return this._reply(res, failed.code === 'size' ? 400 : 500, { message: failed.code === 'size' ? 'Size mismatch' : 'Upload interrupted' });
    }
    try {
      await this._store(session, f, part);
    } catch (e) {
      this.o.log(`[localsend] can't store ${f.name}: ${e.message}`);
      fs.rm(part, { force: true }, () => {});
      session.transfer.done -= counted;
      f.state = 'waiting';
      return this._reply(res, 500, { message: 'Cannot store' });
    }
    f.state = 'done';
    if ([...session.files.values()].every((x) => x.state === 'done')) this._endSession(session, 'done');
    return this._reply(res, 200);
  }

  // A finished part into the folder, one at a time (two finishing at once could pick one free name).
  _store(session, f, part) {
    // The app's own mark on what arrives (macOS: quarantine). A file isn't lost for want of it.
    const mark = async (p) => {
      if (!this.o.mark) return;
      try { await this.o.mark(p); } catch (e) { this.o.log(`[localsend] can't mark ${path.basename(p)}: ${e.message}`); }
    };
    const run = async () => {
      const check = () => {
        if (this._sessions.get(session.id) !== session || session.abort.signal.aborted) throw new LsError('cancelled');
      };
      check();
      fs.mkdirSync(session.saveDir, { recursive: true });
      let dir = session.saveDir;
      if (f.folder.length) {
        // A folder of this session is always a new one here: nothing of ours lands in a folder that
        // was already there (or in what a link in it points to).
        let root = session.roots.get(f.folder[0]);
        if (!root) {
          root = uniquePath(session.saveDir, f.folder[0]);
          fs.mkdirSync(root);
          session.roots.set(f.folder[0], root);
          session.saved.push(root);
          await mark(root);
          check();
        }
        dir = root;
        for (const seg of f.folder.slice(1)) {
          const next = path.join(dir, seg);
          if (path.dirname(next) !== dir) throw new LsError('name');
          if (fs.mkdirSync(next, { recursive: true })) { await mark(next); check(); }
          dir = next;
        }
      }
      await mark(part); // while it's still ours alone: the mark is on the file the moment it's in the folder
      check();
      // A link, then the part is removed: unlike a rename it never replaces a file that appeared
      // meanwhile. Where links aren't possible (another disk, exFAT, a share) it's an exclusive copy.
      let dest = '';
      for (let tries = 0; !dest; tries++) {
        const to = uniquePath(dir, f.name);
        try { fs.linkSync(part, to); dest = to; } catch (e) {
          if (e.code === 'EEXIST' && tries < 5) continue;
          try { fs.copyFileSync(part, to, fs.constants.COPYFILE_EXCL); dest = to; } catch (e2) {
            if (e2.code !== 'EEXIST' || tries >= 5) throw e2;
          }
        }
      }
      fs.rmSync(part, { force: true });
      if (this.o.stored) { try { this.o.stored(dest); } catch { /* the app's own mark */ } }
      if (!f.folder.length) session.saved.push(dest);
    };
    const p = this._finalize.then(run);
    this._finalize = p.catch(() => {});
    return p;
  }

  _progress(s, force) {
    if (!force && Date.now() - s.last < PROGRESS_MS) return;
    s.last = Date.now();
    this.emit('transfer', { ...s.transfer });
  }

  _endSession(s, state) {
    if (!this._sessions.delete(s.id)) return;
    s.abort.abort();
    const files = [...s.files.values()];
    s.transfer.state = state;
    s.transfer.saved = s.saved.slice();
    s.transfer.arrived = files.filter((f) => f.state === 'done').length; // what's kept when it ended early
    if (state === 'done') s.transfer.done = s.transfer.total;
    fs.rm(s.staging, { recursive: true, force: true }, () => {});
    this.emit('transfer', { ...s.transfer });
  }

  _sweepIdle() {
    for (const s of [...this._sessions.values()]) if (Date.now() - s.active > SESSION_IDLE_MS) this._endSession(s, 'cancelled');
  }

  // Parts left by a session that never ended (the app was closed).
  _sweepStaging() {
    try { fs.rmSync(path.join(this.o.dir, 'localsend-incoming'), { recursive: true, force: true }); } catch { /* next time */ }
  }

  // ---- sending ----

  // Files and folders to a device that was found. opts.pin: the PIN that device asks for.
  // → the transfer's id; its states arrive as 'transfer' events ('waiting' for the other person,
  // 'running', then 'done' | 'declined' | 'cancelled' | 'failed' with .error).
  send(id, paths, opts = {}) {
    const peer = this._peers.get(id);
    if (!peer) throw new LsError('peer', 'that device is gone');
    if (!peer.supported) throw new LsError(peer.why, 'that device is not supported');
    const plan = planFiles(Array.isArray(paths) ? paths : []);
    if (!plan.list.length) throw new LsError('empty', 'nothing to send');
    const transfer = { id: `out-${token()}`, dir: 'out', peer: { id: peer.id, alias: peer.alias, ip: peer.ip }, names: plan.names, files: plan.list.length, total: plan.total, done: 0, state: 'waiting', at: Date.now() };
    const entry = { transfer, abort: new AbortController(), last: 0 };
    this._out.set(transfer.id, entry);
    this.emit('transfer', { ...transfer });
    this._run(entry, { ...peer }, plan.list, opts).then(() => 'done', (e) => {
      transfer.error = e.code || 'failed';
      transfer.detail = e.message;
      return e.code === 'cancelled' ? 'cancelled' : e.code === 'declined' ? 'declined' : 'failed';
    }).then((state) => {
      transfer.state = state;
      if (state === 'done') transfer.done = transfer.total;
      this._out.delete(transfer.id);
      this.emit('transfer', { ...transfer });
    });
    return transfer.id;
  }

  async _run(entry, peer, list, opts) {
    const { transfer } = entry;
    const signal = entry.abort.signal;
    const to = { ip: peer.ip, port: peer.port, fingerprint: peer.fingerprint, signal };
    const files = {};
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      f.id = `f${i}`;
      files[f.id] = {
        id: f.id, fileName: f.name, size: f.size, fileType: mimeOf(f.name),
        ...(f.size <= HASH_UP_TO ? { sha256: await hashFile(f.path).catch(() => { throw new LsError('read', `can't read ${path.basename(f.path)}`); }) } : {}),
        metadata: { modified: f.modified.toISOString() },
      };
      if (signal.aborted) throw new LsError('cancelled');
    }
    const pin = typeof opts.pin === 'string' && opts.pin ? `?pin=${encodeURIComponent(opts.pin)}` : '';
    const res = await this._request({ ...to, method: 'POST', path: `${API}/prepare-upload${pin}`, body: Buffer.from(JSON.stringify({ info: this.info(), files })), type: 'application/json', wait: ANSWER_WAIT_MS, max: MAX_JSON });
    if (res.status === 204) return; // it has them, or needs none
    if (res.status === 401) throw new LsError('pin', 'that device asks for a PIN');
    if (res.status === 403) throw new LsError('declined', 'declined');
    if (res.status === 409) throw new LsError('busy', 'that device is busy with another transfer');
    if (res.status === 429) throw new LsError('rate', 'that device asks to wait');
    const ok = res.status === 200 ? json(res.body) : null;
    if (!ok || typeof ok.sessionId !== 'string' || !ok.files || typeof ok.files !== 'object') throw new LsError('answer', `HTTP ${res.status}`);
    transfer.state = 'running';
    this.emit('transfer', { ...transfer });
    const cancelThere = () => this._request({ ip: peer.ip, port: peer.port, fingerprint: peer.fingerprint, method: 'POST', path: `${API}/cancel?sessionId=${encodeURIComponent(ok.sessionId)}`, wait: 5000 }).catch(() => {});
    try {
      for (const f of list) {
        const tok = ok.files[f.id];
        if (typeof tok !== 'string') { transfer.total -= f.size; continue; } // it took only some of them
        const q = `sessionId=${encodeURIComponent(ok.sessionId)}&fileId=${encodeURIComponent(f.id)}&token=${encodeURIComponent(tok)}`;
        const body = f.size ? fs.createReadStream(f.path, { start: 0, end: f.size - 1 }) : Buffer.alloc(0);
        let sent = 0;
        const up = await this._request({
          ...to, method: 'POST', path: `${API}/upload?${q}`, body: f.size ? body : null, length: f.size, type: 'application/octet-stream', wait: IO_MS * 2,
          onSent: (n) => {
            sent += n;
            transfer.done += n;
            if (Date.now() - entry.last >= PROGRESS_MS) { entry.last = Date.now(); this.emit('transfer', { ...transfer }); }
          },
        });
        if (up.status === 422) throw new LsError('integrity', `${path.basename(f.path)} arrived changed`);
        if (up.status < 200 || up.status >= 300) throw new LsError('answer', `HTTP ${up.status}`);
        if (sent !== f.size) throw new LsError('read', `${path.basename(f.path)} changed while it was sent`);
      }
    } catch (e) {
      await cancelThere();
      throw e;
    }
    this._remember(peer.fingerprint, peer.alias); // files went to it: a device the person here knows
  }

  // Stops a transfer of ours (the other side is told), or an arriving one.
  cancel(id) {
    const out = this._out.get(id);
    if (out) { out.abort.abort(); return true; }
    for (const s of this._sessions.values()) if (s.transfer.id === id) { this._endSession(s, 'cancelled'); return true; }
    return false;
  }
}

module.exports = {
  LocalSend, LsError, PORT, GROUP, VERSION, API,
  makeIdentity, loadIdentity, fingerprintOf, splitName, cleanSegment, uniquePath, isLocalAddress, peerFrom, downgrades, versionWhy, planFiles, request, skeleton,
};
