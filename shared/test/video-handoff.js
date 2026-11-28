// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { videoLink, sendVideo } = require('../video-handoff.js');

test('supported video links preserve timestamps and send only to the selected live phone socket', () => {
  const socket = { readyState: 1 };
  const device = { deviceId: 'phone-a', os: 'android', ws: socket };
  const sent = [];
  const peer = { current: device, outbound: () => socket, sendNow: (m) => { sent.push(m); return true; } };
  assert.equal(videoLink('https://youtu.be/dQw4w9WgXcQ?t=1m23s').seconds, 83);
  assert.equal(videoLink('https://vimeo.com/123#t=24s').seconds, 24);
  assert.equal(videoLink('https://www.twitch.tv/videos/123?t=1h2m3s').seconds, 3723);
  assert.equal(videoLink('https://www.dailymotion.com/video/x123?start=10').seconds, 10);
  assert.equal(videoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&redirect=https://example.com', 0).url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s');
  assert.equal(sendVideo(peer, { deviceId: 'phone-a', url: 'https://youtu.be/dQw4w9WgXcQ', seconds: '83' }).ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'video.offer');
  assert.equal(sent[0].seconds, 83);
  assert.equal(sent[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s');
});

test('malformed, substituted, retired and non-video destinations never send', () => {
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com:4430/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/redirect?v=dQw4w9WgXcQ', 'https://example.com/a.mp4',
    'https://youtu.be/dQw4w9WgXcQ?t=oops']) assert.equal(videoLink(url), null, url);
  assert.equal(videoLink('https://youtu.be/dQw4w9WgXcQ', 604801), null);
  assert.equal(videoLink('https://youtu.be/dQw4w9WgXcQ', -1), null);
  assert.equal(videoLink('https://youtu.be/dQw4w9WgXcQ', 1.5), null);
  const device = { deviceId: 'phone-a', os: 'ios', ws: { readyState: 1 } };
  let count = 0;
  const peer = { current: device, sendNow: () => { count++; return true; } };
  const request = { deviceId: 'phone-b', url: 'https://youtu.be/dQw4w9WgXcQ', seconds: 1 };
  assert.equal(sendVideo(peer, request).ok, false);
  request.deviceId = 'phone-a'; device.ws.readyState = 3;
  assert.equal(sendVideo(peer, request).ok, false);
  peer.current = null;
  assert.equal(sendVideo(peer, request).ok, false);
  assert.equal(count, 0);
});
