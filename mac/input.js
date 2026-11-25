// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Input inside Monitor 2 (in.* -> mac-helper `input`, keys swapped Ctrl<->Cmd when
// `swapKeys()`; a phone's stylus with its `pen`). The clipboard lives in clipboard.js.
//
// Stream input is applied only while `enabled()` is true (KVM home; switch it off).
// Everything we hold is released when the PC goes away, when Monitor 2 loses focus (Windows
// sends `clip.request` then), and when the stream restarts.
'use strict';

const P = require('../shared/protocol.js');

const IN_TYPES = [P.T.IN_MOVE, P.T.IN_DOWN, P.T.IN_UP, P.T.IN_WHEEL, P.T.IN_KEY_DOWN, P.T.IN_KEY_UP];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

class Input {
  constructor(server, helper, displays, { enabled = () => true, swapKeys = () => true, listen = true } = {}) {
    this.server = server;
    this.helper = helper;
    this.displays = displays;
    this.enabled = enabled;
    this.swapKeys = swapKeys;
    this.dirty = false; // something may be held in the helper
    this.focusRequest = 0;
    if (!listen) return; // Mesh authorizes and routes the same events before injection.
    server.on('client', () => { this.focusRequest++; });
    server.on('closed', () => { this.focusRequest++; });

    for (const t of IN_TYPES) server.on(`t:${t}`, (msg, ctx) => this._onInput(msg, ctx));
    server.on('closed', () => {
      if (!server.current) this.releaseAll();
    });
    server.on(`t:${P.T.CLIP_REQUEST}`, () => this.releaseAll()); // Monitor 2 lost focus
  }

  _onInput(msg, ctx) {
    if (msg.wid != null || !this.enabled() || !this.inject(msg, this.displays.target())) return;
    const samePeer = () => ctx?.authed && ctx.ws && this.server.current?.ws === ctx.ws && this.server.current?.deviceId === ctx.deviceId;
    if (msg.t === P.T.IN_UP && (num(msg.b) | 0) <= 0 && ctx?.os === 'android' && samePeer()) {
      this.textFocus(() => this.enabled() && samePeer(), (m) => this.server.sendToClient(m));
    }
  }

  inject(msg, target, { swapKeys = this.swapKeys(), meshScreen, scrollAt } = {}) {
    if (!target) return false;
    const route = { bounds: target.bounds };
    if (meshScreen) route.meshScreen = true;
    let ev;
    switch (msg.t) {
      case P.T.IN_MOVE:
        ev = { t: msg.t, x: num(msg.x), y: num(msg.y) };
        break;
      case P.T.IN_DOWN:
      case P.T.IN_UP:
        ev = { t: msg.t, x: num(msg.x), y: num(msg.y), b: Math.max(0, Math.min(4, num(msg.b) | 0)) };
        break;
      case P.T.IN_WHEEL:
        ev = { t: msg.t, dx: num(msg.dx), dy: num(msg.dy), ...scrollAt };
        break;
      default: // in.kd / in.ku
        if (typeof msg.code !== 'string' || msg.code.length > 32) return false;
        ev = { t: msg.t, code: swapKeys ? P.mapKeyFromOtherPlatform(msg.code) : msg.code };
    }
    const pen = msg.t === P.T.IN_MOVE || msg.t === P.T.IN_DOWN || msg.t === P.T.IN_UP ? P.penOf(msg.pen) : null;
    if (pen) ev.pen = pen; // a phone's stylus: a tablet pen (Inject.swift)
    if (pen && msg.t === P.T.IN_MOVE) { // the stroke's samples before this one, in order
      for (const q of P.penPoints(msg.pts, pen)) this.helper.send('input', { ev: { t: msg.t, x: q.x, y: q.y, pen: q.pen }, ...route });
    }
    if (meshScreen || (msg.t !== P.T.IN_MOVE && msg.t !== P.T.IN_WHEEL)) this.dirty = true;
    this.helper.send('input', { ev, ...route });
    return true;
  }

  textFocus(still, reply) {
    const request = ++this.focusRequest;
    setTimeout(async () => {
      const current = () => request === this.focusRequest && still();
      if (!current()) return;
      try {
        const focus = await this.helper.request('textFocus', {}, 1000);
        if (current() && focus.editable === true) reply({ t: 'screen.textFocus', secure: focus.secure === true });
      } catch (_) { /* The viewer's Keyboard button remains available. */ }
    }, 150);
  }

  releaseAll() {
    this.focusRequest++;
    if (!this.dirty) return;
    this.dirty = false;
    this.helper.send('releaseAll');
  }
}

module.exports = { Input, IN_TYPES };
