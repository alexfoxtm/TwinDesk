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
    addEventListener(type, fn) { this.listeners = this.listeners || {}; (this.listeners[type] = this.listeners[type] || []).push(fn); },
    focus() {}, querySelectorAll() { return []; },
    setAttribute(key, value) { this.attrs[key] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
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
    async googleMessages(msg) {
      google.push(msg);
      // The helper dropped: the paired conversation is no longer available.
      if (result === 'not-dispatched') state.googleMessages = { owner: phone, enabled: true, state: 'offline', rows: [] };
      return result;
    },
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
  assert.deepEqual(bubbleTexts(chat), [['Shared text', 'Text']], 'no duplicated history');
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
      rows: [{ id: 'paired', addrs: [dest], reply: true, at: 100 }],
      history: { chat: 'paired', loaded: true, items: [] },
    },
  };
  const { received, asked, paint, chat, rows } = inbox(state, {
    googleMessages: async (msg) => msg.op === 'send' ? 'not-dispatched' : true,
  });
  paint(state);
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs: [dest], at: 50 }] });
  rows()[0].onclick();
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
