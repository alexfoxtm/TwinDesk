// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Public metadata fixtures only: no Keychain, private-key use, or codesign invocation.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { localIdentity } = require('../scripts/local-signing-identity');

const identity = 'A'.repeat(40), teamId = 'ABCDE12345';
function fixture(env = {}) {
  const calls = [];
  const options = {
    env, home: '/fixture',
    read(file) { calls.push(file); return JSON.stringify({ identity, teamId }); },
    exec(file, args) {
      assert.equal(file, '/usr/bin/security');
      calls.push(args);
      return args[0] === 'find-identity'
        ? `  1) ${identity} "Apple Development: Fixture"\n     1 valid identities found`
        : '-----BEGIN CERTIFICATE-----fixture-----END CERTIFICATE-----';
    },
    certificate: () => ({ fingerprint: identity.match(/../g).join(':'), subject: `CN=Apple Development: Fixture\nOU=${teamId}\nO=Fixture` }),
  };
  return { options, calls };
}

function pinnedIdentity() {
  const f = fixture();
  assert.equal(localIdentity(f.options), identity);
  assert.equal(f.calls[0], '/fixture/Library/Application Support/io.github.alexfoxtm.twindesk/build-signing.json');
  const explicit = fixture({ MAC_LOCAL_IDENTITY: identity.toLowerCase(), MAC_LOCAL_TEAM_ID: teamId });
  explicit.options.read = () => { throw Error('environment pin must not read another config'); };
  assert.equal(localIdentity(explicit.options), identity);
  const build = fs.readFileSync(path.join(__dirname, '../build-app.sh'), 'utf8');
  assert.ok(build.indexOf('LOCAL_IDENTITY=$(node scripts/local-signing-identity.js)') < build.indexOf('../mac-helper/build.sh'));
  assert.doesNotMatch(build, /KC=\$\(scripts\/signing-identity\.sh/);
  assert.match(build, /MAC_ADHOC:-0/);
  assert.match(build, /codesign --verify --deep --strict/);
}

function failsClosed() {
  const missing = fixture();
  missing.options.read = () => { throw Error('missing'); };
  assert.throws(() => localIdentity(missing.options), /Configure local signing/);
  const expired = fixture();
  expired.options.exec = () => '0 valid identities found';
  assert.throws(() => localIdentity(expired.options), /missing, expired, or invalid/);
  const wrongTeam = fixture();
  wrongTeam.options.certificate = () => ({ fingerprint: identity, subject: 'CN=Apple Development: Fixture\nOU=ZZZZZ99999' });
  assert.throws(() => localIdentity(wrongTeam.options), /does not match/);
  assert.throws(() => localIdentity(fixture({ MAC_LOCAL_IDENTITY: 'Fixture', MAC_LOCAL_TEAM_ID: teamId }).options), /SHA-1 fingerprint/);
}

pinnedIdentity();
failsClosed();
console.log('local-signing-identity: ok');
