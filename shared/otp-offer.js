// TwinDesk — GPL-3.0, see LICENSE.
// Short-lived, session-scoped OTP offer coordinator for Mac (Notifications, SMS, Google Messages).
// Reuses shared/otp.js (otpOf, quietCopy). Dedupes across authorized sources for the current phone,
// keeps opt-in auto-copy semantics, and runs user-initiated "Use code" with verified focused-field
// fill or secure local-only expiring copy fallback. Never logs or persists code digits.
'use strict';

const { randomUUID } = require('crypto');
const { otpOf } = require('./otp.js');

const CODE_RE = /^\d{4,8}$/;
const DEFAULT_TTL_MS = 120000;
const DEFAULT_FRESH_MS = 120000;
const MAX_FUTURE_SKEW_MS = 60000;
const TARGET_MAX_AGE_MS = 30000;
const TARGET_WAIT_MS = 250;
const MAX_RECENT = 64;

const cleanLabel = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '');

class OtpOfferTracker {
  constructor(opts = {}) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.freshMs = Number.isFinite(opts.freshMs) && opts.freshMs > 0 ? opts.freshMs : DEFAULT_FRESH_MS;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
    this.clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
    this.copy = typeof opts.copy === 'function' ? opts.copy : () => false;
    this.fill = typeof opts.fill === 'function' ? opts.fill : null;
    this.captureTarget = typeof opts.captureTarget === 'function' ? opts.captureTarget : null;
    this.presentOffer = typeof opts.presentOffer === 'function' ? opts.presentOffer : null;
    this.dismissOffer = typeof opts.dismissOffer === 'function' ? opts.dismissOffer : null;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.offers = new Map(); // id -> offer
    this.recent = new Map(); // `${phoneId}\u0001${code}` -> { id, expiresAt }
  }

  _key(phoneId, code) {
    return `${phoneId}\u0001${code}`;
  }

  _prune() {
    const now = this.now();
    let changed = false;
    for (const [k, rec] of this.recent) {
      if (rec.expiresAt <= now) this.recent.delete(k);
    }
    for (const offer of [...this.offers.values()]) {
      if (offer.expiresAt <= now || !this._isAuthorized(offer)) {
        this._remove(offer);
        changed = true;
      }
    }
    return changed;
  }

  _isAuthorized(offer) {
    if (!offer || offer.expiresAt <= this.now()) return false;
    try {
      return typeof offer.isAuthorized === 'function' ? offer.isAuthorized() === true : true;
    } catch {
      return false;
    }
  }

  _remove(offer) {
    if (!offer || !this.offers.has(offer.id)) return;
    if (offer.timer) {
      this.clearTimer(offer.timer);
      offer.timer = null;
    }
    this.offers.delete(offer.id);
    if (offer.presentedSynthetic && this.dismissOffer) {
      offer.presentedSynthetic = false;
      try { this.dismissOffer(offer); } catch {}
    }
  }

  _scheduleExpiry(offer) {
    if (offer.timer) this.clearTimer(offer.timer);
    const delay = Math.max(0, offer.expiresAt - this.now());
    const t = this.setTimer(() => {
      if (!this.offers.has(offer.id)) return;
      this._remove(offer);
      this.onChange();
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
    offer.timer = t;
  }

  // Ingest a new authorized inbound event from 'notif' | 'sms' | 'gmessages'.
  // Returns { accepted, duplicate, offer, copied } or null when rejected / no code.
  ingest({ source, phoneId, session, text, code: rawCode, at, label, notifId, autoCopy = false, isAuthorized }) {
    this._prune();
    if (!['notif', 'sms', 'gmessages'].includes(source)) return null;
    if (typeof phoneId !== 'string' || !phoneId) return null;
    if (typeof isAuthorized === 'function') {
      try { if (isAuthorized() !== true) return null; } catch { return null; }
    }
    const code = typeof rawCode === 'string' && CODE_RE.test(rawCode.trim()) ? rawCode.trim() : otpOf(text);
    if (!code || !CODE_RE.test(code)) return null;

    const now = this.now();
    if (at !== undefined && at !== null) {
      const ts = Number(at);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      if (now - ts > this.freshMs) return null;
      if (ts - now > MAX_FUTURE_SKEW_MS) return null;
    }

    const key = this._key(phoneId, code);
    const seen = this.recent.get(key);
    if (seen && seen.expiresAt > now) {
      const existing = this.offers.get(seen.id);
      if (existing && this._isAuthorized(existing)) {
        existing.sources.add(source);
        if (notifId && !existing.notifId) existing.notifId = notifId;
        if (label && !existing.label) existing.label = cleanLabel(label);
        if (source === 'notif' && existing.presentedSynthetic && this.dismissOffer) {
          existing.presentedSynthetic = false;
          try { this.dismissOffer(existing); } catch {}
        }
        return { accepted: false, duplicate: true, offer: existing, copied: false };
      }
      // Recently consumed/dismissed duplicate from a secondary source within the dedupe window.
      return { accepted: false, duplicate: true, offer: null, copied: false };
    }

    const id = randomUUID();
    const offer = {
      id,
      phoneId,
      session: session ?? null,
      code,
      source,
      sources: new Set([source]),
      label: cleanLabel(label),
      at: Number.isFinite(Number(at)) && Number(at) > 0 ? Math.min(Number(at), now) : now,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      notifId: typeof notifId === 'string' ? notifId : '',
      isAuthorized: typeof isAuthorized === 'function' ? isAuthorized : () => true,
      targetToken: '',
      targetAt: 0,
      targetPromise: null,
      presentedSynthetic: false,
      timer: null,
    };

    // Keep one active offer per phone so a newer code replaces any older synthetic popup.
    for (const prev of [...this.offers.values()]) {
      if (prev.phoneId === phoneId) this._remove(prev);
    }

    this.offers.set(id, offer);
    this.recent.set(key, { id, expiresAt: offer.expiresAt });
    while (this.recent.size > MAX_RECENT) {
      this.recent.delete(this.recent.keys().next().value);
    }
    this._scheduleExpiry(offer);

    let copied = false;
    if (autoCopy) {
      try { copied = this.copy(code) !== false; } catch { copied = false; }
    }

    // Arm a focused-field target snapshot immediately if the user is already in an input.
    void this.armTarget(id);

    // For SMS / Google Messages (which don't already display a phone notification), present the
    // short-lived explicit Use code UI offer.
    if (source !== 'notif' && this.presentOffer) {
      try {
        if (this.presentOffer(offer) !== false) offer.presentedSynthetic = true;
      } catch {}
    }

    this.onChange();
    return { accepted: true, duplicate: false, offer, copied };
  }

  // Snapshot the currently focused editable field for this active offer (never reads field text).
  armTarget(id) {
    const offer = this.offers.get(id);
    if (!offer || !this._isAuthorized(offer) || !this.captureTarget) return Promise.resolve('');
    const p = Promise.resolve()
      .then(() => this.captureTarget())
      .then((res) => {
        if (this.offers.get(id) !== offer) return '';
        if (res && res.valid === true && typeof res.token === 'string' && res.token) {
          offer.targetToken = res.token;
          offer.targetAt = this.now();
          return offer.targetToken;
        }
        offer.targetToken = '';
        offer.targetAt = 0;
        return '';
      })
      .catch(() => {
        if (this.offers.get(id) === offer) {
          offer.targetToken = '';
          offer.targetAt = 0;
        }
        return '';
      })
      .finally(() => {
        if (offer.targetPromise === p) offer.targetPromise = null;
      });
    offer.targetPromise = p;
    return p;
  }

  // Explicit user-initiated "Use code": tries exact verified focused-field fill via the local
  // helper; rejects stale/unauthorized offers; falls back to secure local-only expiring copy when
  // exact target fill is unavailable or rejected by the helper.
  async use(id) {
    this._prune();
    const offer = typeof id === 'string' ? this.offers.get(id) : null;
    if (!offer || !this._isAuthorized(offer)) {
      if (offer) {
        this._remove(offer);
        this.onChange();
      }
      return { ok: false, mode: 'expired' };
    }

    if (offer.targetPromise) {
      let waitTimer;
      await Promise.race([
        offer.targetPromise,
        new Promise((resolve) => {
          waitTimer = this.setTimer(resolve, TARGET_WAIT_MS);
          if (waitTimer && typeof waitTimer.unref === 'function') waitTimer.unref();
        }),
      ]);
      if (waitTimer) this.clearTimer(waitTimer);
    }

    if (this.offers.get(id) !== offer || !this._isAuthorized(offer)) {
      if (this.offers.has(id)) {
        this._remove(offer);
        this.onChange();
      }
      return { ok: false, mode: 'expired' };
    }

    let reason = 'no-target';
    const tokenFresh = offer.targetToken && (this.now() - offer.targetAt <= TARGET_MAX_AGE_MS);
    if (this.fill && tokenFresh) {
      try {
        const res = await this.fill(offer.code, offer.targetToken);
        if (res && res.filled === true) {
          this._remove(offer);
          this.onChange();
          return { ok: true, mode: 'filled' };
        }
        reason = (res && typeof res.reason === 'string' && res.reason) || 'rejected';
      } catch {
        reason = 'helper-unavailable';
      }
    } else if (!this.fill) {
      reason = 'helper-unavailable';
    }

    // Re-check authorization after awaiting helper before falling back to secure copy.
    if (this.offers.get(id) !== offer || !this._isAuthorized(offer)) {
      if (this.offers.has(id)) {
        this._remove(offer);
        this.onChange();
      }
      return { ok: false, mode: 'expired' };
    }

    const copied = this.copy(offer.code) !== false;
    return copied ? { ok: true, mode: 'copied', reason } : { ok: false, mode: 'refused', reason };
  }

  copyOffer(id) {
    this._prune();
    const offer = typeof id === 'string' ? this.offers.get(id) : null;
    if (!offer || !this._isAuthorized(offer)) return false;
    return this.copy(offer.code) !== false;
  }

  findByNotif(notifId, phoneId) {
    this._prune();
    for (const offer of this.offers.values()) {
      if (offer.notifId === notifId && (!phoneId || offer.phoneId === phoneId) && this._isAuthorized(offer)) return offer;
    }
    return null;
  }

  clearPhone(phoneId) {
    let changed = false;
    for (const offer of [...this.offers.values()]) {
      if (!phoneId || offer.phoneId === phoneId) {
        this._remove(offer);
        changed = true;
      }
    }
    if (phoneId) {
      const prefix = `${phoneId}\u0001`;
      for (const k of this.recent.keys()) if (k.startsWith(prefix)) this.recent.delete(k);
    } else {
      this.recent.clear();
    }
    if (changed) this.onChange();
  }

  clearSource(source, phoneId) {
    let changed = false;
    for (const offer of [...this.offers.values()]) {
      if (phoneId && offer.phoneId !== phoneId) continue;
      if (offer.source === source || (offer.sources.has(source) && !this._isAuthorized(offer))) {
        this._remove(offer);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  clearAll() {
    const had = this.offers.size > 0;
    for (const offer of [...this.offers.values()]) this._remove(offer);
    this.recent.clear();
    if (had) this.onChange();
  }

  revalidate() {
    if (this._prune()) this.onChange();
  }

  // Newest active authorized offer for live UI (memory-only, never persisted).
  get view() {
    this._prune();
    let newest = null;
    for (const offer of this.offers.values()) {
      if (!newest || offer.createdAt >= newest.createdAt) newest = offer;
    }
    if (!newest) return null;
    return {
      id: newest.id,
      code: newest.code,
      label: newest.label,
      source: newest.source,
      expiresAt: newest.expiresAt,
    };
  }
}

module.exports = { OtpOfferTracker, CODE_RE, DEFAULT_TTL_MS, DEFAULT_FRESH_MS };
