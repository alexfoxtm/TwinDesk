// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files with LocalSend-compatible apps, on the Files page (shared/localsend/wire.js is the state and
// the actions). UI.localsend() → { els, update(state) }: the switch (off until turned on), the
// devices found with what's known of each, an offer with its Accept and Decline, what's on its way.
// "LocalSend" names the protocol these devices speak; TwinDesk is not affiliated with it.
'use strict';

(function () {
  const t = (s, v) => I18n.t(s, v);

  UI.localsend = function () {
    const { el, api } = UI;
    const short = (fp) => (fp ? fp.slice(0, 8).toUpperCase().replace(/(.{4})/, '$1 ') : '');
    const pct = (tr) => Math.min(100, Math.floor((100 * tr.done) / Math.max(1, tr.total)));
    const what = (x) => (x.names && x.names.length === 1 && x.files === 1 ? x.names[0] : t(x.files === 1 ? '{count} file' : '{count} files', { count: x.files }));

    const sw = UI.switch((v) => api.lsSet({ on: v }), { label: t('Files with LocalSend-compatible apps') });
    const onRow = UI.row(t('Files with LocalSend-compatible apps'), '', [sw], { literal: true });
    const warn = UI.note('warn', '', { literal: true });
    warn.hidden = true;
    const offers = el('div');
    const devices = el('div');
    const address = el('input', { type: 'text', placeholder: '192.168.1.20', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Address') } });
    const add = () => { if (address.value.trim()) api.lsAdd(address.value); };
    const addBtn = UI.button(t('Add'), add, 'small');
    address.onkeydown = (e) => { if (e.key === 'Enter') add(); };
    const addRow = UI.row(t('Add a device by its address'), '', [address, addBtn], { literal: true });
    const refresh = UI.button(t('Look again'), () => api.lsRefresh(), 'small');
    const list = el('div', { class: 'history' });
    const main = UI.card(t('LocalSend-compatible devices'), [onRow, warn, offers, devices, addRow], { cls: 'keep-on', actions: [refresh] });
    const moving = UI.card(t('LocalSend transfers'), [list], { cls: 'keep-on', actions: [UI.button(t('Clear'), () => api.lsClear(), 'small')] });

    const peerHint = (p) => {
      const where = [p.ip + (p.port === 53317 ? '' : `:${p.port}`), p.deviceModel, short(p.fingerprint)].filter(Boolean).join(' · ');
      const state = p.why === 'plain' ? t('Encryption is off on that device: not supported')
        : p.why === 'v1' ? t('Uses the older protocol (v1): not supported')
          : p.why === 'newer' ? t('Uses a newer protocol: not supported')
            : p.verified ? '' : t('Not answering: it may only send');
      return state ? `${where} · ${state}` : where;
    };
    const failure = (tr) => {
      const name = (tr.peer && tr.peer.alias) || t('that device');
      switch (tr.error) {
        case 'declined': return t('Declined on {name}', { name });
        case 'pin': return t('{name} asks for its PIN', { name });
        case 'busy': return t('{name} is busy with another transfer', { name });
        case 'rate': return t('{name} asks to wait a moment', { name });
        case 'fingerprint': return t('The device at that address isn’t {name}: nothing was sent', { name });
        case 'unreachable': case 'timeout': return t('Couldn’t reach {name}', { name });
        case 'integrity': return t('A file arrived changed: the transfer was stopped');
        case 'read': return t('A file couldn’t be read');
        case 'empty': return t('Nothing to send');
        case 'peer': return t('That device is gone');
        case 'plain': return t('Encryption is off on that device: not supported');
        case 'v1': return t('Uses the older protocol (v1): not supported');
        case 'newer': return t('Uses a newer protocol: not supported');
        default: return t('Couldn’t send to {name}', { name });
      }
    };
    const line = (tr) => {
      const name = (tr.peer && tr.peer.alias) || '';
      if (tr.dir === 'out') {
        if (tr.state === 'waiting') return t('Waiting for {name} to accept {file}', { name, file: what(tr) });
        if (tr.state === 'running') return t('Sending {file} to {name} · {percent} %', { file: what(tr), name, percent: pct(tr) });
        if (tr.state === 'done') return t('Sent {file} to {name}', { file: what(tr), name });
        if (tr.state === 'cancelled') return t('Stopped sending to {name}', { name });
        return failure(tr);
      }
      if (tr.state === 'running') return t('Receiving {file} from {name} · {percent} %', { file: what(tr), name, percent: pct(tr) });
      if (tr.state === 'done') return t('Received {file} from {name}', { file: what(tr), name });
      return tr.arrived ? t('Stopped: {count} of {total} files from {name} arrived', { count: tr.arrived, total: tr.files, name }) : t('Stopped: nothing from {name} was kept', { name });
    };

    let peersKey = '';
    let offersKey = '';
    let listKey = '';
    const pins = new Map(); // transfer id -> what's typed so far (a redraw keeps it)

    function update(s) {
      const v = s.localsend;
      if (!v) { main.hidden = true; moving.hidden = true; return; }
      main.hidden = false;
      const on = !!v.cfg.on;
      sw.set(on);
      onRow.setHint(!on ? t('Off. Turn on to find devices running LocalSend-compatible apps on this network, send them files and be asked about theirs.')
        : v.starting ? t('Starting…')
          : v.receiving ? t('On as “{name}”. Every arriving transfer is asked about first; accepted files go to {folder}.', { name: v.name, folder: String(v.folder).replace(/^\/Users\/[^/]+/, '~') })
            : t('On as “{name}”: sending only.', { name: v.name }));
      warn.set(!on || v.starting ? ''
        : v.error === 'port' ? t('Port {port} is used by another app on this computer (LocalSend itself?): it receives; TwinDesk can find devices and send.', { port: 53317 })
          : v.error ? t('Couldn’t start receiving: {error}', { error: v.error }) : '');
      refresh.hidden = !on;
      addRow.hidden = !on;
      devices.hidden = !on;
      addBtn.disabled = !!v.adding;
      addRow.setHint(v.adding ? t('Looking…')
        : v.addError === 'address' ? t('Enter an address on this network, like 192.168.1.20')
          : v.addError === 'plain' ? t('That device has encryption off, which TwinDesk doesn’t use')
            : v.addError === 'unreachable' || v.addError === 'timeout' ? t('Nothing answered there')
              : v.addError ? t('That isn’t a LocalSend-compatible device')
                : t('When it isn’t found by itself: its address is in that app’s settings'));
      addRow.hint.classList.toggle('bad', !v.adding && !!v.addError);

      // An offer: who says it is, from where, and whether that was checked. Nothing is taken without Accept.
      const ok = JSON.stringify(v.offers.map((o) => o.id));
      if (ok !== offersKey) {
        offersKey = ok;
        offers.replaceChildren(...v.offers.map((o) => {
          const row = UI.row(t('{name} wants to send {file} ({size})', { name: o.alias, file: what(o), size: UI.bytes(o.total) }),
            [o.ip, short(o.fingerprint), o.verified ? '' : t('This sender didn’t prove which device it is: its name is only what it says.'),
              o.imitates ? t('Another device uses this name: this may not be the one you think.') : '', o.known ? '' : t('a device not seen before')].filter(Boolean).join(' · ') + (o.text ? ` · “${o.text.slice(0, 200)}”` : ''),
            [UI.button(t('Decline'), () => api.lsAnswer({ id: o.id, accept: false }), 'small'), UI.button(t('Accept'), () => api.lsAnswer({ id: o.id, accept: true }), 'small primary')], { literal: true });
          row.classList.add('ls-offer');
          return row;
        }));
      }

      const pk = JSON.stringify(v.peers.map((p) => [p.id, p.alias, p.ip, p.port, p.verified, p.why]));
      if (pk !== peersKey) {
        peersKey = pk;
        devices.replaceChildren(...(v.peers.length ? v.peers.map((p) => {
          const send = UI.button(t('Send…'), () => api.lsChoose(p.id), 'small');
          send.disabled = !p.supported;
          const row = UI.row(p.alias, peerHint(p), [send], { literal: true });
          row.hint.classList.toggle('bad', !p.supported);
          if (p.supported) {
            row.ondragover = (e) => { e.preventDefault(); row.style.outline = '2px solid var(--accent)'; };
            row.ondragleave = () => { row.style.outline = ''; };
            row.ondrop = (e) => {
              e.preventDefault();
              row.style.outline = '';
              const paths = api.pathsOf([...e.dataTransfer.files]);
              if (paths.length) api.lsSend({ id: p.id, paths });
            };
          }
          return row;
        }) : [UI.row(t('No devices found yet'), t('Open the app on the other device, on the same network'), [], { literal: true })]));
      }

      moving.hidden = !v.transfers.length;
      const lk = JSON.stringify(v.transfers.map((tr) => [tr.id, tr.state, tr.error, pct(tr), tr.pin]));
      if (lk !== listKey) {
        listKey = lk;
        for (const id of pins.keys()) if (!v.transfers.some((tr) => tr.id === id && tr.pin)) pins.delete(id);
        list.replaceChildren(...v.transfers.map((tr) => {
          const live = tr.state === 'waiting' || tr.state === 'running';
          let pin = null;
          if (tr.pin) {
            pin = el('input', { type: 'text', placeholder: t('PIN'), maxLength: 64, autocomplete: 'off', spellcheck: false, value: pins.get(tr.id) || '', attrs: { 'aria-label': t('PIN') } });
            pin.oninput = () => pins.set(tr.id, pin.value);
            pin.onkeydown = (e) => { if (e.key === 'Enter' && pin.value) api.lsPin({ id: tr.id, pin: pin.value }); };
          }
          const row = el('div', { class: 'hist-item' }, [
            el('span', { class: `hist-dir ${tr.dir}` }, [UI.icon(tr.dir === 'out' ? 'up' : 'down')]),
            el('div', { class: 'hist-text' }, [
              el('div', { class: 'hist-preview', text: line(tr) }),
              el('div', { class: 'hint', text: [UI.bytes(tr.total), live ? '' : UI.ago(tr.at)].filter(Boolean).join(' · ') }),
            ]),
            pin,
            pin ? UI.button(t('Send'), () => { if (pin.value) api.lsPin({ id: tr.id, pin: pin.value }); }, 'small') : null,
            live ? UI.button(t('Cancel'), () => api.lsCancel(tr.id), 'small') : null,
            tr.dir === 'in' && tr.saved && tr.saved.length ? UI.button(t('Show'), () => api.lsReveal(tr.id), 'small') : null,
          ]);
          return row;
        }));
      }
    }

    return { els: [main, moving], update };
  };
})();
