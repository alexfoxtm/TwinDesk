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
  const { onRenewal, ...opts } = schedule[0].opts;
  assert.deepEqual(opts, { minExpiry: receipt.expires, requireNewer: true, renewWithin: 3 * 86400, force: false });
  assert.equal(typeof onRenewal, 'function');
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
  await assert.rejects(create({ exec: f.exec, ipas: [f.ipa + '.stored-missing', f.ipa + '.bundled-missing'] }).install(target, signal), /^Error: No TwinDesk iPad build stored yet$/);
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

for (const mode of ['developer', 'apple']) test(`the sole eligible device replaces a missing ${mode} selection without inheriting it`, async (t) => {
  const ipad = { ...target, muxUdid: IPAD };
  const phone = { udid: IPHONE, name: 'Remembered iPhone', coreId: 'phone', muxUdid: IPHONE };
  const ineligible = { udid: '00008111-CCCCCCCCCCCCCCCC', coreId: 'other' };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-selection-test-'));
  t.after(() => fs.rm(temp, { force: true, recursive: true }));
  const file = path.join(temp, 'Remembered.ipa');
  await fs.writeFile(file, '');
  await fs.writeFile(path.join(temp, 'TwinDesk.ipa'), '');
  await fs.mkdir(path.join(temp, IPHONE));
  await fs.writeFile(path.join(temp, IPHONE, 'TwinDesk.ipa'), '');

  const link = Object.assign(new EventEmitter(), { current: { os: 'ios', id: 'old-phone' }, send() {} });
  const config = { mode, on: false, localDevice: IPHONE, appleDevice: IPHONE, device: { 'old-phone': IPHONE } };
  let cfg = config;
  const installs = [];
  const developer = { bundled: () => true, install: async (d) => { installs.push(d.udid); return null; } };
  let vaultReads = 0;
  const vault = { exists: () => true, load: () => {
    vaultReads++;
    return JSON.stringify({ [IPHONE]: { xcode_token: 'old-phone-fixture' } });
  } };
  const sign = new IosSign({ link, developer, vault, cfg: () => cfg, setCfg: (x) => { cfg = { ...cfg, ...x }; }, cacheDir: temp });
  t.after(() => sign.close());
  sign._look = () => {};
  sign.info = { anyIpa: true };
  sign.devices = [phone];
  cfg = { ...cfg, on: true };
  if (mode === 'apple') {
    assert.equal(sign.view.twindeskIpa, true, 'the exact device’s stored IPA is still usable');
    sign.setIpa(file);
  }
  sign.pending = { udid: IPHONE, state: { token: 'old-phone-fixture' } };
  sign.apps[IPAD] = [{ bundleId: APP + '.TESTTEAM12', expires: 1, twindesk: true }];
  sign.devices = [ipad, mode === 'apple' ? ineligible : { ...ineligible, coreId: '', muxUdid: ineligible.udid }];

  assert.equal(sign.view.udid, IPAD, mode + ' exposes the only eligible app-install target');
  assert.equal(sign.view.ipa, '', 'the previous device’s IPA is unavailable');
  assert.equal(sign.view.twindeskIpa, false, 'the unscoped cache has no exact device owner');
  assert.equal(sign.view.pending, false);
  assert.equal(sign.view.session?.udid || '', '', 'the authenticated session is still bound to the missing device');
  assert.deepEqual(cfg.device, config.device);
  assert.equal(cfg.localDevice, IPHONE);
  assert.equal(cfg.appleDevice, IPHONE);
  if (mode === 'apple') {
    const requests = [];
    sign._start = (run, req) => requests.push(req);
    sign._auto();
    assert.deepEqual(requests, []);
    assert.equal(vaultReads, 0, 'a vault without exact consent metadata cannot authorize fallback refresh');
    sign.setIpa(file, IPHONE); // A dialog opened for the old device completed late.
    assert.equal(sign.view.ipa, '');
    sign.signIn({ udid: IPAD, email: 'fixture@example.test', password: 'fixture' });
    assert.equal(requests[0].udid, IPAD);
    for (const key of ['ipa', 'twindesk_ipa', 'state']) assert.equal(requests[0][key], undefined);
  } else {
    sign._auto();
    assert.deepEqual(installs, [], 'a fallback is not automatically enrolled');
    await sign.installDeveloper(IPAD);
    assert.deepEqual(installs, [IPAD]);
    assert.equal(cfg.localInstalls, undefined);
  }

  sign.devices = [ipad, phone];
  assert.equal(sign.view.udid, IPHONE, 'the explicit choice wins again when it reconnects');
  sign.set({ udid: IPAD });
  assert.equal(sign.view.udid, IPAD);
  assert.deepEqual(cfg.device, config.device, 'the picker cannot rebind an app session');
  assert.equal(cfg.localInstalls, undefined, 'the picker cannot enroll automatic installs');
});

