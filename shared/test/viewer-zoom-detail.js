// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const { fixture, near } = require('./viewer-viewport.js');

const zoomDetail = { baseline: 1080, fps: 60, sizes: [null, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }] };
async function detailedViewer(session = 40, touch = 'direct', local = true) {
  const f = fixture(local, touch);
  f.recv({ t: 'rtc.offer', session, viewerGeneration: session + 100, sdp: 'fixture', detail: zoomDetail });
  await new Promise(resolve => setImmediate(resolve));
  f.peers[0].ontrack({ track: { kind: 'video' }, receiver: {} });
  f.videoEvents.get('playing')(); f.videoFrame();
  return f;
}
function zoomIn(f) {
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400);
  f.pointer('pointermove', 2, 800, 400); f.frame();
  f.pointer('pointerup', 1, 400, 400); f.pointer('pointerup', 2, 800, 400);
}
async function zoomRequestsSharperOwnedPicture() {
  const f = await detailedViewer();
  zoomIn(f);
  f.advance(200);
  f.pointer('pointerdown', 3, 500, 400); f.pointer('pointerup', 3, 500, 400);
  f.advance(399);
  assert.deepStrictEqual(f.detailRequests, [], 'tap after a pinch restarts its settled detail request');
  f.advance(1); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [{ generation: 140, session: 40, height: 1440 }]);
  const transform = f.video.style.transform;
  f.video.videoWidth = 2560; f.video.videoHeight = 1440; f.videoEvents.get('resize')(); f.videoFrame();
  f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(f.video.style.transform, transform, 'sharper same-aspect frames preserve zoom and pan');
  assert.strictEqual(f.detailRequests.length, 1, 'same resolution request is coalesced');
  f.recv({ t: 'viewer.scale', mode: 'fit' }); f.advance(400);
  assert.deepStrictEqual(f.detailRequests.at(-1), { generation: 140, session: 40, height: 0 }, 'Fit restores this stream baseline');
}
async function zoomRejectsUnavailableAndRetiredPicture() {
  const f = await detailedViewer();
  f.window.TD.canDecodeVideo = () => false;
  zoomIn(f); f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [], 'unsupported decoder size leaves the baseline stream');
  f.window.TD.canDecodeVideo = () => true;
  f.recv({ t: 'viewer.scale', mode: 'fit' }); zoomIn(f);
  f.document.hidden = true; f.docEvents.get('visibilitychange')(); f.advance(400);
  assert.deepStrictEqual(f.detailRequests, [], 'hidden viewer drops a pending zoom');
  f.document.hidden = false;
  f.recv({ t: 'viewer.scale', mode: 'fit' }); zoomIn(f);
  f.recv({ t: 'viewer.probe', session: 40, viewerGeneration: 141, accept: false }); f.advance(400);
  assert.deepStrictEqual(f.detailRequests, [], 'lock probe cancels the old frame request');
  f.recv({ t: 'viewer.probe', session: 40, viewerGeneration: 142, accept: true }); f.videoFrame();
  f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [{ generation: 142, session: 40, height: 1440 }]);
  f.recv({ t: 'viewer.scale', mode: 'fit' });
  f.recv({ t: 'rtc.offer', session: 41, viewerGeneration: 143, sdp: 'fixture', detail: zoomDetail });
  f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(f.detailRequests.length, 1, 'replacement offer cancels the prior stream restore');
  f.peers[1].ontrack({ track: { kind: 'video' }, receiver: {} });
  f.videoEvents.get('playing')(); f.videoFrame(); zoomIn(f);
  f.recv({ t: 'stream.stop' }); f.advance(400);
  assert.strictEqual(f.detailRequests.length, 1, 'Stop cancels the pending detail request');
}
async function trackpadCueTracksZoomedPicture() {
  for (const local of [true, false]) {
    const f = await detailedViewer(50, 'pad', local);
    f.recv({ t: 'screen.state', on: true, remote: true });
    f.recv({ t: 'viewer.input', on: true });
    if (local) zoomIn(f);
    f.sent.length = 0;
    f.pointer('pointerdown', 3, 500, 400);
    f.pointer('pointermove', 3, 530, 430);
    f.frame();
    assert.equal(f.cue.hidden, false);
    assert.deepStrictEqual(f.sent.map(m => m.t), ['in.mm'], 'the cue adds no input messages');
    const [panX, panY, scale] = f.video.style.transform.match(/-?[0-9.]+/g).map(Number);
    const [x, y] = f.cue.style.transform.match(/-?[0-9.]+/g).map(Number);
    near(x, (1000 - 1000 * scale) / 2 + panX + f.sent[0].x * 1000 * scale);
    near(y, (800 - 562.5 * scale) / 2 + panY + f.sent[0].y * 562.5 * scale);
    f.advance(160);
    assert.equal(f.cue.hidden, true, 'idle cue clears without waiting for a remote frame');
  }
}

