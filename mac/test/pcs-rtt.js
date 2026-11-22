// A paired computer's tile shows the ping, and "Connected" again when the ping
// is gone. The tile is not rebuilt, so the text has to be patched both ways.
// Run: node --test mac/test/pcs-rtt.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const ui = fs.readFileSync(path.join(__dirname, '../ui-start.js'), 'utf8');
const start = ui.indexOf('// The ping changes every second');
const end = ui.indexOf('\n  }', start);
assert.ok(start > 0 && end > start, 'renderPcs ping patch');

function patch(c, current) {
  const el = { textContent: current };
  vm.runInNewContext(ui.slice(start, end), {
    c,
    $(id) {
      assert.equal(id, 'pcs');
      return { querySelector: () => (c ? el : null) };
    },
    setText(node, text) { if (node && node.textContent !== text) node.textContent = text; },
    tr(text, vars) {
      if (!vars) return text;
      return text.replace('{value}', String(vars.value));
    },
  });
  return el.textContent;
}

test('a ping is shown, and a ping that comes back null says Connected', () => {
  assert.equal(patch({ rttMs: null }, '12 ms'), 'Connected');
  assert.equal(patch({ rttMs: 14 }, 'Connected'), '14 ms');
  assert.equal(patch(null, 'Nearby'), 'Nearby', 'no computer: the subtitle is left alone');
});
