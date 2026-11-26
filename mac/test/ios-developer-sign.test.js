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

test('the renewer only runs the pinned, manually signed, provisioning-only xcodebuild', async (t) => {
  const renew = require('../ios-provision-profiles.js');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-provision-test-'));
  t.after(() => fs.rm(temp, { force: true, recursive: true }));
  const argv = renew.args('/w');
  assert.ok(argv.includes('-allowProvisioningUpdates'));
  assert.ok(!argv.some((a) => /DeviceRegistration|Automatic|authenticationKey|-exportArchive|archive/i.test(a)), argv.join(' '));
  for (const pin of ['CODE_SIGN_STYLE=Manual', `DEVELOPMENT_TEAM=${TEAM}`, `CODE_SIGN_IDENTITY=${IDENTITY}`, 'generic/platform=iOS']) assert.ok(argv.includes(pin), pin);
  // The shipped project: manual signing only, exactly TwinDesk's three IDs, the pinned team and certificate.
  const pbx = await fs.readFile(path.join(renew.PROJECT, 'TwinDeskProvision.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.ok(!/Automatic/.test(pbx));
  assert.deepEqual([...new Set([...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]))].sort(), ids.slice().sort());
  assert.ok([...pbx.matchAll(/CODE_SIGN_STYLE = (\w+);/g)].every((m) => m[1] === 'Manual'));
  assert.ok([...pbx.matchAll(/DEVELOPMENT_TEAM = (\w+);/g)].every((m) => m[1] === TEAM));
  assert.ok([...pbx.matchAll(/CODE_SIGN_IDENTITY = (\w+);/g)].every((m) => m[1] === IDENTITY));

  assert.equal(renew.classify('error: No Accounts: Add a new account in Accounts settings.', 65).message, 'Sign in to Xcode › Settings › Accounts');
  assert.equal(renew.classify('error: No account for team "5H4D7574Z4".', 65).state, 'account');
  assert.equal(renew.classify('Provisioning profile "iOS Team Provisioning Profile: com.twindesk.ios" is Xcode managed, but signing settings require a manually managed profile.', 65).state, 'managed');
  assert.equal(renew.classify('** BUILD SUCCEEDED **', 0).state, 'current');
  assert.equal(renew.classify('something else', 65).state, 'failed');

  const prefs = path.join(temp, 'xcode.plist');
  const calls = [];
  let teams = { someone: [{ teamID: 'OTHERTEAM1' }] };
  const exec = async (file, args, options) => {
    calls.push([file, ...args]);
    options.signal?.throwIfAborted();
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(teams) };
    assert.equal(file, '/usr/bin/xcrun');
    const work = path.dirname(args[args.indexOf('-project') + 1]);
    assert.ok(work.startsWith(temp), 'a private copy, never the app’s own Resources');
    await fs.access(path.join(work, 'TwinDeskProvision.xcodeproj', 'project.pbxproj'));
    throw Object.assign(new Error('Command failed'), { code: 65,
      stdout: 'error: Provisioning profile "iOS Team Provisioning Profile: com.twindesk.ios" is Xcode managed, but signing settings require a manually managed profile.' });
  };
  const renewer = renew.create({ exec, tmp: temp, prefs });
  assert.deepEqual(await renewer.renew(), { state: 'account', message: 'Sign in to Xcode › Settings › Accounts' });
  assert.ok(!calls.some((c) => c[0] === '/usr/bin/xcrun'), 'no Xcode call without the pinned team signed in');
  teams = { someone: [{ teamID: TEAM, isFreeProvisioningTeam: true }] };
  assert.equal((await renewer.renew()).state, 'managed');
  const xcode = calls.filter((c) => c[0] === '/usr/bin/xcrun');
  assert.equal(xcode.length, 1);
  assert.deepEqual(xcode[0].slice(1), renew.args(path.dirname(xcode[0][xcode[0].indexOf('-project') + 1])));
  assert.deepEqual(await fs.readdir(temp), [], 'the private copy is removed');
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

  // renew() with a missing project: 'failed', no Xcode call, nothing left in tmp.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-provision-missing-'));
  t.after(() => fs.rm(tmp, { force: true, recursive: true }));
  const calls = [];
  const exec = async (file, args) => {
    calls.push(file);
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify({ someone: [{ teamID: TEAM }] }) };
    assert.fail(`unexpected ${file} ${args.join(' ')}`);
  };
  const result = await createRenewer({ exec, tmp, project: path.join(tmp, 'missing-project'), prefs: path.join(tmp, 'prefs.plist') }).renew();
  assert.equal(result.state, 'failed');
  assert.ok(!calls.includes('/usr/bin/xcrun'));
  assert.deepEqual(await fs.readdir(tmp), []);
});
