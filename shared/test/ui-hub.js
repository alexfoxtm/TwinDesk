// A hub message that arrives before Calls, Messages, Photos or Files is built
// still reaches the handler that page registers while building. Where
// ensureAllBuilt is absent (Windows, Linux, Multi-device) the dispatch is the
// same one a registered page already had.
// Run: node --test shared/test/ui-hub.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui-hub.js'), 'utf8');

function boot(UI) {
  const window = {};
  vm.runInNewContext(source, { UI, window, console });
  return UI;
}

test('a hub message before any page is built still reaches that page', () => {
  const hubs = [];
  const got = [];
  const UI = {
    api: { onHub(fn) { hubs.push(fn); } },
    ensureAllBuilt() {
      got.push('build');
      if (UI.built) return;
      UI.built = true;
      UI.hubOn('call', (m) => got.push(m.n));
    },
  };
  boot(UI);
  assert.equal(hubs.length, 1, 'the listener is installed at load, before a page exists');
  hubs[0]({ t: 'call', n: 1 });
  assert.deepEqual(got, ['build', 1]);
  hubs[0]({ t: 'call', n: 2 });
  assert.deepEqual(got, ['build', 1, 'build', 2]);
});

test('without ensureAllBuilt a registered page still gets the message and nothing is built', () => {
  let hub = null;
  const got = [];
  const UI = {
    api: { onHub(fn) { hub = fn; } },
  };
  boot(UI);
  UI.hubOn('call', (m) => got.push(m.n));
  hub({ t: 'call', n: 7 });
  assert.deepEqual(got, [7]);
  hub({ t: 'other', n: 8 });
  assert.deepEqual(got, [7], 'another type is not delivered here');
});
