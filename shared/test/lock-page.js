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
    const calls = { sent: [], ack: 0, close: 0, credentials: null, received: null, rfb: null, keys: [] };
    const document = { hidden: false, getElementById: element, addEventListener() {} };
    class RFB {
        constructor(target, channel) { this.channel = channel; this.events = {}; calls.rfb = this; channel.onmessage = e => { calls.received = [...new Uint8Array(e.data)]; }; }
        addEventListener(name, fn) { this.events[name] = fn; }
        sendCredentials(c) { calls.credentials = { ...c }; }
        disconnect() {}
        sendKey(key) { calls.keys.push(key); }
    }
    const context = { document, RFB, initLogging() {}, TextEncoder, Uint8Array, ArrayBuffer,
        LockBridge: { tr: s => s, ready() {}, send: s => calls.sent.push(s), ack: () => calls.ack++, close: () => calls.close++ },
        atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
        setTimeout: fn => fn(), console: new Proxy({}, { get: () => () => { throw Error('login page must not log'); } }) };
    context.window = { isSecureContext: true, crypto: { subtle: {} }, addEventListener() {} };
    vm.runInNewContext(source, context);
    return { calls, element, recv: m => context.window.lockRecv(m), keyboard: () => context.window.lockKeyboard() };
}
function main() {
    const f = fixture();
    f.recv({ t: 'open' });
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['username', 'password'] } });
    assert.equal(f.element('auth').hidden, false);
    f.element('username').value = 'test-user';
    f.element('password').value = 'test-only-secret';
    f.element('auth').events.submit({ preventDefault() {} });
    assert.deepEqual(f.calls.credentials, { username: 'test-user', password: 'test-only-secret' });
    assert.equal(f.element('password').value, '');
    assert.equal(f.element('username').value, '');
    assert.equal(f.element('auth').hidden, true);
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
    f.recv({ t: 'closed' });
    assert.match(f.element('status').textContent, /connection ended/);
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
    f.element('username').value = 'test-user';
    f.element('password').value = 'é'.repeat(32);
    f.element('auth').events.submit({ preventDefault() {} });
    assert.equal(f.calls.credentials, null);
    assert.equal(f.element('auth').hidden, false);
    assert.match(f.element('auth-error').textContent, /exceeds 63 UTF-8 bytes/);
    f.calls.rfb.events.credentialsrequired({ detail: { types: ['password'] } });
    assert.equal(f.calls.close, 1);
    assert.equal(f.calls.credentials, null);
    assert.equal(f.element('password').value, '');
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
main(); failure();
console.log('lock-page: ok');
