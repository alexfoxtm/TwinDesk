// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { create, pairedDevices, pinnedIdentity, TEAM, IDENTITY, APP } = require('../ios-developer-sign.js');
const { IosSign, mergeDevices, T } = require('../../shared/iossign.js');

const IPAD = '00008142-AAAAAAAAAAAAAAAA';
const IPHONE = '00008110-BBBBBBBBBBBBBBBB';
const CORE = 'AAA00000-1000-4000-8000-000000000000';
const valid = `  1) ${IDENTITY} "Apple Development: Test fixture (86RNYWFF97)"\n     1 valid identities found`;
const ids = [APP, APP + '.broadcast', APP + '.share'];
const device = {
  identifier: CORE, hardwareProperties: { udid: IPAD, deviceType: 'iPad' },
  deviceProperties: { name: 'Test Tablet', developerModeStatus: 'enabled' },
  connectionProperties: { pairingState: 'paired', transportType: 'localNetwork' },
};
const target = pairedDevices([device])[0];
const next = () => new Promise(setImmediate);

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-developer-test-'));
  t.after(() => fs.rm(temp, { force: true, recursive: true }));
  const ipa = path.join(temp, 'TwinDesk.ipa');
  const profileDir = path.join(temp, 'profiles');
  await fs.writeFile(ipa, '');
  await fs.mkdir(profileDir);
  const leaf = Buffer.from('synthetic certificate');
  const realHash = crypto.createHash;
  t.mock.method(crypto, 'createHash', (algorithm) => {
    const hash = realHash(algorithm);
    return { update: (data) => Buffer.isBuffer(data) && data.equals(leaf)
      ? { digest: () => IDENTITY.toLowerCase() } : hash.update(data) };
  });
  t.mock.method(crypto, 'X509Certificate', function () {
    return { subject: `OU=${TEAM}`, validFrom: '2020-01-01', validTo: '2100-01-01' };
  });
  const ends = Math.floor(Date.now() / 1000) + 86400;
  const profiles = ids.map((id, i) => ({
    Entitlements: { 'application-identifier': `${TEAM}.${id}`, 'get-task-allow': true,
      'com.apple.developer.team-identifier': TEAM, 'keychain-access-groups': [`${TEAM}.*`] },
    TeamIdentifier: [TEAM], Platform: ['iOS'], ProvisionedDevices: [IPAD],
    ExpirationDate: new Date((ends + (i === 1 ? 0 : 3)) * 1000).toISOString(),
    DeveloperCertificates: `<array><data>${leaf.toString('base64')}</data></array>`,
  }));
  await Promise.all(profiles.map((p, i) => fs.writeFile(path.join(profileDir, i + '.mobileprovision'), JSON.stringify(p))));
  const calls = [];
  const f = { valid, devices: [device], profiles, ends, calls, profileDir, ipa, temp };
  f.exec = async (file, args, options) => {
    options.signal?.throwIfAborted();
    calls.push([file, ...args]);
    let stdout = '';
    if (file === '/usr/bin/xcrun') {
      let result;
      const action = args.slice(1, 4).join(' ');
      if (action.startsWith('list devices')) result = { devices: f.devices };
      else if (action === 'device info lockState') result = { passcodeRequired: !!f.locked };
      else if (action === 'device info apps') result = { apps: [] };
      else if (action === 'device install app') result = { installedApplications: [{ bundleID: APP }] };
      else assert.fail(action);
      if (!action.startsWith('list devices')) assert.equal(args[args.indexOf('--device') + 1], CORE);
      stdout = JSON.stringify({ result });
    } else if (file === '/usr/bin/security') {
      stdout = args[0] === 'find-identity' ? f.valid : await fs.readFile(args.at(-1), 'utf8');
    } else if (file === '/usr/bin/plutil' && args[0] === '-extract') {
      const plist = JSON.parse(await fs.readFile(args.at(-1), 'utf8'));
      stdout = args[2] === 'json' ? JSON.stringify(plist[args[1]]) : plist[args[1]];
    } else if (file === '/usr/bin/ditto') {
      const app = path.join(args.at(-1), 'Payload', 'TwinDesk.app');
      const bundles = [app, path.join(app, 'PlugIns', 'Broadcast.appex'), path.join(app, 'PlugIns', 'Share.appex')];
      for (const [i, bundle] of bundles.entries()) {
        await fs.mkdir(bundle, { recursive: true });
        await fs.writeFile(path.join(bundle, 'Info.plist'), JSON.stringify({
          CFBundleIdentifier: ids[i], CFBundleShortVersionString: '3.2.1', UIDeviceFamily: [1, 2],
        }));
      }
    }
    return { stdout };
  };
  f.developer = create({ exec: f.exec, ipa, tmp: temp, profileDirs: [profileDir] });
  return f;
}

