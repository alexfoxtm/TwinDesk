// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/fork-install.sh against a fake checkout and stub tools. Does not build, sign, or install.
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoScript = path.join(__dirname, '..', 'fork-install.sh');
const repoBuild = path.join(__dirname, '..', 'build-app.sh');
const repoCounter = path.join(__dirname, '..', 'scripts', 'fork-build.sh');
const repoBadging = path.join(__dirname, '..', 'scripts', 'apk-badging.sh');
const bash = '/bin/bash';

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function snapshot(dir) {
  const out = [];
  function walk(current) {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}\0${stat.size}\0${fs.readFileSync(full).toString('base64')}`);
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function callsOf(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function called(calls, name) {
  return calls.filter((line) => line.split('\t')[1] === name);
}

function makeStubs(bin, stubDir) {
  const log = path.join(stubDir, 'calls.log');
  const header = `#!/bin/bash
printf '%s\\t%s' "$(date +%s)" "$(basename "$0")" >> ${shellQuote(log)}
for arg in "$@"; do printf '\\t%s' "$arg" >> ${shellQuote(log)}; done
printf '\\n' >> ${shellQuote(log)}
`;
  write(path.join(bin, 'git'), `${header}
if [ "$1" = "-C" ]; then shift 2; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then printf 'true\\n'; exit 0; fi
if [ "$1" = "status" ]; then
  if [ -f ${shellQuote(path.join(stubDir, 'dirty'))} ]; then printf ' M mac/x\\n'; fi
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--short" ]; then printf 'aaaaaaaa\\n'; exit 0; fi
if [ "$1" = "rev-parse" ]; then printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; exit 0; fi
if [ "$1" = "log" ]; then printf 'test commit\\n'; exit 0; fi
printf 'git stub: %s\\n' "$*" >&2
exit 1
`, 0o755);

  write(path.join(bin, 'osascript'), `${header}exit 0\n`, 0o755);
  // cp -R onto the destination path, the way ditto copies a folder's contents.
  // A wrong destination shows up in the tree; a bare "exit 0" would hide it.
  write(path.join(bin, 'ditto'), `${header}
if [ "$#" -lt 2 ]; then echo 'ditto: need src and dest' >&2; exit 1; fi
mkdir -p "$2"
cp -R "$1"/. "$2"/
if [ -n "\${STUB_DITTO_FAIL:-}" ]; then exit 1; fi
exit 0
`, 0o755);
  write(path.join(bin, 'plutil'), `#!/bin/bash
[ "$1" = -extract ] && [ "$3" = raw ] || exit 1
sed -n "s/^$2=//p" "$4"
`, 0o755);
  write(path.join(bin, 'aapt'), `${header}
[ "$1" = dump ] && [ "$2" = badging ] && [ -f "$3" ] || exit 1
printf "package: name='io.github.alexfoxtm.twindesk.android' versionCode='%s' versionName='3.2.1'\\n" "\${STUB_APK_VERSION_CODE:-100074}"
`, 0o755);
  write(path.join(bin, 'open'), `${header}exit 0\n`, 0o755);
  write(path.join(bin, 'codesign'), `${header}
if [ -n "\${STUB_CODESIGN_INSTALL_FAIL:-}" ]; then
  last=""
  for a in "$@"; do last=$a; done
  case "$last" in
    */mac/dist/*) exit 0 ;;
  esac
  exit 1
fi
exit 0
`, 0o755);
  write(path.join(bin, 'npm'), `${header}
if [ -n "\${STUB_NPM_FAIL:-}" ]; then exit 1; fi
root=\${STUB_ROOT}
app="$root/mac/dist/TwinDesk Fork.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/app/mac/vendor"
printf 'x' > "$app/Contents/MacOS/TwinDesk"
printf 'CFBundleShortVersionString=3.2.1\\nCFBundleVersion=74\\n' > "$app/Contents/Info.plist"
src=\$(ls "$root"/android/dist/*-full.apk 2>/dev/null | sort | tail -1)
dest="$app/Contents/Resources/app/mac/vendor/twindesk-android-full.apk"
if [ -n "\${STUB_BAD_APK:-}" ]; then printf 'not-the-apk\\n' > "$dest"; else cp "$src" "$dest"; fi
exit 0
`, 0o755);
  write(path.join(bin, 'adb'), `${header}
if [ "$1" = "devices" ]; then
  if [ -f ${shellQuote(path.join(stubDir, 'devices-fail'))} ]; then echo 'adb: no server' >&2; exit 1; fi
  cat ${shellQuote(path.join(stubDir, 'devices'))}
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "install" ]; then
  if [ -f ${shellQuote(path.join(stubDir, 'install-fail'))} ]; then exit 1; fi
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ]; then
  if [ -f ${shellQuote(path.join(stubDir, 'phone-running'))} ]; then printf '99\\n'; exit 0; fi
  exit 1
fi
if [ "$1" = "-s" ] && [ "$3" = "logcat" ]; then
  if [ -f ${shellQuote(path.join(stubDir, 'phone-crash-large'))} ]; then
    printf 'E crash io.github.alexfoxtm.twindesk.android\\n'
    dd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\0' 'x'
    printf '\\n'
    exit 0
  fi
  if [ -f ${shellQuote(path.join(stubDir, 'phone-crash'))} ]; then printf 'E crash io.github.alexfoxtm.twindesk.android\\n'; fi
  exit 0
fi
exit 0
`, 0o755);
  // Real `ps -axo pid=,command=` lines: space-padded pid, one space, the command.
  // The helper sits under Contents/Frameworks and must not count as the main executable.
  write(path.join(bin, 'ps'), `${header}
mode=none
if [ -f ${shellQuote(path.join(stubDir, 'ps.mode'))} ]; then mode=$(cat ${shellQuote(path.join(stubDir, 'ps.mode'))}); fi
mainbin=""
if [ -f ${shellQuote(path.join(stubDir, 'main-bin'))} ]; then mainbin=$(cat ${shellQuote(path.join(stubDir, 'main-bin'))}); fi
approot=\${mainbin%/Contents/MacOS/*}
helper="\$approot/Contents/Frameworks/TwinDesk Helper (Renderer).app/Contents/MacOS/TwinDesk Helper (Renderer)"
print_helper() { printf '  5151 %s\\n' "\$helper"; }
print_main() { printf '  %s %s\\n' "\$1" "\$mainbin"; }
next_n() {
  n=0
  if [ -f ${shellQuote(path.join(stubDir, 'ps.count'))} ]; then n=$(cat ${shellQuote(path.join(stubDir, 'ps.count'))}); fi
  n=\$((n + 1))
  printf '%s\\n' "\$n" > ${shellQuote(path.join(stubDir, 'ps.count'))}
  printf '%s\\n' "\$n"
}
case "\$mode" in
  fail)
    echo 'ps: failed' >&2
    exit 1
    ;;
  forever)
    print_main 4242
    print_helper
    exit 0
    ;;
  count)
    n=\$(next_n)
    limit=\$(cat ${shellQuote(path.join(stubDir, 'ps.limit'))})
    if [ "\$n" -le "\$limit" ]; then print_main 4242; fi
    print_helper
    exit 0
    ;;
  appear)
    n=\$(next_n)
    if [ "\$n" -eq 1 ]; then print_main 4242
    elif [ "\$n" -ge 3 ]; then print_main 7777
    fi
    print_helper
    exit 0
    ;;
  second)
    quits=\$(awk -F '\\t' '\$2 == "osascript" { c++ } END { print c + 0 }' ${shellQuote(log)})
    if [ "\$quits" -lt 2 ]; then print_main 4242; fi
    print_helper
    exit 0
    ;;
  *)
    print_helper
    exit 0
    ;;
esac
`, 0o755);
  write(path.join(bin, 'pgrep'), `${header}echo 'pgrep stub should not be used' >&2; exit 99\n`, 0o755);
  write(path.join(stubDir, 'devices'), 'List of devices attached\n');
  return log;
}

function makeCheckout() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-install-'));
  const root = path.join(tmp, 'checkout');
  const bin = path.join(tmp, 'bin');
  const stubDir = path.join(tmp, 'stub');
  fs.mkdirSync(bin);
  fs.mkdirSync(stubDir);
  const calls = makeStubs(bin, stubDir);
  write(path.join(root, 'mac/build-app.sh'), [
    "FORK_APP='dist/TwinDesk Fork.app'",
    'APK_DEST=vendor/twindesk-android-full.apk',
    'FULL_APK=$(ls "$ROOT"/android/dist/*-full.apk 2>/dev/null | sort | tail -1)',
    '--executable-name=TwinDesk \\',
    '--app-bundle-id=io.github.alexfoxtm.twindesk --helper-bundle-id=io.github.alexfoxtm.twindesk.helper \\',
    '',
  ].join('\n'));
  write(path.join(root, 'android/app/build.gradle.kts'), [
    '        applicationId = "io.github.alexfoxtm.twindesk.android"',
    '        versionName = "3.2.1"',
    '',
  ].join('\n'));
  write(path.join(root, 'mac/phone-bridge.js'), "const APP_ID = 'io.github.alexfoxtm.twindesk.android';\n");
  write(path.join(root, 'mac/main.js'), "app.setAppLogsPath(path.join(require('os').homedir(), 'Library', 'Logs', 'AlexfoxtmTwinDesk'));\n");
  write(path.join(root, 'mac/package.json'), '{ "version": "3.2.1" }\n');
  write(path.join(root, 'ios/ForkBuild.xcconfig'), 'CURRENT_PROJECT_VERSION = 74\n');
  write(path.join(root, 'mac/scripts/fork-build.sh'), fs.readFileSync(repoCounter));
  write(path.join(root, 'mac/scripts/apk-badging.sh'), fs.readFileSync(repoBadging));
  write(path.join(root, 'shared/applog.js'), "const file = (i) => path.join(folder, i ? `TwinDesk.${i}.log` : 'TwinDesk.log');\n");
  write(path.join(root, 'android/gradlew'), `#!/bin/bash
printf '%s\\t%s' "$(date +%s)" "gradlew" >> ${shellQuote(calls)}
for arg in "$@"; do printf '\\t%s' "$arg" >> ${shellQuote(calls)}; done
printf '\\n' >> ${shellQuote(calls)}
mkdir -p app/build/outputs/apk/full/release
printf 'new-apk-bytes\\n' > app/build/outputs/apk/full/release/app-full-release.apk
`, 0o755);
  fs.copyFileSync(repoScript, path.join(root, 'mac/fork-install.sh'));
  fs.chmodSync(path.join(root, 'mac/fork-install.sh'), 0o755);
  const applications = path.join(root, 'Applications');
  fs.mkdirSync(applications);
  const mainBin = path.join(applications, 'TwinDesk Fork.app/Contents/MacOS/TwinDesk');
  write(path.join(stubDir, 'main-bin'), mainBin);
  return { tmp, root, bin, stubDir, calls, applications, mainBin };
}

function run(ctx, args, extra) {
  const result = spawnSync(bash, [path.join(ctx.root, 'mac/fork-install.sh'), ...args], {
    env: {
      PATH: `${ctx.bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: path.join(ctx.tmp, 'home'),
      TMPDIR: os.tmpdir(),
      STUB_ROOT: ctx.root,
      STUB_DIR: ctx.stubDir,
      FORK_INSTALL_APPLICATIONS: ctx.applications,
      FORK_INSTALL_APP_LOG: path.join(ctx.tmp, 'home/Library/Logs/AlexfoxtmTwinDesk/TwinDesk.log'),
      FORK_INSTALL_POLL_INTERVAL: '1',
      FORK_INSTALL_POST_WAIT: '0',
      FORK_INSTALL_ADB: path.join(ctx.bin, 'adb'),
      AAPT: path.join(ctx.bin, 'aapt'),
      FORK_INSTALL_LOG_DIR: path.join(ctx.root, 'mac/dist'),
      ...extra,
    },
    encoding: 'utf8',
  });
  return result;
}

function placeBuiltApp(ctx, apkBytes) {
  const vendor = path.join(ctx.root, 'mac/dist/TwinDesk Fork.app/Contents/Resources/app/mac/vendor');
  write(path.join(ctx.root, 'mac/dist/TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'x');
  write(path.join(ctx.root, 'mac/dist/TwinDesk Fork.app/Contents/Info.plist'),
    'CFBundleShortVersionString=3.2.1\nCFBundleVersion=74\n');
  write(path.join(vendor, 'twindesk-android-full.apk'), apkBytes || 'new-apk-bytes\n');
}

function placeInstalled(ctx, dir, build = '3.2.1') {
  const app = path.join(dir || ctx.applications, 'TwinDesk Fork.app');
  write(path.join(app, 'MARKER'), 'installed');
  write(path.join(app, 'Contents/Info.plist'), 'CFBundleVersion=' + build + '\n');
}

function commitApk(ctx, bytes) {
  write(path.join(ctx.root, 'android/dist/twindesk-full-3.2.1-aaaaaaaa-full.apk'), bytes || 'new-apk-bytes\n');
}

function assertQuitGuarded(calls) {
  const quits = called(calls, 'osascript');
  assert.ok(quits.length >= 1, calls.join('\n'));
  for (const line of quits) {
    assert.match(line, /if application id "io\.github\.alexfoxtm\.twindesk" is running then tell application id "io\.github\.alexfoxtm\.twindesk" to quit/);
  }
}

function stateChanging(calls) {
  const names = new Set(['gradlew', 'npm', 'osascript', 'ditto', 'open', 'codesign']);
  return calls.filter((line) => {
    const name = line.split('\t')[1];
    if (names.has(name)) return true;
    if (name === 'adb' && line.split('\t').includes('install')) return true;
    return false;
  });
}

function selectedApk(root) {
  const result = spawnSync(bash, ['-c', 'ls "$1"/android/dist/*-full.apk 2>/dev/null | sort | tail -1', 'bash', root], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  return result.stdout.trim();
}

function main() {
  const script = fs.readFileSync(repoScript, 'utf8');
  const build = fs.readFileSync(repoBuild, 'utf8');
  assert.match(build, /ls "\$ROOT"\/android\/dist\/\*-full\.apk 2>\/dev\/null \| sort \| tail -1/);
  assert.match(script, /ls "\$ROOT"\/android\/dist\/\*-full\.apk 2>\/dev\/null \| sort \| tail -1/);
  assert.doesNotMatch(script, /\b(kill|pkill)\b/);
  assert.doesNotMatch(script, /\bpgrep\b/);
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /ps -axo pid=,command=/);

  const help = spawnSync(bash, [repoScript, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /FORK_INSTALL_APPLICATIONS/);
  assert.match(help.stdout, /FORK_INSTALL_POLL_INTERVAL/);
  assert.match(help.stdout, /FORK_INSTALL_POST_WAIT/);
  const unknown = spawnSync(bash, [repoScript, '--nope'], { encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown flag/);

  const dry = makeCheckout();
  try {
    write(path.join(dry.root, 'android/dist/twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'old');
    write(path.join(dry.root, 'mac/dist/TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'old-build');
    placeInstalled(dry);
    const before = snapshot(dry.root);
    const result = run(dry, ['--dry-run']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(snapshot(dry.root), before);
    assert.equal(stateChanging(callsOf(dry.calls)).length, 0, callsOf(dry.calls).join('\n'));
    assert.match(result.stdout, /aaaaaaaa/);
    assert.match(result.stdout, /io\.github\.alexfoxtm\.twindesk/);
    assert.match(result.stdout, /twindesk-full-3\.2\.1-aaaaaaaa-full\.apk/);
    assert.match(result.stdout, /would run:.*gradlew/);
    assert.match(result.stdout, /would run:.*npm/);
    assert.match(result.stdout, /would run:.*osascript/);
    assert.match(result.stdout, /is running/);
    assert.match(result.stdout, /adb is not run during --dry-run/);
    assert.equal(called(callsOf(dry.calls), 'adb').length, 0);
    assert.doesNotMatch(result.stdout, /^phone: install -r /m);
  } finally {
    fs.rmSync(dry.tmp, { recursive: true, force: true });
  }

  const apks = makeCheckout();
  try {
    write(path.join(apks.root, 'android/dist/twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'sorts-after');
    write(path.join(apks.root, 'android/dist/twindesk-full-3.2.1-00000000-full.apk'), 'sorts-before');
    const result = run(apks, ['--no-install']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const dist = path.join(apks.root, 'android/dist');
    const left = fs.readdirSync(dist).filter((name) => name.endsWith('-full.apk')).sort();
    assert.deepEqual(left, ['twindesk-full-3.2.1-aaaaaaaa-full.apk']);
    const previous = fs.readdirSync(path.join(dist, 'previous')).sort();
    assert.deepEqual(previous, ['twindesk-full-3.2.1-00000000-full.apk', 'twindesk-full-3.2.1-zzzzzzzz-full.apk']);
    assert.ok(selectedApk(apks.root).endsWith('twindesk-full-3.2.1-aaaaaaaa-full.apk'));
    assert.match(result.stdout, /bundled apk matches/);
    assert.equal(called(callsOf(apks.calls), 'ditto').length, 0);
  } finally {
    fs.rmSync(apks.tmp, { recursive: true, force: true });
  }

  const mismatch = makeCheckout();
  try {
    const result = run(mismatch, ['--no-install'], { STUB_BAD_APK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256/);
    assert.equal(called(callsOf(mismatch.calls), 'ditto').length, 0);
    assert.equal(called(callsOf(mismatch.calls), 'osascript').length, 0);
  } finally {
    fs.rmSync(mismatch.tmp, { recursive: true, force: true });
  }

  const waited = makeCheckout();
  try {
    placeBuiltApp(waited);
    placeInstalled(waited);
    commitApk(waited);
    write(path.join(waited.stubDir, 'ps.mode'), 'count');
    write(path.join(waited.stubDir, 'ps.limit'), '4');
    const started = Math.floor(Date.now() / 1000);
    const result = run(waited, ['--skip-android', '--skip-mac', '--quit-timeout', '15']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const log = callsOf(waited.calls);
    assert.ok(called(log, 'ps').length >= 4, log.join('\n'));
    assert.deepEqual(called(log, 'ps')[0].split('\t').slice(2), ['-axo', 'pid=,command=']);
    assert.equal(called(log, 'pgrep').length, 0);
    assert.equal(called(log, 'osascript').length, 1, log.join('\n'));
    assertQuitGuarded(log);
    const ditto = called(log, 'ditto');
    assert.equal(ditto.length, 1);
    const dittoAt = Number(ditto[0].split('\t')[0]);
    assert.deepEqual(ditto[0].split('\t').slice(2), [
      path.join(waited.root, 'mac/dist/TwinDesk Fork.app'),
      path.join(waited.applications, 'TwinDesk Fork.app'),
    ], 'ditto copies the app onto its own path in Applications');
    assert.ok(dittoAt - started >= 2, `ditto at ${dittoAt}, started ${started}`);
    assert.equal(fs.readFileSync(path.join(waited.root, 'mac/dist/previous-before-aaaaaaaa/installed/TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.readFileSync(path.join(waited.applications, 'TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'utf8'), 'x');
    assert.equal(fs.existsSync(path.join(waited.applications, 'Contents')), false);
    assert.equal(fs.existsSync(path.join(waited.applications, 'TwinDesk Fork.app/MARKER')), false);
    assert.match(result.stdout, /main process exited/);
  } finally {
    fs.rmSync(waited.tmp, { recursive: true, force: true });
  }

  const stuck = makeCheckout();
  try {
    placeBuiltApp(stuck);
    placeInstalled(stuck);
    commitApk(stuck);
    write(path.join(stuck.stubDir, 'ps.mode'), 'forever');
    const result = run(stuck, ['--skip-android', '--skip-mac', '--quit-timeout', '2']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /still running/);
    assert.match(result.stderr, /left it in place/);
    assert.equal(called(callsOf(stuck.calls), 'ditto').length, 0);
    assert.equal(called(callsOf(stuck.calls), 'open').length, 0);
    assert.equal(called(callsOf(stuck.calls), 'osascript').length, 2);
    assertQuitGuarded(callsOf(stuck.calls));
    assert.equal(fs.readFileSync(path.join(stuck.applications, 'TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.existsSync(path.join(stuck.root, 'mac/dist/previous-before-aaaaaaaa')), false);
    assert.equal(fs.existsSync(path.join(stuck.root, 'mac/dist/TwinDesk Fork.app/Contents/MacOS/TwinDesk')), true);
  } finally {
    fs.rmSync(stuck.tmp, { recursive: true, force: true });
  }

  const emulator = makeCheckout();
  try {
    placeBuiltApp(emulator);
    commitApk(emulator);
    write(path.join(emulator.stubDir, 'devices'), 'List of devices attached\nemulator-5554\tdevice\n');
    const result = run(emulator, ['--skip-android', '--skip-mac']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /phone: skipped \(no physical device attached/);
    assert.equal(called(callsOf(emulator.calls), 'adb').some((line) => line.split('\t').includes('install')), false);
  } finally {
    fs.rmSync(emulator.tmp, { recursive: true, force: true });
  }

  const device = makeCheckout();
  try {
    placeBuiltApp(device);
    write(path.join(device.root, 'android/dist/twindesk-full-3.2.1-aaaaaaaa-full.apk'), 'new-apk-bytes\n');
    const result = run(device, ['--skip-android', '--skip-mac', '--device', '192.0.2.1:5555']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const installs = called(callsOf(device.calls), 'adb').filter((line) => line.split('\t').includes('install'));
    assert.equal(installs.length, 1, callsOf(device.calls).join('\n'));
    const parts = installs[0].split('\t');
    assert.deepEqual(parts.slice(2, 6), ['-s', '192.0.2.1:5555', 'install', '-r']);
    assert.ok(parts[6].endsWith('twindesk-full-3.2.1-aaaaaaaa-full.apk'));
    assert.match(result.stdout, /phone: crash buffer does not mention io\.github\.alexfoxtm\.twindesk\.android/);
    assert.match(result.stdout, /phone: io\.github\.alexfoxtm\.twindesk\.android is not running/);
    assert.equal(result.stderr, '', 'an app that is not running on the phone is not a failed step');
  } finally {
    fs.rmSync(device.tmp, { recursive: true, force: true });
  }

  const upstream = makeCheckout();
  try {
    write(path.join(upstream.root, 'mac/build-app.sh'), [
      "FORK_APP='dist/TwinDesk.app'",
      'APK_DEST=vendor/twindesk-android-full.apk',
      '--executable-name=TwinDesk \\',
      '--app-bundle-id=org.macshare.mac \\',
      '',
    ].join('\n'));
    write(path.join(upstream.root, 'android/app/build.gradle.kts'), '        applicationId = "org.macshare.mac.android"\n        versionName = "3.2.1"\n');
    write(path.join(upstream.root, 'mac/phone-bridge.js'), "const APP_ID = 'org.macshare.mac.android';\n");
    const result = run(upstream, ['--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not this fork/);
    assert.equal(stateChanging(callsOf(upstream.calls)).length, 0);
  } finally {
    fs.rmSync(upstream.tmp, { recursive: true, force: true });
  }

  const dirty = makeCheckout();
  try {
    write(path.join(dirty.stubDir, 'dirty'), '1');
    const refused = run(dirty, ['--dry-run']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not clean/);
    assert.equal(callsOf(dirty.calls).some((line) => line.includes('gradlew')), false);
    fs.writeFileSync(dirty.calls, '');
    const allowed = run(dirty, ['--dry-run', '--allow-dirty']);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.match(allowed.stdout, /\(dirty\)/);
    assert.equal(stateChanging(callsOf(dirty.calls)).length, 0);
  } finally {
    fs.rmSync(dirty.tmp, { recursive: true, force: true });
  }

  const dittoFail = makeCheckout();
  try {
    placeBuiltApp(dittoFail);
    placeInstalled(dittoFail);
    commitApk(dittoFail);
    const result = run(dittoFail, ['--skip-android', '--skip-mac'], { STUB_DITTO_FAIL: '1' });
    assert.notEqual(result.status, 0);
    const archive = path.join(dittoFail.root, 'mac/dist/previous-before-aaaaaaaa/installed');
    assert.match(result.stderr, /ditto into/);
    assert.match(result.stderr, /previous app restored/);
    assert.match(result.stderr, new RegExp(archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.readFileSync(path.join(dittoFail.applications, 'TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.readFileSync(path.join(archive, 'partial-TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'utf8'), 'x');
    assert.equal(fs.existsSync(path.join(archive, 'TwinDesk Fork.app')), false);
    assert.equal(called(callsOf(dittoFail.calls), 'open').length, 0);
  } finally {
    fs.rmSync(dittoFail.tmp, { recursive: true, force: true });
  }

  const signFail = makeCheckout();
  try {
    placeBuiltApp(signFail);
    placeInstalled(signFail);
    commitApk(signFail);
    const result = run(signFail, ['--skip-android', '--skip-mac'], { STUB_CODESIGN_INSTALL_FAIL: '1' });
    assert.notEqual(result.status, 0);
    const archive = path.join(signFail.root, 'mac/dist/previous-before-aaaaaaaa/installed');
    assert.match(result.stderr, /signature check/);
    assert.match(result.stderr, /previous app restored/);
    assert.match(result.stderr, new RegExp(archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.readFileSync(path.join(signFail.applications, 'TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.readFileSync(path.join(archive, 'partial-TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'utf8'), 'x');
    assert.equal(called(callsOf(signFail.calls), 'open').length, 0);
    assert.equal(called(callsOf(signFail.calls), 'ditto').length, 1);
  } finally {
    fs.rmSync(signFail.tmp, { recursive: true, force: true });
  }

  const appeared = makeCheckout();
  try {
    placeBuiltApp(appeared);
    placeInstalled(appeared);
    commitApk(appeared);
    write(path.join(appeared.stubDir, 'ps.mode'), 'appear');
    const result = run(appeared, ['--skip-android', '--skip-mac', '--quit-timeout', '2']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /still running/);
    assert.match(result.stderr, /left it in place/);
    const log = callsOf(appeared.calls);
    assert.equal(called(log, 'osascript').length, 2, log.join('\n'));
    assertQuitGuarded(log);
    assert.equal(called(log, 'ditto').length, 0);
    assert.equal(fs.readFileSync(path.join(appeared.applications, 'TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.existsSync(path.join(appeared.root, 'mac/dist/previous-before-aaaaaaaa')), false);
  } finally {
    fs.rmSync(appeared.tmp, { recursive: true, force: true });
  }

  const secondQuit = makeCheckout();
  try {
    placeBuiltApp(secondQuit);
    placeInstalled(secondQuit);
    commitApk(secondQuit);
    write(path.join(secondQuit.stubDir, 'ps.mode'), 'second');
    const result = run(secondQuit, ['--skip-android', '--skip-mac', '--quit-timeout', '2']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const log = callsOf(secondQuit.calls);
    assert.equal(called(log, 'osascript').length, 2, log.join('\n'));
    assertQuitGuarded(log);
    assert.equal(called(log, 'ditto').length, 1);
    assert.match(result.stdout, /asking again/);
    assert.match(result.stdout, /main process exited/);
    assert.equal(fs.readFileSync(path.join(secondQuit.root, 'mac/dist/previous-before-aaaaaaaa/installed/TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.readFileSync(path.join(secondQuit.applications, 'TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'utf8'), 'x');
  } finally {
    fs.rmSync(secondQuit.tmp, { recursive: true, force: true });
  }

  const psFail = makeCheckout();
  try {
    placeBuiltApp(psFail);
    placeInstalled(psFail);
    commitApk(psFail);
    write(path.join(psFail.stubDir, 'ps.mode'), 'fail');
    const result = run(psFail, ['--skip-android', '--skip-mac', '--quit-timeout', '2']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not list processes/);
    assert.doesNotMatch(result.stdout, /mac: not running/);
    assert.equal(called(callsOf(psFail.calls), 'ditto').length, 0);
    assert.equal(called(callsOf(psFail.calls), 'osascript').length, 0);
    assert.equal(fs.readFileSync(path.join(psFail.applications, 'TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(fs.existsSync(path.join(psFail.root, 'mac/dist/previous-before-aaaaaaaa')), false);
  } finally {
    fs.rmSync(psFail.tmp, { recursive: true, force: true });
  }

  const paren = makeCheckout();
  try {
    const apps = path.join(paren.root, 'Applications (test)');
    fs.mkdirSync(apps);
    write(path.join(paren.stubDir, 'main-bin'), path.join(apps, 'TwinDesk Fork.app/Contents/MacOS/TwinDesk'));
    placeBuiltApp(paren);
    placeInstalled(paren, apps);
    commitApk(paren);
    write(path.join(paren.stubDir, 'ps.mode'), 'forever');
    const result = run(paren, ['--skip-android', '--skip-mac', '--quit-timeout', '2'], {
      FORK_INSTALL_APPLICATIONS: `${apps}/`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /left it in place/);
    assert.equal(called(callsOf(paren.calls), 'ditto').length, 0);
    assert.ok(called(callsOf(paren.calls), 'osascript').length >= 1);
    assert.equal(fs.readFileSync(path.join(apps, 'TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    const joined = callsOf(paren.calls).join('\n');
    assert.doesNotMatch(joined, /Applications \(test\)\/\//);
  } finally {
    fs.rmSync(paren.tmp, { recursive: true, force: true });
  }

  const sameApk = makeCheckout();
  try {
    const dist = path.join(sameApk.root, 'android/dist');
    const previous = path.join(dist, 'previous');
    write(path.join(dist, 'twindesk-full-3.2.1-aaaaaaaa-full.apk'), 'old-same\n');
    write(path.join(previous, 'twindesk-full-3.2.1-aaaaaaaa-full.apk'), 'already\n');
    write(path.join(dist, 'twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'older\n');
    const result = run(sameApk, ['--no-install']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(dist, 'twindesk-full-3.2.1-aaaaaaaa-full.apk'), 'utf8'), 'new-apk-bytes\n');
    assert.equal(fs.readFileSync(path.join(previous, 'twindesk-full-3.2.1-aaaaaaaa-full.apk'), 'utf8'), 'already\n');
    assert.equal(fs.readFileSync(path.join(previous, 'twindesk-full-3.2.1-aaaaaaaa-full.apk.2'), 'utf8'), 'old-same\n');
    assert.equal(fs.readFileSync(path.join(previous, 'twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'utf8'), 'older\n');
    const left = fs.readdirSync(dist).filter((name) => name.endsWith('-full.apk')).sort();
    assert.deepEqual(left, ['twindesk-full-3.2.1-aaaaaaaa-full.apk']);
  } finally {
    fs.rmSync(sameApk.tmp, { recursive: true, force: true });
  }

  const skipMissing = makeCheckout();
  try {
    write(path.join(skipMissing.root, 'android/dist/twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'older\n');
    const before = snapshot(skipMissing.root);
    const result = run(skipMissing, ['--skip-android']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /twindesk-full-3\.2\.1-aaaaaaaa-full\.apk/);
    assert.match(result.stderr, /without --skip-android/);
    assert.deepEqual(snapshot(skipMissing.root), before);
    assert.equal(stateChanging(callsOf(skipMissing.calls)).length, 0);
    assert.equal(called(callsOf(skipMissing.calls), 'adb').length, 0);
    assert.equal(fs.readFileSync(path.join(skipMissing.root, 'android/dist/twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'utf8'), 'older\n');
    fs.writeFileSync(skipMissing.calls, '');
    const dryMiss = run(skipMissing, ['--dry-run', '--skip-android']);
    assert.notEqual(dryMiss.status, 0);
    assert.match(`${dryMiss.stdout}\n${dryMiss.stderr}`, /twindesk-full-3\.2\.1-aaaaaaaa-full\.apk/);
    assert.match(`${dryMiss.stdout}\n${dryMiss.stderr}`, /without --skip-android/);
    assert.deepEqual(snapshot(skipMissing.root), before);
    assert.equal(stateChanging(callsOf(skipMissing.calls)).length, 0);
    assert.equal(called(callsOf(skipMissing.calls), 'adb').length, 0);
    fs.writeFileSync(skipMissing.calls, '');
    const irrelevant = run(skipMissing, ['--skip-android', '--skip-mac', '--no-install']);
    assert.equal(irrelevant.status, 0, irrelevant.stdout + irrelevant.stderr);
    const present = makeCheckout();
    try {
      commitApk(present, 'commit-apk\n');
      const dryOk = run(present, ['--dry-run', '--skip-android']);
      assert.equal(dryOk.status, 0, dryOk.stdout + dryOk.stderr);
      assert.equal(called(callsOf(present.calls), 'adb').length, 0);
      assert.match(dryOk.stdout, /android: skipped/);
    } finally {
      fs.rmSync(present.tmp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(skipMissing.tmp, { recursive: true, force: true });
  }

  const olderNotUsed = makeCheckout();
  try {
    commitApk(olderNotUsed, 'commit-apk\n');
    write(path.join(olderNotUsed.root, 'android/dist/twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'older-apk\n');
    placeBuiltApp(olderNotUsed);
    const result = run(olderNotUsed, ['--skip-android', '--skip-mac', '--device', '192.0.2.1:5555']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const installs = called(callsOf(olderNotUsed.calls), 'adb').filter((line) => line.split('\t').includes('install'));
    assert.equal(installs.length, 1, callsOf(olderNotUsed.calls).join('\n'));
    assert.ok(installs[0].endsWith('twindesk-full-3.2.1-aaaaaaaa-full.apk'));
    assert.equal(fs.readFileSync(path.join(olderNotUsed.root, 'android/dist/twindesk-full-3.2.1-zzzzzzzz-full.apk'), 'utf8'), 'older-apk\n');
  } finally {
    fs.rmSync(olderNotUsed.tmp, { recursive: true, force: true });
  }

  const errTrap = makeCheckout();
  try {
    commitApk(errTrap);
    const result = run(errTrap, ['--skip-android'], { STUB_NPM_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /step failed: mac: npm run dist/);
    assert.match(result.stderr, /fork-install: log: /);
    assert.equal(called(callsOf(errTrap.calls), 'ditto').length, 0);
    assert.equal(called(callsOf(errTrap.calls), 'osascript').length, 0);
  } finally {
    fs.rmSync(errTrap.tmp, { recursive: true, force: true });
  }

  const missingLog = makeCheckout();
  try {
    placeBuiltApp(missingLog);
    commitApk(missingLog);
    const result = run(missingLog, ['--skip-android', '--skip-mac', '--quit-timeout', '2']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /mac log: missing /);
    assert.match(result.stdout, /mac: not running/);
    assert.doesNotMatch(result.stdout, /no warnings or errors since start/);
    assert.equal(called(callsOf(missingLog.calls), 'osascript').length, 0);
    assert.equal(called(callsOf(missingLog.calls), 'ditto').length, 1);
  } finally {
    fs.rmSync(missingLog.tmp, { recursive: true, force: true });
  }

  const noStart = makeCheckout();
  try {
    placeBuiltApp(noStart);
    commitApk(noStart);
    const logFile = path.join(noStart.tmp, 'TwinDesk.log');
    write(logFile, '12:00 WARN hello\n');
    const result = run(noStart, ['--skip-android', '--skip-mac'], { FORK_INSTALL_APP_LOG: logFile });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no start line for this launch/);
    assert.doesNotMatch(result.stdout, /no warnings or errors since start/);
  } finally {
    fs.rmSync(noStart.tmp, { recursive: true, force: true });
  }

  const crashLog = makeCheckout();
  try {
    placeBuiltApp(crashLog);
    commitApk(crashLog);
    const logFile = path.join(crashLog.tmp, 'TwinDesk.log');
    write(logFile, '---- TwinDesk 3.2.1 started\n12:00 [crash] test: boom\n');
    const result = run(crashLog, ['--skip-android', '--skip-mac'], { FORK_INSTALL_APP_LOG: logFile });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[crash\] test: boom/);
    assert.match(result.stdout, /warnings, errors, or crashes since start/);
    assert.doesNotMatch(result.stdout, /no warnings or errors since start/);
  } finally {
    fs.rmSync(crashLog.tmp, { recursive: true, force: true });
  }

  const unreadLog = makeCheckout();
  try {
    placeBuiltApp(unreadLog);
    commitApk(unreadLog);
    const logFile = path.join(unreadLog.tmp, 'TwinDesk.log');
    write(logFile, '---- TwinDesk 3.2.1 started\n12:00 WARN hidden\n');
    fs.chmodSync(logFile, 0o000);
    const result = run(unreadLog, ['--skip-android', '--skip-mac'], { FORK_INSTALL_APP_LOG: logFile });
    fs.chmodSync(logFile, 0o644);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /mac log: unreadable /);
    assert.doesNotMatch(result.stdout, /no warnings or errors since start/);
    assert.doesNotMatch(result.stdout, /WARN hidden/);
  } finally {
    fs.rmSync(unreadLog.tmp, { recursive: true, force: true });
  }

  const phoneFail = makeCheckout();
  try {
    placeBuiltApp(phoneFail);
    placeInstalled(phoneFail);
    commitApk(phoneFail, 'commit-apk\n');
    write(path.join(phoneFail.stubDir, 'install-fail'), '1');
    write(path.join(phoneFail.stubDir, 'phone-crash-large'), '1');
    const result = run(phoneFail, ['--skip-android', '--skip-mac', '--device', '192.0.2.1:5555']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /phone install failed/);
    assert.match(result.stderr, /Mac app was left installed/);
    assert.match(result.stdout, /crash buffer mentions io\.github\.alexfoxtm\.twindesk\.android/);
    assert.match(result.stdout, /is not running/);
    assert.equal(fs.readFileSync(path.join(phoneFail.applications, 'TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(path.join(phoneFail.root, 'mac/dist/previous-before-aaaaaaaa/installed/TwinDesk Fork.app/MARKER'), 'utf8'), 'installed');
    assert.equal(called(callsOf(phoneFail.calls), 'adb').some((line) => line.includes('logcat')), true);
  } finally {
    fs.rmSync(phoneFail.tmp, { recursive: true, force: true });
  }

  const skipMacDry = makeCheckout();
  try {
    commitApk(skipMacDry);
    const result = run(skipMacDry, ['--dry-run', '--skip-mac']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /codesign/);
    assert.doesNotMatch(result.stdout, /shasum/);
    assert.equal(called(callsOf(skipMacDry.calls), 'adb').length, 0);
    fs.writeFileSync(skipMacDry.calls, '');
    const both = run(skipMacDry, ['--dry-run', '--skip-mac', '--no-install']);
    assert.equal(both.status, 0, both.stdout + both.stderr);
    assert.doesNotMatch(both.stdout, /shasum/);
    assert.doesNotMatch(both.stdout, /codesign/);
    assert.equal(called(callsOf(skipMacDry.calls), 'adb').length, 0);
  } finally {
    fs.rmSync(skipMacDry.tmp, { recursive: true, force: true });
  }

  const missingPkg = makeCheckout();
  try {
    fs.rmSync(path.join(missingPkg.root, 'mac/package.json'));
    const result = run(missingPkg, ['--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing mac\/package.json/);
    assert.equal(stateChanging(callsOf(missingPkg.calls)).length, 0);
  } finally {
    fs.rmSync(missingPkg.tmp, { recursive: true, force: true });
  }

  // /bin/bash 3.2: a doubled or trailing slash in the install folder still finds the running app.
  const slashes = makeCheckout();
  try {
    placeBuiltApp(slashes);
    placeInstalled(slashes);
    commitApk(slashes);
    write(path.join(slashes.stubDir, 'ps.mode'), 'count');
    write(path.join(slashes.stubDir, 'ps.limit'), '2');
    const odd = `${path.dirname(slashes.applications)}//Applications///`;
    const result = run(slashes, ['--skip-android', '--skip-mac', '--quit-timeout', '15'], { FORK_INSTALL_APPLICATIONS: odd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const log = callsOf(slashes.calls);
    assert.equal(called(log, 'osascript').length, 1, log.join('\n'));
    assert.deepEqual(called(log, 'ditto')[0].split('\t').slice(2), [
      path.join(slashes.root, 'mac/dist/TwinDesk Fork.app'),
      path.join(slashes.applications, 'TwinDesk Fork.app'),
    ]);
    assert.equal(fs.readFileSync(path.join(slashes.applications, 'TwinDesk Fork.app/Contents/MacOS/TwinDesk'), 'utf8'), 'x');
    assert.doesNotMatch(result.stdout + result.stderr, /\\/);
  } finally {
    fs.rmSync(slashes.tmp, { recursive: true, force: true });
  }

  // A first install that fails the signature check is not opened, and the error says where it is.
  const freshSignFail = makeCheckout();
  try {
    placeBuiltApp(freshSignFail);
    commitApk(freshSignFail);
    const result = run(freshSignFail, ['--skip-android', '--skip-mac'], { STUB_CODESIGN_INSTALL_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature check/);
    assert.ok(result.stderr.includes(`it is at ${path.join(freshSignFail.applications, 'TwinDesk Fork.app')}`), result.stderr);
    assert.doesNotMatch(result.stderr, /step failed/);
    assert.equal(called(callsOf(freshSignFail.calls), 'open').length, 0);
  } finally {
    fs.rmSync(freshSignFail.tmp, { recursive: true, force: true });
  }

  const reusedBuild = makeCheckout();
  try {
    placeInstalled(reusedBuild, reusedBuild.applications, '74');
    const result = run(reusedBuild, []);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fork build 74 must exceed installed Mac build 74/);
    assert.deepEqual(stateChanging(callsOf(reusedBuild.calls)), []);
    commitApk(reusedBuild);
    const staleApk = run(reusedBuild, ['--no-install', '--skip-android'], { STUB_APK_VERSION_CODE: '30201' });
    assert.notEqual(staleApk.status, 0);
    assert.match(staleApk.stderr, /APK metadata must match 3\.2\.1 \(versionCode 100074\)/);
    assert.deepEqual(stateChanging(callsOf(reusedBuild.calls)), []);
    const installed = path.join(reusedBuild.applications, 'TwinDesk Fork.app/Contents');
    write(path.join(installed, 'Info.plist'), 'CFBundleShortVersionString=3.2.1\nCFBundleVersion=74\n');
    const bundled = path.join(installed, 'Resources/app/mac/vendor/twindesk-android-full.apk');
    write(bundled, 'new-apk-bytes\n');
    const retry = run(reusedBuild, ['--android-only', '--device', 'galaxy']);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.match(retry.stdout, /using the APK bundled with installed Mac build 74/);
    const calls = callsOf(reusedBuild.calls);
    assert.equal(called(calls, 'adb').filter((line) => line.includes('\tinstall\t-r\t')).length, 1);
    for (const name of ['osascript', 'ditto', 'open', 'gradlew', 'npm']) assert.deepEqual(called(calls, name), []);
    write(bundled, 'another-apk\n');
    const mismatch = run(reusedBuild, ['--android-only', '--device', 'galaxy']);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /must match the APK bundled in the installed Mac/);
    assert.equal(called(callsOf(reusedBuild.calls), 'adb').filter((line) => line.includes('\tinstall\t-r\t')).length, 1);
  } finally {
    fs.rmSync(reusedBuild.tmp, { recursive: true, force: true });
  }

  // adb that cannot list devices: the phone is skipped and reported once, with no false "step failed".
  const adbFail = makeCheckout();
  try {
    placeBuiltApp(adbFail);
    commitApk(adbFail);
    write(path.join(adbFail.stubDir, 'devices-fail'), '1');
    const result = run(adbFail, ['--skip-android', '--skip-mac']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /phone: skipped \(could not list devices\)/);
    assert.match(result.stderr, /adb devices failed/);
    assert.match(result.stderr, /adb: no server/);
    assert.doesNotMatch(result.stderr, /step failed/);
    assert.equal(called(callsOf(adbFail.calls), 'open').length, 1, 'the Mac install still completes');
  } finally {
    fs.rmSync(adbFail.tmp, { recursive: true, force: true });
  }

  // --dry-run --device on a Mac without adb prints the command with a plain "adb".
  const noAdb = makeCheckout();
  try {
    commitApk(noAdb);
    fs.rmSync(path.join(noAdb.bin, 'adb'));
    const result = run(noAdb, ['--dry-run', '--skip-mac', '--device', '192.0.2.1:5555'], { FORK_INSTALL_ADB: '' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /would run: adb -s 192\.0\.2\.1:5555 install -r /);
    assert.match(result.stdout, /would run: adb -s 192\.0\.2\.1:5555 shell pidof /);
    assert.match(result.stdout, /would run: adb -s 192\.0\.2\.1:5555 logcat -b crash -d/);
    assert.doesNotMatch(result.stdout, /would run: ''/);
  } finally {
    fs.rmSync(noAdb.tmp, { recursive: true, force: true });
  }

  console.log('fork-install: ok');
}

main();
