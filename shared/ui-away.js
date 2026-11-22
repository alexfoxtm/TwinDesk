// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The control window left open behind other windows: its ambient animations (the breathing dot, the
// link's pulse, a page's art) repaint every frame for as long as it is on screen, about a fifth of
// a processor core on a Mac with a phone connected. While the window isn't the focused one they are
// paused (shared/ui-away.css) and go on from where they stopped when it is focused again. Spinners
// and progress bars keep moving: they show work in progress, and a still one reads as a hang.
'use strict';
(function () {
  function watch(win, doc) {
    const set = (away) => doc.documentElement.classList.toggle('td-away', !!away);
    win.addEventListener('blur', () => set(true));
    win.addEventListener('focus', () => set(false));
    set(!doc.hasFocus());
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { watch };
  else watch(window, document);
})();
