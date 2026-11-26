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
  const parents = new WeakMap();
  const el = (tag, props = {}, children = []) => ({
    tag, ...props, children: children.filter(Boolean), attrs: { ...props.attrs },
    style: {}, dataset: {}, classList: { add() {}, toggle() {} },
    addEventListener(type, fn) { this.listeners = this.listeners || {}; (this.listeners[type] = this.listeners[type] || []).push(fn); },
    focus() {}, querySelectorAll() { return []; },
    setAttribute(key, value) { this.attrs[key] = value; },
    append(...nodes) {
      // DOM append moves a node, also inside its own parent. The legend is one element, not a copy.
      for (const node of nodes) {
        const parent = node && typeof node === 'object' ? parents.get(node) : undefined;
        if (parent) parent.children = parent.children.filter((child) => child !== node);
        if (node && typeof node === 'object') parents.set(node, this);
        this.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      for (const child of this.children) if (child && typeof child === 'object') parents.delete(child);
      this.children = nodes;
      for (const node of nodes) if (node && typeof node === 'object') parents.set(node, this);
    },
  });
  let tab;
  const UI = {
    el, state, api: { setChats() {}, hub() {}, notifReply: (msg) => { replies.push(msg); return true; }, ...api },
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
    hubAsk: (msg) => { asked.push(msg); return globals.askResult ? globals.askResult(msg) : true; },
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
  assert.deepEqual(Array.from(rows(), snippet), ['New chat', 'Old SMS']);
  assert.equal(rows()[0].children[1].children[0].children[1].text, '2000');
  findPill('Messages (Chat)').onclick();
  assert.deepEqual(Array.from(rows(), snippet), ['New chat']);
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
  assert.deepEqual(Array.from(rows(), snippet), ['RCS from history', 'WA']);
  assert.equal(findPill('Messages (Chat)').hidden, false);
  state.chatsMessaging = true;
  paint(state);
  assert.equal(findPill('Messages (Chat)').hidden, true, 'structured messaging replaces the history fallback');
  findPill('All').onclick();
  assert.deepEqual(Array.from(rows(), snippet), ['WA']);
});

const joinFixture = (googleState) => {
  const app = 'com.google.android.apps.messaging';
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const at = 10000;
  return {
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
      owner: phone, state: googleState, enabled: true,
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
};
const joinCarrier = (received) => received.get('sms.threads')({ nanp: true, items: [
  { id: 'carrier', addrs: ['2025550100'], name: 'Fixture carrier', at: 10300, snippet: 'Repeated' },
  { id: 'mms-group', addrs: ['+12025550100', '+12025550101'], name: 'Fixture group', at: 200, snippet: 'Separate MMS group' },
] });
const joinHistory = (received) => received.get('sms.thread')({ id: 'carrier', items: [
  { id: 's3', at: 10300, body: 'Repeated' },
  { id: 's2', at: 10300, body: 'Repeated' },
  { id: 's1', at: 10000, body: 'Shared text' },
  { id: 's0', at: 9000, body: 'Carrier only' },
] });
const rowName = (row) => row.children[1].children[0].children[0].text;
const rowTime = (row) => row.children[1].children[0].children[1].text;
const bubbleClasses = (chat) => Array.from(chat.children[1].children[1].children[0].children)
  .filter((node) => node.class?.startsWith('hub-bubble')).map((node) => node.class);
const bubbleWords = (chat) => Array.from(chat.children[1].children[1].children[0].children)
  .filter((node) => node.class?.startsWith('hub-bubble'))
  .map((node) => Array.from(node.children, (child) => child.text));

test('All lists one Google row per verified person in Google mode, with Google history alone and no carrier history read', () => {
  const state = joinFixture('connected');
  const { received, asked, paint, texts, chat, rows, findPill, snippet } = inbox(state, { googleMessages: async () => true });
  paint(state);
  joinCarrier(received);
  assert.equal(findPill('All').attrs['aria-selected'], 'true');
  assert.equal(rows().length, 2, 'no notification, structured or carrier row without a Google source');
  assert.deepEqual(Array.from(rows(), rowName), ['Fixture paired', 'Fixture paired']);
  assert.equal(rowTime(rows()[0]), '12000', 'the time is the Google source');
  assert.equal(snippet(rows()[0]), 'Paired RCS');
  rows()[0].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.thread').length, 0, 'the phone thread is never read');
  joinHistory(received);
  assert.deepEqual(bubbleWords(chat), [['Shared text'], ['Repeated'], ['Paired RCS']]);
  assert.deepEqual(bubbleClasses(chat), ['hub-bubble in text', 'hub-bubble in text', 'hub-bubble in rcs']);
  assert.equal(chat.children[1].children[1].children[0].children.some((n) => n.text === 'Earlier messages'), false);
  const legendOf = (root) => root.children[0].children[0].children.find((node) => node.class === 'hub-transport-legend');
  assert.equal(Array.from(legendOf(chat).children, (key) => key.children[1].text).join(), 'SMS,RCS');
  assert.deepEqual(Array.from(legendOf(chat).children, (key) => key.children[0].class), ['hub-swatch text', 'hub-swatch rcs']);
  assert.equal(legendOf(texts), undefined);
});

test('All joins one-to-one carrier and notification history by verified destination in phone mode, keeping group and ambiguous messages intact', () => {
  for (const googleState of ['disconnected', 'offline']) {
    const state = joinFixture(googleState);
    const { received, asked, paint, chat, rows, findPill } = inbox(state, { googleMessages: async () => true });
    paint(state);
    joinCarrier(received);
    assert.equal(findPill('All').attrs['aria-selected'], 'true');
    assert.equal(rows().length, 4, `${googleState}: the merged person, the other phone's notice and both groups`);
    rows()[0].onclick();
    assert.equal(asked.at(-1).t, 'sms.thread');
    assert.equal(asked.at(-1).id, 'carrier');
    joinHistory(received);
    assert.deepEqual(bubbleWords(chat), [
      ['Carrier only'], ['Shared text'], ['Repeated'], ['Repeated'],
      ['Notification-only text'],
    ], 'the same carrier and notification row works without Google Messages');
    assert.deepEqual(bubbleClasses(chat), [
      'hub-bubble in text', 'hub-bubble in text', 'hub-bubble in text', 'hub-bubble in text', 'hub-bubble in unknown',
    ]);
  }
  // Google Messages goes away while the row is open: the phone's own history takes over the same row.
  const state = joinFixture('connected');
  const { received, asked, paint, chat, rows } = inbox(state, { googleMessages: async () => true });
  paint(state);
  joinCarrier(received);
  rows()[0].onclick();
  state.googleMessages = null;
  paint(state);
  assert.equal(asked.filter((m) => m.t === 'sms.thread').length, 1);
  joinHistory(received);
  assert.deepEqual(bubbleWords(chat), [['Carrier only'], ['Shared text'], ['Repeated'], ['Repeated'], ['Notification-only text']]);
});

test('bubbles keep transport classes and hub status without transport labels, with one SMS and RCS legend', () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { mms: true } } },
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [{ id: 'paired', name: 'Fixture paired', addrs: [dest], at: 2000 }],
      history: { chat: 'paired', loaded: true, items: [
        { id: 'in-rcs', at: 1000, text: 'In RCS', me: false, transport: 'rcs' },
        { id: 'out-rcs', at: 1100, text: 'Out RCS', me: true, transport: 'rcs' },
        { id: 'in-sms', at: 1200, text: 'In SMS', me: false, transport: 'text' },
        { id: 'out-sms', at: 1300, text: 'Out SMS', me: true, transport: 'text' },
        { id: 'in-unknown', at: 1400, text: 'In unknown', me: false },
        { id: 'out-unknown', at: 1500, text: 'Out unknown', me: true, transport: 'other' },
        { id: 'failed-rcs', at: 1600, text: 'Failed RCS', me: true, transport: 'rcs', status: 'failed', error: 'No service' },
      ] },
    },
  };
  const { received, paint, texts, chat, rows, findPill } = inbox(state, { googleMessages: async () => true });
  paint(state);
  rows()[0].onclick();
  const bubbles = () => Array.from(chat.children[1].children[1].children[0].children)
    .filter((node) => String(node.class || '').startsWith('hub-bubble'));
  assert.deepEqual(bubbles().map((node) => node.class), [
    'hub-bubble in rcs',
    'hub-bubble out rcs',
    'hub-bubble in text',
    'hub-bubble out text',
    'hub-bubble in unknown',
    'hub-bubble out unknown',
    'hub-bubble out rcs failed',
  ]);
  const transportWords = new Set(['Text', 'RCS', 'Unknown transport']);
  assert.equal(bubbles().some((node) => node.children.some((child) => transportWords.has(child.text))), false);
  assert.deepEqual(Array.from(bubbles().at(-1).children, (child) => child.text), ['Failed RCS', 'Not sent: No service']);
  const legendOf = (root) => root.children[0].children[0].children.find((node) => node.class === 'hub-transport-legend');
  const legend = legendOf(chat);
  assert.equal(legendOf(texts), undefined);
  assert.deepEqual(Array.from(legend.children, (key) => [key.children[0].class, key.children[1].text]), [
    ['hub-swatch text', 'SMS'],
    ['hub-swatch rcs', 'RCS'],
  ]);
  assert.equal(legend.children.length, 2);
  received.get('sms.threads')({ items: [{ id: 'sms1', addrs: ['+12025550199'], name: 'Fixture texts', at: 50, snippet: 'List snippet' }] });
  findPill('Texts').onclick();
  assert.equal(legendOf(chat), undefined);
  assert.equal(legendOf(texts), legend);
  texts.children[0].children[1].children[0].onclick();
  received.get('sms.thread')({ id: 'sms1', items: [
    { id: 'bad', at: 300, body: 'Failed text', out: true, status: 'failed', error: 'No service' },
    { id: 'out', at: 200, body: 'Out text', out: true },
    { id: 'in', at: 100, body: 'In text', out: false },
  ] });
  const textBubbles = () => Array.from(texts.children[1].children[1].children.find((node) => node.class === 'hub-bubbles').children)
    .filter((node) => String(node.class || '').startsWith('hub-bubble'));
  assert.deepEqual(textBubbles().map((node) => node.class), [
    'hub-bubble in text',
    'hub-bubble out text',
    'hub-bubble out text failed',
  ]);
  assert.equal(textBubbles().some((node) => node.children.some((child) => transportWords.has(child.text))), false);
  assert.ok(textBubbles().at(-1).children.some((child) => child.text === 'Not sent: No service'));
});

