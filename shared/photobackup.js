// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera photo backup, Mac side of the transfer (mac/photobackup.js wires the session;
// PhotoBackup.kt is the phone). One new camera photo at a time, after both sides opt in.
//
// Bytes stay on the authenticated session socket as backup.chunk, not file.offer, not the
// Save allowance (shared/asked-send.js), and not fx/fx2. A chunk carries the request, the
// batch, the item and its generation, so a replaced socket cannot finish an old request.
// That is slower than fx2 ranges: one image, base64, 32 KiB of photo bytes at a time.
// A relay that still looks like a normal IP session is not marked separately; Bluetooth is.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHUNK = 32 * 1024;
const CREDIT_WINDOW = 16 * CHUNK;
const CREDIT_FLUSH = 8 * 1024 * 1024;
const MAX_BYTES = 80 * 1024 * 1024;
const SEP = '\u001f';
const OPEN = 1;
const WAIT_MS = 30_000;
const CREDIT_IDLE_MS = 120_000;
const BODY_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const PART = /^\.pb-[0-9a-f]{16}\.part$/;

function fieldOk(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && !/[\u0000-\u001f]/.test(s);
}

function token(s) {
  return typeof s === 'string' && /^[0-9A-Za-z._-]{1,64}$/.test(s);
}

function itemKey(vol, ver, id) {
  const n = typeof id === 'number' ? String(id) : id;
  if (!fieldOk(vol) || !fieldOk(ver) || typeof n !== 'string' || !/^[1-9][0-9]{0,18}$/.test(n)) return '';
  return `${vol}${SEP}${ver}${SEP}${n}`;
}

function validItem(item) {
  if (typeof item !== 'string') return false;
  const p = item.split(SEP);
  return p.length === 3 && itemKey(p[0], p[1], p[2]) === item;
}

function normGen(g) {
  if (typeof g === 'number' && Number.isInteger(g) && g >= 0 && g <= Number.MAX_SAFE_INTEGER) return String(g);
  if (typeof g === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(g) &&
      (g.length < 19 || g <= '9223372036854775807')) return g;
  return null;
}

function gate(s) {
  if (!s || !s.peerPb) return 'peer';
  if (s.transport !== 'ip') return 'transport';
  if (!s.heard) return 'wait';
  if (!(Number(s.api) >= 30)) return 'api';
  if (s.perm !== 'ok') return s.perm === 'partial' ? 'partial' : 'media';
  if (!s.loc) return 'location';
  if (!s.localOn || !s.remoteOn) return 'consent';
  if (!s.folder) return 'folder';
  return '';
}

function safeName(name) {
  let s = String(name == null ? '' : name).replace(/\\/g, '/');
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '').trim().replace(/^\.+/, '');
  if (!s || s === '.' || s === '..') return '';
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  if (!s || s === '.' || s === '..') return '';
  // Leave room for a collision suffix and multibyte characters on the filesystem.
  while (Buffer.byteLength(s) > 220) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, s.length - ext.length - 1) + ext;
  }
  return s;
}

// Local calendar. DATE_TAKEN when it is a real past-or-near instant, otherwise DATE_ADDED.
function yearMonth(taken, added, now = Date.now()) {
  const pick = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    if (ms > now + 86400000) return null;
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    if (y < 1970 || y > 2100 || m < 1 || m > 12) return null;
    return { y: String(y), m: String(m).padStart(2, '0') };
  };
  return pick(Number(taken)) || pick(Number(added));
}

function hid() {
  return crypto.randomBytes(8).toString('hex');
}

function hashFile(file, progress) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a file');
    const buf = Buffer.alloc(64 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
      progress?.();
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Check each existing component before creating the next. An archive path may not cross a symlink.
function archiveDir(root, ym, create = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw new Error('archive root');
  if (!/^\d{4}$/.test(ym.y) || !/^(0[1-9]|1[0-2])$/.test(ym.m)) throw new Error('archive date');
  let parent = root;
  for (const name of [ym.y, ym.m]) {
    const dir = path.join(parent, name);
    if (create) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('archive path');
    if (create) fsyncDir(parent);
    parent = dir;
  }
  return parent;
}

function rowPath(row, file, part = false) {
  if (typeof file !== 'string' || !file || (part && !PART.test(path.basename(file)))) return false;
  try {
    const parent = path.dirname(file);
    const dir = archiveDir(row.root, { y: path.basename(path.dirname(parent)), m: path.basename(parent) });
    return parent === dir;
  } catch { return false; }
}

function b64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > Math.ceil(CHUNK / 3) * 4 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) return null;
  return buf;
}

