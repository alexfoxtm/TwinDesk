// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../ui-messages.js'), 'utf8');

function inbox(state, api = {}, globals = {}) {
  const received = new Map();
  const asked = [];
  const replies = [];
  const el = (tag, props = {}, children = []) => ({
    tag, ...props, children: children.filter(Boolean), attrs: { ...props.attrs },
    style: {}, dataset: {}, classList: { add() {}, toggle() {} },
    addEventListener() {}, focus() {}, querySelectorAll() { return []; },
    setAttribute(key, value) { this.attrs[key] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  let tab;
  const UI = {
    el, state, api: { setChats() {}, hub() {}, notifReply: (msg) => replies.push(msg), ...api },
    tab(def) { tab = def; },
    hubTop: () => ({ el: el('div'), render() {} }),
    button(text, onclick) { return el('button', { text, onclick }); },
    switch: () => ({ set() {} }),
    select: () => ({ el: el('select'), options() {} }),
    row: () => el('div'),
    card: () => el('div'),
    avatar: () => el('span'),
    clock: (at) => String(at),
    hubOn: (type, fn) => received.set(type, fn),
    hubAsk: (msg) => asked.push(msg),
    hubReady: (s) => s.hub.messages,
    onShown() {},
    onDeviceChange() {},
  };
  vm.runInNewContext(source, { UI, window: {}, clearTimeout, setTimeout, localStorage: { getItem() {} }, ...globals });
  const body = el('section');
  const paint = tab.build(body, {});
  const [, pills, , texts, chat] = body.children.slice(api.googleMessages ? 1 : 0);
  const findPill = (label) => pills.children.find((b) => b.text === label);
  const rows = () => chat.children[0].children[1].children;
  const snippet = (row) => row.children[1].children[1].text;
  return { received, asked, replies, paint, texts, chat, findPill, rows, snippet };
}

test('Messages opens on All for recent notification chats and keeps the carrier route under Texts', () => {
  const state = {
    ui: { chats: true },
    hub: { messages: true, perm: { messages: { mms: true } } },
    notifs: { history: [{ app: 'com.google.android.apps.messaging', at: 3000, title: 'Summary fixture' }] },
    chats: null,
  };
  const { received, asked, replies, paint, texts, chat, findPill, rows, snippet } = inbox(state);
  paint(state);
  assert.equal(findPill('All').attrs['aria-selected'], 'true', 'history RCS still appears without structured messaging');
  assert.equal(findPill('Messages (Chat)').hidden, false, 'legacy peers can still open notification history');
  state.chatsMessaging = true;
  paint(state);
  assert.equal(findPill('Messages (Chat)').hidden, true, 'unclassified notification history is not a chat');

  state.chats = [{
    app: 'com.google.android.apps.messaging', key: 'fixture-chat', name: 'Chat fixture',
    at: 2000, reply: true, items: [{ id: 'fixture-msg', text: 'New chat', at: 2000 }],
  }];
  paint(state);
  received.get('sms.threads')({ items: [{ id: '42', at: 1000, name: 'Carrier fixture', snippet: 'Old SMS', addrs: ['2025550100'] }] });
  assert.equal(findPill('All').attrs['aria-selected'], 'true');
  assert.deepEqual(Array.from(rows(), snippet), ['Chat · New chat', 'Texts · Old SMS']);
  assert.equal(rows()[0].children[1].children[0].children[1].text, '2000');
  findPill('Messages (Chat)').onclick();
  assert.deepEqual(Array.from(rows(), snippet), ['Chat · New chat']);
  rows()[0].onclick();
  const composer = chat.children[1].children[3];
  const replyBox = composer.children[2].children[1];
  assert.equal(composer.hidden, false);
  replyBox.value = 'Fixture reply';
  composer.children[3].onclick();
  assert.equal(replies[0].chat, 'fixture-chat');
  assert.equal(replies[0].text, 'Fixture reply');
  state.chats[0].reply = false;
  paint(state);
  assert.equal(composer.hidden, true);
  replyBox.value = 'Expired reply';
  composer.children[3].onclick();
  assert.equal(replies.length, 1);
  findPill('All').onclick();
  rows()[1].onclick();
  assert.equal(texts.hidden, false);
  assert.equal(findPill('Texts').attrs['aria-selected'], 'true');
  assert.equal(asked.at(-1).t, 'sms.thread');
  assert.equal(asked.at(-1).id, '42');
  const textComposer = texts.children[1].children[3];
  textComposer.children[2].children[1].value = 'Fixture SMS';
  textComposer.children[3].onclick();
  assert.equal(asked.at(-1).t, 'sms.send');
  assert.equal(asked.at(-1).to, '2025550100');
  assert.equal(replies.length, 1);


});

test('keeps RCS notification history without structured messaging, and hides it once the phone delivers it', () => {
  const el = (tag, props = {}, children = []) => ({
    tag, ...props, children: children.filter(Boolean), attrs: { ...props.attrs },
    style: {}, classList: { add() {}, toggle() {} },
    addEventListener() {}, focus() {},
    setAttribute(key, value) { this.attrs[key] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  const history = [{ app: 'com.google.android.apps.messaging', at: 4000, title: 'History fixture', body: 'RCS from history' }];
  const state = {
    ui: { chats: true },
    hub: { messages: true, perm: { messages: { mms: true } } },
    notifs: { history },
    chats: [{ app: 'com.whatsapp', key: 'wa', name: 'Chat app fixture', at: 1000, items: [{ text: 'WA', at: 1000 }] }],
  };
  let tab;
  const UI = {
    el, state, api: { setChats() {} },
    tab(def) { tab = def; },
    hubTop: () => ({ el: el('div'), render() {} }),
    button(text, onclick) { return el('button', { text, onclick }); },
    switch: () => ({ set() {} }),
    select: () => ({ el: el('select'), options() {} }),
    row: (label, hint) => { const n = el('div'); n.setHint = (t) => { n.hint = t; }; n.setHint(hint); return n; },
    card: () => el('div'),
    avatar: () => el('span'),
    clock: (at) => String(at),
    hubOn() {},
    hubAsk() {},
    hubReady: (s) => s.hub.messages,
    onShown() {},
    onDeviceChange() {},
  };
  vm.runInNewContext(source, { UI, window: {}, clearTimeout, setTimeout, localStorage: { getItem() {} } });
  const body = el('section');
  const paint = tab.build(body, {});
  const pills = body.children[1];
  const chatsRow = body.children[2] && body.children[2].children && body.children[2].children[0];
  const chat = body.children[4];
  const findPill = (label) => pills.children.find((b) => b.text === label);
  const rows = () => chat.children[0].children[1].children;
  const snippet = (row) => row.children[1].children[1].text;
  paint(state);
  assert.deepEqual(Array.from(rows(), snippet), ['Chat · RCS from history', 'WhatsApp · WA']);
  assert.equal(findPill('Messages (Chat)').hidden, false);
  state.chatsMessaging = true;
  paint(state);
  assert.equal(findPill('Messages (Chat)').hidden, true, 'structured messaging replaces the history fallback');
  findPill('All').onclick();
  assert.deepEqual(Array.from(rows(), snippet), ['WhatsApp · WA']);
});

test('All joins one-to-one history by verified destination and keeps group and ambiguous messages intact', () => {
  const app = 'com.google.android.apps.messaging';
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const at = 10000;
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { mms: true } } },
    notifs: { history: [
      { id: 'notification-1', app, messagePhone: phone, messagePeer: dest, messageAt: at,
        at: at + 500, title: 'Fixture notice', body: 'Shared text' },
      { id: 'notification-2', app, messagePhone: phone, messagePeer: dest, messageAt: at + 1000,
        at: at + 1500, title: 'Fixture notice', body: 'Notification-only text' },
      { id: 'notification-3', app, messagePhone: 'other-phone', messagePeer: dest, messageAt: at,
        at, title: 'Fixture notice', body: 'Other phone text' },
    ] },
    chats: [{ key: 'group', app, name: 'Fixture group', group: true, messagePeer: dest, at: 100,
      items: [{ id: 'group-message', text: 'Separate group', at: 100 }] }],
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [
        { id: 'paired', name: 'Fixture paired', addrs: [dest], at: at + 2000, snippet: 'Paired RCS' },
        { id: 'different-country', name: 'Fixture paired', addrs: ['+442025550100'], at: 500, snippet: 'Distinct number' },
      ],
      history: { chat: 'paired', loaded: true, items: [
        { id: 'g1', at, text: 'Shared text', me: false, transport: 'text' },
        { id: 'g2', at: at + 300, text: 'Repeated', me: false, transport: 'text' },
        { id: 'g3', at: at + 2000, text: 'Paired RCS', me: false, transport: 'rcs' },
      ] },
    },
  };
  const { received, asked, paint, chat, rows, findPill } = inbox(state, { googleMessages: async () => true });
  paint(state);
  received.get('sms.threads')({ nanp: true, items: [
    { id: 'carrier', addrs: ['2025550100'], name: 'Fixture carrier', at: at + 300, snippet: 'Repeated' },
    { id: 'mms-group', addrs: [dest, '+12025550101'], name: 'Fixture group', at: 200, snippet: 'Separate MMS group' },
  ] });
  assert.equal(findPill('All').attrs['aria-selected'], 'true');
  assert.equal(rows().length, 5);
  rows()[0].onclick();
  assert.equal(asked.at(-1).id, 'carrier');
  received.get('sms.thread')({ id: 'carrier', items: [
    { id: 's3', at: at + 300, body: 'Repeated' },
    { id: 's2', at: at + 300, body: 'Repeated' },
    { id: 's1', at, body: 'Shared text' },
    { id: 's0', at: at - 1000, body: 'Carrier only' },
  ] });
  const visible = () => Array.from(chat.children[1].children[1].children[0].children)
    .filter((node) => node.class?.startsWith('hub-bubble'))
    .map((node) => Array.from(node.children, (child) => child.text));
  assert.deepEqual(visible(), [
    ['Carrier only', 'Text'], ['Shared text', 'Text'], ['Repeated', 'Text'],
    ['Repeated', 'Text'], ['Repeated', 'Text'], ['Notification-only text', 'Unknown transport'], ['Paired RCS', 'RCS'],
  ]);
  state.googleMessages = null;
  paint(state);
  assert.deepEqual(visible(), [
    ['Carrier only', 'Text'], ['Shared text', 'Text'], ['Repeated', 'Text'], ['Repeated', 'Text'],
    ['Notification-only text', 'Unknown transport'],
  ], 'the same carrier and notification row works without a Mac helper');
});

test('one reply uses its exact Google conversation or an independently verified carrier route', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { missing: [] } } },
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [{ id: 'paired', addrs: [dest], reply: true, at: 1000 }],
      history: { chat: 'paired', loaded: true, items: [] },
    },
  };
  const google = [];
  let result = true;
  const { received, asked, replies, paint, chat, rows } = inbox(state, {
    async googleMessages(msg) { google.push(msg); return result; },
  });
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 500 }] });
  rows()[0].onclick();
  const composer = chat.children[1].children[3];
  const reply = async () => {
    composer.children[2].children[1].value = 'Synthetic reply';
    await composer.children[3].onclick();
  };
  const texts = () => asked.filter((x) => x.t === 'sms.send');
  await reply();
  assert.equal(google.at(-1).op, 'send');
  assert.equal(google.at(-1).chat, 'paired');
  assert.equal(texts().length, 0);
  result = false;
  await reply();
  assert.equal(google.length, 2);
  assert.equal(texts().length, 0, 'an unconfirmed dispatch must never be retried by SMS');
  result = 'not-dispatched';
  // The Google conversation supplied the verified destination. It remains
  // eligible for one SMS if the helper drops even without a carrier thread.
  received.get('sms.threads')({ items: [] });
  await reply();
  assert.equal(google.length, 3);
  assert.equal(texts().length, 1);
  assert.equal(texts()[0].to, dest);
  assert.equal(texts()[0].phone.session, 1);
  state.googleMessages = { owner: phone, enabled: true, state: 'keychain-error', rows: [] };
  paint(state);
  await reply();
  assert.equal(google.length, 3);
  assert.equal(texts().length, 2);
  assert.equal(replies.length, 0);

  state.hub.session++;
  paint(state);
  await reply();
  assert.equal(texts().length, 2, 'a replacement phone session invalidates the selected address');
  state.hub.perm.messages.missing = ['send'];
  paint(state);
  await reply();
  assert.equal(texts().length, 2, 'carrier permission still gates the fallback');
});

