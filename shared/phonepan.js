// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Turn a trackpad movement into a short, bounded scrcpy finger drag.
'use strict';
class PhonePan {
  constructor() { this.active = null; this.pending = null; this.timer = null; }
  end() {
    clearTimeout(this.timer); this.timer = null; this.pending = null;
    const s = this.active; this.active = null;
    if (s && !s.ctl.closed) s.ctl.touch(1, 2, s.x, s.y, s.w, s.h, 0);
  }
  move(ctl, display, pointer, dx, dy) {
    if (!ctl || ctl.closed || typeof ctl.touch !== 'function' || !display || !pointer || pointer.buttons || pointer.mouse === false || !Number.isFinite(dx) || !Number.isFinite(dy)) { this.end(); return; }
    const w = Number(display.w), h = Number(display.h), dpi = Number(display.dpi) > 0 && Number(display.dpi) < 2000 ? Number(display.dpi) : 420;
    const margin = Math.max(8, Math.ceil(dpi * 48 / 160)), slop = Math.max(8, Math.ceil(dpi * 12 / 160));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w > 65535 || h > 65535 || w <= 2 * (margin + slop) || h <= 2 * (margin + slop)) { this.end(); return; }
    if (this.active && (this.active.ctl !== ctl || this.active.w !== w || this.active.h !== h)) this.end();
    if (!this.active) {
      const pending = this.pending || (this.pending = { dx: 0, dy: 0 });
      pending.dx += dx; pending.dy += dy;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.end(), 120);
      if (this.timer.unref) this.timer.unref();
      if (Math.hypot(pending.dx, pending.dy) < slop) return;
      dx = pending.dx; dy = pending.dy; this.pending = null;
      const x = Math.max(margin + slop, Math.min(w - 1 - margin - slop, Number(pointer.x) || 0));
      const y = Math.max(margin + slop, Math.min(h - 1 - margin - slop, Number(pointer.y) || 0));
      this.active = { ctl, x, y, w, h, startX: x, startY: y };
      ctl.touch(0, 2, x, y, w, h);
    }
    const s = this.active;
    const x = Math.max(margin, Math.min(w - 1 - margin, s.x + dx));
    const y = Math.max(margin, Math.min(h - 1 - margin, s.y + dy));
    if (x === s.x && y === s.y && (dx || dy)) {
      this.end();
      return this.move(ctl, display, { ...pointer, x: s.startX, y: s.startY }, dx, dy);
    }
    s.x = x; s.y = y;
    ctl.touch(2, 2, s.x, s.y, w, h);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), 120);
    if (this.timer.unref) this.timer.unref();
  }
}
module.exports = { PhonePan };