test('one reply uses its exact Google conversation or an independently verified carrier route', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { missing: [] } } },
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [{ id: 'paired', addrs: [dest], reply: true, kind: 'sms', at: 1000 }],
      history: { chat: 'paired', loaded: true, items: [] },
    },
  };
  const google = [];
  let result = true;
  const { received, asked, replies, paint, chat, rows } = inbox(state, {
    async googleMessages(msg) {
      google.push(msg);
      // The helper dropped: the paired conversation is no longer available.
      if (result === 'not-dispatched') state.googleMessages = { owner: phone, enabled: true, state: 'offline', rows: [] };
      return result;
    },
  });
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 500 }] });
  assert.equal(rows().length, 1);
  rows()[0].onclick();
  assert.equal(asked.filter((x) => x.t === 'sms.thread').length, 0, 'Google mode never reads the phone thread');
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
  // Google reported this conversation as SMS, and it supplied the verified destination. It
  // remains eligible for one SMS if the helper drops even without a carrier thread.
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
      rows: [{ id: 'first', addrs: [dest], reply: true, kind: 'sms', at: 100 }],
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

const fire = (node, type, event = {}) => { for (const fn of node.listeners?.[type] || []) fn(event); };
const bubbleTexts = (chat) => Array.from(chat.children[1].children[1].children[0].children)
  .filter((node) => node.class?.startsWith('hub-bubble'))
  .map((node) => Array.from(node.children, (child) => child.text));
const hints = (chat) => Array.from(chat.children[1].children[1].children[0].children)
  .filter((node) => node.class === 'hint').map((node) => node.text);

test('a notification draft keeps its pinned offer when a newer same-title notice arrives, and keeps the draft on refusal', async () => {
  const app = 'com.whatsapp';
  const first = { id: 'n1', app, title: 'Fixture title', body: 'First body', at: 100, from: 'phone-a', reply: true, replySession: 's1' };
  const state = {
    ui: { chats: true },
    hub: { deviceId: 'phone-a', session: 1, messages: true, perm: { messages: {} } },
    notifs: { history: [first] },
  };
  let refuse = false;
  const sent = [];
  const { paint, chat, rows } = inbox(state, { notifReply: (msg) => { sent.push(msg); return !refuse; } });
  paint(state);
  rows()[0].onclick();
  const composer = chat.children[1].children[3];
  const box = composer.children[2].children[1];
  box.value = 'Synthetic draft';
  fire(box, 'input');
  state.notifs.history = [{ ...first, id: 'n2', body: 'Newer body', at: 200, from: 'phone-b', replySession: 's2' }, first];
  paint(state);
  await composer.children[3].onclick();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].id === 'n1' && sent[0].from === 'phone-a' && sent[0].replySession === 's1', 'the draft stays on its pinned offer');
  assert.equal(box.value, '');

  const newer = state.notifs.history[0];
  state.notifs.history = [first];
  paint(state);
  box.value = 'Second draft';
  fire(box, 'input');
  state.notifs.history = [newer, { ...first, reply: false }];
  paint(state);
  await composer.children[3].onclick();
  assert.equal(sent.length, 1, 'an expired pinned offer is never retargeted to the newer notice');
  assert.equal(box.value, 'Second draft', 'the draft is kept');
  assert.equal(hints(chat).length, 1, 'the failure is shown');

  box.value = '';
  fire(box, 'input');
  box.value = 'Third draft';
  fire(box, 'input');
  refuse = true;
  await composer.children[3].onclick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].id, 'n2');
  assert.equal(box.value, 'Third draft', 'a refused Reply keeps the draft');
  assert.equal(hints(chat).length, 1, 'and shows the failure');
});

