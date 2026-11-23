// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// When the Mac's background timers have a reader. main.js asks; it does not
// decide. A window on screen or a live stream is not a reader of the file
// percentage: that number is the tray title, the transfer popup and the
// transfer notification. Addresses are read for the settings window and while
// a peer is connected. Permissions are read only while that window is visible
// and something is still missing. Bluetooth is read every 3 s during a session
// or while the window is watched, and every 20 s otherwise (the iPhone invite
// already waits that long).
'use strict';

function pctShouldRun({ drop, send, trayTitle } = {}) {
  const dv = drop || {};
  const sv = send || {};
  if (trayTitle) return true;
  if ((dv.inBatches && dv.inBatches.length) || (dv.receiving && dv.receiving.length)) return true;
  if ((sv.outBatches && sv.outBatches.length) || (sv.sending && sv.sending.length)) return true;
  return false;
}

function permShouldPoll({ visible, permissions } = {}) {
  if (!visible) return false;
  const p = permissions || {};
  return p.screen !== 'granted' || !p.accessibility || p.inputMonitoring === false;
}

function addrShouldPoll({ peerConnected, windowWatching } = {}) {
  return !!(peerConnected || windowWatching);
}

function bleIntervalMs({ peerConnected, windowWatching } = {}) {
  return (peerConnected || windowWatching) ? 3000 : 20000;
}

module.exports = { pctShouldRun, permShouldPoll, addrShouldPoll, bleIntervalMs };
