// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Full KVM tab on NixOS (docs/nixos.md): with the declarative setup (programs.twindesk.fullKvm) the
// manager shows the configuration's mode and never runs install.sh; on NixOS without it, it says what to
// set instead of asking for a password; install.sh refuses install/mode/remove there too.
// Run with: node linux/fullkvm/test/manager-nixos.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const cp = require('child_process');

const UNIT = '/etc/systemd/system/twindesk-fullkvm.service';
const CONF = '/etc/twindesk/fullkvm.json';
const NIX_SYSTEMD_RUN = '/run/current-system/sw/bin/systemd-run';
let files = {}; // what the pretend /etc holds
const calls = [];

const realExists = fs.existsSync;
const realRead = fs.readFileSync;
const onNixos = realExists('/etc/NIXOS');
fs.existsSync = (p) => {
  if (p in files) return true;
  if (['/etc/NIXOS', UNIT, CONF, '/usr/bin/systemd-run', '/bin/systemd-run', NIX_SYSTEMD_RUN].includes(p)) return false;
  return realExists(p);
};
fs.readFileSync = function (p, ...a) { return p in files ? files[p] : realRead.call(this, p, ...a); };
const realExecFile = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => { calls.push(cmd); cb(null, cmd === 'systemctl' ? 'active\n' : '', ''); };

const load = Module._load;
Module._load = function (id, ...a) {
  if (id === 'electron') return { app: { getPath: () => os.tmpdir() }, ipcMain: { handle() {} }, session: { defaultSession: { registerPreloadScript() {} } } };
  return load.call(this, id, ...a);
};
const M = require('../manager.js');
Module._load = load;

(async () => {
  // Declarative, System-wide.
  files = { [UNIT]: '', [CONF]: '{"declarative":true,"mode":"system"}' };
  let st = await M.state();
  assert.strictEqual(st.mode, 'system');
  assert.strictEqual(st.declarative, true);
  assert.strictEqual(st.active, true);
  st = await M.set('off');
  assert.match(st.error, /NixOS configuration/);
  assert.strictEqual(st.mode, 'system');
  st = await M.set('simple');
  assert.match(st.error, /NixOS configuration/);
  assert.ok(!calls.includes('pkexec'), 'no password prompt for a declared service');

  // NixOS restarts the app outside the wrapper's process environment.
  files[NIX_SYSTEMD_RUN] = '';
  const wrapperEnv = {
    NODE_PATH: '/nix/store/test/share/twindesk/node_modules',
    TWINDESK_BIN: '/nix/store/test/bin/twindesk',
    CHROME_DESKTOP: 'twindesk.desktop',
    GI_TYPELIB_PATH: '/nix/store/test/lib/girepository-1.0',
    GST_PLUGIN_SYSTEM_PATH_1_0: '/nix/store/test/lib/gstreamer-1.0',
  };
  const realSpawn = cp.spawn;
  const realEnv = process.env;
  const spawned = [];
  try {
    process.env = { ...realEnv, ...wrapperEnv, ELECTRON_RUN_AS_NODE: '1', TWINDESK_TEST_UNRELATED: '1' };
    cp.spawn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    };
    M.attach({ helper: null });
  } finally {
    cp.spawn = realSpawn;
    process.env = realEnv;
  }
  assert.strictEqual(spawned.length, 1);
  const [{ cmd, args, opts }] = spawned;
  assert.strictEqual(cmd, NIX_SYSTEMD_RUN);
  assert.ok(args.includes('--user'));
  for (const [key, value] of Object.entries(wrapperEnv)) {
    assert.ok(args.includes(`--setenv=${key}=${value}`), `restart must preserve ${key}`);
  }
  assert.ok(!args.includes('--setenv=TWINDESK_TEST_UNRELATED=1'));
  assert.strictEqual(opts.env.ELECTRON_RUN_AS_NODE, undefined);

  // Declarative, Signed in; the same mode asked for again is just the state.
  files = { [UNIT]: '', [CONF]: '{"declarative":true,"mode":"simple"}' };
  st = await M.set('simple');
  assert.strictEqual(st.error, '');
  assert.strictEqual(st.mode, 'simple');

  // NixOS without the declarative setup (the Full KVM package alone): nothing installed, so Off; turning it on says how.
  files = { '/etc/NIXOS': '' };
  st = await M.state();
  assert.strictEqual(st.mode, 'off');
  assert.ok(!st.declarative);
  st = await M.set('simple');
  assert.match(st.error, /programs\.twindesk\.fullKvm = true/);
  assert.ok(!calls.includes('pkexec'));

  // Not NixOS, no declarative file: as before (the service is the person's, through pkexec).
  files = {};
  st = await M.state();
  assert.strictEqual(st.mode, 'off');
  assert.ok(!st.declarative);

  fs.existsSync = realExists;
  fs.readFileSync = realRead;
  cp.execFile = realExecFile;

  // install.sh refuses on NixOS before touching anything (a pretend root: `id -u` says 0).
  if (onNixos) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fullkvm-id-'));
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    const sh = (...args) => cp.spawnSync('/bin/sh', [path.join(__dirname, '..', 'install.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
    for (const args of [['install', 'simple', '/bin/true', '/nonexistent'], ['mode', 'system'], ['remove'], ['sync', '/nonexistent']]) {
      const r = sh(...args);
      assert.strictEqual(r.status, 1, args.join(' '));
      assert.match(r.stderr, /NixOS configuration/, args.join(' '));
    }
    fs.rmSync(bin, { recursive: true, force: true });
  }
  console.log('fullkvm manager on NixOS: ok');
})().catch((e) => { console.error(e); process.exit(1); });
