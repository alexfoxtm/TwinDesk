// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages page (Mac, PC and Linux): the phone's conversations on the left, one on the right with
// its texts and pictures, and a box to answer (the phone sends it). New messages come as they
// arrive while Messages is on; their alerts are the phone's own notifications (Notifications).
// A picture goes with a text (Attach, dropped or pasted): an MMS from phones that say
// messages.mms, which also answer group conversations; in a chat app, through the phone (chat.pic).
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

// Android supplies E.164 or a verified SIM numbering context. Never compare suffixes.
const destination = (value, nanp) => {
  const address = String(value || '').trim();
  if (!/^\+?[0-9() .-]+$/.test(address)) return '';
  const digits = address.replace(/\D/g, '');
  if (address.startsWith('+')) return /^[1-9][0-9]{6,14}$/.test(digits) ? '+' + digits : '';
  if (nanp && /^1?[2-9][0-9]{2}[2-9][0-9]{6}$/.test(digits)) return '+1' + digits.slice(-10);
  return '';
};
const sameDestination = (a, b) => !!a && a === b;
const messageText = (text) => String(text || '').replace(/\r\n/g, '\n').trim();

// A verified one-to-one destination: Android's messagePeer first, else the row's single
// address (the phone's E.164 or, with this phone's NANP SIM context, a national number).
// A peer that does not parse never blocks an independently verified address.
const peerOf = (c, nanp) => c.group ? '' : destination(c.messagePeer, nanp) ||
  (c.addrs?.length === 1 ? destination(c.e164) || destination(c.addrs[0], nanp) : '');

function contactThreads(carrier, chats, nanp) {
  const address = (c) => peerOf(c, nanp);
  const google = chats.filter((c) => c.google && address(c));
  const identifies = (thread, paired) => thread.pkg === 'com.google.android.apps.messaging' &&
    thread.msgs?.some((m) => m.match && paired.fingerprints?.some((f) => f.at === m.at && f.matches.includes(m.match)));
  const contacts = new Map();
  const separate = [];
  for (const thread of [...carrier, ...chats]) {
    let dest = address(thread);
    if (!dest && !thread.group && thread.pkg === 'com.google.android.apps.messaging') {
      // Older structured projections have fingerprints but no address field. A unique
      // fingerprint can bind to a verified Google conversation ID.
      const exact = google.filter((c) => identifies(thread, c));
      if (exact.length === 1) dest = address(exact[0]);
    }
    if (!dest) { separate.push(thread); continue; }
    const sources = contacts.get(dest) || [];
    sources.push(thread);
    contacts.set(dest, sources);
  }
  for (const [dest, sources] of contacts) {
    const paired = sources.filter((c) => c.google);
    // A single Google history cursor is addressed by its exact conversation ID.
    // Keep conflicting Google IDs independently actionable.
    if (paired.length > 1) {
      const exact = paired.filter((c) => sources.some((t) => !t.google && identifies(t, c)));
      const independent = paired.filter((c) => exact.length !== 1 || c !== exact[0]);
      separate.push(...independent);
      for (const c of independent) sources.splice(sources.indexOf(c), 1);
    }
    if (!sources.length) continue;
    sources.sort((a, b) => b.at - a.at);
    const newest = sources[0];
    const textThreads = sources.filter((c) => c.carrier);
    separate.push({
      key: 'contact:' + dest, dest, sources, newest, textThreads, googleSource: sources.find((c) => c.google),
      at: newest.at, name: textThreads.find((c) => c.name)?.name || newest.name || dest,
      avatar: textThreads.find((c) => c.avatar)?.avatar || sources.find((c) => c.avatar)?.avatar,
    });
  }
  return separate.sort((a, b) => b.at - a.at);
}

function interleaveMessages(messages) {
  // A duplicate cluster must be unambiguous in both directions, including across
  // three projections. A repeated message within any source breaks that cluster.
  const edges = messages.map(() => []);
  const byText = new Map();
  for (const [i, m] of messages.entries()) {
    const body = messageText(m.text);
    if (!body || !m.at || m.pending || m.status === 'failed' || m.status === 'sending' ||
      m.attachment || m.parts?.length || m.photos?.length || m.pic || !m.source) continue;
    const key = JSON.stringify([m.me, body]);
    const matches = byText.get(key) || [];
    for (const j of matches) {
      const n = messages[j];
      if (m.source === n.source || (m.transport && n.transport && m.transport !== n.transport)) continue;
      const sameTime = m.mms || n.mms ? Math.floor(m.at / 1000) === Math.floor(n.at / 1000) : m.at === n.at;
      if (sameTime) { edges[i].push(j); edges[j].push(i); }
    }
    matches.push(i);
    byText.set(key, matches);
  }
  const dropped = new Set();
  for (const [i, neighbors] of edges.entries()) {
    if (!neighbors.length || dropped.has(i)) continue;
    const cluster = [i, ...neighbors];
    if (new Set(cluster.map((j) => messages[j].source)).size !== cluster.length ||
      !cluster.every((j) => edges[j].length === neighbors.length && edges[j].every((k) => cluster.includes(k)))) continue;
    // Prefer the carrier record, then the full paired record, over projections.
    const keep = cluster.find((j) => messages[j].source === 'carrier') ??
      cluster.find((j) => messages[j].source === 'google') ?? i;
    for (const j of cluster) if (j !== keep) dropped.add(j);
  }
  return messages.filter((_, i) => !dropped.has(i)).sort((a, b) => a.at - b.at);
}

// Colour is the transport class. Text, RCS and Unknown are not drawn on the bubble. In a thread that
// can carry SMS or RCS every other bubble is marked unknown, so it never takes the RCS fill.
const transportClass = (kind, carrierThread) => kind === 'text' || kind === 'rcs' ? ' ' + kind : carrierThread ? ' unknown' : '';

