// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files with LocalSend-compatible apps, as a part of the app: the setting (off until turned on),
// the state the Files page shows and its actions. The protocol is shared/localsend/core.js (MPL-2.0);
// this file holds nothing of Electron either, so the Mac, Windows and Linux apps wire it the same way
// and give it their own dialogs:
//
//   const ls = startLocalSend({
//     dir,                       // where the identity and files on their way are kept
//     settings: () => settings,  // settings.localsend = { on }
//     save, pushState, t,
//     name: () => 'This Mac',    // what the other devices see
//     receivedDir: () => folder, // where accepted files go
//     ask: (offer, signal) => Promise<true | false | null>, // the question for one offer; null: no answer here
//     choose: () => Promise<paths>,                         // the file dialog
//     say: (title, body, onClick), reveal: (path), stored: (path),
//     mark: (path) => Promise,   // the app's mark on what arrives; on macOS it is quarantine() unless given
//   });
//   state.localsend = ls.view(); for (const [name, fn] of Object.entries(ls.actions)) ipcMain.on(name, …)
//
// Nothing is listened for, announced or accepted while the setting is off, and each offer is asked
// about: there is no "always accept".
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { LocalSend, PORT } = require('./core.js');

const KEEP = 30; // transfers shown
const SAVED_CAP = 40; // eligible files published from one look at the retained history
const REVEAL_MAX = 1000; // revealSaved rejects an index above 999
const SCAN_BUDGET = KEEP * SAVED_CAP; // how many retained saved paths one publication may stat

// The folder the person chose (Downloads, or their own). A link or a different case is the same
// folder. The path stored on the transfer stays what was written; publication uses this one.
function chosenParent(dir) {
  try {
    if (typeof dir === 'function') dir = dir();
    if (typeof dir !== 'string' || !dir) return null;
    const configured = path.resolve(dir);
    if (!path.isAbsolute(configured)) return null;
    const real = fs.realpathSync(configured);
    const st = fs.lstatSync(real);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return { configured, real };
  } catch {
    return null;
  }
}

function namesMatch(a, b) {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

// The part of file under root, or ''. A different case of the same folder still counts, on a
// volume that treats it as the same. '..' is not a child.
function childRelative(root, file) {
  if (!root || !file) return '';
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  if (file.length < base.length) return '';
  const head = file.slice(0, base.length);
  if (!(process.platform === 'linux' ? head === base : namesMatch(head, base))) return '';
  const rel = file.slice(base.length);
  if (!rel || rel.split(path.sep).some((part) => !part || part === '.' || part === '..')) return '';
  return rel;
}

function identityOf(st) {
  return { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs, folder: st.isDirectory() };
}

function sameIdentity(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && a.folder === b.folder;
}

// file is under the canonical parent. A link at the file, or at a folder between it and that
// parent, is not the entry that was saved. The path returned is the canonical one.
function walkSaved(rootReal, rel) {
  const parts = rel.split(path.sep);
  let current = rootReal;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    if (!name || name === '.' || name === '..' || path.isAbsolute(name)) return null;
    const next = path.join(current, name);
    let st;
    try { st = fs.lstatSync(next); } catch { return null; }
    if (st.isSymbolicLink()) return null;
    const last = i === parts.length - 1;
    if (!last) {
      if (!st.isDirectory()) return null;
      current = next;
      continue;
    }
    if (!st.isFile() && !st.isDirectory()) return null;
    let real;
    try { real = fs.realpathSync(next); } catch { return null; }
    const back = childRelative(rootReal, real);
    if (!back) return null;
    const backParts = back.split(path.sep);
    if (backParts.length !== parts.length || !backParts.every((part, at) => namesMatch(part, parts[at]))) return null;
    return { canonical: real, root: rootReal, identity: identityOf(st) };
  }
  return null;
}

function readUnder(parent, file) {
  if (!parent || typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let resolved;
  try { resolved = path.resolve(file); } catch { return null; }
  const rel = childRelative(parent.configured, resolved) || childRelative(parent.real, resolved);
  if (!rel) return null;
  return walkSaved(parent.real, rel);
}

// No chosen parent: the stored path itself has to already be canonical. This is the check the
// shelf used before a save folder was allowed to be a link.
function strictEntry(file) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return null;
    if (fs.realpathSync(file) !== file) return null;
    return { canonical: file, root: path.dirname(file), identity: identityOf(st) };
  } catch {
    return null;
  }
}

