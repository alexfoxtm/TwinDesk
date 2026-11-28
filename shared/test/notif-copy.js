// TwinDesk — GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bindReply, replyHistory, withPhoneActions } = require('../notifacts');

class Notices {
  constructor() { this.cfg = { receive: true }; this.socket = {}; this.history = []; this.copied = []; }
  replySocket() { return this.socket; }
  copyOtp(text) { this.copied.push(text); return true; }
  offer(id, from, body) {
    const item = { id, from, title: 'Fixture login', body, app: 'fixture', reply: false };
    bindReply(item, from, this.socket, item, this.history);
    this.history.unshift(item);
    return item;
  }
}
withPhoneActions(Notices);

test('notification text copy uses the visible exact offer and keeps OTP content on quiet copy', () => {
  const n = new Notices();
  const item = n.offer('same-id', 'phone-a', 'Your verification code is 123456');
  const other = n.offer('same-id', 'phone-b', '654321');
  other.title = 'Verification code';
  assert.equal(n.copyText(item.id, item.from, item.copySession), true);
  assert.equal(n.copyText(item.id, item.from, item.copySession, true), true);
  assert.equal(n.copyText(other.id, other.from, other.copySession), true);
  assert.deepEqual(n.copied, [item.body, item.title + '\n' + item.body, '654321']);
  assert.ok(!JSON.stringify(item).includes('copySocket'));
});

test('notification copy refuses a replaced offer, wrong origin, hidden policy and retired socket', () => {
  const n = new Notices();
  const item = n.offer('id', 'phone-a', 'Your verification code is 123456');
  assert.equal(n.copyText(item.id, 'phone-b', item.copySession), false);
  assert.equal(n.copyText(item.id, item.from, ''), false);
  n.cfg.receive = false;
  assert.equal(n.copyText(item.id, item.from, item.copySession), false);
  n.cfg.receive = true;
  n.cfg.phoneApps = { fixture: { mode: 'hide' } };
  assert.equal(n.copyText(item.id, item.from, item.copySession), false);
  n.cfg.phoneApps = {};
  // A retired exact transport must never authorize a stale render.
  n.socket = {};
  assert.equal(replyHistory(n)[0].copySession, undefined);
  assert.equal(n.copyText(item.id, item.from, item.copySession), false);
  n.history = [];
  assert.equal(n.copyText(item.id, item.from, item.copySession), false);
  assert.deepEqual(n.copied, []);
});
