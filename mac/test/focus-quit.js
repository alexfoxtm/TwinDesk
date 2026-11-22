'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const start = source.indexOf('let focusReleasePending');
const end = source.indexOf('// Your own relay', start);
assert.ok(start >= 0 && end > start);

function setup() {
  let finish, timer;
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
      silence: { stop: () => calls.push('stop'), mac: { close: () => new Promise((resolve) => {
        calls.push('release');
        finish = resolve;
      }) } },
      shutdown: () => calls.push('shutdown'),
    },
  });
  return { app, calls, finish: () => finish(), expire: () => timer() };
}

(async () => {
  for (const reason of ['finished', 'timeout', 'second Quit']) {
    const { app, calls, finish, expire } = setup();
    app.quit();
    await Promise.resolve();
    assert.deepEqual(calls, ['stop', 'release']);
    if (reason === 'finished') finish();
    if (reason === 'timeout') expire();
    if (reason === 'second Quit') app.quit();
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['stop', 'release', 'shutdown', 'quit'], reason);
    finish();
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['stop', 'release', 'shutdown', 'quit'], reason);
  }
  console.log('focus-quit ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
