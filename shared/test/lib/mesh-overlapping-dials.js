'use strict';

const assert = require('node:assert/strict');

// Let both pinned TLS connections reach HELLO before delivering either one.
// Run both arrival orders so each side has to retire its still-dialling socket.
module.exports = async function overlappingDials(lo, hi, { linked, socketCount, waitFor }) {
  const low = lo.links.get(hi.id);
  const high = hi.links.get(lo.id);
  hi.links.inboundWaitMs = 0; // Model the larger peer's wait having already elapsed.

  for (const [winner, yielding] of [[low, high], [high, low]]) {
    await waitFor(() => linked(lo, hi) && socketCount(lo, hi) === 1, 'one established link');
    const hellos = new Map();
    const lowHello = low._hello;
    const highHello = high._hello;
    low._hello = () => hellos.set(low, () => lowHello.call(low));
    high._hello = () => hellos.set(high, () => highHello.call(high));
    try {
      (low.authed ? low : high).ws.terminate();
      await waitFor(() => hellos.size === 2, 'both outbound TLS dials awaiting HELLO');
      const retiring = yielding.ws;
      assert.ok(retiring && winner.ws);
      assert.equal(yielding.authed, false);
      assert.equal(winner.authed, false);
      hellos.get(winner)();
      await waitFor(() => linked(lo, hi) && winner.authed && retiring.readyState === 3,
        'one authenticated link and the overlapping socket closed');
      assert.equal(yielding.ws, null);
      assert.equal(socketCount(lo, hi), 1);
    } finally {
      low._hello = lowHello;
      high._hello = highHello;
    }
  }
};
