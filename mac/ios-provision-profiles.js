// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Renewal of TwinDesk's three development profiles through Xcode (developer mode,
// mac/ios-developer-sign.js). A free Personal Team only has Xcode-managed profiles, which only
// automatic signing renews. xcodebuild -help: "-allowProvisioningUpdates … For automatically signed
// targets, xcodebuild will create and update profiles, app IDs, and certificates." So each run is
// guarded so that only the three profiles change:
//   - the project (mac/ios-provision) has three empty targets with TwinDesk's existing bundle IDs
//     and no capabilities or entitlements, for team 5H4D7574Z4 only;
//   - the destination is the selected, already registered device; never
//     -allowProvisioningDeviceRegistration, never Apple ID mode or an account endpoint;
//   - before: the pinned certificate 80F731EE… (Apple Development, 86RNYWFF97) must be a valid
//     signing identity on this Mac (certificate and private key), or nothing runs;
//   - after: a new Apple Development identity fails the renewal and is reported, never revoked;
//   - Xcode reuses a valid profile, so the selected device's current TwinDesk profiles (exactly
//     these three IDs and team, in Xcode's UserData folder) are moved aside to a backup first. On
//     failure or abort they are moved back; on success the new profiles must list the device and
//     the pinned certificate, or the old ones are moved back. A backup that can't be restored is
//     kept, and recovered by the next run.
'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { pinnedIdentity, TEAM, IDENTITY, APP } = require('./ios-developer-sign.js');

