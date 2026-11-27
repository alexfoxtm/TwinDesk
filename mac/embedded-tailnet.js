// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const P = require('../shared/protocol.js');
const { EmbeddedMedia } = require('./embedded-media.js');
const { PATH: MIRROR_PATH } = require('../shared/nativescreen.js');
const { EMBEDDED_FOLDER } = require('../shared/foldershare.js');

const local = '127.0.0.1';
const helperPath = path.join(__dirname, '..', 'mac-helper', '.build', 'release', 'twindesk-network');
const validNode = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

class EmbeddedTailnet {
  constructor({ server, dir, identity, openLogin, onChange, remember, enabled }) {
    this.server = server;
    this.dir = path.join(dir, 'twindesk-embedded-network');
    this.identity = identity;
    this.openLogin = openLogin;
    this.onChange = onChange;
    this.remember = remember;
    this.enabled = enabled === true;
    this.available = fs.existsSync(helperPath);
    this.state = 'stopped';
    this.epoch = 0;
    this.next = 0;
    this.pending = new Map();
    this.sockets = new Map();
    this.proofs = new Map();
    this.media = new EmbeddedMedia(server);
    server.on('client', (ctx) => { void this.media.start(ctx); });
    server.on('closed', (ctx) => this.media.close(ctx));
    server.on('message', (msg, ctx, ws) => {
      if (msg.t === P.T.ADB_STATE) this.media.adbState(ctx, ws, msg);
    });
    server.embeddedAdbGrant = (ws) => this.media.adbGrant(ws);
    server.retireEmbeddedMedia = (ctx) => this.media.close(ctx);
    this.server.embeddedPeer = (socket) => {
      if (socket.localPort !== this.backend?.address()?.port || socket.remoteAddress !== local) return null;
      return this.sockets.get(socket.remotePort)?.peer || null;
    };
  }

  view() {
    return { available: this.available, enabled: this.enabled, state: this.state, ready: !!this.generation };
  }

  _notice() {
    this.onChange();
  }