function entryNow(file, parent) {
  return parent === undefined ? strictEntry(file) : readUnder(parent, file);
}

// The identity taken at completion still names this path: same file, and no link in its container.
function stillThere(row) {
  if (!row || typeof row.canonical !== 'string' || typeof row.root !== 'string' || !row.identity) return false;
  const rel = childRelative(row.root, row.canonical);
  if (!rel) return false;
  const live = walkSaved(row.root, rel);
  return !!live && live.canonical === row.canonical && sameIdentity(live.identity, row.identity);
}

// Completed incoming files from the retained history. Missing and linked paths are not counted, so
// a transfer whose files are gone does not crowd out an older one that is still there. The scan
// looks at a bounded number of retained paths. `pins` is the identity taken when each transfer
// finished; a file replaced since then is left out and is not recorded again. The identity stays
// with this list for the shelf in this process. It is not part of the page's state.
function completedIncoming(transfers, opt) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(transfers)) return out;
  const pins = opt && opt.pins;
  const parent = pins || opt?.receivedDir == null ? undefined : chosenParent(opt.receivedDir);
  const n = Math.min(transfers.length, KEEP);
  let looked = 0;
  for (let i = 0; i < n && out.length < SAVED_CAP; i++) {
    const tr = transfers[i];
    if (!tr || typeof tr !== 'object' || tr.dir !== 'in' || tr.state !== 'done' || !Array.isArray(tr.saved)) continue;
    const at = typeof tr.at === 'number' && Number.isFinite(tr.at) && tr.at > 0 ? tr.at : 0;
    const pin = pins && pins.get(tr.id);
    if (pins && !pin) continue;
    const max = Math.min(tr.saved.length, REVEAL_MAX);
    for (let index = 0; index < max && out.length < SAVED_CAP; index++) {
      if (++looked > SCAN_BUDGET) return out;
      const file = tr.saved[index];
      if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
      const row = pin ? pin[index] : entryNow(file, parent);
      if (!stillThere(row)) continue;
      if (seen.has(row.canonical)) continue;
      seen.add(row.canonical);
      out.push({ path: row.canonical, at, identity: row.identity });
    }
  }
  return out;
}

// Which saved path a reveal may open. The caller names a transfer id and, for a later file, its
// index. A path on the argument is ignored: it is not one this history stored.
function revealSaved(transfers, arg) {
  const id = typeof arg === 'string' ? arg : (arg && typeof arg === 'object' && typeof arg.id === 'string' ? arg.id : '');
  let index = 0;
  if (arg && typeof arg === 'object') {
    if (arg.index == null) index = 0;
    else if (Number.isInteger(arg.index)) index = arg.index;
    else index = -1;
  }
  if (!id || index < 0 || index > 999) return null;
  const tr = (Array.isArray(transfers) ? transfers : []).find((item) => item && item.id === id);
  if (!tr || tr.dir !== 'in' || tr.state === 'waiting' || tr.state === 'running' || !Array.isArray(tr.saved) || index >= tr.saved.length) return null;
  const file = tr.saved[index];
  if (typeof file !== 'string' || !file) return null;
  return { id, index, file };
}

function openReceipt(transfers, arg, reveal, opt) {
  const found = revealSaved(transfers, arg);
  if (!found || typeof reveal !== 'function') return false;
  const pins = opt && opt.pins;
  if (pins) {
    if (!pins.has(found.id)) return false;
    const row = pins.get(found.id)[found.index];
    if (!stillThere(row)) return false;
    reveal(row.canonical);
    return true;
  }
  const parent = opt?.receivedDir == null ? undefined : chosenParent(opt.receivedDir);
  const live = entryNow(found.file, parent);
  if (!live) return false;
  reveal(live.canonical);
  return true;
}

