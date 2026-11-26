// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const Tailnet = require('./tailnet.js');
const observed = new WeakMap();
const closeReasons = {
  1000: 'normal', 1001: 'going-away', 1002: 'protocol-error', 1003: 'unsupported-data',
  1005: 'no-status', 1006: 'abnormal', 1007: 'invalid-data', 1008: 'policy',
  1009: 'message-too-big', 1010: 'missing-extension', 1011: 'internal-error',
  1012: 'restart', 1013: 'try-again-later', 1014: 'bad-gateway', 1015: 'tls-error',
};

function info(ws) {
  if (!observed.has(ws)) observed.set(ws, {});
  return observed.get(ws);
}

const errorCode = (error) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,35}$/.test(error.code) ? error.code : '-';

function watch(ws, socket, now) {
  const entry = info(ws);
  entry.opened = now;
  // ws converts raw TCP failures to 1006 without forwarding the original socket error.
  socket.once?.('error', (error) => { entry.socketError = errorCode(error); });
  socket.once?.('end', () => { entry.peerEnded = true; });
  ws.on('error', (error) => { entry.wsError = errorCode(error); });
}

function mark(ws, cause) {
  info(ws).cause ??= cause;
}

function log(ws, code, reason, now) {
  const entry = info(ws);
  if (entry.logged) return;
  entry.logged = true;
  const framed = Number.isInteger(code) && code !== 1005 && code !== 1006;
  const cause = entry.cause || (entry.socketError ? 'socket-error' : entry.wsError ? 'ws-error'
    : framed ? 'close-frame' : entry.peerEnded ? 'peer-fin' : 'transport');
  const via = ws.transport === 'embedded-tailnet' ? 'embedded-tailscale'
    : ws.transport === 'ble' ? 'bluetooth' : Tailnet.isTailnet(ws.address) ? 'tailscale'
    : /^(?:127\.|::1$)/.test(ws.address) ? 'loopback' : 'lan';
  const elapsed = (since) => Number.isFinite(since) ? Math.max(0, now - since) + 'ms' : '-';
  // The peer chooses the close text. Record its presence without logging arbitrary payloads.
  console.log(`[server] session socket closed code=${code ?? '-'} reason=${closeReasons[code] || '-'} peerText=${reason?.length ? 'yes' : 'no'} by=${cause} tcp=${entry.socketError || '-'} ws=${entry.wsError || '-'} via=${via} up=${elapsed(entry.opened)} rx=${elapsed(ws.lastRx)}`);
}

module.exports = { watch, mark, log };
