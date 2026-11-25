// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../ui-messages.js'), 'utf8');

test('Messages opens on All for recent notification chats and keeps the carrier route under Texts', () => {
  const received = new Map();
  const asked = [];
  const replies = [];
  const el = (tag, props = {}, children = []) => ({
    tag, ...props, children: children.filter(Boolean), attrs: { ...props.attrs },
    style: {}, classList: { add() {}, toggle() {} },
    addEventListener() {}, focus() {},
    setAttribute(key, value) { this.attrs[key] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  const state = {
    ui: { chats: true },
    hub: { messages: true, perm: { messages: { mms: true } } },
    notifs: { history: [{ app: 'com.google.android.apps.messaging', at: 3000, title: 'Summary fixture' }] },
    chats: null,
  };
  let tab;
  const UI = {
    el, state, api: { setChats() {}, notifReply: (msg) => replies.push(msg) },
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
  vm.runInNewContext(source, { UI, window: {}, localStorage: { getItem() {} } });
  const body = el('section');
  const paint = tab.build(body, {});
  const [, pills, , texts, chat] = body.children;
  const findPill = (label) => pills.children.find((b) => b.text === label);
  const rows = () => chat.children[0].children[1].children;
  const snippet = (row) => row.children[1].children[1].text;
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
  const replyBox = composer.children[1].children[1];
  assert.equal(composer.hidden, false);
  replyBox.value = 'Fixture reply';
  composer.children[2].onclick();
  assert.equal(replies[0].chat, 'fixture-chat');
  assert.equal(replies[0].text, 'Fixture reply');
  state.chats[0].reply = false;
  paint(state);
  assert.equal(composer.hidden, true);
  replyBox.value = 'Expired reply';
  composer.children[2].onclick();
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

  const at = 7000;
  const addrs = ['2025550100'];
  state.chatsMessaging = false;
  state.notifs.history = [
    { app: 'com.google.android.apps.messaging', at, title: 'Matched fixture', body: 'Fixture body' },
    { app: 'com.google.android.apps.messaging', at, title: 'Distinct fixture', body: 'Other fixture' },
  ];
  state.chats = [
    { app: 'com.google.android.apps.messaging', key: 'structured', name: 'Matched fixture', at,
      items: [{ id: 'structured-item', at, text: 'Fixture body', match: 'synthetic-fingerprint' }] },
  ];
  state.googleMessages = {
    owner: 'paired-fixture', state: 'connected',
    rows: [{ id: 'paired', name: 'Matched fixture', addrs: ['+12025550100'], at, snippet: 'Fixture body',
      fingerprints: [{ at, matches: ['synthetic-fingerprint'] }] }],
  };
  received.get('sms.threads')({ items: [{ id: 'carrier', addrs, at, snippet: 'Fixture body' }] });
  findPill('All').onclick();
  assert.equal(rows().length, 2, 'paired, SMS and both fallback sources fold into the paired and distinct rows');
  state.googleMessages = { owner: 'paired-fixture', state: 'offline', rows: [] };
  paint(state);
  assert.equal(rows().length, 4, 'failed helper restores all phone sources');
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
  vm.runInNewContext(source, { UI, window: {}, localStorage: { getItem() {} } });
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
