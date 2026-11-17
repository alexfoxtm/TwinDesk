// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera photo backup, Mac side of the transfer (mac/photobackup.js wires the session;
// PhotoBackup.kt is the phone). One new camera photo at a time, after both sides opt in.
//
// Bytes stay on the authenticated session socket as backup.chunk, not file.offer, not the
// Save allowance (shared/asked-send.js), and not fx/fx2. A chunk carries the request, the
// batch, the item and its generation, so a replaced socket cannot finish an old request.
// That is slower than fx2 ranges: one image, base64, 32 KiB of photo bytes at a time.
// A relay that still looks like a normal IP session is not marked separately; Bluetooth is.
// A generation change for an id the phone's cursor has already passed waits until a later
// scan sees that id again. New camera photos get higher ids, so they are not in that gap.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHUNK = 32 * 1024;
const MAX_BYTES = 80 * 1024 * 1024;
const SEP = '\u001f';
const OPEN = 1;

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
  if (typeof g === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(g)) return g;
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
  s = s.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  if (!s || s === '.' || s === '..') return '';
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  if (!s || s === '.' || s === '..') return '';
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

function hashFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function insideRoot(root, dest) {
  let base;
  try { base = fs.realpathSync(root); } catch { return false; }
  const abs = path.resolve(dest);
  let cur = path.dirname(abs);
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      const rel = path.relative(base, path.resolve(real, path.relative(cur, abs)));
      return !!rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
    } catch (e) {
      if (e.code !== 'ENOENT') return false;
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  }
}

function b64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) return null;
  return buf;
}

class Ledger {
  constructor(file) {
    this.file = file;
    this.data = { v: 1, peers: {} };
    this._load();
    this.recover();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.peers && typeof raw.peers === 'object') this.data = { v: 1, peers: raw.peers };
    } catch (e) {
      if (e.code !== 'ENOENT') this.data = { v: 1, peers: {} };
    }
  }

  _peer(origin) {
    if (!this.data.peers[origin]) this.data.peers[origin] = { items: {} };
    if (!this.data.peers[origin].items) this.data.peers[origin].items = {};
    return this.data.peers[origin];
  }

  get(origin, item, gen) {
    const g = this._peer(origin).items[item];
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
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  // A crash after the digest was stored and before "done": publish the part, or trust the
  // file already linked. A part with no digest is incomplete and is removed.
  recover() {
    let changed = false;
    for (const [origin, peer] of Object.entries(this.data.peers)) {
      const items = peer && peer.items;
      if (!items) continue;
      for (const item of Object.keys(items)) {
        for (const gen of Object.keys(items[item])) {
          const row = items[item][gen];
          if (!row || row.state === 'done') {
            if (row && row.state === 'done' && row.part) { row.part = ''; changed = true; }
            continue;
          }
          if (row.state !== 'pending' || typeof row.sha !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha)) {
            this._unlink(row && row.part);
            delete items[item][gen];
            changed = true;
            continue;
          }
          if (row.dest && this._same(row.dest, row.size, row.sha)) {
            this._unlink(row.part);
            row.state = 'done';
            row.part = '';
            changed = true;
            continue;
          }
          if (row.part && this._same(row.part, row.size, row.sha) && row.dest) {
            try {
              const dest = this._linkNew(row.part, row.dest, row.size, row.sha);
              this._unlink(row.part);
              row.dest = dest;
              row.state = 'done';
              row.part = '';
              changed = true;
              continue;
            } catch {
              // Leave the part. The next open tries the link again.
              continue;
            }
          }
          this._unlink(row.part);
          delete items[item][gen];
          changed = true;
        }
        if (items[item] && !Object.keys(items[item]).length) delete items[item];
      }
    }
    if (changed) this.save();
  }

  _unlink(file) {
    if (!file) return;
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  _same(file, size, sha) {
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile() || st.size !== size) return false;
    return hashFile(file) === sha;
  }

  _linkNew(part, dest, size, sha) {
    const place = (target) => {
      try {
        fs.linkSync(part, target);
        return target;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (this._same(target, size, sha)) return target;
        return null;
      }
    };
    const first = place(dest);
    if (first) return first;
    const ext = path.extname(dest);
    const base = dest.slice(0, dest.length - ext.length);
    for (let n = 2; n < 500; n++) {
      const alt = `${base}-${n}${ext}`;
      if (fs.existsSync(alt)) {
        if (this._same(alt, size, sha)) return alt;
        continue;
      }
      const linked = place(alt);
      if (linked) return linked;
    }
    throw Object.assign(new Error('name'), { code: 'EEXIST' });
  }

  // Digest is on disk before the name is published. link never replaces a file.
  commitPart({ origin, item, gen, root, part, sha, size, name, ym, afterLink }) {
    const dir = path.join(root, ym.y, ym.m);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, name);
    if (!insideRoot(root, dest)) throw Object.assign(new Error('path'), { code: 'EBADPATH' });
    if (fs.existsSync(dest)) {
      if (this._same(dest, size, sha)) {
        this._unlink(part);
        this.set(origin, item, gen, { state: 'done', size, sha, dest, part: '' });
        this.save();
        return dest;
      }
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      let picked = '';
      for (let n = 2; n < 500; n++) {
        const cand = `${base}-${n}${ext}`;
        const full = path.join(dir, cand);
        if (!fs.existsSync(full)) { picked = full; break; }
        if (this._same(full, size, sha)) {
          this._unlink(part);
          this.set(origin, item, gen, { state: 'done', size, sha, dest: full, part: '' });
          this.save();
          return full;
        }
      }
      if (!picked) throw Object.assign(new Error('name'), { code: 'EEXIST' });
      dest = picked;
    }
    this.set(origin, item, gen, { state: 'pending', size, sha, dest, part });
    this.save();
    const published = this._linkNew(part, dest, size, sha);
    if (published !== dest) {
      this.set(origin, item, gen, { state: 'pending', size, sha, dest: published, part });
      this.save();
    }
    if (typeof afterLink === 'function') afterLink();
    if (!this._same(published, size, sha)) throw Object.assign(new Error('short'), { code: 'EBADSHA' });
    this._unlink(part);
    let dfd;
    try {
      dfd = fs.openSync(dir, 'r');
      fs.fsyncSync(dfd);
    } catch { /* a directory that cannot be synced still has the linked file */ } finally {
      if (dfd != null) fs.closeSync(dfd);
    }
    this.set(origin, item, gen, { state: 'done', size, sha, dest: published, part: '' });
    this.save();
    return published;
  }
}

