// The HID event tap stays a default tap at the head of the stream, and the
// deadman stays a 0.25 s timer. This reads Capture.swift. It does not create a
// tap, post an event, or run the helper. Run: node mac/test/capture-tap.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const src = fs.readFileSync(
  path.join(__dirname, '../../mac-helper/Sources/macshare-helper/Capture.swift'),
  'utf8',
);

test('the event tap still swallows at the head of the HID stream', () => {
  assert.match(
    src,
    /CGEvent\.tapCreate\(tap: \.cghidEventTap, place: \.headInsertEventTap, options: \.defaultTap,/,
    'a listenOnly, session or tail tap would drop or reorder events, or stop swallowing',
  );
  assert.match(src, /deadman = Timer\.scheduledTimer\(withTimeInterval: 0\.25, repeats: true\)/);
  assert.match(src, /now\(\) - self\.lastCommand > 1\.5/);
  assert.match(src, /\["event": "captureEnded", "reason": "deadman"\]/);
  assert.match(src, /let pass = Unmanaged\.passUnretained\(event\)/);
  assert.match(src, /type == \.tapDisabledByTimeout \|\| type == \.tapDisabledByUserInput/);
});