class Ledger {
  constructor(file, { readOnly = false } = {}) {
    this.readOnly = readOnly;
    this.file = file;
    this.data = { v: 1, peers: {} };
    this.broken = false;
    this._load();
    if (!readOnly && !this.broken) {
      try { this.recover(); } catch { this.broken = true; }
    }
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.v !== 1 || !raw.peers || typeof raw.peers !== 'object' || Array.isArray(raw.peers)) throw new Error('ledger');
      this.data = { v: 1, peers: raw.peers };
    } catch (e) {
      if (e.code !== 'ENOENT') this.broken = true;
    }
  }

  _peer(origin) {
    if (!Object.hasOwn(this.data.peers, origin)) Object.defineProperty(this.data.peers, origin, {
      value: { items: {} }, configurable: true, writable: true, enumerable: true,
    });
    if (!this.data.peers[origin].items) this.data.peers[origin].items = {};
    return this.data.peers[origin];
  }

  get(origin, item, gen) {
    const g = Object.hasOwn(this.data.peers, origin) && this.data.peers[origin]?.items?.[item];
    return g ? g[String(gen)] || null : null;
  }

  set(origin, item, gen, row) {
    const items = this._peer(origin).items;
    if (!items[item]) items[item] = {};
    items[item][String(gen)] = row;
  }

  drop(origin, item, gen) {
    const items = this._peer(origin).items;
    const g = items[item];
    if (!g) return;
    delete g[String(gen)];
    if (!Object.keys(g).length) delete items[item];
  }

  save() {
    if (this.broken) throw new Error('backup history is unreadable');
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${hid()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      fsyncDir(dir);
    } finally {
      this._unlink(tmp);
    }
  }

  // Journal the path before the first byte. Recovery drops incomplete parts and recognizes an
  // already-published file; it never publishes a pending part without renewed consent.
  recover() {
    let changed = false;
    for (const [origin, peer] of Object.entries(this.data.peers)) {
      if (!peer?.items) continue;
      for (const [item, revisions] of Object.entries(peer.items)) {
        for (const [gen, row] of Object.entries(revisions)) {
          if (row?.state === 'done' && !row.part) continue;
          if (row?.part && !this.clearPart(row)) continue; // missing mount or unsafe path: keep its receipt
          if (row?.state === 'pending' && /^[0-9a-f]{64}$/.test(row.sha) &&
              rowPath(row, row.dest) && this._same(row.dest, row.size, row.sha)) {
            fsyncDir(path.dirname(row.dest));
            const st = fs.lstatSync(row.dest);
            this.set(origin, item, gen, { ...row, state: 'done', part: '', ino: st.ino, dev: st.dev, mtime: st.mtimeMs });
          } else this.drop(origin, item, gen);
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  clearPart(row) {
    if (!row.part) return true;
    if (!rowPath(row, row.part, true)) return false;
    this._unlink(row.part);
    return true;
  }

  _unlink(file) {
    if (!file) return;
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  _same(file, size, sha, progress) {
    try {
      const st = fs.lstatSync(file);
      return st.isFile() && st.size === size && hashFile(file, progress) === sha;
    } catch { return false; }
  }

  hasArchived(row, root, size) {
    if (row?.state !== 'done' || row.root !== root || row.size !== size || !rowPath(row, row.dest)) return false;
    const st = fs.lstatSync(row.dest, { throwIfNoEntry: false });
    return !!st && st.isFile() && st.size === size && st.ino === row.ino && st.dev === row.dev && st.mtimeMs === row.mtime;
  }

  beginPart({ origin, item, gen, root, ym, size }) {
    const old = this.get(origin, item, gen);
    if (old && !this.clearPart(old)) throw new Error('previous backup folder is unavailable');
    const dir = archiveDir(root, ym, true);
    const part = path.join(dir, `.pb-${hid()}.part`);
    this.set(origin, item, gen, { state: 'receiving', size, root, part });
    this.save();
    return { part, fd: fs.openSync(part, 'wx', 0o600) };
  }

  // The pending ledger names the exact file before link(), including on a name collision.
  commitPart({ origin, item, gen, root, part, sha, size, name, ym, beforePublish, afterLink, progress }) {
    const dir = archiveDir(root, ym);
    if (!rowPath({ root }, part, true) || path.dirname(part) !== dir) throw new Error('archive part');
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const source = fs.lstatSync(part);
    if (!source.isFile() || source.size !== size) throw new Error('archive size');
    for (let n = 1; n < 500; n++) {
      const dest = path.join(dir, n === 1 ? name : `${base}-${n}${ext}`);
      const present = fs.lstatSync(dest, { throwIfNoEntry: false });
      if (present && !this._same(dest, size, sha, progress)) continue;
      const pending = { state: 'pending', root, size, sha, dest, part };
      this.set(origin, item, gen, pending);
      this.save();
      progress?.();
      beforePublish?.();
      if (!present) {
        try { fs.linkSync(part, dest); } catch (e) {
          if (e.code === 'EEXIST') continue;
          throw e;
        }
        if (typeof afterLink === 'function') afterLink();
      }
      const st = fs.lstatSync(dest);
      if (!st.isFile() || st.size !== size ||
          (!present && (st.dev !== source.dev || st.ino !== source.ino))) throw new Error('archive changed');
      fsyncDir(dir);
      progress?.();
      this._unlink(part);
      this.set(origin, item, gen, { ...pending, state: 'done', part: '', ino: st.ino, dev: st.dev, mtime: st.mtimeMs });
      try { this.save(); } catch (e) { this.set(origin, item, gen, pending); throw e; }
      return dest;
    }
    throw new Error('archive filename is in use');
  }
}

function validPhoneState(msg) {
  const { on, rev, since, perm, loc, api } = msg;
  return typeof on === 'boolean' && Number.isInteger(rev) && rev >= 0 &&
    typeof since === 'number' && Number.isFinite(since) && since >= 0 &&
    typeof perm === 'string' && perm.length <= 16 && typeof loc === 'boolean' && Number.isInteger(api);
}

class Mac {
  constructor(ledger, { send, now = () => Date.now(), changed = () => {}, hooks = {} } = {}) {
    this.ledger = ledger;
    this.send = send || (() => false);
    this.now = now;
    this.changed = changed;
    this.hooks = hooks;
    this.conn = null;
    this.deviceId = '';
    this.origin = '';
    this.transport = '';
    this.peerPb = false;
    this.local = { on: false, since: 0, mrev: 0, folder: '' };
    this.remote = { on: false, since: 0, rev: 0, perm: '', loc: false, api: 0, heard: false };
    this.flight = null;
    this.inv = null;
    this.cursor = 0;
    this.syncReq = '';
    this.timer = null;
    this.retry = null;
    this.problem = '';
    this.rescan = false;
  }

  snap() {
    return {
      peerPb: this.peerPb,
      transport: this.transport,
      heard: this.remote.heard,
      api: this.remote.api,
      perm: this.remote.perm,
      loc: this.remote.loc,
      localOn: this.local.on,
      remoteOn: this.remote.on,
      folder: this.local.folder,
    };
  }

  why() { return gate(this.snap()) || (this.ledger.broken ? 'disk' : ''); }

  live(conn) {
    return !!conn && conn === this.conn && conn.readyState === OPEN && conn.released !== true && conn.authed !== false;
  }

  bind(conn, deviceId, { transport = '', peerPb = false, origin = deviceId, local = null } = {}) {
    this.invalidate();
    this.conn = conn;
    this.deviceId = deviceId || '';
    this.origin = origin || '';
    this.transport = transport || '';
    this.peerPb = peerPb === true;
    this.remote = { on: false, since: 0, rev: 0, perm: '', loc: false, api: 0, heard: false };
    this.local = { on: false, since: 0, mrev: 0, folder: '' };
    if (local) this.setLocal(local);
  }

  unbind() {
    this.invalidate();
    this.conn = null;
    this.deviceId = '';
    this.origin = '';
    this.peerPb = false;
    this.transport = '';
  }

  // Stop, Forget, a replaced socket, or the session moving: nothing further is written.
  invalidate() {
    const flight = this.flight;
    this.flight = null;
    this._clearTimer();
    clearTimeout(this.retry);
    this.retry = null;
    this.problem = '';
    this.inv = null;
    this.cursor = 0;
    this.syncReq = '';
    this.rescan = false;
    if (!flight) return;
    this._kill(flight);
    this._emit({ t: 'backup.stop', req: flight.req });
  }

  setLocal(next) {
    const prev = this.local;
    const local = {
      on: next.on === true,
      since: Number(next.since) || 0,
      mrev: Number.isInteger(next.mrev) ? next.mrev : (Number.isInteger(next.rev) ? next.rev : 0),
      folder: typeof next.folder === 'string' ? next.folder : '',
    };
    const changed = prev.on !== local.on || prev.since !== local.since || prev.mrev !== local.mrev || prev.folder !== local.folder;
    this.local = local;
    if (changed) this.invalidate();
    this._emitState();
    if (!this.flight) this.maybeSync();
  }

  receive(msg, conn) {
    if (!msg || typeof msg !== 'object' || !this.live(conn)) return;
    if (msg.t === 'backup.state') this.onState(msg, conn);
    else if (msg.t === 'backup.inv') this.onInv(msg, conn);
    else if (msg.t === 'backup.accept') this.onAccept(msg, conn);
    else if (msg.t === 'backup.chunk') this.onChunk(msg, conn);
    else if (msg.t === 'backup.end') this.onEnd(msg, conn);
    else if (msg.t === 'backup.refuse') this.onRefuse(msg, conn);
    else if (msg.t === 'backup.stop' && this.flight && msg.req === this.flight.req) {
      this.invalidate();
      this._retrySoon('wait');
    }
  }

  _clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  _deadline(ms, expire) {
    this._clearTimer();
    this.timer = setTimeout(expire, ms);
    this.timer.unref?.();
  }

  _retrySoon(reason) {
    this.problem = reason;
    if (!this.retry && !this.why() && this.live(this.conn)) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.maybeSync();
        this.changed();
      }, RETRY_MS);
      this.retry.unref?.();
    }
    this.changed();
  }

  _watchFlight(f) {
    f.idleUntil = Math.min(f.until, this.now() + (f.credit && f.phase === 'body' ? CREDIT_IDLE_MS : WAIT_MS));
    this._deadline(Math.max(1, f.idleUntil - this.now()), () => {
      if (this.flight === f) this.failItem('timeout');
    });
  }

  onState(msg, conn) {
    if (!this.live(conn)) return;
    if (!validPhoneState(msg)) return;
    const { rev, since } = msg;
    const prev = this.remote;
    const next = { on: msg.on, since, rev, perm: msg.perm, loc: msg.loc, api: msg.api, heard: true };
    if (prev.heard && (rev < prev.rev || (rev === prev.rev && (prev.on !== next.on || prev.since !== since)))) return;
    const changed = prev.heard && (prev.rev !== rev || prev.on !== next.on || prev.since !== since || prev.perm !== next.perm || prev.loc !== next.loc || prev.api !== next.api);
    this.remote = next;
    if (changed) this.invalidate();
    if (!this.why() && (this.flight || this.inv || this.syncReq)) this.rescan = true;
    else this.maybeSync();
  }

  onInv(msg, conn) {
    if (!this.live(conn) || this.why() || this.flight || this.inv) return;
    if (!token(msg.req) || !token(msg.scan) || msg.sync !== this.syncReq) return;
    if (msg.rev !== this.remote.rev || msg.mrev !== this.local.mrev) return;
    if (!Array.isArray(msg.items) || msg.items.length > 40) return;
    this._clearTimer();
    this.inv = {
      req: msg.req,
      scan: msg.scan,
      more: msg.more === true,
      remain: msg.remain === true,
      items: msg.items,
    };
    this.cursor = 0;
    this.pump();
  }

  onAccept(msg, conn) {
    const f = this.flight;
    if (!this.live(conn) || !f || msg.req !== f.req || f.phase !== 'take') return;
    if (!this._echo(msg, f) || msg.size !== f.size) { this.failItem('echo'); return; }
    if (this.why() || f.idleUntil <= this.now()) { this.failItem('stop'); return; }
    try {
      const opened = this.ledger.beginPart({ origin: f.origin, item: f.item, gen: f.gen, root: f.folder, ym: f.ym, size: f.size });
      f.part = opened.part;
      f.fd = opened.fd;
      f.hash = crypto.createHash('sha256');
      f.phase = 'body';
      this._watchFlight(f);
      this._credit(f);
    } catch { this.failItem('disk'); }
  }

  onChunk(msg, conn) {
    const f = this.flight;
    if (!f || f.phase !== 'body' || msg.req !== f.req) return;
    if (!this.live(conn) || this.why() || f.idleUntil <= this.now()) { this.failItem('stop'); return; }
    if (!this._echo(msg, f) || msg.seq !== f.seq) { this.failItem('echo'); return; }
    const buf = b64(msg.data);
    if (!buf || buf.length > CHUNK || f.got + buf.length > f.size) { this.failItem('checksum'); return; }
    try {
      fs.writeFileSync(f.fd, buf);
      f.hash.update(buf);
      f.got += buf.length;
      f.seq += 1;
      if (f.credit && f.got - (f.flushed || 0) >= CREDIT_FLUSH) {
        fs.fsyncSync(f.fd);
        f.flushed = f.got;
      }
      this._watchFlight(f);
      this._credit(f);
    } catch { this.failItem('disk'); }
  }

  _credit(f) {
    if (f.credit) this._emit({ t: 'backup.credit', req: f.req, written: f.got, upTo: Math.min(f.size, f.got + CREDIT_WINDOW) });
  }

  onEnd(msg, conn) {
    const f = this.flight;
    if (!f || f.phase !== 'body' || msg.req !== f.req) return;
    if (!this.live(conn) || this.why() || f.idleUntil <= this.now()) { this.failItem('stop'); return; }
    if (!this._echo(msg, f)) { this.failItem('echo'); return; }
    const sha = f.hash.digest('hex');
    if (sha !== msg.sha256 || msg.size !== f.size || f.got !== f.size) { this.failItem('checksum'); return; }
    let lastProgress = -Infinity;
    const progress = f.credit ? () => {
      const now = this.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      this._emit({ t: 'backup.progress', req: f.req });
    } : undefined;
    try {
      fs.fsyncSync(f.fd);
      progress?.();
      fs.closeSync(f.fd);
      f.fd = null;
      this.ledger.commitPart({
        origin: f.origin, item: f.item, gen: f.gen, root: f.folder,
        part: f.part, sha, size: f.size, name: f.name, ym: f.ym,
        beforePublish: this.hooks.beforePublish, afterLink: this.hooks.afterLink, progress,
      });
    } catch {
      // Leave any final file in place. A retry verifies it rather than writing a duplicate.
      this.failItem('disk');
      return;
    }
    this._clearTimer();
    this.flight = null;
    this.problem = '';
    this._emit({
      t: 'backup.done', req: f.req, inv: f.inv, scan: f.scan, batch: f.batch,
      item: f.item, gen: f.gen, rev: f.rev, mrev: f.mrev, size: f.size, sha256: sha,
    });
    this.pump();
  }

  onRefuse(msg, conn) {
    if (!this.live(conn) || !msg) return;
    const f = this.flight;
    if (f && msg.req === f.req && (this._echo(msg, f) ||
        (!msg.item && msg.rev === f.rev && msg.mrev === f.mrev))) {
      const why = typeof msg.why === 'string' ? msg.why : 'stop';
      this.failItem(['permission', 'checksum', 'disk', 'gone', 'version', 'timeout', 'read'].includes(why) ? why : 'stop');
      return;
    }
    if (!this.flight && !this.inv && msg.req === this.syncReq) {
      this._clearTimer();
      this.syncReq = '';
      this._retrySoon(msg.why === 'permission' ? 'media' : 'wait');
    }
  }

  maybeSync() {
    if (this.flight || this.inv || this.syncReq || this.retry || this.why() || !this.live(this.conn)) return;
    const req = hid();
    this.syncReq = req;
    this.rescan = false;
    if (!this._emit({ t: 'backup.sync', req, rev: this.remote.rev, mrev: this.local.mrev })) {
      this.syncReq = '';
      return;
    }
    this._deadline(WAIT_MS, () => {
      if (this.syncReq !== req || this.inv) return;
      this.syncReq = '';
      this._retrySoon('wait');
    });
  }

  pump() {
    if (!this.inv || this.flight) return;
    if (this.why()) { this.invalidate(); return; }
    const cutoff = Math.max(this.local.since || 0, this.remote.since || 0);
    while (this.cursor < this.inv.items.length) {
      const raw = this.inv.items[this.cursor++];
      const checked = this._check(raw, cutoff);
      if (typeof checked === 'string') {
        this._emit({
          t: 'backup.refuse', req: this.inv.req, inv: this.inv.req, scan: this.inv.scan,
          item: raw && raw.item, gen: raw && raw.gen, why: checked, rev: this.remote.rev, mrev: this.local.mrev,
        });
        continue;
      }
      const row = this.ledger.get(this.origin, checked.item, checked.gen);
      let have = false;
      try { have = this.ledger.hasArchived(row, this.local.folder, checked.size); } catch { /* retry the file */ }
      if (have) {
        this._emit(this._have(checked, row.sha));
        continue;
      }
      const req = hid();
      const batch = hid();
      this.flight = {
        phase: 'take', req, batch, inv: this.inv.req, scan: this.inv.scan,
        item: checked.item, gen: checked.gen, size: checked.size, name: checked.name, ym: checked.ym,
        rev: this.remote.rev, mrev: this.local.mrev, seq: 0, got: 0, part: '', fd: null,
        origin: this.origin, folder: this.local.folder,
        credit: this.hooks.credit === true, until: this.hooks.credit ? Infinity : this.now() + BODY_MS,
      };
      this._watchFlight(this.flight);
      if (!this._emit({
        t: 'backup.take', ...(this.flight.credit ? { credit: CREDIT_WINDOW } : {}), req, inv: this.inv.req, scan: this.inv.scan, batch,
        item: checked.item, gen: checked.gen, size: checked.size,
        rev: this.remote.rev, mrev: this.local.mrev,
      })) this.failItem('stop');
      return;
    }
    const again = this.inv.more || this.inv.remain || this.rescan;
    this.inv = null;
    this.syncReq = '';
    if (again) this.maybeSync();
    else this.problem = '';
  }

  _have(checked, sha) {
    const req = hid();
    return {
      t: 'backup.have', req, inv: this.inv.req, scan: this.inv.scan, batch: hid(),
      item: checked.item, gen: checked.gen, size: checked.size, sha256: sha, rev: this.remote.rev, mrev: this.local.mrev,
    };
  }

  _check(raw, cutoff) {
    if (!raw || typeof raw !== 'object') return 'bad';
    if (!validItem(raw.item)) return 'bad';
    const gen = normGen(raw.gen);
    if (gen == null) return 'bad';
    if (!Number.isInteger(raw.size) || raw.size <= 0 || raw.size > MAX_BYTES) return 'bad';
    const name = safeName(raw.name);
    if (!name) return 'bad';
    const added = Number(raw.added);
    if (!Number.isFinite(added) || added < cutoff) return 'date';
    const ym = yearMonth(raw.taken, added, this.now());
    if (!ym) return 'date';
    const rel = path.relative(this.local.folder, path.resolve(this.local.folder, ym.y, ym.m, name));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'bad';
    return { item: raw.item, gen, size: raw.size, name, ym };
  }

  _echo(msg, f) {
    return !!msg && msg.req === f.req && msg.batch === f.batch && msg.item === f.item
      && String(msg.gen) === String(f.gen) && msg.rev === f.rev && msg.mrev === f.mrev
      && msg.scan === f.scan && msg.inv === f.inv;
  }

  failItem(why) {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    this._clearTimer();
    const clean = this._kill(f);
    const reason = clean ? why : 'disk';
    this.inv = null; // the phone drops this page when a flight is refused
    this.syncReq = '';
    this.rescan = false;
    this._emit({
      t: 'backup.refuse', req: f.req, inv: f.inv, scan: f.scan, batch: f.batch,
      item: f.item, gen: f.gen, why: reason, rev: f.rev, mrev: f.mrev,
    });
    this._retrySoon(reason === 'disk' ? 'disk' : 'wait');
  }

  _kill(f) {
    if (f.fd != null) {
      try { fs.closeSync(f.fd); } catch { /* already closed */ }
      f.fd = null;
    }
    const row = this.ledger.get(f.origin, f.item, f.gen);
    if (!row || row.state === 'done') return true;
    try {
      if (!this.ledger.clearPart(row)) return false;
      this.ledger.drop(f.origin, f.item, f.gen);
      this.ledger.save();
      return true;
    } catch {
      this.ledger.set(f.origin, f.item, f.gen, row);
      return false;
    }
  }

  _emitState() {
    this._emit({ t: 'backup.state', ...(this.hooks.credit ? { photoCredit: 1 } : {}), on: this.local.on, since: this.local.since, mrev: this.local.mrev });
  }

  _emit(msg) {
    if (!this.live(this.conn)) return false;
    try { return this.send(msg) !== false; } catch { return false; }
  }
}

module.exports = {
  CHUNK, CREDIT_WINDOW, rowPath, MAX_BYTES, CREDIT_IDLE_MS, RETRY_MS, SEP, gate, validPhoneState, itemKey, validItem, safeName, yearMonth, hashFile, Ledger, Mac,
};