async function trackpadCueDoesNotSurviveRevocation() {
  const f = await detailedViewer(51, 'pad');
  f.recv({ t: 'screen.state', on: true, remote: true });
  f.recv({ t: 'viewer.input', on: true });
  f.pointer('pointerdown', 1, 500, 400);
  f.pointer('pointermove', 1, 530, 430);
  f.recv({ t: 'viewer.input', on: false });
  f.frame();
  assert.equal(f.cue.hidden, true, 'a queued cue cannot appear after input is revoked');
  f.recv({ t: 'viewer.input', on: true });
  f.pointer('pointermove', 1, 560, 460);
  f.frame();
  assert.equal(f.cue.hidden, false);
  f.recv({ t: 'viewer.probe', session: 51, viewerGeneration: 152, accept: false });
  assert.equal(f.cue.hidden, true, 'lock clears the visible cue immediately');
  f.pointer('pointermove', 1, 590, 490);
  f.frame();
  assert.equal(f.cue.hidden, true);
}

async function receiveMetricsUseActualDecodedCounters() {
  const f = await detailedViewer(60);
  let count = 0;
  f.peers[0].stats = () => {
    const n = count++;
    return new Map([['in', { id: 'video-in', type: 'inbound-rtp', kind: 'video', timestamp: 1000 + n * 2000,
      framesDecoded: 100 + n * 120, bytesReceived: 1000 + n * 250000, framesDropped: 2 + n }]]);
  };
  f.advance(2000); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.videoMetrics[0], { generation: 160, session: 60, w: 1920, h: 1080, fps: -1, kbps: -1, dropped: 2 },
    'rates wait for a second observed sample');
  f.advance(2000); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.videoMetrics[1], { generation: 160, session: 60, w: 1920, h: 1080, fps: 60, kbps: 1000, dropped: 3 });
  assert.equal(count, 2);
}

async function receiveMetricsRejectLateStats() {
  const f = await detailedViewer(61);
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.recv({ t: 'viewer.probe', session: 61, viewerGeneration: 162, accept: false });
  finish(new Map([['in', { id: 'old', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 100, bytesReceived: 1000 }]]));
  await new Promise(resolve => setImmediate(resolve));
  f.advance(10000);
  assert.deepEqual(f.videoMetrics, [], 'an async report from the locked generation is discarded');
  f.recv({ t: 'viewer.probe', session: 61, viewerGeneration: 163, accept: true }); f.videoFrame();
  f.advance(2000);
  f.document.hidden = true; f.docEvents.get('visibilitychange')();
  finish(new Map([['in', { id: 'hidden', type: 'inbound-rtp', kind: 'video', timestamp: 2000 }]]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.videoMetrics, [], 'a backgrounded viewer discards in-flight statistics');
}

async function receiveMetricsRecoverIfConnectionStateChangesDuringStats() {
  const f = await detailedViewer(62);
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.peers[0].connectionState = 'connecting';
  finish(new Map([['in', { id: 'video-in', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 10, bytesReceived: 1000 }]]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.videoMetrics, []);
  f.peers[0].connectionState = 'connected';
  f.peers[0].stats = () => new Map([['in', { id: 'video-in', type: 'inbound-rtp', kind: 'video', timestamp: 3000, framesDecoded: 130, bytesReceived: 251000, framesDropped: 1 }]]);
  f.peers[0].onconnectionstatechange();
  f.videoFrame();
  f.advance(2000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.videoMetrics.length, 1, 'doctor polling resumes after transient non-connected getStats');
}

(async () => {
  await zoomRequestsSharperOwnedPicture();
  await zoomRejectsUnavailableAndRetiredPicture();
  await trackpadCueTracksZoomedPicture();
  await trackpadCueDoesNotSurviveRevocation();
  await receiveMetricsUseActualDecodedCounters();
  await receiveMetricsRejectLateStats();
  await receiveMetricsRecoverIfConnectionStateChangesDuringStats();
  console.log('viewer-zoom-detail: zoom detail, trackpad cue, and receive metrics passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