test('live notification and structured Reply precede SMS, with unverified titles scoped to device and app', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const app = 'com.google.android.apps.messaging';
  const active = { id: 'notice', app, title: 'Fixture', at: 200, body: 'Fixture body',
    from: phone, messagePhone: phone, messagePeer: dest, messageAt: 100, reply: true, replySession: 'session-one' };
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { missing: [] } } },
    notifs: { history: [active,
      { ...active, id: 'unknown-1', messagePeer: null, reply: false },
      { ...active, id: 'unknown-2', messagePeer: null, reply: false },
      { ...active, from: 'other-phone', id: 'unknown-3', messagePeer: null, reply: false },
    ] },
  };
  const { received, asked, replies, paint, chat, rows } = inbox(state);
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 100 }] });
  assert.equal(rows().length, 3, 'one verified contact and one unverified title per device');
  rows().at(-1).onclick();
  const composer = chat.children[1].children[3];
  async function reply() {
    composer.children[2].children[1].value = 'Fixture reply';
    await composer.children[3].onclick();
  }
  const texts = () => asked.filter((x) => x.t === 'sms.send');
  await reply();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].id === active.id && replies[0].from === phone && replies[0].replySession === active.replySession);
  assert.equal(texts().length, 0);
  state.chatsMessaging = true;
  state.chats = [{ key: 'structured', app, name: 'Fixture', messagePeer: dest, from: phone,
    replySession: 'r:fixture', reply: true, at: 200, items: [{ text: 'Fixture body', at: 100 }] }];
  paint(state);
  await reply();
  assert.equal(replies.length, 2);
  assert.ok(replies[1].chat === 'structured' && replies[1].from === phone && replies[1].replySession === 'r:fixture');
  assert.equal(texts().length, 0);
  state.chats[0].reply = false;
  paint(state);
  await reply();
  assert.equal(texts().length, 1);
});