test('a New Message picture cannot move to a different To while it converts or after it is attached', async () => {
  const state = { hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: { mms: true } } } };
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
  const { asked, paint, texts } = inbox(state, {}, { FileReader, Image, document });
  paint(state);
  texts.children[0].children[0].children[1].onclick();
  const conv = texts.children[1];
  const to = conv.children[0].children[0];
  const compose = conv.children[3];
  const chip = compose.children[2].children[0];
  const box = compose.children[2].children[1];
  const start = () => { compose.children[4].files = [{ type: 'image/jpeg' }]; compose.children[4].onchange(); };
  const end = async () => { finish(); await Promise.resolve(); };
  to.value = '+12025550100';
  start();
  to.value = '+12025550101';
  fire(to, 'input');
  await end();
  assert.equal(chip.hidden, true, 'conversion finishing after a To edit is dropped');
  start();
  await end();
  assert.equal(chip.hidden, false);
  to.value = '+12025550100';
  fire(to, 'input');
  box.value = 'Synthetic text';
  compose.children[3].onclick();
  const sends = asked.filter((m) => m.t === 'sms.send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, '+12025550100');
  assert.equal(sends[0].image, undefined, 'the picture attached for the first To is not transferred');
});

test('a structured conversation fully matched to carrier history keeps its live phone Reply ahead of SMS', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const app = 'com.google.android.apps.messaging';
  const state = {
    ui: { chats: true }, chatsMessaging: true,
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: {} } },
    chats: [{ key: 'structured', app, name: 'Fixture', messagePeer: dest, from: phone, replySession: 'r:live', reply: true, at: 100, items: [] }],
  };
  const { received, asked, replies, paint, chat, rows } = inbox(state);
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 100 }] });
  assert.equal(rows().length, 1);
  rows()[0].onclick();
  received.get('sms.thread')({ id: 'carrier', items: [{ id: 's1', at: 100, body: 'Shared text' }] });
  assert.deepEqual(bubbleTexts(chat), [['Shared text']], 'no duplicated history');
  const composer = chat.children[1].children[3];
  composer.children[2].children[1].value = 'Synthetic reply';
  fire(composer.children[2].children[1], 'input');
  await composer.children[3].onclick();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].chat === 'structured' && replies[0].replySession === 'r:live');
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0);
});

test('not-dispatched does not send SMS when the same Google conversation is writable again', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: {} } },
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [{ id: 'paired', addrs: [dest], reply: true, kind: 'sms', at: 100 }],
      history: { chat: 'paired', loaded: true, items: [] },
    },
  };
  const { received, asked, paint, chat, rows } = inbox(state, {
    googleMessages: async (msg) => msg.op === 'send' ? 'not-dispatched' : true,
  });
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 50 }] });
  assert.equal(rows().length, 1);
  rows()[0].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.thread').length, 0);
  const composer = chat.children[1].children[3];
  composer.children[2].children[1].value = 'Synthetic draft';
  await composer.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0);
  assert.equal(composer.children[2].children[1].value, 'Synthetic draft');
});

test('a group with an unresolved member is never sent to the resolved subset', () => {
  const state = { hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: { mms: true } } } };
  const { received, asked, paint, texts } = inbox(state);
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'g', group: true, unresolved: true, addrs: ['+12025550100', '+12025550101'], at: 100 }] });
  texts.children[0].children[1].children[0].onclick();
  const compose = texts.children[1].children[3];
  compose.children[2].children[1].value = 'Synthetic group text';
  compose.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0);
  assert.equal(compose.hidden, true);
});

test('matching older history cannot remove a new send before its failure receipt', () => {
  const dest = '+12025550100';
  const state = {
    ui: { chats: true },
    hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: { mms: true } } },
  };
  const { received, asked, paint, chat, rows } = inbox(state);
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 100 }] });
  rows()[0].onclick();
  received.get('sms.thread')({ id: 'carrier', items: [] });
  const composer = chat.children[1].children[3];
  composer.children[2].children[1].value = 'Same text';
  composer.children[3].onclick();
  const send = asked.findLast((m) => m.t === 'sms.send');
  received.get('sms.new')({ thread: 'carrier', msg: { id: 's-old', at: Date.now() - 60000, body: 'Same text', out: true } });
  received.get('sms.sent')({ ref: send.ref, ok: false, error: 'No service' });
  const failed = bubbleTexts(chat).filter((b) => b.some((t) => typeof t === 'string' && t.startsWith('Not sent')));
  assert.equal(failed.length, 1, 'the failed send keeps its visible failure row');
});

test('a captioned attachment MMS does not collapse into a plain text projection', () => {
  const dest = '+12025550100';
  const app = 'com.google.android.apps.messaging';
  const state = {
    ui: { chats: true }, chatsMessaging: true,
    hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: {} } },
    chats: [{ key: 'structured', app, name: 'Fixture', messagePeer: dest, at: 5000, items: [{ id: 'x', text: 'Caption', at: 5000 }] }],
  };
  const { received, paint, chat, rows } = inbox(state);
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 5000 }] });
  rows()[0].onclick();
  received.get('sms.thread')({ id: 'carrier', items: [{ id: 'm1', at: 5000, body: 'Caption', attachment: true, parts: [] }] });
  assert.equal(bubbleTexts(chat).length, 2);
});

