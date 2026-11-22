// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// The process is disposable even while its worker is inside a synchronous filesystem call.
function run(port, file, createWorker = (filename, options) => new Worker(filename, options)) {
  const epoch = new Int32Array(new SharedArrayBuffer(8));
  const permit = new Int32Array(new SharedArrayBuffer(4));
  const worker = createWorker(path.join(__dirname, 'photo-backup-worker.js'), {
    workerData: { file, epoch: epoch.buffer, permit: permit.buffer, credit: true },
  });
  worker.on('message', (event) => port.send(event));
  worker.on('error', () => { /* the worker exit closes the process */ });
  worker.on('exit', () => port.kill());

  port.on('message', (event) => {
    if (event.kind === 'permit') {
      Atomics.store(permit, 0, event.allow ? 1 : -1);
      Atomics.notify(permit, 0);
      return;
    }
    if (event.kind === 'fence') {
      Atomics.store(epoch, 0, event.gen);
      Atomics.store(epoch, 1, Number(event.cancelled));
      return;
    }
    worker.postMessage(event);
  });
  port.on('disconnect', () => port.kill());
}

if (require.main === module) {
  run({
    on: process.on.bind(process),
    send: (event) => { if (process.connected) process.send(event, () => {}); },
    kill: () => process.kill(process.pid, 'SIGKILL'),
  }, process.argv[2]);
}

module.exports = { run };
