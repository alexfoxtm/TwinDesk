// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/notifpop.js: a reused notification ID from another phone or offer cannot take over an open Reply draft.
'use strict';

const assert = require('assert');
const Module = require('module');

const handlers = {};
const windows = [];
class BrowserWindow {
  constructor() { this.webContents = { send() {}, focus() {} }; windows.push(this); }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} on() {} close() {} setBounds() {}
  showInactive() {} setFocusable() {} focus() {}
  isDestroyed() { return false; }
}
const electron = {
  ipcMain: { handle: (n, f) => { handlers[n] = f; }, on: (n, f) => { handlers[n] = f; } },
  BrowserWindow, nativeTheme: {}, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
const { NotifPop } = require('../notifpop.js');

const replies = [];
const pop = new NotifPop({ reply: (item, text) => replies.push({ item, text }) });
const from = (w) => ({ sender: w.webContents });
const a = { id: 'n1', app: 'com.whatsapp', title: 'Fixture', reply: true, from: 'phone-a', replySession: 'offer-a' };
const b = { ...a, from: 'phone-b', replySession: 'offer-b' };
const a2 = { ...a, replySession: 'offer-a2' };

pop.show(a);
assert.strictEqual(windows.length, 1);
handlers['notifpop:typing'](from(windows[0]));
pop.show(b);
assert.strictEqual(windows.length, 2, 'another phone opens its own window while a draft is open');
handlers['notifpop:typing'](from(windows[1]));
pop.show(a2);
assert.strictEqual(windows.length, 3, 'a new offer opens its own window while drafts are open');
handlers['notifpop:reply'](from(windows[0]), 'Synthetic draft');
assert.strictEqual(replies.length, 1);
assert.strictEqual(replies[0].item, a, 'the open draft keeps its own device, session and offer');
handlers['notifpop:reply'](from(windows[1]), 'Synthetic answer');
assert.strictEqual(replies[1].item, b);

// The same offer updated during a draft stays in its window; without a draft a reused ID updates in place.
handlers['notifpop:typing'](from(windows[2]));
pop.show({ ...a2, body: 'updated' });
assert.strictEqual(windows.length, 3);
handlers['notifpop:reply'](from(windows[2]), 'Synthetic third');
assert.strictEqual(replies[2].item.body, 'updated');
pop.show(b);
assert.strictEqual(windows.length, 4);
pop.show({ ...a });
assert.strictEqual(windows.length, 4, 'no draft: presentation updates in place');
pop.closeAll();
Module._load = load;
console.log('notifpop ok');
