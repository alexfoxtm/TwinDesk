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

// Same normalization as Android's MessageChat fingerprint and sameDestination.
const destination = (value) => {
  const address = String(value || '').trim();
  if (!/^\+?[0-9() .-]+$/.test(address)) return '';
  const digits = address.replace(/\D/g, '');
  return digits.length && digits.length <= 15 ? (address.startsWith('+') ? '+' : '') + digits : '';
};
const sameDestination = (a, b) => {
  const left = destination(a);
  const right = destination(b);
  return !!left && !!right && (left === right ||
    (left.replace(/\D/g, '').length >= 10 && right.replace(/\D/g, '').length >= 10 && left.slice(-10) === right.slice(-10)));
};
const messageText = (text) => String(text || '').replace(/\r\n/g, '\n').trim();
const sameMessage = (a, b) => !!messageText(a) && messageText(a) === messageText(b);
const coversText = (rows, t) => {
  const candidates = rows.filter((c) => t.addrs?.length === 1 && !c.group && c.addrs?.length === 1 &&
    sameDestination(t.addrs[0], c.addrs[0]));
  return candidates.length === 1 && candidates[0].at >= t.at &&
    (Math.floor(candidates[0].at / 1000) === Math.floor(t.at / 1000) && sameMessage(t.snippet, candidates[0].snippet) ||
      candidates[0].msgs.some((m) => Math.floor(m.at / 1000) === Math.floor(t.at / 1000) && sameMessage(t.snippet, m.text)));
};
const coversStructured = (rows, fallback) => {
  const latest = fallback.msgs[fallback.msgs.length - 1];
  if (!latest) return false;
  if (latest.match) {
    const candidates = rows.filter((c) => c.fingerprints?.some((m) =>
      m.at === latest.at && m.matches.includes(latest.match)));
    return candidates.length === 1;
  }
  return !latest.me && coversNotification(rows, fallback.name, latest.text, latest.at, 1000);
};
const coversNotification = (rows, title, text, at, slack) => {
  if (!title || !text || !at) return false;
  const candidates = rows.filter((c) => {
    const nameMatches = destination(title) ? !c.group && c.addrs?.length === 1 && sameDestination(title, c.addrs[0])
      : c.name?.trim() === title.trim();
    if (!nameMatches) return false;
    return Math.abs(c.at - at) <= slack && sameMessage(c.snippet, text) ||
      c.msgs.some((m) => !m.me && Math.abs(m.at - at) <= slack && sameMessage(m.text, text));
  });
  return candidates.length === 1;
};

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
// pastes onto `zone`. enabled(): whether a picture can go to this conversation now.
function attacher({ el, button }, zone, box, enabled) {
  let data = '';
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
  const take = (file) => {
    if (!file || !enabled()) return;
    shrink(file).then((d) => { set(d); box.focus(); }).catch(() => {});
  };
  input.onchange = () => { take(imageOf(input.files)); input.value = ''; };
  remove.onclick = () => set('');
  zone.addEventListener('dragover', (e) => { if (enabled() && [...(e.dataTransfer.items || [])].some((i) => /^image\//.test(i.type))) { e.preventDefault(); zone.classList.add('hub-drop'); } });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('hub-drop'); });
  zone.addEventListener('drop', (e) => { zone.classList.remove('hub-drop'); const f = imageOf(e.dataTransfer.files); if (f && enabled()) { e.preventDefault(); take(f); } });
  box.addEventListener('paste', (e) => { const f = imageOf(e.clipboardData && e.clipboardData.files); if (f && enabled()) { e.preventDefault(); take(f); } });
  return { btn, chip, input, get: () => data, clear: () => set(''), show(on) { btn.hidden = !on; if (!on) set(''); } };
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
    const simPick = UI.select([{ value: '', label: tr('Default SIM') }], () => {});
    simPick.el.setAttribute('aria-label', tr('SIM'));
    simPick.el.hidden = true;
    const conv = el('div', { class: 'hub-conv' });
    const mmsOk = () => !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.messages && UI.state.hub.perm.messages.mms);
    const pic = attacher(UI, conv, box, () => mmsOk() && !box.disabled);
    const compose = el('div', { class: 'hub-compose-row' }, [simPick.el, pic.btn, el('div', { class: 'hub-compose-col' }, [pic.chip, box]), send, pic.input]);
    conv.append(head, scroll, groupNote, compose);
    const empty = el('div', { class: 'hub-empty hub-conv-empty', text: tr('Choose a conversation') });
    const textSearch = searchBox(() => { renderList(); paintChats(UI.state, true); });
    const delText = UI.button(tr('Delete'), () => {
      const t = thread();
      if (!t) return;
      forget('sms:' + t.id, t.at);
      openId = null;
      renderList();
      renderConv();
    }, 'small');
    delText.title = tr('Delete this conversation from the list here (it stays on the phone, and comes back with a new message)');
    const layout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [el('div', { class: 'hub-side-head' }, [textSearch, newBtn]), list]), conv, empty]);
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
    const pills = el('div', { class: 'msg-pills', attrs: { role: 'tablist' } });
    const pillBtns = CHAT.map(([id, label]) => {
      const b = el('button', { class: 'msg-pill', text: label, attrs: { role: 'tab' } });
      b.onclick = () => { chosePill = true; pill = id; chatOpen = ''; chatKey = ''; paintChats(UI.state); if (UI.state) layout.hidden = pill !== 'texts' || !UI.hubReady(UI.state, 'messages'); };
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
        if (!v && pill === id) pill = 'all';
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
    const chatPicOk = () => { const t = chatThreads(UI.state).find((x) => x.key === chatOpen); return !!(t && t.msgs && t.pic); };
    const chatPic = attacher(UI, chatConv, chatBox, chatPicOk);
    const chatCompose = el('div', { class: 'hub-compose-row' }, [chatPic.btn, el('div', { class: 'hub-compose-col' }, [chatPic.chip, chatBox]), chatSend, chatPic.input]);
    chatConv.append(chatHead, chatScroll, chatNote, chatCompose);
    const chatEmpty = el('div', { class: 'hub-empty hub-conv-empty', text: tr('Choose a conversation') });
    const chatSearch = searchBox(() => { renderList(); paintChats(UI.state, true); });
    const chatLayout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [el('div', { class: 'hub-side-head' }, [chatSearch]), chatList]), chatConv, chatEmpty]);
    let chatOpen = ''; // app|title
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
      if (gm?.state !== 'connected' || hiddenApps.has('rcs')) return [];
      return gm.rows.map((c) => {
        const history = gm.history?.chat === c.id ? gm.history : null;
        return {
          ...c, key: 'google:' + c.id, pkg: 'com.google.android.apps.messaging', app: 'rcs', google: true,
          name: c.name || c.addrs?.join(', ') || tr('Google Messages'), pic: c.reply,
          msgs: history?.items || [], loaded: !!history?.loaded, more: !!history?.more, typing: !!history?.typing,
        };
      }).filter((c) => !isGone(c.key, c.at));
    };
    function openChat(t) {
      if (chatOpen !== t.key && (t.google || chatOpen.startsWith('google:'))) {
        chatBox.value = '';
        chatPic.clear();
        gmHistory = '';
        gmRead = '';
        gmTypingAt = 0;
        gmError = '';
        gmPhotos.clear();
      }
      chatOpen = t.key;
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
      const own = synced(s) ? s.chats.map((c) => ({ key: c.key, pkg: c.app, avatar: c.avatar || '', app: appOf(c.app) || 'other', name: appOf(c.app) ? c.name || c.appName : [c.name, c.appName].filter(Boolean).join(' · '), group: !!c.group, reply: !!c.reply, pic: !!c.pic, at: c.at, msgs: c.items || [] })) : [];
      const by = new Map();
      for (const h of ((s && s.notifs) || {}).history || []) {
        const app = appOf(h.app);
        // Skip RCS from history only once the phone is delivering structured messaging conversations.
        // Windows, Linux and older phones have no socket, so they keep the previous history fallback.
        if (!app || (app !== 'rcs' && synced(s))) continue;
        if (app === 'rcs' && s.chatsMessaging) continue;
        if (h.app === 'com.google.android.apps.messaging' && coversNotification(google, h.title, h.body, h.at, 120000)) continue;
        if (h.live || BUSY.test(h.body || '') || BUSY.test(h.title || '')) continue; // the app at work, not a message
        const key = app + '|' + (h.title || h.appName);
        const t = by.get(key) || { key, pkg: h.app, avatar: h.avatar || '', app, name: h.title || h.appName, items: [], at: 0 };
        t.items.push(h);
        t.at = Math.max(t.at, h.at);
        by.set(key, t);
      }
      const uncovered = own.filter((t) => t.pkg !== 'com.google.android.apps.messaging' ||
        !coversStructured(google, t));
      return google.concat(uncovered, [...by.values()]).filter((t) => (t.app !== 'rcs' || !!(s.hub && s.hub.messages)) &&
        !hiddenApps.has(t.app) && !isGone(t.key, t.at)).sort((a, b) => b.at - a.at);
    }
    // A chat app's notice that isn't a message: "Sending video…", "Deleting chats… 100%".
    const BUSY = /^(?:sending|uploading|downloading|deleting|backing up|restoring|checking for new messages|preparing|syncing)\b|\b\d{1,3}\s?%\s*$/i;
    // A conversation's last message, as its row shows it.
    function snippetOf(t) {
      if (!t.msgs) return (t.items[0] && t.items[0].body) || '';
      const m = t.msgs[t.msgs.length - 1];
      if (!m && t.google) return t.snippet || '';
      return m ? m.me ? tr('You: {message}', { message: m.text }) : t.group && m.from ? tr('{sender}: {message}', { sender: m.from, message: m.text }) : m.text : '';
    }
    async function chatReply() {
      const t = chatThreads(UI.state).find((x) => x.key === chatOpen);
      const text = chatBox.value.trim();
      const image = chatPic.get();
      if (t?.google) {
        if (!t.reply || (!text && !image) || gmSend) return;
        const gm = UI.state.googleMessages;
        const request = {};
        gmSend = request;
        gmError = '';
        paintChats(UI.state, true);
        const ok = await gmAct('send', { chat: t.id, text: image ? '' : text, image }, gm);
        if (gmSend !== request) return;
        gmSend = null;
        if (chatOpen !== t.key || UI.state.googleMessages?.owner !== gm.owner) return;
        if (ok) {
          if (image && chatPic.get() === image) chatPic.clear();
          if (!image && chatBox.value.trim() === text) chatBox.value = '';
        } else gmError = tr('Google Messages could not confirm the send. Check the conversation before retrying.');
        paintChats(UI.state, true);
        return;
      }
      if (t && t.msgs && t.pic && image && api.notifReply) {
        api.notifReply({ chat: t.key, text, image });
        chatBox.value = '';
        chatPic.clear();
        return;
      }
      if (!t || !text || !api.notifReply) return;
      if (t.msgs) {
        if (!t.reply) return;
        api.notifReply({ chat: t.key, text });
      } else {
        const last = t.items.find((h) => h.reply);
        if (!last) return;
        api.notifReply({ id: last.id, text });
      }
      chatBox.value = '';
    }
    const threadRow = (name, at, snippet, active, onClick, photo, pkg) => {
      const b = el('button', { class: `hub-thread${active ? ' active' : ''}`, attrs: { 'data-literal': '' } }, [avatar(name, photo, pkg), el('span', { class: 'hub-thread-text' }, [
        el('span', { class: 'hub-thread-top' }, [el('span', { class: 'hub-thread-name', text: name }), el('span', { class: 'hub-thread-time', text: UI.clock(at) })]),
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
      paintAccount(gm);
      const on = !!s.ui?.chats || gm?.state === 'connected';
      chatsSw.set(!!s.ui?.chats);
      pills.hidden = !on;
      chatsCard.hidden = !!s.ui?.chats || !api.setChats;
      if (!on && pill !== 'texts') pill = 'texts';
      const all = chatThreads(s);
      if (chatsRow.setHint) chatsRow.setHint(chatsHint(!!(s && s.chatsMessaging)));
      if (on && !chosePill) pill = all.some((t) => t.app === 'rcs') ? 'all' : 'texts';
      for (const [id, b] of pillBtns) {
        b.classList.toggle('on', id === pill);
        b.setAttribute('aria-selected', String(id === pill));
        b.hidden = hiddenApps.has(id) || (OPTIONAL.includes(id) && id !== pill && !all.some((t) => t.app === id));
      }
      appsBtn.hidden = !on;
      if (!on) appsPanel.hidden = true;
      chatLayout.hidden = pill === 'texts';
      layout.hidden = pill !== 'texts' || !UI.hubReady(s, 'messages');
      if (pill === 'texts') return;
      const shown = all.filter((t) => (pill === 'all' || t.app === pill) && (matches(t.name, snippetOf(t)) || t.key === chatOpen));
      const sum = (t) => t.google
        ? [t.at, t.snippet, t.reply, t.loaded, t.more, t.typing, t.msgs.map((m) => [m.id, m.text, m.receipt, m.photos])]
        : (t.msgs ? [t.msgs.length, t.reply, t.pic, t.msgs.map((m) => m.id || m.pic || '').join()] : [t.items.length, t.items.map((h) => (h.replies || []).length)]);
      const k = JSON.stringify([pill, chatOpen, query, shown.map((t) => [t.key, t.at, sum(t), !!t.avatar]), pill === 'all' ? threads.map((t) => t.id + t.at) : 0, (s.notifs || {}).receive, synced(s), Object.keys((s.notifs || {}).historyIcons || {}).length]);
      if (k === chatKey) return;
      chatKey = k;
      // The list: chats, and in All the texts too (opening one goes to Texts).
      const snippet = snippetOf;
      const rows = shown.map((t) => ({ at: t.at, el: threadRow(t.name, t.at, (APP_NAME[t.app] || '') + ' · ' + snippet(t), t.key === chatOpen, () => openChat(t), t.avatar, t.pkg) }));
      if (pill === 'all') {
        for (const t of visibleThreads()) {
          if (coversText(all.filter((c) => c.google), t)) continue;
          rows.push({ at: t.at || 0, el: threadRow(t.name || (t.addrs || []).join(', '), t.at, tr('Texts · {message}', { message: t.snippet || '' }), false, () => { chosePill = true; pill = 'texts'; paintChats(UI.state); openThread(t.id); }, t.photo) });
        }
      }
      rows.sort((a, b) => b.at - a.at);
      chatList.replaceChildren(...rows.map((r) => r.el));
      if (!rows.length) chatList.append(el('div', { class: 'hub-empty', text: query ? tr('Nothing found') : !synced(s) && !(s.notifs || {}).receive ? tr('Turn on Notifications to see chats here') : tr('No chats yet. They show here as messages arrive.') }));
      const t = shown.find((x) => x.key === chatOpen);
      chatConv.hidden = !t;
      chatEmpty.hidden = !!t;
      if (!t) return;
      if (t.google && !t.loaded && gmHistory !== t.key) {
        gmHistory = t.key;
        gmError = '';
        gmAct('history', { chat: t.id }).then((ok) => {
          if (!ok && gmHistory === t.key && chatOpen === t.key && UI.state.googleMessages?.state === 'connected') {
            gmError = tr('Could not load Google Messages history.');
            paintChats(UI.state, true);
          }
        });
      }
      if (t.google) markGoogleRead(t);
      const del = UI.button(tr('Delete'), () => {
        if (t.msgs && !t.google && api.notifReply) api.notifReply({ chat: t.key, remove: true }); // off the list kept here (shared/chats.js)
        forget(t.key, t.at); // and from notifications (an older phone): until a newer message
        chatOpen = '';
        paintChats(UI.state, true);
      }, 'small');
      del.classList.add('hub-del');
      del.title = tr('Delete this chat from the list here (it stays on the phone, and comes back with a new message)');
      chatHead.replaceChildren(avatar(t.name, t.avatar, t.pkg), el('div', { class: 'hub-conv-title' }, [el('div', { class: 'hub-conv-name', text: t.name }), el('div', { class: 'hint', text: t.group ? tr('{app} · Group', { app: APP_NAME[t.app] || '' }) : (APP_NAME[t.app] || '') })]), del);
      const msgs = [];
      if (t.google && t.more) msgs.push(UI.button(tr('Earlier messages'), async () => {
        if (!(await gmAct('earlier', { chat: t.id })) && chatOpen === t.key) {
          gmError = tr('Could not load earlier messages.');
          paintChats(UI.state, true);
        }
      }, 'small'));
      if (t.google && !t.loaded && gmError) msgs.push(UI.button(tr('Retry history'), () => {
        gmHistory = '';
        paintChats(UI.state, true);
      }, 'small'));
      let lastDay = '';
      for (const m of t.msgs || []) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; msgs.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        msgs.push(el('div', { class: `hub-bubble ${m.me ? 'out' : 'in'}`, title: new Date(m.at).toLocaleString() }, [
          t.group && !m.me && m.from ? el('div', { class: 'hub-from', text: m.from }) : null,
          ...(t.google ? (m.photos || []).map((part) => {
            const key = JSON.stringify([t.id, m.id, part]);
            const picture = (src) => el('img', { class: 'hub-pic', src, alt: tr('Picture') });
            if (gmPhotos.has(key)) return picture(gmPhotos.get(key));
            return UI.button(tr('Load photo'), async () => {
              const gm = UI.state.googleMessages;
              const data = await gmAct('photo', { chat: t.id, message: m.id, part }, gm);
              if (chatOpen !== t.key || UI.state.googleMessages?.owner !== gm.owner || UI.state.googleMessages?.state !== 'connected') return;
              if (typeof data === 'string') {
                gmPhotos.set(key, data);
                if (gmPhotos.size > 8) gmPhotos.delete(gmPhotos.keys().next().value);
              } else gmError = tr('Could not load the photo.');
              paintChats(UI.state, true);
            }, 'small');
          }) : []),
          m.pic ? el('div', { class: 'hub-text', text: tr('Picture') }) : null,
          m.text ? el('div', { class: 'hub-text', text: m.text }) : null,
          m.receipt ? el('div', { class: 'hub-status', text: m.receipt === 'read' ? tr('Read') : tr('Delivered') }) : null,
          m.pic && m.pic !== 'sent' ? el('div', { class: 'hub-status', text: m.pic === 'sending' ? tr('Sending…') : m.pic === 'opened' ? tr('Open on the phone: tap Send there') : m.error ? tr('Not sent: {error}', { error: tr(m.error) }) : tr('Not sent') }) : null,
        ]));
      }
      for (const h of t.msgs ? [] : t.items.slice().reverse()) {
        msgs.push(el('div', { class: 'hub-bubble in' }, [el('div', { text: h.body || h.subtitle || '' }), el('div', { class: 'hub-status', text: UI.clock(h.at) })]));
        for (const r of h.replies || []) msgs.push(el('div', { class: 'hub-bubble out' }, [el('div', { text: r.text }), el('div', { class: 'hub-status', text: UI.clock(r.at) })]));
      }
      if (t.google && t.typing) msgs.push(el('div', { class: 'hint', text: tr('Typing…'), attrs: { role: 'status' } }));
      if (t.google && gmError) msgs.push(el('div', { class: 'hint', text: gmError, attrs: { role: 'status' } }));
      const wasAtBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 40;
      chatBubbles.replaceChildren(...msgs);
      if (!t.google || wasAtBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
      const canReply = t.google ? t.loaded && t.reply : (t.msgs ? t.reply || t.pic : t.items.some((h) => h.reply)) && !!api.notifReply;
      chatCompose.hidden = !canReply;
      chatNote.hidden = canReply;
      chatSend.disabled = !!(t.google && gmSend);
      chatPic.show(!!(t.msgs && t.pic));
      if (t.google) {
        chatNote.textContent = t.loaded ? tr('This conversation is read-only.') : gmError ? '' : tr('Loading conversation…');
      } else chatNote.textContent = t.msgs ? tr('Reply here once the phone shows this chat’s notification again.') : tr('Answer this one on the phone: its notification has no Reply.');
    }

    chatBox.addEventListener('input', () => {
      if (!chatBox.value.trim() || Date.now() - gmTypingAt < 4000) return;
      const t = paired(UI.state).find((c) => c.key === chatOpen);
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

    function renderConv() {
      const t = thread();
      const isNew = openId === '';
      conv.hidden = openId === null;
      empty.hidden = openId !== null;
      to.hidden = !isNew;
      head.replaceChildren(...(isNew ? [to] : t ? [avatar(t.name, t.photo), el('div', { class: 'hub-conv-title' }, [el('div', { class: 'hub-conv-name', text: t.name || t.addrs.join(', ') }), el('div', { class: 'hint', text: t.name ? t.addrs.join(', ') : '' })]), delText] : []));
      const group = !!(t && t.addrs && t.addrs.length > 1);
      groupNote.hidden = !group || mmsOk(); // a phone that sends MMS answers groups too
      pic.show(mmsOk());
      const sims = (UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.messages && UI.state.hub.perm.messages.sims) || [];
      simPick.options([{ value: '', label: tr('Default SIM') }, ...sims.map((x) => ({ value: String(x.id), label: x.label }))]);
      simPick.el.hidden = sims.length < 2;
      compose.hidden = group && !mmsOk();
      more.hidden = !hasMore || isNew;
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
      const shown = items.concat(pending.filter((p) => p.thread === openId).map((p) => ({ id: p.ref, body: p.body, at: p.at, out: true, status: p.status, error: p.error, image: p.image })));
      let lastDay = '';
      const nodes = [];
      for (const m of shown) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; nodes.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        const pics = m.image ? [el('img', { class: 'hub-pic', alt: '', src: m.image })] : (m.parts || []).map((p) => {
          const img = el('img', { class: 'hub-pic', alt: '' });
          if (parts.has(p.id)) img.src = parts.get(p.id);
          else { parts.set(p.id, ''); UI.hubAsk({ t: 'sms.part', id: p.id }); }
          img.dataset.part = p.id;
          return img;
        });
        nodes.push(el('div', { class: `hub-bubble ${m.out ? 'out' : 'in'}${m.status === 'failed' ? ' failed' : ''}`, title: new Date(m.at).toLocaleString() }, [
          group && !m.out && (m.fromName || m.from) ? el('div', { class: 'hub-from', text: m.fromName || m.from }) : null,
          ...pics,
          m.body ? el('div', { class: 'hub-text', text: m.body }) : null,
          m.status ? el('div', { class: 'hub-status', text: m.status === 'sending' ? tr('Sending…') : m.status === 'failed' ? m.error ? tr('Not sent: {error}', { error: tr(m.error) }) : tr('Not sent') : '' }) : null,
        ]));
      }
      bubbles.replaceChildren(...nodes);
      if (atBottom || loadingFirst) scroll.scrollTop = scroll.scrollHeight;
      loadingFirst = false;
    }

    let loadingFirst = false;
    function openThread(id) {
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
      UI.hubAsk({ t: 'sms.thread', id, before: earlier && items.length ? items[0].at : 0, n: 50 });
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
      if ((addrs.length > 1 || image) && !mmsOk()) return;
      const ref = `r${Date.now()}-${refCount++}`;
      pending.push({ ref, body: text, at: Date.now(), status: 'sending', thread: openId, to: dest, image });
      const sim = simPick.el.hidden || simPick.el.value === '' ? undefined : Number(simPick.el.value);
      UI.hubAsk({ t: 'sms.send', to: dest, body: text, ref, sim, ...(addrs.length > 1 ? { addrs: addrs.slice(0, 20) } : {}), ...(image ? { image } : {}) });
      box.value = '';
      pic.clear();
      autosize();
      renderConv();
      scroll.scrollTop = scroll.scrollHeight;
    }

    const autosize = () => { box.style.height = 'auto'; box.style.height = `${Math.min(140, box.scrollHeight)}px`; };
    box.oninput = autosize;
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); }
    };

    UI.hubOn('sms.threads', (m) => {
      threads = (m.items || []).filter((t) => t && t.id);
      renderList();
      paintChats(UI.state, true);
      if (openId) renderConv();
    });
    UI.hubOn('sms.thread', (m) => {
      if (m.id !== openId) return;
      const older = (m.items || []).slice().reverse();
      const before = Number(m.before) || 0;
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
      for (const img of bubbles.querySelectorAll('img[data-part]')) if (img.dataset.part === m.id) img.src = m.data;
    });
    UI.hubOn('sms.sent', (m) => {
      const p = pending.find((x) => x.ref === m.ref);
      if (!p) return;
      if (m.ok) p.status = 'sent';
      else { p.status = 'failed'; p.error = m.error || ''; }
      // A new conversation: the phone's store has it now.
      if (p.thread === '' && m.ok) setTimeout(() => UI.hubAsk({ t: 'sms.threads', n: 80 }), 800);
      if (openId === p.thread) renderConv();
    });
    let threadsTimer = 0;
    // The phone's copy of one sent from here: the same text, and a picture if it had one.
    const sameAs = (p, msg) => p.body.trim() === String(msg.body || '').trim() && !!p.image === !!(msg.parts && msg.parts.length);
    UI.hubOn('sms.new', (m) => {
      const msg = m.msg || {};
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
      threadsTimer = setTimeout(() => UI.hubAsk({ t: 'sms.threads', n: 80 }), 400);
      if (!page.hidden) api.hub({ do: 'seen' });
    });

    let loaded = false;
    let loadedAt = 0;
    const load = () => {
      loaded = true;
      if (Date.now() - loadedAt < 2000) return; // shown and rendered at once: asked once
      loadedAt = Date.now();
      UI.hubAsk({ t: 'sms.threads', n: 80 });
      if (openId) loadThread(openId, false);
    };
    UI.onShown(page, (shown) => {
      if (!shown) return;
      api.hub({ do: 'seen' });
      const t = UI.state && paired(UI.state).find((c) => c.key === chatOpen);
      if (t) markGoogleRead(t);
      if (UI.hubReady(UI.state, 'messages')) load();
    });
    renderList();
    renderConv();
    UI.onDeviceChange(() => { // another device: its conversations, not the previous one's
      pill = 'texts';
      chosePill = false;
      chatOpen = '';
      chatKey = '';
      chatBox.value = '';
      gmSend = null;
      gmError = '';
      gmWipeError = false;
      gmHistory = '';
      gmRead = '';
      gmPhotos.clear();
      threads = [];
      openId = null;
      items = [];
      hasMore = false;
      pending = [];
      pic.clear();
      chatPic.clear();
      loaded = false;
      loadedAt = 0;
      renderList();
      renderConv();
      if (!page.hidden && UI.hubReady(UI.state, 'messages')) load();
    });

    return (s) => {
      top.render(s);
      paintChats(s);
      const ready = UI.hubReady(s, 'messages');
      layout.hidden = !ready || pill !== 'texts';
      if (!ready) { loaded = false; return; }
      if (!loaded) load();
      const canSend = !(s.hub.perm.messages.missing || []).includes('send');
      send.disabled = !canSend;
      box.disabled = !canSend;
      box.placeholder = canSend ? tr('Text message') : tr('Allow sending on the phone to answer here');
    };
  },
});

})();