test('a draft follows a newer offer of its proven conversation only, and is never discarded', async () => {
  const phone = 'fixture-phone';
  const peer = '+12025550100';
  const app = 'com.google.android.apps.messaging';
  const first = { id: 'n1', app, title: 'Fixture', body: 'Fixture body', at: 100, from: phone, messagePhone: phone,
    messagePeer: peer, messageAt: 100, reply: true, replySession: 's1' };
  const state = {
    ui: { chats: true },
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { missing: ['send'] } } },
    notifs: { history: [first] },
  };
  const sent = [];
  const { asked, paint, chat, rows } = inbox(state, { notifReply: (msg) => { sent.push(msg); return true; } });
  paint(state);
  rows()[0].onclick();
  const composer = chat.children[1].children[3];
  const box = composer.children[2].children[1];
  const type = (text) => { box.value = ''; fire(box, 'input'); box.value = text; fire(box, 'input'); };
  type('Synthetic draft');
  // The phone re-posts the same conversation: a new notification and a new reply session.
  const second = { ...first, id: 'n2', at: 200, messageAt: 200, replySession: 's2' };
  state.notifs.history = [second, { ...first, reply: false }];
  paint(state);
  await composer.children[3].onclick();
  assert.equal(sent.length, 1, 'the draft stays sendable');
  assert.ok(sent[0].id === 'n2' && sent[0].from === phone && sent[0].replySession === 's2');
  assert.equal(box.value, '');

  type('Second draft');
  const stale = { ...second, reply: false };
  const cases = [
    ['another phone', [{ ...second, id: 'n3', from: 'other-phone', messagePhone: 'other-phone', replySession: 's3' }, stale]],
    ['another peer', [{ ...second, id: 'n4', messagePeer: '+12025550101', replySession: 's4' }, stale]],
    ['an unverified same title', [{ ...second, id: 'n5', messagePeer: null, messagePhone: null, replySession: 's5' }, stale]],
  ];
  for (const [label, history] of cases) {
    state.notifs.history = history;
    paint(state);
    await composer.children[3].onclick();
    assert.equal(sent.length, 1, `never retargeted to ${label}`);
    assert.equal(box.value, 'Second draft', `the draft is kept (${label})`);
  }
  state.notifs.history = [{ ...second, id: 'n6', replySession: 's6' }, stale];
  paint(state);
  await composer.children[3].onclick();
  assert.equal(sent.length, 2, 'the same proven conversation is still sendable');
  assert.ok(sent[1].id === 'n6' && sent[1].replySession === 's6');

  type('Third draft');
  // The same phone on a new session: the pinned draft is refused, never carried, and its text stays.
  state.notifs.history = [{ ...second, id: 'n7', replySession: 's7' }, { ...second, id: 'n6', replySession: 's6', reply: false }];
  state.hub.session = 2;
  paint(state);
  await composer.children[3].onclick();
  assert.equal(sent.length, 2, 'never carried across a replacement phone session');
  assert.equal(box.value, 'Third draft', 'a same-phone session change keeps the typed draft');
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0, 'never retried by SMS');
});

test('ordinary Texts sends and reads carry their phone; a receipt without a contact repaints and reloads', () => {
  const timers = [];
  const state = { hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: { mms: true } } } };
  const { received, asked, paint, texts } = inbox(state, {}, { setTimeout: (fn) => { timers.push(fn); return timers.length; } });
  paint(state);
  const reads = asked.filter((m) => m.t === 'sms.threads');
  assert.ok(reads.length >= 1 && reads.every((m) => m.phone && m.phone.deviceId === 'fixture-phone' && m.phone.session === 1));
  received.get('sms.threads')({ items: [{ id: 't1', addrs: ['+12025550100'], at: 100 }] });
  texts.children[0].children[1].children[0].onclick();
  assert.ok(asked.filter((m) => m.t === 'sms.thread').every((m) => m.phone?.session === 1), 'history reads carry the phone');
  texts.children[0].children[0].children[1].onclick();
  const conv = texts.children[1];
  const to = conv.children[0].children[0];
  const compose = conv.children[3];
  to.value = '+12025550102';
  compose.children[2].children[1].value = 'Synthetic text';
  compose.children[3].onclick();
  const send = asked.findLast((m) => m.t === 'sms.send');
  assert.ok(send && send.phone.deviceId === 'fixture-phone' && send.phone.session === 1, 'an ordinary send names its phone');
  const before = asked.filter((m) => m.t === 'sms.threads').length;
  state.hub.session = 2;
  assert.doesNotThrow(() => received.get('sms.sent')({ ref: send.ref, ok: true }));
  timers.splice(0).forEach((fn) => fn());
  const after = asked.filter((m) => m.t === 'sms.threads');
  assert.equal(after.length, before + 1, 'the new conversation is reloaded');
  assert.equal(after.at(-1).phone.session, 1, 'asked of the phone session that sent it');
});

test('a refused carrier request marks its send failed rather than leaving it sending', async () => {
  const state = { hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: { mms: true } } } };
  const { received, asked, paint, texts } = inbox(state, {}, { askResult: (m) => m.t !== 'sms.send' });
  paint(state);
  received.get('sms.threads')({ items: [{ id: 't1', addrs: ['+12025550100'], at: 100 }] });
  texts.children[0].children[1].children[0].onclick();
  received.get('sms.thread')({ id: 't1', items: [] });
  const compose = texts.children[1].children[3];
  compose.children[2].children[1].value = 'Synthetic text';
  compose.children[3].onclick();
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 1);
  const shown = JSON.stringify(texts.children[1].children[1], (k, v) => (k === 'listeners' ? undefined : v));
  assert.match(shown, /Not sent/, 'the refusal is shown, not retried');
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 1);
});

test('an oversized group is refused with its note and never cut down to 20', () => {
  const state = { hub: { deviceId: 'fixture-phone', session: 1, messages: true, perm: { messages: { mms: true } } } };
  const { received, asked, paint, texts } = inbox(state);
  paint(state);
  const many = Array.from({ length: 21 }, (_, i) => `+120255501${String(i).padStart(2, '0')}`);
  received.get('sms.threads')({ items: [{ id: 'g', group: true, addrs: many, at: 100 }] });
  texts.children[0].children[1].children[0].onclick();
  const conv = texts.children[1];
  const compose = conv.children[3];
  compose.children[2].children[1].value = 'Synthetic group text';
  compose.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0, 'an existing 21-member group is refused');
  assert.equal(conv.children[2].hidden, false, 'with its note');

  texts.children[0].children[0].children[1].onclick();
  const to = conv.children[0].children[0];
  to.value = many.join(', ');
  fire(to, 'input');
  assert.equal(conv.children[2].hidden, false, 'New Message shows the note for 21 recipients');
  compose.children[2].children[1].value = 'Synthetic group text';
  compose.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0, 'a 21-recipient New Message is refused');
  assert.equal(compose.children[2].children[1].value, 'Synthetic group text', 'its text is kept');
  to.value = many.slice(0, 20).join(', ');
  fire(to, 'input');
  compose.children[3].onclick();
  const sends = asked.filter((m) => m.t === 'sms.send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].addrs.length, 20, 'exactly 20 is sent whole');
});

