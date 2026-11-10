#!/usr/bin/env node
// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fail closed when a release provisioning profile is supplied for a different App ID.
// Reads only the application-identifier string. Does not print the profile and does not use Keychain.
'use strict';

const fs = require('fs');

function rawApplicationIdentifier(buf) {
  const text = Buffer.from(buf).toString('latin1');
  const m = text.match(/<key>(?:com\.apple\.)?application-identifier<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1] : '';
}

function applicationIdentifier(buf) {
  return rawApplicationIdentifier(buf).replace(/^[A-Z0-9]{10}\./, '');
}

function check(buf, expected, team = '') {
  const raw = rawApplicationIdentifier(buf);
  const id = applicationIdentifier(buf);
  if (!id) return { ok: false, id: '' };
  if (id !== expected || (team && !raw.startsWith(`${team}.`))) return { ok: false, id };
  return { ok: true, id };
}

function main(argv) {
  const file = argv[2];
  const expected = argv[3];
  const label = argv[4] || 'provisioning profile';
  const team = argv[5] || '';
  if (!file || !expected) {
    process.stderr.write('error: profile check needs a file and an App ID\n');
    process.exit(1);
  }
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (_) {
    process.stderr.write(`error: ${label} was supplied but could not be read. Refusing to embed it.\n`);
    process.exit(1);
  }
  const result = check(buf, expected, team);
  if (!result.ok) {
    const why = result.id
      ? `${label} does not match the expected App ID and team for ${expected}.`
      : `${label} has no application-identifier for ${expected}.`;
    process.stderr.write(`error: ${why} Refusing to embed it.\n`);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv);

module.exports = { applicationIdentifier, check };