test('a bound legacy device can pause its offline refresh while another device is selected', (t) => {
  const messages = [];
  const link = Object.assign(new EventEmitter(), { current: { os: 'ios', id: 'bound', name: 'My iPhone' }, send: (m) => messages.push(m) });
  let cfg = { mode: 'apple', on: false, appleDevice: IPHONE, device: { bound: IPHONE } };
  const sign = new IosSign({ link, developer: { bundled: () => true }, cfg: () => cfg, setCfg: (x) => { cfg = { ...cfg, ...x }; } });
  t.after(() => sign.close());
  sign._look = () => {};
  sign.info = {};
  sign.devices = [{ ...target, muxUdid: IPAD }];
  cfg = { ...cfg, on: true };
  sign.set({ udid: IPHONE, deviceAuto: false });
  assert.equal(cfg.deviceAuto?.[IPHONE], false);
  assert.equal(sign.view.session.auto, false);
  link.emit(T.STATE, { expires: 1, signedIn: true });
  assert.ok(!messages.some((m) => m.t === T.WANT));
  sign.set({ udid: IPHONE, deviceAuto: true });
  sign._auto();
  assert.equal(messages.filter((m) => m.t === T.WANT).length, 1);
  assert.equal(sign.view.udid, IPAD);
  assert.equal(cfg.appleDevice, IPHONE, 'changing the offline toggle cannot select another device');
});

test('the stored fork IPA wins over the legacy bundled copy and reports its checked version', async (t) => {
  const f = await fixture(t);
  const stored = path.join(f.temp, 'userData', 'ios-developer', 'TwinDesk.ipa');
  const bundled = f.ipa;
  const developer = create({ exec: f.exec, ipas: [stored, bundled], tmp: f.temp, profileDirs: [f.profileDir] });
  assert.deepEqual(developer.source(), { file: bundled, kind: 'bundled' }, 'legacy fallback only when nothing is stored');
  assert.equal((await developer.stored()).kind, 'bundled');
  await fs.mkdir(path.dirname(stored), { recursive: true });
  await fs.writeFile(stored, 'fork');
  assert.deepEqual(developer.source(), { file: stored, kind: 'stored' });
  assert.deepEqual(await developer.stored(), { kind: 'stored', version: '3.2.1', file: stored, valid: true });
  assert.deepEqual(developer.storedInfo(), { kind: 'stored', version: '3.2.1', file: stored, valid: true });
  const from = f.calls.length;
  const receipt = await developer.install(target, new AbortController().signal);
  assert.equal(receipt.ipa, 'stored');
  const unpacked = f.calls.slice(from).filter((c) => c[0] === '/usr/bin/ditto').map((c) => c.at(-2));
  assert.equal(unpacked.at(-1), stored, 'the install unpacks the stored IPA');
  assert.ok(!unpacked.includes(bundled));

  // Inventory rules: exact Payload/TwinDesk.app, the three IDs, iPhone and iPad.
  const realExec = f.exec;
  for (const broken of ['name', 'family', 'extra', 'version']) {
    f.exec = async (file, args, options) => {
      const r = await realExec(file, args, options);
      if (file === '/usr/bin/ditto') {
        const app = path.join(args.at(-1), 'Payload', 'TwinDesk.app');
        if (broken === 'name') await fs.rename(app, path.join(args.at(-1), 'Payload', 'Other.app'));
        if (broken === 'extra') await fs.mkdir(path.join(app, 'PlugIns', 'Extra.appex'));
        if (broken === 'family' || broken === 'version') {
          const info = path.join(app, 'Info.plist');
          const plist = JSON.parse(await fs.readFile(info, 'utf8'));
          if (broken === 'family') plist.UIDeviceFamily = [1];
          else plist.CFBundleShortVersionString = '';
          await fs.writeFile(info, JSON.stringify(plist));
        }
      }
      return r;
    };
    await fs.writeFile(stored, `fork ${broken}`); // a new size/time: checked again
    const checker = create({ exec: (...a) => f.exec(...a), ipas: [stored, bundled], tmp: f.temp });
    const info = await checker.stored();
    assert.equal(info.valid, false, broken);
    assert.equal(info.version, '');
  }
});

function renewerFixture(f, outcome) {
  const calls = [];
  return { calls, async renew(signal, opts) {
    calls.push(opts);
    signal.throwIfAborted();
    if (outcome.write) for (const [i, p] of f.profiles.entries()) {
      await fs.writeFile(path.join(f.profileDir, `renewed-${i}.mobileprovision`),
        JSON.stringify({ ...p, ExpirationDate: new Date((outcome.write + i) * 1000).toISOString() }));
    }
    return { state: outcome.state, message: outcome.message || '' };
  } };
}

