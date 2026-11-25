// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Share this Mac's screen to several devices at once (docs/screen-mesh.md). Every connected device gets a
// Stream of its own (stream.js) on a peer bound to that device, so each target has its own WebRTC
// session, policy and display. A target follows the shared settings (`sharing.on`, `sharing.displayId`,
// the virtual display) until it is given a choice of its own: none, mirror of a display, or the
// virtual display. The stream table (shared/screen-mesh.js) checks the choices against this Mac's displays.
//
// This object is also the single-stream API the rest of the app grew up with (`stream`): restart(),
// stop(), `view` and `audio` are the ACTIVE target's (the selected device), so with one device
// everything behaves as before. restart() and stop() reach every target.
//
// Events: 'change'.
'use strict';

const { EventEmitter } = require('events');
const S = require('../../shared/screen-mesh.js');
const P = require('../../shared/protocol.js');
const { IN_TYPES } = require('../input.js');
const { ScopedPhonePeer: ScopedPeer } = require('./phones.js');

class StreamSet extends EventEmitter {
  // hub: hub.js; server: the Server; make(peer) -> Stream; displays: Displays (model()).
  constructor({ hub, server, make, displays, input, swapKeys }) {
    super();
    Object.assign(this, { hub, server, make, displays, input, swapKeys });
    this.byId = new Map();
    this.all = [];
    this.table = {};
    this.inputEpoch = 0;
    this.inputOwner = null;
    this.inputLocked = false;
    this.first = this._create();
    hub.bus.onPeer('welcome', (id) => this._ensure(id));
    hub.bus.onPeer('closed', (id) => this._gone(id));
    for (const s of hub.sessions.list()) if (s.connected) this._ensure(s.id);
    // Publish after the hub settles selection, including a pending user Connect.
    hub.on('change', () => this.syncScopedScreens());
    if (input) {
      for (const type of IN_TYPES) hub.bus.on(type, (m, id, source, ws) => this._onInput(m, id, source, ws));
      hub.bus.on(P.T.CLIP_REQUEST, (_m, id, source, ws) => {
        const owner = this.inputOwner;
        if (owner && owner.stream.peer.id === id && owner.grant.socket === ws && source?.ws === ws &&
            this.hub.sessions.get(id)?.inbound() === source) {
          this._releaseInput();
        }
      });
      input.helper.on('event', (ev, { epoch } = {}) => {
        if (ev !== 'screenInputLocal' || !Number.isSafeInteger(epoch)) return;
        if (this.inputOwner?.grant.inputEpoch <= epoch) this._releaseInput();
        for (const st of this.all) {
          if (st.inputGrant?.inputEpoch <= epoch) st.inputGrant = null;
        }
        this.syncScopedScreens();
      });
    }
    this.syncScopedScreens();
  }

  _create() {
    const peer = new ScopedPeer(this.hub, this.server, null);
    const st = this.make(peer);
    st.peer = peer;
    st.audioOk = () => st === this.active;
    st.on('change', () => {
      const input = this._syncScreenInput(st);
      if (st.scopedScreen) st.syncScopedScreen(false, input);
      this.emit('change');
    });
    this.all.push(st);
    return st;
  }

  _ensure(id) {
    if (this.byId.has(id)) return;
    const st = this.first.peer.id === null ? this.first : this._create();
    st.peer.bind(id);
    this.byId.set(id, st);
    this.emit('change');
  }

  _gone(id) {
    delete this.table[id];
    this.emit('change');
  }

  _syncScopedScreen(st) {
    const selected = this.hub.selectedId;
    const input = this._syncScreenInput(st);
    st.syncScopedScreen?.(selected !== null && selected !== st.peer.id, input);
  }

  _syncScreenInput(st) {
    if (!this.input) return false;
    const c = st.peer.current;
    const ios = c?.os === P.OS.IOS;
    const epochRequired = ios && st.viewerUsesInputEpoch === true;
    const allowed = !this.inputLocked && this.input.enabled() && (epochRequired || c?.deviceId === this.hub.selectedId);
    const target = allowed ? st.inputTarget() : null;
    const bounds = target?.bounds;
    const mapping = bounds ? [target.id, bounds.x, bounds.y, bounds.width, bounds.height].join(':') : null;
    const old = st.inputGrant;
    if (!mapping || old?.socket !== c?.conn || old.session !== st.session || old.mapping !== mapping || old.epochRequired !== epochRequired) {
      if (this.inputOwner?.stream === st) this._releaseInput();
      st.inputGrant = mapping ? { socket: c.conn, session: st.session, mapping, inputEpoch: ++this.inputEpoch, epochRequired, target } : null;
    }

    // An iPad that negotiated epochs can control its scoped stream. A legacy iPad keeps its
    // selected-viewer input path, still checked against the live socket, capture and policy.
    const on = ios ? !!st.inputGrant : allowed;
    const msg = { t: P.T.STREAM_INPUT, on };
    if (ios) {
      if (epochRequired) {
        msg.session = st.inputGrant?.session ?? null;
        msg.inputEpoch = st.inputGrant?.inputEpoch ?? null;
      }
      // A transport resume can replace the primary socket without a new welcome on iOS.
      if (st.viewer === true && st.viewerSocket !== c.conn) msg.refreshViewer = true;
    }
    const key = JSON.stringify(msg);
    if (!c?.conn) st.inputState = null;
    else if (st.inputState?.socket !== c.conn || st.inputState.key !== key) {
      if (st.peer.sendToClient(msg)) st.inputState = { socket: c.conn, key };
    }
    return !!st.inputGrant;
  }

