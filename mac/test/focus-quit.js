'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const start = source.indexOf('let focusReleasePending');
const end = source.indexOf('// Your own relay', start);
assert.ok(start >= 0 && end > start);

function setup(focus = true) {
  let finish, fail, timer = null;
  const calls = [];
  const app = new EventEmitter();
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    if (!prevented) calls.push('quit');
  };
  vm.runInNewContext(source.slice(start, end), {
    app, quitting: true, photoBackup: null, proximityLock: null, fileShelf: null,
    phoneHub: null, callwin: null, discovery: null, link: null, server: null,
    setTimeout(fn, ms) {
      assert.ok(ms > 0 && ms < 15000);
      timer = fn;
      return fn;
    },
    clearTimeout(fn) { if (timer === fn) timer = null; },
    svc: {
      silence: focus && { stop: () => calls.push('stop'), mac: { close: () => new Promise((resolve, reject) => {
        calls.push('release');
        finish = resolve;
        fail = reject;
      }) } },
      shutdown: () => calls.push('shutdown'),
    },
  });
  return { app, calls, finish: () => finish(), fail: () => fail(new Error('shortcut failed')), expire: () => timer(), armed: () => timer !== null };
}

(async () => {
  for (const reason of ['finished', 'failed', 'timeout', 'second Quit']) {
    const { app, calls, finish, fail, expire, armed } = setup();
    app.quit();
    await Promise.resolve();
    assert.deepEqual(calls, ['stop', 'release']);
    assert.ok(armed(), 'the deadline is set while the release runs');
    if (reason === 'finished') finish();
    if (reason === 'failed') fail();
    if (reason === 'timeout') expire();
    if (reason === 'second Quit') app.quit();
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['stop', 'release', 'shutdown', 'quit'], reason);
    assert.ok(!armed(), `${reason}: the deadline is cleared`);
    finish();
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['stop', 'release', 'shutdown', 'quit'], reason);
  }
  {
    const { app, calls, armed } = setup(false); // Focus off: nothing to wait for
    app.quit();
    assert.deepEqual(calls, ['shutdown', 'quit']);
    assert.ok(!armed());
  }
  console.log('focus-quit ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
