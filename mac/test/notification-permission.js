// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { NotificationPermission } = require('../notification-permission');

function page() {
  let tab;
  const rows = [];
  const calls = [];
  const node = (kind, data = {}) => ({ kind, ...data, append() {}, replaceChildren() {}, set() {} });
  const UI = {
    tab(v) { tab = v; }, el: () => node('div'), peer: () => ({}),
    api: { allowNativeNotifications() { calls.push('allow'); } },
    switch: () => node('switch'), button: (text, click) => node('button', { textContent: text, click }),
    row(label, hint, controls) { const row = node('row', { label, hint, controls, setHint(v) { this.hint = v; } }); rows.push(row); return row; },
    pair: () => node('pair'), dir: () => node('dir'), card: () => node('card'),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui-notifs.js'), 'utf8'), { UI, I18n: { t: (s) => s } });
  const render = tab.build({ append() {} });
  return { render: (nativeAccess, nativeFailure = false) => render({ notifs: { receive: true, nativeAccess, nativeFailure, apps: [], muted: [] } }),
    row: rows.find((r) => r.label === 'macOS notifications'), calls };
}

async function statusAndRequest() {
  const denied = { authorization: 'denied', alerts: 'disabled', bundleId: 'test.fork' };
  const allowed = { authorization: 'authorized', alerts: 'enabled', bundleId: 'test.fork' };
  let current = denied, requests = 0;
  const permission = new NotificationPermission({ getSettings: async () => current, request: async () => { requests++; return current = allowed; } });
  assert.deepStrictEqual(await permission.refresh(), denied);
  const ui = page();
  ui.render(permission.view);
  assert.strictEqual(ui.row.hidden, false);
  assert.match(ui.row.hint, /disabled/);
  ui.row.controls[0].click();
  assert.deepStrictEqual(ui.calls, ['allow']);
  assert.deepStrictEqual(await permission.request(), allowed);
  assert.strictEqual(requests, 1);
  ui.render(permission.view);
  assert.strictEqual(ui.row.hidden, true);
  current = denied;
  await permission.refresh();
  ui.render(permission.view);
  assert.strictEqual(ui.row.hidden, false, 'returning from Settings refreshes revoked authorization');
  let finishQuery, finishRequest, concurrent = 0;
  const queued = new NotificationPermission({
    getSettings: () => new Promise((resolve) => { finishQuery = resolve; }),
    request: () => { concurrent++; return new Promise((resolve) => { finishRequest = resolve; }); },
  });
  const query = queued.refresh();
  const first = queued.request(), second = queued.request();
  finishQuery(denied);
  await query;
  await Promise.resolve();
  assert.strictEqual(concurrent, 1, 'concurrent requests share one authorization request');
  finishRequest(allowed);
  assert.deepStrictEqual(await Promise.all([first, second]), [allowed, allowed]);
}

async function unavailableIsUnknown() {
  const permission = new NotificationPermission({ getSettings: async () => { throw Error('unavailable'); }, request: async () => { throw Error('unavailable'); } });
  assert.strictEqual((await permission.refresh()).authorization, 'unknown');
  assert.strictEqual((await permission.request()).authorization, 'unknown');
  assert.strictEqual((await new NotificationPermission(null).request()).authorization, 'unknown');
  const ui = page();
  ui.render(permission.view);
  assert.match(ui.row.hint, /could not be checked/);
  assert.doesNotMatch(ui.row.hint, /disabled/);
  ui.render({ authorization: 'authorized', alerts: 'enabled' }, true);
  assert.match(ui.row.hint, /could not show/);
}

(async () => {
  await statusAndRequest();
  await unavailableIsUnknown();
  console.log('notification-permission: ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
