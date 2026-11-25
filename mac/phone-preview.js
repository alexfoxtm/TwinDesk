// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { OS } = require('../shared/protocol.js');
const { screenSize } = require('../shared/nativescreen.js');
const MAX_PREVIEWS = 16;
const MAX_JPEG = 32 * 1024;
const MIN_INTERVAL = 4000;

// ReplayKit supplies the pictured screen because iOS has no public wallpaper API. Keep it in
// memory for the lifetime of the pairing, alongside neither settings nor transfer history.
class PhonePreviews {
  constructor(pairing) {
    this.pairing = pairing;
    this.sessions = new WeakMap();
    this.frames = new Map();
    this.revision = 0;
    pairing.on('change', () => this.prune());
  }

  authorize(ctx, pair) {
    if (pair.os === OS.IOS) this.sessions.set(ctx, pair);
  }

  owner(ctx) {
    const pair = ctx && this.sessions.get(ctx);
    return pair && ctx.authed && !ctx.released && ctx.deviceId === pair.id
      && pair.os === OS.IOS && this.pairing.paired.includes(pair) ? pair : null;
  }

  prune() {
    for (const pair of this.frames.keys()) {
      if (pair.os !== OS.IOS || !this.pairing.paired.includes(pair)) this.frames.delete(pair);
    }
  }

  save(ctx, data, display, info) {
    const pair = this.owner(ctx);
    if (!pair || typeof data !== 'string' || data.length > MAX_JPEG) return false;
    const now = performance.now();
    const previous = this.frames.get(pair);
    if (previous && now - previous.at < MIN_INTERVAL) return false;
    if (!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
    const size = screenSize(display?.width, display?.height);
    if (!size) return false;
    const platform = ['ios', 'ipados'].includes(info?.platform) ? info.platform : '';
    this.frames.delete(pair);
    if (this.frames.size >= MAX_PREVIEWS) this.frames.delete(this.frames.keys().next().value);
    this.frames.set(pair, { id: pair.id, revision: ++this.revision, at: now, platform,
      display: { w: size.width, h: size.height }, data });
    return true;
  }

  list(images = false) {
    this.prune();
    return [...this.frames.values()].map(({ id, revision, platform, display, data }) =>
      ({ id, revision, platform, display, ...(images ? { data } : {}) }));
  }
}

module.exports = { PhonePreviews };
