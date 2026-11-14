// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files with LocalSend-compatible apps on the Mac: shared/localsend/wire.js with the Mac's own
// question, file dialog and notifications (the one-to-one app and the multi-device app both use
// this). Off until turned on (Files); every arriving transfer is asked about, here and on the page,
// with Decline as the button Return presses.
'use strict';

const path = require('path');
const { app, dialog, ipcMain, Notification, shell } = require('electron');
const { startLocalSend } = require('../shared/localsend/wire.js');

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

// { settings(), save(), pushState(), t, name(), receivedDir(), window() } → { view(), actions, shutdown() }
function setupLocalSend({ settings, save, pushState, t, name, receivedDir, window, log }) {
  const say = (title, body, onClick) => {
    if (!Notification.isSupported()) return;
    try {
      const n = new Notification({ title, body: body || '' });
      if (onClick) n.on('click', onClick);
      n.show();
    } catch { /* no notifications: the page shows it */ }
  };
  const parent = () => { const w = window && window(); return w && !w.isDestroyed() && w.isVisible() ? w : null; };
  const ls = startLocalSend({
    dir: path.join(app.getPath('userData'), 'localsend'),
    settings, save, pushState, t, name, receivedDir, log, say,
    reveal: (p) => shell.showItemInFolder(p),
    // One offer: who it says it is, from where, whether it proved which device it is (its
    // certificate), whether that device is one known from before, and what. The signal ends the
    // question when it was answered on the page or ran out.
    async ask(offer, signal) {
      const file = offer.names.length === 1 && offer.files === 1 ? offer.names[0] : t(offer.files === 1 ? '{count} file' : '{count} files', { count: offer.files });
      const message = t('{name} wants to send {file} ({size})', { name: offer.alias, file, size: bytes(offer.total) });
      say(message, t('Open TwinDesk to accept or decline'));
      const detail = [
        t('From {address} with a LocalSend-compatible app.', { address: offer.ip }),
        offer.verified ? '' : t('This sender didn’t prove which device it is: its name is only what it says.'),
        offer.imitates ? t('Another device uses this name: this may not be the one you think.') : '',
        offer.known ? '' : t('This device hasn’t been seen before: accept only if you expect it.'),
        offer.text ? `“${offer.text.slice(0, 400)}”` : '',
        t('Accepted files go to {folder}.', { folder: receivedDir() }),
      ].filter(Boolean).join('\n\n');
      const opts = { type: 'question', message, detail, buttons: [t('Decline'), t('Accept')], defaultId: 0, cancelId: 0, signal };
      const w = parent();
      try {
        const r = await (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts));
        return signal.aborted ? null : r.response === 1;
      } catch { return null; }
    },
    async choose() {
      const opts = { title: t('Send files'), buttonLabel: t('Send'), properties: ['openFile', 'openDirectory', 'multiSelections'] };
      const w = parent();
      const r = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
      return r.canceled ? [] : r.filePaths;
    },
  });
  for (const [action, fn] of Object.entries(ls.actions)) ipcMain.on(action, (_e, arg) => fn(arg));
  app.on('before-quit', () => ls.shutdown());
  return ls;
}

module.exports = { setupLocalSend };
