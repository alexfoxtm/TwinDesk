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
const { LocalSend, PORT } = require('./core.js');

const KEEP = 30; // transfers shown

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

  const push = () => { try { o.pushState(); } catch { /* no window */ } };
  const what = (tr) => (tr.names.length === 1 && tr.files === 1 ? tr.names[0] : t(tr.files === 1 ? '{count} file' : '{count} files', { count: tr.files }));

  function record(tr) {
    const i = transfers.findIndex((x) => x.id === tr.id);
    if (i >= 0) transfers[i] = tr;
    else transfers.unshift(tr);
    while (transfers.length > KEEP) {
      const old = transfers.findLastIndex((x) => x.state !== 'waiting' && x.state !== 'running');
      if (old < 0) break;
      sources.delete(transfers[old].id);
      transfers.splice(old, 1);
    }
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
    n.on('transfer', (tr) => {
      const before = transfers.find((x) => x.id === tr.id);
      record(tr);
      if (o.say && tr.dir === 'in' && before && before.state === 'running' && tr.state !== 'running') {
        if (tr.state === 'done') o.say(t('Received from {name}', { name: tr.peer.alias }), what(tr), () => o.reveal && tr.saved[0] && o.reveal(tr.saved[0]));
        else if (tr.arrived) o.say(t('Stopped: {count} of {total} files from {name} arrived', { count: tr.arrived, total: tr.files, name: tr.peer.alias }), '', () => o.reveal && tr.saved[0] && o.reveal(tr.saved[0]));
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
        if (transfers[i].state !== 'waiting' && transfers[i].state !== 'running') { sources.delete(transfers[i].id); transfers.splice(i, 1); }
      }
      push();
    },
    lsReveal(id) {
      const tr = transfers.find((x) => x.id === id);
      if (tr && tr.dir === 'in' && tr.saved && tr.saved[0] && o.reveal) o.reveal(tr.saved[0]);
    },
  };

  apply();
  return { view, actions, apply, shutdown: () => { if (node) { node.stop(); node = null; } }, get node() { return node; } };
}

module.exports = { startLocalSend, quarantine, ACTIONS: ['lsSet', 'lsRefresh', 'lsAdd', 'lsChoose', 'lsSend', 'lsPin', 'lsAnswer', 'lsCancel', 'lsClear', 'lsReveal'] };