const IDS = [APP, APP + '.share', APP + '.broadcast'];
const UDID = /^(?:[a-f0-9]{8}-[a-f0-9]{16}|[a-f0-9]{40})$/i;
const PROJECT = path.join(__dirname, 'ios-provision');
const XCODE_PREFS = path.join(os.homedir(), 'Library/Preferences/com.apple.dt.Xcode.plist');
const PROFILES = path.join(os.homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles');
const BACKUP_PREFIX = '.twindesk-profile-backup-';
const SIGN_IN = 'Sign in to Xcode › Settings › Accounts';
const NO_CERT = 'The Mac’s TwinDesk signing certificate is unavailable';
const NEW_CERT = 'Xcode created a new certificate. TwinDesk didn’t use or revoke it; check Xcode › Settings › Accounts';
const FAILED = 'Xcode could not renew TwinDesk’s profiles';
const MANAGED = 'Xcode manages TwinDesk’s profiles for this team. Renew them in Xcode; the current profiles stay in use until then';

// The exact, only xcodebuild command (work: a private copy of the project).
function args(work, udid) {
  return ['xcodebuild', '-project', path.join(work, 'TwinDeskProvision.xcodeproj'), '-scheme', 'App',
    '-configuration', 'Debug', '-destination', `id=${udid}`,
    '-derivedDataPath', path.join(work, 'build'), '-allowProvisioningUpdates',
    'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${TEAM}`, 'build'];
}

// What xcodebuild said, in one of: current | account | managed | unavailable | failed.
function classify(output, code) {
  const text = String(output || '');
  if (/No Accounts?\b|No account for team|Accounts settings|accounts have valid credentials|not signed in/i.test(text)) return { state: 'account', message: SIGN_IN };
  if (/is Xcode managed, but signing settings require a manually managed profile/.test(text)) return { state: 'managed', message: MANAGED };
  if (/unable to find utility "xcodebuild"|requires Xcode|active developer directory .* is a command line tools instance/i.test(text)) return { state: 'unavailable', message: 'Install Xcode to renew TwinDesk’s profiles' };
  if (code === 0) return { state: 'current', message: '' };
  return { state: 'failed', message: FAILED };
}

// Apple Development identities (SHA-1) in `security find-identity -v -p codesigning` output.
function developmentIdentities(list) {
  return [...String(list).matchAll(/^\s*\d+\) ([A-F0-9]{40}) "Apple Development: [^"]*"\s*$/gm)].map((m) => m[1]).sort();
}

function create({
  exec = promisify(execFile), tmp = os.tmpdir(), project = PROJECT, prefs = XCODE_PREFS, profileDir = PROFILES,
  log = (line) => console.error(`ios-provision: ${line}`),
} = {}) {
  const run = async (signal, file, argv, timeout = 15000) => (await exec(file, argv, { signal, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;

  // Whether Xcode lists the pinned team for a signed-in account. Only team IDs are looked at; no
  // account names or credentials leave this function.
  async function account(signal) {
    try {
      const byAccount = JSON.parse(await run(signal, '/usr/bin/plutil', ['-extract', 'IDEProvisioningTeamByIdentifier', 'json', '-o', '-', prefs]));
      return Object.values(byAccount || {}).some((teams) => Array.isArray(teams) && teams.some((t) => t?.teamID === TEAM));
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async function identities(signal) {
    return run(signal, '/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  }

  // One profile's facts, or null when it isn't one of TwinDesk's for this team.
  async function inspect(file, work, signal) {
    try {
      const plist = path.join(work, 'inspect.plist');
      await fs.writeFile(plist, await run(signal, '/usr/bin/security', ['cms', '-D', '-i', file]));
      const get = async (key, format = 'raw') => (await run(signal, '/usr/bin/plutil', ['-extract', key, format, '-o', '-', plist])).trim();
      const ent = JSON.parse(await get('Entitlements', 'json'));
      const id = IDS.find((bundle) => ent['application-identifier'] === `${TEAM}.${bundle}`);
      const team = JSON.parse(await get('TeamIdentifier', 'json'));
      if (!id || ent['com.apple.developer.team-identifier'] !== TEAM || !Array.isArray(team) || !team.includes(TEAM)) return null;
      let devices = [];
      try { devices = JSON.parse(await get('ProvisionedDevices', 'json')); } catch { signal.throwIfAborted(); }
      const certs = [...(await get('DeveloperCertificates', 'xml1')).matchAll(/<data>([^<]+)<\/data>/g)]
        .map((m) => crypto.createHash('sha1').update(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).digest('hex').toUpperCase());
      return { id, devices: Array.isArray(devices) ? devices.map((d) => String(d).toUpperCase()) : [], certs,
        expires: Math.floor(Date.parse(await get('ExpirationDate')) / 1000) || 0 };
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  // TwinDesk's profiles for the device in Xcode's folder: [{name, file, id, devices, certs, expires}].
  async function scan(udid, work, signal) {
    let names;
    try { names = await fs.readdir(profileDir); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const found = [];
    for (const name of names.filter((n) => n.endsWith('.mobileprovision')).sort()) {
      signal.throwIfAborted();
      const file = path.join(profileDir, name);
      const facts = await inspect(file, work, signal);
      if (facts && facts.devices.includes(udid)) found.push({ name, file, ...facts });
    }
    return found;
  }

  // Moves each backed-up profile back unless a file of that name is there now; a backup that
  // can't be fully restored stays where it is.
  async function restore(backup) {
    let names = [];
    try { names = await fs.readdir(backup); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    let ok = true;
    for (const name of names.filter((n) => n.endsWith('.mobileprovision'))) {
      const target = path.join(profileDir, name);
      try {
        await fs.link(path.join(backup, name), target); // never replaces an existing file
        await fs.rm(path.join(backup, name));
      } catch (error) {
        if (error.code === 'EEXIST') { await fs.rm(path.join(backup, name)).catch(() => { ok = false; }); continue; }
        ok = false;
        log(`could not restore ${name}: ${error.code || error.message}; kept in ${backup}`);
      }
    }
    if (ok) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    return ok;
  }

  // Backups left by an interrupted run go back first.
  async function recover() {
    let names = [];
    try { names = await fs.readdir(path.dirname(profileDir)); } catch { return true; }
    let ok = true;
    for (const name of names.filter((n) => n.startsWith(BACKUP_PREFIX))) ok = await restore(path.join(path.dirname(profileDir), name)) && ok;
    return ok;
  }

  async function renew(signal = new AbortController().signal, { udid } = {}) {
    signal.throwIfAborted();
    if (!UDID.test(udid || '')) return { state: 'failed', message: FAILED };
    udid = udid.toUpperCase();
    if (!await account(signal)) return { state: 'account', message: SIGN_IN };
    let before;
    try { before = await identities(signal); } catch { signal.throwIfAborted(); return { state: 'failed', message: NO_CERT }; }
    if (!pinnedIdentity(before)) return { state: 'failed', message: NO_CERT };

    // One renewal at a time on this Mac (the app and the CLI); a lock left by a dead process is taken over.
    const lock = path.join(path.dirname(profileDir), '.twindesk-profile-renew.lock');
    const take = async () => { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'pid'), String(process.pid)); };
    try { await take(); } catch {
      let alive = true;
      try {
        const pid = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0); else alive = false;
      } catch (error) { alive = error.code === 'EPERM'; }
      try {
        if (alive) throw new Error('busy');
        await fs.rm(lock, { recursive: true, force: true });
        await take();
      } catch {
        signal.throwIfAborted();
        log('another renewal is running');
        return { state: 'failed', message: FAILED };
      }
    }
    let work;
    let backup;
    let restoreNeeded = false;
    try {
      if (!await recover()) return { state: 'failed', message: FAILED };
      work = await fs.mkdtemp(path.join(tmp, 'twindesk-ios-provision-'));
      // A private copy: the app's own Resources stay untouched (and signed).
      await fs.cp(project, path.join(work, 'project'), { recursive: true, filter: (src) => !/(?:^|\/)(?:build|xcuserdata)(?:\/|$)/.test(path.relative(project, src)) });
      const current = await scan(udid, work, signal);
      backup = await fs.mkdtemp(path.join(path.dirname(profileDir), BACKUP_PREFIX));
      restoreNeeded = true;
      for (const p of current) await fs.rename(p.file, path.join(backup, p.name)); // same volume: atomic
      if (current.length) log(`moved aside ${current.map((p) => `${p.id} ${p.name}`).join(', ')}`);

      let output = '';
      let code = 0;
      try {
        const r = await exec('/usr/bin/xcrun', args(path.join(work, 'project'), udid), { signal, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
        output = `${r.stdout || ''}\n${r.stderr || ''}`;
      } catch (error) {
        signal.throwIfAborted();
        output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
        code = typeof error.code === 'number' ? error.code : 1;
      }
      const added = developmentIdentities(await identities(signal)).filter((sha) => !developmentIdentities(before).includes(sha));
      if (added.length) {
        log(`new Apple Development identity after renewal: ${added.join(', ')} (not revoked)`);
        return { state: 'failed', message: NEW_CERT, identities: added };
      }
      const outcome = classify(output, code);
      if (outcome.state !== 'current') return outcome;
      // The fresh profiles: each ID's newest lists the device and the pinned certificate.
      const fresh = await scan(udid, work, signal);
      const good = IDS.every((id) => {
        const newest = fresh.filter((p) => p.id === id).sort((a, b) => b.expires - a.expires)[0];
        return newest && newest.certs.includes(IDENTITY) && newest.expires * 1000 > Date.now();
      });
      if (!good) {
        log('the new profiles don’t list the device and the pinned certificate');
        return { state: 'failed', message: FAILED };
      }
      restoreNeeded = false;
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      log(`renewed ${IDS.map((id) => `${id} until ${new Date(Math.max(...fresh.filter((p) => p.id === id).map((p) => p.expires)) * 1000).toISOString()}`).join(', ')}`);
      return { state: 'current', message: '' };
    } catch (error) {
      signal.throwIfAborted();
      log(`renewal stopped: ${error.code || error.message}`);
      return { state: 'failed', message: FAILED };
    } finally {
      if (restoreNeeded && backup && !await restore(backup).catch(() => false)) log(`profiles kept in ${backup}`);
      if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { account, renew, scan, recover };
}

module.exports = { create, args, classify, developmentIdentities, SIGN_IN, NO_CERT, NEW_CERT, FAILED, MANAGED, PROJECT, PROFILES, TEAM, IDENTITY, IDS };