test('a same-phone reconnect keeps the Texts draft, the open conversation and unsent bubbles; another phone clears them', async () => {
  const phone = 'fixture-phone';
  const state = { hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { mms: true } } } };
  const { received, asked, paint, texts } = inbox(state, {}, { askResult: (m) => m.t !== 'sms.send' });
  paint(state);
  const threads = () => received.get('sms.threads')({ items: [{ id: 't1', addrs: ['+12025550100'], at: 100 }] });
  threads();
  texts.children[0].children[1].children[0].onclick();
  received.get('sms.thread')({ id: 't1', items: [] });
  const conv = texts.children[1];
  const compose = conv.children[3];
  const box = compose.children[2].children[1];
  box.value = 'Synthetic refused';
  compose.children[3].onclick();
  await new Promise((r) => setImmediate(r));
  const shown = () => JSON.stringify(conv.children[1], (k, v) => (k === 'listeners' ? undefined : v));
  assert.match(shown(), /Not sent/);
  box.value = 'Synthetic draft';
  // The same phone drops and comes back: two session changes, no device ID in between.
  state.hub = { ...state.hub, deviceId: '', session: 2, messages: false };
  paint(state);
  state.hub = { ...state.hub, deviceId: phone, session: 3, messages: true };
  paint(state);
  assert.equal(box.value, 'Synthetic draft', 'the draft survives a same-phone reconnect');
  assert.equal(conv.hidden, false, 'the conversation stays open');
  const reread = asked.filter((m) => m.t === 'sms.thread' && m.phone.session === 3);
  assert.ok(reread.length === 1 && reread[0].id === 't1', 'the open conversation is read again from the new session');
  threads();
  received.get('sms.thread')({ id: 't1', items: [] });
  assert.match(shown(), /Synthetic refused/, 'the unsent bubble is kept');
  assert.match(shown(), /Not sent/);
  state.hub = { ...state.hub, deviceId: 'other-phone', session: 4 };
  paint(state);
  assert.equal(box.value, '', 'another phone never inherits the draft');
  assert.equal(conv.hidden, true, 'another phone closes the conversation');
  assert.doesNotMatch(shown(), /Synthetic refused/);
});

test('with the Chats switch off, an open chat and its draft outlast a phone drop and a Google Messages outage; another phone clears them', async () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const gm = (row) => ({ owner: phone, state: 'connected', enabled: true, rows: [row], history: { chat: row.id, loaded: true, items: [] } });
  const paired = { id: 'paired', addrs: [dest], reply: true, at: 1000 };
  const group = { id: 'group', name: 'Synthetic group', addrs: [dest, '+12025550101'], group: true, reply: true, at: 1000 };
  const hub = { deviceId: phone, session: 1, messages: true, perm: { messages: { missing: [] } } };
  const open = (row) => {
    // No ui.chats: only the paired Google Messages shows the chats.
    const state = { hub: { ...hub }, googleMessages: gm(row) };
    const google = [];
    const page = inbox(state, { async googleMessages(msg) { google.push(msg); return true; } });
    page.paint(state);
    page.findPill('All').onclick(); // a pill the user chose is not picked again by itself
    page.rows()[0].onclick();
    const conv = page.chat.children[1];
    const composer = conv.children[3];
    const box = composer.children[2].children[1];
    return { ...page, state, google, conv, composer, box };
  };

  // The same phone drops and comes back; its Google Messages view goes and returns with it.
  const one = open(paired);
  one.box.value = 'Synthetic chat draft';
  one.state.hub = { ...hub, deviceId: '', session: 2, messages: false };
  one.state.googleMessages = null;
  one.paint(one.state);
  assert.equal(one.chat.hidden, true, 'no chats while the phone is away');
  one.state.hub = { ...hub, session: 3 };
  one.state.googleMessages = { owner: phone, state: 'connecting', enabled: true, rows: [] };
  one.paint(one.state);
  one.state.googleMessages = gm(paired);
  one.paint(one.state);
  assert.equal(one.box.value, 'Synthetic chat draft', 'the draft survives a same-phone reconnect');
  assert.equal(one.findPill('All').attrs['aria-selected'], 'true', 'the chosen pill is back');
  assert.ok(!one.chat.hidden && !one.conv.hidden, 'the conversation is open again');
  await one.composer.children[3].onclick();
  const sent = one.google.filter((m) => m.op === 'send');
  assert.ok(sent.length === 1 && sent[0].chat === 'paired' && sent[0].text === 'Synthetic chat draft', 'the draft goes to its own conversation');
  one.box.value = 'Synthetic second draft';
  one.state.hub = { ...hub, deviceId: '', session: 4, messages: false };
  one.state.googleMessages = null;
  one.paint(one.state);
  one.state.hub = { ...hub, deviceId: 'other-phone', session: 5 };
  one.state.googleMessages = { ...gm(paired), owner: 'other-phone' };
  one.paint(one.state);
  assert.equal(one.box.value, '', 'another phone never inherits the draft');
  assert.ok(one.chat.hidden || one.conv.hidden, 'another phone never shows the conversation');

  // The phone stays; its Google Messages helper drops out and returns.
  const two = open(group);
  two.box.value = 'Synthetic group draft';
  for (const state of ['connecting', 'offline']) {
    two.state.googleMessages = { owner: phone, state, enabled: true, rows: [] };
    two.paint(two.state);
    assert.equal(two.chat.hidden, true);
  }
  two.state.googleMessages = gm(group);
  two.paint(two.state);
  assert.equal(two.box.value, 'Synthetic group draft', 'the draft survives a Google Messages outage');
  assert.ok(!two.chat.hidden && !two.conv.hidden, 'the conversation is open again');
});

