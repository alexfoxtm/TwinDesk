// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { TurnThread } = require('../shared/turn.js');
const P = require('../shared/protocol.js');
const { startNetemTrace } = require('./netem-trace.js');

// Keep the harness separate from the wired listener and its credentials.
function netemTurn(listener) {
  const phone = process.env.TWINDESK_NETEM_PHONE;
  if (!phone || !/^[A-Za-z0-9._-]{1,64}$/.test(phone)) return () => null;

  const turn = new TurnThread({ port: 43200, allocationsOnly: true });
  let ready = false;
  let closed = false;
  listener.once('close', () => { closed = true; ready = false; turn.stop(); });
  turn.start().then(() => { ready = !closed; }, () => {
    if (!closed) console.error('[netem] test TURN listener unavailable');
  });
  return (ctx) => {
    const owner = ctx.ws;
    const open = () => owner && owner.readyState === (owner.OPEN ?? 1);
    if (!ctx.authed || !open() || ctx.released || !ctx.netemRequested || ctx.deviceId !== phone ||
        !P.isPhoneOs(ctx.os) || ctx.transport !== 'ip' || ctx.address !== '127.0.0.1') return;
    owner.netemTrace = startNetemTrace(ctx, owner);
    owner.netemTrace.turn(ready);
    if (!ready) return;
    const ice = { ...turn.ice(), netem: true };
    Object.defineProperty(ctx, 'netemIce', {
      get: () => ready && ctx.ws === owner && open() && !ctx.released ? ice : null,
    });
  };
}

module.exports = { netemTurn };
