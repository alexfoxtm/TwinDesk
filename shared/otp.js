// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A one-time code in a notification's text ("Your code is 482913", "G-482913 is your Google
// verification code", "OTP: 4829-13"): the digits, for a Copy button on the notification here and
// in the lists. Only next to a word that says it's a code, so an order number or a price doesn't
// count. otpOf(text) → '482913' | ''. Main process (require) and pages (window.Otp).
'use strict';

(function (root) {
  const WORDS = /\b(?:code|otp|one[- ]time|passcode|pass code|verification|verify|security|login|log-in|sign[- ]in|2fa|two[- ]factor|pin|token|authenticat\w*|confirm\w*)\b|кода?|код\b|コード|验证码|驗證碼|인증|รหัส|कोड|رمز|කේතය/i;
  // 4–8 digits, alone or in two groups ("482 913", "4829-13"); a G- prefix (Google) is allowed.
  const CODE = /(?:^|[^\w.,:/+-])(?:G-)?(\d{3,4}[ -]\d{2,4}|\d{4,8})(?![\w%/]|[.,]\d|:\d)/g;

  // A "code" that isn't a one-time one: a zip code, a promo code, an error code…
  const OTHER = 'zip|postal|area|country|promo|promotion(?:al)?|discount|coupon|voucher|gift|referral|invite|bar|qr|dress|source|error|status|fault|tracking|sort|swift|bic|ifsc|hs|colou?r|product|item|tax';
  const OTHER_CODE = new RegExp(`\\b(?:${OTHER})[ -]codes?\\b`, 'gi');
  const OTHER_END = new RegExp(`\\b(?:${OTHER})[ -]codes?\\s*(?:is|was|:|#|no\\.?)?\\s*$`, 'i');
  // Right before the digits: money ("$1250", "Rs. 5000"), a card, account or order number, a
  // country code ("+44 7911…").
  const MONEY = /(?:[$€£¥₹₩₦₱]|\b(?:rs|inr|usd|eur|gbp|lkr|aud|cad)\.?)\s*$/i;
  const NUMBER_OF = /(?:\b(?:ending(?: in)?|ends in|account|acct|a\/c|card|order|invoice|package|parcel|tracking|ref(?:erence)?|room|flight|seat)\s*(?:no\.?|number|#)?\s*[:#]?\s*|#\s*|\+\d{1,3}[ -]?)$/i;

  function otpOf(text) {
    const raw = String(text || '');
    if (!raw) return '';
    // The other kinds of code don't count as a code word.
    const t = raw.replace(OTHER_CODE, (w) => ' '.repeat(w.length));
    if (!WORDS.test(t)) return '';
    let best = '';
    for (const m of t.matchAll(CODE)) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length < 4 || digits.length > 8) continue;
      if (/^(19|20)\d\d$/.test(digits) && !/\d[ -]\d/.test(m[1])) continue; // a year
      const start = m.index + m[0].length - m[1].length;
      const lead = raw.slice(Math.max(0, start - 24), start).replace(/G-$/, '');
      if (OTHER_END.test(lead) || MONEY.test(lead) || NUMBER_OF.test(lead)) continue;
      // More digit groups around it: a date (2026-10-08) or a phone number (+44 7911 123456).
      if (/^[ -/]\d{2,}/.test(raw.slice(start + m[1].length)) || /\d[ -]$/.test(lead)) continue;
      best = digits;
      // The first code after a code word wins ("Code 1234 for order 99887766").
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      if (WORDS.test(before)) return digits;
    }
    return best;
  }

  // A one-time code put on the clipboard (manual Copy, Use code fallback, or opt-in auto-copy):
  // kept out of clipboard sync and history (each clipboard module asks isQuiet before sending or
  // keeping), and taken off the clipboard after ttlMs (default 2 minutes) only if that exact quiet
  // copy is still current. Repeated copies replace the pending timer, and an external clipboard
  // write or changeCount change prevents late expiry from clearing an unrelated clipboard value.
  // Main process only. Never logs code digits.
  const DEFAULT_TTL_MS = 120000;
  const CLEAR_GRACE_MS = 2000;
  const quiet = new Map(); // text -> until
  let copySeq = 0;
  let activeCopy = null; // { seq, code, timer, clearTimer, changeCount }

  function _clearActiveTimer() {
    if (!activeCopy) return;
    if (activeCopy.timer) activeCopy.clearTimer(activeCopy.timer);
    activeCopy.timer = null;
  }

  function isQuiet(text, nowFn = Date.now) {
    const now = nowFn();
    for (const [k, until] of quiet) if (until < now) quiet.delete(k);
    return typeof text === 'string' && quiet.has(text.trim());
  }

  function invalidateQuietCopy() {
    if (!activeCopy) return;
    const prev = activeCopy;
    _clearActiveTimer();
    activeCopy = null;
    if (prev.code) quiet.delete(prev.code);
  }

  function noteClipboardText(text) {
    if (!activeCopy) return;
    if (String(text || '') !== activeCopy.code) invalidateQuietCopy();
  }

  function quietCopy(code, clipboardOrOpts) {
    const value = typeof code === 'string' ? code.trim() : '';
    if (!value) return false;
    const isOpts = clipboardOrOpts && typeof clipboardOrOpts === 'object' && typeof clipboardOrOpts.writeText !== 'function';
    const opts = isOpts ? clipboardOrOpts : { clipboard: clipboardOrOpts };
    const cb = opts.clipboard || require('electron').clipboard;
    if (!cb || typeof cb.writeText !== 'function') return false;
    const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
    const setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
    const clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    const quietMs = Number.isFinite(opts.quietMs) && opts.quietMs >= ttlMs ? opts.quietMs : Math.max(ttlMs + 5000, 5 * 60000);
    const readChangeCount = typeof opts.readChangeCount === 'function' ? opts.readChangeCount : null;

    if (activeCopy) {
      const prevCode = activeCopy.code;
      _clearActiveTimer();
      if (prevCode && prevCode !== value) quiet.delete(prevCode);
    }

    const seq = ++copySeq;
    const slot = { seq, code: value, timer: null, clearTimer, changeCount: null };
    activeCopy = slot;
    quiet.set(value, nowFn() + quietMs);
    cb.writeText(value);

    if (readChangeCount) {
      Promise.resolve()
        .then(() => readChangeCount())
        .then(async (count) => {
          if (activeCopy !== slot || typeof count !== 'number' || !Number.isFinite(count)) return;
          const current = typeof cb.readText === 'function' ? String((await cb.readText()) || '') : value;
          if (activeCopy === slot && current === value) slot.changeCount = count;
        })
        .catch(() => {});
    }

    const t = setTimer(() => {
      if (activeCopy !== slot) return;
      Promise.resolve()
        .then(() => (typeof cb.readText === 'function' ? cb.readText() : ''))
        .then(async (current) => {
          if (activeCopy !== slot) return;
          if (String(current || '') !== value) {
            activeCopy = null;
            quiet.delete(value);
            return;
          }
          if (readChangeCount && slot.changeCount !== null) {
            const countNow = await Promise.resolve().then(() => readChangeCount()).catch(() => null);
            if (activeCopy !== slot) return;
            if (typeof countNow === 'number' && Number.isFinite(countNow) && countNow !== slot.changeCount) {
              activeCopy = null;
              quiet.delete(value);
              return;
            }
          }
          if (activeCopy !== slot) return;
          activeCopy = null;
          quiet.set(value, nowFn() + CLEAR_GRACE_MS);
          await cb.writeText('');
        })
        .catch(() => {
          if (activeCopy === slot) {
            activeCopy = null;
            quiet.delete(value);
          }
        });
    }, ttlMs);
    slot.timer = t;
    if (t && typeof t.unref === 'function') t.unref();
    return true;
  }

  const api = { otpOf, isQuiet, quietCopy, invalidateQuietCopy, noteClipboardText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Otp = api;
})(typeof window !== 'undefined' ? window : globalThis);