test('profile-only renewal runs within cfg.days or on Refresh now and never blocks valid cached profiles', async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const make = (outcome) => {
    const renewer = renewerFixture(f, outcome);
    return { renewer, developer: create({ exec: f.exec, ipa: f.ipa, tmp: f.temp, profileDirs: [f.profileDir], renewer }) };
  };
  // Cached profiles end in ~1 day: inside the default 3 days, so an automatic refresh renews first.
  let { renewer, developer } = make({ state: 'managed', message: 'renew in Xcode' });
  const heard = [];
  let receipt = await developer.install(target, signal, { renewWithin: 3 * 86400, onRenewal: (r) => heard.push(r) });
  assert.deepEqual(renewer.calls, [{ udid: IPAD }], 'exactly the selected paired device');
  assert.equal(receipt.expires, f.ends, 'blocked renewal keeps the valid cached profiles');
  assert.deepEqual(receipt.renewal, { state: 'managed', before: f.ends, after: f.ends });
  assert.equal(heard[0].message, 'renew in Xcode');
  // Outside cfg.days: no renewal for an automatic run; Refresh now (force) always asks Xcode.
  ({ renewer, developer } = make({ state: 'current' }));
  receipt = await developer.install(target, signal, { renewWithin: 3600 });
  assert.deepEqual(renewer.calls, []);
  assert.equal(receipt.renewal, undefined);
  await developer.install(target, signal, { renewWithin: 3600, force: true });
  assert.equal(renewer.calls.length, 1);
  // Xcode issued newer profiles: they are the ones embedded, and the scheduler's newer check passes.
  const later = f.ends + 5 * 86400;
  ({ renewer, developer } = make({ state: 'current', write: later }));
  receipt = await developer.install(target, signal, { minExpiry: f.ends, requireNewer: true });
  assert.equal(receipt.expires, later);
  assert.equal(receipt.renewal.state, 'renewed');
  assert.equal(receipt.renewal.after, later);
  // No Xcode account and no usable cache: the exact sign-in guidance, nothing signed or installed.
  await Promise.all([0, 1, 2].map((i) => fs.rm(path.join(f.profileDir, `${i}.mobileprovision`))));
  await Promise.all([0, 1, 2].map((i) => fs.rm(path.join(f.profileDir, `renewed-${i}.mobileprovision`))));
  const before = f.calls.length;
  ({ renewer, developer } = make({ state: 'account', message: 'Sign in to Xcode › Settings › Accounts' }));
  await assert.rejects(developer.install(target, signal), /^Error: Sign in to Xcode › Settings › Accounts$/);
  assert.ok(!f.calls.slice(before).some((c) => c[0] === '/usr/bin/codesign' || c[3] === 'install'));
  // Canceled during renewal: nothing after it runs.
  const controller = new AbortController();
  developer = create({ exec: f.exec, ipa: f.ipa, tmp: f.temp, profileDirs: [f.profileDir],
    renewer: { async renew() { controller.abort(); return { state: 'current' }; } } });
  await assert.rejects(developer.install(target, controller.signal), { name: 'AbortError' });
});

test('automatic developer refresh: next due within cfg.days, retry rest per device, renewal options and scoping', async (t) => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const other = '00008142-CCCCCCCCCCCCCCCC';
  const ipad = { ...target };
  const second = { udid: other, coreId: 'CCC00000-1000-4000-8000-000000000000', klass: 'iPad', name: 'Second' };
  const at = (days) => Math.floor(now / 1000) + days * 86400;
  let cfg = { on: true, mode: 'developer', localDevice: IPAD, auto: true,
    localInstalls: { [IPAD]: { expires: at(4) }, [other]: { expires: at(3.5) } } };
  const installs = [];
  const developer = { bundled: () => true, list: async () => [], storedInfo: () => ({ kind: 'stored', version: '3.2.1', valid: true }),
    async install(d, s, opts) {
      installs.push({ udid: d.udid, ...opts, onRenewal: !!opts.onRenewal });
      opts.onRenewal?.({ state: 'managed', message: 'renew in Xcode' });
      return null;
    } };
  const link = Object.assign(new EventEmitter(), { send() {} });
  const sign = new IosSign({ link, developer, cfg: () => cfg, setCfg: (x) => { cfg = { ...cfg, ...x }; } });
  t.after(() => sign.close());
  sign._look = () => {};
  sign._release = () => {};
  await sign.scanTask; // the constructor's first scan settles before the fixture devices are set
  sign.devices = [ipad, second];
  sign._auto();
  assert.deepEqual(installs, [], 'nothing is due outside the default 3 days');
  cfg = { ...cfg, days: 4 };
  sign._auto();
  assert.deepEqual(installs.map((i) => i.udid), [other], 'the earliest expiry inside cfg.days goes first');
  assert.equal(installs[0].renewWithin, 4 * 86400);
  assert.equal(installs[0].force, false);
  assert.equal(installs[0].requireNewer, true);
  assert.equal(installs[0].minExpiry, at(3.5));
  assert.equal(sign.renewal.udid, other);
  assert.equal(sign.view.renewal, null, 'a renewal for an unselected device is not shown for the selected one');
  await next();
  assert.deepEqual(installs.map((i) => i.udid), [other, IPAD], 'the next due device follows; the first rests');
  await next();
  assert.equal(sign.view.renewal.state, 'managed');
  sign._auto();
  assert.equal(installs.length, 2, 'both rest for cfg.retry (default 6 h)');
  clock = now + 6 * 3600 * 1000 - 1;
  sign._auto();
  assert.equal(installs.length, 2);
  clock = now + 6 * 3600 * 1000;
  sign._auto();
  assert.equal(installs.length, 3, 'retried after exactly 6 h');
  await next();
  assert.deepEqual(installs.slice(2).map((i) => i.udid), [other, IPAD]);
  cfg = { ...cfg, retry: 1, deviceAuto: { [other]: false } };
  clock += 3600 * 1000;
  sign._auto();
  await next();
  assert.deepEqual(installs.slice(4).map((i) => i.udid), [IPAD], 'cfg.retry 1 h; a device paused on its own is skipped');
  // Refresh now: the selected device only, always asks Xcode first.
  await sign.installDeveloper(IPAD);
  assert.equal(installs.at(-1).force, true);
  assert.equal(installs.at(-1).requireNewer, false);
  assert.equal(await sign.installDeveloper(other), null, 'manual install keeps to the selection');
  // A canceled run cannot report its renewal.
  sign.renewal = null;
  developer.install = (d, s, opts) => new Promise((resolve) => s.addEventListener('abort', () => { opts.onRenewal({ state: 'account', message: 'late' }); resolve(null); }));
  const started = sign.installDeveloper(IPAD);
  sign.stop();
  await started;
  assert.equal(sign.view.renewal, null);
  assert.deepEqual(sign.view.stored, { kind: 'stored', version: '3.2.1', valid: true });
  cfg = { ...cfg, mode: 'apple' };
  assert.equal(sign.view.stored, null, 'Apple ID mode shows no developer build');
});