test('All collapses Chat and Texts for one verified person across national and E.164 forms, in time order and route priority', async () => {
  const phone = 'fixture-phone';
  const app = 'com.google.android.apps.messaging';
  const order = (chat) => Array.from(chat.children[1].children[1].children[0].children)
    .filter((node) => node.class?.startsWith('hub-bubble')).map((node) => node.children[0].text);
  const hub = () => ({ deviceId: phone, session: 1, messages: true, perm: { messages: { missing: [] } } });

  // A national messagePeer under this phone's NANP context joins the E.164 carrier thread. An
  // unusable peer with no address, a group and a display name alone never join it.
  const state = {
    ui: { chats: true }, hub: hub(), chatsMessaging: true,
    chats: [
      { key: 'national-peer', app, name: 'Fixture person', messagePeer: '2025550100', from: phone,
        replySession: 'r:fixture', reply: true, at: 2500,
        items: [{ id: 'r1', text: 'Chat one', at: 1500 }, { id: 'r2', text: 'Chat two', at: 2500 }] },
      { key: 'unusable-peer', app, name: 'Fixture person', messagePeer: 'not-a-number', at: 3000,
        items: [{ id: 'u1', text: 'Unverified', at: 3000 }] },
      { key: 'group', app, name: 'Fixture person', group: true, messagePeer: '+12025550100', at: 50,
        items: [{ id: 'g1', text: 'Group', at: 50 }] },
    ],
  };
  const one = inbox(state);
  one.paint(state);
  one.received.get('sms.threads')({ nanp: true, items: [
    { id: 'carrier', addrs: ['+12025550100'], e164: '+12025550100', name: 'Fixture person', at: 2000, snippet: 'Text two' },
  ] });
  assert.equal(one.rows().length, 3, 'one merged person, the unverified chat and the group');
  one.rows()[1].onclick();
  assert.equal(one.asked.at(-1).t, 'sms.thread');
  assert.equal(one.asked.at(-1).id, 'carrier');
  one.received.get('sms.thread')({ id: 'carrier', items: [
    { id: 's2', at: 2000, body: 'Text two', out: true },
    { id: 's1', at: 1000, body: 'Text one' },
  ] });
  assert.deepEqual(order(one.chat), ['Text one', 'Chat one', 'Text two', 'Chat two']);
  const composer = one.chat.children[1].children[3];
  const reply = async (page, c) => {
    c.children[2].children[1].value = 'Synthetic reply';
    await c.children[3].onclick();
  };
  const texts = (page) => page.asked.filter((x) => x.t === 'sms.send');
  await reply(one, composer);
  assert.equal(one.replies.length, 1, 'the live exact phone Reply goes first');
  assert.equal(one.replies[0].chat, 'national-peer');
  assert.equal(texts(one).length, 0);
  state.chats[0].reply = false;
  state.chats[0].replySession = undefined;
  one.paint(state);
  await reply(one, composer);
  assert.equal(one.replies.length, 1);
  assert.equal(texts(one).length, 1, 'then exactly one SMS to the verified destination');
  assert.equal(texts(one)[0].to, '+12025550100');

  // An unusable peer on a paired Google row falls through to its verified E.164 address, which
  // joins the national carrier thread. Writable RCS goes first; an unconfirmed send is never retried by SMS.
  const google = [];
  let result = true;
  const paired = {
    ui: { chats: true }, hub: hub(),
    googleMessages: {
      owner: phone, state: 'connected', enabled: true,
      rows: [{ id: 'paired', name: 'Fixture person', messagePeer: 'not-a-number', addrs: ['+12025550111'], reply: true, kind: 'sms', at: 3000 }],
      history: { chat: 'paired', loaded: true, items: [{ id: 'h1', at: 1500, text: 'RCS one', me: false, transport: 'rcs' }] },
    },
  };
  const two = inbox(paired, { async googleMessages(msg) { google.push(msg); return msg.op === 'send' ? result : true; } });
  two.paint(paired);
  two.received.get('sms.threads')({ nanp: true, items: [
    { id: 'carrier-national', addrs: ['2025550111'], e164: '+12025550111', name: 'Fixture person', at: 2000, snippet: 'SMS two' },
  ] });
  assert.equal(two.rows().length, 1, 'the paired row and the national carrier thread are one person');
  two.rows()[0].onclick();
  assert.equal(two.asked.filter((x) => x.t === 'sms.thread').length, 0, 'Google mode never reads the phone thread');
  two.received.get('sms.thread')({ id: 'carrier-national', items: [
    { id: 't2', at: 2000, body: 'SMS two' }, { id: 't1', at: 1000, body: 'SMS one' },
  ] });
  assert.deepEqual(order(two.chat), ['RCS one'], 'Google history alone');
  const pairedComposer = two.chat.children[1].children[3];
  await reply(two, pairedComposer);
  const sends = () => google.filter((x) => x.op === 'send');
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].chat, 'paired');
  assert.equal(sends()[0].allowCarrier, true);
  result = false;
  await reply(two, pairedComposer);
  assert.equal(sends().length, 2);
  assert.equal(texts(two).length, 0, 'an uncertain dispatch is never repeated by SMS');

  // Phone mode: the same national carrier thread and its E.164 form are one row with the phone's history.
  paired.googleMessages = { ...paired.googleMessages, state: 'disconnected', rows: [] };
  two.paint(paired);
  assert.equal(two.rows().length, 1);
  assert.equal(two.asked.at(-1).t, 'sms.thread');
  assert.equal(two.asked.at(-1).id, 'carrier-national');
  two.received.get('sms.thread')({ id: 'carrier-national', items: [
    { id: 't2', at: 2000, body: 'SMS two' }, { id: 't1', at: 1000, body: 'SMS one' },
  ] });
  assert.deepEqual(order(two.chat), ['SMS one', 'SMS two']);
});

test('an unknown transport never takes the RCS fill, and the legend shows once and only on SMS or RCS lists', () => {
  const phone = 'fixture-phone';
  const dest = '+12025550100';
  const state = {
    ui: { chats: true }, chatsMessaging: true,
    hub: { deviceId: phone, session: 1, messages: true, perm: { messages: { mms: true } } },
    chats: [
      { key: 'rcs', app: 'com.google.android.apps.messaging', appName: 'Messages', name: 'Fixture contact', group: false, messagePeer: dest, at: 2000,
        items: [{ at: 1500, from: 'Fixture contact', text: 'Chat in', me: false }, { at: 2000, from: '', text: 'Chat out', me: true }] },
      { key: 'wa', app: 'com.whatsapp', appName: 'WhatsApp', name: 'Fixture other app', group: false, at: 900,
        items: [{ at: 800, from: 'Fixture other app', text: 'App in', me: false }, { at: 900, from: '', text: 'App out', me: true }] },
    ],
  };
  const { received, paint, texts, chat, rows, findPill } = inbox(state);
  paint(state);
  received.get('sms.threads')({ nanp: true, items: [{ id: 'carrier', addrs: ['(202) 555-0100'], e164: dest, name: 'Fixture contact', at: 1000, snippet: 'Text in' }] });
  const legendsOf = (root) => root.children[0].children[0].children.filter((node) => node.class === 'hub-transport-legend');
  const bubbles = () => Array.from(chat.children[1].children[1].children[0].children)
    .filter((node) => String(node.class || '').startsWith('hub-bubble')).map((node) => node.class);
  const named = (name) => rows().find((row) => row.children[1].children[0].children[0].text === name);
  findPill('All').onclick();
  paint(state);
  paint(state);
  assert.equal(legendsOf(chat).length, 1, 'repainting keeps one legend');
  assert.equal(legendsOf(texts).length, 0);
  const legend = legendsOf(chat)[0];
  assert.equal(!!legend.hidden, false);
  named('Fixture contact').onclick();
  received.get('sms.thread')({ id: 'carrier', items: [{ id: 's1', at: 1000, body: 'Text in' }] });
  assert.deepEqual(bubbles(), ['hub-bubble in text', 'hub-bubble in unknown', 'hub-bubble out unknown']);
  findPill('Messages (Chat)').onclick();
  assert.equal(legend.hidden, false);
  findPill('WhatsApp').onclick();
  assert.equal(legend.hidden, true, 'no SMS and RCS legend on another app');
  named('Fixture other app').onclick();
  assert.deepEqual(bubbles(), ['hub-bubble in', 'hub-bubble out'], 'another app keeps the plain bubbles');
  findPill('Texts').onclick();
  assert.equal(legend.hidden, false);
  assert.deepEqual([legendsOf(texts).length, legendsOf(chat).length], [1, 0]);
  findPill('All').onclick();
  assert.equal(legend.hidden, false);
  assert.deepEqual([legendsOf(texts).length, legendsOf(chat).length], [0, 1]);
});

