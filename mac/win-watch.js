// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Whether the settings window is actually on screen. The main process skips the
// window's state push while it is not (mac/main.js). Electron 44 has no public
// occlusion API: isVisible() stays true when another window covers this one.
// Chromium reports full occlusion as document.visibilityState hidden while
// background throttling is left on (this window does not turn it off). The
// renderer reports that. A null page flag means it has not reported yet, so a
// window that is merely shown still gets its first state.
'use strict';

function watching(win, pageVisible) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  if (typeof win.isVisible === 'function' && win.isVisible() === false) return false;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
  if (pageVisible === false) return false;
  return true;
}

// page: null until the renderer reports, then true or false.
// seen: we already pushed for the current watched stretch. unsee() on hide or
// minimize, so the next show or restore pushes once even if the page flag was
// never false (isVisible() flips only after the show event).
function createWatch() {
  let page = null;
  let seen = false;
  return {
    watching(win) { return watching(win, page); },
    // null leaves the page flag alone: show/restore fire before the document
    // reports, and must not forget a "hidden" that is still true (a covered window).
    note(win, visible) {
      if (visible !== null) page = visible === true;
      const now = watching(win, page);
      const edge = now && !seen;
      seen = now;
      return edge;
    },
    mark(win) { seen = watching(win, page); },
    unsee() { seen = false; },
    reset() { page = null; seen = false; },
  };
}

module.exports = { watching, createWatch };
