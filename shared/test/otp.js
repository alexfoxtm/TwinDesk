// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/otp.js: the one-time code in a notification (Copy on Overview and the toast), and only that.
'use strict';

const assert = require('assert');
const { otpOf, isQuiet, quietCopy, invalidateQuietCopy, noteClipboardText } = require('../otp.js');

const cases = [
  ['Your one-time code is 482913. Don’t share it.', '482913'],
  ['G-482913 is your Google verification code.', '482913'],
  ['OTP: 4829-13 valid 5 min', '482913'],
  ['Verification code: 123 456', '123456'],
  ['Use 739201 to sign in to Instagram', '739201'],
  ['Your code 1234 for order 99887766', '1234'],
  ['Your total is 12.50, code 9921', '9921'],
  ['ඔබගේ කේතය 556677', '556677'],
  ['Order 99887766 shipped', ''],
  ['Meeting at 10:30, room 2024', ''],
  ['PIN 2024 expires', ''],
  ['Call me at 0771234567 about the code', ''],
  // Not codes: money, card/account/order numbers, other kinds of "code", dates, phone numbers.
  ['Your code is ready. Pay Rs. 5000 at the counter', ''],
  ['Use your PIN at checkout to pay $1250.', ''],
  ['Verification complete: €4500 transferred.', ''],
  ['Your login was recorded on 2026-10-08 at 12:30.', ''],
  ['For verification support, dial +44 7911 123456.', ''],
  ['Order #482910 has shipped! Use your tracking code at the link.', ''],
  ['Your tracking code is 84920184 for order 192837.', ''],
  ['Login alert for card ending 4821.', ''],
  ['Verification requested for account 948201.', ''],
  ['Delivery to zip code 94043 is scheduled.', ''],
  ['Login failed with error code 4040.', ''],
  ['Use promo code 5521 for 10% off', ''],
  // Codes next to those words still count.
  ['Your code is 4821. Card ending 9911 was used.', '4821'],
  ['Error code 12 — your verification code is 663201', '663201'],
  ['G-482913 is your Google verification code', '482913'],
  ['', ''],
];
for (const [text, want] of cases) assert.strictEqual(otpOf(text), want, JSON.stringify(text));

(async () => {
  // Fake timer harness for quietCopy expiry, repeat, and unrelated clipboard protection.
  const tick = () => new Promise((r) => setImmediate(r));
  let now = 10000;
  const timers = new Map();
  let nextId = 1;
  const fakeSetTimeout = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + ms });
    return { id, unref() {} };
  };
  const fakeClearTimeout = (t) => { if (t) timers.delete(t.id); };
  const advance = async (ms) => {
    now += ms;
    for (const [id, entry] of [...timers]) {
      if (entry.at <= now) {
        timers.delete(id);
        entry.fn();
      }
    }
    await tick();
    await tick();
  };

  let clipText = '';
  let changeCount = 1;
  const cb = {
    readText: async () => clipText,
    writeText: async (v) => { clipText = String(v); changeCount++; },
  };
  const opts = {
    clipboard: cb,
    ttlMs: 120000,
    now: () => now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    readChangeCount: async () => changeCount,
  };

  // 1. Basic expiring quiet copy clears itself when untouched.
  assert.strictEqual(quietCopy('482913', opts), true);
  assert.strictEqual(clipText, '482913');
  assert.strictEqual(isQuiet('482913', () => now), true);
  await tick();
  await advance(120000);
  assert.strictEqual(clipText, '', 'untouched OTP copy expires and clears');

  // 2. Repeated quietCopy cancels the earlier timer so late expiry does not clear the newer copy.
  quietCopy('111222', opts);
  await tick();
  await advance(90000);
  quietCopy('111222', opts);
  await tick();
  await advance(35000); // 125s after first copy, only 35s after second
  assert.strictEqual(clipText, '111222', 'repeated copy cancels earlier expiry timer');
  await advance(85000); // 120s after second copy
  assert.strictEqual(clipText, '', 'second copy expires at its own deadline');

  // 3. Unrelated clipboard value is never cleared by expiry.
  quietCopy('333444', opts);
  await tick();
  clipText = 'unrelated user text';
  changeCount++;
  await advance(120000);
  assert.strictEqual(clipText, 'unrelated user text', 'unrelated clipboard text stays untouched');

  // 4. External re-copy of the same digits (different changeCount) is NOT cleared by old timer.
  quietCopy('555666', opts);
  await tick();
  clipText = 'other';
  changeCount++;
  clipText = '555666';
  changeCount++;
  await advance(120000);
  assert.strictEqual(clipText, '555666', 'changed pasteboard changeCount prevents clearing an external copy');

  // 5. noteClipboardText / invalidateQuietCopy disarm pending expiry and clear quiet flag.
  quietCopy('777888', opts);
  await tick();
  assert.strictEqual(isQuiet('777888', () => now), true);
  noteClipboardText('something else');
  assert.strictEqual(isQuiet('777888', () => now), false);
  clipText = '777888';
  await advance(120000);
  assert.strictEqual(clipText, '777888', 'disarmed timer never clears later clipboard');
  invalidateQuietCopy();

  console.log('otp: ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