test('transport colours are fixed tokens that hold for every accent, and the legend has its own row', () => {
  const css = fs.readFileSync(require.resolve('../phonehub.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => [m[1].trim().replace(/\s+/g, ' '), m[2].trim().replace(/\s+/g, ' ')]);
  const body = (selector) => rules.filter(([sel]) => sel.split(',').map((part) => part.trim()).includes(selector)).map(([, text]) => text).join(' ');
  const transport = rules.filter(([sel]) => /\.hub-(?:bubble|swatch)[^,]*\.(?:rcs|text|unknown)\b/.test(sel));
  assert.ok(transport.length >= 5);
  for (const [sel, text] of transport) assert.doesNotMatch(text, /--accent/, `${sel} must not follow the configurable accent`);
  const tokens = body('.hub-bubbles');
  const rcs = /--msg-rcs:\s*(#[0-9a-f]{6})\b/i.exec(tokens)?.[1];
  assert.ok(rcs, 'RCS is a fixed colour');
  assert.match(tokens, /--msg-sms:\s*var\(--good\)/);
  assert.ok(body('.hub-transport-legend').includes(`--msg-rcs: ${rcs}`), 'the legend swatches use the same tokens as the bubbles');
  assert.match(body('.hub-bubble.out:not(.failed).rcs'), /background:\s*var\(--msg-rcs\)/);
  assert.match(body('.hub-swatch.rcs'), /background:\s*var\(--msg-rcs\)/);
  assert.match(body('.hub-bubble.out:not(.failed).text'), /background:\s*var\(--msg-sms\)/);
  assert.match(body('.hub-swatch.text'), /background:\s*var\(--msg-sms\)/);
  const ink = /(?:^|[; ])color:\s*(#[0-9a-f]{6})\b/i.exec(body('.hub-bubble.out:not(.failed).rcs'))?.[1];
  assert.ok(ink, 'outgoing RCS has a fixed ink');
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(ink), lum(rcs)].sort((a, b) => b - a);
  assert.ok((hi + 0.05) / (lo + 0.05) >= 4.5, 'outgoing RCS text is at least 4.5:1');
  const unknown = body('.hub-bubble.out:not(.failed).unknown');
  assert.match(unknown, /background:\s*color-mix\(in srgb, var\(--text\) 22%, var\(--card\)\)/);
  assert.match(unknown, /(?:^|[; ])color:\s*var\(--text\)/);
  const legend = body('.hub-transport-legend');
  assert.match(legend, /flex:\s*0 0 100%/);
  assert.doesNotMatch(legend, /order:\s*-1/);
  assert.match(body('.hub-side-head'), /flex-wrap:\s*wrap/);
  assert.match(body('.hub-transport-legend[hidden]'), /display:\s*none/);
});

// ---- Google Messages as the source of truth while it is connected ----
const gmPhone = 'fixture-phone';
const gmDest = '+12025550100';
const connected = (rows, history = { chat: rows[0]?.id, loaded: true, items: [] }) =>
  ({ owner: gmPhone, state: 'connected', enabled: true, rows, history });
const gmPage = (googleMessages, extra = {}, result = () => true) => {
  const state = {
    ui: { chats: true },
    hub: { deviceId: gmPhone, session: 1, messages: true, perm: { messages: { mms: true, missing: [] } } },
    googleMessages, ...extra,
  };
  const google = [];
  const page = inbox(state, { async googleMessages(msg) { google.push(msg); return msg.op === 'send' ? result(msg, state) : true; } });
  page.paint(state);
  const composer = page.chat.children[1].children[3];
  const reply = async (text = 'Synthetic reply') => {
    composer.children[2].children[1].value = text;
    await composer.children[3].onclick();
  };
  return {
    ...page, state, google, composer, reply,
    sms: () => page.asked.filter((m) => m.t === 'sms.send'),
    gmSends: () => google.filter((m) => m.op === 'send'),
  };
};

test('a phone thread and a Google row flagged as a group for the same person show one row', () => {
  const page = gmPage(connected([{ id: 'flagged', name: 'Fixture person', group: true, addrs: [gmDest], reply: true, kind: 'rcs', at: 2000 }]));
  page.received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [gmDest], name: 'Fixture carrier', at: 3000, snippet: 'Carrier text' }] });
  assert.equal(page.rows().length, 1);
  assert.equal(rowName(page.rows()[0]), 'Fixture person');
});

test('an SMS-kind Google row and its phone thread are one row with Google messages only and no carrier history read', () => {
  const page = gmPage(connected([{ id: 'sms-row', name: 'Fixture Google', addrs: [gmDest], reply: true, kind: 'sms', at: 5000, snippet: 'Google snippet' }],
    { chat: 'sms-row', loaded: true, items: [{ id: 'g1', at: 4000, text: 'Google text', me: false, transport: 'text' }] }));
  page.received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [gmDest], name: 'Fixture carrier', at: 6000, snippet: 'Carrier snippet' }] });
  assert.equal(page.rows().length, 1);
  assert.deepEqual([rowName(page.rows()[0]), rowTime(page.rows()[0]), page.snippet(page.rows()[0])], ['Fixture Google', '5000', 'Google text']);
  page.rows()[0].onclick();
  page.received.get('sms.thread')({ id: 'carrier', items: [{ id: 's1', at: 4500, body: 'Carrier text' }] });
  assert.deepEqual(bubbleWords(page.chat), [['Google text']]);
  assert.equal(page.asked.filter((m) => m.t === 'sms.thread').length, 0);
});

test('notification and structured Chat rows are hidden in Google mode; WhatsApp stays', () => {
  const app = 'com.google.android.apps.messaging';
  const extra = {
    notifs: { history: [{ id: 'notice', app, title: 'Fixture notice', body: 'Notice text', at: 3000 }] },
    chats: [
      { key: 'structured', app, name: 'Fixture structured', messagePeer: '+12025550155', at: 4000, items: [{ id: 's', text: 'Structured', at: 4000 }] },
      { key: 'wa', app: 'com.whatsapp', name: 'Fixture WhatsApp', at: 1000, items: [{ id: 'w', text: 'WA', at: 1000 }] },
    ],
  };
  const gm = connected([{ id: 'g', name: 'Fixture Google', addrs: ['+12025550177'], reply: true, kind: 'rcs', at: 2000 }]);
  const page = gmPage(gm, extra);
  assert.deepEqual(Array.from(page.rows(), rowName), ['Fixture Google', 'Fixture WhatsApp']);
  page.findPill('Messages (Chat)').onclick();
  assert.deepEqual(Array.from(page.rows(), rowName), ['Fixture Google']);
  page.findPill('WhatsApp').onclick();
  assert.deepEqual(Array.from(page.rows(), rowName), ['Fixture WhatsApp']);
  page.state.googleMessages = { ...gm, state: 'disconnected', rows: [] };
  page.findPill('All').onclick();
  assert.deepEqual(Array.from(page.rows(), rowName), ['Fixture structured', 'Fixture notice', 'Fixture WhatsApp'], 'phone mode lists them again');
});

