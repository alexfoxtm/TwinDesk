// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const TEAM = '5H4D7574Z4';
const IDENTITY = '80F731EE19E02914C4634D57E8F7B1ADDDD63FD2';
const APP = 'com.twindesk.ios';
const EXTENSIONS = [APP + '.broadcast', APP + '.share'];
const UDID = /^(?:[a-f0-9]{8}-[a-f0-9]{16}|[a-f0-9]{40})$/i;
const CORE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// The fork stages its own unsigned build (mac/scripts/stage-ios-ipa.sh) in the app's settings
// folder: <userData>/ios-developer/TwinDesk.ipa. A copy inside the app is only a legacy fallback.
const IPA = path.join(__dirname, 'ios-developer', 'TwinDesk.ipa');
const STORED = (userData) => path.join(userData, 'ios-developer', 'TwinDesk.ipa');
const NO_IPA = 'No TwinDesk iPad build stored yet';
const RENEW_FAILED = 'Xcode could not renew TwinDesk’s profiles';
const EXPIRED_NOT_RENEWED = 'TwinDesk’s profiles for this device have expired and Xcode could not renew them. Renew them in Xcode, then Refresh now';
const NONE_NOT_RENEWED = 'Xcode has no TwinDesk profiles for this device. Prepare them in Xcode, then Refresh now';

function pairedDevices(devices) {
  const paired = new Map();
  const ambiguous = new Set();
  const hardware = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    const hw = d?.hardwareProperties;
    const conn = d?.connectionProperties;
    const klass = hw?.deviceType;
    if (!UDID.test(hw?.udid) || !CORE_ID.test(d.identifier) || conn?.pairingState !== 'paired'
        || !['iPhone', 'iPad'].includes(klass)) continue;
    const udid = hw.udid.toUpperCase();
    const coreId = d.identifier.toUpperCase();
    const previousUdid = hardware.get(coreId);
    if (previousUdid && previousUdid !== udid) { ambiguous.add(udid); ambiguous.add(previousUdid); }
    hardware.set(coreId, udid);
    const prior = paired.get(udid);
    if (prior && (prior.coreId !== coreId || prior.klass !== klass)) {
      ambiguous.add(udid);
      continue;
    }
    paired.set(udid, {
      udid, coreId, klass,
      name: [prior?.name, String(d.deviceProperties?.name || '').slice(0, 80)].filter(Boolean).sort()[0] || '',
      developerMode: (!prior || prior.developerMode) && d.deviceProperties?.developerModeStatus === 'enabled',
      usb: !!prior?.usb || conn.transportType === 'wired', wifi: !!prior?.wifi || conn.transportType === 'localNetwork',
    });
  }
  return [...paired.values()].filter((d) => !ambiguous.has(d.udid));
}

function pinnedIdentity(list) {
  return list.split('\n').some((line) => {
    const match = /^\s*\d+\) ([A-F0-9]{40}) "Apple Development: .+ \(86RNYWFF97\)"\s*$/.exec(line);
    return match?.[1] === IDENTITY;
  });
}

function connectError(klass) {
  return Object.assign(new Error(klass === 'iPad' ? 'Connect or unlock the iPad' : 'Connect or unlock the iPhone'), { kind: 'device' });
}

