// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { startXCTest, RUNNER_ID, WdaInputRejected } = require('./iosctl-xctest');

const owners = new Map();
const MAX_QUEUE = 12;
const MAX_POINTS = 24;
const MAX_PASTE_BYTES = 16 * 1024;
const KEYBOARD_INPUT = '/wda/element/0/keyboardInput';
const COMMAND_FLAG = 1 << 4; // XCUIKeyModifierCommand
const SHIFT_FLAG = 1 << 1;
const EDITING_COMMANDS = new Set(['a', 'c', 'v', 'x', 'z']);
const START_MS = 60000;
const SPECIAL_KEYS = new Map(Object.entries({
  Backspace: 'Delete', Delete: 'ForwardDelete', Enter: 'Return', Tab: 'Tab', Escape: 'Escape', ' ': 'Space',
  ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
}));

function videoPoint(p, rect) {
  if (!p || !rect || ![p.x, p.y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) return null;
  const x = (p.x - rect.left) / rect.width;
  const y = (p.y - rect.top) / rect.height;
  return x >= 0 && x < 1 && y >= 0 && y < 1 ? { x, y } : null;
}

function fullDisplay(frame, source, window) {
  if (!frame || !source || !window || window.x !== 0 || window.y !== 0) return false;
  const sides = [frame.width, frame.height, source.w, source.h, window.width, window.height];
  if (!sides.every((v) => Number.isFinite(v) && v > 0 && v < 16384)) return false;
  // ReplayKit rotates pixels upright before downscaling. Compare both axes against the
  // announced capture pixels and against XCTest points. Split-view/rotation mismatches fail closed.
  const sameAspect = (w, h) => Math.abs((w / h) / (source.w / source.h) - 1) < 0.025;
  return sameAspect(frame.width, frame.height) && sameAspect(window.width, window.height);
}

const pointInWindow = (p, win) => ({
  x: Math.min(Math.ceil(win.width) - 1, Math.round(p.x * win.width)),
  y: Math.min(Math.ceil(win.height) - 1, Math.round(p.y * win.height)),
});

function actionsFor(points, window, duration, hold) {
  const move = (p, ms) => ({ type: 'pointerMove', origin: 'viewport', duration: ms, ...pointInWindow(p, window) });
  const steps = [move(points[0], 0), { type: 'pointerDown', button: 0 }];
  if (hold) steps.push({ type: 'pause', duration: hold });
  let offset = 0;
  for (let i = 1; i < points.length; i++) {
    const next = Math.round(duration * i / (points.length - 1));
    steps.push(move(points[i], next - offset));
    offset = next;
  }
  steps.push({ type: 'pointerUp', button: 0 });
  return { actions: [{ id: 'finger', type: 'pointer', parameters: { pointerType: 'touch' }, actions: steps }] };
}

function keyboardInput(key, modifierFlags = 0) {
  return [KEYBOARD_INPUT, { keys: [modifierFlags ? { key, modifierFlags } : key] }];
}

function shortcutKey(m) {
  if (m.code === 'Space') return ' ';
  return typeof m.code === 'string' && /^Key[A-Z]$/.test(m.code) ? m.code[3].toLowerCase() : m.key.toLowerCase();
}

function keyCommand(m, hardwareKeys) {
  const key = m.key;
  if (m.down !== true || m.composing || m.ctrl || typeof key !== 'string') return null;
  if (m.meta) {
    if (m.alt) return null;
    const lower = shortcutKey(m);
    if (lower === 'h' && !m.shift) return ['/wda/pressButton', { name: 'home' }];
    if (!hardwareKeys) return null;
    if (lower === ' ' && !m.shift) return keyboardInput('XCUIKeyboardKeySpace', COMMAND_FLAG);
    if (EDITING_COMMANDS.has(lower) && (!m.shift || lower === 'z' || lower === 'v')) {
      return keyboardInput(lower, COMMAND_FLAG | (m.shift && lower === 'z' ? SHIFT_FLAG : 0));
    }
    return null;
  }
  const special = SPECIAL_KEYS.get(key);
  if (special && !m.alt && hardwareKeys) return keyboardInput(`XCUIKeyboardKey${special}`, m.shift ? SHIFT_FLAG : 0);
  if (Array.from(key).length === 1 && !/\p{Cc}/u.test(key)) return ['/wda/keys', { value: [key] }];
  return null;
}

class IpadControl {
  constructor({ udid, owns, canInput = () => true, status, log = console.log, start = startXCTest, template }) {
    Object.assign(this, { udid, owns, canInput, status, log, start, template });
    this.abort = new AbortController();
    this.queue = [];
    this.inputEpoch = 0;
    this.hardwareKeys = false;
  }

  async connect() {
    if (!this.owns() || this.abort.signal.aborted || owners.has(this.udid)) throw new Error('busy');
    owners.set(this.udid, this);
    this.finished = new Promise((resolve) => { this.finish = resolve; });
    const deadline = AbortSignal.any([this.abort.signal, AbortSignal.timeout(START_MS)]);
    let code = 'startup';
    try {
      this.transport = await this.start(this.udid, deadline, this.template);
      this.transport.exited.then(() => { if (!this.abort.signal.aborted) this.stop(this.session ? 'lost' : 'startup'); });
      let verified = false;
      while (this.owns() && !deadline.aborted) {
        const r = await this.transport.request('GET', '/status', undefined, deadline, 1200).catch((error) => {
          if (error.message === 'route') throw error;
          return null; // The signed runner may still be starting on this route.
        });
        if (r && (r.value?.device !== 'ipad' || r.value?.build?.productBundleIdentifier !== RUNNER_ID ||
          r.value?.build?.upgradedAt !== this.transport.marker || r.sessionId != null)) {
          code = 'endpoint';
          throw new Error(code);
        }
        if (r?.value?.ready === true) {
          const version = r.value.os?.version;
          this.hardwareKeys = typeof version === 'string' && Number.parseInt(version, 10) >= 17;
          verified = true;
          break;
        }
        await delay(300, undefined, { signal: deadline });
      }
      if (!verified || !this.owns()) throw new Error(code);
      this.transport.seal();
      this.transport.lost.addEventListener('abort', () => this.stop('lost'), { once: true });
      if (this.transport.lost.aborted) throw new Error(code);
      this.verified = true;
      deadline.throwIfAborted();
      const r = await this.transport.request('POST', '/session', { capabilities: { alwaysMatch: {
        platformName: 'iOS', 'appium:shouldTerminateApp': false, 'appium:disableAutomaticScreenshots': true,
        'appium:waitForIdleTimeout': 0,
      }, firstMatch: [{}] } }, deadline, 8000);
      const id = r.value?.sessionId;
      if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || !this.owns()) throw new Error(code);
      deadline.throwIfAborted();
      const session = `/session/${id}`;
      const settings = await this.transport.request('POST', `${session}/appium/settings`, {
        settings: { animationCoolOffTimeout: 0 },
      }, deadline);
      if (settings.value?.animationCoolOffTimeout !== 0 || !this.owns()) throw new Error(code);
      deadline.throwIfAborted();
      this.session = session;
      this.status('connected');
      this.heartbeat = setInterval(() => this.enqueue('heartbeat', () => this.send('GET', '')), 3000);
    } catch (error) {
      if (['setup', 'device', 'developerMode', 'route'].includes(error.message)) code = error.message;
      await this.stop(this.abort.signal.aborted ? undefined : code);
    } finally {
      // A window can stop while the async launcher is still unwinding.
      if (this.abort.signal.aborted && owners.get(this.udid) === this) {
        await this.stopping;
        if (owners.get(this.udid) === this) {
          await this.transport?.stop();
          this.release();
        }
      }
    }
  }

  send(method, route, body) {
    this.abort.signal.throwIfAborted();
    if (!this.owns()) throw new Error('owner');
    return this.transport.request(method, this.session + route, body, this.abort.signal);
  }

  clearInput() {
    this.inputEpoch++;
    this.queue.length = 0;
  }

  input(m, geometry, readPasteboard) {
    if (!this.session || !this.owns() || !this.canInput() || this.abort.signal.aborted) return false;
    if (m.op === 'cancel') return this.clearInput();
    const epoch = this.inputEpoch;
    const active = () => epoch === this.inputEpoch && this.canInput() && this.owns() && !this.abort.signal.aborted;
    const key = m.op === 'key' && keyCommand(m, this.hardwareKeys);
    if (key) {
      const paste = m.meta && m.shift && shortcutKey(m) === 'v';
      if (paste && !readPasteboard) return false;
      if (m.meta && m.repeat) return true;
      let text;
      if (paste) {
        try { text = readPasteboard(); } catch { return true; }
        if (typeof text !== 'string' || !text || !active()) return true;
        if (Buffer.byteLength(text, 'utf8') > MAX_PASTE_BYTES) {
          this.status('pasteTooLarge');
          return true;
        }
      }
      this.enqueue(paste ? 'paste' : 'key', async () => {
        if (!active()) return;
        if (paste) {
          await this.send('POST', '/wda/setPasteboard', {
            contentType: 'plaintext', content: Buffer.from(text, 'utf8').toString('base64'),
          });
        }
        if (active()) return this.send('POST', ...key);
      });
      return true;
    }
    if (m.op === 'spotlight' && !this.hardwareKeys) return false;
    if (m.op === 'spotlight') return this.enqueue('spotlight', () => {
      if (active()) return this.send('POST', ...keyboardInput('XCUIKeyboardKeySpace', COMMAND_FLAG));
    });
    if (m.op === 'home' || m.op === 'volumeUp' || m.op === 'volumeDown') {
      return this.enqueue(m.op, () => {
        if (active()) return this.send('POST', '/wda/pressButton', { name: m.op });
      });
    }
    if (!['gesture', 'doubleTap', 'longPress', 'scroll'].includes(m.op)) return false;
    const { frame, source } = geometry();
    if (!frame || !source || m.width !== frame.width || m.height !== frame.height) return;
    const scroll = m.op === 'scroll';
    if (scroll && ![m.dx, m.dy].every(Number.isFinite)) return;
    if (!Array.isArray(m.points) || m.points.length < 1 || m.points.length > MAX_POINTS
        || (m.op !== 'gesture' && m.points.length !== 1)) return;
    const points = m.points.map((p) => videoPoint(p, m.rect));
    if (points.some((p) => !p)) return;
    if (scroll) {
      const [p] = points;
      const step = (d, at) => Math.max(0.001, Math.min(0.999, at - Math.max(-0.35, Math.min(0.35, d / 500))));
      const to = { x: step(m.dx, p.x), y: step(m.dy, p.y) };
      if (Math.hypot(to.x - p.x, to.y - p.y) < 0.01) return;
      points.push(to);
    }
    const ms = scroll ? 130 : Math.min(650, Math.max(55, Number.isFinite(m.duration) ? m.duration : 55));
    const hold = m.op === 'longPress' || (!scroll && points.length === 1 && ms >= 480) ? 520 : 0;
    let kind = 'tap';
    if (scroll) kind = 'scroll';
    else if (m.op === 'doubleTap') kind = 'double-tap';
    else if (hold) kind = 'long-press';
    else if (points.length > 1) kind = 'drag';
    this.enqueue(kind, async () => {
      if (!active() || geometry().frame !== frame || geometry().source !== source) return;
      const { value: window } = await this.send('GET', '/window/rect');
      if (!active() || geometry().frame !== frame || geometry().source !== source || !fullDisplay(frame, source, window)) return;
      if (m.op === 'doubleTap') return this.send('POST', '/wda/doubleTap', pointInWindow(points[0], window));
      return this.send('POST', '/actions', actionsFor(points, window, ms, hold));
    });
  }

  enqueue(kind, run) {
    if (this.abort.signal.aborted) return;
    if (kind === 'heartbeat' && (this.running || this.queue.length)) return;
    if (kind === 'scroll' && this.queue.at(-1)?.kind === 'scroll') this.queue.pop();
    if (this.queue.length >= MAX_QUEUE) return;
    const item = { kind, run, queued: performance.now() };
    this.queue.push(item);
    void this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let item; (item = this.queue.shift()) && !this.abort.signal.aborted;) {
        if (!this.owns()) { void this.stop('lost'); break; }
        if (item.kind !== 'heartbeat' && !this.canInput()) continue;
        if (performance.now() - item.queued > 1600) continue;
        const began = performance.now();
        let result;
        try { result = await item.run(); }
        catch (error) {
          if (!(error instanceof WdaInputRejected) || item.kind === 'heartbeat') throw error;
          if (!this.abort.signal.aborted) this.log(`[ipad control] ${item.kind} rejected ${error.code}`);
          continue;
        }
        if (result && !this.abort.signal.aborted && item.kind !== 'heartbeat') {
          this.log(`[ipad control] ${item.kind} ${Math.round(performance.now() - began)}ms`);
        }
      }
    } catch {
      if (!this.abort.signal.aborted) void this.stop('lost');
    } finally {
      this.running = false;
    }
  }

  stop(reason = 'off', immediate = false) {
    if (this.stopping) {
      if (immediate) void this.transport?.stop();
      return this.stopping;
    }
    this.abort.abort();
    clearInterval(this.heartbeat);
    this.clearInput();
    this.session = null;
    this.stopping = (async () => {
      const transport = this.transport;
      if (!transport) return; // connect's finally releases the reservation
      try {
        if (this.verified && !immediate && !transport.lost.aborted) {
          await transport.request('GET', '/wda/shutdown', undefined, AbortSignal.timeout(650), 650);
        }
      } catch { /* xcodebuild owns the runner even when its connection has gone away */ }
      finally {
        await transport.stop();
        this.release();
      }
    })();
    this.status(reason);
    this.log(`[ipad control] ${reason}`);
    return this.stopping;
  }

  release() {
    if (owners.get(this.udid) === this) owners.delete(this.udid);
    this.finish?.();
  }
}

function stopAllIPadControl() {
  if (!owners.size) return null;
  return Promise.allSettled([...owners.values()].map((controller) => {
    void controller.stop('off', true);
    return controller.finished;
  }));
}

module.exports = { IpadControl, stopAllIPadControl, videoPoint, fullDisplay, pointInWindow };
