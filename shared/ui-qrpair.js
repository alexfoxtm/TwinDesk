// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connection › Pair a phone with a QR code (Mac, PC and Linux): an extra way next to Found nearby
// and the code, which stay as they are. Show QR Code draws this computer's pairing link
// (twindesk://pair, main's qrPair: its addresses, port and a nonce that asks only for Allow here),
// scanned with the phone's camera or TwinDesk's Scan QR code (QrActivity.kt). Only where the app
// has it (api.qrPair) and Qr (shared/qr.js) is loaded. UI.qrPairCard() → {el, update(state)}
'use strict';

UI.qrPairCard = () => {
  const { el, api } = UI;
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  if (!api.qrPair || !window.Qr) return null;
  let route = '';
  let networkState = null;
  let netBusy = false;
  let url = '';
  let until = 0;
  const toggle = (next) => { route = route === next ? '' : next; void refresh(); };
  const showBtn = UI.button(t('Show QR Code'), () => toggle('lan'), 'small');
  const row = UI.row(t('Pair a phone with a QR code'), t('Scan it with the phone’s camera, or with Scan QR code in TwinDesk on the phone'), [showBtn]);
  const signIn = api.embeddedTailnet && UI.button(t('Sign in'), () => networkAction('login'), 'small');
  const stop = signIn && UI.button(t('Stop'), () => networkAction('stop'), 'small');
  const signOut = signIn && UI.button(t('Sign out'), () => networkAction('logout'), 'small');
  const netRow = signIn && UI.row(t('Embedded Tailscale'), '', [signIn, stop, signOut]);
  if (netRow) netRow.hint.setAttribute('role', 'status');
  const remoteBtn = signIn && UI.button(t('Show QR Code'), () => toggle('embedded-tailnet'), 'small');
  const remoteRow = remoteBtn && UI.row(t('Pair over Tailscale'), t('Sign in with the same Tailscale account in TwinDesk on both devices.'), [remoteBtn]);
  const img = el('div', { class: 'qr-img', attrs: { role: 'img', 'aria-label': t('Pairing QR code') } });
  const note = el('div', { class: 'hint', attrs: { 'data-literal': '' } });
  const box = el('div', { class: 'qr-box' }, [img, el('div', { class: 'qr-text' }, [
    el('strong', { text: t('Scan with your phone') }),
    el('ol', {}, [t('Open the camera, or TwinDesk › Scan QR code.'), t('Point it at this code and open the link.'), t('Click Allow here when it asks.')].map((t) => el('li', { text: t }))),
    note,
  ])]);
  box.hidden = true;
  if (netRow) netRow.hidden = remoteRow.hidden = true;
  const card = UI.card('', [row, netRow, remoteRow, box].filter(Boolean));

  async function networkAction(op) {
    netBusy = true;
    paintNetwork();
    try {
      networkState = await api.embeddedTailnet(op);
    } catch {
      networkState = { available: true, state: 'error' };
    } finally {
      netBusy = false;
      paintNetwork();
      void refresh();
    }
  }

  function paintNetwork() {
    if (!netRow) return;
    const status = networkState || {};
    const live = ['running', 'starting', 'needsApproval', 'needsLogin'].includes(status.state);
    netRow.hidden = status.available !== true;
    remoteRow.hidden = status.ready !== true;
    signIn.hidden = status.ready === true;
    signIn.disabled = netBusy;
    stop.hidden = !live;
    stop.disabled = netBusy;
    signOut.hidden = !status.enabled;
    signOut.disabled = netBusy;
    netRow.setHint(status.warning === 'remote-revocation-unconfirmed' ?
      t('Signed out locally. This device may still be listed in Tailscale.') :
      status.ready ? t('Ready to pair') :
      status.state === 'needsApproval' ? t('Waiting for Tailscale approval') :
      status.state === 'needsLogin' ? t('Finish signing in in your browser') :
      status.state === 'starting' || status.state === 'running' ? t('Starting…') :
      status.state === 'error' ? t('Could not start embedded Tailscale. Try signing in again.') : t('Off'));
    if (route === 'embedded-tailnet' && !status.ready) route = '';
  }

  async function refresh() {
    showBtn.textContent = route === 'lan' ? t('Hide') : t('Show QR Code');
    if (remoteBtn) remoteBtn.textContent = route === 'embedded-tailnet' ? t('Hide') : t('Show QR Code');
    box.hidden = !route;
    if (!route) { img.replaceChildren(); url = ''; until = 0; return; }
    const requestedRoute = route;
    let v;
    try { v = await api.qrPair(requestedRoute); } catch { /* the connection window is closing */ }
    if (requestedRoute !== route) return;
    if (!v || !v.url) {
      img.replaceChildren();
      note.textContent = t((v && v.why) || 'Not ready yet');
      return;
    }
    if (v.url !== url) {
      url = v.url;
      const c = window.Qr.canvas(url, 4);
      c.className = 'qr-canvas';
      img.replaceChildren(c);
    }
    until = v.until || 0;
    note.textContent = t('A new code comes every 10 minutes. Only someone who sees this screen can use it.');
  }
  // A code that ran out is drawn again while it's shown.
  setInterval(() => { if (route && until && Date.now() > until) void refresh(); }, 15000);

  return {
    el: card,
    update(s) {
      const connected = !!s.phone?.connected;
      const was = route;
      networkState = s.embeddedTailnet;
      paintNetwork();
      row.hidden = connected;
      if (remoteRow && connected) remoteRow.hidden = true;
      card.hidden = connected && !networkState?.available;
      if (connected) route = '';
      if (was !== route) void refresh();
    },
  };
};
