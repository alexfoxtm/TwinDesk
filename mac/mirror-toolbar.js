// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

(function (root) {
  function MirrorToolbar({ deviceId, rail, api, i18n = root.PlayerI18n }) {
    const bar = document.getElementById('bar');
    const tools = bar.querySelector('.tools');
    const dock = document.createElement('div');
    dock.id = 'toolbar-dock';
    const select = document.createElement('select');
    select.id = 'toolbar-position';
    const positions = [
      ['window', 'Window toolbar'],
      ['above', 'Above picture'],
      ['below', 'Below picture'],
    ];
    for (const [value, label] of positions) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    bar.append(select);
    document.body.append(dock);
    const key = deviceId ? 'twindesk.mirrorToolbar.' + deviceId : '';
    let position = 'window';
    let lastHeight = -1;
    if (key) {
      try {
        const saved = root.localStorage.getItem(key);
        if (positions.some(([value]) => value === saved)) position = saved;
      } catch (_) {}
    }
    function measure() {
      const height = position === 'window' ? 0 : Math.ceil(dock.getBoundingClientRect().height);
      document.body.style.setProperty('--toolbar-height', height + 'px');
      if (lastHeight !== height) {
        lastHeight = height;
        api.send({ t: 'toolbarHeight', height });
      }
    }
    function apply(value) {
      position = positions.some(([name]) => name === value) ? value : 'window';
      document.body.dataset.toolbar = position;
      select.value = position;
      if (position === 'window') {
        bar.insertBefore(tools, select);
        document.body.append(rail.nav);
      } else {
        dock.append(tools, rail.nav);
      }
      if (key) try { root.localStorage.setItem(key, position); } catch (_) {}
      measure();
    }
    function translate() {
      select.setAttribute('aria-label', i18n.t('Toolbar position'));
      select.title = i18n.t('Toolbar position');
      for (let i = 0; i < positions.length; i++) select.options[i].textContent = i18n.t(positions[i][1]);
    }
    select.onchange = () => apply(select.value);
    // Choosing a local layout must not send the selector's arrow/Return keys to the phone.
    select.addEventListener('keydown', (event) => event.stopPropagation());
    select.addEventListener('keyup', (event) => event.stopPropagation());
    // The expanded rail adds a second row; measuring it also follows font and locale changes.
    const observer = new root.ResizeObserver(measure);
    observer.observe(dock);
    translate();
    if (i18n.onChange) i18n.onChange(translate);
    apply(position);
    return { select, dock };
  }
  root.MirrorToolbar = MirrorToolbar;
})(typeof window !== 'undefined' ? window : globalThis);
