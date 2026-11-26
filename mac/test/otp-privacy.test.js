// TwinDesk — GPL-3.0, see LICENSE.
// Synthetic-fixture tests for Mac OTP detection across notifications/SMS/Google Messages,
// cross-source dedupe, verified Use code + secure copy fallback, local-only clipboard isolation,
// session/permission revocation, and control IPC origin checks.
// Run: node mac/test/otp-privacy.test.js
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const P = require('../../shared/protocol.js');
const { Mesh } = require('../../shared/mesh.js');
const { PhoneHub } = require('../../shared/phonehub.js');
const { GoogleMessages } = require('../google-messages.js');
const Otp = require('../../shared/otp.js');

let clipText = '';
const clipWrites = [];
const handlers = new Map();
const ipcMain = new EventEmitter();
ipcMain.handle = (channel, fn) => handlers.set(channel, fn);

let electron = {
  ipcMain,
  clipboard: {
    readText: async () => clipText,
    writeText: async (v) => { clipText = String(v); clipWrites.push(clipText); },
  },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  Notification: class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(opts) { super(); this.opts = opts; }
    show() {}
    close() { this.emit('close'); }
  },
};

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return electron;
  return load.call(this, id, ...args);
};
test.after(() => { Module._load = load; });

const { Notifs } = require('../notifs.js');
const { Clipboard } = require('../clipboard.js');
const { setupIpc } = require('../ipc.js');

function resetClip() {
  Otp.invalidateQuietCopy();
  clipText = '';
  clipWrites.length = 0;
}

