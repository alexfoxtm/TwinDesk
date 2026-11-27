// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { randomBytes } = require('node:crypto');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { WebSocketServer, createWebSocketStream } = require('ws');
const { TurnThread } = require('../shared/turn.js');
const { NativeScreen } = require('../shared/nativescreen.js');
const { T, OS } = require('../shared/protocol.js');
const { embeddedFolder } = require('../shared/foldershare.js');

const PORT_HOST = '127.0.0.1';
const MAX_FRAME = 32768;
const MAX_SESSIONS = 8;
const MAX_CHILDREN = 6;
const signaling = (type) => typeof type === 'string' && (type === 'screen.policy' || type === 'screen.ctl' ||
  type === T.PHONE_MIRROR_WANT ||
  type.startsWith('rtc.') || type.startsWith('rtc2.') ||
  ['audio.offer', 'audio.answer', 'audio.ice', 'audio.policy'].includes(type));

function embeddedMediaAllowed(ctx, type) {
  return !ctx.embeddedPeer || !signaling(type) || ctx.embeddedMediaReady?.() === true;
}

class EmbeddedMedia {
  constructor(server) {
    this.server = server;
    this.sessions = new Map();
    this.adbGrants = new WeakMap();
    this.adbTunnels = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  }

  _owns(ctx, owner) {
    const current = this.server.clients ? this.server.clients.get(ctx.deviceId) : this.server.current;
    return ctx === current && ctx.authed === true && !ctx.released &&
      !ctx.expectedClose && ctx.ws === owner && !!owner && !owner.detached && !owner.released && owner.readyState === owner.OPEN;
  }

  _current(session) {
    return this.sessions.get(session.ctx) === session && this._owns(session.ctx, session.owner);
  }

  adbState(ctx, owner, msg) {
    if (!ctx.embeddedPeer || ctx.os !== OS.ANDROID || !this._owns(ctx, owner)) return;
    const port = msg.embeddedPort;
    const granted = msg.wifi === true && msg.devOptions !== false && msg.net !== false &&
      Number.isInteger(port) && port > 0 && port < 65536 && port !== 5555;
    const old = this.adbGrants.get(ctx);
    if (granted && old?.owner === owner && old.port === port && old.peer === ctx.embeddedPeer) return;
    this.adbGrants.delete(ctx);
    if (granted) {
      const grant = { ctx, owner, peer: ctx.embeddedPeer, port };
      grant.open = (current, onClose) => this._openAdb(grant, current, onClose);
      this.adbGrants.set(ctx, grant);
    }
    this.adbTunnels.get(ctx)?.close();
  }

  adbGrant(owner) {
    const ctx = owner?.ctx;
    const grant = this.adbGrants.get(ctx);
    return grant && grant.owner === owner && grant.peer === ctx.embeddedPeer && this._owns(ctx, owner) ? grant : null;
  }

  _openAdb(grant, current, onClose) {
    const { ctx, owner, port } = grant;
    if (this.adbGrant(owner) !== grant || !current() || this.adbTunnels.has(ctx) || this.adbTunnels.size >= MAX_SESSIONS) return null;
    let resolvePort;
    const ready = new Promise((resolve) => { resolvePort = resolve; });
    const tunnel = { grant, ready, close, attached: false, key: '', current: live };
    let tcp, child, timer;
    const listener = net.createServer({ pauseOnConnect: true }, (socket) => {
      socket.on('error', () => {});
      if (!live() || tcp) return socket.destroy();
      tcp = socket;
      tcp.on('error', close);
      tcp.setNoDelay(true);
      tcp.once('close', close);
      tunnel.key = randomBytes(32).toString('hex');
      timer = setTimeout(close, 9000);
      timer.unref();
      const msg = { t: 'embedded.adb.open', key: tunnel.key, port };
      try {
        if ((this.server.socketFor && this.server.socketFor(ctx, msg) !== owner) || !this.server.send(ctx, msg)) close();
      } catch { close(); }
    });
    const media = this;
    function live() {
      return media.adbTunnels.get(ctx) === tunnel && media.adbGrant(owner) === grant && current();
    }
    function close() {
      if (media.adbTunnels.get(ctx) !== tunnel) return;
      media.adbTunnels.delete(ctx);
      tunnel.key = '';
      tunnel.attached = false;
      clearTimeout(timer);
      listener.close();
      tcp?.destroy();
      child?.destroy();
      resolvePort(null);
      onClose();
    }
    tunnel.attach = (ws) => {
      tunnel.key = '';
      clearTimeout(timer);
      child = framedChild(ws, live);
      child.once('close', close);
      tunnel.attached = true;
      tcp.pipe(child).pipe(tcp);
    };
    this.adbTunnels.set(ctx, tunnel);
    listener.on('error', close);
    listener.listen(0, PORT_HOST, () => {
      if (!live()) return close();
      resolvePort(listener.address().port);
    });
    return tunnel;
  }