class Mac {
  constructor(ledger, { send, now = () => Date.now(), hooks = {} } = {}) {
    this.ledger = ledger;
    this.send = send || (() => false);
    this.now = now;
    this.hooks = hooks;
    this.conn = null;
    this.deviceId = '';
    this.transport = '';
    this.peerPb = false;
    this.local = { on: false, since: 0, mrev: 0, folder: '' };
    this.remote = { on: false, since: 0, rev: 0, perm: '', loc: false, api: 0, heard: false };
    this.flight = null;
    this.dead = new Set();
    this.inv = null;
    this.cursor = 0;
    this.syncReq = '';
    this.failed = new Set();
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

  why() { return gate(this.snap()); }

  live(conn) {
    return !!conn && conn === this.conn && conn.readyState === OPEN && conn.released !== true && conn.authed !== false;
  }

  bind(conn, deviceId, { transport = '', peerPb = false } = {}) {
    this.invalidate();
    this.conn = conn;
    this.deviceId = deviceId || '';
    this.transport = transport || '';
    this.peerPb = peerPb === true;
    this.remote = { on: false, since: 0, rev: 0, perm: '', loc: false, api: 0, heard: false };
    this._emitState();
  }

  unbind() {
    this.invalidate();
    this.conn = null;
    this.deviceId = '';
    this.peerPb = false;
    this.transport = '';
  }

  // Stop, Forget, a replaced socket, or the session moving: nothing further is written.
  invalidate() {
    const flight = this.flight;
    this.flight = null;
    this.inv = null;
    this.cursor = 0;
    this.syncReq = '';
    this.failed = new Set();
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
    if (!msg || typeof msg !== 'object') return;
    if (!this.live(conn)) {
      if (this.flight) this.invalidate();
      return;
    }
    if (typeof msg.req === 'string' && this.dead.has(msg.req) && msg.t !== 'backup.state' && msg.t !== 'backup.inv') {
      this._emit({ t: 'backup.refuse', req: msg.req, why: 'stop' });
      return;
    }
    if (msg.t === 'backup.state') this.onState(msg, conn);
    else if (msg.t === 'backup.inv') this.onInv(msg, conn);
    else if (msg.t === 'backup.accept') this.onAccept(msg, conn);
    else if (msg.t === 'backup.chunk') this.onChunk(msg, conn);
    else if (msg.t === 'backup.end') this.onEnd(msg, conn);
    else if (msg.t === 'backup.refuse') this.onRefuse(msg, conn);
    else if (msg.t === 'backup.stop') this.invalidate();
  }

  onState(msg, conn) {
    if (!this.live(conn)) return;
    if (!Object.prototype.hasOwnProperty.call(msg, 'perm') && !Object.prototype.hasOwnProperty.call(msg, 'api')) return;
    const rev = msg.rev;
    const since = msg.since;
    if (typeof msg.on !== 'boolean' || !Number.isInteger(rev) || rev < 0 || typeof since !== 'number' || !Number.isFinite(since) || since < 0) return;
    if (typeof msg.perm !== 'string' || msg.perm.length > 16) return;
    if (typeof msg.loc !== 'boolean') return;
    if (!Number.isInteger(msg.api)) return;
    const prev = this.remote;
    const next = { on: msg.on, since, rev, perm: msg.perm, loc: msg.loc, api: msg.api, heard: true };
    const changed = prev.heard && (prev.rev !== rev || prev.on !== next.on || prev.since !== since || prev.perm !== next.perm || prev.loc !== next.loc || prev.api !== next.api);
    this.remote = next;
    if (changed) this.invalidate();
    if (!this.flight) this.maybeSync();
  }

  onInv(msg, conn) {
    if (!this.live(conn) || this.why() || this.flight || this.inv) return;
    if (!token(msg.req) || !token(msg.scan) || msg.sync !== this.syncReq) return;
    if (msg.rev !== this.remote.rev || msg.mrev !== this.local.mrev) return;
    if (!Array.isArray(msg.items) || msg.items.length > 40) return;
    this.inv = {
      req: msg.req,
      scan: msg.scan,
      more: msg.more === true,
      remain: msg.remain === true,
      items: msg.items,
    };
    this.cursor = 0;
    this.failed = new Set();
    this.pump();
  }

  onAccept(msg, conn) {
    const f = this.flight;
    if (!this.live(conn) || !f || f.phase !== 'take' || !this._echo(msg, f) || msg.size !== f.size) {
      if (f && msg && msg.req === f.req) this.failItem('echo');
      return;
    }
    if (this.why()) { this.failItem(this.why() || 'stop'); return; }
    try {
      const dir = path.join(this.local.folder, f.ym.y, f.ym.m);
      fs.mkdirSync(dir, { recursive: true });
      const part = path.join(dir, `.pb-${hid()}.part`);
      if (!insideRoot(this.local.folder, part)) throw Object.assign(new Error('path'), { code: 'EBADPATH' });
      f.part = part;
      f.fd = fs.openSync(part, 'wx', 0o600);
      f.phase = 'body';
      f.seq = 0;
      f.got = 0;
    } catch {
      this.failItem('disk');
    }
  }

  onChunk(msg, conn) {
    const f = this.flight;
    if (!f || f.phase !== 'body') {
      if (msg && typeof msg.req === 'string' && this.dead.has(msg.req)) this._emit({ t: 'backup.refuse', req: msg.req, why: 'stop' });
      return;
    }
    if (!this.live(conn) || !this._echo(msg, f) || msg.seq !== f.seq) { this.failItem('echo'); return; }
    if (this.why()) { this.failItem('stop'); return; }
    const buf = b64(msg.data);
    if (!buf || buf.length > CHUNK || f.got + buf.length > f.size) { this.failItem('checksum'); return; }
    try {
      fs.writeSync(f.fd, buf);
      f.got += buf.length;
      f.seq += 1;
    } catch {
      this.failItem('disk');
    }
  }

  onEnd(msg, conn) {
    const f = this.flight;
    if (!this.live(conn) || !f || f.phase !== 'body' || !this._echo(msg, f)) {
      if (f && msg && msg.req === f.req) this.failItem('echo');
      return;
    }
    if (typeof msg.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(msg.sha256) || msg.size !== f.size || f.got !== f.size) {
      this.failItem('checksum');
      return;
    }
    const part = f.part;
    try {
      fs.fsyncSync(f.fd);
      fs.closeSync(f.fd);
      f.fd = null;
      const sha = hashFile(part);
      const st = fs.statSync(part);
      if (sha !== msg.sha256 || st.size !== f.size) { this.failItem('checksum'); return; }
      const dest = this.ledger.commitPart({
        origin: this.deviceId, item: f.item, gen: f.gen, root: this.local.folder,
        part, sha, size: f.size, name: f.name, ym: f.ym,
        afterLink: this.hooks.afterLink,
      });
      const done = {
        t: 'backup.done', req: f.req, inv: f.inv, scan: f.scan, batch: f.batch,
        item: f.item, gen: Number(f.gen), rev: f.rev, mrev: f.mrev, size: f.size, sha256: sha, dest,
      };
      this.flight = null;
      this._emit(done);
      this.pump();
    } catch (e) {
      const row = this.ledger.get(this.deviceId, f.item, f.gen);
      if (!row || row.state === 'done' || !row.sha) this._discard(f);
      this.dead.add(f.req);
      if (this.dead.size > 64) this.dead.delete(this.dead.values().next().value);
      this.flight = null;
      this.inv = null;
      this.syncReq = '';
      if (row && row.state === 'done') return;
      throw e;
    }
  }

  onRefuse(msg, conn) {
    if (!this.live(conn) || !msg) return;
    const f = this.flight;
    if (f && msg.req === f.req) {
      const why = typeof msg.why === 'string' ? msg.why : 'stop';
      this.failItem(why === 'permission' || why === 'checksum' || why === 'disk' ? why : 'stop');
      return;
    }
    // The phone declined the scan itself (permission, consent, Bluetooth). Do not ask again
    // until the next state, or a revoked permission would spin.
    if (msg.req && msg.req === this.syncReq) this.syncReq = '';
  }

  maybeSync() {
    if (this.flight || this.inv || this.syncReq) return;
    if (this.why()) return;
    if (!this.live(this.conn)) return;
    const req = hid();
    this.syncReq = req;
    this.failed = new Set();
    this._emit({ t: 'backup.sync', req, rev: this.remote.rev, mrev: this.local.mrev });
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
      const row = this.ledger.get(this.deviceId, checked.item, checked.gen);
      if (row && row.state === 'done' && row.dest && fs.existsSync(row.dest)) {
        this._emit(this._have(checked));
        continue;
      }
      const req = hid();
      const batch = hid();
      this.flight = {
        phase: 'take', req, batch, inv: this.inv.req, scan: this.inv.scan,
        item: checked.item, gen: checked.gen, size: checked.size, name: checked.name, ym: checked.ym,
        rev: this.remote.rev, mrev: this.local.mrev, seq: 0, got: 0, part: '', fd: null,
      };
      this._emit({
        t: 'backup.take', req, inv: this.inv.req, scan: this.inv.scan, batch,
        item: checked.item, gen: Number(checked.gen), size: checked.size,
        rev: this.remote.rev, mrev: this.local.mrev,
      });
      return;
    }
    const again = this.inv.more || this.inv.remain;
    const failed = this.failed.size > 0;
    this.inv = null;
    this.syncReq = '';
    if (again && !failed) this.maybeSync();
  }

