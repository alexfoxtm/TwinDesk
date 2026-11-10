// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The `Host twindesk` entry in ~/.ssh/config, so `ssh twindesk` opens a shell on the paired
// computer on every OS. Only our marked block is touched; the rest of the file stays byte for byte,
// and a one-time backup is kept. Blocks written by older versions (`macshare-pc`) are removed too.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const CONFIG = path.join(SSH_DIR, 'config');
const SCOPES = {
  upstream: {
    alias: 'twindesk',
    begin: '# >>> twindesk (managed by TwinDesk, do not edit)',
    end: '# <<< twindesk',
    old: [['# >>> macshare', '# <<< macshare']],
    backup: '.before-twindesk',
    priorBackup: '.before-macshare',
  },
  // The Mac fork. Its block does not include upstream's markers, so writing it leaves `Host twindesk` alone.
  fork: {
    alias: 'alexfoxtm-twindesk',
    begin: '# >>> alexfoxtm-twindesk (managed by Alexfoxtm TwinDesk, do not edit)',
    end: '# <<< alexfoxtm-twindesk',
    old: [],
    backup: '.before-alexfoxtm-twindesk',
    priorBackup: null,
  },
};
const ALIAS = SCOPES.upstream.alias;

function scopeOf(name) {
  return SCOPES[name] || SCOPES.upstream;
}

// A value for the config file, quoted when it has spaces (Windows paths often do).
const quote = (v) => (/[\s"]/.test(v) ? `"${String(v).replace(/"/g, '')}"` : String(v));

function strip(text, begin, end) {
  const start = text.indexOf(begin);
  const stop = start < 0 ? -1 : text.indexOf(end, start);
  if (start < 0 || stop < 0) return text;
  let a = start;
  if (text[a - 1] === '\n' && text[a - 2] === '\n') a--; // the blank line we added before it
  let b = stop + end.length;
  if (text[b] === '\r') b++;
  if (text[b] === '\n') b++;
  return text.slice(0, a) + text.slice(b);
}

// host: {address, port, user, identityFile, knownHostsFile}, or null to remove the entry.
// scopeName defaults to upstream (`Host twindesk`). 'fork' touches only the fork's block.
function renderConfig(text, host, scopeName) {
  const scope = scopeOf(scopeName);
  let out = String(text || '');
  for (const [b, e] of [[scope.begin, scope.end], ...scope.old]) out = strip(out, b, e);
  if (host) {
    const lines = [
      `Host ${scope.alias}`,
      `  HostName ${host.address}`,
      `  Port ${Number(host.port) || 22}`,
      `  User ${quote(host.user)}`,
      `  IdentityFile ${quote(host.identityFile)}`,
      '  IdentitiesOnly yes',
      `  HostKeyAlias ${scope.alias}`,
      `  UserKnownHostsFile ${quote(host.knownHostsFile)}`,
      '  StrictHostKeyChecking yes',
    ];
    out = `${out}${out && !out.endsWith('\n') ? '\n' : ''}${out ? '\n' : ''}${scope.begin}\n${lines.join('\n')}\n${scope.end}\n`;
  }
  return out;
}

function setHost(host, scopeName) {
  const scope = scopeOf(scopeName);
  let text = '';
  try {
    text = fs.readFileSync(CONFIG, 'utf8');
  } catch { /* no config yet */ }
  const next = renderConfig(text, host, scopeName);
  if (next === text) return;
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  const backup = `${CONFIG}${scope.backup}`;
  const prior = scope.priorBackup ? `${CONFIG}${scope.priorBackup}` : '';
  if (fs.existsSync(CONFIG) && !fs.existsSync(backup) && !(prior && fs.existsSync(prior))) fs.copyFileSync(CONFIG, backup);
  const mode = fs.existsSync(CONFIG) ? fs.statSync(CONFIG).mode & 0o777 : 0o600;
  fs.writeFileSync(CONFIG, next, { mode });
}

function alias(scopeName) {
  return scopeOf(scopeName).alias;
}

// Pinned host keys for the alias, one per line.
function knownHosts(keys, scopeName) {
  return keys.map((k) => `${alias(scopeName)} ${k}`).join('\n') + '\n';
}

module.exports = { ALIAS, setHost, knownHosts, renderConfig, alias };
