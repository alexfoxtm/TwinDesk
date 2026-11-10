// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fork isolation beyond bundle ids: a supplied release profile must match this fork, the Mac app
// must not share Electron storage, SMB, or SSH names with upstream, updates must not install
// upstream builds, and own-app filters must skip both identities. Does not sign, import a profile,
// touch Keychain, or write ~/.ssh.
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { applicationIdentifier, check } = require('../scripts/check-provision-profile.js');
const { ALIAS, alias, knownHosts, renderConfig } = require('../../shared/sshconfig.js');
const { Updates, REPO } = require('../../shared/updates.js');
const { LINKS } = require('../../shared/about.js');
const { ownPhoneApp } = require('../../shared/nowplaying.js');

const FORK_APP = 'io.github.alexfoxtm.twindesk';
const FORK_CAMERA = 'io.github.alexfoxtm.twindesk.camera';
const SECRET = 'SECRET-DEVICE-UDID-999';

function plist(id) {
  return Buffer.from(
    `<plist><key>application-identifier</key><string>${id}</string>` +
    `<key>ProvisionedDevices</key><array><string>${SECRET}</string></array></plist>`,
    'latin1',
  );
}

function main() {
  const build = read('mac/build-app.sh');
  const checkAt = build.indexOf('scripts/check-provision-profile.js');
  const embedAt = build.indexOf('cp "$MAC_APP_PROFILE"');
  assert.ok(checkAt > 0 && embedAt > checkAt, 'a supplied profile is checked before it is embedded');
  assert.match(build, /if \[ -n "\$\{MAC_APP_PROFILE:-\}" \]/);
  assert.match(build, /if \[ -n "\$\{MAC_CAMERA_PROFILE:-\}" \]/);
  assert.match(build, /check-provision-profile\.js "\$MAC_APP_PROFILE" "io\.github\.alexfoxtm\.twindesk"/);
  assert.match(build, /check-provision-profile\.js "\$MAC_CAMERA_PROFILE" "io\.github\.alexfoxtm\.twindesk\.camera"/);
  assert.match(build, /electron-packager "\$STAGE" TwinDesk /);
  assert.match(read('mac/package.json'), /"productName": "TwinDesk"/);
  const checker = read('mac/scripts/check-provision-profile.js');
  assert.doesNotMatch(checker, /\bsecurity\b/);
  assert.doesNotMatch(checker, /child_process/);

  const appId = check(plist(`ABCDE12345.${FORK_APP}`), FORK_APP);
  assert.deepEqual(appId, { ok: true, id: FORK_APP });
  const cameraId = check(plist(`ABCDE12345.${FORK_CAMERA}`), FORK_CAMERA);
  assert.deepEqual(cameraId, { ok: true, id: FORK_CAMERA });
  assert.equal(applicationIdentifier(plist(`ABCDE12345.${FORK_APP}`)), FORK_APP);
  const macProfile = Buffer.from(`<plist><key>com.apple.application-identifier</key><string>ABCDE12345.${FORK_APP}</string></plist>`);
  assert.equal(check(macProfile, FORK_APP, 'ABCDE12345').ok, true);
  assert.equal(check(macProfile, FORK_APP, 'ZZZZZ99999').ok, false);
  assert.equal(check(plist(`ABCDE12345.${FORK_APP}.*`), FORK_APP).ok, false);
  assert.equal(check(plist('ABCDE12345.org.macshare.mac'), FORK_APP).ok, false);
  assert.equal(check(Buffer.from('<plist></plist>'), FORK_APP).ok, false);

  const mainJs = read('mac/main.js');
  const nameAt = mainJs.indexOf("app.setName('AlexfoxtmTwinDesk')");
  const logsAt = mainJs.indexOf("app.setAppLogsPath(path.join(require('os').homedir(), 'Library', 'Logs', 'AlexfoxtmTwinDesk'))");
  const applogAt = mainJs.indexOf("require('../shared/applog.js').start(app)");
  const meshAt = mainJs.indexOf("require('./mesh/main.js')");
  assert.ok(nameAt > 0 && logsAt > nameAt && applogAt > logsAt && meshAt > applogAt);
  assert.match(mainJs, /cacheDir: path\.join\(app\.getPath\('temp'\), 'AlexfoxtmTwinDesk ReZume'\)/);
  assert.doesNotMatch(mainJs, /'TwinDesk ReZume'/);
  assert.match(read('windows/main.js'), /'TwinDesk ReZume'/);
  assert.match(read('linux/main.js'), /'TwinDesk ReZume'/);

  for (const rel of ['mac/smb.js', 'mac/scripts/smb-share.sh', 'mac/scripts/smb-unshare.sh']) {
    const source = read(rel);
    assert.match(source, /alexfoxtmtd/);
    assert.match(source, /AlexfoxtmTwinDesk/);
  }
  for (const rel of ['mac/main.js', 'mac/mesh/main.js']) {
    const source = read(rel);
    assert.match(source, /SMB_USER/);
    assert.match(source, /SMB_SHARE/);
  }
  const unshare = read('mac/scripts/smb-unshare.sh');
  assert.match(unshare, /sharing -r "\$SHARE"/);
  assert.doesNotMatch(unshare, /sharing -r MacShare/);
  assert.doesNotMatch(unshare, /deleteUser macshare/);
  assert.match(read('mac/main.js'), /url: `smb:\/\/\$\{host\}\/\$\{SMB_SHARE\}`/);
  assert.match(read('mac/mesh/main.js'), /url: `smb:\/\/\$\{host\}\/\$\{SMB_SHARE\}`/);
  assert.match(read('windows/smb.js'), /const SHARE = 'MacShare'/);
  assert.match(read('linux/smb.js'), /const SHARE = 'MacShare'/);

  const ssh = read('mac/ssh-client.js');
  assert.match(ssh, /const SSH_SCOPE = 'fork'/);
  assert.match(ssh, /alexfoxtm_twindesk_ed25519/);
  assert.match(ssh, /alexfoxtm_twindesk_known_hosts/);
  assert.match(ssh, /alexfoxtm-twindesk@/);
  assert.match(ssh, /setHost\(null, SSH_SCOPE\)/);
  assert.doesNotMatch(ssh, /setHost\(null\)/);
  assert.match(ssh, /knownHosts\(keys, SSH_SCOPE\)/);
  const terminal = read('mac/terminal.js');
  assert.match(terminal, /alexfoxtm-twindesk:\$\{String\(id\)/);
  assert.match(terminal, /\$\{AUTH_KEYS\}\.alexfoxtm-twindesk-tmp/);
  assert.match(read('mac/ui-terminal.js'), /ssh alexfoxtm-twindesk/);
  assert.equal(ALIAS, 'twindesk');
  assert.equal(alias('fork'), 'alexfoxtm-twindesk');
  assert.equal(knownHosts(['ssh-ed25519 AAAA']), 'twindesk ssh-ed25519 AAAA\n');
  const upstreamBlock = [
    '# >>> twindesk (managed by TwinDesk, do not edit)',
    'Host twindesk',
    '  HostName 10.0.0.2',
    '# <<< twindesk',
    '',
  ].join('\n');
  const withFork = renderConfig(upstreamBlock, {
    address: '10.0.0.8', port: 22, user: 'alex',
    identityFile: '/tmp/alexfoxtm_twindesk_ed25519',
    knownHostsFile: '/tmp/alexfoxtm_twindesk_known_hosts',
  }, 'fork');
  assert.match(withFork, /Host twindesk\n/);
  assert.match(withFork, /Host alexfoxtm-twindesk\n/);
  const cleared = renderConfig(withFork, null, 'fork');
  assert.match(cleared, /Host twindesk\n/);
  assert.doesNotMatch(cleared, /alexfoxtm-twindesk/);

  assert.equal(REPO, 'InukaAsith/TwinDesk');
  const idle = { current: '1.0.0', getSettings: () => ({}), fetch() {} };
  const upstreamUpdates = new Updates({ ...idle, platform: 'win' });
  assert.equal(upstreamUpdates.api, 'https://api.github.com/repos/InukaAsith/TwinDesk/releases/latest');
  const forkUpdates = new Updates({ ...idle, platform: 'mac', repo: 'alexfoxtm/TwinDesk' });
  assert.equal(forkUpdates.api, 'https://api.github.com/repos/alexfoxtm/TwinDesk/releases/latest');
  assert.equal(forkUpdates.releasesPage, 'https://github.com/alexfoxtm/TwinDesk/releases');
  const rejected = new Updates({ ...idle, platform: 'mac', repo: 'https://evil.example/x' });
  assert.equal(rejected.repo, REPO);
  assert.match(mainJs, /repo: 'alexfoxtm\/TwinDesk'/);
  assert.match(read('mac/mesh/main.js'), /repo: 'alexfoxtm\/TwinDesk'/);
  assert.doesNotMatch(read('windows/main.js'), /repo: 'alexfoxtm\/TwinDesk'/);
  assert.doesNotMatch(read('linux/main.js'), /repo: 'alexfoxtm\/TwinDesk'/);
  assert.equal(LINKS.github, 'https://github.com/InukaAsith/TwinDesk');
  assert.equal(LINKS.releases, 'https://github.com/InukaAsith/TwinDesk/releases');
  for (const rel of ['mac/ipc.js', 'mac/mesh/ipc.js']) {
    const ipc = read(rel);
    assert.match(ipc, /github: 'https:\/\/github\.com\/alexfoxtm\/TwinDesk'/);
    assert.match(ipc, /releases: 'https:\/\/github\.com\/alexfoxtm\/TwinDesk\/releases'/);
    assert.match(ipc, /upstream: 'https:\/\/github\.com\/InukaAsith\/TwinDesk\/releases'/);
  }
  assert.match(read('windows/ipc.js'), /const \{ LINKS \} = require\('\.\.\/shared\/about\.js'\)/);
  assert.match(read('linux/ipc.js'), /const \{ LINKS \} = require\('\.\.\/shared\/about\.js'\)/);
  const aboutCopy = 'InukaAsith/TwinDesk builds are a different app. They are not installed as updates.';
  assert.match(read('mac/ui-about.js'), new RegExp(aboutCopy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(read('android/app/src/main/java/com/twindesk/android/Updates.kt'), /REPO = "alexfoxtm\/TwinDesk"/);
  assert.match(read('android/app/src/main/java/com/twindesk/android/MainActivity.kt'), /github.com\/alexfoxtm\/TwinDesk\/releases/);
  assert.match(read('android/app/src/main/java/com/twindesk/android/MainActivity.kt'), new RegExp(aboutCopy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const notifs = read('mac-helper/Sources/macshare-helper/Notifs.swift');
  assert.match(notifs, /"io\.github\.alexfoxtm\.twindesk"/);
  assert.match(notifs, /"org\.macshare\.mac"/);
  assert.match(notifs, /"com\.github\.Electron"/);
  const activity = read('mac/activity.js');
  assert.match(activity, /io\\.github\\.alexfoxtm\\.twindesk/);
  assert.match(activity, /org\\.macshare\\./);
  assert.match(activity, /com\\.twindesk\\./);
  const fclip = read('mac/fclip.js');
  assert.match(fclip, /id\.startsWith\('io\.github\.alexfoxtm\.twindesk'\)/);
  assert.match(fclip, /id\.startsWith\('org\.macshare\.'\)/);
  assert.match(fclip, /!ownBundle\(src\.front\)/);
  assert.equal(ownPhoneApp('com.twindesk.android'), true);
  assert.equal(ownPhoneApp('io.github.alexfoxtm.twindesk.android'), true);
  assert.equal(ownPhoneApp('com.spotify.music'), false);
  assert.match(read('shared/notif-guard.js'), /twindesk\|macshare/);
}

function failure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-profile-check-'));
  const wrong = path.join(dir, 'wrong.mobileprovision');
  const empty = path.join(dir, 'empty.mobileprovision');
  const script = path.join(root, 'mac/scripts/check-provision-profile.js');
  try {
    fs.writeFileSync(wrong, plist('ABCDE12345.org.macshare.mac'));
    fs.writeFileSync(empty, Buffer.from(`<plist><string>${SECRET}</string></plist>`));
    const rejected = spawnSync(process.execPath, [script, wrong, FORK_APP, 'MAC_APP_PROFILE'], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /MAC_APP_PROFILE does not match the expected App ID and team for io\.github\.alexfoxtm\.twindesk/);
    assert.equal(rejected.stderr.includes(SECRET), false);
    assert.equal(rejected.stdout.includes(SECRET), false);
    const missing = spawnSync(process.execPath, [script, empty, FORK_APP, 'MAC_APP_PROFILE'], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /has no application-identifier for io\.github\.alexfoxtm\.twindesk/);
    assert.equal(missing.stderr.includes(SECRET), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
failure();
console.log('fork-isolation: ok');
