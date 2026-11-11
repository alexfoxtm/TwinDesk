// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A pinned local Apple Development identity; this reads public certificate metadata only.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function localIdentity({ env = process.env, home = os.homedir(), read = fs.readFileSync, exec = execFileSync,
  certificate = (pem) => new X509Certificate(pem) } = {}) {
  let identity = env.MAC_LOCAL_IDENTITY, teamId = env.MAC_LOCAL_TEAM_ID;
  if (!identity) {
    const config = env.MAC_LOCAL_SIGNING_CONFIG || path.join(home, 'Library', 'Application Support', 'io.github.alexfoxtm.twindesk', 'build-signing.json');
    let value;
    try { value = JSON.parse(read(config, 'utf8')); }
    catch { throw Error(`Configure local signing in ${config} or set MAC_LOCAL_IDENTITY and MAC_LOCAL_TEAM_ID; use MAC_ADHOC=1 only for a disposable build.`); }
    identity = value.identity;
    teamId = value.teamId;
  }
  if (typeof identity !== 'string' || !/^[A-Fa-f0-9]{40}$/.test(identity) || typeof teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw Error('Local signing requires a certificate SHA-1 fingerprint and its 10-character teamId.');
  }
  identity = identity.toUpperCase();
  const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const valid = exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], options);
  if (!new RegExp(`^\\s*\\d+\\) ${identity} "Apple Development:`, 'm').test(valid)) {
    throw Error('The pinned Apple Development signing identity is missing, expired, or invalid.');
  }
  const pem = exec('/usr/bin/security', ['find-certificate', '-a', '-p'], options);
  const cert = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [])
    .map(certificate).find((c) => c.fingerprint.replaceAll(':', '').toUpperCase() === identity);
  if (!cert || !new RegExp(`(?:^|\\n)OU=${teamId}(?:\\n|$)`).test(cert.subject) || !/(?:^|\n)CN=Apple Development:/.test(cert.subject)) {
    throw Error('The pinned local signing certificate does not match the configured Apple Development team.');
  }
  return identity;
}

if (require.main === module) {
  try { process.stdout.write(localIdentity() + '\n'); }
  catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}

module.exports = { localIdentity };