test('a not-dispatched result for a replaced Google conversation does not send by SMS', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: {} } },
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [{ id: 'first', addrs: [dest], reply: true, at: 100 }],
      history: { chat: 'first', loaded: true, items: [] },
    },
  };
  let settle;
  const { asked, paint, chat, rows } = inbox(state, {
    googleMessages: (msg) => msg.op === 'send' ? new Promise((resolve) => { settle = resolve; }) : Promise.resolve(true),
  });
  paint(state);
  rows()[0].onclick();
  const composer = chat.children[1].children[3];
  composer.children[2].children[1].value = 'Fixture draft';
  const sending = composer.children[3].onclick();
  state.googleMessages.rows[0].id = 'replacement';
  state.googleMessages.history.chat = 'replacement';
  paint(state);
  settle('not-dispatched');
  await sending;
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0);
  assert.ok(composer.children[2].children[1].value);
});

test('late photo conversion cannot populate or send in another conversation or replacement phone session', async () => {
  const phone = 'fixture-phone';
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { mms: true } } },
  };
  let finish;
  class FileReader {
    readAsDataURL() { finish = () => { this.result = 'data:image/jpeg;base64,AA=='; this.onload(); }; }
  }
  class Image {
    constructor() { this.naturalWidth = this.naturalHeight = 1; }
    set src(_) { this.onload(); }
  }
  const document = { createElement: () => ({
    getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AA==',
  }) };
  const { received, asked, paint, chat, rows } = inbox(state, {}, { FileReader, Image, document });
  const load = () => received.get('sms.threads')({ items: [
    { id: 'first', addrs: ['+12025550100'], at: 200 },
    { id: 'second', addrs: ['+12025550101'], at: 100 },
  ] });
  paint(state);
  load();
  rows()[0].onclick();
  const composer = chat.children[1].children[3];
  const input = composer.children[4];
  const chip = composer.children[2].children[0];
  const start = () => { input.files = [{ type: 'image/jpeg' }]; input.onchange(); };
  const end = async () => { finish(); await Promise.resolve(); };
  start();
  rows()[1].onclick();
  await end();
  assert.equal(chip.hidden, true);
  start();
  state.hub.session++;
  paint(state);
  load();
  rows()[1].onclick();
  await end();
  assert.equal(chip.hidden, true);
  await composer.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0);
  start();
  await end();
  assert.equal(chip.hidden, false);
  await composer.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 1);
});
