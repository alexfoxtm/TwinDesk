// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// In-memory USB-only intent for one opted-in Galaxy. Same lifetime as wired.js byDevice:
// nothing is written to userData. An old phone.wired without `cable` must not turn this on.
'use strict';

const isUsb = (serial) => typeof serial === 'string' && serial.length > 0 && !serial.includes(':') &&
  !serial.startsWith('emulator-') && !serial.includes('._adb-tls');

class CablePolicy {
  constructor() {
    this.byDevice = new Map(); // deviceId -> { on, serial }
  }

  // `cable` missing: keep the previous intent. 1/true opts in. 0/false clears it and may keep the serial.
  note(deviceId, serial, message) {
    if (!deviceId) return;
    const prev = this.byDevice.get(deviceId) || { on: false, serial: null };
    let on = prev.on;
    if (message && Object.prototype.hasOwnProperty.call(message, 'cable')) on = message.cable === 1 || message.cable === true;
    const nextSerial = isUsb(serial) ? serial : prev.serial;
    if (!on && !nextSerial) this.byDevice.delete(deviceId);
    else this.byDevice.set(deviceId, { on, serial: nextSerial });
  }

  // HELLO supplies the policy only once that exact request has committed an Android session.
  noteAuthenticated(ctx, requested) {
    if (!ctx?.authed || ctx.os !== 'android' || (requested !== 0 && requested !== 1)) return;
    this.note(ctx.deviceId, null, { cable: requested });
  }

  on(deviceId) {
    return !!(deviceId && this.byDevice.get(deviceId)?.on);
  }

  serial(deviceId) {
    const row = deviceId ? this.byDevice.get(deviceId) : null;
    return row && row.on && isUsb(row.serial) ? row.serial : null;
  }

  // undefined: this phone is not opted in, so the caller keeps its wireless search.
  // null: opted in, and that exact USB serial is not an online adb device.
  exact(deviceId, list) {
    if (!this.on(deviceId)) return undefined;
    const serial = this.serial(deviceId);
    if (!serial || !Array.isArray(list) || !list.some((x) => x && x.serial === serial && x.state === 'device')) return null;
    return serial;
  }

  skipsTcpip(serial) {
    if (!isUsb(serial)) return false;
    for (const row of this.byDevice.values()) if (row.on && row.serial === serial) return true;
    return false;
  }

  // Read the persisted policy before desktop auto-setup can restart adbd. An older phone or a
  // failed query cannot authorize promotion; its existing cable connection can still proceed.
  async permitsWiredTcpip(adb, serial, receiver) {
    if (!isUsb(serial) || this.skipsTcpip(serial)) return false;
    try {
      const reply = await adb.shell(serial, `am broadcast -f 32 -n ${receiver} --ez checkCableMode true`, { timeout: 5000 });
      return reply.code === 0 && !this.skipsTcpip(serial) &&
        reply.out.split(/\r?\n/).includes('Broadcast completed: result=0, data="twindesk-cable-unrestricted"');
    } catch (_) {
      return false;
    }
  }

  clear() { this.byDevice.clear(); }
}

const cable = new CablePolicy();

module.exports = { CablePolicy, cable, isUsb };
