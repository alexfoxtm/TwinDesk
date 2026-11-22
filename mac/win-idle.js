// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The settings window stays after its close button, hidden, and is destroyed once
// it has not been opened for IDLE_MS. Quit closes it for real. The timer is unref'd
// so it cannot keep the process up. mac/main.js is the only caller.
'use strict';

const IDLE_MS = 5 * 60 * 1000;
const LEAVE_FULLSCREEN_MS = 2000; // a missing leave-full-screen must not leave the window unclosable

function attach(win, opts) {
  const quitting = opts.quitting;
  const onDead = opts.onDead;
  let timer = null;
  let leaveTimer = null;
  let leaveGen = 0;
  let onLeft = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
  };
  const dropLeave = () => {
    leaveGen++;
    clearTimeout(leaveTimer);
    leaveTimer = null;
    if (onLeft) {
      win.removeListener('leave-full-screen', onLeft);
      onLeft = null;
    }
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
  const hideNow = () => {
    if (quitting() || !win || win.isDestroyed()) return;
    win.hide();
    arm();
  };
  win.on('close', (e) => {
    if (quitting()) { dropLeave(); disarm(); return; }
    e.preventDefault();
    if (!win || win.isDestroyed()) return;
    // hide() while native full screen leaves an empty Space. Leave first, then hide.
    // A window that is full screen on another Space still reports isFullScreen.
    if (typeof win.isFullScreen === 'function' && win.isFullScreen()) {
      if (leaveTimer) return;
      const gen = ++leaveGen;
      onLeft = () => {
        if (gen !== leaveGen || quitting() || win.isDestroyed()) return;
        clearTimeout(leaveTimer);
        leaveTimer = null;
        onLeft = null;
        hideNow();
      };
      win.once('leave-full-screen', onLeft);
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (gen !== leaveGen || quitting() || win.isDestroyed()) return;
        if (onLeft) {
          win.removeListener('leave-full-screen', onLeft);
          onLeft = null;
        }
        // Still full screen: destroy, as a close used to, so the Space goes away.
        // Already left, and the event was lost: hide, and keep the window.
        if (win.isFullScreen()) onDead(win);
        else hideNow();
      }, LEAVE_FULLSCREEN_MS);
      if (leaveTimer.unref) leaveTimer.unref();
      win.setFullScreen(false);
      return;
    }
    hideNow();
  });
  win.on('show', () => { dropLeave(); disarm(); });
  win.on('closed', () => { dropLeave(); disarm(); });
  return { arm, disarm, hold: dropLeave };
}

module.exports = { attach, IDLE_MS, LEAVE_FULLSCREEN_MS };
