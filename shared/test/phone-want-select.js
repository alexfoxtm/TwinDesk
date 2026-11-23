// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A click on an unconnected phone (upstream #317): the hub selects that phone when it connects,
// and the sidebar opens its section. A background connect, a later click on another device, and
// an ask older than 20 s do not take the selection. The connect timer never opens a section by itself.
// Run with: node shared/test/phone-want-select.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Mesh } = require('../mesh.js');
const M = require('../sidebar-model.js');
const { Hub: MacHub } = require('../../mac/mesh/hub.js');
const { Hub: WinHub } = require('../../windows/mesh/hub.js');
const { Hub: LinuxHub } = require('../../linux/mesh/hub.js');

const root = path.resolve(__dirname, '..', '..');

function links() {
  const e = new EventEmitter();
  e.list = () => [];
  e.get = () => null;
  e.setBusy = () => {};
  e.forget = () => {};
  e.start = () => {};
  return e;
}

function session(id, os) {
  return {
    id,
    connected: true,
    peerOs: os,
    meshCapable: false,
    name: id,
    role: 'guest',
    transport: 'wifi',
    lastRx: 0,
    status: { rtt: 1, state: 'connected', message: '' },
    linkUp: false,
    hostUp: true,
    hosting: true,
    link: null,
    ctx: { deviceId: id, name: id, os, address: '10.0.0.2', rttMs: 1, authed: false },
    displayName() { return this.name; },
    send() { return true; },
  };
}

function makeHub(Hub) {
  return new Hub({ device: { id: 'me', name: 'This computer' }, links: links(), mesh: new Mesh({ selfId: 'me' }) });
}

function up(hub, id, os) {
  const s = session(id, os);
  hub.sessions.sessions.set(id, s);
  hub._up(s);
  return s;
}

function hubCases(name, Hub) {
  {
    const hub = makeHub(Hub);
    up(hub, 'pc', 'win');
    assert.strictEqual(hub.selectedId, 'pc', name + ': the first device is selected');
    hub.wantSelect('phone');
    up(hub, 'phone', 'android');
    assert.strictEqual(hub.selectedId, 'phone', name + ': the clicked phone takes the selection');
    assert.strictEqual(hub.pendingSelect, null, name + ': the ask is cleared once applied');
  }
  {
    const hub = makeHub(Hub);
    up(hub, 'pc', 'win');
    up(hub, 'phone', 'android');
    assert.strictEqual(hub.selectedId, 'pc', name + ': a background connect leaves the selection');
  }
  {
    const hub = makeHub(Hub);
    up(hub, 'pc', 'win');
    hub.wantSelect('phone');
    up(hub, 'other', 'android');
    assert.strictEqual(hub.selectedId, 'pc', name + ': a different device does not take a pending phone');
    assert.strictEqual(hub.pendingSelect && hub.pendingSelect.id, 'phone', name + ': the ask stays for the phone');
  }
  {
    const hub = makeHub(Hub);
    up(hub, 'pc', 'win');
    up(hub, 'mac', 'mac');
    hub.wantSelect('phone');
    assert.strictEqual(hub.select('mac'), true);
    assert.strictEqual(hub.selectedId, 'mac', name + ': select() moves to the other device');
    assert.strictEqual(hub.pendingSelect, null, name + ': select(other) cancels the ask');
    up(hub, 'phone', 'android');
    assert.strictEqual(hub.selectedId, 'mac', name + ': the phone no longer takes the selection');
  }
  {
    const hub = makeHub(Hub);
    up(hub, 'pc', 'win');
    hub.wantSelect('phone');
    hub.forgetPeer('phone');
    assert.strictEqual(hub.pendingSelect, null, name + ': forget cancels the ask');
    up(hub, 'phone', 'android');
    assert.strictEqual(hub.selectedId, 'pc', name + ': a forgotten phone does not take the selection');
  }
  {
    const hub = makeHub(Hub);
    up(hub, 'pc', 'win');
    hub.wantSelect('phone');
    hub.pendingSelect.at = Date.now() - 20001;
    up(hub, 'phone', 'android');
    assert.strictEqual(hub.selectedId, 'pc', name + ': an ask older than 20 s does not take the selection');
    assert.strictEqual(hub.pendingSelect, null, name + ': a stale ask is dropped');
  }
}

