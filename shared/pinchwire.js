// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Two phone.in 'z' dialects share the action and, on the fork, the capability name input.pinch.
//   legacy  fork c49da681: {a:'z', x, y, v} with x,y normalized 0..1 and v the summed magnification
//           in [-1, 1]. The phone lays the fingers out. Old Macs send this only when they see
//           input.pinch.
//   stroke  upstream 58bef59c: {a:'z', x, y, from, to, vert} in pixels (shared/pinch.js). Upstream
//           Android speaks this and does not advertise input.pinch.
// input.pinch alone stays the legacy dialect. It is not a hint about stroke. A phone that also
// understands stroke says so with input.pinch.stroke, added beside input.pinch so an old Mac still
// sends legacy. No pinch capability means stroke: that is upstream's protocol, not a guess that
// input.pinch means pixels.
'use strict';

const CAP_LEGACY = 'input.pinch';
const CAP_STROKE = 'input.pinch.stroke';

function capSet(info) {
  const list = info && Array.isArray(info.caps) ? info.caps : Array.isArray(info) ? info : [];
  return new Set(list.filter((c) => typeof c === 'string').slice(0, 50));
}

// 'legacy' | 'stroke'. Stroke is explicit (input.pinch.stroke) or upstream (no pinch cap).
function pinchDialect(info) {
  const caps = capSet(info);
  if (caps.has(CAP_STROKE)) return 'stroke';
  if (caps.has(CAP_LEGACY)) return 'legacy';
  return 'stroke';
}

// 'stroke' | 'legacy' | 'reject'. Field presence decides. Magnitudes do not: a pixel can be small.
// Both families, or a partial stroke (from without to, vert alone), is not a pinch.
function classifyPinch(msg) {
  if (!msg || typeof msg !== 'object') return 'reject';
  const hasFrom = Object.prototype.hasOwnProperty.call(msg, 'from');
  const hasTo = Object.prototype.hasOwnProperty.call(msg, 'to');
  const hasVert = Object.prototype.hasOwnProperty.call(msg, 'vert');
  const hasV = Object.prototype.hasOwnProperty.call(msg, 'v');
  const stroke = hasFrom || hasTo || hasVert;
  if (stroke && hasV) return 'reject';
  if (hasFrom && hasTo) return 'stroke';
  if (hasV && !stroke) return 'legacy';
  return 'reject';
}

module.exports = { CAP_LEGACY, CAP_STROKE, pinchDialect, classifyPinch };