test('a blocked renewal never claims profiles stay in use when none are valid, and renewer errors never block valid caches', async (t) => {
  const { MANAGED, create: createRenewer } = require('../ios-provision-profiles.js');
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const managed = { async renew() { return { state: 'managed', message: MANAGED }; } };
  const make = (renewer) => create({ exec: f.exec, ipa: f.ipa, tmp: f.temp, profileDirs: [f.profileDir], renewer });
  const installs = () => f.calls.filter((c) => c[0] === '/usr/bin/codesign' || (c[2] === 'device' && c[3] === 'install')).length;

  // Valid cached profiles with 'managed': installs, and the page hears MANAGED.
  let heard = [];
  let receipt = await make(managed).install(target, signal, { force: true, onRenewal: (r) => heard.push(r) });
  assert.equal(receipt.expires, f.ends);
  assert.equal(receipt.renewal.state, 'managed');
  assert.equal(heard[0].message, MANAGED);

  // M2: valid cached profiles and a renewer that throws: the install still goes ahead.
  heard = [];
  const enotempty = { async renew() { throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }); } };
  receipt = await make(enotempty).install(target, signal, { force: true, onRenewal: (r) => heard.push(r) });
  assert.equal(receipt.expires, f.ends);
  assert.equal(receipt.renewal.state, 'failed');
  assert.equal(heard[0].state, 'failed');
  // A renewer that aborts still aborts.
  const controller = new AbortController();
  const aborting = { async renew() { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } };
  await assert.rejects(make(aborting).install(target, controller.signal, { force: true }), { name: 'AbortError' });

  // M1: all three profiles expired an hour ago, 'managed': expired guidance, nothing signed or installed.
  const past = Math.floor(Date.now() / 1000) - 3600;
  await Promise.all(f.profiles.map((p, i) => fs.writeFile(path.join(f.profileDir, i + '.mobileprovision'),
    JSON.stringify({ ...p, ExpirationDate: new Date(past * 1000).toISOString() }))));
  heard = [];
  let before = installs();
  await assert.rejects(make(managed).install(target, signal, { onRenewal: (r) => heard.push(r) }), (error) => {
    assert.equal(error.kind, 'xcode');
    assert.match(error.message, /expired/);
    assert.doesNotMatch(error.message, /stay in use/);
    assert.equal(heard[0].message, error.message);
    return true;
  });
  assert.equal(installs(), before);
  // Empty profile directory with 'managed': no profiles for this device.
  await Promise.all([0, 1, 2].map((i) => fs.rm(path.join(f.profileDir, i + '.mobileprovision'))));
  before = installs();
  await assert.rejects(make(managed).install(target, signal), (error) => {
    assert.equal(error.kind, 'xcode');
    assert.match(error.message, /no TwinDesk profiles for this device/i);
    assert.doesNotMatch(error.message, /stay in use/);
    return true;
  });
  assert.equal(installs(), before);

  // renew() with a missing project: 'failed', no Xcode call, nothing left in tmp, profiles untouched.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-provision-missing-'));
  t.after(() => fs.rm(tmp, { force: true, recursive: true }));
  const prefs = path.join(f.temp, 'prefs.json');
  await fs.writeFile(prefs, JSON.stringify({ IDEProvisioningTeamByIdentifier: { someone: [{ teamID: TEAM }] } }));
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push(file);
    if (file === '/usr/bin/xcrun') assert.fail(`unexpected ${args.join(' ')}`);
    return f.exec(file, args, options);
  };
  const result = await createRenewer({ exec, tmp, project: path.join(tmp, 'missing-project'), prefs, profileDir: f.profileDir, log: () => {} })
    .renew(undefined, { udid: IPAD });
  assert.equal(result.state, 'failed');
  assert.ok(!calls.includes('/usr/bin/xcrun'));
  assert.deepEqual(await fs.readdir(tmp), []);
  assert.ok(!(await fs.readdir(f.temp)).some((n) => n.startsWith('.twindesk-')), 'no backup or lock left');
});