  _releaseInput() {
    if (!this.inputOwner) return;
    this.inputOwner = null;
    this.input.releaseAll();
  }

  lockInput(locked) {
    this.inputLocked = locked;
    this.syncScopedScreens();
  }

  _onInput(m, id, source, ws) {
    if (m.wid != null || !ws || source?.ws !== ws || this.hub.sessions.get(id)?.inbound() !== source) return;
    const st = this.byId.get(id);
    const c = st?.peer.current;
    if (!c || c.conn !== ws || !this._syncScreenInput(st)) return;
    const grant = st.inputGrant;
    const ios = c.os === P.OS.IOS;
    if (grant.epochRequired && (m.session !== grant.session || m.inputEpoch !== grant.inputEpoch)) return;
    if (ios && !grant.epochRequired && (m.session != null || m.inputEpoch != null)) return;

    const t = m.t;
    const key = t === P.T.IN_KEY_DOWN || t === P.T.IN_KEY_UP;
    if (key && (typeof m.code !== 'string' || !m.code.length || m.code.length > 32)) return;
    let owner = this.inputOwner;
    if (owner?.grant !== grant) {
      if (owner && (owner.buttons.size || owner.keys.size)) return;
      const claims = t === P.T.IN_DOWN || t === P.T.IN_WHEEL ||
        (t === P.T.IN_MOVE && (!owner || (grant.epochRequired && m.engaged === true))) ||
        (t === P.T.IN_KEY_DOWN && !grant.epochRequired && !owner);
      if (!claims) return;
      this._releaseInput();
      owner = this.inputOwner = { stream: st, grant, buttons: new Set(), keys: new Set(), keyboard: !grant.epochRequired };
    }
    const b = Number.isFinite(m.b) ? Math.max(0, Math.min(4, m.b | 0)) : 0;
    if (t === P.T.IN_UP && !owner.buttons.delete(b)) return;
    if (key && (!owner.keyboard || (t === P.T.IN_KEY_UP && !owner.keys.delete(m.code)))) return;
    if (t === P.T.IN_DOWN) {
      owner.buttons.add(b);
      owner.keyboard = true;
    }
    if (t === P.T.IN_KEY_DOWN) owner.keys.add(m.code);
    if (t !== P.T.IN_WHEEL && !key && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      owner.point = { x: m.x, y: m.y };
    }
    const scrollAt = Number.isFinite(m.x) && Number.isFinite(m.y) ? { x: m.x, y: m.y }
      : owner.point || { x: 0.5, y: 0.5 };
    this.input.inject(m, grant.target, { swapKeys: this.swapKeys?.(c), meshScreen: grant.inputEpoch, scrollAt });
    if (t === P.T.IN_UP && b === 0 && c.os === P.OS.ANDROID) {
      this.input.textFocus(() => this.inputOwner === owner && st.peer.current?.conn === ws &&
        this.input.enabled() && !!st.inputTarget(), (m) => st.peer.sendToClient(m));
    }
  }

  syncScopedScreens() {
    for (const st of this.all) this._syncScopedScreen(st);
  }

  get active() {
    return this.byId.get(this.hub.selectedId) || this.first;
  }

  get view() {
    const a = this.active;
    return {
      ...a.view,
      deviceId: a.peer.id,
      displays: S.normalizeDisplays(this.displays.model()),
      targets: [...this.byId].filter(([id]) => (this.hub.sessions.get(id) || {}).connected).map(([id, st]) => {
        const c = st.choice;
        return { id, name: this.hub.sessions.get(id).displayName(), mode: c ? c.mode : 'default', displayId: c && c.displayId ? String(c.displayId) : '', status: st.view.status, active: st === a };
      }),
    };
  }

  get audio() {
    return this.active.audio;
  }

  // choice: { mode: 'default'|'none'|'mirror'|'virtual', displayId? }. 'default' follows the shared settings again.
  setTarget(id, choice) {
    const st = this.byId.get(id);
    if (!st) return { ok: false, error: 'device' };
    const ids = [...this.byId.keys()];
    const displays = S.normalizeDisplays(this.displays.model());
    if (!choice || choice.mode === 'default') {
      delete this.table[id];
      st.choice = null;
    } else {
      const want = choice.mode === 'virtual' ? { mode: 'virtual', size: { w: 1920, h: 1080 } }
        : choice.mode === 'mirror' ? { mode: 'mirror', displayId: String(choice.displayId) } : { mode: choice.mode };
      const r = S.setChoice(this.table, id, want, ids, displays);
      if (!r.ok) return r;
      this.table = r.table;
      st.choice = choice.mode === 'mirror' ? { mode: 'mirror', displayId: Number(choice.displayId) } : { mode: choice.mode };
    }
    if (typeof st.noteViewIdentity === 'function') st.noteViewIdentity();
    st.restart('target choice');
    this.emit('change');
    return { ok: true };
  }

  // Every device's selection epoch, after the shared display changes.
  noteViewIdentity() {
    for (const st of this.all) if (st && typeof st.noteViewIdentity === 'function') st.noteViewIdentity();
  }

  restart(reason) {
    return Promise.all(this.all.map((st) => st.restart(reason)));
  }

  stop(status) {
    for (const st of this.all) st.stop(status);
  }
}

module.exports = { StreamSet };