  _launch() {
    const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (child !== this.child) return;
      let value;
      try { value = JSON.parse(line); } catch { return; }
      const request = this.pending.get(value?.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(value.id);
      request.resolve(value.reply);
    });
    const gone = () => {
      lines.close();
      if (child !== this.child) return;
      this.child = null;
      this._reset();
      this.state = 'error';
      this._notice();
    };
    child.on('error', gone);
    child.on('exit', gone);
    child.stdin.on('error', gone);
  }

  _request(op, params = {}) {
    if (!this.child || this.pending.size >= 40) return Promise.resolve(null);
    const id = ++this.next;
    const child = this.child;
    return new Promise((resolve) => {
      const complete = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        resolve(null);
      };
      const timer = setTimeout(complete, 8000);
      timer.unref();
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, request: { op, ...params } }) + '\n', (err) => { if (err) complete(); });
    });
  }

  _closeBackend() {
    this.media.closeAll();
    this.generation = '';
    this.selfID = '';
    this.proofs.clear();
    const backend = this.backend;
    this.backend = null;
    if (backend) backend.close();
    for (const entry of this.sockets.values()) entry.socket.destroy();
    this.sockets.clear();
  }

  _reset() {
    this.epoch++;
    clearInterval(this.timer);
    this.timer = null;
    this.refreshing = null;
    this.wantLogin = false;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve(null);
    }
    this.pending.clear();
    this._closeBackend();
  }

  async _serve(epoch) {
    const tls = https.createServer({ ...this.server.tls, handshakeTimeout: 5000 }, (req, res) => {
      if (epoch === this.epoch && req.url?.startsWith(EMBEDDED_FOLDER + '/')) {
        res.setHeader('Connection', 'close');
        return this.media.folder(req, res, this.server.embeddedPeer(req.socket));
      }
      if (epoch === this.epoch && req.url === MIRROR_PATH) {
        res.setHeader('Connection', 'close');
        return this.media.mirror(req, res, this.server.embeddedPeer(req.socket));
      }
      res.writeHead(404).end();
    });
    tls.on('upgrade', (req, socket, head) => {
      // Both control and TURN children enter through the same witnessed, pinned listener.
      const peer = this.server.embeddedPeer(socket);
      if (epoch !== this.epoch || !peer) return socket.destroy();
      if (req.url === '/embedded/turn') return this.media.upgrade(req, socket, head, peer);
      if (req.url === '/embedded/dav') return this.media.upgradeDav(req, socket, head, peer);
      if (req.url === '/embedded/adb') return this.media.upgradeAdb(req, socket, head, peer);
      if (req.url !== '/' && (req.url !== P.LOCK_PATH || !this.server.lockview)) return socket.destroy();
      this.server.wss.handleUpgrade(req, socket, head, (ws) => this.server.wss.emit('connection', ws, req));
    });
    const backend = net.createServer({ pauseOnConnect: true }, async (socket) => {
      const sourcePort = socket.remotePort;
      if (!this.generation || socket.remoteAddress !== local || !sourcePort) return socket.destroy();
      const entry = { socket, peer: null };
      socket.on('error', () => {});
      socket.on('close', () => { if (this.sockets.get(sourcePort) === entry) this.sockets.delete(sourcePort); });
      this.sockets.set(sourcePort, entry);
      const port = socket.localPort;
      const generation = this.generation;
      const proof = await this._request('claimIngress', { port, sourcePort, generation });
      if (epoch !== this.epoch || socket.destroyed || this.sockets.get(sourcePort) !== entry ||
          this.generation !== generation || !proof?.ok || !validNode(proof.peer)) return socket.destroy();
      entry.peer = proof.peer;
      tls.emit('connection', socket);
      socket.resume();
    });
    backend.maxConnections = 40;
    await new Promise((resolve) => {
      backend.once('error', resolve);
      backend.listen(0, local, resolve);
    });
    if (epoch !== this.epoch || !backend.address()) {
      backend.close();
      return false;
    }
    this.backend = backend;
    const result = await this._request('serve', { port: backend.address().port });
    if (epoch !== this.epoch) return false;
    if (!result?.ok || typeof result.generation !== 'string' || !result.generation) {
      this._closeBackend();
      return false;
    }
    this.generation = result.generation;
    return true;
  }

  async _refresh(epoch) {
    if (epoch !== this.epoch || this.refreshing) return;
    const refresh = {};
    this.refreshing = refresh;
    const oldState = this.state;
    const wasReady = !!this.generation;
    try {
      const status = await this._request('status');
      if (epoch !== this.epoch) return;
      this.state = status?.ok ? status.state : 'error';
      if (this.state === 'running' && validNode(status?.selfID)) {
        if (this.selfID && this.selfID !== status.selfID) this._closeBackend();
        if (!this.backend && !await this._serve(epoch)) {
          if (epoch === this.epoch) this.state = 'error';
          return;
        }
        if (epoch !== this.epoch) return;
        this.selfID = status.selfID;
        this.wantLogin = false;
      } else {
        this._closeBackend();
        if (this.wantLogin && status?.authURL) {
          try {
            const url = new URL(status.authURL);
            if (url.protocol === 'https:' && !url.username && !url.password &&
                ['login.tailscale.com', 'controlplane.tailscale.com'].includes(url.host)) {
              this.wantLogin = false;
              void Promise.resolve(this.openLogin(url.href)).catch(() => {});
            }
          } catch { /* invalid login response */ }
        }
      }
    } finally {
      if (this.refreshing === refresh) this.refreshing = null;
      if (epoch === this.epoch && (oldState !== this.state || wasReady !== !!this.generation)) this._notice();
    }
  }

  async start(interactive = false) {
    if (!this.available || this.stopping) return this.view();
    if (!this.child) this._launch();
    const epoch = this.epoch;
    if (interactive) {
      this.enabled = true;
      this.remember(true);
      this.wantLogin = true;
    }
    this.state = 'starting';
    this._notice();
    const reply = await this._request('start', { dir: this.dir, role: 'mac', displayName: this.identity.macName });
    if (epoch !== this.epoch) return this.view();
    if (!reply?.ok) {
      this.state = 'error';
      this._notice();
      return this.view();
    }
    if (interactive) await this._request('login');
    if (epoch !== this.epoch) return this.view();
    if (!this.timer) {
      this.timer = setInterval(() => { void this._refresh(epoch); }, 1200);
      this.timer.unref();
    }
    await this._refresh(epoch);
    return this.view();
  }

  async stop(logout = false) {
    if (this.stopping) return this.view();
    this.stopping = true;
    this._reset();
    if (logout) {
      this.enabled = false;
      this.remember(false);
      if (!this.child && this.available) this._launch();
    }
    const result = await this._request(logout ? 'logout' : 'stop', logout ? { dir: this.dir, role: 'mac' } : {});
    this.close();
    this.state = logout && !result?.ok ? 'error' : 'stopped';
    this.stopping = false;
    this._notice();
    return { ...this.view(), ...(result?.warning ? { warning: result.warning } : {}) };
  }

  close() {
    this._reset();
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      const force = setTimeout(() => { if (child.exitCode == null) child.kill(); }, 3000);
      force.unref();
      child.once('exit', () => clearTimeout(force));
    }
  }

  pairingQr() {
    if (!this.generation || !this.selfID) return { url: '', why: 'Start embedded Tailscale first' };
    const now = Date.now();
    for (const [key, until] of this.proofs) if (until <= now) this.proofs.delete(key);
    const key = this.proofs.keys().next().value || crypto.randomBytes(16).toString('hex');
    const until = this.proofs.get(key) || now + 10 * 60000;
    this.proofs.set(key, until);
    const { macId, macName, fp } = this.identity;
    const query = new URLSearchParams({ ts: this.selfID, fp: P.normFingerprint(fp), id: macId, n: macName, k: key, p: String(P.PORT) });
    return { url: 'twindesk://pair?' + query.toString(), until };
  }

  knows(key) {
    return !!this.generation && (this.proofs.get(key) || 0) > Date.now();
  }

  consume(key) {
    this.proofs.delete(key);
  }
}

module.exports = { EmbeddedTailnet };
