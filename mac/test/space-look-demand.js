// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const send = source.slice(source.indexOf('function sendScreenState()'), source.indexOf('// The viewer asked to mirror'));
const mode = process.argv[2] || 'no-view';
const conn = { deviceId: 'phone', ws: {} };
let view = { id: '1', generation: 1, session: 1 };
let calls = 0;
let fence;
const context = {
  require: require("node:module").createRequire(require.resolve("../main.js")), screenStateKey: '', previewShots: null, appsHeld: () => false,
  displayMode: () => 'mirror', P: { T: { SCREEN_STATE: 'screen.state' } },
  Pick: { stateFields: () => ({}) }, settings: { sharing: { on: true } },
  peer: { current: conn, sendToClient: () => {} },
  svc: {
    stream: { viewedDisplay: () => view },
    spaceLook: { current: () => null, refresh: (opts) => { calls++; fence = opts.still; } },
    displays: { list: () => [], target: () => null }, input: { enabled: () => true },
  },
};
if (mode === 'no-view') {
  view = null;
  vm.runInNewContext(send + '\nsendScreenState();', context);
  assert.equal(calls, 0, 'a connected peer without a picture does not poll desktops');
} else {
  vm.runInNewContext(send + '\nsendScreenState();', context);
  assert.equal(calls, 1, 'a viewer with a picture gets desktop updates');
  assert.equal(typeof fence, 'function', 'the read is fenced to this viewer');
  assert.equal(fence(), true);
  context.peer.current = { ...conn, ws: {} };
  assert.equal(fence(), false, 'a replaced socket drops the read even with the same device and view');
}
console.log('space-look demand passed:', mode);
