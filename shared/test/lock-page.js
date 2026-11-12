// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { execFileSync } = require('child_process');
const base = path.join(__dirname, '../../android/app/src/main/assets');
const source = fs.readFileSync(path.join(base, 'lock/lock.js'), 'utf8').replace(/^import .*;\n/gm, '');
function fixture() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', hidden: id === 'auth', textContent: '', events: {}, addEventListener(name, fn) { this.events[name] = fn; }, focus() { document.activeElement = this; }, setSelectionRange() {} });
        return elements.get(id);
    };
    const calls = { sent: [], ack: 0, close: 0, credentials: null, received: null, rfb: null, keys: [], authRequired: 0 };
    const document = { hidden: false, getElementById: element, addEventListener() {} };
    class RFB {
        constructor(target, channel) { this.channel = channel; this.events = {}; calls.rfb = this; channel.onmessage = e => { calls.received = [...new Uint8Array(e.data)]; }; }
        addEventListener(name, fn) { this.events[name] = fn; }
        sendCredentials(c) { calls.credentials = { ...c }; }
        disconnect() {}
        sendKey(key) { calls.keys.push(key); }
    }
    const context = { document, RFB, initLogging() {}, TextEncoder, Uint8Array, ArrayBuffer,
        LockBridge: { tr: s => s, pageId: () => 7, credentials: () => calls.authRequired++, ready() {}, keyboard() {}, send: s => calls.sent.push(s), ack: () => calls.ack++, close: () => calls.close++ },
        atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
        setTimeout: fn => fn(), console: new Proxy({}, { get: () => () => { throw Error('login page must not log'); } }) };
    context.window = { isSecureContext: true, crypto: { subtle: {} }, addEventListener() {} };
    vm.runInNewContext(source, context);
    return { calls, element, recv: m => context.window.lockRecv(m), keyboard: () => context.window.lockKeyboard(), submit: (page, name, secret) => context.window.lockCredentials(page, name, secret) };
}
async function main() {
    const f = fixture();
    f.recv({ t: 'open' });
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['username', 'password'] } });
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['username', 'password'] } });
    assert.equal(f.calls.authRequired, 1, 'fragmented authentication requests the native form once');
    assert.equal(f.calls.close, 0, 'fragmented authentication does not close the form');
    assert.equal(f.submit(6, 'test-user', 'test-only-secret'), false, 'old page generation cannot send credentials');
    assert.equal(f.calls.credentials, null);
    assert.equal(f.submit(7, 'test-user', 'test-only-secret'), true);
    assert.deepEqual(f.calls.credentials, { username: 'test-user', password: 'test-only-secret' });
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['username', 'password'] } });
    assert.equal(f.calls.close, 0, 'async duplicate does not cancel submitted credentials');
    f.calls.rfb.channel.send(Uint8Array.from([1, 2, 3]));
    assert.equal(f.calls.sent[0], 'AQID');
    f.recv({ t: 'bytes', data: 'BAUG' });
    assert.deepEqual(f.calls.received, [4, 5, 6]);
    assert.equal(f.calls.ack, 1);
    f.calls.rfb.events.connect();
    assert.equal(f.keyboard(), true);
    assert.equal(f.calls.rfb.focusOnClick, false);
    f.element('keyboard').value = '\u200bA';
    f.element('keyboard').events.input({ inputType: 'insertText', isComposing: false });
    f.element('keyboard').events.beforeinput({ inputType: 'deleteContentBackward', cancelable: true, preventDefault() {} });
    f.element('keyboard').events.beforeinput({ inputType: 'deleteContentBackward', cancelable: false });
    f.element('keyboard').events.input({ inputType: 'deleteContentBackward', isComposing: false });
    f.element('keyboard').events.keydown({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(f.calls.keys, [65, 0xff08, 0xff08, 0xff0d]);
    assert.equal(f.element('keyboard').value, '\u200b');
    gateFixture();
    await ardFixture();
    f.recv({ t: 'closed' });
    assert.match(f.element('status').textContent, /connection ended/);
}
// Run the actual vendored ARD negotiation methods against fragmented input and deferred crypto.
async function ardFixture() {
    const rfb = fs.readFileSync(path.join(base, 'novnc/core/rfb.js'), 'utf8');
    const sync = rfb.match(/    (_negotiateARDAuth\(\) \{[\s\S]*?)\n    async _negotiateARDAuthAsync/)[1].trim();
    const asyncBody = rfb.match(/    async (_negotiateARDAuthAsync\([\s\S]*?)\n    _negotiateTightUnixAuth/)[1].trim();
    let cryptoDone, prompts = 0, writes = 0, bytes = new Uint8Array(0), at = 0;
    const crypto = { generateKey: () => ({ publicKey: {}, privateKey: {} }), exportKey: () => new Uint8Array(2), deriveBits: () => new Uint8Array(2),
        digest: () => new Promise(resolve => { cryptoDone = resolve; }), importKey: async () => ({}), encrypt: async () => new Uint8Array(128) };
    const ctx = { _rfbCredentials: {}, _rfbConnectionState: 'connecting', dispatchEvent() { prompts++; }, _fail() { throw Error('ARD failed'); },
        _sock: { rQwait(_label, size, back = 0) { if (bytes.length - at >= size) return false; at -= back; return true; },
            rQshiftBytes(size) { const b = bytes.slice(at, at + size); at += size; return b; }, rQshift16() { const n = bytes[at] * 256 + bytes[at + 1]; at += 2; return n; },
            sQpushBytes() { writes++; }, flush() {} } };
    ctx._negotiateARDAuth = new Function('legacyCrypto', 'CustomEvent', 'return function ' + sync)(crypto, class { });
    ctx._negotiateARDAuthAsync = new Function('legacyCrypto', 'encodeUTF8', 'window', 'return async function ' + asyncBody)(crypto, s => s, { crypto: { getRandomValues: b => b } });
    ctx._resumeAuthentication = () => ctx._negotiateARDAuth();
    ctx._negotiateARDAuth(); ctx._negotiateARDAuth(); assert.equal(prompts, 2);
    ctx._rfbCredentials = { username: 'local-test', password: 'not-a-real-password' };
    bytes = Uint8Array.from([0, 2]); ctx._negotiateARDAuth(); assert.equal(ctx._ardInProgress, undefined);
    bytes = Uint8Array.from([0, 2, 0, 2, 0, 7]); ctx._negotiateARDAuth(); assert.equal(at, 0, 'incomplete DH packet rolls back');
    bytes = Uint8Array.from([0, 2, 0, 2, 0, 7, 0, 3]); ctx._negotiateARDAuth(); assert.equal(ctx._ardInProgress, true);
    assert.equal(ctx._rfbCredentials.password, undefined);
    ctx._negotiateARDAuth(); assert.equal(prompts, 2, 'no credential prompt during async crypto');
    cryptoDone(new Uint8Array(16)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 2); assert.equal(ctx._rfbInitState, 'SecurityResult'); assert.deepEqual(ctx._rfbCredentials, {});
}
function failure() {
    const rfb = fs.readFileSync(path.join(base, 'novnc/core/rfb.js'), 'utf8');
    const select = rfb.match(/_isSupportedSecurityType\(type\) \{([\s\S]*?)\n    \}/)[1];
    const supports = new Function('type', 'securityTypeARD', select);
    assert.equal(supports(30, 30), true);
    for (const type of [1, 2, 16, 19, 256]) assert.equal(supports(type, 30), false);
    const auth = rfb.match(/_negotiateAuthentication\(\) \{([\s\S]*?)\n        switch/)[1];
    const oldServerGuard = new Function('securityTypeARD', auth);
    assert.equal(oldServerGuard.call({ _rfbAuthScheme: 2, _fail: () => 'refused' }, 30), 'refused', 'old RFB cannot force shared-password auth');
    const f = fixture();
    f.recv({ t: 'open' });
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['username', 'password'] } });
    assert.equal(f.submit(7, 'test-user', 'é'.repeat(32)), false);
    assert.equal(f.calls.credentials, null);
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['password'] } });
    assert.equal(f.calls.close, 1);
    assert.equal(f.calls.credentials, null);
}
// Exercise the production gate with real reader threads: ACK and cancellation
// both unblock the reader without ever waiting on Android's main thread.
function gateFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-lock-read-'));
    try {
        const test = path.join(dir, 'LockReadGateFixture.java');
        fs.writeFileSync(test, `package com.twindesk.android;
import java.util.concurrent.*;
public final class LockReadGateFixture {
    public static void main(String[] args) throws Exception {
        ExecutorService io = Executors.newSingleThreadExecutor();
        try {
            LockReadGate gate = new LockReadGate();
            if (!gate.acquire()) throw new AssertionError("first chunk");
            Future<Boolean> next = io.submit(() -> gate.acquire());
            try { next.get(100, TimeUnit.MILLISECONDS); throw new AssertionError("reader did not apply backpressure"); }
            catch (TimeoutException expected) { }
            gate.ack();
            if (!next.get(1, TimeUnit.SECONDS)) throw new AssertionError("ACK did not release reader");
            Future<Boolean> cancelled = io.submit(() -> gate.acquire());
            try { cancelled.get(100, TimeUnit.MILLISECONDS); throw new AssertionError("second reader did not wait"); }
            catch (TimeoutException expected) { }
            gate.cancel();
            if (cancelled.get(1, TimeUnit.SECONDS)) throw new AssertionError("cancelled reader admitted data");
            if (gate.acquire()) throw new AssertionError("closed gate reopened");
        } finally { io.shutdownNow(); }
    }
}`);
        execFileSync('javac', ['-encoding', 'UTF-8', '-d', dir, path.join(base, '../java/com/twindesk/android/LockReadGate.java'), test], { stdio: 'pipe' });
        execFileSync('java', ['-cp', dir, 'com.twindesk.android.LockReadGateFixture'], { stdio: 'pipe', timeout: 10000 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().then(() => { failure(); console.log('lock-page: ok'); }).catch(error => { console.error(error); process.exitCode = 1; });
