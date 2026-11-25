// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('applying a terminal key updates only the paired peer line and disables forwarding', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-terminal-test-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  t.mock.method(os, 'homedir', () => home);
  const keys = path.join(home, '.ssh', 'authorized_keys');
  fs.mkdirSync(path.dirname(keys));
  const key = 'ssh-ed25519 Zml4dHVyZQ==';
  const unmanaged = 'ssh-ed25519 ZGlmZmVyZW50 unmanaged';
  const otherPeer = 'ssh-ed25519 ZGlmZmVyZW50 macshare:another-peer';
  const old = 'no-agent-forwarding,no-X11-forwarding ' + key + ' macshare:fixture-peer';
  const expected = 'no-agent-forwarding,no-X11-forwarding,no-port-forwarding ' + key + ' macshare:fixture-peer';
  const digest = line => crypto.createHash('sha256').update(line).digest('hex');

  for (const platform of ['linux', 'windows']) {
    const Sshd = require('../../' + platform + '/sshd.js');
    fs.writeFileSync(keys, [unmanaged, old, otherPeer, ''].join('\n'));
    const settings = { terminal: { allowMac: true, installedKey: digest(old) } };
    let saves = 0;
    const daemon = Object.assign(Object.create(Sshd.prototype), {
      settings,
      link: { snapshot: () => ({ session: { id: 'fixture-peer' } }) },
      isAdmin: false,
      service: 'running',
      refresh() {},
      _info(enabled) { assert.equal(enabled, true); },
      save() { saves++; },
    });

    await daemon._onKey({ pub: key });
    assert.equal(fs.readFileSync(keys, 'utf8'), [unmanaged, otherPeer, expected, ''].join('\n'), platform);
    assert.equal(settings.terminal.installedKey, digest(expected), platform);
    await daemon.apply();
    assert.equal(saves, 1, platform);
    if (process.platform !== 'win32' && platform === 'linux') assert.equal(fs.statSync(keys).mode & 0o777, 0o600);
  }

  const { Terminal } = require('../../mac/terminal.js');
  const mark = ' alexfoxtm-twindesk:fixture-peer';
  const unrelated = otherPeer + '\nssh-ed25519 ZGlmZmVyZW50 alexfoxtm-twindesk:another-peer';
  fs.writeFileSync(keys, [unmanaged, old.replace(' macshare:fixture-peer', mark), unrelated, ''].join('\n'));
  const expectedMac = [unmanaged, unrelated, expected.replace(' macshare:fixture-peer', mark), ''].join('\n');
  t.mock.method(net, 'connect', () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    process.nextTick(() => socket.emit('connect'));
    return socket;
  });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith('/etc/ssh/')) throw new Error('No fixture host keys');
    return readFileSync(file, ...args);
  });
  const terminal = Object.assign(Object.create(Terminal.prototype), {
    keys: new Map(),
    getSettings: () => ({ terminal: { allowPc: true } }),
    server: { send: (_ctx, reply) => assert.equal(reply.enabled, true) },
  });
  for (let i = 0; i < 2; i++) {
    await terminal._onKey({ pub: key }, { deviceId: 'fixture-peer' });
    assert.equal(fs.readFileSync(keys, 'utf8'), expectedMac);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keys).mode & 0o777, 0o600);
  }
});
