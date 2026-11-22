// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { sameIdentity } = require('../shared/localsend/wire');

function attachReceipts(shelf, receipts, latestPhoto = () => null) {
  if (shelf.receipts) return;
  shelf.receipts = receipts;
  shelf.latestPhoto = latestPhoto;
  const identify = shelf._identify.bind(shelf);
  shelf._identify = (source) => {
    const identity = identify(source);
    // Compare the receipt pin to the same snapshot used for drag and reveal.
    return source.identity && !sameIdentity(source.identity, identity) ? null : identity;
  };
  shelf._candidates = function () {
    let received = [], photo = null;
    try { photo = this.latestPhoto(); } catch { /* A revoked or unreadable backup has no item. */ }
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
    return [photo && typeof photo.path === 'string' ? { path: photo.path, photo: true } : null, ...ranked].filter(Boolean);
  };
  shelf.refresh();
}

module.exports = { attachReceipts };
