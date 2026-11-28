// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos page (Mac, PC and Linux): the phone's photos and videos, newest first, a page at a
// time; small pictures only for the tiles on screen; click one to see it big; Save copies the
// files here (into Downloads, as Send does); Remove deletes them from the phone (asks once more
// here; without All files access the phone shows Android's own confirmation too). On USB, Wi-Fi or Wi-Fi Direct; over Bluetooth it says
// so and loads nothing (thumbnails there slowed everything else down).
// On a computer that has it (hub.canMediaAlerts) with a phone that does (media.alerts): a switch for
// a notification here when the phone's camera takes a photo or a video (how many, nothing loaded).
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

UI.tab({
  id: 'media',
  group: 'Phone',
  order: 7,
  title: tr('Photos'),
  icon: 'photo',
  color: 'linear-gradient(#ffd60a, #ff9f0a)',
  desc: tr('See your phone’s photos and videos and copy them here.'),
  for: ['android', 'ios'], // a phone's: Android, iPhone or iPad (shared/ui-kinds.js)
  wifiOnly: true, // pictures are too big for Bluetooth: Connect with Wi-Fi Direct on top, nothing loads
  master: { get: (s) => !!(s.hub && s.hub.media), set: (v) => UI.api.hub({ do: 'set', what: 'media', on: v }) },
  badge: (s) => (s.hub && s.hub.media ? 'on' : ''),
  build(body, page) {
    const { el } = UI;
    const top = UI.hubTop('media');
    let kind = 'all';
    const filter = UI.segmented([
      { value: 'all', label: tr('All') }, { value: 'photos', label: tr('Photos') }, { value: 'videos', label: tr('Videos') }, { value: 'screenshots', label: tr('Screenshots') },
    ], (v) => { kind = v; filter.set(v); reset(); });
    filter.set(kind);
    const MAX_SELECTED = 300; // matches shared/phonehub.js ask() ids() cap
    const MIN_ZOOM = 1;
    const MAX_ZOOM = 4;
    const DOUBLE_CLICK_ZOOM = 2;
    const DRAG_THRESHOLD = 6;
    const selectBtn = UI.button(tr('Select'), () => {
      cancelDrag();
      selecting = !selecting;
      if (!selecting) { chosen.clear(); pickedDay = ''; selectionLimitNote = false; }
      paint();
    }, 'small');
    const saveBtn = UI.button(tr('Save'), () => save([...chosen]), 'primary small');
    // Remove asks once more (its label turns into the question), as Files' Delete does.
    let confirmRemove = null;
    const removeBtn = UI.button(tr('Remove'), () => {
      confirmRemove = confirmDeletion([...chosen], confirmRemove);
      paintRemoveBtn();
    }, 'small');
    const canRemove = () => !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.media && UI.state.hub.perm.media.remove);
    const samePhone = (a, b) => !!a && !!b && a.deviceId === b.deviceId && a.session === b.session;
    const canTrash = () => canRemove() && !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.media && UI.state.hub.perm.media.trash);
    const status = el('span', { class: 'hint hub-media-status', attrs: { 'data-literal': '', role: 'status', 'aria-live': 'polite' } });
    const daySelect = el('select', { class: 'hub-media-day-select', attrs: { 'aria-label': tr('Loaded day to select'), 'aria-describedby': 'hub-media-limit', 'data-literal': '' } });
    daySelect.onchange = () => { pickedDay = daySelect.value; selectionLimitNote = false; paint(); };
    daySelect.onblur = () => paint();
    const dayBtn = UI.button(tr('Select loaded day'), () => selectDay(), 'small');
    dayBtn.title = tr('Select loaded items for the chosen day');
    const selectionLimit = el('span', { class: 'hint hub-media-limit', attrs: { id: 'hub-media-limit', 'data-literal': '', role: 'status' } });
    const dayWrap = el('span', { class: 'hub-media-day', hidden: true }, [daySelect, dayBtn]);
    const folderBtn = UI.saveFolderButton();
    const bar = el('div', { class: 'hub-media-bar' }, [filter.el, el('span', { class: 'hub-grow' }), status, dayWrap, folderBtn, removeBtn, saveBtn, selectBtn, selectionLimit]);
    const grid = el('div', { class: 'hub-grid' });
    const dragBox = el('div', { class: 'hub-drag-box', hidden: true, attrs: { 'aria-hidden': 'true' } });
    const sentinel = el('div', { class: 'hub-sentinel' });
    // Albums (a phone that lists them: media.albums): All, then each with its cover and count. The
    // filters above work inside the one picked.
    let album = ''; // '' all; else the album's id
    let albums = []; // {id, name, n, cover}
    const covers = new Set(); // cover ids still to get
    const albumList = el('div', { class: 'hub-albums', hidden: true, attrs: { role: 'listbox', 'aria-label': tr('Albums') } });
    const main = el('div', { class: 'hub-media-main' }, [bar, grid, sentinel]);
    const wrap = el('div', { class: 'hub-media' }, [albumList, main]);
    function paintAlbums() {
      albumList.hidden = !albums.length;
      wrap.classList.toggle('with-albums', !!albums.length);
      if (!albums.length) return;
      const total = albums.reduce((a, x) => a + x.n, 0);
      const row = (id, name, n, cover) => {
        const pic = el('span', { class: 'hub-album-pic' + (cover ? '' : ' all') });
        if (cover && thumbs.get(cover)) pic.style.backgroundImage = `url("${thumbs.get(cover)}")`;
        if (cover) pic.dataset.cover = cover;
        const b = el('button', { class: 'hub-album' + (album === id ? ' on' : ''), attrs: { role: 'option', 'aria-selected': String(album === id), 'data-literal': '' } }, [
          pic, el('span', { class: 'hub-album-text' }, [el('span', { class: 'hub-album-name', text: name }), el('span', { class: 'hub-album-n', text: String(n) })]),
        ]);
        b.onclick = () => { if (album === id) return; album = id; paintAlbums(); reset(); };
        return b;
      };
      albumList.replaceChildren(row('', tr('All'), total, ''), ...albums.map((a) => row(a.id, a.name, a.n, a.cover)));
    }

    // The viewer: one big, with its name and Save.
    const bigImg = el('img', { class: 'hub-big', alt: '', draggable: false });
    const bigName = el('div', { class: 'hub-big-name', attrs: { 'data-literal': '' } });
    const bigSub = el('div', { class: 'hint', attrs: { 'data-literal': '' } });
    const prev = UI.button('‹', () => step(-1));
    const next = UI.button('›', () => step(1));
    const bigSave = UI.button(tr('Save'), () => viewing && save([viewing.id]), 'primary');
    const bigSaveAs = UI.button(tr('Save As…'), () => {
      if (viewing && !viewing.video && viewing.saveKey) {
        UI.api.hub({ do: 'savePhotoAs', id: viewing.id, name: viewing.name, key: viewing.saveKey });
      }
    });
    bigSaveAs.hidden = true;
    let confirmBig = null;
    const bigRemove = UI.button(tr('Remove'), () => {
      if (!viewing) return;
      confirmBig = confirmDeletion([viewing.id], confirmBig);
      paintBig();
    });
    // Copy and Share: the picture shown (the phone's large one, up to 1600 px), once it's here.
    let bigData = ''; // that picture, a data: URL ('' while it comes)
    const bigCopy = UI.button(tr('Copy'), () => {
      if (!viewing || !bigData) return;
      Promise.resolve(UI.api.hub({ do: 'copyImage', data: bigData })).then(() => {
        bigCopy.textContent = tr('Copied');
        setTimeout(() => { bigCopy.textContent = tr('Copy'); }, 1500);
      }).catch(() => {});
    });
    const bigShare = UI.button(tr('Share'), () => {
      if (!viewing || !bigData) return;
      UI.api.hub({ do: 'shareImage', data: bigData, name: viewing.name });
    });
    // Open: in this computer's own app for pictures; on Windows also Open with (its list of apps).
    const bigOpen = UI.button(tr('Open'), () => viewing && bigData && UI.api.hub({ do: 'openImage', data: bigData, name: viewing.name }));
    bigOpen.title = tr('Open it in this computer’s app for pictures');
    const winPc = /Win/.test(navigator.platform || navigator.userAgent);
    const bigOpenWith = UI.button(tr('Open with…'), () => viewing && bigData && UI.api.hub({ do: 'openImage', data: bigData, name: viewing.name, with: true }));
    const closeBtn = UI.button(tr('Close'), () => view(null));
    const viewerStage = el('div', { class: 'hub-viewer-stage' }, [prev, bigImg, next]);
    const viewer = el('div', { class: 'hub-viewer', hidden: true }, [
      viewerStage,
      el('div', { class: 'hub-viewer-bar' }, [el('div', { class: 'hub-grow' }, [bigName, bigSub]), bigRemove, bigCopy, bigOpen, bigOpenWith, bigShare, bigSave, bigSaveAs, closeBtn]),
    ]);
    // A notification here for new camera photos and videos: off until switched on, and shown only
    // where it works (this computer shows them, the connected phone tells them).
    const alertSw = UI.switch((v) => UI.api.hub({ do: 'opt', mediaAlerts: v }), { label: tr('Notify about new photos and videos') });
    const alertCard = UI.card('', [UI.row(tr('Notify about new photos and videos'),
      tr('Shows a notification on {me} when the phone’s camera takes a photo or a video, not for screenshots or pictures saved from elsewhere. Nothing is copied here until you save it.'), [alertSw])]);
    alertCard.hidden = true;
    // New camera photos into a folder on this Mac. Only the direct Mac window has state.photoBackup,
    // so mesh, Windows and Linux keep this card hidden. Save and the count notification are unchanged.
    const backup = (arg) => UI.api.photoBackup({ ...arg, generation: UI.state.photoBackup?.generation });
    const backupSw = UI.switch((v) => backup({ do: 'on', on: v }), { label: tr('Back up new camera photos') });
    const backupChoose = UI.button(tr('Choose…'), () => backup({ do: 'folder' }), 'small');
    const backupRow = UI.row(tr('Back up new camera photos'), '', [backupSw], { literalHint: true });
    const folderRow = UI.row(tr('Folder'), '', [backupChoose], { literalHint: true });
    const backupCard = UI.card('', [backupRow, folderRow]);
    backupCard.hidden = true;
    body.append(top.el, alertCard, backupCard, wrap, viewer);

    let items = []; // {id, video, at, w, h, size, name, dur, album}
    let nextKey = '';
    let more = false;
    let asking = false;
    let selecting = false;
    let pickedDay = '';
    let daySig = '';
    let selectionLimitNote = false;
    const chosen = new Set();
    const thumbs = new Map(); // id -> data: URL ('' asked)
    let thumbsPhone = null;
    const tiles = new Map(); // id -> tile element
    let viewing = null;
    let galleryPhone = null; // the phone and session that populated the current results
    let zoom = MIN_ZOOM;
    let panX = 0;
    let panY = 0;
    let panning = null;
    let drag = null;
    let suppressClick = false;
    const scrollRoot = document.getElementById('content');

    function isButtonTarget(target) {
      if (!target) return false;
      if (target === prev || target === next) return true;
      return typeof target.closest === 'function' ? !!target.closest('button') : target.tag === 'button' || target.tagName === 'BUTTON';
    }

    function applyZoom() {
      viewerStage.classList.toggle('zoomed', zoom > MIN_ZOOM);
      viewerStage.classList.toggle('panning', !!panning);
      if (zoom <= MIN_ZOOM) {
        bigImg.style.transform = '';
      } else {
        const px = Math.round(panX * 100) / 100;
        const py = Math.round(panY * 100) / 100;
        const z = Math.round(zoom * 1000) / 1000;
        bigImg.style.transform = `translate3d(${px}px, ${py}px, 0) scale(${z})`;
      }
    }

    function zoomMetrics() {
      const ir = typeof bigImg.getBoundingClientRect === 'function' ? bigImg.getBoundingClientRect() : null;
      const sr = typeof viewerStage.getBoundingClientRect === 'function' ? viewerStage.getBoundingClientRect() : null;
      const baseW = ir && ir.width > 0 ? ir.width / zoom : 0;
      const baseH = ir && ir.height > 0 ? ir.height / zoom : 0;
      const centerX = ir ? (ir.left + ir.width / 2) - panX : 0;
      const centerY = ir ? (ir.top + ir.height / 2) - panY : 0;
      const stageW = sr && sr.width > 0 ? sr.width : baseW;
      const stageH = sr && sr.height > 0 ? sr.height : baseH;
      return { baseW, baseH, centerX, centerY, stageW, stageH };
    }

    function clampPan(nx, ny, nz, m) {
      if (nz <= MIN_ZOOM || m.baseW <= 0 || m.baseH <= 0) return [0, 0];
      const maxX = Math.max(0, (m.baseW * nz - m.stageW) / 2);
      const maxY = Math.max(0, (m.baseH * nz - m.stageH) / 2);
      return [
        Math.max(-maxX, Math.min(maxX, nx)),
        Math.max(-maxY, Math.min(maxY, ny)),
      ];
    }

    function endPan() {
      if (!panning) return;
      const id = panning.id;
      panning = null;
      try { viewerStage.releasePointerCapture?.(id); } catch (_) {}
      applyZoom();
    }

    function resetZoom() {
      endPan();
      zoom = MIN_ZOOM;
      panX = 0;
      panY = 0;
      applyZoom();
    }

    function zoomAt(nextZoom, clientX, clientY) {
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
      if (nz < 1.01) { resetZoom(); return; }
      const m = zoomMetrics();
      let nx = panX;
      let ny = panY;
      if (m.baseW > 0 && m.baseH > 0 && Number.isFinite(clientX) && Number.isFinite(clientY)) {
        const dx = (clientX - m.centerX - panX) / zoom;
        const dy = (clientY - m.centerY - panY) / zoom;
        nx = clientX - m.centerX - nz * dx;
        ny = clientY - m.centerY - nz * dy;
      }
      [panX, panY] = clampPan(nx, ny, nz, m);
      zoom = nz;
      applyZoom();
    }

    viewerStage.addEventListener?.('wheel', (e) => {
      if (viewer.hidden || !viewing || isButtonTarget(e.target)) return;
      e.preventDefault?.();
      if (panning) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (!Number.isFinite(dy) || dy === 0) return;
      const factor = Math.exp(-Math.max(-240, Math.min(240, dy)) * 0.003);
      zoomAt(zoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    viewerStage.addEventListener?.('dblclick', (e) => {
      if (viewer.hidden || !viewing || isButtonTarget(e.target)) return;
      e.preventDefault?.();
      if (zoom > MIN_ZOOM) resetZoom();
      else zoomAt(DOUBLE_CLICK_ZOOM, e.clientX, e.clientY);
    });

    viewerStage.addEventListener?.('pointerdown', (e) => {
      if (viewer.hidden || !viewing || zoom <= MIN_ZOOM || e.button !== 0 || isButtonTarget(e.target)) return;
      panning = { id: e.pointerId, startX: e.clientX, startY: e.clientY, basePanX: panX, basePanY: panY };
      try { viewerStage.setPointerCapture?.(e.pointerId); } catch (_) {}
      e.preventDefault?.();
      applyZoom();
    });

    viewerStage.addEventListener?.('pointermove', (e) => {
      if (!panning || e.pointerId !== panning.id) return;
      const m = zoomMetrics();
      [panX, panY] = clampPan(
        panning.basePanX + (e.clientX - panning.startX),
        panning.basePanY + (e.clientY - panning.startY),
        zoom,
        m,
      );
      applyZoom();
    });

    const stopPanEvent = (e) => {
      if (panning && (e.pointerId === undefined || e.pointerId === panning.id)) endPan();
    };
    viewerStage.addEventListener?.('pointerup', stopPanEvent);
    viewerStage.addEventListener?.('pointercancel', stopPanEvent);
    viewerStage.addEventListener?.('lostpointercapture', stopPanEvent);
    window.addEventListener?.('resize', () => {
      if (viewer.hidden || zoom <= MIN_ZOOM) return;
      const m = zoomMetrics();
      [panX, panY] = clampPan(panX, panY, zoom, m);
      applyZoom();
    });

    function clearDragHits() {
      if (!drag || !drag.hitIds) return;
      for (const id of drag.hitIds) tiles.get(id)?.classList.remove('drag-hit');
      drag.hitIds.clear();
    }

    function onDragScroll() {
      if (drag && drag.active) updateDrag(drag.lastX, drag.lastY);
    }

    function updateDrag(clientX, clientY) {
      if (!drag) return;
      const gr = typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null;
      if (!gr || gr.width <= 0 || gr.height <= 0) return;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const x1 = clamp(gr.left + drag.anchorX, gr.left, gr.right);
      const y1 = clamp(gr.top + drag.anchorY, gr.top, gr.bottom);
      const x2 = clamp(clientX, gr.left, gr.right);
      const y2 = clamp(clientY, gr.top, gr.bottom);
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      dragBox.style.left = `${left - gr.left}px`;
      dragBox.style.top = `${top - gr.top}px`;
      dragBox.style.width = `${right - left}px`;
      dragBox.style.height = `${bottom - top}px`;
      const add = [];
      for (const it of items) {
        const t = tiles.get(it.id);
        if (!t || typeof t.getBoundingClientRect !== 'function') continue;
        const r = t.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) continue;
        if (r.right > left && r.left < right && r.bottom > top && r.top < bottom) {
          if (!drag.baseChosen.has(it.id)) add.push(it.id);
        }
      }
      const exceeds = drag.baseChosen.size + add.length > MAX_SELECTED;
      clearDragHits();
      drag.add = add;
      drag.exceeds = exceeds;
      drag.hitIds = new Set(exceeds ? [] : add);
      for (const id of drag.hitIds) tiles.get(id)?.classList.add('drag-hit');
      warnSelectionLimit(exceeds);
    }

    function cancelDrag() {
      if (!drag) return;
      const id = drag.id;
      scrollRoot?.removeEventListener?.('scroll', onDragScroll);
      try { grid.releasePointerCapture?.(id); } catch (_) {}
      clearDragHits();
      dragBox.hidden = true;
      grid.classList.remove('dragging');
      drag = null;
      paint();
    }

    function finishDrag() {
      if (!drag) return;
      const { id, active, add, exceeds } = drag;
      scrollRoot?.removeEventListener?.('scroll', onDragScroll);
      try { grid.releasePointerCapture?.(id); } catch (_) {}
      clearDragHits();
      dragBox.hidden = true;
      grid.classList.remove('dragging');
      drag = null;
      if (!active) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (exceeds) {
        selectionLimitNote = true;
        paint();
        return;
      }
      const currentHits = add.filter((itemId) => tiles.has(itemId));
      if (currentHits.length) {
        for (const itemId of currentHits) chosen.add(itemId);
        selectionLimitNote = false;
        confirmRemove = null;
      }
      paint();
    }

    grid.addEventListener?.('click', (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation?.();
      e.preventDefault?.();
    }, true);

    grid.addEventListener?.('pointerdown', (e) => {
      if (!selecting || e.button !== 0 || !items.length) return;
      const gr = typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null;
      if (!gr || gr.width <= 0 || gr.height <= 0) return;
      cancelDrag();
      drag = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        anchorX: e.clientX - gr.left,
        anchorY: e.clientY - gr.top,
        active: false,
        baseChosen: new Set(chosen),
        add: [],
        hitIds: new Set(),
        exceeds: false,
      };
    });

    grid.addEventListener?.('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!(e.buttons & 1)) return cancelDrag();
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.active = true;
        if (dragBox.parentNode !== grid) grid.append(dragBox);
        dragBox.hidden = false;
        grid.classList.add('dragging');
        try { grid.setPointerCapture?.(drag.id); } catch (_) {}
        scrollRoot?.addEventListener?.('scroll', onDragScroll, { passive: true });
      }
      e.preventDefault?.();
      updateDrag(e.clientX, e.clientY);
    });

    grid.addEventListener?.('pointerup', (e) => {
      if (drag && e.pointerId === drag.id && e.button === 0) finishDrag();
    });

    const cancelDragEvent = (e) => {
      if (drag && (e.pointerId === undefined || e.pointerId === drag.id)) cancelDrag();
    };
    grid.addEventListener?.('pointercancel', cancelDragEvent);
    grid.addEventListener?.('lostpointercapture', cancelDragEvent);

    function dayKeyOf(it) {
      const n = Number(it && it.at);
      if (!Number.isFinite(n) || n <= 0) return '';
      const d = new Date(n);
      if (Number.isNaN(d.getTime())) return '';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function dayLabelOf(at) {
      const d = new Date(Number(at));
      try {
        return d.toLocaleDateString(window.I18n ? window.I18n.locale : undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch (_) {
        return d.toLocaleDateString();
      }
    }

    // Group currently loaded items by local-calendar day without changing list order or fetching more pages.
    function loadedDays() {
      const byDay = new Map();
      for (const it of items) {
        const key = dayKeyOf(it);
        if (!key) continue;
        let g = byDay.get(key);
        if (!g) { g = { key, label: dayLabelOf(it.at), ids: [] }; byDay.set(key, g); }
        g.ids.push(it.id);
      }
      return [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key));
    }

    function daySelection(key, days) {
      const day = days.find((d) => d.key === key);
      const add = day ? day.ids.filter((id) => !chosen.has(id)) : [];
      return { add, exceeds: chosen.size + add.length > MAX_SELECTED };
    }

    function selectDay() {
      if (!selecting) return;
      const sel = daySelection(pickedDay, loadedDays());
      if (!sel.add.length) return;
      if (sel.exceeds) { paint(); return; }
      for (const id of sel.add) chosen.add(id);
      selectionLimitNote = false;
      confirmRemove = null;
      paint();
    }

    function tile(it) {
      const img = el('img', { alt: '', draggable: false });
      if (thumbs.get(it.id)) img.src = thumbs.get(it.id);
      const t = el('button', { class: 'hub-tile', attrs: { 'data-literal': '' }, title: `${it.name}\n${new Date(it.at).toLocaleString()}` }, [img,
        it.video ? el('span', { class: 'hub-dur', text: it.dur ? UI.duration(it.dur / 1000) : tr('Video') }) : null,
        el('span', { class: 'hub-check' })]);
      t.dataset.id = it.id;
      t.onclick = () => {
        if (!selecting) return view(it);
        if (chosen.has(it.id)) {
          chosen.delete(it.id);
        } else {
          if (chosen.size >= MAX_SELECTED) {
            selectionLimitNote = true;
            warnSelectionLimit(true);
            return;
          }
          chosen.add(it.id);
        }
        selectionLimitNote = false;
        confirmRemove = null;
        paint();
      };
      tiles.set(it.id, t);
      seen.observe(t);
      return t;
    }

    function warnSelectionLimit(show) {
      selectionLimit.textContent = show ? tr('Can’t select more than {max} items at once', { max: MAX_SELECTED }) : '';
    }

    function paintRemoveBtn() {
      removeBtn.hidden = !selecting || !canRemove();
      removeBtn.disabled = !chosen.size;
      const count = confirmRemove?.ids.length;
      removeBtn.textContent = confirmRemove
        ? tr(confirmRemove.trash
          ? (count === 1 ? 'Move 1 item to Trash?' : 'Move {count} items to Trash?')
          : (count === 1 ? 'Remove 1 item from the phone?' : 'Remove {count} items from the phone?'), { count })
        : tr(canTrash() ? 'Move to Trash' : 'Remove');
      removeBtn.classList.toggle('danger', !!confirmRemove);
    }

    function paint() {
      wrap.classList.toggle('selecting', selecting);
      if (!selecting || !chosen.size) confirmRemove = null;
      const days = selecting ? loadedDays() : [];
      if (!days.some((d) => d.key === pickedDay)) pickedDay = days[0]?.key || '';
      if (selecting && document.activeElement !== daySelect) {
        const sig = days.map((d) => `${d.key}:${d.ids.length}:${d.label}`).join('|');
        if (sig !== daySig) {
          daySig = sig;
          daySelect.replaceChildren(...days.map((d) => el('option', {
            value: d.key,
            text: tr('{day} ({count} loaded)', { day: d.label, count: d.ids.length }),
          })));
        }
        daySelect.value = pickedDay;
      }
      const sel = selecting ? daySelection(pickedDay, days) : null;
      const exceeds = !!(sel && sel.exceeds);
      dayWrap.hidden = !selecting || !days.length;
      dayBtn.disabled = !sel || !sel.add.length || exceeds;
      warnSelectionLimit(exceeds || selectionLimitNote);
      paintRemoveBtn();
      selectBtn.textContent = selecting ? tr('Done') : tr('Select');
      saveBtn.hidden = !selecting;
      saveBtn.disabled = !chosen.size;
      saveBtn.textContent = chosen.size ? tr('Save {count} to {me}', { count: chosen.size, me: UI.fill('{me}') }) : tr('Save');
      for (const [id, t] of tiles) t.classList.toggle('chosen', chosen.has(id));
      status.textContent = items.length ? tr(kind === 'videos' ? '{count} videos' : kind === 'photos' ? '{count} photos' : kind === 'screenshots' ? '{count} screenshots' : '{count} items', { count: `${items.length}${more ? '+' : ''}` }) : '';
    }

    // The tiles on screen get their pictures, those first (what scrolled past is dropped).
    const visible = new Set();
    let thumbTimer = 0;
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.dataset.id); else visible.delete(e.target.dataset.id);
      }
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => {
        if (UI.onBle(UI.state)) return; // over Bluetooth: none
        const ids = [...visible].filter((id) => !thumbs.has(id));
        // A little ahead too: the next row or two below.
        const last = items.findIndex((x) => x.id === [...visible].pop());
        if (last >= 0) for (const x of items.slice(last + 1, last + 13)) if (!thumbs.has(x.id) && !ids.includes(x.id)) ids.push(x.id);
        for (const id of covers) if (!thumbs.get(id) && !ids.includes(id)) ids.push(id); // the albums' covers too, till they come
        for (const id of ids) if (!thumbs.has(id)) thumbs.set(id, '');
        if (ids.length) UI.hubAsk({ t: 'media.thumb', ids });
      }, 120);
    }, { root: document.getElementById('content'), rootMargin: '200px 0px' });
    const askCovers = () => {
      if (UI.onBle(UI.state) || !covers.size) return;
      const ids = [...visible].filter((id) => !thumbs.get(id)).concat([...covers].filter((id) => !thumbs.get(id)));
      if (ids.length) UI.hubAsk({ t: 'media.thumb', ids });
    };

    const end = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && more && !asking) page1();
    }, { root: document.getElementById('content'), rootMargin: '600px 0px' });
    end.observe(sentinel);

    function page1() {
      if (UI.onBle(UI.state)) return;
      asking = true;
      UI.hubAsk({ t: 'media.list', kind, before: nextKey, n: 120, ...(album ? { album } : {}) });
    }

    function reset(request = UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state)) {
      cancelDrag();
      resetZoom();
      items = [];
      galleryPhone = null;
      nextKey = '';
      more = false;
      pickedDay = '';
      daySig = '';
      selectionLimitNote = false;
      confirmRemove = null;
      chosen.clear();
      for (const t of tiles.values()) seen.unobserve(t);
      tiles.clear();
      visible.clear();
      grid.replaceChildren();
      paint();
      if (request) page1();
    }

    function save(ids) {
      if (!ids.length) return;
      UI.hubAsk({ t: 'media.save', ids });
      status.textContent = tr('Saving {count} to {me}’s {folder}…', { count: ids.length, me: UI.fill('{me}'), folder: UI.receivedName(UI.state) });
      if (selecting) { cancelDrag(); selecting = false; chosen.clear(); pickedDay = ''; selectionLimitNote = false; }
      paint();
    }

    function phoneOf() {
      const { deviceId, session } = UI.state?.hub || {};
      return deviceId && Number.isSafeInteger(session) ? { deviceId, session } : null;
    }

    function confirmDeletion(ids, armed) {
      const phone = phoneOf();
      const trash = canTrash();
      if (!samePhone(phone, galleryPhone)) {
        view(null);
        clearThumbs();
        reset();
        return null;
      }
      if (!canRemove() || !ids.length) return null;
      if (!armed) return { phone, trash, ids };
      if (!samePhone(phone, armed.phone) || trash !== armed.trash ||
          ids.length !== armed.ids.length || ids.some((id, i) => id !== armed.ids[i])) return null;

      if (selecting) {
        cancelDrag();
        selecting = false;
        chosen.clear();
        pickedDay = '';
        selectionLimitNote = false;
      }
      confirmRemove = confirmBig = null;
      paint();
      paintBig();
      status.textContent = tr(trash ? 'Moving {count} to Trash…' : 'Removing {count}…', { count: ids.length });
      void remove(armed);
      return null;
    }

    // Apply exactly the action that was shown at confirmation. The main process rechecks phone.
    async function remove({ ids, phone, trash }) {
      let sent;
      try {
        sent = await UI.hubAsk({ t: 'media.delete', ids, phone, ...(trash ? { action: 'trash' } : {}) });
      } catch (_) {
        sent = false;
      }
      if (sent === false && samePhone(phone, phoneOf())) {
        status.textContent = tr(trash ? '{count} couldn’t be moved to Trash' : '{count} couldn’t be removed', { count: ids.length });
      }
    }

    function drop(ids) {
      const gone = new Set(ids);
      if (!gone.size) return;
      let switchedViewing = false;
      if (viewing && gone.has(viewing.id)) {
        const i = items.indexOf(viewing);
        const nextIt = items.slice(i + 1).find((x) => !gone.has(x.id)) || items.slice(0, i).reverse().find((x) => !gone.has(x.id));
        view(nextIt || null);
        switchedViewing = true;
      }
      items = items.filter((x) => !gone.has(x.id));
      for (const id of gone) {
        const t = tiles.get(id);
        if (t) { seen.unobserve(t); t.remove(); }
        tiles.delete(id);
        thumbs.delete(id);
        visible.delete(id);
        chosen.delete(id);
      }
      if (!items.length && !more) grid.replaceChildren(el('div', { class: 'hub-empty', text: tr(kind === 'all' ? 'No photos or videos' : kind === 'videos' ? 'No videos' : kind === 'screenshots' ? 'No screenshots' : 'No photos') }));
      if (viewing) {
        const i = items.indexOf(viewing);
        prev.disabled = i <= 0;
        next.disabled = i < 0 || i >= items.length - 1;
        if (switchedViewing) paintBig();
      }
    }

    function view(it) {
      resetZoom();
      viewing = it;
      viewer.hidden = !it;
      confirmBig = null;
      bigData = '';
      paintBig();
      if (!it) return;
      if (thumbs.get(it.id)) bigImg.src = thumbs.get(it.id); else bigImg.removeAttribute('src');
      bigName.textContent = it.name;
      bigSub.textContent = [new Date(it.at).toLocaleString(), it.w && it.h ? `${it.w} × ${it.h}` : '', UI.bytes(it.size || 0), it.album].filter(Boolean).join(' · ');
      if (!UI.onBle(UI.state)) UI.hubAsk({ t: 'media.view', id: it.id });
      const i = items.indexOf(it);
      prev.disabled = i <= 0;
      next.disabled = i < 0 || i >= items.length - 1;
    }

    // Copy and Share: photos only (a video's is a still), Share where this computer has one.
    function paintBig() {
      const photo = !!viewing && !viewing.video;
      bigRemove.hidden = !viewing || !canRemove();
      bigRemove.textContent = tr(confirmBig
        ? (confirmBig.trash ? 'Move to Trash?' : 'Remove from the phone?')
        : (canTrash() ? 'Move to Trash' : 'Remove'));
      bigRemove.classList.toggle('danger', !!confirmBig);
      bigSaveAs.hidden = !photo || !viewing.saveKey || viewing.saveKey !== UI.state?.hub?.photoSaveKey;
      bigCopy.hidden = bigOpen.hidden = !photo;
      bigOpenWith.hidden = !photo || !winPc;
      bigOpen.disabled = bigOpenWith.disabled = !bigData;
      bigShare.hidden = !photo || !(UI.state && UI.state.hub && UI.state.hub.shareSheet);
      bigCopy.disabled = bigShare.disabled = !bigData;
    }

    function step(d) {
      const i = items.indexOf(viewing);
      const it = items[i + d];
      if (it) view(it);
      if (i + d >= items.length - 6 && more && !asking) page1();
    }

    document.addEventListener('keydown', (e) => {
      if (page.hidden) return;
      if (drag && e.key === 'Escape') { cancelDrag(); return; }
      if (viewer.hidden) return;
      if (e.key === 'Escape') view(null);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });

    function clearThumbs() {
      thumbs.clear();
      thumbsPhone = null;
    }

    function currentMediaReply(m) {
      if (!samePhone(phoneOf(), m.phone) || (galleryPhone && !samePhone(galleryPhone, m.phone))) return false;
      if (!samePhone(thumbsPhone, m.phone)) {
        clearThumbs();
        thumbsPhone = m.phone;
      }
      return true;
    }

    UI.hubOn('media.list', (m) => {
      if (m.kind !== kind || (m.before || '') !== nextKey || (m.album || '') !== album) return; // an answer for an older filter or album
      if (!currentMediaReply(m)) return;
      galleryPhone = m.phone;
      asking = false;
      let fresh = (m.items || []).filter((x) => x && x.id && !tiles.has(x.id));
      if (m.saveKey) fresh = fresh.map((it) => ({ ...it, saveKey: m.saveKey }));
      items = items.concat(fresh);
      more = !!m.more;
      nextKey = m.next || nextKey;
      grid.append(...fresh.map(tile));
      if (!items.length) grid.replaceChildren(el('div', { class: 'hub-empty', text: tr(kind === 'all' ? 'No photos or videos' : kind === 'videos' ? 'No videos' : kind === 'screenshots' ? 'No screenshots' : 'No photos') }));
      paint();
    });
    UI.hubOn('media.thumb', (m) => {
      if (!currentMediaReply(m)) return;
      if (!m.data) return;
      thumbs.set(m.id, m.data);
      if (covers.delete(m.id)) for (const p of albumList.querySelectorAll('[data-cover]')) if (p.dataset.cover === m.id) p.style.backgroundImage = `url("${m.data}")`;
      const t = tiles.get(m.id);
      if (t) t.querySelector('img').src = m.data;
      if (viewing && viewing.id === m.id && !bigImg.getAttribute('src')) bigImg.src = m.data;
    });
    UI.hubOn('media.albums', (m) => {
      if (!currentMediaReply(m)) return;
      albums = (Array.isArray(m.items) ? m.items : []).filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
        .map((a) => ({ id: a.id.slice(0, 24), name: a.name.slice(0, 100), n: Math.max(0, Number(a.n) || 0), cover: typeof a.cover === 'string' ? a.cover.slice(0, 40) : '' }));
      if (album && !albums.some((a) => a.id === album)) { album = ''; reset(); }
      for (const a of albums) if (a.cover && !thumbs.get(a.cover)) covers.add(a.cover);
      paintAlbums();
      askCovers();
    });
    UI.hubOn('media.delete', (m) => {
      if (!currentMediaReply(m)) return;
      const ids = Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string') : [];
      const trash = m.action === 'trash';
      drop(ids);
      paint();
      const notes = [];
      if (m.confirm > 0) notes.push(tr(trash ? 'Tap the notification on the phone to move {count} to Trash' : 'Tap the notification on the phone to remove {count} more', { count: m.confirm }));
      if (m.failed > 0) notes.push(tr(trash ? '{count} couldn’t be moved to Trash' : '{count} couldn’t be removed', { count: m.failed }));
      if (notes.length) status.textContent = notes.join(' · ');
      if (albums.length && (ids.length || !trash)) UI.hubAsk({ t: 'media.albums' }); // their counts
    });
    UI.hubOn('media.view', (m) => {
      if (!currentMediaReply(m)) return;
      if (!viewing || viewing.id !== m.id || !m.data) return;
      resetZoom();
      bigImg.src = m.data;
      bigData = m.data;
      paintBig();
    });

    let loaded = false;
    let saveKey = '';
    UI.onShown(page, (shown) => {
      if (!shown) { cancelDrag(); view(null); }
      else if (UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state) && !loaded) { loaded = true; reset(); UI.hubAsk({ t: 'media.albums' }); }
    });
    paint();
    UI.onDeviceChange(() => { // another device: its photos, not the previous one's
      view(null);
      clearThumbs();
      album = '';
      albums = [];
      covers.clear();
      selecting = false;
      loaded = !page.hidden && UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state);
      paintAlbums();
      reset(loaded);
      if (loaded) UI.hubAsk({ t: 'media.albums' });
    });

    function backupHint(b) {
      const name = b.name || '';
      if (b.peer === false) return tr('Update TwinDesk on {name} to back up camera photos.', { name });
      if (!b.on) return tr('New camera photos are copied into the folder you choose, by year and month, after you turn this on here and on {name}. The copy includes the photo’s location. Nothing is deleted or replaced.', { name });
      if (b.why === 'peer') return tr('Update TwinDesk on {name} to back up camera photos.', { name });
      if (b.why === 'api') return tr('Needs Android 11 or later.');
      if (b.why === 'partial' || b.why === 'media') return tr('Allow all photos on the phone. Selected photos can’t be backed up.');
      if (b.why === 'location') return tr('Allow photo locations on the phone. Backup copies that location with the photo.');
      if (b.why === 'transport') return tr('Connect over Wi-Fi or a cable.');
      if (b.why === 'consent') return tr('Turn backup on on {name} and choose a folder.', { name });
      if (b.why === 'folder') return tr('Choose a folder on this Mac.');
      if (b.why === 'disk') return tr('Couldn’t save the backup. Check the folder and free space.');
      if (b.why === 'wait') return tr('Waiting for the phone…');
      return tr('New camera photos are copied into the folder you choose, by year and month, after you turn this on here and on {name}. The copy includes the photo’s location. Nothing is deleted or replaced.', { name });
    }

    return (s) => {
      top.render(s);
      folderBtn.update(s);
      bigSave.textContent = tr('Save to {me}', { me: UI.fill('{me}') });
      alertCard.hidden = !(s.hub && s.hub.canMediaAlerts && UI.hubReady(s, 'media') && s.hub.perm.media.alerts && s.hub.perm.media.perm === 'ok'); // not with only chosen photos allowed
      alertSw.set(!!(s.hub && s.hub.mediaAlerts));
      const b = s.photoBackup;
      backupCard.hidden = !b;
      if (b) {
        backupSw.set(!!b.on);
        backupSw.disable(!b.available && !b.on);
        backupChoose.disabled = !b.available;
        backupRow.setHint(backupHint(b));
        folderRow.setHint(b.folder || tr('Choose a folder on this Mac.'));
      }
      const key = s.hub?.photoSaveKey || '';
      const owner = galleryPhone || thumbsPhone;
      if (saveKey !== key || (owner && !samePhone(phoneOf(), owner))) {
        saveKey = key;
        loaded = false;
        view(null);
        clearThumbs();
        reset(false);
      }
      const ready = UI.hubReady(s, 'media') && !UI.onBle(s); // over Bluetooth: the Wi-Fi Direct note only
      wrap.hidden = !ready;
      if (!ready) { loaded = false; cancelDrag(); view(null); return; }
      paintRemoveBtn();
      paintBig();
      if (!loaded) { loaded = true; reset(); UI.hubAsk({ t: 'media.albums' }); }
    };
  },
});

})();