// A stand-in Mac for the renewer: Xcode's profile folder, prefs and identities, and an xcodebuild
// whose behavior each case chooses.
async function renewRig(t, xcodebuild) {
  const f = await fixture(t);
  const renew = require('../ios-provision-profiles.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-provision-rig-'));
  t.after(() => fs.rm(tmp, { force: true, recursive: true }));
  const prefs = path.join(f.temp, 'prefs.json');
  await fs.writeFile(prefs, JSON.stringify({ IDEProvisioningTeamByIdentifier: { someone: [{ teamID: TEAM, isFreeProvisioningTeam: true }] } }));
  // Not TwinDesk's for this device: another app, and TwinDesk for another device. Never moved.
  const unrelated = {
    'other-app.mobileprovision': { ...f.profiles[0], Entitlements: { ...f.profiles[0].Entitlements, 'application-identifier': `${TEAM}.com.example.other` } },
    'other-device.mobileprovision': { ...f.profiles[0], ProvisionedDevices: [IPHONE] },
  };
  for (const [name, p] of Object.entries(unrelated)) await fs.writeFile(path.join(f.profileDir, name), JSON.stringify(p));
  const r = { f, renew, tmp, prefs, unrelated, xcode: [], logs: [] };
  r.fresh = (patch = {}) => Promise.all(f.profiles.map((p, i) => fs.writeFile(path.join(f.profileDir, `fresh-${i}.mobileprovision`),
    JSON.stringify({ ...p, ExpirationDate: new Date((f.ends + 6 * 86400) * 1000).toISOString(), ...patch }))));
  r.exec = async (file, args, options) => {
    if (file === '/usr/bin/xcrun' && args[0] === 'xcodebuild') {
      r.xcode.push(args);
      options.signal?.throwIfAborted();
      // Xcode sees no TwinDesk profiles for the device: they were moved aside.
      const names = await fs.readdir(f.profileDir);
      assert.deepEqual(names.sort(), Object.keys(unrelated).sort(), 'only the device’s three TwinDesk profiles are moved aside');
      return xcodebuild(r, args, options);
    }
    return f.exec(file, args, options);
  };
  r.renewer = r.renew.create({ exec: r.exec, tmp, prefs, profileDir: f.profileDir, log: (l) => r.logs.push(l) });
  r.names = async () => (await fs.readdir(f.profileDir)).sort();
  r.leftovers = async () => (await fs.readdir(f.temp)).filter((n) => n.startsWith('.twindesk-'));
  r.original = ['0.mobileprovision', '1.mobileprovision', '2.mobileprovision', ...Object.keys(unrelated)].sort();
  return r;
}

