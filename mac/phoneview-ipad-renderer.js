// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

window.PhoneViewIPad = (api, I, canvas, displayedFrame) => {
  let state = 'off';
  let generation;
  let gesture;
  let pendingTap;
  let scroll;
  const doubleClickMs = 220;
  const wheelBatchMs = 40;
  const maxWheelDelta = 175;

  document.body.classList.add('ipad');
  document.getElementById('ipad-controls').hidden = false;
  const button = document.getElementById('ipad-control');
  const status = document.getElementById('ipad-control-status');
  const pointer = document.getElementById('ipad-pointer');
  const shortcuts = document.getElementById('ipad-shortcuts');
  document.getElementById('ipad-spotlight').onclick = () => send('spotlight');
  document.getElementById('ipad-volume-down').onclick = () => send('volumeDown');
  document.getElementById('ipad-volume-up').onclick = () => send('volumeUp');
  button.onclick = () => api.send({ t: 'ipadControl', on: state !== 'starting' && state !== 'connected' });
  const copy = {
    starting: ['Connecting…'], connected: ['Connected'], picture: ['Waiting for video', 'Wait for the iPad’s screen to appear.'],
    setup: ['Set up XCUITest', 'Stage the signed XCUITest runner in this TwinDesk profile’s ipad-control folder.'],
    device: ['iPad unavailable', 'Check the iPad’s developer pairing in Xcode.'],
    developerMode: ['Developer Mode off', 'On the iPad, open Settings › Privacy & Security › Developer Mode.'],
    route: ['No developer route', 'Check the associated iPad’s paired Wi-Fi connection in Xcode, or use trusted USB.'],
    busy: ['iPad control busy', 'Stop control in the other window or wait for its session to close.'],
    endpoint: ['Runner mismatch', 'Check the staged TwinDesk XCUITest runner.'],
    startup: ['Couldn’t start control', 'Check Xcode provisioning, unlock the iPad and check Settings › Developer › Enable UI Automation.'],
    lost: ['Control disconnected', 'Reopen the iPad viewer and choose Control this iPad again.'],
  };
  api.on('opts', (m) => {
    if (m?.minimized === true) clearInput();
    if (!m?.ipadState) return;
    state = m.ipadState;
    generation = m.ipadGeneration;
    clearInput();
    const connected = state === 'connected';
    document.body.classList.toggle('ipad-connected', connected);
    shortcuts.hidden = !connected;
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

  const samePicture = (a, b) => a && b && a.frame === b.frame
    && Object.keys(a.rect).every((key) => a.rect[key] === b.rect[key]);
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const sendAt = (op, picture, points, data) => send(op, { ...picture.frame, rect: picture.rect, points, ...data });

  function showPointer(e, picture) {
    pointer.hidden = !picture;
    canvas.classList.toggle('ipad-pointer-visible', !!picture);
    if (picture) pointer.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }

  function clearGesture() {
    const id = gesture?.id;
    gesture = null;
    if (id != null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }

  function clearInput() {
    clearGesture();
    clearTimeout(pendingTap?.timer);
    clearTimeout(scroll?.timer);
    pendingTap = scroll = null;
    showPointer(null, null);
  }

  function flushTap() {
    const tap = pendingTap;
    if (!tap) return;
    pendingTap = null;
    clearTimeout(tap.timer);
    if (samePicture(tap.picture, pictureAt(tap.event))) sendAt('gesture', tap.picture, [point(tap.event)]);
  }

  canvas.addEventListener('pointerenter', (e) => showPointer(e, pictureAt(e)));
  canvas.addEventListener('pointerleave', () => showPointer(null, null));

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const picture = pictureAt(e);
    showPointer(e, picture);
    if (!picture) return;
    if (e.button === 1) return send('home');
    if (e.button !== 0 && e.button !== 2) return;
    if (gesture) return;
    const right = e.button === 2 || e.ctrlKey;
    canvas.setPointerCapture(e.pointerId);
    gesture = { id: e.pointerId, began: performance.now(), picture, right, points: [point(e)] };
  });

  canvas.addEventListener('pointermove', (e) => {
    const picture = pictureAt(e);
    showPointer(e, picture);
    if (gesture?.id !== e.pointerId) return;
    if (!samePicture(gesture.picture, picture)) return clearGesture();
    const { points, right } = gesture;
    if (right) return;
    const next = point(e);
    if (distance(next, points.at(-1)) < (points.length === 1 ? 5 : 12)) return;
    if (points.length >= 23) points.splice(1, 1);
    points.push(next);
  });

  canvas.addEventListener('pointerup', (e) => {
    if (gesture?.id !== e.pointerId) return;
    const { points, began, picture, right } = gesture;
    clearGesture();
    const end = pictureAt(e);
    if (!samePicture(picture, end)) return;
    const duration = performance.now() - began;
    const at = point(e);
    const moved = points.length > 1 || distance(at, points[0]) >= 5;
    if (right || (duration >= 480 && !moved)) {
      flushTap();
      if (distance(at, points[0]) < 12) sendAt('longPress', picture, points);
      return;
    }
    if (moved) {
      flushTap();
      if (distance(at, points.at(-1)) > 0) points.push(at);
      return sendAt('gesture', picture, points, { duration });
    }
    if (pendingTap && samePicture(pendingTap.picture, picture) && distance(point(pendingTap.event), at) < 12) {
      clearTimeout(pendingTap.timer);
      pendingTap = null;
      return sendAt('doubleTap', picture, [at]);
    }
    flushTap();
    pendingTap = { picture, event: e, timer: setTimeout(flushTap, doubleClickMs) };
  });
  canvas.addEventListener('pointercancel', clearGesture);
  canvas.addEventListener('lostpointercapture', (e) => { if (gesture?.id === e.pointerId) gesture = null; });
  canvas.addEventListener('contextmenu', (e) => { if (state === 'connected') e.preventDefault(); });

  const clampWheel = (d) => Math.max(-maxWheelDelta, Math.min(maxWheelDelta, d));
  canvas.addEventListener('wheel', (e) => {
    const picture = pictureAt(e);
    if (!picture) return;
    e.preventDefault();
    if (e.ctrlKey || gesture || !Number.isFinite(e.deltaX) || !Number.isFinite(e.deltaY)) return;
    const scale = e.deltaMode === 1 ? 25 : e.deltaMode === 2 ? 180 : 1;
    if (scroll && !samePicture(scroll.picture, picture)) {
      clearTimeout(scroll.timer);
      scroll = null;
    }
    if (!scroll) {
      scroll = { dx: 0, dy: 0, picture, timer: setTimeout(() => {
        const batch = scroll;
        scroll = null;
        if (batch && samePicture(batch.picture, pictureAt(batch.event))) {
          sendAt('scroll', batch.picture, [point(batch.event)], { dx: batch.dx, dy: batch.dy });
        }
      }, wheelBatchMs) };
    }
    scroll.dx = clampWheel(scroll.dx + e.deltaX * scale);
    scroll.dy = clampWheel(scroll.dy + e.deltaY * scale);
    scroll.event = e;
  }, { passive: false });

  const special = new Set(['Backspace', 'Delete', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'PageUp', 'PageDown', 'Home', 'End']);
  canvas.addEventListener('keydown', (e) => {
    if (state !== 'connected' || e.metaKey || e.ctrlKey || e.isComposing || (e.shiftKey && e.key === 'Tab')) return;
    if (e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') {
      e.preventDefault();
      return send(e.key === 'AudioVolumeUp' ? 'volumeUp' : 'volumeDown');
    }
    if (!special.has(e.key) && Array.from(e.key).length !== 1) return;
    e.preventDefault();
    send('key', { key: e.key, down: true, shift: e.shiftKey, alt: e.altKey });
  });
  canvas.addEventListener('blur', () => {
    clearInput();
    send('cancel');
  });
  window.addEventListener('blur', clearInput);
  api.on('size', clearInput);
  api.on('status', (m) => { if (m.closed || m.error) clearInput(); });
  return { home: () => send('home') };
};
