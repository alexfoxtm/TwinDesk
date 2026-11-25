// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const binary = path.join(__dirname, '..', 'mac-helper', '.build', 'release', 'twindesk-gmessages');
const states = new Set(['disconnected', 'signing-in', 'connecting', 'offline', 'keychain-error', 'helper-error', 'connection-error']);
const commands = new Set(['history', 'earlier', 'send', 'read', 'typing', 'photo']);
const imageURL = /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const atOf = (row) => Number.isSafeInteger(row?.at) ? row.at : 0;

// Wire format shared with Android MessageChat.fingerprint.
function fingerprints(addrs, me, text) {
  if (addrs?.length !== 1 || typeof addrs[0] !== 'string' || typeof me !== 'boolean' || typeof text !== 'string') return [];
  const address = addrs[0].trim();
  if (!/^\+?[0-9() .-]+$/.test(address)) return [];
  const digits = address.replace(/\D/g, '');
  const body = text.replace(/\r\n/g, '\n').trim();
  if (!digits.length || digits.length > 15 || !body) return [];
  const hash = createHash('sha256');
  for (const field of [(address.startsWith('+') ? '+' : '') + digits, String(me), body]) {
    hash.update(Buffer.byteLength(field) + ':').update(field);
  }
  return [hash.digest('hex')];
}

class GoogleMessages {
  constructor({ current, enabled, change, launch = spawn }) {
    Object.assign(this, { current, enabled, change, launch });
    this.owner = '';
    this.state = 'disconnected';
    this.rows = new Map();
    this.pending = new Map();
    this.ref = 0;
    this.retiring = Promise.resolve();
  }

  clear() {
    this.rows.clear();
    this.history = null;
    this.emoji = '';
    clearTimeout(this.typingTimer);
    for (const req of this.pending.values()) req.finish(false);
    this.pending.clear();
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.clear();
    this.state = 'disconnected';
    if (child) {
      this.retiring = child.done;
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
      child.done.then(() => clearTimeout(timer));
    }
  }

  sync() {
    const owner = this.closed ? '' : this.current() || '';
    const enabled = !!(owner && this.enabled());
    if (owner === this.owner && enabled === this.active) return false;
    this.stop();
    this.owner = owner;
    this.active = enabled;
    if (enabled) this.start(owner);
    return true;
  }

  start(owner, idle = false) {
    if (this.starting) return this.starting.then(() =>
      owner === this.owner ? this.start(owner, idle) : null);
    const launch = async () => {
      await this.retiring;
      if (this.closed || owner !== this.owner || this.current() !== owner || (!idle && !this.active)) return null;
      if (this.child) return this.child;
      const child = this.launch(binary, [owner, ...(idle ? ['--idle'] : [])], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.child = child;
      child.done = new Promise((resolve) => child.once('close', resolve));
      child.stdin.on('error', () => {});
      child.on('error', () => {});
      child.done.then(() => {
        if (this.child !== child) return;
        this.child = null;
        this.clear();
        this.state = 'helper-error';
        this.change();
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.child !== child || this.current() !== owner || line.length > 10_000_000) return;
        let evt;
        try { evt = JSON.parse(line); } catch { return; }
        this.event(evt);
      });
      return child;
    };
    this.starting = launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  event(evt) {
    if (evt?.type === 'state' && states.has(evt.state)) {
      // A transient outage invalidates every actionable conversation and restores the phone path.
      if (evt.state !== 'connecting' || this.state === 'connected') this.clear();
      this.state = evt.state;
      if (evt.wipe) {
        this.wiped?.(evt.state === 'disconnected');
        this.wiped = null;
      }
    } else if (evt?.type === 'emoji' && typeof evt.emoji === 'string' && evt.emoji.length <= 16) {
      this.state = 'confirm';
      this.emoji = evt.emoji;
    } else if (evt?.type === 'conversations' && this.active && Array.isArray(evt.items)) {
      this.state = 'connected';
      this.emoji = '';
      this.rows = new Map(evt.items.filter((c) => typeof c?.id === 'string').map((c) => [c.id, c]));
      if (this.history && !this.rows.has(this.history.chat)) this.history = null;
    } else if (evt?.type === 'result') {
      this.pending.get(evt.ref)?.finish(evt.ok === true);
      return;
    } else if (this.state === 'connected' && evt?.type === 'message' && this.rows.has(evt.chat) && evt.item?.id) {
      const m = evt.item;
      const row = this.rows.get(evt.chat);
      if (atOf(m) >= atOf(row)) {
        this.rows.set(evt.chat, { ...row, at: m.at, snippet: m.text, snippetMe: m.me });
      }
      if (this.history?.chat === evt.chat) {
        this.history = { ...this.history, items: this.merge(this.history.items, [m]) };
      }
    } else if (this.state === 'connected' && this.history?.chat === evt?.chat) {
      const h = this.history;
      if (evt.type === 'photo' && typeof evt.data === 'string' && imageURL.test(evt.data)) {
        this.pending.get(evt.ref)?.finish(evt.data);
        return;
      }
      if (evt.type === 'history' && Array.isArray(evt.items)) {
        this.history = { ...h, items: this.merge(h.items, evt.items), more: !!evt.more, loaded: true };
      } else if (evt.type === 'typing') {
        clearTimeout(this.typingTimer);
        this.history = { ...h, typing: !!evt.typing };
        if (evt.typing) {
          this.typingTimer = setTimeout(() => {
            if (this.history?.chat !== h.chat || this.child !== h.child) return;
            this.history = { ...this.history, typing: false };
            this.change();
          }, 15000).unref();
        }
      } else return;
    } else return;
    this.change();
  }

  merge(items, incoming) {
    const byId = new Map(items.map((m) => [m.id, m]));
    for (const m of incoming) if (m?.id && atOf(m)) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.at - b.at);
  }

