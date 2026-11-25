// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { TurnThread } = require('../shared/turn.js');
const P = require('../shared/protocol.js');

// Keep the harness separate from the wired listener and its credentials.
function netemTurn(listener) {
  const phone = process.env.TWINDESK_NETEM_PHONE;
  if (!phone || !/^[A-Za-z0-9._-]{1,64}$/.test(phone)) return () => null;

  const turn = new TurnThread({ port: 43200, allocationsOnly: true });
  let ready = false;
  listener.once('close', () => { ready = false; turn.stop(); });
  turn.start().then(() => { ready = true; }, () => console.error('[netem] test TURN listener unavailable'));
  return (ctx) => {
    if (!ready || !ctx.authed || !ctx.ws || ctx.released || !ctx.netemRequested || ctx.deviceId !== phone ||
        !P.isPhoneOs(ctx.os) || ctx.transport !== 'ip' || ctx.address !== '127.0.0.1') return;
    const owner = ctx.ws;
    const ice = { ...turn.ice(), netem: true };
    Object.defineProperty(ctx, 'netemIce', {
      get: () => ready && ctx.ws === owner && !ctx.released ? ice : null,
    });
  };
}

module.exports = { netemTurn };
