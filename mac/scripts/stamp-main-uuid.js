#!/usr/bin/env node
// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Give the packaged fork its own main-executable LC_UUID. Run after electron-packager
// and before codesign. Does not sign, and does not modify helpers, frameworks, or any
// file other than Contents/MacOS/<CFBundleExecutable> inside the app it is given.
//
// Local network privacy (TN3179) uses that UUID, and TN3178 says two apps that share
// it can be treated as one program. Electron ships one UUID per version and architecture.
// The packager copies the prebuilt binary unchanged, so this fork's main executable
// matched other apps on the same Electron (observed with T3 Code Nightly:
// 4C4C448B-5555-3144-A137-BC5609565491). There is no Apple tool that sets LC_UUID.
//
// The replacement is UUID version 5 of this fork's bundle id and the executable
// slice, with its existing UUID zeroed. It is reproducible and idempotent for the
// same unsigned input, but changes when the executable changes. Stamp before signing.
// A missing or malformed UUID fails the build before signing; this does not invent a
// load command or resize the file.
//
// The new bytes replace the executable via a new inode. A hard link (the Electron
// cache, another copy) keeps the old inode and the old UUID.
//
// dSYM: LC_UUID is what matches a crash to a .dSYM. This build does not emit one.
// Stamping does not rewrite a dSYM. Electron's upstream symbols stop matching the
// main executable, because their UUID is the one we replace. Helpers and frameworks
// are unchanged, so their symbols still match. A dSYM for this executable has to be
// provided with a matching UUID and debug symbols. Signing does not change LC_UUID,
// but it covers it, so the stamp stays before codesign. A dSYM made from the unstamped
// Electron binary still carries Electron's UUID and will not symbolicate.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUNDLE_ID = 'io.github.alexfoxtm.twindesk';
// Fixed namespace for this fork's main executable. Changing it changes every UUID.
const NAMESPACE = Buffer.from('b7e0c3a14d2f5a689c1e0f3a6b8d2e47', 'hex');
const FORBIDDEN_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  '4C4C448B-5555-3144-A137-BC5609565491',
]);

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const MH_EXECUTE = 0x2;
const LC_UUID = 0x1b;
const CPU_SUBTYPE_MASK = 0x00ffffff;

function fail(message) {
  throw new Error(message);
}

function maskedSubtype(cpusubtype) {
  return (cpusubtype >>> 0) & CPU_SUBTYPE_MASK;
}

