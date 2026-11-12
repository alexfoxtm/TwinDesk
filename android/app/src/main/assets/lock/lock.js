// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import RFB from '../novnc/core/rfb.js';
import { initLogging } from '../novnc/core/util/logging.js';
initLogging('none');
const t = text => LockBridge.tr(text);
const status = document.getElementById('status');
const form = document.getElementById('auth');
const username = document.getElementById('username');
const password = document.getElementById('password');
const keyboard = document.getElementById('keyboard');
const authError = document.getElementById('auth-error');
document.getElementById('username-label').textContent = t('Mac account name');
document.getElementById('password-label').textContent = t('Mac account password');
document.getElementById('signin').textContent = t('Sign in');
status.textContent = t('Connecting to the Mac login screen…');
let rfb = null;
let channel = null;
let ended = false;
let asked = false;
let connected = false;
const clearCredentials = () => { username.value = ''; password.value = ''; keyboard.value = ''; authError.textContent = ''; };
function close() {
    if (ended) return;
    ended = true;
    clearCredentials();
    form.hidden = true;
    if (rfb) rfb.disconnect();
    if (channel) { channel.readyState = 3; channel.onclose({ code: 1000, reason: '', wasClean: true }); }
    rfb = null;
    channel = null;
    status.textContent = t('Login-screen connection ended. Close this view and try again.');
}
function fail() { close(); LockBridge.close(); }
function makeChannel() {
    return { readyState: 0, protocol: 'binary', binaryType: 'arraybuffer',
        onopen() {}, onmessage() {}, onerror() {}, onclose() {},
        send(data) {
            if (ended || this.readyState !== 1) return;
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            for (let at = 0; at < bytes.length; at += 49152) {
                let binary = '';
                const chunk = bytes.subarray(at, at + 49152);
                for (const byte of chunk) binary += String.fromCharCode(byte);
                LockBridge.send(btoa(binary));
            }
        },
        close() { this.readyState = 3; clearCredentials(); LockBridge.close(); }
    };
}
window.lockRecv = message => {
    if (ended) return;
    if (message.t === 'open') {
        if (channel) return fail();
        if (!window.isSecureContext || !window.crypto?.subtle) return fail();
        channel = makeChannel();
        try { rfb = new RFB(document.getElementById('screen'), channel, { shared: true }); }
        catch (_) { return fail(); }
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = true;
        rfb.focusOnClick = true;
        rfb.addEventListener('credentialsrequired', event => {
            const types = event.detail?.types;
            if (!Array.isArray(types) || types.length !== 2 || !types.includes('username') || !types.includes('password')) return fail();
            if (asked) return;
            asked = true;
            status.textContent = '';
            form.hidden = false;
            username.focus();
        });
        rfb.addEventListener('securityfailure', fail);
        rfb.addEventListener('disconnect', close);
        rfb.addEventListener('connect', () => { connected = true; clearCredentials(); form.hidden = true; status.textContent = ''; LockBridge.keyboard(); });
        channel.readyState = 1;
        channel.onopen({});
    } else if (message.t === 'bytes') {
        if (!channel || channel.readyState !== 1 || typeof message.data !== 'string' || message.data.length > 90000) return fail();
        try {
            const raw = atob(message.data);
            const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
            channel.onmessage({ data: bytes.buffer });
        } catch (_) { return fail(); }
        LockBridge.ack();
    } else if (message.t === 'closed') close();
};
form.addEventListener('submit', event => {
    event.preventDefault();
    if (ended || !rfb || !asked || form.hidden) return;
    // ARD limits each UTF-8 field to 63 bytes. Refuse truncation rather than change a password.
    if (new TextEncoder().encode(username.value).length > 63 || new TextEncoder().encode(password.value).length > 63) {
        authError.textContent = t('Screen Sharing cannot use this account name or password because it exceeds 63 UTF-8 bytes.');
        return;
    }
    rfb.sendCredentials({ username: username.value, password: password.value });
    clearCredentials();
    form.hidden = true;
    status.textContent = t('Signing in to Screen Sharing…');
});
const resetKeyboard = () => { keyboard.value = '\u200b'; keyboard.setSelectionRange(1, 1); };
window.lockKeyboard = () => {
    if (ended || !rfb) return false;
    if (!form.hidden) {
        const field = document.activeElement;
        (field === username || field === password ? field : username).focus();
    } else if (connected) {
        // Keep a canvas tap from taking focus away from the private IME field.
        rfb.focusOnClick = false;
        resetKeyboard();
        keyboard.focus();
    } else return false;
    return true;
};
function typeKeyboard() {
    if (ended || !rfb) return;
    for (const char of keyboard.value.replaceAll('\u200b', '')) {
        const cp = char.codePointAt(0);
        rfb.sendKey(cp < 256 ? cp : 0x01000000 + cp);
    }
    resetKeyboard();
}
keyboard.addEventListener('beforeinput', event => {
    if (ended || !rfb) return;
    if (event.cancelable !== false && (event.inputType === 'deleteContentBackward' || event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph')) {
        event.preventDefault();
        rfb.sendKey(event.inputType === 'deleteContentBackward' ? 0xff08 : 0xff0d);
        resetKeyboard();
    }
});
keyboard.addEventListener('compositionend', typeKeyboard);
keyboard.addEventListener('input', event => {
    if (event.isComposing || ended || !rfb) return;
    // Some IMEs issue a non-cancellable beforeinput. Its input event is authoritative.
    if (event.inputType === 'deleteContentBackward' || event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        rfb.sendKey(event.inputType === 'deleteContentBackward' ? 0xff08 : 0xff0d);
        resetKeyboard();
    } else typeKeyboard();
});
keyboard.addEventListener('keydown', event => {
    if (ended || !rfb) return;
    const keys = { Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54 };
    if (keys[event.key]) { event.preventDefault(); rfb.sendKey(keys[event.key]); resetKeyboard(); }
});
window.lockClose = close;
document.getElementById('screen').addEventListener('pointerup', () => { if (connected && !ended) LockBridge.keyboard(); });
window.addEventListener('pagehide', close);
document.addEventListener('visibilitychange', () => { if (document.hidden) fail(); });
LockBridge.ready();
