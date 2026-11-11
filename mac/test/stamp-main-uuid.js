// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One success and one failure for the fork main-executable UUID stamp.
// Uses a disposable synthetic Mach-O only. Does not sign, install, or open a real app.
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BUNDLE_ID, formatUuid, locateUuids, uuidForSlice } = require('../scripts/stamp-main-uuid.js');

const root = path.join(__dirname, '..', '..');
const script = path.join(__dirname, '..', 'scripts', 'stamp-main-uuid.js');
const COLLISION = '4C4C448B-5555-3144-A137-BC5609565491';
const OTHER = '00112233-4455-6677-8899-AABBCCDDEEFF';

function le32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function le64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

function parseUuid(text) {
  const hex = text.replace(/-/g, '');
  assert.equal(hex.length, 32);
  return Buffer.from(hex, 'hex');
}

function macho({ cputype, cpusubtype, uuid, withUuid = true }) {
  const header = Buffer.concat([
    le32(0xfeedfacf),
    le32(cputype),
    le32(cpusubtype),
    le32(2),
    le32(withUuid ? 2 : 1),
    le32(withUuid ? 96 : 72),
    le32(0x00200085),
    le32(0),
  ]);
  const segname = Buffer.alloc(16);
  segname.write('__TEXT');
  const segment = Buffer.concat([
    le32(0x19),
    le32(72),
    segname,
    le64(0),
    le64(0),
    le64(0),
    le64(0),
    le32(7),
    le32(5),
    le32(0),
    le32(0),
  ]);
  const parts = [header, segment];
  if (withUuid) parts.push(Buffer.concat([le32(0x1b), le32(24), uuid]));
  parts.push(Buffer.from('PAYLOAD-KEEP'));
  const file = Buffer.concat(parts);
  file.writeBigUInt64LE(BigInt(file.length), 64);
  file.writeBigUInt64LE(BigInt(file.length), 80);
  return file;
}

function fat(slices) {
  const align = 0x1000;
  let cursor = align;
  const placed = slices.map((slice) => {
    const row = { ...slice, offset: cursor, size: slice.data.length };
    cursor = Math.ceil((cursor + slice.data.length) / align) * align;
    return row;
  });
  const out = Buffer.alloc(cursor);
  out.writeUInt32BE(0xcafebabe, 0);
  out.writeUInt32BE(placed.length, 4);
  placed.forEach((slice, index) => {
    const base = 8 + index * 20;
    out.writeUInt32BE(slice.cputype >>> 0, base);
    out.writeUInt32BE(slice.cpusubtype >>> 0, base + 4);
    out.writeUInt32BE(slice.offset, base + 8);
    out.writeUInt32BE(slice.size, base + 12);
    out.writeUInt32BE(12, base + 16);
    slice.data.copy(out, slice.offset);
  });
  return out;
}