function formatUuid(bytes) {
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidForSlice(buf, slice) {
  const name = `${BUNDLE_ID}\nmain\n${slice.cputype >>> 0}\n${maskedSubtype(slice.cpusubtype)}\n`;
  const digest = crypto.createHash('sha1').update(NAMESPACE).update(name, 'utf8')
    .update(buf.subarray(slice.start, slice.uuidOff))
    .update(Buffer.alloc(16))
    .update(buf.subarray(slice.uuidOff + 16, slice.start + slice.size))
    .digest();
  const uuid = Buffer.from(digest.subarray(0, 16));
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const text = formatUuid(uuid);
  if (FORBIDDEN_UUIDS.has(text) || (uuid[6] >> 4) !== 5 || (uuid[8] & 0xc0) !== 0x80) {
    fail(`refusing to write UUID ${text}`);
  }
  return uuid;
}

function archName(cputype, cpusubtype) {
  const type = cputype >>> 0;
  const sub = maskedSubtype(cpusubtype);
  if (type === 0x0100000c && sub === 0) return 'arm64';
  if (type === 0x0100000c && sub === 2) return 'arm64e';
  if (type === 0x01000007) return 'x86_64';
  return `${type}.${sub}`;
}

function u32(buf, off, le) {
  if (off < 0 || off + 4 > buf.length) fail('Mach-O is truncated');
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function u64(buf, off, le) {
  if (off < 0 || off + 8 > buf.length) fail('Mach-O is truncated');
  const value = le ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('Mach-O offset does not fit');
  return Number(value);
}

function locateSlice(buf, start, size) {
  if (start < 0 || size < 32 || start > buf.length || size > buf.length - start) fail('Mach-O slice is out of range');
  const magic = buf.readUInt32LE(start);
  let le;
  if (magic === MH_MAGIC_64) le = true;
  else if (magic === MH_CIGAM_64) le = false;
  else fail('main executable slice is not a 64-bit Mach-O');
  const cputype = u32(buf, start + 4, le);
  const cpusubtype = u32(buf, start + 8, le);
  const filetype = u32(buf, start + 12, le);
  const ncmds = u32(buf, start + 16, le);
  const sizeofcmds = u32(buf, start + 20, le);
  if ((cputype >>> 0) === 0) fail('main executable slice has no cputype');
  if (filetype !== MH_EXECUTE) fail('main executable slice is not MH_EXECUTE');
  if (ncmds < 1 || ncmds > 4096) fail('main executable has an invalid load-command count');
  if (32 + sizeofcmds > size) fail('load commands extend past the slice');
  let off = start + 32;
  const end = off + sizeofcmds;
  let uuidOff = -1;
  for (let i = 0; i < ncmds; i += 1) {
    if (off + 8 > end) fail('load command is truncated');
    const cmd = u32(buf, off, le);
    const cmdsize = u32(buf, off + 4, le);
    if (cmdsize < 8 || cmdsize % 8 !== 0 || off + cmdsize > end) fail('load command size is invalid');
    if (cmd === LC_UUID) {
      if (cmdsize !== 24) fail('LC_UUID size is invalid');
      if (uuidOff !== -1) fail('main executable slice has more than one LC_UUID');
      uuidOff = off + 8;
    }
    off += cmdsize;
  }
  if (off !== end) fail('load commands do not fill sizeofcmds');
  if (uuidOff < 0) fail('main executable slice has no LC_UUID');
  return { cputype, cpusubtype, uuidOff, start, size };
}

function locateUuids(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) fail('main executable is too small to be a Mach-O');
  const leMagic = buf.readUInt32LE(0);
  const beMagic = buf.readUInt32BE(0);
  if (leMagic === MH_MAGIC_64 || leMagic === MH_CIGAM_64) {
    return [locateSlice(buf, 0, buf.length)];
  }
  let le = false;
  let fat64 = false;
  if (beMagic === FAT_MAGIC || beMagic === FAT_MAGIC_64) {
    le = false;
    fat64 = beMagic === FAT_MAGIC_64;
  } else if (leMagic === FAT_MAGIC || leMagic === FAT_MAGIC_64) {
    le = true;
    fat64 = leMagic === FAT_MAGIC_64;
  } else {
    fail('main executable is not a 64-bit Mach-O or a fat archive');
  }
  const nfat = u32(buf, 4, le);
  if (nfat < 1 || nfat > 8) fail('fat archive has an invalid architecture count');
  const archSize = fat64 ? 32 : 20;
  const headerBytes = 8 + nfat * archSize;
  if (headerBytes > buf.length) fail('fat header is truncated');
  const slices = [];
  for (let i = 0; i < nfat; i += 1) {
    const base = 8 + i * archSize;
    let offset;
    let size;
    if (fat64) {
      offset = u64(buf, base + 8, le);
      size = u64(buf, base + 16, le);
    } else {
      offset = u32(buf, base + 8, le);
      size = u32(buf, base + 12, le);
    }
    if (offset < headerBytes || size < 32 || offset > buf.length || size > buf.length - offset) {
      fail('fat slice is out of range');
    }
    slices.push({ offset, size, ...locateSlice(buf, offset, size) });
  }
  const order = slices.map((slice) => [slice.offset, slice.offset + slice.size]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < order.length; i += 1) {
    if (order[i][0] < order[i - 1][1]) fail('fat slices overlap');
  }
  return slices;
}

function plistString(xml, key) {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  if (!match || !match[1] || /[&<>]/.test(match[1])) fail(`Info.plist has no plain ${key}`);
  return match[1];
}

function realFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_) {
    fail(`cannot read ${file}`);
  }
  if (stat.isSymbolicLink()) fail(`${file} is a symlink; refusing to follow it`);
  if (!stat.isFile()) fail(`${file} is not a regular file`);
  return stat;
}