// macOS: what arrives is marked as downloaded (com.apple.quarantine), as a browser's downloads and
// AirDrop's files are, so Gatekeeper checks an app or a script from another device before its first
// run. On the file while it is still on its way, and on each folder made for a transfer.
function quarantine(file) {
  return new Promise((resolve, reject) => {
    const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};TwinDesk;`;
    execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], { timeout: 5000 }, (e) => (e ? reject(e) : resolve()));
  });
}

function startLocalSend(o) {
  const t = o.t || ((s, v) => String(s).replace(/\{(\w+)\}/g, (_m, k) => (v && k in v ? v[k] : `{${k}}`)));
  const cfg = () => {
    const s = o.settings();
    if (!s.localsend || typeof s.localsend !== 'object') s.localsend = { on: false };
    return s.localsend;
  };
  let node = null;
  let starting = false;
  let adding = false;
  let addError = '';
  const transfers = []; // newest first
  const sources = new Map(); // a transfer of ours -> what it was, for another try with a PIN
  const asking = new Map(); // offer id -> AbortController of its question
  const pins = new Map(); // transfer id -> identity of each saved entry, taken once when it finished

  // The chosen folder, canonicalized, and the file or folder that was actually stored. Taken once:
  // a later file at that path is not this receipt.
  function bind(tr, saveDir) {
    if (!tr || typeof tr.id !== 'string' || pins.has(tr.id)) return;
    if (tr.dir !== 'in' || tr.state === 'waiting' || tr.state === 'running') return;
    const saved = Array.isArray(tr.saved) ? tr.saved : [];
    const parent = chosenParent(saveDir);
    const n = Math.min(saved.length, REVEAL_MAX);
    const rows = new Array(n);
    for (let index = 0; index < n; index++) rows[index] = readUnder(parent, saved[index]);
    pins.set(tr.id, rows);
  }

  const push = () => { try { o.pushState(); } catch { /* no window */ } };
  const what = (tr) => (tr.names.length === 1 && tr.files === 1 ? tr.names[0] : t(tr.files === 1 ? '{count} file' : '{count} files', { count: tr.files }));

  function record(tr, saveDir) {
    const i = transfers.findIndex((x) => x.id === tr.id);
    if (i >= 0) transfers[i] = tr;
    else transfers.unshift(tr);
    while (transfers.length > KEEP) {
      const old = transfers.findLastIndex((x) => x.state !== 'waiting' && x.state !== 'running');
      if (old < 0) break;
      sources.delete(transfers[old].id);
      pins.delete(transfers[old].id);
      transfers.splice(old, 1);
    }
    if (transfers.some((item) => item.id === tr.id)) bind(tr, saveDir);
  }

  function make() {
    const n = new LocalSend({ dir: o.dir, alias: o.name, saveDir: o.receivedDir, stored: o.stored, mark: o.mark || (process.platform === 'darwin' ? quarantine : undefined), log: o.log || (() => {}), ...(o.core || {}) });
    n.on('change', push);
    n.on('offer', (offer) => {
      push();
      if (!o.ask) return;
      const ac = new AbortController();
      asking.set(offer.id, ac);
      Promise.resolve().then(() => o.ask(offer, ac.signal)).then((yes) => { if (typeof yes === 'boolean') n.answer(offer.id, yes); }, () => {});
    });
    n.on('offerEnd', (e) => {
      const ac = asking.get(e.id);
      asking.delete(e.id);
      if (ac) ac.abort(); // answered on the page, or it ran out: the question goes away
      push();
    });
    n.on('transfer', (tr, saveDir) => {
      const before = transfers.find((x) => x.id === tr.id);
      record(tr, saveDir);
      if (o.say && tr.dir === 'in' && before && before.state === 'running' && tr.state !== 'running') {
        const reveal = () => openReceipt(transfers, tr.id, o.reveal, { pins });
        if (tr.state === 'done') o.say(t('Received from {name}', { name: tr.peer.alias }), what(tr), reveal);
        else if (tr.arrived) o.say(t('Stopped: {count} of {total} files from {name} arrived', { count: tr.arrived, total: tr.files, name: tr.peer.alias }), '', reveal);
      }
      if (o.say && tr.dir === 'out' && tr.state === 'done') o.say(t('Sent to {name}', { name: tr.peer.alias }), what(tr));
      push();
    });
    return n;
  }

  function apply() {
    const on = cfg().on && (!o.enabled || o.enabled());
    if (on && !node) {
      const n = make();
      node = n;
      starting = true;
      // Turned off, or off and on again, before it had started: that is another node's "starting" now.
      n.start().catch((e) => { if (o.log) o.log(`[localsend] ${e.message}`); }).then(() => { if (node === n) starting = false; push(); });
    } else if (!on && node) {
      const n = node;
      node = null;
      starting = false;
      n.stop();
      n.removeAllListeners();
      for (const ac of asking.values()) ac.abort();
      asking.clear();
      for (const tr of transfers) if (tr.state === 'waiting' || tr.state === 'running') tr.state = 'cancelled';
      addError = '';
    }
    push();
  }

  function send(id, paths, opts) {
    if (!node) return;
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).slice(0, 5000);
    const peer = node.peers().find((p) => p.id === id);
    try {
      const tid = node.send(id, list, opts);
      sources.set(tid, { id, paths: list });
    } catch (e) {
      // Shown where the transfers are: nothing was there to send, or the device is gone or not one we speak with.
      record({ id: `x-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dir: 'out', peer: { id, alias: peer ? peer.alias : '', ip: peer ? peer.ip : '' }, names: [], files: 0, total: 0, done: 0, state: 'failed', error: e.code || 'failed', at: Date.now() });
      push();
    }
  }

  const view = () => {
    const st = node ? node.status() : { running: false, receiving: false, port: PORT, fingerprint: '', error: '' };
    return {
      cfg: { on: !!cfg().on },
      running: st.running && !starting, starting, receiving: st.receiving, port: st.port, error: st.error,
      name: String(o.name() || ''), folder: String(o.receivedDir() || ''),
      fingerprint: st.fingerprint,
      peers: node ? node.peers().map((p) => ({
        id: p.id, alias: p.alias, ip: p.ip, port: p.port, deviceType: p.deviceType, deviceModel: p.deviceModel,
        verified: p.verified, supported: p.supported, why: p.why, fingerprint: p.protocol === 'https' ? p.fingerprint : '',
      })) : [],
      offers: node ? node.offers() : [],
      transfers: transfers.map((tr) => ({ ...tr, pin: tr.error === 'pin' && sources.has(tr.id) })),
      adding, addError,
    };
  };

  const actions = {
    lsSet(patch) {
      if (!patch || typeof patch.on !== 'boolean') return;
      cfg().on = patch.on;
      o.save();
      apply();
    },
    lsRefresh() { if (node) node.announce(); },
    // "192.168.1.20" or "192.168.1.20:53317": a device the network doesn't let us find.
    lsAdd(text) {
      if (!node || adding) return;
      const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\s*$/.exec(String(text || ''));
      const port = m && m[2] ? Number(m[2]) : PORT;
      if (!m || port < 1 || port > 65535) { addError = 'address'; return push(); }
      adding = true;
      addError = '';
      push();
      const n = node;
      n.probe(m[1], port).then(() => '', (e) => e.code || 'unreachable').then((code) => {
        adding = false;
        if (n === node) addError = code;
        push();
      });
    },
    lsChoose(id) {
      if (!node || !o.choose) return;
      Promise.resolve(o.choose()).then((paths) => { if (paths && paths.length) send(id, paths); }, () => {});
    },
    lsSend(arg) { if (arg && typeof arg.id === 'string') send(arg.id, arg.paths); },
    // The device asked for its PIN: the same files again, with it.
    lsPin(arg) {
      const src = arg && sources.get(arg.id);
      if (!src || typeof arg.pin !== 'string' || !arg.pin || arg.pin.length > 64) return;
      sources.delete(arg.id);
      const i = transfers.findIndex((x) => x.id === arg.id);
      if (i >= 0) transfers.splice(i, 1);
      send(src.id, src.paths, { pin: arg.pin });
    },
    lsAnswer(arg) { if (node && arg && typeof arg.id === 'string') node.answer(arg.id, arg.accept === true); },
    lsCancel(id) { if (node && typeof id === 'string') node.cancel(id); },
    lsClear() {
      for (let i = transfers.length - 1; i >= 0; i--) {
        if (transfers[i].state !== 'waiting' && transfers[i].state !== 'running') {
          sources.delete(transfers[i].id);
          pins.delete(transfers[i].id);
          transfers.splice(i, 1);
        }
      }
      push();
    },
    lsReveal(arg) { openReceipt(transfers, arg, o.reveal, { pins }); },
  };

  apply();
  return {
    view, actions, apply,
    shutdown: () => { if (node) { node.stop(); node = null; } },
    get node() { return node; },
    get receipts() { return completedIncoming(transfers, { pins }); },
  };
}

module.exports = { startLocalSend, quarantine, completedIncoming, openReceipt, sameIdentity, ACTIONS: ['lsSet', 'lsRefresh', 'lsAdd', 'lsChoose', 'lsSend', 'lsPin', 'lsAnswer', 'lsCancel', 'lsClear', 'lsReveal'] };