// A picture picked here as a JPEG data: URL, at most 1600 px and about 4 MB (the phone makes it
// fit the carrier's MMS limit). On white: a transparent PNG's clear parts don't turn black.
const shrink = (file) => new Promise((resolve, reject) => {
  if (!file || !/^image\//.test(file.type || '')) return reject(new Error('not a picture'));
  const r = new FileReader();
  r.onerror = () => reject(new Error('unreadable'));
  r.onload = () => {
    const img = new Image();
    img.onerror = () => reject(new Error('unreadable'));
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85;
      let d = c.toDataURL('image/jpeg', q);
      while (d.length > 4500000 && q > 0.4) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
      resolve(d);
    };
    img.src = String(r.result);
  };
  r.readAsDataURL(file);
});
const imageOf = (list) => [...(list || [])].find((f) => f && /^image\//.test(f.type || ''));

// A compose row's picture: the Attach button, the picture waiting to go (with ×), and drops and
// pastes onto `zone`. The target is checked again after the picture is converted.
function attacher({ el, button }, zone, box, target) {
  let data = '';
  let attachedTo = '';
  let revision = 0;
  const input = el('input', { type: 'file', attrs: { accept: 'image/*', hidden: '' } });
  const thumb = el('img', { class: 'hub-attach-img', alt: '' });
  const remove = el('button', { class: 'hub-attach-x', text: '×', attrs: { 'aria-label': tr('Remove picture') } });
  const chip = el('div', { class: 'hub-attach' }, [thumb, remove]);
  chip.hidden = true;
  const btn = button('+', () => input.click(), 'small');
  btn.classList.add('hub-attach-btn');
  btn.title = tr('Attach a picture');
  btn.setAttribute('aria-label', tr('Attach a picture'));
  const set = (d) => { data = d || ''; thumb.src = data; chip.hidden = !data; };
  const clear = () => { revision++; attachedTo = ''; set(''); };
  const take = (file) => {
    const selected = target();
    if (!file || !selected) return;
    const started = ++revision;
    shrink(file).then((d) => {
      if (started !== revision || selected !== target()) return;
      attachedTo = selected;
      set(d);
      box.focus();
    }).catch(() => {});
  };
  input.onchange = () => { take(imageOf(input.files)); input.value = ''; };
  remove.onclick = clear;
  zone.addEventListener('dragover', (e) => { if (target() && [...(e.dataTransfer.items || [])].some((i) => /^image\//.test(i.type))) { e.preventDefault(); zone.classList.add('hub-drop'); } });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('hub-drop'); });
  zone.addEventListener('drop', (e) => { zone.classList.remove('hub-drop'); const f = imageOf(e.dataTransfer.files); if (f && target()) { e.preventDefault(); take(f); } });
  box.addEventListener('paste', (e) => { const f = imageOf(e.clipboardData && e.clipboardData.files); if (f && target()) { e.preventDefault(); take(f); } });
  return { btn, chip, input, get: () => attachedTo && attachedTo === target() ? data : '', clear,
    show(on) { btn.hidden = !on; if (!on || (attachedTo && attachedTo !== target())) clear(); } };
}

UI.tab({
  id: 'messages',
  group: 'Phone',
  order: 6,
  title: tr('Messages'),
  icon: 'message',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: tr('Read and send your phone’s texts here.'),
  for: ['android'], // iOS gives no app its calls or texts (shared/ui-kinds.js)
  master: { get: (s) => !!(s.hub && s.hub.messages), set: (v) => UI.api.hub({ do: 'set', what: 'messages', on: v }) },
  badge: (s) => (s.hub && s.hub.messages ? (s.hub.unread ? String(s.hub.unread) : 'on') : ''),
  build(body, page) {
    const { el, api } = UI;
    const top = UI.hubTop('messages');
    // This window's own choices (localStorage): which chat apps show, and conversations deleted from
    // the list here (each comes back with a newer message: key -> the time it was deleted at).
    const loadPref = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (_) { return d; } };
    const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* this time only */ } };
    let hiddenApps = new Set(loadPref('td.msg.hiddenApps', []));
    let gone = loadPref('td.msg.deleted', {});
    const isGone = (key, at) => !!gone[key] && (at || 0) <= gone[key];
    const forget = (key, at) => {
      gone[key] = Math.max(at || 0, Date.now());
      const keys = Object.keys(gone);
      if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete gone[k];
      keep('td.msg.deleted', gone);
    };
    // Search: one box over each list, for names, numbers and the last message.
    let query = '';
    const matches = (...texts) => !query || texts.some((x) => String(x || '').toLowerCase().includes(query));
    const searchBox = (onInput) => {
      const i = el('input', { type: 'search', class: 'hub-input hub-search', placeholder: tr('Search'), spellcheck: false, attrs: { 'aria-label': tr('Search conversations') } });
      i.addEventListener('input', () => { query = i.value.trim().toLowerCase(); for (const b of boxes) if (b !== i) b.value = i.value; onInput(); });
      boxes.push(i);
      return i;
    };
    const boxes = [];
    // A conversation's picture, with its app's icon in the corner (the phone sends those with notifications).
    const avatar = (name, photo, pkg) => {
      const a = UI.avatar(name, photo);
      const icon = pkg && UI.state && UI.state.notifs && (UI.state.notifs.historyIcons || {})[pkg];
      if (!icon) return a;
      return el('span', { class: 'hub-avatar-wrap' }, [a, el('img', { class: 'hub-avatar-app', src: icon, alt: '' })]);
    };
    const list = el('div', { class: 'hub-threads' });
    const newBtn = UI.button(tr('New message'), () => openNew(), 'small');
    const head = el('div', { class: 'hub-conv-head', attrs: { 'data-literal': '' } });
    const scroll = el('div', { class: 'hub-conv-scroll' });
    const more = UI.button(tr('Earlier messages'), () => loadThread(openId, true), 'small');
    const bubbles = el('div', { class: 'hub-bubbles', attrs: { 'data-literal': '' } });
    scroll.append(more, bubbles);
    const to = el('input', { type: 'text', class: 'hub-input hub-to', placeholder: tr('To: a number'), spellcheck: false, attrs: { 'aria-label': tr('To') } });
    const box = el('textarea', { class: 'hub-compose', rows: 1, placeholder: tr('Text message'), attrs: { 'aria-label': tr('Message') } });
    const send = UI.button(tr('Send'), () => sendNow(), 'primary');
    const groupNote = el('div', { class: 'hint hub-group-note', text: tr('Answer group conversations on the phone.') });
    // Two SIMs or more on the phone: which one the text goes out on ('' is the phone's default).
    const simOptions = (s) => [{ value: '', label: tr('Default SIM') },
      ...(s?.hub?.perm?.messages?.sims || []).map((x) => ({ value: String(x.id), label: x.label }))];
    const simPick = UI.select([{ value: '', label: tr('Default SIM') }], () => {});
    simPick.el.setAttribute('aria-label', tr('SIM'));
    simPick.el.hidden = true;
    const conv = el('div', { class: 'hub-conv' });
    const mmsOk = () => !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.messages && UI.state.hub.perm.messages.mms);
    const pic = attacher(UI, conv, box, () => {
      const hub = UI.state?.hub;
      return pill === 'texts' && openId !== null && carrierSend(UI.state) && mmsOk()
        ? JSON.stringify([hub.deviceId, hub.session, openId, openId === '' ? to.value.trim() : thread()?.addrs]) : '';
    });
    // A picture belongs to the recipients it was attached for: editing To drops it, even mid-conversion.
    to.addEventListener('input', () => {
      pic.show(mmsOk());
      if (openId === '') groupNote.hidden = to.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean).length <= MAX_GROUP;
    });
    const compose = el('div', { class: 'hub-compose-row' }, [simPick.el, pic.btn, el('div', { class: 'hub-compose-col' }, [pic.chip, box]), send, pic.input]);
    conv.append(head, scroll, groupNote, compose);
    const empty = el('div', { class: 'hub-empty hub-conv-empty', text: tr('Choose a conversation') });
    const textSearch = searchBox(() => { renderList(); paintChats(UI.state, true); });
    const delText = UI.button(tr('Delete'), () => {
      const t = thread();
      if (!t) return;
      forget('sms:' + t.id, t.at);
      openId = null;
      pic.clear();
      renderList();
      renderConv();
    }, 'small');
    delText.title = tr('Delete this conversation from the list here (it stays on the phone, and comes back with a new message)');
    const textSideHead = el('div', { class: 'hub-side-head' }, [textSearch, newBtn]);
    const layout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [textSideHead, list]), conv, empty]);
    // ---- chat apps in one inbox (the switch here, settings.ui.chats): pills on top ----
    // Texts are the phone's SMS and MMS (above); the chat apps are their conversations as the phone
    // sends them (s.chats: shared/chats.js), kept here, or with an older phone their notifications
    // (Notifications on). Answered with their own Reply (notif.reply). All: everything.
    const CHAT = [['all', tr('All')], ['texts', tr('Texts')], ['rcs', tr('Messages (Chat)')], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['telegram', 'Telegram'], ['messenger', 'Messenger'], ['signal', 'Signal'], ['other', tr('Other apps')]];
    const OPTIONAL = ['rcs', 'messenger', 'signal', 'other']; // their pill only once one of their chats is here
    const appOf = (pkg) => (/^com\.whatsapp/.test(pkg) ? 'whatsapp' : /^(?:org\.telegram|org\.thunderdog\.challegram)/.test(pkg) ? 'telegram' : /^com\.instagram/.test(pkg) ? 'instagram'
      : pkg === 'com.facebook.orca' ? 'messenger' : pkg === 'org.thoughtcrime.securesms' ? 'signal'
      : pkg === 'com.google.android.apps.messaging' || pkg === 'com.samsung.android.messaging' ? 'rcs' : '');
    const APP_NAME = { whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram', messenger: 'Messenger', signal: 'Signal', rcs: tr('Chat') };
    let pill = 'texts';
    let chosePill = false;
    let parkedPill = ''; // the pill an outage put away, with its open chat and draft: back when chats are
    const pills = el('div', { class: 'msg-pills', attrs: { role: 'tablist' } });
    const pillBtns = CHAT.map(([id, label]) => {
      const b = el('button', { class: 'msg-pill', text: label, attrs: { role: 'tab' } });
      b.onclick = () => { chosePill = true; pill = id; closeChat(); chatKey = ''; paintChats(UI.state); if (UI.state) layout.hidden = pill !== 'texts' || !UI.hubReady(UI.state, 'messages'); };
      pills.append(b);
      return [id, b];
    });
    // Which chat apps show (pills and All): a small panel under the pills.
    const appsBtn = el('button', { class: 'msg-pill msg-apps-btn', text: tr('Apps…'), attrs: { 'aria-expanded': 'false' } });
    const appsPanel = el('div', { class: 'msg-apps', hidden: true });
    appsBtn.onclick = () => { appsPanel.hidden = !appsPanel.hidden; appsBtn.setAttribute('aria-expanded', String(!appsPanel.hidden)); };
    const appsRows = CHAT.filter(([id]) => id !== 'all' && id !== 'texts').map(([id, label]) => {
      const sw = UI.switch((v) => {
        if (v) hiddenApps.delete(id); else hiddenApps.add(id);
        keep('td.msg.hiddenApps', [...hiddenApps]);
        if (!v && pill === id) { pill = 'all'; closeChat(); }
        paintChats(UI.state, true);
      }, { label });
      sw.set(!hiddenApps.has(id));
      return UI.row(label, '', [sw]);
    });
    appsPanel.append(...appsRows);
    pills.append(appsBtn);
    const chatsSw = UI.switch((v) => api.setChats && api.setChats(v), { label: tr('Chat apps in Messages') });
    const chatsHint = (messaging) => tr(messaging
      ? 'See notifications from Google Messages, Samsung Messages and other chat apps alongside your texts.'
      : 'WhatsApp, Instagram, Telegram and Messenger next to your texts. Reply from here.');
    const chatsRow = UI.row(tr('Chat apps in Messages'), chatsHint(false), [chatsSw]);
    const chatsCard = UI.card('', [chatsRow]);
    chatsCard.hidden = !api.setChats;
    const chatList = el('div', { class: 'hub-threads' });
    const chatHead = el('div', { class: 'hub-conv-head', attrs: { 'data-literal': '' } });
    const chatScroll = el('div', { class: 'hub-conv-scroll' });
    const chatBubbles = el('div', { class: 'hub-bubbles', attrs: { 'data-literal': '' } });
    chatScroll.append(chatBubbles);
    const chatBox = el('textarea', { class: 'hub-compose', rows: 1, placeholder: tr('Reply'), attrs: { 'aria-label': tr('Reply') } });
    const chatSend = UI.button(tr('Send'), () => chatReply(), 'primary');
    chatBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatReply(); } });
    const chatNote = el('div', { class: 'hint hub-group-note' });
    const chatConv = el('div', { class: 'hub-conv' });
    const chatPic = attacher(UI, chatConv, chatBox, () => {
      const t = selectedChat();
      const hub = UI.state?.hub;
      return t && chatPictureAllowed(t)
        ? JSON.stringify([chatEpoch, hub?.deviceId, hub?.session, t.key, googleOf(t)?.id || (openContact?.key === t.key ? openContact.googleId : null)]) : '';
    });
    const chatSim = UI.select([{ value: '', label: tr('Default SIM') }], () => {});
    chatSim.el.hidden = true;
    chatSim.el.setAttribute('aria-label', tr('SIM'));
    const chatCompose = el('div', { class: 'hub-compose-row' }, [chatSim.el, chatPic.btn, el('div', { class: 'hub-compose-col' }, [chatPic.chip, chatBox]), chatSend, chatPic.input]);
    chatConv.append(chatHead, chatScroll, chatNote, chatCompose);
    const chatEmpty = el('div', { class: 'hub-empty hub-conv-empty', text: tr('Choose a conversation') });
    const chatSearch = searchBox(() => { renderList(); paintChats(UI.state, true); });
    const chatNew = UI.button(tr('New message'), () => {
      chosePill = true;
      pill = 'texts';
      closeChat();
      paintChats(UI.state, true);
      openNew();
    }, 'small');
    const chatSideHead = el('div', { class: 'hub-side-head' }, [chatSearch, chatNew]);
    const chatLayout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [chatSideHead, chatList]), chatConv, chatEmpty]);
    // One legend for whichever list is open, only where SMS or RCS can show. Swatches use the
    // outgoing SMS and RCS fills.
    const transportLegend = el('div', { class: 'hub-transport-legend' }, [
      el('span', { class: 'hub-transport-key' }, [el('span', { class: 'hub-swatch text', attrs: { 'aria-hidden': 'true' } }), el('span', { text: tr('SMS') })]),
      el('span', { class: 'hub-transport-key' }, [el('span', { class: 'hub-swatch rcs', attrs: { 'aria-hidden': 'true' } }), el('span', { text: tr('RCS') })]),
    ]);
    let legendHead = null;
    const placeTransportLegend = () => {
      const head = pill === 'texts' ? textSideHead : chatSideHead;
      transportLegend.hidden = !['all', 'texts', 'rcs'].includes(pill);
      if (head === legendHead) return;
      legendHead = head;
      head.append(transportLegend);
    };
    placeTransportLegend();
    let chatOpen = '';
    let chatDraft = null; // {key, offer}: the notification offer a draft started on
    let openContact = null;
    let chatEpoch = 0;
    let carrierHistory = new Map();
    let nanp = false;
    let phoneSession;
    let phoneDevice;
    // Destination -> the kind Google Messages last reported for it ('rcs', 'sms' or ''), from
    // Google-mode rows. It decides whether a carrier send is allowed while Google is away.
    const lastKind = new Map();
    let kindOwner;
    const carrierReady = (s) => UI.hubReady(s, 'messages') && !s.hub.perm.messages.missing?.includes('read');
    const carrierSend = (s) => UI.hubReady(s, 'messages') && !s.hub.perm.messages.missing?.includes('send');
    // The phone and session a carrier request is for. Sends, history and list reads carry it, so a
    // delayed request never reaches a replacement phone (shared/phonehub.js checks it).
    const phoneOf = () => UI.state?.hub ? { deviceId: UI.state.hub.deviceId || '', session: UI.state.hub.session } : null;
    const carrierAsk = (msg, phone = phoneOf()) => phone ? UI.hubAsk({ ...msg, phone }) : false;
    const MAX_GROUP = 20; // the phone's MMS limit: a larger group is refused, never cut down
    let chatKey = '';
    const gmAct = (op, args = {}, gm = UI.state?.googleMessages) =>
      api.googleMessages && gm ? api.googleMessages({ op, owner: gm.owner, ...args }).catch(() => false) : Promise.resolve(false);
    let gmBusy = false;
    let gmWipeError = false;
    let gmHistory = '';
    let gmRead = '';
    let gmTypingAt = 0;
    let gmSend = null;
    let gmError = '';
    let gmOwner = '';
    const gmPhotos = new Map();
    const gmConnect = UI.button(tr('Connect Google Messages'), async () => {
      const gm = UI.state?.googleMessages;
      gmWipeError = false;
      gmBusy = true;
      paintAccount(gm);
      await gmAct('connect');
      gmBusy = false;
      paintAccount(UI.state?.googleMessages);
    }, 'small');
    const gmDisconnect = UI.button(tr('Disconnect'), async () => {
      openContact = null;
      chatEpoch++;
      chatPic.clear();
      gmBusy = true;
      paintAccount(UI.state?.googleMessages);
      gmWipeError = !(await gmAct('disconnect'));
      gmBusy = false;
      paintAccount(UI.state?.googleMessages);
    }, 'small');
    const gmRow = api.googleMessages && UI.row(tr('Google Messages'), '', [gmConnect, gmDisconnect]);
    const gmCard = gmRow && UI.card('', [gmRow]);
    gmRow?.hint?.setAttribute('role', 'status');
    function paintAccount(gm) {
      if (!gmCard) return;
      gmCard.hidden = !gm;
      if (!gm) return;
      const busy = ['connecting', 'signing-in', 'confirm'].includes(gm.state);
      gmConnect.hidden = busy || gm.state === 'connected' || gm.state === 'offline';
      gmConnect.disabled = !gm.enabled || gmBusy;
      gmDisconnect.disabled = gmBusy;
      const labels = {
        connected: tr('Connected'),
        disconnected: gm.enabled ? tr('Disconnected') : tr('Turn on Messages to connect.'),
        connecting: tr('Connecting to Google Messages…'),
        'signing-in': tr('Sign in in the TwinDesk window.'),
        confirm: tr('Tap {emoji} in Google Messages on your phone.', { emoji: gm.emoji }),
        offline: tr('Disconnected. Waiting for Google Messages to reconnect.'),
        'connection-error': tr('Disconnected. Check Google Messages on your phone and try again.'),
        'helper-error': tr('Disconnected. The Google Messages helper could not start.'),
        'keychain-error': tr('Disconnected. TwinDesk could not access the Google Messages Keychain item.'),
      };
      gmRow.setHint?.(gmWipeError ? tr('TwinDesk could not clear the Google Messages session. Try Disconnect again.') : labels[gm.state]);
    }
    const paired = (s) => {
      const gm = s?.googleMessages;
      if (gm?.state !== 'connected' || hiddenApps.has('rcs') || (s.hub?.deviceId && s.hub.deviceId !== gm.owner)) return [];
      return gm.rows.map((c) => {
        const history = gm.history?.chat === c.id ? gm.history : null;
        return {
          ...c, key: 'google:' + c.id, pkg: 'com.google.android.apps.messaging', app: 'rcs', google: true,
          name: c.name || c.addrs?.join(', ') || tr('Google Messages'), pic: c.reply,
          msgs: history?.items || [], loaded: !!history?.loaded, more: !!history?.more, typing: !!history?.typing,
        };
      }).filter((c) => !isGone(c.key, c.at));
    };
    // Google mode: Google Messages is connected for this phone and shown. The list and every SMS, MMS
    // and RCS conversation then come from Google alone. Otherwise the phone's own path (phone mode).
    const googleMode = (s) => {
      const gm = s?.googleMessages;
      return gm?.state === 'connected' && !hiddenApps.has('rcs') && !!s.hub?.messages &&
        !(s.hub?.deviceId && s.hub.deviceId !== gm.owner);
    };
    const kindOf = (c) => c.kind ?? 'rcs'; // a missing kind is RCS
    function closeChat() {
      chatOpen = '';
      parkedPill = '';
      chatDraft = null;
      openContact = null;
      chatEpoch++;
      chatBox.value = '';
      chatPic.clear();
      carrierHistory.clear();
      gmHistory = '';
      gmRead = '';
      gmTypingAt = 0;
      gmError = '';
      gmPhotos.clear();
    }
    function openChat(t) {
      if (chatOpen !== t.key) closeChat();
      chatOpen = t.key;
      if (t.dest && t.googleSource && UI.state.hub?.deviceId && UI.state.hub.deviceId === UI.state.googleMessages?.owner) {
        openContact = { key: t.key, dest: t.dest, deviceId: UI.state.hub.deviceId, session: UI.state.hub.session, googleId: t.googleSource.id };
      }
      paintChats(UI.state);
    }
    function markGoogleRead(t) {
      if (page.hidden || !t.loaded) return;
      const last = [...t.msgs].reverse().find((m) => !m.me);
      if (!last || last.id === gmRead) return;
      gmRead = last.id;
      gmAct('read', { chat: t.id, message: last.id });
    }

    // The conversations: the phone's own (s.chats), else from the notifications, one per app and
    // title (the sender or the group).
    const synced = (s) => !!(s && Array.isArray(s.chats));
    function chatThreads(s) {
      const google = paired(s);
      const own = synced(s) ? s.chats.map((c) => ({ key: c.key, pkg: c.app, avatar: c.avatar || '', app: appOf(c.app) || 'other',
        name: appOf(c.app) ? c.name || c.appName : [c.name, c.appName].filter(Boolean).join(' · '),
        group: !!c.group, reply: !!c.reply, pic: !!c.pic, at: c.at, msgs: c.items || [], messagePeer: c.messagePeer, from: c.from, replySession: c.replySession })) : [];
      const by = new Map();
      for (const h of s.notifs?.history || []) {
        const app = appOf(h.app);
        // Structured messaging supersedes raw notifications on phones that deliver it.
        if (!app || (app !== 'rcs' && synced(s)) || (app === 'rcs' && s.chatsMessaging)) continue;
        if (h.live || BUSY.test(h.body || '') || BUSY.test(h.title || '')) continue;
        const peer = app === 'rcs' && h.messagePhone && h.messagePhone === s.hub?.deviceId ? h.messagePeer : '';
        // A title groups unverified notifications for display only. It never supplies a destination.
        const key = app === 'rcs'
          ? JSON.stringify([app, h.from || h.messagePhone || '', h.app, peer ? 'peer' : 'title', peer || h.title || h.appName])
          : app + '|' + (h.title || h.appName);
        const t = by.get(key) || { key, pkg: h.app, avatar: h.avatar || '', app, name: h.title || h.appName,
          messagePeer: peer, items: [], at: 0 };
        t.items.push(h);
        t.at = Math.max(t.at, peer && h.messageAt || h.at);
        by.set(key, t);
      }
      const googleList = googleMode(s);
      return google.concat(own, [...by.values()]).filter((t) => (t.app !== 'rcs' || !!s.hub?.messages) &&
        (!googleList || t.app !== 'rcs' || t.google) &&
        !hiddenApps.has(t.app) && !isGone(t.key, t.at)).sort((a, b) => b.at - a.at);
    }
    const googleUnavailable = (gm) => ['offline', 'helper-error', 'connection-error', 'keychain-error'].includes(gm?.state);
    function inboxThreads(s, chats = chatThreads(s)) {
      const carrier = carrierReady(s) ? threads.filter((t) => !isGone('sms:' + t.id, t.at))
        .map((t) => ({ ...t, name: t.name || t.addrs?.join(', '), key: 'sms:' + t.id, avatar: t.photo, carrier: true })) : [];
      const rows = contactThreads(carrier, chats, nanp);
      if (googleMode(s)) {
        // No SMS, MMS or RCS row without a Google source. A phone thread stays only under its Google
        // row (its avatar, and the same key through an outage); the row shows the Google source.
        const listed = rows.filter((c) => c.dest ? !!c.googleSource : !c.carrier);
        for (const c of listed) if (c.dest) lastKind.set(c.dest, kindOf(c.googleSource));
        return listed.map((c) => c.dest ? { ...c, newest: c.googleSource, at: c.googleSource.at, name: c.googleSource.name } : c)
          .sort((a, b) => b.at - a.at);
      }
      const gm = s.googleMessages;
      if (openContact && openContact.deviceId === gm?.owner && openContact.deviceId === s.hub?.deviceId &&
          openContact.session === s.hub?.session && !hiddenApps.has('rcs') && carrierSend(s) &&
          googleUnavailable(gm) &&
          !rows.some((c) => c.key === openContact.key)) {
        // Keep the selected address available for Text through a helper outage.
        // All paired content is removed by the helper's owner/session boundary.
        rows.push({ key: openContact.key, dest: openContact.dest, name: openContact.dest,
          at: 0, sources: [], textThreads: [] });
      }
      return rows;
    }
    // A chat app's notice that isn't a message: "Sending video…", "Deleting chats… 100%".
    const BUSY = /^(?:sending|uploading|downloading|deleting|backing up|restoring|checking for new messages|preparing|syncing)\b|\b\d{1,3}\s?%\s*$/i;
    // A conversation's last message, as its row shows it.
    function snippetOf(t) {
      if (t.dest) return t.newest ? snippetOf(t.newest) : '';
      if (t.carrier) return t.snippet || '';
      if (!t.msgs) return (t.items[0] && t.items[0].body) || '';
      const m = t.msgs[t.msgs.length - 1];
      if (!m && t.google) return t.snippet || '';
      return m ? m.me ? tr('You: {message}', { message: m.text }) : t.group && m.from ? tr('{sender}: {message}', { sender: m.from, message: m.text }) : m.text : '';
    }
    const googleOf = (t) => t.googleSource || (t.google ? t : null);
    function selectedChat() {
      const s = UI.state;
      if (!s || !chatOpen || pill === 'texts') return null;
      const rows = pill === 'all' ? inboxThreads(s) : chatThreads(s);
      return rows.find((t) => t.key === chatOpen && (pill === 'all' || t.app === pill));
    }
    const carrierMessage = (m) => ({ ...m, text: m.body, me: m.out || !!m.ref,
      pending: !!m.ref, mms: m.id?.startsWith('m'), source: 'carrier', transport: 'text' });
    const googleOnly = (t) => googleMode(UI.state) && !!t?.googleSource;
    function projectContact(t) {
      if (googleOnly(t)) {
        // Google history alone, and this window's carrier sends that are still sending or failed.
        const local = pending.filter((p) => p.contact === t.key && (p.status === 'sending' || p.status === 'failed'));
        return interleaveMessages([...local.map(carrierMessage), ...t.googleSource.msgs.map((m) => ({ ...m, source: 'google' }))]);
      }
      const texts = t.textThreads.flatMap((c) => carrierHistory.get(c.id)?.items || []);
      const local = pending.filter((p) => p.contact === t.key);
      const messages = [...texts, ...local].map(carrierMessage);
      for (const c of t.sources) {
        if (c.carrier) continue;
        if (c.msgs) {
          messages.push(...c.msgs.map((m) => ({ ...m, source: c.google ? 'google' : 'structured' })));
        } else {
          messages.push(...c.items.flatMap((h) => [
            { text: h.body || h.subtitle, at: h.messageAt || h.at, me: false, source: 'notification' },
            ...(h.replies || []).map((r) => ({ ...r, me: true, pending: true })),
          ]));
        }
      }
      return interleaveMessages(messages);
    }
    // A carrier send: only for a conversation Google reported as SMS. Without a Google source, not
    // while Google Messages is in use and the destination was last RCS or Google is still connecting.
    const canText = (t, image) => {
      if (!t?.dest || !carrierSend(UI.state) || (image && !mmsOk())) return false;
      const google = googleOf(t);
      if (google) return kindOf(google) === 'sms';
      const gm = UI.state?.googleMessages;
      return !(gm?.enabled && gm.state !== 'disconnected' &&
        (lastKind.get(t.dest) === 'rcs' || ['connecting', 'signing-in', 'confirm'].includes(gm.state)));
    };
    function sendContactText(t, text, image) {
      const sms = t.textThreads.length === 1 ? t.textThreads[0] : null;
      dispatchText([t.dest], text, image, chatSim.el, sms?.id, t.key);
      chatBox.value = '';
      chatDraft = null;
      chatPic.clear();
      paintChats(UI.state, true);
    }
    // A notification offer's verified one-to-one identity: its phone, app and peer, and this window's
    // phone session. Only that can carry a draft to a newer offer; a display title never does.
    function offerProof(t, offer) {
      const hub = UI.state?.hub;
      if (!offer?.id || !hub?.deviceId) return null;
      for (const c of t.dest ? t.sources : [t]) {
        const h = !c.carrier && !c.google && !c.msgs && c.items.find((h) => h.id === offer.id && h.from === offer.from &&
          h.replySession === offer.replySession);
        if (h) {
          return h.messagePeer && h.messagePhone === h.from && h.from === hub.deviceId
            ? { app: h.app, from: h.from, messagePeer: h.messagePeer, deviceId: hub.deviceId, session: hub.session } : null;
        }
      }
      return null;
    }
    function notificationReply(t, image, pinned, proof) {
      if (!api.notifReply) return null;
      const candidates = t.dest ? t.sources : [t];
      if (pinned) {
        // A title groups unverified notifications for display only: a draft stays on its exact offer.
        for (const c of candidates) {
          const h = !c.carrier && !c.google && !c.msgs && c.items.find((h) => h.reply && h.id === pinned.id &&
            h.from === pinned.from && h.replySession === pinned.replySession);
          if (h) return pinned;
        }
        // A newer offer of the same proven conversation (phone, session, app and verified peer) keeps
        // the draft sendable. Never another phone, peer or session.
        const hub = UI.state?.hub;
        if (proof && hub?.deviceId === proof.deviceId && hub.session === proof.session) {
          for (const c of candidates) {
            const h = !c.carrier && !c.google && !c.msgs && c.items.find((h) => h.reply && h.replySession &&
              h.from === proof.from && h.app === proof.app && h.messagePeer === proof.messagePeer && h.messagePhone === h.from);
            if (h) return { id: h.id, from: h.from, replySession: h.replySession };
          }
        }
        return null;
      }
      for (const c of candidates) {
        if (c.carrier || c.google) continue;
        if (c.msgs) {
          if (image ? c.pic : c.reply) return { chat: c.key, from: c.from, replySession: c.replySession };
        } else {
          const h = !image && c.items.find((h) => h.reply && h.from && h.replySession);
          if (h) return { id: h.id, from: h.from, replySession: h.replySession };
        }
      }
      return null;
    }
    const chatPictureAllowed = (t) => googleOf(t) ? !!googleOf(t).reply : !!notificationReply(t, true) || canText(t, true);
    const replyRefused = () => {
      gmError = tr('Reply here once the phone shows this chat’s notification again.');
      paintChats(UI.state, true);
    };
    async function sendFallback(t, text, image) {
      const pinned = !image && chatDraft?.key === t.key ? chatDraft.offer : null;
      const offer = notificationReply(t, image, pinned, pinned && chatDraft.proof);
      if (pinned && !offer) {
        // The draft's offer expired: keep the draft rather than retarget a newer notification.
        replyRefused();
        return true;
      }
      if (offer) {
        const epoch = chatEpoch;
        const ok = await api.notifReply({ ...offer, text, ...(image ? { image } : {}) });
        if (epoch !== chatEpoch) return true;
        if (ok === false) {
          replyRefused();
          return true;
        }
        if (chatBox.value.trim() === text) {
          chatBox.value = '';
          chatDraft = null;
        }
        if (image && chatPic.get() === image) chatPic.clear();
        return true;
      }
      if (!canText(t, image)) return false;
      sendContactText(t, text, image);
      return true;
    }
    async function chatReply() {
      const t = selectedChat();
      const text = chatBox.value.trim();
      const image = chatPic.get();
      if (!t || (!text && !image) || gmSend?.key === t.key) return;
      const google = googleOf(t);
      if (!google) {
        gmError = '';
        await sendFallback(t, text, image);
        return;
      }
      if (!google.reply) return; // read-only: never a notification or carrier send
      if (!google.loaded || gmSend || gmBusy) return;
      const gm = UI.state.googleMessages;
      const epoch = chatEpoch;
      const { deviceId, session } = UI.state.hub || {};
      const allowCarrier = !!t.dest && (!!notificationReply(t, image) || canText(t, image));
      const request = { key: t.key };
      gmSend = request;
      gmError = '';
      paintChats(UI.state, true);
      const ok = await gmAct('send', { chat: google.id, text: image ? '' : text, image, allowCarrier }, gm);
      if (gmSend !== request) return;
      gmSend = null;
      const currentGM = UI.state.googleMessages;
      const hub = UI.state.hub;
      if (epoch !== chatEpoch || chatOpen !== t.key || currentGM?.owner !== gm.owner ||
          hub?.deviceId !== deviceId || hub?.session !== session) {
        paintChats(UI.state, true);
        return;
      }
      const current = selectedChat();
      const currentGoogle = current && googleOf(current);
      // Fall back only while that same conversation is still unavailable. Writable again: no SMS.
      const sameGoogle = currentGM.state === 'connected'
        ? currentGoogle?.id === google.id && !currentGoogle.reply
        : googleUnavailable(currentGM) && !currentGoogle && openContact?.googleId === google.id;
      if (ok === 'not-dispatched' && allowCarrier && !gmBusy && currentGM.enabled && sameGoogle &&
          sameDestination(current?.dest, t.dest) && chatBox.value.trim() === text && chatPic.get() === image &&
          await sendFallback(current, text, image)) return;
      if (ok === true) {
        if (image && chatPic.get() === image) chatPic.clear();
        if (!image && chatBox.value.trim() === text) chatBox.value = '';
      } else gmError = ok === 'not-dispatched' ? tr('Google Messages is unavailable. Check the reply options and try again.')
        : tr('Google Messages could not confirm the send. Check the conversation before retrying.');
      paintChats(UI.state, true);
    }
    const threadRow = (name, at, snippet, active, onClick, photo, pkg) => {
      const b = el('button', { class: `hub-thread${active ? ' active' : ''}`, attrs: { 'data-literal': '' } }, [avatar(name, photo, pkg), el('span', { class: 'hub-thread-text' }, [
        el('span', { class: 'hub-thread-top' }, [el('span', { class: 'hub-thread-name', text: name }), el('span', { class: 'hub-thread-time', text: at ? UI.clock(at) : '' })]),
        el('span', { class: 'hub-thread-snippet', text: snippet }),
      ])]);
      b.onclick = onClick;
      return b;
    };
    function paintChats(s, force) {
      if (!s) return;
      if (force) chatKey = '';
      const gm = s.googleMessages;
      if (gm?.owner !== gmOwner || gm?.state !== 'connected') {
        gmOwner = gm?.owner;
        gmHistory = '';
        gmRead = '';
        gmPhotos.clear();
      }
      if (gm && gm.owner !== kindOwner) { kindOwner = gm.owner; lastKind.clear(); }
      if (gm?.state === 'disconnected') lastKind.clear();
      paintAccount(gm);
      const ready = carrierReady(s);
      const on = !!s.ui?.chats || gm?.state === 'connected' ||
        (pill === 'all' && chatOpen.startsWith('contact:') && carrierSend(s));
      chatsSw.set(!!s.ui?.chats);
      pills.hidden = !on;
      chatsCard.hidden = !!s.ui?.chats || !api.setChats;
      if (!on && pill !== 'texts') {
        // Chats are out (no phone, or Google Messages is away): an open chat and its draft wait under
        // Texts and return with them. Only the user, another phone or another device closes it.
        if (chatOpen) parkedPill = pill; else closeChat();
        pill = 'texts';
      }
      const all = chatThreads(s);
      const inbox = inboxThreads(s, all);
      if (chatsRow.setHint) chatsRow.setHint(chatsHint(!!s.chatsMessaging));
      if (on && parkedPill) { pill = parkedPill; parkedPill = ''; }
      if (on && !chosePill) pill = 'all';
      for (const [id, b] of pillBtns) {
        b.classList.toggle('on', id === pill);
        b.setAttribute('aria-selected', String(id === pill));
        b.hidden = hiddenApps.has(id) || (OPTIONAL.includes(id) && id !== pill && !all.some((t) => t.app === id));
      }
      appsBtn.hidden = !on;
      if (!on) appsPanel.hidden = true;
      chatNew.hidden = pill !== 'all' || !carrierSend(s);
      chatLayout.hidden = pill === 'texts';
      layout.hidden = pill !== 'texts' || !UI.hubReady(s, 'messages');
      placeTransportLegend();
      if (pill === 'texts') return;
      const shown = (pill === 'all' ? inbox : all.filter((t) => t.app === pill)).filter((t) =>
        matches(t.name, t.dest, t.addrs?.join(' '), snippetOf(t)) ||
        (googleOnly(t) ? [t.googleSource] : t.sources)?.some((c) => matches(c.name, snippetOf(c))) || t.key === chatOpen);
      const t = shown.find((x) => x.key === chatOpen);
      const google = t && googleOf(t);
      if (openContact && openContact.key === t?.key && gm?.state === 'connected' && openContact.googleId !== google?.id) {
        openContact.googleId = google?.id;
        chatEpoch++;
        chatPic.clear();
      }
      const messages = t?.dest ? projectContact(t) : t?.msgs || [];
      const k = JSON.stringify([pill, chatOpen, query, shown.map((row) => [row.key, row.at, row.name, snippetOf(row), row.sources?.map((c) => c.key), !!row.avatar]),
        messages.map(({ image, ...m }) => m), t?.items, t?.reply, t?.pic, t?.people?.map((p) => p.name),
        t?.sources?.map((c) => [c.replySession, c.items?.map((h) => h.reply && h.replySession)]), google?.id, google?.reply, google?.loaded,
        google?.more, google?.typing, ready, carrierSend(s), mmsOk(), s.hub?.perm?.messages?.sims, (s.notifs || {}).receive, synced(s),
        gm?.enabled, gm?.state, t?.dest ? lastKind.get(t.dest) : '',
        Object.keys((s.notifs || {}).historyIcons || {}).length]);
      if (k === chatKey) return;
      chatKey = k;
      const rows = shown.map((row) => threadRow(row.name, row.at, snippetOf(row), row.key === chatOpen, () => {
          if (!row.carrier) { openChat(row); return; }
          closeChat();
          chosePill = true;
          pill = 'texts';
          paintChats(UI.state);
          openThread(row.id);
        }, row.avatar, row.pkg));
      chatList.replaceChildren(...rows);
      if (!rows.length) chatList.append(el('div', { class: 'hub-empty', text: query ? tr('Nothing found') : !synced(s) && !s.notifs?.receive && !ready ? tr('Turn on Notifications to see chats here') : tr('No chats yet. They show here as messages arrive.') }));
      chatConv.hidden = !t;
      chatEmpty.hidden = !!t;
      if (!t) {
        chatPic.clear();
        return;
      }
      if (t.dest && !googleOnly(t)) {
        for (const c of t.textThreads) {
          if (carrierHistory.has(c.id)) continue;
          carrierHistory.set(c.id, { items: [], more: false, loading: true });
          carrierAsk({ t: 'sms.thread', id: c.id, before: 0, n: 50 });
        }
      }
      if (google && !google.loaded && gmHistory !== google.key) {
        gmHistory = google.key;
        gmAct('history', { chat: google.id }).then((ok) => {
          if (!ok && gmHistory === google.key && chatOpen === t.key && UI.state.googleMessages?.state === 'connected') {
            gmError = tr('Could not load Google Messages history.');
            paintChats(UI.state, true);
          }
        });
      }
      if (google) markGoogleRead(google);
      const del = UI.button(tr('Delete'), () => {
        for (const c of t.sources || [t]) {
          if (c.msgs && !c.google && api.notifReply) api.notifReply({ chat: c.key, remove: true });
          forget(c.key, c.at);
        }
        closeChat();
        paintChats(UI.state, true);
      }, 'small');
      del.classList.add('hub-del');
      del.title = tr('Delete this chat from the list here (it stays on the phone, and comes back with a new message)');
      chatHead.replaceChildren(avatar(t.name, t.avatar, t.pkg), el('div', { class: 'hub-conv-title' }, [el('div', { class: 'hub-conv-name', text: t.name }), el('div', { class: 'hint', text: t.dest || t.people?.map((p) => p.name).filter(Boolean).join(', ') || (t.group ? tr('{app} · Group', { app: APP_NAME[t.app] || '' }) : (APP_NAME[t.app] || '')) })]), del);
      const msgs = [];
      const older = googleOnly(t) ? [] : (t.textThreads || []).filter((c) => carrierHistory.get(c.id)?.more);
      if (google?.more || older.length) msgs.push(UI.button(tr('Earlier messages'), async () => {
        for (const c of older) {
          const h = carrierHistory.get(c.id);
          if (!h || h.loading || !h.items.length) continue;
          h.loading = true;
          carrierAsk({ t: 'sms.thread', id: c.id, before: h.items[0].at, n: 50 });
        }
        if (google?.more && !(await gmAct('earlier', { chat: google.id })) && chatOpen === t.key) {
          gmError = tr('Could not load earlier messages.');
          paintChats(UI.state, true);
        }
      }, 'small'));
      if (google && !google.loaded && gmError) msgs.push(UI.button(tr('Retry history'), () => {
        gmHistory = '';
        paintChats(UI.state, true);
      }, 'small'));
      let lastDay = '';
      for (const m of messages) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; msgs.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        msgs.push(el('div', { class: `hub-bubble ${m.me ? 'out' : 'in'}${transportClass(m.transport, !!(t.dest || t.app === 'rcs'))}${m.status === 'failed' ? ' failed' : ''}`, title: new Date(m.at).toLocaleString() }, [
          t.group && !m.me && m.from ? el('div', { class: 'hub-from', text: m.from }) : null,
          ...(m.source === 'carrier' ? textPictures(m) : []),
          ...(google ? (m.photos || []).map((part) => {
            const key = JSON.stringify([google.id, m.id, part]);
            const picture = (src) => el('img', { class: 'hub-pic', src, alt: tr('Picture') });
            if (gmPhotos.has(key)) return picture(gmPhotos.get(key));
            return UI.button(tr('Load photo'), async () => {
              const gm = UI.state.googleMessages;
              const epoch = chatEpoch;
              const data = await gmAct('photo', { chat: google.id, message: m.id, part }, gm);
              const current = selectedChat();
              if (!gm || epoch !== chatEpoch || current?.key !== t.key || googleOf(current)?.id !== google.id ||
                  UI.state.googleMessages?.owner !== gm.owner || UI.state.googleMessages?.state !== 'connected') return;
              if (typeof data === 'string') {
                gmPhotos.set(key, data);
                if (gmPhotos.size > 8) gmPhotos.delete(gmPhotos.keys().next().value);
              } else gmError = tr('Could not load the photo.');
              paintChats(UI.state, true);
            }, 'small');
          }) : []),
          m.pic ? el('div', { class: 'hub-text', text: tr('Picture') }) : null,
          m.text ? el('div', { class: 'hub-text', text: m.text }) : null,
          textStatus(m),
          m.receipt ? el('div', { class: 'hub-status', text: m.receipt === 'read' ? tr('Read') : tr('Delivered') }) : null,
          m.pic && m.pic !== 'sent' ? el('div', { class: 'hub-status', text: m.pic === 'sending' ? tr('Sending…') : m.pic === 'opened' ? tr('Open on the phone: tap Send there') : m.error ? tr('Not sent: {error}', { error: tr(m.error) }) : tr('Not sent') }) : null,
        ]));
      }
      const plain = transportClass('', t.app === 'rcs');
      for (const h of t.msgs || t.dest ? [] : t.items.slice().reverse()) {
        msgs.push(el('div', { class: 'hub-bubble in' + plain }, [el('div', { text: h.body || h.subtitle || '' }),
          el('div', { class: 'hub-status', text: UI.clock(h.at) })]));
        for (const r of h.replies || []) msgs.push(el('div', { class: 'hub-bubble out' + plain }, [el('div', { text: r.text }), el('div', { class: 'hub-status', text: UI.clock(r.at) })]));
      }
      if (google?.typing) msgs.push(el('div', { class: 'hint', text: tr('Typing…'), attrs: { role: 'status' } }));
      if (gmError) msgs.push(el('div', { class: 'hint', text: gmError, attrs: { role: 'status' } }));
      const wasAtBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 40;
      chatBubbles.replaceChildren(...msgs);
      if ((!google && !t.dest) || wasAtBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
      const canReply = google ? !!google.reply && google.loaded
        : canText(t, false) || !!notificationReply(t, false) || !!notificationReply(t, true);
      chatCompose.hidden = !canReply;
      chatNote.hidden = canReply;
      chatSend.disabled = !!gmSend && (!!google?.reply || gmSend.key === t.key);
      chatPic.show(chatPictureAllowed(t));
      const sims = simOptions(s);
      chatSim.options(sims);
      chatSim.el.hidden = !t.dest || !!google || !!notificationReply(t, !!chatPic.get()) || sims.length < 3;
      if (google) {
        chatNote.textContent = google.loaded ? tr('This conversation is read-only.') : gmError ? '' : tr('Loading conversation…');
      } else chatNote.textContent = t.msgs || t.dest ? tr('Reply here once the phone shows this chat’s notification again.') : tr('Answer this one on the phone: its notification has no Reply.');
    }

    chatBox.addEventListener('input', () => {
      if (!chatBox.value.trim()) { chatDraft = null; return; }
      const t = selectedChat();
      if (!t || chatDraft?.key === t.key) return;
      const offer = notificationReply(t, false);
      // Only a notification's own offer is pinned, with its verified identity when it has one.
      chatDraft = { key: t.key, offer: offer?.id ? offer : null, proof: offer?.id ? offerProof(t, offer) : null };
    });
    chatBox.addEventListener('input', () => {
      if (!chatBox.value.trim() || Date.now() - gmTypingAt < 4000) return;
      const row = selectedChat();
      const t = row && googleOf(row);
      if (!t?.loaded || !t.reply) return;
      gmTypingAt = Date.now();
      gmAct('typing', { chat: t.id });
    });
    body.append(top.el);
    if (gmCard) body.append(gmCard);
    body.append(pills, appsPanel, layout, chatLayout, chatsCard);
    chatLayout.hidden = true;

    let threads = [];
    let openId = null; // the conversation shown ('' = a new one)
    let items = []; // its messages, oldest first
    let hasMore = false;
    const parts = new Map(); // MMS picture id -> data: URL
    let pending = []; // sent from here, not yet seen in the phone's store: {ref, body, at, status}
    let refCount = 0;

    const thread = () => threads.find((t) => t.id === openId);

    // The texts as listed: not deleted here (until a newer message), and as searched.
    const visibleThreads = () => threads.filter((t) => !isGone('sms:' + t.id, t.at) && (matches(t.name, (t.addrs || []).join(' '), t.snippet) || t.id === openId));

    function renderList() {
      list.replaceChildren(...visibleThreads().map((t) => {
        const b = el('button', { class: `hub-thread${t.id === openId ? ' active' : ''}${t.unread ? ' unread' : ''}`, attrs: { 'data-literal': '' } }, [
          avatar(t.name, t.photo),
          el('span', { class: 'hub-thread-text' }, [
            el('span', { class: 'hub-thread-top' }, [el('span', { class: 'hub-thread-name', text: t.name || (t.addrs || []).join(', ') }), el('span', { class: 'hub-thread-time', text: UI.clock(t.at) })]),
            el('span', { class: 'hub-thread-snippet', text: t.snippet || '' }),
          ]),
        ]);
        b.onclick = () => openThread(t.id);
        return b;
      }));
      if (!visibleThreads().length) list.append(el('div', { class: 'hub-empty', text: query ? tr('Nothing found') : tr('No conversations') }));
    }

    function textPictures(m) {
      if (m.image) return [el('img', { class: 'hub-pic', alt: '', src: m.image })];
      return (m.parts || []).map((p) => {
        const img = el('img', { class: 'hub-pic', alt: '' });
        if (parts.has(p.id)) img.src = parts.get(p.id);
        else { parts.set(p.id, ''); carrierAsk({ t: 'sms.part', id: p.id }); }
        img.dataset.part = p.id;
        return img;
      });
    }
    function textStatus(m) {
      if (m.status === 'sending') return el('div', { class: 'hub-status', text: tr('Sending…') });
      if (m.status !== 'failed') return null;
      return el('div', { class: 'hub-status', text: m.error ? tr('Not sent: {error}', { error: tr(m.error) }) : tr('Not sent') });
    }

    function renderConv() {
      const t = thread();
      const isNew = openId === '';
      conv.hidden = openId === null;
      empty.hidden = openId !== null;
      to.hidden = !isNew;
      head.replaceChildren(...(isNew ? [to] : t ? [avatar(t.name, t.photo), el('div', { class: 'hub-conv-title' }, [el('div', { class: 'hub-conv-name', text: t.name || t.addrs.join(', ') }), el('div', { class: 'hint', text: t.name ? t.addrs.join(', ') : '' })]), delText] : []));
      const group = !!(t?.group || t?.addrs?.length > 1);
      // A member the phone could not resolve: never send to the resolved subset.
      const groupBlocked = !!t?.unresolved || (group && (!mmsOk() || t.addrs.length < 2 || t.addrs.length > MAX_GROUP));
      groupNote.hidden = !groupBlocked;
      pic.show(mmsOk());
      const sims = simOptions(UI.state);
      simPick.options(sims);
      simPick.el.hidden = sims.length < 3;
      compose.hidden = groupBlocked;
      more.hidden = !hasMore || isNew;
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
      const shown = items.concat(pending.filter((p) => p.thread === openId).map((p) => ({ id: p.ref, body: p.body, at: p.at, out: true, status: p.status, error: p.error, image: p.image })));
      let lastDay = '';
      const nodes = [];
      for (const m of shown) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; nodes.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        nodes.push(el('div', { class: `hub-bubble ${m.out ? 'out' : 'in'} text${m.status === 'failed' ? ' failed' : ''}`, title: new Date(m.at).toLocaleString() }, [
          group && !m.out && (m.fromName || m.from) ? el('div', { class: 'hub-from', text: m.fromName || m.from }) : null,
          ...textPictures(m),
          m.body ? el('div', { class: 'hub-text', text: m.body }) : null,
          textStatus(m),
        ]));
      }
      bubbles.replaceChildren(...nodes);
      if (atBottom || loadingFirst) scroll.scrollTop = scroll.scrollHeight;
      loadingFirst = false;
    }

    let loadingFirst = false;
    function openThread(id) {
      pic.clear();
      openId = id;
      items = [];
      hasMore = false;
      loadingFirst = true;
      renderList();
      renderConv();
      loadThread(id, false);
      box.focus();
    }

    function openNew() {
      pic.clear();
      openId = '';
      items = [];
      hasMore = false;
      renderList();
      renderConv();
      to.value = '';
      to.focus();
    }

    function loadThread(id, earlier) {
      if (!id) return;
      carrierAsk({ t: 'sms.thread', id, before: earlier && items.length ? items[0].at : 0, n: 50 });
    }

    function sendNow() {
      const text = box.value.trim();
      const image = pic.get();
      if (!text && !image) return;
      const t = thread();
      // Everyone in it: a group conversation, or numbers typed with commas (MMS only).
      const addrs = openId === '' ? to.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : (t && t.addrs) || [];
      const dest = addrs[0];
      if (!dest) return to.focus();
      if (openId === '' && addrs.length === 1 && googleMode(UI.state)) {
        // A known one-to-one Google conversation: open it in All with this text, never a new send.
        const verified = destination(dest, nanp);
        const known = verified ? inboxThreads(UI.state).filter((r) => {
          const g = googleOf(r);
          return g && !g.group && (r.dest || peerOf(r, nanp)) === verified;
        }) : [];
        if (known.length === 1) {
          chosePill = true;
          pill = 'all';
          closeChat();
          chatKey = '';
          openChat(known[0]);
          chatBox.value = text;
          box.value = '';
          pic.clear();
          autosize();
          paintChats(UI.state, true);
          return;
        }
      }
      // Never a silent subset: an oversized or unresolved group is refused with its note, text kept.
      if (addrs.length > MAX_GROUP) { groupNote.hidden = false; return; }
      if (t?.unresolved || (t?.group && addrs.length < 2) || ((addrs.length > 1 || image) && !mmsOk())) return;
      if (!carrierSend(UI.state)) return;
      dispatchText(addrs, text, image, simPick.el, openId);
      box.value = '';
      pic.clear();
      autosize();
      renderConv();
      scroll.scrollTop = scroll.scrollHeight;
    }

    function dispatchText(addrs, text, image, simPicker, id, contact) {
      const dest = addrs[0];
      const phone = phoneOf();
      if (!dest || !phone || addrs.length > MAX_GROUP) return;
      const ref = `r${Date.now()}-${refCount++}`;
      const p = { ref, body: text, at: Date.now(), status: 'sending', thread: id, contact, to: dest, image, phone };
      pending.push(p);
      const sim = simPicker.hidden || simPicker.value === '' ? undefined : Number(simPicker.value);
      // Bound to the phone and session it was written for: a replacement phone refuses it, and the
      // refusal shows here (never retried by itself).
      Promise.resolve(carrierAsk({ t: 'sms.send', to: dest, body: text, ref, sim,
        ...(addrs.length > 1 ? { addrs } : {}), ...(image ? { image } : {}) }, phone)).then((ok) => {
        if (ok !== false || p.status !== 'sending') return;
        p.status = 'failed';
        p.error = '';
        if (openId === p.thread) renderConv();
        if (p.contact && p.contact === chatOpen) paintChats(UI.state, true);
      }, () => {});
    }

    const autosize = () => { box.style.height = 'auto'; box.style.height = `${Math.min(140, box.scrollHeight)}px`; };
    box.oninput = autosize;
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); }
    };

    UI.hubOn('sms.threads', (m) => {
      if (!carrierReady(UI.state)) return;
      nanp = m.nanp === true;
      threads = (m.items || []).filter((t) => t && t.id);
      renderList();
      paintChats(UI.state, true);
      if (openId) renderConv();
    });
    UI.hubOn('sms.thread', (m) => {
      if (!carrierReady(UI.state)) return;
      const older = (m.items || []).slice().reverse();
      const before = Number(m.before) || 0;
      const contact = selectedChat();
      const history = carrierHistory.get(m.id);
      if (history && contact?.textThreads?.some((c) => c.id === m.id)) {
        const h = chatScroll.scrollHeight;
        const byId = new Map([...older, ...history.items].map((msg) => [msg.id, msg]));
        history.items = [...byId.values()].sort((a, b) => a.at - b.at);
        history.more = !!m.more;
        history.loading = false;
        reconcileContact(contact, m.id, history.items);
        paintChats(UI.state, true);
        if (before) chatScroll.scrollTop += chatScroll.scrollHeight - h;
      }
      if (m.id !== openId) return;
      if (before) {
        const h = scroll.scrollHeight;
        items = older.concat(items);
        hasMore = !!m.more;
        renderConv();
        scroll.scrollTop = scroll.scrollHeight - h; // stay where you were reading
      } else {
        items = older;
        hasMore = !!m.more;
        loadingFirst = true;
        renderConv();
      }
    });
    UI.hubOn('sms.part', (m) => {
      if (!m.data) return;
      parts.set(m.id, m.data);
      for (const container of [bubbles, chatBubbles]) {
        for (const img of container.querySelectorAll('img[data-part]')) if (img.dataset.part === m.id) img.src = m.data;
      }
    });
    UI.hubOn('sms.sent', (m) => {
      const p = pending.find((x) => x.ref === m.ref);
      if (!p) return;
      if (m.ok) p.status = 'sent';
      else { p.status = 'failed'; p.error = m.error || ''; }
      // An ordinary Texts send has no contact: nothing to reconcile, but it still repaints and reloads.
      const contact = m.ok && p.contact ? selectedChat() : null;
      if (contact && contact.key === p.contact) {
        for (const c of contact.textThreads || []) if (carrierHistory.get(c.id)) reconcileContact(contact, c.id, carrierHistory.get(c.id).items);
      }
      // A new conversation: the phone's store has it now (asked of the phone and session that sent it).
      if (!p.thread && m.ok) setTimeout(() => carrierAsk({ t: 'sms.threads', n: 80 }, p.phone), 800);
      if (openId === p.thread) renderConv();
      if (p.contact && p.contact === chatOpen) paintChats(UI.state, true);
    });
    let threadsTimer = 0;
    // The phone's copy of one sent from here: the same text, and a picture if it had one.
    const sameAs = (p, msg) => p.body.trim() === String(msg.body || '').trim() && !!p.image === !!(msg.parts && msg.parts.length);
    function reconcileContact(contact, id, arrived) {
      // Only after the send's own receipt: matching older history cannot hide a send that then fails.
      const sent = pending.filter((p) => p.contact === contact.key && p.status === 'sent' && (!p.thread || p.thread === id));
      const matches = (p, m) => m.out && Math.abs(p.at - m.at) < 120000 && sameAs(p, m);
      for (const m of arrived) {
        const candidates = sent.filter((p) => matches(p, m));
        if (candidates.length !== 1) continue;
        const p = candidates[0];
        if (arrived.filter((msg) => matches(p, msg)).length === 1) pending = pending.filter((x) => x !== p);
      }
    }
    UI.hubOn('sms.new', (m) => {
      if (!carrierReady(UI.state)) return;
      const msg = m.msg || {};
      const contact = selectedChat();
      const h = carrierHistory.get(m.thread);
      if (h && contact?.textThreads?.some((c) => c.id === m.thread) && !h.items.some((x) => x.id === msg.id)) {
        h.items.push(msg);
        h.items.sort((a, b) => a.at - b.at);
        reconcileContact(contact, m.thread, h.items);
        paintChats(UI.state, true);
      }
      if (m.thread === openId && !items.some((x) => x.id === msg.id)) {
        if (msg.out) {
          const i = pending.findIndex((p) => p.thread === openId && sameAs(p, msg) && p.status !== 'failed');
          if (i >= 0) pending.splice(i, 1);
        }
        items.push(msg);
        renderConv();
      }
      if (openId === '' && msg.out) { // the new conversation we just started
        const p = pending.find((x) => x.thread === '' && sameAs(x, msg));
        if (p) { pending = pending.filter((x) => x !== p); openId = m.thread; loadThread(openId, false); }
      }
      clearTimeout(threadsTimer);
      const phone = phoneOf();
      threadsTimer = setTimeout(() => carrierAsk({ t: 'sms.threads', n: 80 }, phone), 400);
      if (!page.hidden) api.hub({ do: 'seen' });
    });

    let loaded = false;
    let loadedAt = 0;
    const load = () => {
      loaded = true;
      if (Date.now() - loadedAt < 2000) return; // shown and rendered at once: asked once
      loadedAt = Date.now();
      carrierAsk({ t: 'sms.threads', n: 80 });
      if (openId) loadThread(openId, false);
    };
    UI.onShown(page, (shown) => {
      if (!shown) return;
      api.hub({ do: 'seen' });
      const t = selectedChat();
      if (t && googleOf(t)) markGoogleRead(googleOf(t));
      if (carrierReady(UI.state)) load();
    });
    renderList();
    renderConv();
    UI.onDeviceChange(() => { // another device: its conversations, not the previous one's
      pill = 'texts';
      chosePill = false;
      placeTransportLegend();
      closeChat();
      chatKey = '';
      gmSend = null;
      gmError = '';
      gmWipeError = false;
      lastKind.clear();
      resetCarrier();
      renderList();
      renderConv();
      if (!page.hidden && carrierReady(UI.state)) load();
    });

    function dropPhoneData() {
      chatEpoch++;
      openContact = null;
      threads = [];
      carrierHistory.clear();
      parts.clear();
      nanp = false;
      items = [];
      hasMore = false;
      pic.clear();
      loaded = false;
      loadedAt = 0;
      clearTimeout(threadsTimer);
    }
    function resetCarrier() {
      dropPhoneData();
      openId = null;
      pending = [];
    }

    return (s) => {
      top.render(s);
      const device = s.hub?.deviceId || '';
      const otherPhone = !!device && device !== phoneDevice;
      const sessionChanged = phoneSession !== s.hub?.session;
      if (otherPhone || sessionChanged || (!carrierReady(s) && (loaded || threads.length))) {
        phoneSession = s.hub?.session;
        if (device) phoneDevice = device;
        if (otherPhone) {
          lastKind.clear();
          closeChat();
          box.value = '';
          resetCarrier();
        } else if (sessionChanged) {
          dropPhoneData();
          chatPic.clear();
          pending = pending.filter((p) => p.status !== 'sent');
        } else resetCarrier();
        renderList();
        renderConv();
      }
      paintChats(s);
      const ready = UI.hubReady(s, 'messages');
      layout.hidden = !ready || pill !== 'texts';
      if (!ready) { loaded = false; return; }
      if (!loaded && carrierReady(s)) load();
      const canSend = carrierSend(s);
      send.disabled = !canSend;
      box.disabled = !canSend;
      box.placeholder = canSend ? tr('Text message') : tr('Allow sending on the phone to answer here');
    };
  },
});

})();
