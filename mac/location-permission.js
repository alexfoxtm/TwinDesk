// TwinDesk — Copyright (C) 2026 alexfoxtm. GPL-3.0, see LICENSE.
'use strict';

function createLocationRequest(ctx, pushState, openSettings) {
  const permissions = ctx.state.permissions;
  return async () => {
    if (permissions.locationPending) return;
    permissions.locationPending = true;
    pushState();
    try {
      // The helper waits for Core Location's decision for up to 60 seconds.
      const result = await ctx.helper.request('requestLocation', {}, 65_000);
      if (result.openSettings === true) await openSettings();
    } catch {
      // With no definitive reply, leave Settings closed and let the user retry.
    } finally {
      permissions.locationPending = false;
      ctx.refreshPermissions();
    }
  };
}

module.exports = { createLocationRequest };
