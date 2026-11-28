// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const crypto = require('node:crypto');
const MAX_SECONDS = 7 * 24 * 60 * 60;

// Rebuild supported links so a received offer cannot carry an alternate destination.
function videoLink(value, position = null) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u;
  try { u = new URL(value.trim()); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  let out;
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id = host === 'youtu.be' ? u.pathname.slice(1) : u.pathname === '/watch'
      ? u.searchParams.get('v') : u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)$/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
    out = new URL('https://www.youtube.com/watch');
    out.searchParams.set('v', id);
  } else if (host === 'vimeo.com' && /^\/\d{1,20}\/?$/.test(u.pathname)) {
    out = new URL('https://vimeo.com' + u.pathname);
  } else if (host === 'twitch.tv' && /^\/videos\/\d{1,20}\/?$/.test(u.pathname)) {
    out = new URL('https://www.twitch.tv' + u.pathname);
  } else if (host === 'dailymotion.com' && /^\/video\/[A-Za-z0-9]{1,40}\/?$/.test(u.pathname)) {
    out = new URL('https://www.dailymotion.com' + u.pathname);
  } else return null;
  let sec = position;
  if (sec == null || sec === '') {
    const time = u.searchParams.get('t') || u.searchParams.get('start') || u.hash.replace(/^#t=/, '') || '0';
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
    sec = /^\d+$/.test(time) ? Number(time) : parts
      ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0) : NaN;
  } else if (typeof sec === 'string' && /^\d{1,7}$/.test(sec)) sec = Number(sec);
  if (!Number.isInteger(sec) || sec < 0 || sec > MAX_SECONDS) return null;
  if (host === 'vimeo.com') out.hash = 't=' + sec + 's';
  else if (host === 'dailymotion.com') out.searchParams.set('start', String(sec));
  else out.searchParams.set('t', String(sec) + 's');
  return { url: out.href, seconds: sec };
}

function sendVideo(peer, request) {
  const selected = peer?.current;
  if (!selected || !['android', 'ios'].includes(selected.os) || !request || request.deviceId !== selected.deviceId) return { ok: false };
  const video = videoLink(request.url, request.seconds);
  if (!video) return { ok: false };
  const socket = typeof peer.outbound === 'function' ? peer.outbound(selected) : selected.ws;
  if (!socket || socket.readyState !== 1 || peer.current !== selected) return { ok: false };
  const message = { t: 'video.offer', id: crypto.randomUUID(), ...video, at: Date.now() };
  const sent = typeof peer.sendNow === 'function' ? peer.sendNow(message) : peer.send(selected, message);
  return { ok: sent !== false };
}

module.exports = { videoLink, sendVideo, MAX_SECONDS };