function plist(bundleId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>TwinDesk</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
</dict></plist>
`;
}

function makeApp(dir, exeBytes, bundleId = BUNDLE_ID) {
  const app = path.join(dir, 'TwinDesk.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(bundleId));
  const exe = path.join(macos, 'TwinDesk');
  fs.writeFileSync(exe, exeBytes);
  fs.chmodSync(exe, 0o755);
  return { app, exe };
}

function run(app) {
  return spawnSync(process.execPath, [script, app], { encoding: 'utf8' });
}

function indexOfUuid(buf, text) {
  const needle = parseUuid(text);
  const hits = [];
  let from = 0;
  while (from <= buf.length - needle.length) {
    const at = buf.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

function main() {
  const build = fs.readFileSync(path.join(root, 'mac', 'build-app.sh'), 'utf8');
  const packed = build.indexOf('electron-packager');
  const stamped = build.indexOf('node scripts/stamp-main-uuid.js dist/TwinDesk.app');
  const signed = build.indexOf('codesign ');
  assert.ok(packed > 0 && stamped > packed && signed > stamped);
  assert.equal(build.split('stamp-main-uuid.js').length - 1, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-uuid-'));
  try {
    const arm = macho({ cputype: 0x0100000c, cpusubtype: 0, uuid: parseUuid(COLLISION) });
    const x64 = macho({ cputype: 0x01000007, cpusubtype: 3, uuid: parseUuid(OTHER) });
    const armBytes = uuidForSlice(arm, locateUuids(arm)[0]);
    const ARM64 = formatUuid(armBytes);
    const X64 = formatUuid(uuidForSlice(x64, locateUuids(x64)[0]));
    assert.notEqual(ARM64, X64);
    assert.notEqual(ARM64, COLLISION);
    assert.equal(armBytes[6] >> 4, 5);
    assert.equal(armBytes[8] & 0xc0, 0x80);
    const changedCode = Buffer.from(arm);
    changedCode[changedCode.length - 1] ^= 1;
    assert.notEqual(formatUuid(uuidForSlice(changedCode, locateUuids(changedCode)[0])), ARM64);
    const universal = fat([
      { cputype: 0x0100000c, cpusubtype: 0, data: arm },
      { cputype: 0x01000007, cpusubtype: 3, data: x64 },
    ]);
    const { app, exe } = makeApp(path.join(dir, 'ok'), universal);
    const helperDir = path.join(app, 'Contents', 'Frameworks', 'TwinDesk Helper.app', 'Contents', 'MacOS');
    fs.mkdirSync(helperDir, { recursive: true });
    const helper = path.join(helperDir, 'TwinDesk Helper');
    fs.writeFileSync(helper, arm);
    const cache = path.join(dir, 'electron-cache-TwinDesk');
    fs.linkSync(exe, cache);
    const before = fs.readFileSync(exe);
    const cacheIno = fs.statSync(cache).ino;

    const result = run(app);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${ARM64} arm64`));
    assert.match(result.stdout, new RegExp(`${X64} x86_64`));
    const after = fs.readFileSync(exe);
    assert.equal(after.length, before.length);
    assert.deepEqual(indexOfUuid(after, ARM64).length, 1);
    assert.deepEqual(indexOfUuid(after, X64).length, 1);
    assert.deepEqual(indexOfUuid(after, COLLISION).length, 0);
    assert.deepEqual(indexOfUuid(after, OTHER).length, 0);
    const changed = [];
    for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) changed.push(i);
    const allowed = new Set();
    for (const at of [...indexOfUuid(before, COLLISION), ...indexOfUuid(before, OTHER)]) {
      for (let i = 0; i < 16; i += 1) allowed.add(at + i);
    }
    assert.ok(changed.length > 0);
    assert.ok(changed.every((i) => allowed.has(i)));
    assert.ok(fs.readFileSync(helper).equals(arm));
    assert.ok(fs.readFileSync(cache).equals(before));
    assert.equal(fs.statSync(cache).ino, cacheIno);
    assert.notEqual(fs.statSync(exe).ino, cacheIno);
    assert.equal(fs.statSync(exe).mode & 0o777, 0o755);
    const stampedIno = fs.statSync(exe).ino;

    const thin = makeApp(path.join(dir, 'thin'), arm);
    const thinRun = run(thin.app);
    assert.equal(thinRun.status, 0, thinRun.stderr);
    assert.equal(thinRun.stdout.trim(), `${ARM64} arm64`);
    assert.ok(fs.readFileSync(thin.exe).includes(parseUuid(ARM64)));

    const dump = spawnSync('/usr/bin/dwarfdump', ['--uuid', exe], { encoding: 'utf8' });
    assert.equal(dump.status, 0, dump.stderr);
    assert.match(dump.stdout, new RegExp(`UUID: ${ARM64} \\(arm64\\)`));
    assert.match(dump.stdout, new RegExp(`UUID: ${X64} \\(x86_64\\)`));
    assert.doesNotMatch(dump.stdout, new RegExp(COLLISION));

    const again = run(app);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(fs.readFileSync(exe).equals(after));
    assert.equal(fs.statSync(exe).ino, stampedIno);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function failure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-uuid-fail-'));
  try {
    const broken = macho({
      cputype: 0x0100000c,
      cpusubtype: 0,
      uuid: parseUuid(COLLISION),
      withUuid: false,
    });
    const { app, exe } = makeApp(dir, broken);
    const before = fs.readFileSync(exe);
    const result = run(app);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no LC_UUID/);
    assert.ok(fs.readFileSync(exe).equals(before));
    assert.equal(fs.readFileSync(path.join(app, 'Contents', 'Info.plist')).includes(BUNDLE_ID), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
failure();
console.log('stamp-main-uuid: ok');
