// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

(function () {
  const TL = typeof module === 'object' && module.exports ? require('./timeline') : window.TDTimeline;
  const PATH = 1024;
  const PER_SOURCE = 500;
  const baseName = TL.baseName;
  const fromState = TL.fromState;
  const revealItem = TL.revealItem;

  function absolutePath(p) {
    return typeof p === 'string' && p.length > 1 && p.length <= PATH && (p.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(p));
  }

  // One record per saved file of a finished incoming transfer. Newest transfers first, as stored.
  function localSendRecords(transfers) {
    const records = [];
    if (!Array.isArray(transfers)) return records;
    const seen = new Set();
    const n = Math.min(transfers.length, PER_SOURCE);
    for (let i = 0; i < n && records.length < PER_SOURCE; i++) {
      let tr;
      try { tr = transfers[i]; } catch (_) { continue; }
      if (!tr || typeof tr !== 'object' || Array.isArray(tr) || tr.dir !== 'in' || tr.state !== 'done' || !Array.isArray(tr.saved)) continue;
      const id = typeof tr.id === 'string' ? tr.id.slice(0, 80) : '';
      if (!id) continue;
      const peer = tr.peer && typeof tr.peer === 'object' && typeof tr.peer.alias === 'string' ? tr.peer.alias : '';
      const max = Math.min(tr.saved.length, 40);
      for (let index = 0; index < max && records.length < PER_SOURCE; index++) {
        const file = tr.saved[index];
        if (!absolutePath(file) || seen.has(file)) continue;
        seen.add(file);
        records.push({ name: baseName(file), path: file, at: tr.at, peer, ls: id, index });
      }
    }
    return records;
  }

  // Activity may reveal a completed receipt only while that transfer is still in the history, and
  // only by its id and saved index. The returned object has no path.
  function localsendReveal(it, transfers) {
    const m = it && it.meta;
    if (!m || typeof m.ls !== 'string' || !m.ls) return null;
    if (m.lsIndex != null && (!Number.isInteger(m.lsIndex) || m.lsIndex < 0 || m.lsIndex > 999)) return null;
    const index = Number.isInteger(m.lsIndex) && m.lsIndex > 0 ? m.lsIndex : 0;
    const list = Array.isArray(transfers) ? transfers : [];
    const tr = list.find((entry) => entry && entry.id === m.ls && entry.dir === 'in' && entry.state === 'done' && Array.isArray(entry.saved));
    const file = tr && tr.saved[index];
    if (typeof file !== 'string' || !file) return null;
    if (it.path && file !== it.path) return null;
    return index ? { id: m.ls, index } : { id: m.ls };
  }

  function withReceipts(state) {
    const rows = fromState(state);
    const seen = new Set(rows.filter(it => it.kind === 'file' && it.path && it.meta.dir === 'in' && it.meta.ok !== false).map(it => it.path));
    const records = localSendRecords(state?.localsend?.transfers).filter(record => {
      if (seen.has(record.path)) return false;
      seen.add(record.path);
      return true;
    });
    for (const [i, row] of fromState({ received: records }).entries()) {
      const { ls, index } = records[i];
      row.id = `file:ls:${ls}:${index}`;
      row.meta = { dir: 'in', ok: true, state: 'done', ls, ...(index ? { lsIndex: index } : {}) };
      rows.push(row);
    }
    return rows;
  }

  function reveal(it, state, api) {
    const m = it && it.meta || {};
    if (m.ls) {
      const arg = localsendReveal(it, state?.localsend?.transfers);
      if (arg && api && typeof api.lsReveal === 'function') api.lsReveal(arg.index ? arg : arg.id);
      return;
    }
    revealItem(it, state, api);
  }

  const activity = { ...TL, fromState: withReceipts, build: state => TL.dedupeSort(withReceipts(state)), revealItem: reveal, localsendReveal };
  if (typeof module === 'object' && module.exports) module.exports = activity;
  else window.TDTimeline = activity;
})();