  upgradeAdb(req, socket, head, peer) {
    const key = req.headers['x-twindesk-adb'];
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return socket.destroy();
    const tunnel = [...this.adbTunnels.values()].find((entry) => entry.key === key && entry.grant.peer === peer);
    if (!tunnel?.current()) return socket.destroy();
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (tunnel.key !== key || !tunnel.current()) return ws.terminate();
      tunnel.attach(ws);
    });
  }
  async start(ctx) {
    if (!ctx.embeddedPeer || !ctx.embeddedMediaWanted || this.sessions.size >= MAX_SESSIONS ||
        this.sessions.has(ctx)) return;
    const owner = ctx.ws;
    const turn = new TurnThread({ port: 0, allocationsOnly: true });
    const session = { ctx, owner, turn, key: randomBytes(32).toString('hex'), children: new Set(), pendingDav: new Map() };
    this.sessions.set(ctx, session);
    owner.once('close', () => this.close(ctx));
    try {
      await turn.start();
      if (!this._current(session)) return this.close(ctx);
      turn.worker.once('exit', () => this.close(ctx));
      ctx.embeddedIce = turn.ice();
      ctx.embeddedMediaReady = () => this._current(session);
      ctx.openEmbeddedDav = (share, callback) => this._openDav(session, share, callback);
      if (!this.server.send(ctx, { t: 'embedded.media', key: session.key })) this.close(ctx);
      else this.server.lockviewRefresh?.();
    } catch {
      this.close(ctx);
    }
  }

  upgrade(req, socket, head, peer) {
    const key = req.headers['x-twindesk-media'];
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return socket.destroy();
    const session = [...this.sessions.values()].find((s) => s.ctx.embeddedPeer === peer && s.key === key);
    if (!session || !session.ctx.embeddedMediaReady?.() || session.children.size >= MAX_CHILDREN) return socket.destroy();
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!this._current(session)) return ws.terminate();
      this._pipe(session, ws);
    });
  }

  mirror(req, res, peer) {
    if (!peer) return res.writeHead(403).end();
    return NativeScreen.request(req, res, (screen) => {
      const owner = screen.server.current?.ws;
      const session = [...this.sessions.values()].find((s) => s.owner === owner && s.ctx.embeddedPeer === peer);
      if (!session?.ctx.embeddedMediaReady?.() || session.children.size >= MAX_CHILDREN) return null;
      const close = () => req.destroy();
      session.children.add(close);
      res.once('close', () => session.children.delete(close));
      const current = () => this._current(session) && screen.server.current?.ws === owner;
      return current;
    });
  }

  folder(req, res, peer) {
    for (const session of this.sessions.values()) {
      if (session.ctx.embeddedPeer !== peer || !this._current(session) || session.children.size >= MAX_CHILDREN) continue;
      if (!embeddedFolder(session.owner, req, res, () => this._current(session))) continue;
      const close = () => req.destroy();
      session.children.add(close);
      res.once('close', () => session.children.delete(close));
      return;
    }
    res.writeHead(403).end();
  }

  _pipe(session, ws) {
    const tcp = net.connect({ host: PORT_HOST, port: session.turn.port });
    tcp.setNoDelay(true);
    const child = this._child(session, ws);
    child.pipe(tcp);
    tcp.pipe(child);
    child.once('close', () => tcp.destroy());
    tcp.once('close', () => child.destroy());
    tcp.on('error', (error) => child.destroy(error));
  }

  _child(session, ws) {
    const socket = framedChild(ws, () => this._current(session));
    const close = () => socket.destroy();
    session.children.add(close);
    socket.once('close', () => session.children.delete(close));
    return socket;
  }

  _openDav(session, share, callback) {
    if (!this._current(session) || session.children.size + session.pendingDav.size >= MAX_CHILDREN ||
        session.pendingDav.size >= 2) return callback(new Error('The phone folder is unavailable'));
    const key = randomBytes(32).toString('hex');
    const reject = () => {
      if (!session.pendingDav.delete(key)) return;
      clearTimeout(timer);
      callback(new Error('The phone folder is unavailable'));
    };
    const timer = setTimeout(reject, 9000);
    timer.unref();
    session.pendingDav.set(key, { timer, callback, reject });
    if (!this.server.send(session.ctx, { t: 'embedded.dav.open', key, share })) reject();
  }

  upgradeDav(req, socket, head, peer) {
    const key = req.headers['x-twindesk-dav'];
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return socket.destroy();
    const session = [...this.sessions.values()].find((s) => s.ctx.embeddedPeer === peer && s.pendingDav.has(key));
    if (!session || !this._current(session)) return socket.destroy();
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const request = session.pendingDav.get(key);
      if (!request || !this._current(session)) return ws.terminate();
      session.pendingDav.delete(key);
      clearTimeout(request.timer);
      request.callback(null, this._child(session, ws));
    });
  }

  close(ctx) {
    this.adbGrants.delete(ctx);
    this.adbTunnels.get(ctx)?.close();
    const session = this.sessions.get(ctx);
    if (!session) return;
    this.sessions.delete(ctx);
    ctx.embeddedMediaReady = null;
    ctx.embeddedIce = null;
    ctx.openEmbeddedDav = null;
    for (const entry of session.pendingDav.values()) entry.reject();
    for (const close of session.children) close();
    session.turn.stop();
  }

  closeAll() {
    this.adbGrants = new WeakMap();
    for (const tunnel of this.adbTunnels.values()) tunnel.close();
    for (const ctx of this.sessions.keys()) this.close(ctx);
  }
}

function framedChild(ws, current) {
  // Reject invalid frames before createWebSocketStream can hand them to the TCP stream.
  ws.on('message', (data, binary) => { if (!binary || !data.length) socket.destroy(); });
  const incoming = createWebSocketStream(ws);
  const socket = new Duplex({
    read() { incoming.resume(); },
    write(chunk, _encoding, done) {
      let offset = 0;
      function next(error) {
        if (error || offset === chunk.length) return done(error);
        if (!current()) return done(new Error('TwinDesk Network disconnected'));
        const frame = chunk.subarray(offset, offset + MAX_FRAME);
        offset += frame.length;
        ws.send(frame, next);
      }
      next();
    },
    final(done) { ws.close(); done(); },
    destroy(error, done) { ws.terminate(); incoming.destroy(); done(error); },
  });
  socket.on('error', () => {});
  incoming.on('data', (chunk) => {
    if (socket.destroyed || !current()) return socket.destroy();
    if (!socket.push(chunk)) incoming.pause();
  });
  incoming.on('error', (error) => socket.destroy(error));
  incoming.once('close', () => socket.destroy());
  return socket;
}

module.exports = { EmbeddedMedia, embeddedMediaAllowed };
