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
const IPA = path.join(__dirname, 'ios-developer', 'TwinDesk.ipa');

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
  exec = promisify(execFile), ipa = IPA, tmp = os.tmpdir(),
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
          if (!(expires * 1000 > now) || (chosen.get(id)?.expires || 0) >= expires) continue;
          if (!entitlements['keychain-access-groups']?.some((group) => group === appId || group === `${TEAM}.*`)) continue;
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
    if (chosen.size !== 1 + EXTENSIONS.length) throw new Error('Xcode needs to prepare TwinDesk for the selected device');
    return chosen;
  }

  async function inventory(work, signal) {
    await command(signal, '/usr/bin/ditto', ['-x', '-k', ipa, work], 60000);
    const payload = path.join(work, 'Payload');
    const contents = await fs.readdir(payload, { withFileTypes: true });
    if (contents.length !== 1 || !contents[0].isDirectory() || !contents[0].name.endsWith('.app')) throw new Error('The bundled TwinDesk app is invalid');
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
    return { app, targets, version };
  }

  async function install(selected, signal, { minExpiry = 0, requireNewer = false } = {}) {
    if (!selected || !UDID.test(selected.udid) || !CORE_ID.test(selected.coreId)) throw connectError(selected?.klass);
    if (!existsSync(ipa)) throw new Error('This Mac build doesn’t include TwinDesk for iPhone and iPad');
    const target = await verifyTarget(selected, signal);
    if (!pinnedIdentity(await command(signal, '/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']))) {
      throw new Error('The Mac’s TwinDesk signing certificate is unavailable');
    }
    const work = await fs.mkdtemp(path.join(tmp, 'twindesk-ios-developer-'));
    try {
      const selectedProfiles = await profiles(work, target.udid, signal);
      const components = [APP, ...EXTENSIONS].map((bundleId) => ({ bundleId, expires: selectedProfiles.get(bundleId).expires }));
      const expires = Math.min(...components.map((p) => p.expires));
      if (expires <= minExpiry && requireNewer) return null;
      if (expires < minExpiry) throw new Error('Xcode needs to prepare a newer copy of TwinDesk for the selected device');
      const { app, targets, version } = await inventory(work, signal);
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
      return { udid: target.udid, device: target.name || target.klass, team: TEAM, identity: IDENTITY, bundleId: APP, version, expires, components };
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  return { bundled: () => existsSync(ipa), list, apps, install };
}

module.exports = { create, pairedDevices, pinnedIdentity, TEAM, IDENTITY, APP };
