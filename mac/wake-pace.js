// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// When the Mac's background timers have a reader. main.js asks; it does not
// decide. A window on screen or a live stream is not a reader of the file
// percentage: that number is the tray title, the transfer popup and the
// transfer notification. Addresses are read only while the settings window is
// watched; a connected peer with that window hidden does not poll. Permissions
// are read only while that window is visible and something is still missing.
// Bluetooth is read every 3 s while the window is watched, or while a connected
// session is still inside the Wi-Fi settle (it wants Bluetooth off, and that
// has not happened yet). Once that settles, and while nothing is connected, it
// is every 20 s. The iPhone invite already waits that long.
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

function addrShouldPoll({ windowWatching } = {}) {
  return !!windowWatching;
}

// bleSettled: Wi-Fi quiet is not in its 5 s wait. True when this session is not
// a candidate for turning Bluetooth off, or bleOff is already true.
function bleIntervalMs({ peerConnected, windowWatching, bleSettled } = {}) {
  if (windowWatching) return 3000;
  if (peerConnected && !bleSettled) return 3000;
  return 20000;
}

module.exports = { pctShouldRun, permShouldPoll, addrShouldPoll, bleIntervalMs };