function stampApp(appPath) {
  let appStat;
  try {
    appStat = fs.lstatSync(appPath);
  } catch (_) {
    fail(`cannot read ${appPath}`);
  }
  if (appStat.isSymbolicLink()) fail('app path is a symlink; refusing to follow it');
  if (!appStat.isDirectory()) fail('app path is not a bundle directory');
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  const infoStat = realFile(infoPath);
  if (infoStat.size > 1024 * 1024) fail('Info.plist is unexpectedly large');
  const infoBuf = fs.readFileSync(infoPath);
  if (infoBuf.length >= 6 && infoBuf.subarray(0, 6).toString('ascii') === 'bplist') {
    fail('Info.plist is binary; refusing to stamp');
  }
  const bundleId = plistString(infoBuf.toString('utf8'), 'CFBundleIdentifier');
  if (bundleId !== BUNDLE_ID) fail(`refusing to stamp bundle id ${bundleId}`);
  const exeName = plistString(infoBuf.toString('utf8'), 'CFBundleExecutable');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/.test(exeName)) fail('CFBundleExecutable is not a single file name');
  const macos = path.join(appPath, 'Contents', 'MacOS');
  const executable = path.join(macos, exeName);
  if (path.relative(macos, executable) !== exeName) fail('CFBundleExecutable escapes Contents/MacOS');
  const exeStat = realFile(executable);
  const original = fs.readFileSync(executable);
  const slices = locateUuids(original);
  const seen = new Set();
  const uuids = [];
  const next = Buffer.from(original);
  for (const slice of slices) {
    const key = `${slice.cputype >>> 0}:${maskedSubtype(slice.cpusubtype)}`;
    if (seen.has(key)) fail('fat archive repeats an architecture');
    seen.add(key);
    const uuid = uuidForSlice(original, slice);
    if (uuids.some((row) => row.uuid === formatUuid(uuid))) fail('architectures produced the same UUID');
    uuid.copy(next, slice.uuidOff);
    uuids.push({
      arch: archName(slice.cputype, slice.cpusubtype),
      uuid: formatUuid(uuid),
      offset: slice.uuidOff,
    });
  }
  if (!next.equals(original)) {
    const mode = exeStat.mode & 0o777;
    const tmp = path.join(macos, `.${exeName}.stamp-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeFileSync(fd, next);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, mode);
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    try {
      const readBack = fs.readFileSync(tmp);
      if (!readBack.equals(next)) fail('stamped executable did not read back');
      const checked = locateUuids(readBack);
      if (checked.length !== uuids.length) fail('stamped executable UUID count changed');
      for (let i = 0; i < checked.length; i += 1) {
        const got = readBack.subarray(checked[i].uuidOff, checked[i].uuidOff + 16);
        if (formatUuid(got) !== uuids[i].uuid) fail('stamped UUID did not read back');
      }
      fs.renameSync(tmp, executable);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }
  return { executable, uuids };
}

function main(argv) {
  if (argv.length !== 3 || !argv[2]) {
    process.stderr.write('error: stamp-main-uuid needs the path to the fork .app\n');
    process.exit(1);
  }
  try {
    const result = stampApp(argv[2]);
    for (const row of result.uuids) process.stdout.write(`${row.uuid} ${row.arch}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv);

module.exports = {
  BUNDLE_ID,
  FORBIDDEN_UUIDS,
  archName,
  formatUuid,
  locateUuids,
  stampApp,
  uuidForSlice,
};
