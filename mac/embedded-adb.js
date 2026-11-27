// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

class EmbeddedAdb {
  constructor(bridge) {
    this.bridge = bridge;
    const { server } = bridge;
    for (const event of ['client', 'closed', 'transport']) server.on(event, () => this.sync());
    server.route?.onState?.(() => this.sync());
  }

  get active() {
    return !!this.bridge.server.current?.embeddedPeer;
  }

  get grant() {
    const { phone, server } = this.bridge;
    const ctx = server.current;
    if (!ctx?.embeddedPeer || (server.route && ctx.conn !== ctx.ws)) return null;
    return phone.raw?.embeddedAdbGrant?.(ctx.ws) || null;
  }

  get wanted() {
    const b = this.bridge;
    const id = b.server.current?.deviceId;
    return !!id && (b.need || (b.phone.adb?.wifi && (b.known.has(id) || b._rzApps())));
  }

  get usb() {
    const id = this.bridge.server.current?.deviceId;
    return id && this.bridge.wired?.serialOf(id);
  }

  sync() {
    const b = this.bridge;
    const attempt = this.attempt;
    const devices = b.adb.track?.list;
    const lost = attempt?.serial && b.serial === attempt.serial && devices &&
      !devices.some((d) => d.serial === attempt.serial && d.state === 'device');
    if (attempt && (attempt.grant !== this.grant || !this.wanted || this.usb || lost)) this.close();
    // A LAN controller can survive normal socket resumes. Entering the embedded route requires
    // either the exact wired device or a new transport from the embedded grant.
    if (this.active && b.serial && b.serial !== this.usb && b.serial !== this.attempt?.serial) this._release(b.serial);
  }

  close() {
    this.attempt?.tunnel.close();
  }

  _release(serial) {
    const b = this.bridge;
    if (b.serial !== serial) return;
    b._kvmEnd(!!b._crossingPeer(b.kvm?.owner));
    b._epoch++;
    b._dropControl();
    b.serial = null;
    b.inputBlocked = false;
    b._set('connecting', 'Waiting for the phone’s ADB connection…');
    b._kick();
  }

  _closed(attempt) {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    attempt.abort.abort();
    if (!attempt.serial) return;
    const b = this.bridge;
    this._release(attempt.serial);
    b.setupDone.delete(attempt.serial);
    require('./scrcpy').Session.forgetSerial(attempt.serial);
    void b.adb.disconnect(attempt.serial).catch(() => {});
  }

  async find() {
    const b = this.bridge;
    const usb = this.usb;
    if (usb) {
      this.close();
      const device = (await b.adb.devices()).find((d) => d.serial === usb);
      if (this.usb !== usb || !this.active) return null;
      if (device?.state === 'device') return usb;
      b._set('connecting', device?.state === 'unauthorized'
        ? 'Allow USB debugging for this computer on the phone (tap Allow on its prompt).'
        : `Waiting for adb on the cable (${device?.state || 'not listed'})…`);
      return null;
    }
    const grant = this.grant;
    if (!grant) {
      const a = b.phone.adb;
      if (!a.wifi || !a.net) b._set('waitingWifi', 'Connect the phone to Wi-Fi and turn on Wireless debugging on the phone.');
      else b._set('connecting', 'Waiting for the phone’s wireless debugging port…');
      return null;
    }

    let attempt = this.attempt;
    if (!attempt) {
      attempt = { grant, abort: new AbortController() };
      const tunnel = grant.open(() => this.grant === grant && this.wanted && !this.usb, () => this._closed(attempt));
      if (!tunnel) return null;
      attempt.tunnel = tunnel;
      this.attempt = attempt;
      const port = await tunnel.ready;
      if (!port || this.attempt !== attempt) return null;
      attempt.serial = `127.0.0.1:${port}`;
      const r = await b.adb.connectEmbedded(attempt.serial, attempt.abort.signal);
      if (this.grant !== grant || !this.wanted || this.usb) return this.close();
      const status = `${r.out}${r.err}`;
      if (/authenticat|unauthorized/i.test(status)) return this._needsPair();
      if (this.attempt !== attempt || !/connected to/i.test(status) || /failed|unable|cannot/i.test(status)) {
        this.close();
        b.misses++;
        b.canPair = b.misses >= 5;
        b._set('connecting', b.canPair ? 'Can’t reach wireless debugging. Check it’s on, or pair again on the same Wi-Fi.' : 'Connecting to the phone’s wireless debugging…');
        return null;
      }
      attempt.deadline = Date.now() + 10000;
    }

    const device = (await b.adb.devices()).find((d) => d.serial === attempt.serial);
    if (this.attempt !== attempt || this.grant !== grant || !this.wanted || this.usb) return null;
    if (device?.state === 'device' && attempt.tunnel.attached) {
      b.misses = 0;
      return attempt.serial;
    }
    if (device?.state === 'unauthorized') return this._needsPair();
    if (Date.now() >= attempt.deadline) this.close();
    b._set('connecting', 'Connecting to the phone’s wireless debugging…');
    return null;
  }

  _needsPair() {
    this.close();
    this.bridge._known(false);
    this.bridge._set('needsPair', 'Pair this Mac with the phone once on the same Wi-Fi: Wireless debugging › Pair device with pairing code.');
    return null;
  }
}

module.exports = { EmbeddedAdb };