  view() {
    this.sync();
    if (!this.owner) return null;
    return {
      owner: this.owner, state: this.state, enabled: this.active, emoji: this.emoji,
      rows: [...this.rows.values()].sort((a, b) => atOf(b) - atOf(a)).map((row) => {
        const recent = this.history?.chat === row.id ? this.history.items.slice(-50) : [];
        return {
          ...row,
          fingerprints: (row.group ? [] : [{ at: row.at, text: row.snippet, me: row.snippetMe }, ...recent])
            .map((m) => ({ at: m.at, matches: fingerprints(row.addrs, m.me, m.text) }))
            .filter((m) => m.matches.length),
        };
      }),
      history: this.history ? {
        chat: this.history.chat, items: this.history.items, loaded: this.history.loaded,
        more: this.history.more, typing: this.history.typing,
      } : null,
    };
  }

  async action(arg) {
    this.sync();
    const owner = this.owner;
    if (!owner || arg?.owner !== owner) return false;
    if (arg.op === 'disconnect') {
      if (this.wiped) return false;
      const child = this.child || await this.start(owner, true);
      if (!child || this.wiped || this.current() !== owner || owner !== this.owner || child !== this.child) return false;
      this.clear();
      this.state = 'disconnected';
      this.change();
      return new Promise((resolve) => {
        const finish = (ok) => {
          clearTimeout(timer);
          if (this.wiped === finish) this.wiped = null;
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 5000);
        this.wiped = finish;
        child.stdin.write(JSON.stringify({ op: 'disconnect' }) + '\n');
        child.done.then(() => finish(false));
      });
    }
    if (!this.active) return false;
    if (arg.op === 'connect') {
      if (this.wiped) return false;
      if (this.state === 'connected' || this.state === 'confirm' || this.state === 'signing-in' || this.state === 'connecting') return false;
      const child = this.child || await this.start(owner);
      if (!child || this.current() !== owner || owner !== this.owner || child !== this.child) return false;
      child.stdin.write(JSON.stringify({ op: 'connect' }) + '\n');
      return true;
    }
    if (this.wiped || !commands.has(arg.op)) return false;
    const child = this.child;
    const available = child && child.exitCode == null && child.signalCode == null && child.stdin.writable;
    const row = this.rows.get(arg.chat);
    if (!available || this.state !== 'connected' || !row) {
      // The renderer may use its independently verified carrier route. This result
      // must only be returned before the helper could have received a send command.
      if (arg.op === 'send' && arg.allowCarrier === true &&
        ((this.state === 'connected' && row?.reply === true) ||
         this.state === 'offline' || this.state === 'helper-error')) return 'not-dispatched';
      return false;
    }
    const { op, chat } = arg;
    if (this.pending.size >= 16) return false;
    if (op === 'history') {
      clearTimeout(this.typingTimer);
      this.history = { chat, child, items: [], more: false, typing: false };
    } else if (this.history?.chat !== chat) return false;
    const message = typeof arg.message === 'string' ? arg.message.slice(0, 200) : '';
    const part = Number.isInteger(arg.part) ? arg.part : 0;
    const text = typeof arg.text === 'string' ? arg.text.trim().slice(0, 5000) : '';
    const image = typeof arg.image === 'string' && arg.image.length <= 6000000 && arg.image.startsWith('data:image/jpeg;') && imageURL.test(arg.image) ? arg.image : '';
    if (op === 'send' && (!row.reply || (!text && !image) || (arg.image && !image))) return false;
    const ref = ++this.ref;
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        this.pending.delete(ref);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 38000);
      this.pending.set(ref, { finish });
      const deadline = Date.now() + 35000;
      child.stdin.write(JSON.stringify({ op, chat, message, part, text, image, ref, deadline }) + '\n', (err) => {
        if (err) finish(false);
      });
    });
  }
}

function setupGoogleMessages({ app, ipcMain, window, current, enabled, change }) {
  const gm = new GoogleMessages({ current, enabled, change });
  ipcMain.handle('googleMessages', (event, arg) => {
    const win = window();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
    return gm.action(arg);
  });
  app.on('will-quit', () => { gm.closed = true; gm.stop(); });
  return gm;
}

module.exports = { GoogleMessages, setupGoogleMessages, fingerprints };