for (const [name, Hub] of [['mac', MacHub], ['windows', WinHub], ['linux', LinuxHub]]) hubCases(name, Hub);

// The sidebar's connect click, the same helper the three windows call.
{
  const available = ['overview', 'phone', 'calls', 'connection'];
  const opened = [];
  let goAfter = null;
  let connected = null;
  const scheduled = [];
  const cancelled = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    scheduled.push(timer);
    return timer;
  };
  const cancel = (timer) => {
    if (!timer) return;
    timer.cancelled = true;
    cancelled.push(timer);
  };
  const connectPhone = (id) => { connected = id; };
  function pickConnect(t) {
    const open = () => opened.push(M.targetSection('overview', t.kind, available));
    goAfter = M.armConnectOpen(goAfter, t.id, {
      open,
      schedule,
      cancel,
      drop: (armed) => { if (goAfter === armed) goAfter = null; },
    });
    return connectPhone(t.id);
  }
  function selectionChanged(id) {
    if (goAfter && id === goAfter.id) goAfter.go();
  }

  pickConnect({ id: 'phone', kind: 'phone', action: 'connect' });
  assert.strictEqual(goAfter && goAfter.id, 'phone', 'the click arms goAfter for that phone');
  assert.strictEqual(connected, 'phone', 'the click asks the phone to connect');
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].ms, M.CONNECT_OPEN_MS, 'the connect wait is 20 s');
  assert.notStrictEqual(scheduled[0].fn, goAfter.go, 'the timer is not the section opener');

  selectionChanged('phone');
  assert.deepStrictEqual(opened, ['overview'], 'the phone\'s section opens when it becomes selected');
  assert.strictEqual(goAfter, null, 'the ask is finished');
  assert.strictEqual(scheduled[0].cancelled, true, 'the wait is cancelled once the section opens');

  opened.length = 0;
  connected = null;
  pickConnect({ id: 'late', kind: 'phone', action: 'connect' });
  const waiting = scheduled[scheduled.length - 1];
  waiting.fn();
  assert.strictEqual(goAfter, null, 'the wait forgets the click');
  assert.deepStrictEqual(opened, [], 'a missed phone does not open a section');
  selectionChanged('late');
  assert.deepStrictEqual(opened, [], 'a late selection after the wait does not open a section');
  assert.strictEqual(connected, 'late');
}

// The three windows use that helper on a connect click, and a connect records the ask.
{
  const ui = [
    ['mac/mesh/ui-start.js', 'selectPeer'],
    ['windows/mesh/app.js', 'setActivePeer'],
    ['linux/mesh/app.js', 'setActivePeer'],
  ];
  for (const [file, selectApi] of ui) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const branch = src.match(/if \(t\.action === 'connect'\) \{[\s\S]*?return api\.connectPhone\(t\.id\);/);
    assert.ok(branch, file + ' has a connect branch');
    assert.ok(branch[0].includes('armConnectOpen'), file + ' arms the open');
    assert.ok(!/setTimeout\(\s*go\s*,/.test(branch[0]), file + ' does not open on the connect timer');
    assert.ok(src.includes('api.' + selectApi + '('), file + ' still selects a connected device');
  }
  for (const file of ['mac/mesh/ipc.js', 'windows/mesh/ipc.js', 'linux/mesh/ipc.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(/connectPhone[\s\S]{0,240}wantSelect\(/.test(src), file + ' records the click');
  }
  for (const file of ['windows/mesh/main.js', 'linux/mesh/main.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(/function connectPhoneDev\(d\) \{[\s\S]{0,180}wantSelect\(/.test(src), file + ' records an overview connect');
  }
}

console.log('phone-want-select: ok');