test('guarded automatic renewal: pinned arguments, profiles moved aside, fresh profiles validated, backup removed', async (t) => {
  const r = await renewRig(t, async (rig) => { await rig.fresh(); return { stdout: '** BUILD SUCCEEDED **', stderr: '' }; });
  const developer = create({ exec: r.f.exec, ipa: r.f.ipa, tmp: r.f.temp, profileDirs: [r.f.profileDir], renewer: r.renewer });
  const receipt = await developer.install(target, new AbortController().signal, { force: true });
  assert.equal(receipt.renewal.state, 'renewed');
  assert.equal(receipt.renewal.before, r.f.ends);
  assert.equal(receipt.expires, r.f.ends + 6 * 86400, 'the fresh profiles are the ones installed');
  const argv = r.xcode[0];
  assert.deepEqual(argv, r.renew.args(path.dirname(argv[argv.indexOf('-project') + 1]), IPAD));
  for (const pin of ['-allowProvisioningUpdates', 'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${TEAM}`, `id=${IPAD}`]) assert.ok(argv.includes(pin), pin);
  assert.ok(!argv.some((a) => /DeviceRegistration|authenticationKey|archive|Manual/i.test(a)), argv.join(' '));
  assert.deepEqual(await r.names(), [...Object.keys(r.unrelated), 'fresh-0.mobileprovision', 'fresh-1.mobileprovision', 'fresh-2.mobileprovision'].sort(),
    'old TwinDesk profiles are gone after a validated renewal; unrelated ones untouched');
  assert.deepEqual(await r.leftovers(), [], 'no backup or lock left');
  assert.deepEqual(await fs.readdir(r.tmp), []);
  // The shipped project: automatic signing for the pinned team, exactly TwinDesk's three IDs, nothing else.
  const pbx = await fs.readFile(path.join(r.renew.PROJECT, 'TwinDeskProvision.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.deepEqual([...new Set([...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]))].sort(), ids.slice().sort());
  assert.ok([...pbx.matchAll(/DEVELOPMENT_TEAM = (\w+);/g)].every((m) => m[1] === TEAM));
  assert.ok(!/ENTITLEMENTS|PROVISIONING_PROFILE|Manual/.test(pbx));
});

test('guarded automatic renewal restores the moved profiles on failure, abort, bad profiles or a new certificate', async (t) => {
  const NEW = 'B'.repeat(40);
  const cases = {
    failure: async () => { throw Object.assign(new Error('Command failed'), { code: 65, stdout: 'error: No profiles for com.twindesk.ios' }); },
    'no device': async (rig) => { await rig.fresh({ ProvisionedDevices: [IPHONE] }); return { stdout: '' }; },
    'other certificate': async (rig) => { await rig.fresh({ DeveloperCertificates: '<array><data>YQ==</data></array>' }); return { stdout: '' }; },
    'new certificate': async (rig) => {
      rig.f.valid = `${rig.f.valid}\n  2) ${NEW} "Apple Development: Test fixture (NEWCERT123)"`;
      await rig.fresh();
      return { stdout: '' };
    },
    'no account': null,
    'no pinned certificate': null,
  };
  for (const [name, xcodebuild] of Object.entries(cases)) {
    const r = await renewRig(t, xcodebuild || (async () => assert.fail('xcodebuild must not run')));
    if (name === 'no account') await fs.writeFile(r.prefs, JSON.stringify({ IDEProvisioningTeamByIdentifier: { someone: [{ teamID: 'OTHERTEAM1' }] } }));
    if (name === 'no pinned certificate') r.f.valid = r.f.valid.replace(IDENTITY, 'A'.repeat(40));
    const result = await r.renewer.renew(new AbortController().signal, { udid: IPAD });
    const expected = { failure: 'failed', 'no device': 'failed', 'other certificate': 'failed', 'new certificate': 'failed', 'no account': 'account', 'no pinned certificate': 'failed' }[name];
    assert.equal(result.state, expected, name);
    if (name === 'no account') assert.equal(result.message, 'Sign in to Xcode › Settings › Accounts');
    if (name === 'no pinned certificate') assert.equal(result.message, 'The Mac’s TwinDesk signing certificate is unavailable');
    if (name === 'new certificate') {
      assert.match(result.message, /Xcode created a new certificate/);
      assert.deepEqual(result.identities, [NEW]);
      assert.ok(r.logs.some((l) => l.includes(NEW) && /not revoked/.test(l)));
      assert.ok(!r.f.calls.some((c) => c.includes('delete-identity') || c.includes('delete-certificate')), 'nothing revoked or deleted');
    }
    if (!xcodebuild) assert.equal(r.xcode.length, 0, name);
    const names = await r.names();
    for (const old of r.original) assert.ok(names.includes(old), `${name}: ${old} restored`);
    assert.deepEqual(await r.leftovers(), [], name);
  }

  // Abort during xcodebuild: rejects, and the profiles are back.
  const controller = new AbortController();
  const r = await renewRig(t, (rig, args, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    controller.abort();
  }));
  await assert.rejects(r.renewer.renew(controller.signal, { udid: IPAD }), { name: 'AbortError' });
  assert.deepEqual(await r.names(), r.original);
  assert.deepEqual(await r.leftovers(), []);
});

test('a backup that cannot be restored is kept and recovered by the next run; one renewal at a time', async (t) => {
  const fsp = require('node:fs/promises');
  const r = await renewRig(t, async () => { throw Object.assign(new Error('Command failed'), { code: 65 }); });
  const link = t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
  assert.equal((await r.renewer.renew(new AbortController().signal, { udid: IPAD })).state, 'failed');
  const kept = (await r.leftovers()).filter((n) => n.startsWith('.twindesk-profile-backup-'));
  assert.equal(kept.length, 1, 'the backup is preserved');
  assert.equal((await fs.readdir(path.join(r.f.temp, kept[0]))).length, 3);
  assert.ok(r.logs.some((l) => /kept in/.test(l)));
  link.mock.restore();
  // The next run puts them back first (then Xcode fails again and they are restored again).
  assert.equal((await r.renewer.renew(new AbortController().signal, { udid: IPAD })).state, 'failed');
  assert.deepEqual(await r.names(), r.original);
  assert.deepEqual(await r.leftovers(), []);

  // A live lock: no run. A lock left by a dead process: taken over.
  const lock = path.join(r.f.temp, '.twindesk-profile-renew.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
  const xcode = r.xcode.length;
  assert.equal((await r.renewer.renew(new AbortController().signal, { udid: IPAD })).state, 'failed');
  assert.equal(r.xcode.length, xcode);
  assert.deepEqual(await r.names(), r.original);
  await fs.writeFile(path.join(lock, 'pid'), '999999');
  await r.renewer.renew(new AbortController().signal, { udid: IPAD });
  assert.equal(r.xcode.length, xcode + 1);
  assert.deepEqual(await r.leftovers(), []);
  // A malformed UDID never runs anything.
  assert.equal((await r.renewer.renew(new AbortController().signal, { udid: 'nope' })).state, 'failed');
  assert.equal(r.xcode.length, xcode + 1);
});

test('profileExpiry: the earliest valid TwinDesk profile for the exact device, read only and remembered until the profiles change', async (t) => {
  const f = await fixture(t);
  const decodes = () => f.calls.filter((c) => c[0] === '/usr/bin/security' && c[1] === 'cms').length;
  assert.equal(await f.developer.profileExpiry(IPAD), f.ends, 'the earliest of app, share and broadcast');
  assert.equal(decodes(), 3);
  assert.equal(await f.developer.profileExpiry(IPAD.toLowerCase()), f.ends, 'the exact device in any spelling');
  assert.equal(decodes(), 3, 'remembered: no decode while the profiles are unchanged');
  assert.ok(f.calls.every((c) => (c[0] === '/usr/bin/security' && c[1] === 'cms') || (c[0] === '/usr/bin/plutil' && c[1] === '-extract')),
    'no signing, keychain identity, Xcode, CoreDevice or IPA work');
  assert.equal(await f.developer.profileExpiry(IPHONE), 0, 'another device has no profiles');
  assert.equal(await f.developer.profileExpiry('not-a-device'), 0);
  await assert.rejects(f.developer.profileExpiry(IPAD, AbortSignal.abort()), { name: 'AbortError' });

  const write = (i, p) => fs.writeFile(path.join(f.profileDir, i + '.mobileprovision'), JSON.stringify(p));
  await fs.rm(path.join(f.profileDir, '2.mobileprovision'));
  assert.equal(await f.developer.profileExpiry(IPAD), 0, 'a missing extension profile arms nothing');
  await write(2, { ...f.profiles[2], Entitlements: { ...f.profiles[2].Entitlements, 'application-identifier': `${TEAM}.com.example.other` } });
  assert.equal(await f.developer.profileExpiry(IPAD), 0, 'another bundle does not count');
  await write(2, { ...f.profiles[2], ExpirationDate: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await f.developer.profileExpiry(IPAD), 0, 'an expired profile does not count');
  await write(2, f.profiles[2]);
  assert.equal(await f.developer.profileExpiry(IPAD), f.ends, 'valid again after the change');
});

test('no receipt: the selected paired iPad with TwinDesk installed arms automatic refresh from its cached profiles', async (t) => {
  const expiry = Date.parse('2026-12-03T11:43:35Z') / 1000; // 06:43:35 EST, the earliest cached profile
  const due = (expiry - 3 * 86400) * 1000; // 2026-11-30 06:43:35 EST
  const hour = 3600 * 1000;
  let clock = Date.parse('2026-11-26T12:06:00Z');
  t.mock.method(Date, 'now', () => clock);
  const ipad = { ...target };
  let installed = { bundleIdentifier: APP, version: '3.2.1' };
  let expires = expiry;
  let appsFail = false;
  const reads = [];
  const installs = [];
  const unlock = () => { throw Object.assign(new Error('Connect or unlock the iPad'), { kind: 'device' }); };
  let outcome = unlock;
  const developer = {
    bundled: () => true, list: async () => [ipad], stored: async () => null, storedInfo: () => null,
    apps: async () => { if (appsFail) throw new Error('unavailable'); return installed; },
    profileExpiry: async (u) => { reads.push(u); return expires; },
    install: async (d, s, opts) => { installs.push({ udid: d.udid, ...opts }); return outcome(s); },
  };
  let cfg = { on: false, mode: 'developer', localDevice: IPAD, auto: true };
  const lines = [];
  const link = Object.assign(new EventEmitter(), { send() {} });
  const sign = new IosSign({ link, developer, log: (l) => lines.push(l), cfg: () => cfg, setCfg: (x) => { cfg = { ...cfg, ...x }; } });
  t.after(() => sign.close());
  sign._release = () => {};
  const settle = async () => { await next(); await next(); while (sign.scanTask) await sign.scanTask; };
  const fires = async () => { sign.tried.clear(); const n = installs.length; sign._auto(); await settle(); return installs.length - n; };
  const prefix = `[ios-developer] automatic refresh for ${IPAD}`;
  cfg = { ...cfg, on: true };
  await sign._look();

  assert.deepEqual(reads, [IPAD], 'the cached profiles are read for the exact selected device');
  assert.deepEqual(installs, [], 'nothing before 3 days ahead of the earliest profile');
  assert.deepEqual(lines, [`[ios-developer] automatic refresh armed for ${IPAD} from cached profiles (no install receipt): `
    + 'profiles until 2026-12-03T11:43:35.000Z, due 2026-11-30T11:43:35.000Z (3 days before), retry every 6 h']);
  assert.equal(cfg.localInstalls, undefined, 'arming never writes a receipt');
  await sign._look();
  sign._auto();
  assert.equal(lines.length, 1, 'later scans and ticks do not log again');

  clock = due - 1;
  sign._auto();
  assert.equal(installs.length, 0);
  clock = due;
  sign._auto();
  assert.equal(installs.length, 1, 'due exactly cfg.days before the earliest profile');
  assert.deepEqual({ ...installs[0], onRenewal: undefined }, { udid: IPAD, minExpiry: 0, requireNewer: true, renewWithin: 3 * 86400, force: false, onRenewal: undefined });
  await settle();
  assert.equal(sign.view.devices[0].result.error.message, 'Connect or unlock the iPad', 'the existing result');
  assert.deepEqual(lines.slice(1), [`${prefix} (cached profiles): started`, `${prefix} (cached profiles): failed: Connect or unlock the iPad`]);
  assert.equal(cfg.localInstalls, undefined, 'a failed fallback refresh records nothing');
  clock = due + 6 * hour - 1;
  sign._auto();
  assert.equal(installs.length, 1, 'rests for cfg.retry (default 6 h)');
  clock = due + 6 * hour;
  sign._auto();
  assert.equal(installs.length, 2, 'retried after exactly 6 h');
  await settle();

  // Guards: on, mode, auto, the device's own switch and the exact selection.
  for (const [patch, why] of [[{ auto: false }, 'auto off'], [{ deviceAuto: { [IPAD]: false } }, 'paused for this device'],
    [{ mode: 'apple' }, 'Apple ID mode'], [{ localDevice: IPHONE }, 'another device selected'], [{ localDevice: undefined }, 'no explicit selection']]) {
    const saved = cfg;
    cfg = { ...cfg, ...patch };
    assert.equal(await fires(), 0, why);
    cfg = saved;
  }
  sign.devices = [{ ...ipad, coreId: 'DDD00000-1000-4000-8000-000000000000' }];
  assert.equal(await fires(), 0, 'another pairing of the same UDID is not the armed one');
  await sign._look();
  assert.equal(await fires(), 1, 'armed again on the next scan of the same pairing');

  // A receipt of an install made here keeps priority.
  cfg = { ...cfg, localInstalls: { [IPAD]: { expires: expiry + 30 * 86400 } } };
  assert.equal(await fires(), 0, 'a later receipt wins over the cached profiles');
  cfg = { ...cfg, localInstalls: { [IPAD]: { expires: expiry - 86400, version: '3.2.1' } } };
  assert.equal(await fires(), 1);
  assert.equal(installs.at(-1).minExpiry, expiry - 86400, 'the receipt still sets the floor');
  assert.equal(lines.at(-1), `${prefix} (install receipt): failed: Connect or unlock the iPad`);
  cfg = { ...cfg, localInstalls: undefined };
  await sign._look();
  assert.equal(await fires(), 1);

  // No installed evidence, another bundle, an unreadable inventory, missing or expired profiles: disarmed.
  const armedLines = () => lines.filter((l) => l.includes(' armed ')).length;
  const logged = armedLines();
  for (const [change, undo, why] of [
    [() => { installed = undefined; }, () => { installed = { bundleIdentifier: APP, version: '3.2.1' }; }, 'not installed'],
    [() => { installed = { bundleIdentifier: APP + '.share' }; }, () => { installed = { bundleIdentifier: APP, version: '3.2.1' }; }, 'another bundle'],
    [() => { appsFail = true; }, () => { appsFail = false; }, 'stale inventory'],
    [() => { expires = 0; }, () => { expires = expiry; }, 'missing or invalid profiles'],
    [() => { expires = Math.floor(clock / 1000) - 1; }, () => { expires = expiry; }, 'expired profiles']]) {
    change();
    await sign._look();
    assert.equal(await fires(), 0, why);
    undo();
    await sign._look();
  }
  assert.equal(armedLines(), logged, 'disarming and re-arming the same schedule logs no new arming');
  assert.equal(cfg.localInstalls, undefined);

  // cfg.days and cfg.retry move the schedule; the new one is logged once.
  cfg = { ...cfg, days: 4, retry: 1 };
  sign.tried.clear();
  clock = due - 86400 * 1000;
  sign._auto();
  await settle();
  assert.equal(lines.filter((l) => l.includes('armed')).at(-1), `[ios-developer] automatic refresh armed for ${IPAD} from cached profiles (no install receipt): `
    + 'profiles until 2026-12-03T11:43:35.000Z, due 2026-11-29T11:43:35.000Z (4 days before), retry every 1 h');
  assert.equal(installs.at(-1).renewWithin, 4 * 86400);
  const n = installs.length;
  clock += hour - 1;
  sign._auto();
  assert.equal(installs.length, n);
  clock += 1;
  sign._auto();
  assert.equal(installs.length, n + 1, 'cfg.retry 1 h');
  await settle();

  // Stopping the run cancels it: no receipt.
  outcome = (s) => new Promise((resolve, reject) => s.addEventListener('abort', () => reject(s.reason)));
  sign.tried.clear();
  sign._auto();
  sign.stop();
  await settle();
  assert.equal(sign.view.devices[0].result.error.message, 'Stopped');
  assert.equal(cfg.localInstalls, undefined);

  // Only the app's own successful install records a receipt, and then the receipt schedules.
  outcome = () => ({ udid: IPAD, expires: expiry + 7 * 86400, version: '3.2.1', bundleId: APP });
  assert.equal(await fires(), 1);
  assert.equal(cfg.localInstalls[IPAD].expires, expiry + 7 * 86400);
  assert.equal(lines.at(-1), `${prefix} (cached profiles): installed, profiles until 2026-12-10T11:43:35.000Z`);
  assert.equal(sign._armed(IPAD), null);
  assert.equal(await fires(), 0, 'the new receipt is not due');
});
