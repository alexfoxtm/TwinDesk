// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const { stopAllIPadControl } = require('./iosctl');

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

function stopIPad(v, reason = 'off', immediate = false) {
  const lease = v.ipadLease;
  if (!lease) return;
  v.ipadLease = null;
  lease.abort.abort();
  lease.stream.removeListener('close', lease.closed);
  lease.controller?.stop(reason, immediate);
}

function handleIPad(views, v, m) {
  if (m.t === 'ipadInput') return true;
  if (m.t === 'ipadControl') {
    if (m.on === false) stopIPad(v);
    return true;
  }
  if (!v.ipadOwner) return false;
  if (v.ipadLease && !matchesIPad(views, v.ipadOwner)) stopIPad(v, 'lost');
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