test('not-dispatched on an RCS conversation never sends SMS without a notification offer; an SMS conversation falls back', async () => {
  for (const kind of ['rcs', 'sms']) {
    // The send is not dispatched and the same conversation is no longer writable.
    const page = gmPage(connected([{ id: 'paired', addrs: [gmDest], reply: true, kind, at: 1000 }]), {},
      (msg, state) => { state.googleMessages.rows[0].reply = false; return 'not-dispatched'; });
    page.received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [gmDest], at: 500 }] });
    page.rows()[0].onclick();
    await page.reply();
    assert.equal(page.gmSends().length, 1);
    assert.equal(page.gmSends()[0].allowCarrier, kind === 'sms');
    assert.equal(page.replies.length, 0);
    if (kind === 'rcs') {
      assert.equal(page.sms().length, 0, 'an RCS conversation is never sent by the carrier');
      assert.deepEqual(hints(page.chat), ['Google Messages is unavailable. Check the reply options and try again.']);
    } else {
      assert.equal(page.sms().length, 1, 'an SMS conversation falls back to the carrier');
      assert.equal(page.sms()[0].to, gmDest);
    }
  }
});

test('through an outage the row keeps its key, and a carrier send follows the last known kind until Google disconnects', async () => {
  for (const kind of ['rcs', 'sms']) {
    const page = gmPage(connected([{ id: 'paired', addrs: [gmDest], reply: true, kind, at: 1000 }]));
    page.received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [gmDest], at: 500 }] });
    page.rows()[0].onclick();
    page.state.googleMessages = { owner: gmPhone, state: 'offline', enabled: true, rows: [] };
    page.paint(page.state);
    assert.equal(page.rows().length, 1);
    assert.match(page.rows()[0].class, /active/, 'the same contact row stays selected');
    assert.equal(page.chat.children[1].hidden, false);
    await page.reply();
    assert.equal(page.sms().length, kind === 'sms' ? 1 : 0, `last known ${kind}`);
    assert.equal(page.composer.hidden, kind === 'rcs');
    if (kind === 'sms') continue;
    page.state.googleMessages = { owner: gmPhone, state: 'disconnected', enabled: true, rows: [] };
    page.paint(page.state);
    await page.reply();
    assert.equal(page.sms().length, 1, 'allowed once Google Messages is disconnected');
    page.state.googleMessages = { owner: gmPhone, state: 'offline', enabled: true, rows: [] };
    page.paint(page.state);
    await page.reply();
    assert.equal(page.sms().length, 2, 'disconnect forgets the last known kind');
    page.state.googleMessages = { owner: gmPhone, state: 'connecting', enabled: true, rows: [] };
    page.paint(page.state);
    await page.reply();
    assert.equal(page.sms().length, 2, 'never while Google Messages is connecting');
  }
});

test('a read-only Google row with a number never sends', async () => {
  const app = 'com.google.android.apps.messaging';
  const page = gmPage(connected([{ id: 'read-only', addrs: [gmDest], reply: false, kind: 'sms', at: 1000 }]), {
    notifs: { history: [{ id: 'n1', app, title: 'Fixture', body: 'Notice', at: 900, from: gmPhone, messagePhone: gmPhone,
      messagePeer: gmDest, reply: true, replySession: 's1' }] },
  });
  page.received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [gmDest], at: 500 }] });
  assert.equal(page.rows().length, 1);
  page.rows()[0].onclick();
  assert.equal(page.composer.hidden, true);
  assert.equal(page.chat.children[1].children[2].textContent, 'This conversation is read-only.');
  await page.reply();
  assert.equal(page.gmSends().length, 0);
  assert.equal(page.sms().length, 0);
  assert.equal(page.replies.length, 0);
});

test('a Google group shows its members and senders and never sends by the carrier', async () => {
  const members = ['+12025550101', '+12025550102'];
  const page = gmPage(connected([{ id: 'group', name: 'Fixture group', group: true, addrs: members, reply: true, kind: 'sms', at: 3000,
    people: [{ name: 'Fixture Ann', number: members[0] }, { name: 'Fixture Bob', number: members[1] }] }],
  { chat: 'group', loaded: true, items: [
    { id: 'm1', at: 1000, text: 'Hello', me: false, from: 'Fixture Ann' },
    { id: 'm2', at: 2000, text: 'Hi', me: false, from: 'Fixture Bob' },
  ] }), {}, (msg, state) => { state.googleMessages.rows[0].reply = false; return 'not-dispatched'; });
  page.received.get('sms.threads')({ items: [{ id: 'mms', group: true, addrs: members, at: 4000 }] });
  assert.equal(page.rows().length, 1, 'the phone MMS group is not listed');
  page.rows()[0].onclick();
  const title = page.chat.children[1].children[0].children[1];
  assert.equal(title.children[1].text, 'Fixture Ann, Fixture Bob');
  assert.deepEqual(bubbleWords(page.chat), [['Fixture Ann', 'Hello'], ['Fixture Bob', 'Hi']]);
  await page.reply();
  assert.equal(page.gmSends().length, 1);
  assert.equal(page.gmSends()[0].allowCarrier, false);
  assert.equal(page.sms().length, 0);
});

test('New message to a known Google one-to-one opens that row in All with the text, never a new send', async () => {
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
  const state = {
    ui: { chats: true },
    hub: { deviceId: gmPhone, session: 1, messages: true, perm: { messages: { mms: true } } },
    googleMessages: connected([{ id: 'paired', name: 'Fixture person', addrs: [gmDest], reply: true, kind: 'rcs', at: 1000 }]),
  };
  const { received, asked, paint, texts, chat, rows, findPill } = inbox(state, { googleMessages: async () => true }, { FileReader, Image, document });
  paint(state);
  received.get('sms.threads')({ nanp: true, items: [{ id: 'carrier', addrs: [gmDest], at: 500 }] });
  findPill('Texts').onclick();
  texts.children[0].children[0].children[1].onclick();
  const conv = texts.children[1];
  const to = conv.children[0].children[0];
  const compose = conv.children[3];
  const chip = compose.children[2].children[0];
  const box = compose.children[2].children[1];
  to.value = '(202) 555-0100';
  compose.children[4].files = [{ type: 'image/jpeg' }];
  compose.children[4].onchange();
  finish();
  await Promise.resolve();
  assert.equal(chip.hidden, false);
  box.value = 'Synthetic text';
  compose.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 0, 'not dispatched');
  assert.equal(findPill('All').attrs['aria-selected'], 'true');
  assert.equal(chat.hidden, false);
  assert.equal(chat.children[1].hidden, false);
  assert.match(rows()[0].class, /active/);
  assert.equal(chat.children[1].children[3].children[2].children[1].value, 'Synthetic text', 'the text moves to its composer');
  assert.equal(box.value, '');
  assert.equal(chip.hidden, true, 'the picture is cleared');

  // Another number is still a new carrier send.
  findPill('Texts').onclick();
  texts.children[0].children[0].children[1].onclick();
  to.value = '+12025550199';
  box.value = 'Other text';
  compose.children[3].onclick();
  assert.equal(asked.filter((m) => m.t === 'sms.send').length, 1);
});
