// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Whether the capture window posts a stats sample. Omitted or true: always
// (mesh, and any start that does not say). false: only a sample with frames,
// so a quiet capture does not cross IPC, and a picture still clears the retry.
'use strict';

function shouldSendStats(reportStats, sample) {
  if (reportStats !== false) return true;
  const s = sample || {};
  return (s.fps || 0) > 0 || (s.mbps || 0) > 0;
}

if (typeof module === 'object' && module.exports) module.exports = { shouldSendStats };
else window.TwinDeskStatsSend = { shouldSendStats };
