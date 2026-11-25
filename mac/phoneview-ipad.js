// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { IpadControl, stopAllIPadControl } = require('./iosctl');
const { developerIPads } = require('./iosctl-xctest');

function pairedIPad(views, peer = views.server.current) {
  const socket = peer && Object.hasOwn(peer, 'conn') ? peer.conn : peer?.ws;
  if (peer?.os !== 'ios' || peer.authed !== true || peer.released || !peer.deviceId
      || socket?.readyState !== 1 || socket.released || socket.detached
      || views.phone.infoId !== peer.deviceId || views.phone.info?.platform !== 'ipados') return null;
  const pair = views.phone.pairing?.list().find((p) => p.id === peer.deviceId && p.os === 'ios');
  return pair ? { pair, socket } : null;
}

function matchesIPad(views, owner) {
  const live = pairedIPad(views);
  return !!live && live.socket === owner.socket && live.pair.id === owner.pair.id && live.pair.pairedAt === owner.pair.pairedAt;
}

function ipadState(views, v, code, generation, hardwareKeys) {
  views._send(v, 'phoneview:opts', { ipadState: code, ipadGeneration: generation, ipadHardwareKeys: hardwareKeys });
}

function stopIPad(views, v, reason = 'off', immediate = false) {
  const lease = v.ipadLease;
  if (!lease) return;
  v.ipadLease = null;
  lease.abort.abort();
  lease.stream.removeListener('close', lease.closed);
  lease.controller?.stop(reason, immediate);
  ipadState(views, v, reason);
}

async function startIPad(views, v, dialog) {
  if (v.ipadLease || !v.ipadOwner || !matchesIPad(views, v.ipadOwner)) return;
  const { session, win } = v;
  if (!session?.req || session.req.destroyed || session.closed || !session.owns?.() || !v.size || !v.ipadGeometry) {
    return ipadState(views, v, 'picture');
  }
  const template = views.ipadRunnerTemplate();
  if (!existsSync(template)) return ipadState(views, v, 'setup');
  const contents = win.webContents;
  const lease = { abort: new AbortController(), stream: session.req, generation: randomUUID() };
  const owns = () => v.ipadLease === lease && views.views.get(v.id) === v && !v.ending
    && !win.isDestroyed() && win.webContents === contents && !contents.isDestroyed()
    && v.session === session && !session.closed && session.owns() && session.req === lease.stream
    && !lease.stream.destroyed && matchesIPad(views, v.ipadOwner);
  lease.closed = () => stopIPad(views, v, 'lost');
  v.ipadLease = lease;
  lease.stream.once('close', lease.closed);
  ipadState(views, v, 'starting');

  try {
    const phoneSettings = views.getSettings().phone;
    const { id, name, pairedAt } = v.ipadOwner.pair;
    const sites = Array.isArray(phoneSettings.ipadDeveloperDevices) ? phoneSettings.ipadDeveloperDevices : [];
    let udid = sites.find((binding) => binding?.id === id && binding.pairedAt === pairedAt)?.udid;
    if (!udid) {
      const devices = (await developerIPads(lease.abort.signal)).filter((d) =>
        !sites.some((binding) => binding?.udid === d.udid && binding.id !== id
          && views.phone.pairing.list().some((p) => p.id === binding.id && p.pairedAt === binding.pairedAt)));
      if (!owns()) return;
      if (!devices.length) return stopIPad(views, v, 'device');
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', title: 'Control this iPad', message: 'Associate a developer iPad',
        detail: `Choose the physical iPad showing in this window for ${name || 'this iPad'} (TwinDesk …${id.slice(-8)}). Choose Cancel if you cannot identify it.`,
        buttons: [...devices.map((d) => `${d.name} (…${d.udid.slice(-8)})`), 'Cancel'],
        defaultId: devices.length, cancelId: devices.length, noLink: true,
      });
      if (!owns()) return;
      const selected = devices[response];
      if (!selected) return stopIPad(views, v);
      udid = selected.udid;
      // Re-read after the dialog so two Mesh windows cannot overwrite one another's associations.
      const latest = Array.isArray(phoneSettings.ipadDeveloperDevices) ? phoneSettings.ipadDeveloperDevices : [];
      if (latest.some((binding) => binding?.udid === udid && binding.id !== id
        && views.phone.pairing.list().some((p) => p.id === binding.id && p.pairedAt === binding.pairedAt))) {
        return stopIPad(views, v, 'busy');
      }
      phoneSettings.ipadDeveloperDevices = [...latest.filter((binding) => binding?.id !== id), { id, pairedAt, udid }];
      views.bridge.emit('save');
    }
    if (!owns()) return;
    const controller = new IpadControl({ udid, owns, template, canInput: () => !win.isDestroyed() && win.isFocused(), status: (code) => {
      if (v.ipadLease !== lease) return;
      if (code === 'connected') ipadState(views, v, code, lease.generation, controller.hardwareKeys);
      else if (code === 'pasteTooLarge') views._send(v, 'phoneview:opts', { ipadPasteTooLarge: true });
      else stopIPad(views, v, code);
    } });
    lease.controller = controller;
    await controller.connect();
  } catch (error) {
    if (v.ipadLease === lease) stopIPad(views, v, error.message === 'busy' ? 'busy' : 'startup');
  } finally {
    if (!owns() && v.ipadLease === lease) stopIPad(views, v, 'lost');
  }
}

function handleIPad(views, v, m, dialog) {
  if (!v.ipadOwner) return false;
  if (!matchesIPad(views, v.ipadOwner)) {
    if (v.ipadLease) stopIPad(views, v, 'lost');
    else if (m.t === 'ipadControl') ipadState(views, v, 'lost');
    return m.t !== 'resetVideo' && m.t !== 'pin';
  }
  if (m.t === 'ipadControl') {
    if (m.on === true) void startIPad(views, v, dialog);
    else stopIPad(views, v);
    return true;
  }
  if (m.t === 'ipadInput') {
    const lease = v.ipadLease;
    if (lease && m.generation === lease.generation && v.win.isFocused()) {
      lease.controller?.input(m, () => ({ frame: v.size, source: v.ipadGeometry }));
    }
    return true;
  }
  return m.t !== 'resetVideo' && m.t !== 'pin';
}

function installIPadQuitDrain(app, stop = stopAllIPadControl) {
  let pending;
  let draining = false;
  let resumed = false;
  app.on('before-quit', () => { if (!resumed) pending ||= stop(); });
  app.on('will-quit', (event) => {
    if (!pending || resumed) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      clearTimeout(timer);
      app.quit();
    };
    const timer = setTimeout(resume, 3000);
    pending.then(resume, resume);
  });
}

module.exports = { pairedIPad, matchesIPad, stopIPad, handleIPad, installIPadQuitDrain };