  _have(checked) {
    const req = hid();
    return {
      t: 'backup.have', req, inv: this.inv.req, scan: this.inv.scan, batch: hid(),
      item: checked.item, gen: Number(checked.gen), rev: this.remote.rev, mrev: this.local.mrev,
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
    this._kill(f);
    this.flight = null;
    if (why === 'checksum' || why === 'disk' || why === 'permission') this.failed.add(`${f.item}${SEP}${f.gen}`);
    this._emit({
      t: 'backup.refuse', req: f.req, inv: f.inv, scan: f.scan, batch: f.batch,
      item: f.item, gen: Number(f.gen), why, rev: f.rev, mrev: f.mrev,
    });
    this.pump();
  }

  _kill(f) {
    this.dead.add(f.req);
    if (this.dead.size > 64) this.dead.delete(this.dead.values().next().value);
    this._discard(f);
    const row = this.ledger.get(this.deviceId, f.item, f.gen);
    if (row && row.state === 'pending' && !row.sha) this.ledger.drop(this.deviceId, f.item, f.gen);
    if (row && row.state !== 'done') {
      // An explicit stop is not a crash. The part is not published later.
      if (row.part) {
        try { fs.unlinkSync(row.part); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      if (row.state === 'pending') {
        this.ledger.drop(this.deviceId, f.item, f.gen);
        this.ledger.save();
      }
    }
  }

  _discard(f) {
    if (f.fd != null) {
      try { fs.closeSync(f.fd); } catch { /* already closed */ }
      f.fd = null;
    }
    if (f.part) {
      try { fs.unlinkSync(f.part); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      f.part = '';
    }
  }

  _emitState() {
    this._emit({ t: 'backup.state', on: this.local.on, since: this.local.since, mrev: this.local.mrev });
  }

  _emit(msg) {
    if (!this.live(this.conn)) return false;
    return this.send(msg) !== false;
  }
}

module.exports = {
  CHUNK, MAX_BYTES, SEP, gate, itemKey, validItem, safeName, yearMonth, hashFile, insideRoot, Ledger, Mac,
};
