// Mesh clipboard on the Mac: a read that started before an incoming clip, or before a peer
// session changed, must not publish. Run: node shared/test/mac-mesh-clipboard.js
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../protocol.js');
const { Mesh } = require('../mesh.js');

const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { clipboard: {}, nativeImage: { createFromBuffer() { return { isEmpty: () => true }; } } };
  return load.call(this, id, ...args);
};
const { Clip } = require('../../mac/mesh/clipboard.js');

function setup() {
  const published = [];
  const mesh = new Mesh({ selfId: 'mac' });
  mesh.addPeer({ id: 'peer', name: 'Phone', mesh: true, send: (msg) => { published.push(msg); return true; } });
  const peers = { welcome: [], closed: [] };
  let ids = ['peer'];
  const bus = {
    on() {},
    onPeer(event, fn) { peers[event].push(fn); },
    send() { return true; },
    connectedIds() { return ids.slice(); },
    selectedId() { return ids[0] || null; },
    peer(event, id) { for (const fn of peers[event]) fn(id); },
    setIds(next) { ids = next.slice(); },
  };
  const clipboard = {
    text: '',
    writes: [],
    readText() { return clipboard.text; },
    writeText(value) { clipboard.text = String(value); clipboard.writes.push(clipboard.text); },
  };
  const helper = Object.assign(new EventEmitter(), {
    running: true,
    send() {},
    request: async () => ({ concealed: false }),
  });
  const settings = { clipboard: { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 20 } };
  const clip = new Clip({ bus, mesh, getSettings: () => settings, clipboard, helper });
  const texts = () => published.filter((m) => m.t === P.T.CLIP).map((m) => m.text);
  return { clip, clipboard, helper, bus, texts, settings };
}

(async () => {
  {
    const { clip, clipboard, texts } = setup();
    clipboard.text = 'A';
    await clip.sendIfChanged('instant');
    await clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
    assert.equal(clipboard.text, 'B');
    assert.equal(clip.lastSync.sent, null, 'an incoming clip clears what was sent');
    assert.equal(clip.lastSync.received, 'B');
    await clip.sendIfChanged('instant');
    assert.deepEqual(texts(), ['A'], 'the text just received is not sent back');
    clipboard.text = 'A';
    await clip.sendIfChanged('instant');
    assert.deepEqual(texts(), ['A', 'A'], 'the same text copied again after an incoming clip is sent again');
  }

  {
    const { clip, clipboard, texts } = setup();
    clipboard.text = 'A';
    await clip.sendIfChanged('instant');
    const reads = [];
    clip._readText = () => new Promise((resolve) => reads.push(resolve));
    const pending = clip.sendIfChanged('instant');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads.length, 1);
    const incoming = clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads.length, 2);
    reads[1]('A');
    await incoming;
    assert.equal(clipboard.text, 'B');
    assert.equal(clip.lastSync.sent, null);
    assert.equal(clip.lastSync.received, 'B');
    reads[0]('A');
    await pending;
    assert.deepEqual(texts(), ['A'], 'a stale read of A does not publish after B clears the sent marker');
    clip._readText = async () => clipboard.text;
    clipboard.text = 'A';
    await clip.sendIfChanged('instant');
    assert.deepEqual(texts(), ['A', 'A'], 'fencing the stale read still lets the next copy of A through');
  }

  {
    const { clip, clipboard, helper, texts } = setup();
    clipboard.text = 'A';
    let release;
    let entered;
    const atHelper = new Promise((resolve) => { entered = resolve; });
    helper.request = () => new Promise((resolve) => { release = resolve; entered(); });
    const pending = clip.sendIfChanged('request');
    await atHelper;
    await clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
    release({ concealed: false });
    await pending;
    assert.deepEqual(texts(), [], 'a read that already passed the sent check does not publish after B arrives');
    assert.equal(clipboard.text, 'B');
    assert.equal(clip.lastSync.sent, null);
    clipboard.text = 'A';
    helper.request = async () => ({ concealed: false });
    await clip.sendIfChanged('request');
    assert.deepEqual(texts(), ['A'], 'the next copy of A still sends');
  }

  {
    const { clip, clipboard, bus, texts } = setup();
    clipboard.text = 'A';
    const reads = [];
    clip._readText = () => new Promise((resolve) => reads.push(resolve));
    const pending = clip.sendIfChanged('instant');
    await new Promise((resolve) => setImmediate(resolve));
    bus.peer('welcome', 'peer');
    reads[0]('A');
    await pending;
    assert.deepEqual(texts(), [], 'a read started before the session changed does not publish');
    clip._readText = async () => clipboard.text;
    await clip.sendIfChanged('instant');
    assert.deepEqual(texts(), ['A'], 'the next read in the new session publishes');
    await clip._onClip({ t: P.T.CLIP, text: 'B' }, 'peer');
    bus.peer('closed', 'peer');
    bus.setIds(['peer']);
    clipboard.text = 'B';
    await clip.sendIfChanged('instant');
    assert.deepEqual(texts(), ['A'], 'a session change does not echo the text just received');
    clipboard.text = 'A';
    await clip.sendIfChanged('instant');
    assert.deepEqual(texts(), ['A', 'A'], 'a repeated copy still sends after the session change');
  }

  console.log('mac-mesh-clipboard: repeat, no echo, stale read and session fence pass');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { Module._load = load; });
