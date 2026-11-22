// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { SpaceLook } = require('../space-switch');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const send = source.slice(source.indexOf('function sendScreenState()'), source.indexOf('// The viewer asked to mirror'));
const services = fs.readFileSync(require.resolve('../services.js'), 'utf8');
const wiring = services.slice(services.indexOf('  const spaceLook ='), services.indexOf('  const desktopRefresh ='));
const look = { composed: true, displays: [{ cgId: '1', uuid: 'main', current: '10', spaces: ['10', '11'] }] };

function setup() {
  let view = null;
  let timer;
  let pushes = 0;
  let sendState = () => {};
  const conn = { deviceId: 'phone', ws: {} };
  const requests = [];
  const packets = [];
  const helper = new EventEmitter();
  helper.request = () => new Promise(resolve => requests.push(resolve));
  const server = { current: conn, sendToClient: msg => packets.push(msg) };
  const stream = { viewedDisplay: () => view };
  const spaceLook = vm.runInNewContext(wiring + '\nspaceLook;', {
    SpaceLook, helper, server, stream,
    pushState() { pushes++; sendState(); },
    setTimeout(fn) { timer = fn; return fn; },
    clearTimeout(fn) { if (timer === fn) timer = null; },
  });
  sendState = vm.runInNewContext(send + '\nsendScreenState;', {
    require: require('node:module').createRequire(require.resolve('../main.js')),
    screenStateKey: '', previewShots: null, appsHeld: () => false,
    displayMode: () => 'mirror', P: { T: { SCREEN_STATE: 'screen.state' } },
    Pick: { stateFields: () => ({}) }, settings: { sharing: { on: true } },
    peer: server,
    svc: {
      stream, spaceLook,
      displays: { list: () => [{ id: 1, name: 'Main', primary: true }], target: () => null },
      input: { enabled: () => true },
    },
  });
  return {
    sendState, server, packets, requests, spaceLook,
    setView(value) { view = value; },
    pushes: () => pushes,
    event(name = 'activeSpaceChanged') { helper.emit('event', name); },
    flushEvent() { const fn = timer; timer = null; if (fn) fn(); },
    async finish(value = look) { requests.shift()(value); await new Promise(setImmediate); },
  };
}

async function check() {
  const idle = setup();
  idle.sendState();
  assert.equal(idle.requests.length, 1, 'connect without a picture requests a look');
  await idle.finish();
  assert.ok(idle.packets.at(-1).desktops, 'the phone gets the named-display catalog without a picture');
  idle.spaceLook.at = 0;
  idle.sendState();
  assert.equal(idle.requests.length, 0, 'a connected peer without a picture does not poll');
  idle.server.current = { ...idle.server.current, ws: {} };
  idle.sendState();
  assert.equal(idle.requests.length, 1, 'a new session refreshes the catalog');
  await idle.finish();

  const viewer = setup();
  viewer.setView({ id: '1', generation: 1, session: 1 });
  viewer.sendState();
  assert.equal(viewer.requests.length, 1, 'a viewer with a picture gets desktop updates');
  const ticket = viewer.spaceLook.ticket;
  viewer.sendState();
  assert.equal(viewer.spaceLook.again, false, 'a periodic push skips a busy look');
  assert.equal(viewer.spaceLook.pendingDemand, null);
  assert.equal(viewer.spaceLook.ticket, ticket);
  await viewer.finish();
  viewer.sendState();
  assert.equal(viewer.requests.length, 0, 'periodic requests still respect the throttle');
  viewer.spaceLook.at = 0;
  viewer.sendState();
  assert.equal(viewer.requests.length, 1);
  viewer.setView(null);
  await viewer.finish({ ...look, spans: true });
  assert.equal(viewer.spaceLook.current().spans, undefined, 'a stopped view drops the in-flight catalog');
  viewer.sendState();
  assert.equal(viewer.requests.length, 1, 'detaching takes a fresh look');
  await viewer.finish();
  viewer.setView({ id: '1', generation: 2, session: 1 });
  viewer.sendState();
  assert.equal(viewer.requests.length, 1, 'attaching takes a fresh look within the throttle');
  viewer.server.current = { ...viewer.server.current, ws: {} };
  await viewer.finish({ ...look, spans: true });
  assert.equal(viewer.spaceLook.current().spans, undefined, 'a replaced socket drops the in-flight catalog');
  viewer.sendState();
  viewer.setView({ id: '1', generation: 3, session: 1 });
  await viewer.finish({ ...look, spans: true });
  assert.equal(viewer.spaceLook.current().spans, undefined, 'a changed capture generation drops the in-flight catalog');

  const events = setup();
  const conn = events.server.current;
  events.server.current = null;
  events.event();
  events.flushEvent();
  assert.equal(events.pushes(), 0, 'an unattended desktop event does not push state');
  assert.equal(events.requests.length, 0);
  events.server.current = conn;
  events.sendState();
  events.event('other');
  events.flushEvent();
  assert.equal(events.spaceLook.pendingDemand, null);
  for (let i = 0; i < 5; i++) events.event();
  events.flushEvent();
  assert.equal(events.requests.length, 1, 'a desktop event waits for the busy read');
  let explicit = 0;
  events.spaceLook.refresh({ force: true, onFresh: () => { explicit++; } });
  await events.finish();
  assert.equal(events.requests.length, 1, 'the explicit request keeps its queue slot');
  await events.finish();
  assert.equal(explicit, 1);
  assert.equal(events.requests.length, 1, 'a busy burst leaves one fresh look despite the throttle');
  await events.finish();
  assert.equal(events.requests.length, 0);
  events.event();
  events.flushEvent();
  assert.equal(events.requests.length, 1, 'an idle event refreshes within the throttle without a picture');
  await events.finish();
  events.event();
  events.server.current = { ...conn, ws: {} };
  events.flushEvent();
  assert.equal(events.requests.length, 0, 'a queued event is fenced to its session');

  const failed = setup();
  const realSetTimeout = global.setTimeout;
  let retry = null;
  global.setTimeout = (fn, ms) => (ms === 1000 ? (retry = fn, { unref() {} }) : realSetTimeout(fn, ms));
  try {
    failed.sendState();
    await failed.finish(null);
    assert.equal(failed.requests.length, 0);
    assert.ok(retry, 'a failed look with nothing else due is tried once more');
    const again = retry;
    retry = null;
    again();
    assert.equal(failed.requests.length, 1, 'the retry asks the helper');
    await failed.finish(null);
    assert.equal(retry, null, 'and only once per failure run');
  } finally {
    global.setTimeout = realSetTimeout;
  }
}

check().then(() => console.log('space-look demand passed')).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
