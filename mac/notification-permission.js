// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const { EventEmitter } = require('events');

function loadBinding() {
  if (!process.versions.electron || process.type === 'renderer') return null;
  try { return require('../mac-helper/.build/release/notification-permission.node'); }
  catch { return null; }
}

class NotificationPermission extends EventEmitter {
  constructor(binding = loadBinding()) {
    super();
    this.binding = binding;
    this.view = { authorization: 'unknown', alerts: 'unknown', bundleId: '' };
    this.pending = null;
    this.requesting = null;
  }

  _set(value) {
    if (JSON.stringify(this.view) !== JSON.stringify(value)) {
      this.view = value;
      this.emit('change');
    }
    return this.view;
  }

  async refresh() {
    if (!this.binding) return this.view;
    if (this.pending) return this.pending;
    const pending = this.binding.getSettings().then((value) => this._set(value), () =>
      this._set({ authorization: 'unknown', alerts: 'unknown', bundleId: this.view.bundleId }));
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = null; }
  }

  async request() {
    if (!this.binding) return this.view;
    if (this.requesting) return this.requesting;
    const requesting = this._request();
    this.requesting = requesting;
    try { return await requesting; }
    finally { if (this.requesting === requesting) this.requesting = null; }
  }

  async _request() {
    // A query admitted before the request must not overwrite its newer answer.
    if (this.pending) await this.pending;
    const pending = this.binding.request().then((value) => this._set(value), () =>
      this._set({ authorization: 'unknown', alerts: 'unknown', bundleId: this.view.bundleId }));
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = null; }
  }
}

module.exports = { NotificationPermission };
