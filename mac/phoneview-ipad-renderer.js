// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

window.PhoneViewIPad = (api, I, canvas, displayedFrame) => {
  let state = 'off';
  let generation;
  let gesture;
  let scroll;

  document.body.classList.add('ipad');
  document.getElementById('ipad-controls').hidden = false;
  const button = document.getElementById('ipad-control');
  const status = document.getElementById('ipad-control-status');
  button.onclick = () => api.send({ t: 'ipadControl', on: state !== 'starting' && state !== 'connected' });
  const copy = {
    starting: ['Connecting…'], connected: ['Connected'], picture: ['Waiting for video', 'Wait for the iPad’s screen to appear.'],
    setup: ['Set up XCUITest', 'Set TWINDESK_IPAD_WDA_XCTESTRUN to the staged runner’s .xctestrun file.'],
    device: ['iPad unavailable', 'Check the iPad’s developer pairing in Xcode.'],
    developerMode: ['Developer Mode off', 'On the iPad, open Settings › Privacy & Security › Developer Mode.'],
    route: ['No developer route', 'Check the associated iPad’s paired Wi-Fi connection in Xcode, or use trusted USB.'],
    busy: ['iPad control busy', 'Stop control in the other window or wait for its session to close.'],
    endpoint: ['Runner mismatch', 'Check the staged TwinDesk XCUITest runner.'],
    startup: ['Couldn’t start control', 'Check Xcode provisioning, unlock the iPad and check Settings › Developer › Enable UI Automation.'],
    lost: ['Control disconnected', 'Reopen the iPad viewer and choose Control this iPad again.'],
  };
  api.on('opts', (m) => {
    if (!m.ipadState) return;
    state = m.ipadState;
    generation = m.ipadGeneration;
    gesture = scroll = null;
    const connected = state === 'connected';
    document.body.classList.toggle('ipad-connected', connected);
    I.text(button, connected || state === 'starting' ? 'Stop iPad control' : 'Control this iPad');
    const [label, detail] = copy[state] || [''];
    I.text(status, label);
    status.title = I.t(detail || label);
    status.setAttribute('aria-label', status.title);
    if (connected) canvas.focus();
  });

  const pictureAt = (e) => {
    const frame = displayedFrame();
    if (state !== 'connected' || !frame) return null;
    const { left, top, width, height } = canvas.getBoundingClientRect();
    if (e.clientX < left || e.clientX >= left + width || e.clientY < top || e.clientY >= top + height) return null;
    return { frame, rect: { left, top, width, height } };
  };
  const point = (e) => ({ x: e.clientX, y: e.clientY });
  const send = (op, data) => {
    if (state === 'connected') api.send({ t: 'ipadInput', op, generation, ...data });
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const picture = pictureAt(e);
    if (!picture) return;
    if (e.button === 1) return send('home');
    if (e.button !== 0 || gesture) return;
    canvas.setPointerCapture(e.pointerId);
    gesture = { id: e.pointerId, began: performance.now(), picture, points: [point(e)] };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (gesture?.id !== e.pointerId) return;
    const picture = pictureAt(e);
    if (!picture || picture.frame !== gesture.picture.frame) { gesture = null; return; }
    const { points } = gesture;
    const last = points.at(-1);
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < (points.length === 1 ? 5 : 12)) return;
    if (points.length >= 23) points.splice(1, 1);
    points.push(point(e));
  });

  canvas.addEventListener('pointerup', (e) => {
    if (gesture?.id !== e.pointerId) return;
    const { points, began, picture } = gesture;
    gesture = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const end = pictureAt(e);
    if (!end || end.frame !== picture.frame || Object.keys(end.rect).some((key) => end.rect[key] !== picture.rect[key])) return;
    if (points.length > 1 || Math.hypot(e.clientX - points[0].x, e.clientY - points[0].y) >= 5) points.push(point(e));
    send('gesture', { ...picture.frame, rect: picture.rect, points, duration: performance.now() - began });
  });
  canvas.addEventListener('pointercancel', () => { gesture = null; });
  canvas.addEventListener('lostpointercapture', () => { gesture = null; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!pictureAt(e) || e.ctrlKey) return;
    const scale = e.deltaMode === 1 ? 25 : e.deltaMode === 2 ? 180 : 1;
    if (!scroll) {
      const batch = { dx: 0, dy: 0, event: e, frame: displayedFrame() };
      scroll = batch;
      setTimeout(() => {
        if (scroll !== batch) return;
        scroll = null;
        const picture = pictureAt(batch.event);
        if (picture?.frame === batch.frame) {
          send('scroll', { ...picture.frame, rect: picture.rect, dx: batch.dx, dy: batch.dy, points: [point(batch.event)] });
        }
      }, 45);
    }
    scroll.dx += e.deltaX * scale;
    scroll.dy += e.deltaY * scale;
    scroll.event = e;
  }, { passive: false });

  canvas.addEventListener('keydown', (e) => {
    if (state !== 'connected' || e.metaKey || e.ctrlKey || e.isComposing) return;
    if (e.key !== 'Tab') e.preventDefault();
    send('key', { key: e.key, down: true });
  });
  window.addEventListener('blur', () => { gesture = scroll = null; });
  return { home: () => send('home') };
};
