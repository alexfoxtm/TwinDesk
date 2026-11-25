// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { performance } = require('node:perf_hooks');
const { T } = require('../shared/protocol.js');

const CONTROL = new Map([
  [T.WELCOME, 'welcome'],
  [T.SCREEN_POLICY, 'screen_policy'],
  [T.SCREEN_CTL, 'screen_ctl'],
  [T.SCREEN_STATE, 'screen_state'],
  [T.STREAM_STOP, 'stream_stop'],
  [T.RTC_OFFER, 'rtc_offer'],
  [T.RTC_ANSWER, 'rtc_answer'],
  [T.PHONE_APPS_LIST, 'phone_apps_request'],
  [T.PHONE_APPS, 'phone_apps'],
  ['phone.apps.ready', 'phone_apps_ready'],
]);

function startNetemTrace(ctx, ws) {
  const started = performance.now();
  let remaining = 80;
  const write = (event, fields = '') => {
    if (remaining <= 0 || ctx.ws !== ws || !ctx.authed || ctx.released ||
        ws.readyState !== (ws.OPEN ?? 1)) return;
    remaining--;
    console.log(`[TwinDeskNetem] stage=${event} elapsed_ms=${Math.round(performance.now() - started)}${fields}`);
  };

  return {
    control(direction, msg, data) {
      const kind = CONTROL.get(msg.t);
      if (!kind) return;
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      let flags = '';
      if (msg.t === T.SCREEN_POLICY) flags = ` accept=${Number(msg.accept === true)}`;
      if (msg.t === T.SCREEN_CTL) {
        const share = typeof msg.share === 'boolean' ? Number(msg.share) : -1;
        const display = msg.displayId != null && msg.displayId !== '';
        flags = ` share=${share} display=${Number(display)}`;
      }
      if (msg.t === T.SCREEN_STATE) flags = ` sharing=${Number(msg.on === true)} remote=${Number(msg.remote !== false)}`;
      if (msg.t === T.RTC_OFFER) flags = ` test_turn=${Number(msg.ice?.netem === true)}`;
      write(`${direction}_${kind}`, ` bytes=${bytes} queued_bytes=${ws.bufferedAmount || 0}${flags}`);
    },
    turn(ready) {
      write('turn_config', ` ready=${Number(ready)}`);
    },
    policy(msg, stream, sharing, selected) {
      const prev = stream.viewer == null ? -1 : Number(stream.viewer);
      write('stream_policy', ` accept=${Number(msg.accept === true)} previous=${prev} selected=${Number(selected)}` +
        ` sharing=${Number(sharing.on === true)} remote=${Number(sharing.remote !== false)} off=${Number(stream.choice?.mode === 'none')}`);
    },
    capture(status) {
      write(`capture_${status}`);
    },
  };
}

// Observe the actual per-device route before Stream consumes its policy. Only an ingress
// still owned by this route can be attributed to the diagnostic socket.
function observeNetemStream(stream, peer, settings, hub) {
  peer.route.prependListener(`t:${T.SCREEN_POLICY}`, (msg, view) => {
    const owner = view?.source?.();
    if (!owner?.netemTrace || peer.current?.conn !== owner) return;
    owner.netemTrace.policy(msg, stream, settings().sharing, hub.selectedId === peer.id);
  });
  let last = null;
  stream.on('change', () => {
    const active = stream.active;
    const owner = active?.detailOwner;
    if (!owner?.netemTrace || peer.current?.conn !== owner) return;
    const raw = stream.view.status;
    const status = raw.startsWith('error') ? 'error' : (
      raw === 'starting' || raw === 'connecting' || raw === 'live' || raw === 'failed' ||
      raw === 'disconnected' ? raw : raw === 'waiting for answer' ? 'wait_answer' : '');
    if (!status || (last?.owner === owner && last.session === active.session && last.status === status)) return;
    last = { owner, session: active.session, status };
    owner.netemTrace.capture(status);
  });
}

module.exports = { startNetemTrace, observeNetemStream };