test('a paired iPad joins USB discovery and refreshes through the pinned CoreDevice path on its own schedule', async (t) => {
  const f = await fixture(t);
  const mux = [{ udid: IPHONE, klass: 'iPhone', name: 'Test Phone', usb: true },
    { udid: IPAD.toLowerCase(), name: 'from USB', usb: true }];
  const core = await f.developer.list();
  const [phone, ipad] = mergeDevices(mux, core);
  assert.equal(phone.udid, IPHONE);
  assert.deepEqual(ipad, { udid: IPAD, coreId: CORE, muxUdid: IPAD.toLowerCase(), klass: 'iPad', name: 'Test Tablet', usb: true, wifi: true });
  const signal = new AbortController().signal;
  const receipt = await f.developer.install(ipad, signal);
  assert.equal(receipt.expires, f.ends);
  assert.equal(receipt.team, TEAM);
  assert.equal(receipt.identity, IDENTITY);
  assert.equal(receipt.components.length, 3);
  const signs = f.calls.filter((c) => c[0] === '/usr/bin/codesign' && c.includes('--sign'));
  assert.equal(signs.length, 3);
  assert.ok(signs.every((c) => c[c.indexOf('--sign') + 1] === IDENTITY));
  assert.match(signs.at(-1).at(-1), /TwinDesk\.app$/);
  assert.equal((await f.developer.install(ipad, signal, { minExpiry: receipt.expires, requireNewer: true })), null);
  assert.equal(f.calls.filter((c) => c[2] === 'device' && c[3] === 'install').length, 1);

  let cfg = { on: false, alone: IPHONE.toLowerCase(), auto: true, localInstalls: { [IPAD]: receipt } };
  const link = new EventEmitter();
  link.send = () => {};
  const schedule = [];
  const developer = { ...f.developer, async install(d, s, opts) { schedule.push({ d, s, opts }); return null; } };
  const service = new IosSign({ link, developer, cfg: () => cfg, setCfg: (x) => { cfg = { ...cfg, ...x }; } });
  t.after(() => service.close());
  service._release = () => {};
  service.devices = [phone, ipad];
  service.info = {};
  assert.equal(service.view.mode, 'apple', 'legacy preferences retain Apple ID mode');
  assert.equal(service.view.udid, IPHONE, 'legacy lowercase selection migrates to the exact device');
  // The Apple ID scheduler can refresh a previously enrolled device without
  // using an IPA the person has just chosen for a different one.
  cfg = { ...cfg, on: true, keptFacts: { [IPAD]: { signedIn: true } } };
  const state = { xcode_token: 'fixture' };
  service.vault = { load: () => JSON.stringify({ [IPAD]: state }) };
  service.ipa = '/chosen-for-the-iphone.ipa';
  service.apps[IPAD] = [{ bundleId: APP + '.TESTTEAM12', expires: receipt.expires, twindesk: true }];
  const requests = [];
  service._start = (run, req) => requests.push(req);
  service._auto();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].udid, IPAD);
  assert.equal(requests[0].ipa, undefined);
  assert.equal(service.ipa, '/chosen-for-the-iphone.ipa');

  cfg = { ...cfg, on: true, mode: 'developer', localDevice: IPHONE };
  service._auto();
  assert.equal(schedule[0].d.udid, IPAD);
  assert.deepEqual(schedule[0].opts, { minExpiry: receipt.expires, requireNewer: true });
  await next();
  service._auto();
  assert.equal(schedule.length, 1, 'bounded retry even when Xcode had no newer profile');
  assert.equal(service.view.devices.find((d) => d.udid === IPAD).expires, f.ends);
  assert.equal(await service.installDeveloper(IPAD), null, 'manual actions must use the current selection');
  link.current = { os: 'ios', id: 'paired-session' };
  link.emit(T.SET, { on: false });
  assert.equal(cfg.on, true, 'the legacy wire cannot change developer mode');
});

test('unpaired, locked, wrong certificate or wrong profile cannot start installation', async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  f.locked = true;
  await assert.rejects(f.developer.install(target, signal), /Connect or unlock the iPad/);
  f.locked = false;
  f.devices = [{ ...device, connectionProperties: { ...device.connectionProperties, pairingState: 'unpaired' } }];
  await assert.rejects(f.developer.install(target, signal), /Connect or unlock the iPad/);
  f.devices = [device];
  f.valid = valid.replace(IDENTITY, 'A'.repeat(40));
  assert.equal(pinnedIdentity(f.valid), false);
  await assert.rejects(f.developer.install(target, signal), /certificate is unavailable/);
  f.valid = valid;
  const wrong = path.join(f.profileDir, '2.mobileprovision');
  for (const patch of [{ ProvisionedDevices: [IPHONE] }, { TeamIdentifier: ['OTHERTEAM1'] },
    { DeveloperCertificates: '<array><data>YQ==</data></array>' }]) {
    await fs.writeFile(wrong, JSON.stringify({ ...f.profiles[2], ...patch }));
    await assert.rejects(f.developer.install(target, signal), /Xcode needs to prepare TwinDesk/);
  }
  await assert.rejects(create({ exec: f.exec, ipa: f.ipa + '.missing' }).install(target, signal), /doesn’t include TwinDesk/);
  assert.ok(!f.calls.some((c) => c[0] === '/usr/bin/codesign' || c[3] === 'install'), 'no ad-hoc or Apple ID fallback');

  const calls = [];
  let finish;
  const link = Object.assign(new EventEmitter(), { send() {} });
  let cfg = { on: false, mode: 'developer', localDevice: IPAD, auto: false };
  const developer = { ...f.developer, install(d, s) {
    calls.push(d.udid);
    return new Promise((resolve) => { finish = () => { assert.equal(s.aborted, true); resolve({ expires: f.ends }); }; });
  } };
  const service = new IosSign({ link, developer, cfg: () => cfg, setCfg: (x) => { cfg = { ...cfg, ...x }; } });
  service.devices = [{ ...target }, { udid: IPHONE, coreId: 'other' }];
  cfg.on = true;
  const started = service.installDeveloper(IPAD);
  service.set({ udid: IPHONE });
  finish();
  assert.equal(await started, null);
  assert.equal(cfg.localInstalls, undefined, 'late result cannot report a canceled install');
  assert.deepEqual(calls, [IPAD]);
  service.close();
});
