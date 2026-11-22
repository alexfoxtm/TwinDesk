// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The settings window stays after its close button, hidden, and is destroyed once
// it has not been opened for IDLE_MS. Quit closes it for real. The timer is unref'd
// so it cannot keep the process up. mac/main.js is the only caller.
'use strict';

const IDLE_MS = 5 * 60 * 1000;

function attach(win, opts) {
  const quitting = opts.quitting;
  const onDead = opts.onDead;
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      timer = null;
      if (quitting() || !win || win.isDestroyed() || win.isVisible()) return;
      onDead(win);
    }, IDLE_MS);
    if (timer.unref) timer.unref();
  };
  win.on('close', (e) => {
    if (quitting()) { disarm(); return; }
    e.preventDefault();
    if (!win.isDestroyed()) win.hide();
    arm();
  });
  win.on('show', disarm);
  win.on('closed', disarm);
  return { arm, disarm };
}

module.exports = { attach, IDLE_MS };
