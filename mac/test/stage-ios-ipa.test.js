// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// mac/scripts/stage-ios-ipa.sh: rebuilds only when HEAD:ios changes or the staged IPA/stamp is
// missing or invalid, checks a new IPA with the install inventory rules, replaces atomically and
// keeps a valid cached IPA when a build fails. A stand-in build makes real IPAs (plutil + zip).
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'stage-ios-ipa.sh');

const BUILD = `#!/bin/bash
set -euo pipefail
echo "$PWD" >> "$STAGE_COUNT"
[ "\${STAGE_REQUIRE_NETWORK:-0}" != 1 ] || [ -f ../network/go.mod ]
[ "\${STAGE_MODE:-ok}" = fail ] && { echo "build failed" >&2; exit 3; }
W=$(mktemp -d)
fam=",2"; [ "\${STAGE_MODE:-ok}" = invalid ] && fam=""
mk() { mkdir -p "$1"; printf '{"CFBundleIdentifier":"%s","CFBundleShortVersionString":"%s","UIDeviceFamily":[1%s]}' "$2" "$STAGE_VERSION" "$fam" > "$1/Info.plist"; plutil -convert xml1 "$1/Info.plist"; }
A="$W/Payload/TwinDesk.app"
mk "$A" com.twindesk.ios
mk "$A/PlugIns/Share.appex" com.twindesk.ios.share
mk "$A/PlugIns/Broadcast.appex" com.twindesk.ios.broadcast
mkdir -p dist
(cd "$W" && zip -qry TwinDesk.ipa Payload)
mv "$W/TwinDesk.ipa" dist/TwinDesk.ipa
rm -rf "$W"
`;

function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('staging builds once per ios/ tree, validates, replaces atomically and keeps the cache on failure', { skip: process.platform !== 'darwin' }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-ios-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const out = path.join(temp, 'userData', 'ios-developer');
  const build = path.join(temp, 'fake-build.sh');
  const count = path.join(temp, 'count');
  fs.writeFileSync(build, BUILD, { mode: 0o755 });
  fs.mkdirSync(path.join(repo, 'ios'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'android/app/src/main/assets/web'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'ios', 'project.yml'), 'name: TwinDesk\n');
  fs.writeFileSync(path.join(repo, 'android/app/src/main/assets/web', 'index.html'), '<p>\n');
  fs.writeFileSync(path.join(repo, 'ios', 'uncommitted.swift'), '');
  git(repo, 'init', '-q');
  git(repo, 'add', 'ios/project.yml', 'android');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'one');

  const ipa = path.join(out, 'TwinDesk.ipa');
  const stamp = path.join(out, 'TwinDesk.ipa.stamp');
  const builds = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0);
  const run = (env = {}) => spawnSync('bash', [SCRIPT, '--repo', repo, '--out', out], {
    encoding: 'utf8', env: { ...process.env, NODE: process.execPath, TMPDIR: temp, TWINDESK_STAGE_IOS_BUILD: build,
      STAGE_COUNT: count, STAGE_VERSION: '3.2.1', ...env } });
  const fields = () => Object.fromEntries(fs.readFileSync(stamp, 'utf8').trim().split('\n').map((l) => l.split('=')));

  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(builds(), 1);
  const tree = git(repo, 'rev-parse', 'HEAD:ios');
  assert.deepEqual(fields(), { ios: tree, web: git(repo, 'rev-parse', 'HEAD:android/app/src/main/assets/web'), network: '-', sha256: sha(ipa), version: '3.2.1' });
  assert.match(r.stdout, new RegExp(`staged ios=${tree} version=3.2.1 sha256=${sha(ipa)}`));
  assert.ok(!fs.readFileSync(count, 'utf8').includes(repo), 'built from an export of HEAD, not the working tree');
  assert.deepEqual(fs.readdirSync(out).sort(), ['TwinDesk.ipa', 'TwinDesk.ipa.stamp'], 'no temporary or lock files left');

  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date/);
  assert.equal(builds(), 1, 'same HEAD:ios: no rebuild');

  fs.mkdirSync(path.join(repo, 'network'));
  fs.writeFileSync(path.join(repo, 'network', 'go.mod'), 'module test.local');
  git(repo, 'add', 'network');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'network');
  r = run({ STAGE_REQUIRE_NETWORK: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(builds(), 2, 'a change to the embedded engine rebuilds the IPA');
  assert.equal(fields().ios, tree);
  assert.equal(fields().network, git(repo, 'rev-parse', 'HEAD:network'));

  // A failed or invalid build keeps the valid cached IPA and its stamp, byte for byte.
  fs.writeFileSync(path.join(repo, 'ios', 'project.yml'), 'name: TwinDesk\n# 2\n');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qam', 'two');
  const before = [fs.readFileSync(ipa), fs.readFileSync(stamp, 'utf8')];
  for (const mode of ['fail', 'invalid']) {
    r = run({ STAGE_MODE: mode, STAGE_VERSION: '3.2.2' });
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, /keeping the cached IPA \(3\.2\.1\)/, mode);
    assert.deepEqual([fs.readFileSync(ipa), fs.readFileSync(stamp, 'utf8')], before, mode);
    assert.deepEqual(fs.readdirSync(out).sort(), ['TwinDesk.ipa', 'TwinDesk.ipa.stamp']);
  }
  const n = builds();
  r = run({ STAGE_VERSION: '3.2.2' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(builds(), n + 1, 'a new HEAD:ios rebuilds');
  assert.equal(fields().ios, git(repo, 'rev-parse', 'HEAD:ios'));
  assert.equal(fields().version, '3.2.2');

  // Missing, mismatched or corrupt staged files rebuild; the stamp always names the IPA beside it.
  for (const breakIt of [() => fs.rmSync(stamp), () => fs.rmSync(ipa), () => fs.appendFileSync(ipa, 'x'),
    () => fs.writeFileSync(stamp, fs.readFileSync(stamp, 'utf8').replace(/version=.*/, 'version=9.9.9')),
    () => fs.writeFileSync(ipa, 'not a zip')]) {
    breakIt();
    const m = builds();
    r = run({ STAGE_VERSION: '3.2.2' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(builds(), m + 1);
    assert.equal(fields().sha256, sha(ipa));
  }
  // Nothing valid cached and the build fails: no stamp or IPA is invented.
  fs.rmSync(out, { recursive: true });
  r = run({ STAGE_MODE: 'fail' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /keeping/);
  assert.deepEqual(fs.readdirSync(out), []);
  // A live lock from another run is respected; relative output is refused.
  fs.mkdirSync(path.join(out, '.stage.lock'));
  fs.writeFileSync(path.join(out, '.stage.lock', 'pid'), String(process.pid));
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another staging run/);
  fs.rmSync(path.join(out, '.stage.lock'), { recursive: true });
  r = spawnSync('bash', [SCRIPT, '--out', 'relative'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /absolute/);
});
