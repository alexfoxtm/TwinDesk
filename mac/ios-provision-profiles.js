// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Profile-only renewal of TwinDesk's three development profiles through Xcode (developer mode,
// mac/ios-developer-sign.js). xcodebuild -help: "-allowProvisioningUpdates … For automatically
// signed targets, xcodebuild will create and update profiles, app IDs, and certificates. For
// manually signed targets, xcodebuild will download missing or updated provisioning profiles."
// So this only ever runs the manually signed, provisioning-only project in mac/ios-provision with
// the pinned team and certificate, and never:
//   - automatic signing (it may create or revoke certificates and create App IDs),
//   - -allowProvisioningDeviceRegistration (no device registration),
//   - ad-hoc signing, Apple ID mode or any account endpoint,
//   - moving, hiding or deleting Xcode's cached profiles.
// A free Personal Team only has Xcode-managed profiles, which Xcode refuses for manually signed
// targets ("is Xcode managed, but signing settings require a manually managed profile"); that is
// reported as 'managed' (renew them in Xcode) and the valid cached profiles stay in use.
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const TEAM = '5H4D7574Z4';
const IDENTITY = '80F731EE19E02914C4634D57E8F7B1ADDDD63FD2';
const PROJECT = path.join(__dirname, 'ios-provision');
const XCODE_PREFS = path.join(os.homedir(), 'Library/Preferences/com.apple.dt.Xcode.plist');
const SIGN_IN = 'Sign in to Xcode › Settings › Accounts';
const MANAGED = 'Xcode manages TwinDesk’s profiles for this team. Renew them in Xcode; the current profiles stay in use until then';

// The exact, only command this module runs (work: a private copy of the project).
function args(work) {
  return ['xcodebuild', '-project', path.join(work, 'TwinDeskProvision.xcodeproj'), '-scheme', 'App',
    '-configuration', 'Debug', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
    '-derivedDataPath', path.join(work, 'build'), '-allowProvisioningUpdates',
    'CODE_SIGN_STYLE=Manual', `DEVELOPMENT_TEAM=${TEAM}`, `CODE_SIGN_IDENTITY=${IDENTITY}`, 'build'];
}

// What xcodebuild said, in one of: ok | account | managed | unavailable | failed.
function classify(output, code) {
  const text = String(output || '');
  if (/No Accounts?\b|No account for team|Accounts settings|accounts have valid credentials|not signed in/i.test(text)) return { state: 'account', message: SIGN_IN };
  if (/is Xcode managed, but signing settings require a manually managed profile/.test(text)) return { state: 'managed', message: MANAGED };
  if (/unable to find utility "xcodebuild"|requires Xcode|active developer directory .* is a command line tools instance/i.test(text)) return { state: 'unavailable', message: 'Install Xcode to renew TwinDesk’s profiles' };
  if (code === 0) return { state: 'current', message: '' };
  return { state: 'failed', message: 'Xcode could not renew TwinDesk’s profiles' };
}

function create({ exec = promisify(execFile), tmp = os.tmpdir(), project = PROJECT, prefs = XCODE_PREFS } = {}) {
  // Whether Xcode lists the pinned team for a signed-in account. Only team IDs are looked at; no
  // account names or credentials leave this function.
  async function account(signal) {
    try {
      const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'IDEProvisioningTeamByIdentifier', 'json', '-o', '-', prefs],
        { signal, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
      const byAccount = JSON.parse(stdout);
      return Object.values(byAccount || {}).some((teams) => Array.isArray(teams) && teams.some((t) => t?.teamID === TEAM));
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async function renew(signal = new AbortController().signal) {
    signal.throwIfAborted();
    if (!await account(signal)) return { state: 'account', message: SIGN_IN };
    const work = await fs.mkdtemp(path.join(tmp, 'twindesk-ios-provision-'));
    try {
      // A private copy: the app's own Resources stay untouched (and signed).
      await fs.cp(project, work, { recursive: true, filter: (src) => !/(?:^|\/)(?:build|xcuserdata)(?:\/|$)/.test(path.relative(project, src)) });
      let output = '';
      let code = 0;
      try {
        const r = await exec('/usr/bin/xcrun', args(work), { signal, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
        output = `${r.stdout || ''}\n${r.stderr || ''}`;
      } catch (error) {
        signal.throwIfAborted();
        output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
        code = typeof error.code === 'number' ? error.code : 1;
      }
      return classify(output, code);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  return { account, renew };
}

module.exports = { create, args, classify, SIGN_IN, MANAGED, PROJECT, TEAM, IDENTITY };