function create({
  exec = promisify(execFile), ipa, ipas = ipa ? [ipa] : [IPA], tmp = os.tmpdir(), renewer = null,
  profileDirs = [
    path.join(os.homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
    path.join(os.homedir(), 'Library/MobileDevice/Provisioning Profiles'),
  ],
} = {}) {
  async function command(signal, file, args, timeout = 10000) {
    signal?.throwIfAborted();
    const { stdout } = await exec(file, args, { signal, timeout, maxBuffer: 4 * 1024 * 1024 });
    signal?.throwIfAborted();
    return stdout;
  }

  async function core(signal, args, seconds = 8) {
    const stdout = await command(signal, '/usr/bin/xcrun',
      ['devicectl', ...args, '-q', '--timeout', String(seconds), '--json-output', '/dev/stdout'], (seconds + 2) * 1000);
    return JSON.parse(stdout).result;
  }

  async function list(signal) {
    return pairedDevices((await core(signal, ['list', 'devices']))?.devices);
  }

  async function apps(target, signal) {
    const result = await core(signal, ['device', 'info', 'apps', '--device', target.coreId,
      '--filter', `bundleIdentifier == "${APP}"`]);
    if (!Array.isArray(result?.apps)) throw new Error('Could not check the installed app');
    return result.apps.find((a) => a.bundleIdentifier === APP);
  }

  async function verifyTarget(selected, signal) {
    let devices;
    try { devices = await list(signal); } catch {
      signal.throwIfAborted();
      throw connectError(selected.klass);
    }
    const exact = devices.filter((d) => d.udid === selected.udid);
    if (exact.length !== 1 || exact[0].coreId !== selected.coreId) throw connectError(selected.klass);
    const target = exact[0];
    if (!target.developerMode) throw new Error('Turn on Developer Mode on the selected device');
    try {
      const lock = await core(signal, ['device', 'info', 'lockState', '--device', target.coreId]);
      if (lock?.passcodeRequired !== false) throw connectError(target.klass);
    } catch {
      signal.throwIfAborted();
      throw connectError(target.klass);
    }
    return target;
  }

  async function extract(signal, plist, key, format = 'raw') {
    return (await command(signal, '/usr/bin/plutil', ['-extract', key, format, '-o', '-', plist])).trim();
  }

  async function profiles(work, udid, signal) {
    const chosen = new Map();
    let expired = false; // a profile that passed every check but has run out
    const plist = path.join(work, 'profile.plist');
    const now = Date.now();
    for (const dir of profileDirs) {
      let files;
      try { files = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
        signal.throwIfAborted();
        if (!file.isFile() || !file.name.endsWith('.mobileprovision')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file.name));
          const snapshot = path.join(work, 'candidate.mobileprovision');
          await fs.writeFile(snapshot, raw);
          await fs.writeFile(plist, await command(signal, '/usr/bin/security', ['cms', '-D', '-i', snapshot]));
          const entitlements = JSON.parse(await extract(signal, plist, 'Entitlements', 'json'));
          const appId = entitlements['application-identifier'];
          const id = [APP, ...EXTENSIONS].find((bundle) => appId === `${TEAM}.${bundle}`);
          if (!id || entitlements['get-task-allow'] !== true || entitlements['com.apple.developer.team-identifier'] !== TEAM) continue;
          const team = JSON.parse(await extract(signal, plist, 'TeamIdentifier', 'json'));
          const platform = JSON.parse(await extract(signal, plist, 'Platform', 'json'));
          const provisioned = JSON.parse(await extract(signal, plist, 'ProvisionedDevices', 'json'));
          if (!Array.isArray(team) || !team.includes(TEAM) || !Array.isArray(platform) || !platform.includes('iOS')
              || !Array.isArray(provisioned) || !provisioned.some((device) => typeof device === 'string' && device.toUpperCase() === udid)) continue;
          const expiration = await extract(signal, plist, 'ExpirationDate');
          const certs = await extract(signal, plist, 'DeveloperCertificates', 'xml1');
          const leaf = [...certs.matchAll(/<data>([^<]+)<\/data>/g)]
            .map((m) => Buffer.from(m[1], 'base64')).find((der) => crypto.createHash('sha1').update(der).digest('hex').toUpperCase() === IDENTITY);
          if (!leaf) continue;
          const cert = new crypto.X509Certificate(leaf);
          if (!cert.subject.split('\n').includes(`OU=${TEAM}`) || !(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo))) continue;
          const expires = Math.floor(Date.parse(expiration) / 1000);
          if (!entitlements['keychain-access-groups']?.some((group) => group === appId || group === `${TEAM}.*`)) continue;
          if (!(expires * 1000 > now)) { expired = true; continue; }
          if ((chosen.get(id)?.expires || 0) >= expires) continue;
          chosen.set(id, { raw, expires, entitlement: {
            'application-identifier': appId,
            'com.apple.developer.team-identifier': TEAM,
            'keychain-access-groups': [appId],
            'get-task-allow': true,
          } });
        } catch {
          signal.throwIfAborted();
          // Other apps, teams and unreadable profiles are never candidates.
        }
      }
    }
    if (chosen.size !== 1 + EXTENSIONS.length) {
      throw Object.assign(new Error(expired ? 'TwinDesk’s profiles for this device have expired' : 'Xcode needs to prepare TwinDesk for the selected device'), { expired });
    }
    return chosen;
  }

  // The first IPA that exists: the stored fork build, then the legacy copy inside the app.
  function source() {
    const file = ipas.find((f) => existsSync(f));
    return file ? { file, kind: ipas.indexOf(file) === 0 ? 'stored' : 'bundled' } : null;
  }

  async function inventory(work, signal, file) {
    await command(signal, '/usr/bin/ditto', ['-x', '-k', file, work], 60000);
    const top = await fs.readdir(work, { withFileTypes: true });
    if (top.length !== 1 || top[0].name !== 'Payload' || !top[0].isDirectory()) throw new Error('The stored TwinDesk app is invalid');
    const payload = path.join(work, 'Payload');
    const contents = await fs.readdir(payload, { withFileTypes: true });
    if (contents.length !== 1 || !contents[0].isDirectory() || contents[0].name !== 'TwinDesk.app') throw new Error('The stored TwinDesk app is invalid');
    const app = path.join(payload, contents[0].name);
    const plugins = path.join(app, 'PlugIns');
    const entries = await fs.readdir(plugins, { withFileTypes: true });
    if (entries.length !== EXTENSIONS.length || entries.some((e) => !e.isDirectory() || !e.name.endsWith('.appex'))) throw new Error('The bundled TwinDesk extensions are invalid');
    const targets = new Map();
    let version = '';
    for (const bundle of [...entries.map((e) => path.join(plugins, e.name)), app]) {
      const info = path.join(bundle, 'Info.plist');
      const id = await extract(signal, info, 'CFBundleIdentifier');
      if (targets.has(id) || (bundle === app ? id !== APP : !EXTENSIONS.includes(id))) throw new Error('The bundled TwinDesk app IDs are invalid');
      const families = JSON.parse(await extract(signal, info, 'UIDeviceFamily', 'json'));
      if (!families.includes(1) || !families.includes(2)) throw new Error('The bundled TwinDesk app must support iPhone and iPad');
      targets.set(id, bundle);
      if (id === APP) version = await extract(signal, info, 'CFBundleShortVersionString');
    }
    if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('The stored TwinDesk app has no valid version');
    return { app, targets, version };
  }

  // The IPA the next install would use, checked with the same inventory rules: {kind, version, file,
  // valid}. Remembered per file, size and time, so the page can show it without unpacking it again.
  let known = null;
  async function stored(signal = new AbortController().signal) {
    const src = source();
    if (!src) { known = null; return null; }
    const st = await fs.stat(src.file);
    const key = `${src.file}\0${st.size}\0${st.mtimeMs}`;
    if (known?.key === key) return known.info;
    const work = await fs.mkdtemp(path.join(tmp, 'twindesk-ios-ipa-'));
    try {
      const { version } = await inventory(work, signal, src.file);
      known = { key, info: { kind: src.kind, version, file: src.file, valid: true } };
    } catch (error) {
      signal.throwIfAborted();
      known = { key, info: { kind: src.kind, version: '', file: src.file, valid: false, error: str(error.message) } };
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
    return known.info;
  }

  function minimum(chosen) {
    return Math.min(...[APP, ...EXTENSIONS].map((id) => chosen.get(id).expires));
  }

  // renewWithin (seconds): profiles running out sooner are renewed through Xcode first (guarded,
  // mac/ios-provision-profiles.js); force: Refresh now always asks. onRenewal({state, message,
  // before, after}) hears the outcome; a blocked renewal still installs with valid cached profiles.
  async function install(selected, signal, { minExpiry = 0, requireNewer = false, renewWithin = 3 * 86400, force = false, onRenewal } = {}) {
    if (!selected || !UDID.test(selected.udid) || !CORE_ID.test(selected.coreId)) throw connectError(selected?.klass);
    const src = source();
    if (!src) throw new Error(NO_IPA);
    const target = await verifyTarget(selected, signal);
    if (!pinnedIdentity(await command(signal, '/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']))) {
      throw new Error('The Mac’s TwinDesk signing certificate is unavailable');
    }
    const work = await fs.mkdtemp(path.join(tmp, 'twindesk-ios-developer-'));
    try {
      const scan = async () => {
        const dir = await fs.mkdtemp(path.join(work, 'profiles-'));
        try { return await profiles(dir, target.udid, signal); } finally { await fs.rm(dir, { recursive: true, force: true }); }
      };
      let selectedProfiles = null;
      let missing = null;
      try { selectedProfiles = await scan(); } catch (error) {
        signal.throwIfAborted();
        missing = error;
      }
      const before = selectedProfiles ? minimum(selectedProfiles) : 0;
      let renewal = null;
      if (renewer && (force || !selectedProfiles || before * 1000 - Date.now() <= renewWithin * 1000)) {
        let outcome;
        try { outcome = await renewer.renew(signal, { udid: target.udid }); } catch {
          signal.throwIfAborted();
          outcome = { state: 'failed', message: RENEW_FAILED };
        }
        renewal = { ...outcome, before };
        signal.throwIfAborted();
        try { selectedProfiles = await scan(); missing = null; } catch (error) {
          signal.throwIfAborted();
          missing = error;
          selectedProfiles = null;
        }
        renewal.after = selectedProfiles ? minimum(selectedProfiles) : 0;
        if (renewal.after > before && renewal.state !== 'account') renewal.state = 'renewed';
        // 'the current profiles stay in use' (managed) only holds while valid profiles remain.
        if (!selectedProfiles && ['managed', 'failed'].includes(renewal.state)) renewal.message = missing?.expired ? EXPIRED_NOT_RENEWED : NONE_NOT_RENEWED;
        onRenewal?.(renewal);
      }
      if (!selectedProfiles) {
        if (renewal && renewal.state !== 'renewed' && renewal.message) throw Object.assign(new Error(renewal.message), { kind: 'xcode' });
        throw missing;
      }
      const components = [APP, ...EXTENSIONS].map((bundleId) => ({ bundleId, expires: selectedProfiles.get(bundleId).expires }));
      const expires = Math.min(...components.map((p) => p.expires));
      if (expires <= minExpiry && requireNewer) return null;
      if (expires < minExpiry) throw new Error('Xcode needs to prepare a newer copy of TwinDesk for the selected device');
      const { app, targets, version } = await inventory(path.join(work, 'ipa'), signal, src.file);
      const ent = path.join(work, 'entitlements.plist');
      const requirement = `=anchor apple generic and certificate leaf = H"${IDENTITY}" and certificate leaf[subject.OU] = "${TEAM}"`;
      for (const [id, bundle] of targets) {
        const { raw, entitlement } = selectedProfiles.get(id);
        await fs.writeFile(path.join(bundle, 'embedded.mobileprovision'), raw, { flag: 'wx' });
        await fs.writeFile(ent, JSON.stringify(entitlement));
        await command(signal, '/usr/bin/plutil', ['-convert', 'xml1', ent]);
        await command(signal, '/usr/bin/codesign', ['--force', '--sign', IDENTITY, '--timestamp=none',
          '--generate-entitlement-der', '--entitlements', ent, bundle], 60000);
        await command(signal, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, bundle], 60000);
      }
      await verifyTarget(target, signal);
      if (expires * 1000 <= Date.now()) throw new Error('Xcode needs to prepare TwinDesk for the selected device');
      let result;
      try {
        result = await core(signal, ['device', 'install', 'app', '--device', target.coreId, app], 120);
      } catch {
        signal.throwIfAborted();
        throw new Error('The device didn’t install TwinDesk');
      }
      if (!Array.isArray(result?.installedApplications) || !result.installedApplications.some((entry) => entry?.bundleID === APP || entry?.bundleIdentifier === APP)) {
        throw new Error('The device did not confirm that it installed TwinDesk');
      }
      return { udid: target.udid, device: target.name || target.klass, team: TEAM, identity: IDENTITY, bundleId: APP, version, expires, components,
        ipa: src.kind, ...(renewal ? { renewal: { state: renewal.state, before: renewal.before, after: renewal.after } } : {}) };
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  // bundled(): an IPA is there to install (stored, or the legacy copy in the app).
  return { bundled: () => !!source(), source, stored, storedInfo: () => known?.info || null, list, apps, install };
}

function str(v, n = 250) { return typeof v === 'string' ? v.slice(0, n) : ''; }

module.exports = { create, pairedDevices, pinnedIdentity, TEAM, IDENTITY, APP, IPA, STORED, NO_IPA };

// node mac/ios-developer-sign.js --verify FILE.ipa: the staging script's check, same inventory rules.
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== '--verify') {
    console.error('Usage: node ios-developer-sign.js --verify TwinDesk.ipa');
    process.exitCode = 2;
  } else {
    create({ ipas: [path.resolve(process.argv[3])] }).stored().then((info) => {
      if (!info?.valid) throw new Error(info?.error || 'The IPA is missing');
      console.log(JSON.stringify({ bundleId: APP, version: info.version }));
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
