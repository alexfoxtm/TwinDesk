// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/chats.js: a phone's chat app conversations kept per phone, merged without doubles, an
// answer typed here replaced by the phone's copy, chat.want sent once per change.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chats } = require('../chats.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-chats-'));
const on = {};
const sent = [];
const link = { on: (ev, fn) => (on[ev] = fn), send: (m) => sent.push(m), current: { deviceId: 'phone1' } };
let want = true;
let socket = {};
const c = new Chats({ link, dir, want: () => want, socket: () => socket });

assert.strictEqual(c.view(), null, 'nothing heard: null (Messages falls back to notifications)');
assert.strictEqual(c.messaging(), false);
on.welcome();
assert.deepStrictEqual(sent, [{ t: 'chat.want', on: true, messaging: true }]);
c.sync();
assert.strictEqual(sent.length, 1, 'once per change');

const conv = (items, extra = {}) => ({ key: 'sc1', app: 'com.whatsapp', appName: 'WhatsApp', name: 'Family', group: true, id: 'k1', reply: true, items, ...extra });
on['chat.conv'](conv([{ at: 1000, from: 'Mum', text: 'Dinner?' }, { at: 2000, from: 'Dad', text: 'Yes' }]));
on['chat.conv'](conv([{ at: 2000, from: 'Dad', text: 'Yes' }, { at: 3000, from: 'Mum', text: 'At 8' }]));
let v = c.view();
assert.strictEqual(v.length, 1);
assert.strictEqual(c.messaging(), false, 'WhatsApp is not structured messaging');
assert.deepStrictEqual(v[0].items.map((x) => x.text), ['Dinner?', 'Yes', 'At 8'], 'merged, no doubles');
assert.strictEqual(v[0].reply, true);

assert.strictEqual(c.reply(v[0].key, 'On my way'), true);
assert.deepStrictEqual(sent[1], { t: 'notif.reply', id: 'k1', text: 'On my way' });
on['chat.conv'](conv([{ at: Date.now() + 500, from: '', text: 'On my way', me: true }]));
v = c.view();
assert.strictEqual(v[0].items.filter((x) => x.text === 'On my way').length, 1, "the phone's copy replaces the one typed here");
assert.ok(!v[0].items.some((x) => x.local));

on['chat.conv']({ key: 'x', app: 'com.google.android.apps.messaging', items: [{ at: 1, text: 'hi' }] });
on['chat.conv']({ key: 'y', app: 'not a package', items: [{ at: 1, text: 'hi' }] });
assert.strictEqual(c.view().length, 1, 'never a texting app (those are the texts), nor anything but a package');
on['chat.conv']({ key: 'z', app: 'com.viber.voip', appName: 'Viber', name: 'Ann', items: [{ at: 2, text: 'hi' }] });
assert.strictEqual(c.view().length, 2, 'other chat apps too');
assert.ok(c.view().some((x) => x.app === 'com.viber.voip'));

const messages = (app, items, extra = {}) => ({
  key: 'shortcut', app, name: 'Fixture', source: 'messaging', id: 'r:one', reply: true, pic: true, items, ...extra,
});
const first = { id: 'a'.repeat(64), match: 'f'.repeat(64), at: 30000, text: 'Repeat' };
const second = { ...first, id: 'b'.repeat(64), at: 30010 };
const google = messages('com.google.android.apps.messaging', [first, second]);
on['chat.conv'](google, {});
assert.equal(c.view().length, 2, 'a retired socket cannot deliver a projection');
on['chat.conv'](google, socket);
assert.strictEqual(c.messaging(), true, 'a live Google projection arms the structured-messaging flag');
on['chat.conv'](google, socket);
on['chat.conv'](messages('com.samsung.android.messaging', [{ ...first, id: 'c'.repeat(64), at: 32000 }], { id: 'r:two', reply: false }), socket);
const googleView = () => c.view().find((x) => x.app === google.app);
assert.deepStrictEqual(googleView().items.map((x) => x.at), [30000, 30010], 'snapshot repeats merge by ID, distinct messages survive');
assert.strictEqual(c.view().find((x) => x.app === 'com.samsung.android.messaging').reply, false);
assert.strictEqual(googleView().pic, false);
assert.strictEqual(c.reply(googleView().key, 'Fixture reply'), true);
assert.deepStrictEqual(sent.at(-1), { t: 'notif.reply', id: 'r:one', text: 'Fixture reply' });
on['chat.gone']({ id: 'r:one' }, socket);
assert.strictEqual(c.reply(googleView().key, 'Stale reply'), false);
const request = sent.findLast((m) => m.t === 'chat.match');
on['chat.match']({ ref: request.ref, ids: [first.id] }, socket);
assert.deepStrictEqual(googleView().items.map((x) => x.id), [second.id], 'only the exact confirmed item is hidden');
on['chat.match']({ ref: request.ref, ids: [first.id, second.id] }, socket);
assert.strictEqual(googleView(), undefined, 'the last matching item removes the duplicate row');
on['chat.match']({ ref: request.ref, ids: [first.id] }, socket);
assert.deepStrictEqual(googleView().items.map((x) => x.id), [second.id], 'late ambiguity restores the unmatched item');
on['chat.conv'](messages(google.app, [second], { id: 'r:three' }), socket);
socket = {};
assert.strictEqual(c.reply(googleView().key, 'Retired transport'), false);

link.current = { deviceId: 'phone2' };
assert.deepStrictEqual(c.view(), [], 'another phone: its own');
on['chat.match']({ ref: request.ref, ids: [second.id] }, socket);
link.current = { deviceId: 'phone1' };

on.closed();
assert.strictEqual(c.messaging(), true, 'a phone that already sent projections stays marked after disconnect');
assert.strictEqual(c.view()[0].reply, false, 'no Reply without a session');
on.welcome();
assert.strictEqual(c.messaging(), true, 'reconnect does not require a fresh projection to keep the flag');
assert.strictEqual(googleView().reply, false, 'cached history cannot offer Reply after reconnect');
c.stop();
const again = new Chats({ link, dir, want: () => false });
assert.strictEqual(again.view().length, 4, 'kept after a restart');
assert.strictEqual(again.messaging(), false, 'a client without a socket never claims structured messaging');
const againWithSocket = new Chats({ link, dir, want: () => false, socket: () => socket });
assert.strictEqual(againWithSocket.messaging(), true, 'the stored mark survives a process restart');
fs.rmSync(dir, { recursive: true, force: true });
console.log('chats ok');
