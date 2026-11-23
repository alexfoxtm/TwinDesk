// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's copies reaching the computer with TwinDesk in the background there (#257). They come
// from scrcpy's control session (clipboard_autosync: Android tells the shell of each copy), which
// never fires on some phones (seen on a Galaxy S26 Ultra, Android 17): only what the phone's app sent
// while it was open reached the computer. A copy the app sends that scrcpy didn't report is that
// sign: from then on, for this run, the computer asks for the phone's clipboard every POLL_MS while
// the control session is up (a small binder read; Android notes it once per copy, as it does for the
// listener). Phones whose listener works never poll.
//   clipWatch(bridge) — bridge: the phone bridge {server (peer), control (Session), lastPhoneClip}
'use strict';

const POLL_MS = 1500;
const GRACE_MS = 1500;

function clipWatch(bridge) {
  let timer = null;
  let armed = false; // scrcpy missed a copy: keep asking until stop(), even if a tick is paused
  // Absent on Windows, Linux and mesh: those keep polling once armed. The Mac sets it.
  const allowed = () => typeof bridge.allowClipPoll !== 'function' || bridge.allowClipPoll() !== false;
  const clear = () => { clearInterval(timer); timer = null; };
  const stop = () => { armed = false; clear(); };
  const tick = () => {
    if (!allowed()) return clear();
    const s = bridge.control;
    if (!s || s.closed) return;
    try { s.getClipboard(); } catch (_) { stop(); }
  };
  const start = () => {
    if (timer || !armed || !allowed()) return;
    const s = bridge.control;
    if (!s || s.closed) return;
    timer = setInterval(tick, POLL_MS);
    if (timer.unref) timer.unref();
  };
  // Clipboard sync or the peer changed: pause, or resume a poll that was already armed.
  const sync = () => { if (armed) (allowed() ? start() : clear()); };
  bridge.server.on('t:clip', (m) => {
    if (!m || typeof m.text !== 'string' || !m.text || m.text === bridge.lastPhoneClip || timer || armed) return; // ours (scrcpy's), injected
    const c = bridge.control;
    if (!c || c.closed) return; // no control session: nothing missed it
    // The app's copy may come a moment before scrcpy's: missed only if scrcpy still hasn't said so.
    const t = setTimeout(() => {
      if (timer || armed || bridge.lastPhoneClip === m.text || bridge.control !== c || c.closed) return;
      bridge.lastPhoneClip = m.text;
      console.log('[phone] the phone’s copies don’t reach TwinDesk in the background: asking for them every 1.5 s');
      armed = true;
      start();
    }, GRACE_MS);
    if (t.unref) t.unref();
  });
  return { stop, sync, get polling() { return !!timer; } };
}

module.exports = { clipWatch, POLL_MS };
