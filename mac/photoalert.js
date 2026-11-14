// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// New camera photos and videos on the phone, as a notification on this Mac (shared/phonehub.js
// mediaAlert; Photos › Notify about new photos and videos, off until switched on). It says how many
// and on which phone: the phone tells no more than that, and nothing is loaded for it. One at a
// time: more within a minute replace it, without a sound, with the count so far. A click opens
// Photos, only while that phone's session is still the one connected.
'use strict';

const AGAIN_MS = 60000;

// Notification: Electron's. t: the translation. open(tab): the window on that page.
function photoAlerts({ Notification, t, open }) {
  let live = null; // the one showing: {note, photos, videos, at, current}
  return (a) => {
    if (!Notification.isSupported()) return;
    const more = !!live && live.current() && Date.now() - live.at < AGAIN_MS;
    const photos = a.photos + (more ? live.photos : 0);
    const videos = a.videos + (more ? live.videos : 0);
    const phone = a.name || t('your phone');
    const title = !videos ? (photos === 1 ? t('New photo on {phone}', { phone }) : t('{count} new photos on {phone}', { count: photos, phone }))
      : !photos ? (videos === 1 ? t('New video on {phone}', { phone }) : t('{count} new videos on {phone}', { count: videos, phone }))
        : t('{count} new photos and videos on {phone}', { count: photos + videos, phone });
    try {
      if (live) live.note.close();
      const note = new Notification({ title, body: t('Click to open Photos'), silent: more });
      const mine = { note, photos, videos, at: Date.now(), current: a.current };
      note.on('click', () => {
        if (live === mine) live = null; // seen: the next one counts from one again
        if (mine.current()) open('media');
      });
      live = mine;
      note.show();
    } catch { live = null; }
  };
}

module.exports = { photoAlerts };
