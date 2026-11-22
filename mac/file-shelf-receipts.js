// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { sameIdentity } = require('../shared/localsend/wire');

function attachReceipts(shelf, receipts, latestPhoto = () => null, recheckPhoto = () => {}) {
  if (shelf.receipts) return;
  shelf.receipts = receipts;
  let photoPath;
  const identify = shelf._identify.bind(shelf);
  shelf._identify = (source) => {
    const identity = identify(source);
    if (source.photo && source.identity && !sameIdentity(source.identity, identity)) {
      recheckPhoto(source.photo);
      return null;
    }
    return source.identity && !sameIdentity(source.identity, identity) ? null : identity;
  };
  shelf._candidates = function () {
    let received = [], photo = null;
    try { photo = latestPhoto(); } catch { /* A revoked or unreadable backup has no item. */ }
    try {
      const list = typeof this.receipts === 'function' ? this.receipts() : [];
      if (Array.isArray(list)) received = list.slice(0, 40);
    } catch { /* A broken history has no item. */ }
    const ranked = [];
    for (const item of (this.drop?.recent || []).slice(0, 40)) {
      if (item && item.ok && typeof item.path === 'string') ranked.push({ path: item.path, at: item.at });
    }
    for (const item of received) {
      if (item && typeof item.path === 'string') ranked.push({ path: item.path, at: item.at, identity: item.identity });
    }
    ranked.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    photoPath = typeof photo?.path === 'string' ? photo.path : null;
    return photoPath ? [{ path: photoPath, identity: photo.identity, photo }, ...ranked] : ranked;
  };
  const sources = shelf._sources.bind(shelf);
  shelf._sources = () => sources().map(source => source.path === photoPath ? { ...source, kind: 'photo' } : source);
  const snapshot = shelf._snapshot.bind(shelf);
  shelf._snapshot = () => {
    const state = snapshot();
    for (const item of state.items) {
      if (item.kind === 'photo') item.detail = shelf.t('Latest backed-up photo');
    }
    return state;
  };
  shelf.refresh();
}

module.exports = { attachReceipts };
