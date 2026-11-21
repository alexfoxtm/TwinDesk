// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function suggestedName(name) {
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop() : '';
  const clean = base.replace(/[\x00-\x1f\x7f:]/g, '_').trim().replace(/^\.+/, '');
  return clean && Buffer.byteLength(clean) <= 255 ? clean : 'Photo';
}

function entry(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function destination(file) {
  const dir = fs.realpathSync(path.dirname(file));
  const final = path.join(dir, path.basename(file));
  const previous = entry(final);
  if (previous && !previous.isFile()) throw new Error('The destination is not a regular file');
  return { dir, final, previous, directory: entry(dir) };
}

function stage(target) {
  const { dir, directory } = target;
  if (!sameObject(directory, entry(dir))) throw new Error('The destination folder changed');
  const tmp = path.join(dir, `.twindesk-${crypto.randomUUID()}.part`);
  return { tmp, fd: fs.openSync(tmp, 'wx', 0o600) };
}

function sameObject(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

function contains(reserved, file) {
  // Batch paths can start in a different spelling of the same folder, including a symlink.
  let dir = path.dirname(reserved);
  try { dir = fs.realpathSync(dir); } catch { /* it hasn't been created yet */ }
  const top = path.join(dir, path.basename(reserved)).normalize('NFC').toLowerCase();
  const dest = file.normalize('NFC').toLowerCase();
  return dest === top || dest.startsWith(top + path.sep);
}

function publish(target, tmp) {
  const { dir, final, previous, directory } = target;
  if (!sameObject(directory, entry(dir))) throw new Error('The destination folder changed');
  if (!previous) {
    fs.linkSync(tmp, final); // atomic no-clobber even if a file appeared during the transfer
    return;
  }
  const now = entry(final);
  if (!sameObject(previous, now) || previous.ctimeNs !== now.ctimeNs || previous.mtimeNs !== now.mtimeNs) {
    throw new Error('The file chosen for replacement changed');
  }
  fs.renameSync(tmp, final); // replace the approved name atomically after the bytes have been verified
}

function discard(tmp) {
  try { fs.unlinkSync(tmp); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('[photo save as] staging cleanup:', e.code); }
}

function action(drop, getWindow, t) {
  return (id, name, route, live) => drop.savePhotoAs({ id, route, live, choose: async () => {
    const { app, dialog } = require('electron');
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: t('Save As…'),
      defaultPath: path.join(drop.cfg.folder || app.getPath('downloads'), suggestedName(name)),
      properties: ['createDirectory'],
    });
    if (canceled || !filePath || !live() || win.isDestroyed()) return null;
    const target = destination(filePath);
    if (target.previous) {
      // The panel doesn't report which entry was approved. Confirm the observed file before requesting bytes.
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message: t('Replace the existing file?'), detail: path.basename(filePath),
        buttons: [t('Cancel'), t('Replace')], defaultId: 0, cancelId: 0,
      });
      if (response !== 1 || win.isDestroyed()) return null;
    }
    return target;
  } });
}

module.exports = { action, stage, publish, discard, contains };