test('main path: cross-source OTP detection, dedupe, verified Use code fill, and local-only quiet copy', async () => {
  resetClip();
  const sentToPeer = [];
  const helperCalls = [];
  const socket = {};
  const server = Object.assign(new EventEmitter(), {
    current: { deviceId: 'phone-1', name: 'Fixture Phone', os: P.OS.ANDROID, ws: socket },
    outbound: () => socket,
    sendToClient: (m) => { sentToPeer.push(m); return true; },
  });
  const helper = Object.assign(new EventEmitter(), {
    running: true,
    send() {},
    async request(cmd, args) {
      helperCalls.push({ cmd, args });
      if (cmd === 'otpTarget') return { valid: true, token: 'tok-1' };
      if (cmd === 'otpFill') return { filled: args.token === 'tok-1' && args.code === '482913', method: 'ax' };
      if (cmd === 'clipboardInfo') return { changeCount: 7, concealed: false };
      return {};
    },
  });
  const settings = {
    notifs: { receive: true, send: false, otpCopy: true, style: 'none', muted: [] },
    hub: { calls: false, messages: true, media: false, files: false },
    clipboard: { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 10 },
    files: {},
  };

  const notifs = new Notifs({ server, helper, getSettings: () => settings, saveSettings() {} });
  const clip = new Clipboard(server, helper, () => settings);
  const hub = new PhoneHub({ server, getSettings: () => settings, save() {} });
  hub.on('smsNew', (ev) => notifs.onSmsNew(ev, hub));
  hub.started();

  let gmChild;
  const gm = new GoogleMessages({
    current: () => (server.current && server.current.os === P.OS.ANDROID ? server.current.deviceId : ''),
    enabled: () => settings.hub.messages === true,
    change() {},
    onMessage: (ev) => notifs.onGoogleMessage(ev, gm),
    onReset: (owner) => notifs.clearOtpSource('gmessages', owner),
    launch() {
      gmChild = new EventEmitter();
      gmChild.stdin = new PassThrough();
      gmChild.stdout = new PassThrough();
      gmChild.stdin.on('finish', () => gmChild.emit('close'));
      return gmChild;
    },
  });
  gm.view();
  await gm.starting;
  gmChild.stdout.write(JSON.stringify({
    type: 'conversations',
    items: [{ id: 'chat-1', at: Date.now() - 60000, name: 'Fixture Bank', addrs: ['+12025550100'], snippet: 'Older code 111111', snippetMe: false, reply: true }],
  }) + '\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(notifs.view.otp, null, 'historical Google Messages conversations never create an OTP candidate');

  const now = Date.now();
  // 1. Notification arrives first with code 482913 -> auto-copies via quietCopy once, creates Use code offer.
  server.emit(`t:${P.T.NOTIF}`, {
    id: 'n-otp', app: 'com.google.android.apps.messaging', appName: 'Messages',
    title: 'Fixture Bank', body: 'Your verification code is 482913', at: now,
  }, server.current, socket);
  assert.ok(notifs.view.otp, 'notification creates a short-lived OTP offer');
  assert.equal(notifs.view.otp.code, '482913');
  const offerId = notifs.view.otp.id;
  assert.deepEqual(clipWrites, ['482913'], 'opt-in auto-copy writes code once');

  // 2. Clipboard sync & history must skip the quiet OTP copy.
  await clip.sendIfChanged('instant');
  assert.deepEqual(sentToPeer.filter((m) => m.t === P.T.CLIP), [], 'quiet OTP copy is never synced to peers');
  assert.equal(clip.history.length, 0, 'quiet OTP copy is never added to clipboard history');

  // 3. Same code arrives via SMS and Google Messages -> deduped cleanly (same offer ID, no second copy).
  server.emit(`t:${P.T.SMS_NEW}`, {
    t: P.T.SMS_NEW, thread: 't1', summary: { name: 'Fixture Bank' },
    msg: { id: 's1', body: 'Your verification code is 482913', at: now + 500, out: false },
  }, server.current, socket);
  gmChild.stdout.write(JSON.stringify({
    type: 'message', chat: 'chat-1',
    item: { id: 'gm1', at: now + 800, me: false, text: 'Your verification code is 482913' },
  }) + '\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(notifs.view.otp.id, offerId, 'SMS and Google Messages dedupe onto the same candidate');
  assert.deepEqual(clipWrites, ['482913'], 'deduped secondary sources do not re-copy');

  // 4. User-initiated Use code succeeds via verified helper target without touching clipboard again.
  const res = await notifs.useOtp(offerId);
  assert.deepEqual(res, { ok: true, mode: 'filled' });
  assert.ok(helperCalls.some((c) => c.cmd === 'otpFill' && c.args.token === 'tok-1' && c.args.code === '482913'));
  assert.equal(notifs.view.otp, null, 'consumed offer is cleared');
  assert.deepEqual(clipWrites, ['482913'], 'verified fill does not rewrite clipboard');

  gm.stop();
  await gm.retiring;
  resetClip();
});

test('failure paths: target-change falls back to secure copy, Stop/revoke invalidates, and IPC enforces origin', async () => {
  resetClip();
  const socket = {};
  const server = Object.assign(new EventEmitter(), {
    current: { deviceId: 'phone-1', name: 'Fixture Phone', os: P.OS.ANDROID, ws: socket },
    outbound: () => socket,
    sendToClient: () => true,
  });
  const helper = Object.assign(new EventEmitter(), {
    running: true,
    send() {},
    async request(cmd) {
      if (cmd === 'otpTarget') return { valid: true, token: 'tok-stale' };
      if (cmd === 'otpFill') return { filled: false, reason: 'target-changed' };
      return {};
    },
  });
  const settings = {
    notifs: { receive: true, send: false, otpCopy: false, style: 'none', muted: [] },
    hub: { calls: false, messages: true, media: false, files: false },
  };
  const notifs = new Notifs({ server, helper, getSettings: () => settings, saveSettings() {} });
  const hub = new PhoneHub({ server, getSettings: () => settings, save() {} });
  hub.on('smsNew', (ev) => notifs.onSmsNew(ev, hub));
  hub.on('stopped', () => notifs.clearOtpSource('sms'));
  hub.started();

  // Stale SMS (hours old) and outgoing SMS are ignored.
  server.emit(`t:${P.T.SMS_NEW}`, {
    t: P.T.SMS_NEW, msg: { id: 'old', body: 'Code is 998877', at: Date.now() - 3600_000, out: false },
  }, server.current, socket);
  server.emit(`t:${P.T.SMS_NEW}`, {
    t: P.T.SMS_NEW, msg: { id: 'out', body: 'Code is 998877', at: Date.now(), out: true },
  }, server.current, socket);
  assert.equal(notifs.view.otp, null, 'stale and outgoing SMS never create an offer');

  // Fresh authorized SMS creates an offer without auto-copy (otpCopy is off).
  server.emit(`t:${P.T.SMS_NEW}`, {
    t: P.T.SMS_NEW, summary: { name: 'Auth' },
    msg: { id: 'fresh', body: 'Use 654321 to sign in', at: Date.now(), out: false },
  }, server.current, socket);
  assert.equal(clipWrites.length, 0, 'opt-in otpCopy off does not auto-copy');
  const offerId = notifs.view.otp.id;

  // Helper rejects target-changed -> secure explicit quietCopy fallback!
  const fallback = await notifs.useOtp(offerId);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.mode, 'copied');
  assert.equal(fallback.reason, 'target-changed');
  assert.deepEqual(clipWrites, ['654321']);
  assert.equal(Otp.isQuiet('654321'), true, 'fallback copy is local-only and sync-exempt');

  // Control IPC enforces mainFrame + control.html origin and rejects malformed codes.
  handlers.clear();
  setupIpc({ state: { connect: {} }, server, notifs });
  const controlURL = pathToFileURL(path.resolve(__dirname, '../control.html')).href;
  const goodFrame = { url: controlURL };
  const goodEvent = { sender: { mainFrame: goodFrame }, senderFrame: goodFrame };
  const badEvent = { sender: { mainFrame: goodFrame }, senderFrame: { url: 'about:blank' } };
  assert.equal(await handlers.get('copyOtp')(badEvent, '654321'), false, 'wrong frame rejected');
  assert.equal(await handlers.get('copyOtp')(goodEvent, 'not-a-code'), false, 'non-OTP text rejected');
  assert.equal(await handlers.get('copyOtp')(goodEvent, '654321'), true, 'valid control IPC copyOtp succeeds');
  assert.deepEqual(await handlers.get('useOtp')(badEvent, offerId), { ok: false, mode: 'refused' });

  // Revoking Messages permission or stopping session immediately invalidates the candidate.
  settings.hub.messages = false;
  const revoked = await handlers.get('useOtp')(goodEvent, offerId);
  assert.deepEqual(revoked, { ok: false, mode: 'expired' }, 'revoked permission refuses Use code');
  assert.equal(notifs.view.otp, null);

  // New offer cleared on disconnect / Stop.
  settings.hub.messages = true;
  server.emit(`t:${P.T.SMS_NEW}`, {
    t: P.T.SMS_NEW, summary: { name: 'Auth' },
    msg: { id: 'fresh2', body: 'Verification code: 246810', at: Date.now(), out: false },
  }, server.current, socket);
  assert.ok(notifs.view.otp);
  server.current = null;
  server.emit('closed', { deviceId: 'phone-1', os: P.OS.ANDROID });
  assert.equal(notifs.view.otp, null, 'disconnect/Stop clears active OTP candidate');
  resetClip();
});
