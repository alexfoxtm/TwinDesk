// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications tab: this Mac's notifications on the other computer, and theirs here
// as native notifications. Sending needs Full Disk Access (there is no API for it on macOS).
'use strict';

UI.tab({
  id: 'notifications',
  group: 'Share',
  order: 45,
  title: I18n.t('Notifications'),
  icon: 'bell',
  desc: I18n.t('See one computer’s notifications on the other.'),
  color: 'linear-gradient(#ff6961, #ff3b30)',
  // One switch for the whole tab (both directions); each direction is shared with the
  // other computer per pair (pairsync.js), so flipping it there flips it here.
  master: { get: (s) => !!(s.notifs && (s.notifs.send || s.notifs.receive)), set: (v) => UI.api.setNotifs({ send: v, receive: v }) },
  badge: (s) => (s.notifs && (s.notifs.send || s.notifs.receive) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const sendSw = UI.switch((v) => api.setNotifs({ send: v }), { label: I18n.t('Send notifications') });
    const sendRow = UI.row(I18n.t('Show {me}’s notifications on {name}'), '', [sendSw]);
    const hideSw = UI.switch((v) => api.setNotifs({ hideText: v }), { label: I18n.t('Hide message text') });
    const hideRow = UI.row(I18n.t('Hide message text'), I18n.t('Only the app and the title'), [hideSw]);
    const fdaBtn = UI.button(I18n.t('Allow'), () => api.allowFullDisk(), 'small primary');
    const fdaRow = UI.row(I18n.t('Allow Full Disk Access'), I18n.t('Click +, or drag TwinDesk into the list'), [fdaBtn]);
    const recvSw = UI.switch((v) => api.setNotifs({ receive: v }), { label: I18n.t('Show notifications here') });
    const recvRow = UI.row(I18n.t('Show {name}’s notifications on {me}'), '', [recvSw]);
    const nativeBtn = UI.button(I18n.t('Allow'), () => api.allowNativeNotifications(), 'small primary');
    const nativeRow = UI.row(I18n.t('macOS notifications'), '', [nativeBtn]);
    const apps = el('div');

    const hist = UI.historyCard('notifs', { list: true });

    // Silence together (shared/silence.js), with an Android phone: only "silenced or not" goes
    // either way, each way switched on here and on the phone. macOS lets no app read or set a
    // Focus, so this Mac's part is the person's own shortcuts (silence-mac.js): one that reads the
    // Focus, and two that turn on and off a Focus made for TwinDesk alone. None is run, and
    // neither way works, until the person checks them here: the page says what the check showed.
    const silSendSw = UI.switch((v) => api.setSilence({ send: v }), { label: I18n.t('Silence the phone with this Mac') });
    const silSendRow = UI.row(I18n.t('Silence {name} when {me} is in a Focus'), '', [silSendSw]);
    const silFollowSw = UI.switch((v) => api.setSilence({ follow: v }), { label: I18n.t('Silence this Mac with the phone') });
    const silFollowRow = UI.row(I18n.t('Silence {me} when {name} is on Do not disturb'), '', [silFollowSw]);
    const none = [{ value: '', label: I18n.t('None') }];
    const silProbeSel = UI.select(none, (v) => api.silenceDo({ do: 'pick', which: 'probe', id: v }));
    const silOnSel = UI.select(none, (v) => api.silenceDo({ do: 'pick', which: 'on', id: v }));
    const silOffSel = UI.select(none, (v) => api.silenceDo({ do: 'pick', which: 'off', id: v }));
    const silListRow = UI.row(I18n.t('Your shortcuts'), I18n.t('macOS lets no app read or set a Focus. TwinDesk runs only the shortcuts you pick here'), [
      UI.button(I18n.t('Refresh'), () => api.silenceDo({ do: 'shortcuts' }), 'small'),
      UI.button(I18n.t('Open Shortcuts'), () => api.silenceDo({ do: 'openShortcuts' }), 'small'),
    ]);
    const silProbeRow = UI.row(I18n.t('Shortcut that reads the Focus'), '', [silProbeSel]);
    const silOnRow = UI.row(I18n.t('Shortcut that turns TwinDesk’s Focus on'), '', [silOnSel]);
    const silOffRow = UI.row(I18n.t('Shortcut that turns it off'), '', [silOffSel]);
    const silOwnSw = UI.switch((v) => api.silenceDo({ do: 'dedicated', on: v }), { label: I18n.t('These two set a Focus made only for TwinDesk') });
    const silOwnRow = UI.row(I18n.t('These two set a Focus made only for TwinDesk'), I18n.t('Never pick shortcuts for a Focus you use yourself: TwinDesk would turn it off'), [silOwnSw]);
    const silCheckBtn = UI.button(I18n.t('Check'), () => api.silenceDo({ do: 'check' }), 'small primary');
    const silCheckRow = UI.row(I18n.t('Check this setup'), '', [silCheckBtn]);
    const silCard = UI.card(I18n.t('Silence together'), [silSendRow, silFollowRow, silListRow, silProbeRow, silOnRow, silOffRow, silOwnRow, silCheckRow]);
    silCard.hidden = true;
    const silence = (s) => {
      const v = s.silence;
      const on = !!(v && v.peerId && v.mac && s.client && s.client.os === 'android');
      silCard.hidden = !on;
      if (!on) return;
      const m = v.mac;
      const peer = v.peer;
      silSendSw.set(v.send);
      silFollowSw.set(v.follow);
      const ack = v.ack && v.ack.on === true ? v.ack.r : '';
      silSendRow.setHint(!v.send ? I18n.t('Only whether it is silenced is shared, never which Focus')
        : !v.can.read ? I18n.t('Finish the setup below')
        : !peer ? I18n.t('{name} needs a newer TwinDesk')
        : !peer.follow ? I18n.t('Switch it on on {name} too')
        : !peer.set ? I18n.t('{name} hasn’t allowed Do not disturb access')
        : ack === 'applied' ? I18n.t('{name} is silenced too')
        : ack === 'kept' ? I18n.t('{name} was silenced already')
        : ack === 'overridden' ? I18n.t('Turned off on {name}: left off')
        : ack === 'failed' || ack === 'refused' ? I18n.t('{name} couldn’t be silenced')
        : I18n.t('While any Focus is on here'));
      const why = v.last && v.last.r === 'failed' ? v.last.why : '';
      silFollowRow.setHint(!v.follow ? I18n.t('A Focus you turned on yourself is never changed')
        : !v.can.set ? I18n.t('Finish the setup below')
        : !peer ? I18n.t('{name} needs a newer TwinDesk')
        : !peer.send || !peer.read ? I18n.t('Switch it on on {name} too')
        : v.stale ? I18n.t('The Focus turned on for {name} couldn’t be turned off')
        : v.leased ? I18n.t('{me} is silenced with {name}')
        : v.overridden ? I18n.t('You turned it off: left off until {name} is off and on again')
        : v.remote === true && why === 'flapping' ? I18n.t('Stopped: it kept being turned off')
        : v.remote === true && why ? I18n.t('The shortcut didn’t turn a Focus on')
        : v.remote === true && v.state === true ? I18n.t('A Focus was on already: left alone')
        : I18n.t('With your shortcuts, and only while {name} is connected'));
      const setup = v.send || v.follow;
      for (const r of [silListRow, silProbeRow, silCheckRow]) r.hidden = !setup;
      for (const r of [silOnRow, silOffRow, silOwnRow]) r.hidden = !v.follow;
      if (!setup) return;
      const list = m.shortcuts || [];
      for (const [sel, row, pick, hint] of [
        [silProbeSel, silProbeRow, m.probe, I18n.t('Its output must be “twindesk-focus off”, or “twindesk-focus on” and the Focus’s name')],
        [silOnSel, silOnRow, m.on, ''], [silOffSel, silOffRow, m.off, ''],
      ]) {
        const opts = [...none, ...list.map((x) => ({ value: x.id, label: x.name }))];
        if (pick && !list.some((x) => x.id === pick.id)) opts.push({ value: pick.id, label: pick.name });
        sel.options(opts);
        sel.set(pick ? pick.id : '');
        row.setHint(pick && pick.missing ? I18n.t('This shortcut is gone: pick another') : !m.shortcuts ? I18n.t('Refresh to see this Mac’s shortcuts') : hint);
      }
      silOwnSw.set(m.dedicated);
      silCheckBtn.disabled = m.checking;
      // What the check showed, and what it still needs: nothing here is assumed.
      const pair = v.follow && m.on && m.off && !m.on.missing && !m.off.missing;
      silCheckRow.setHint(m.checking ? I18n.t('Checking…')
        : m.fail === 'output' ? I18n.t('The shortcut that reads the Focus didn’t answer as asked')
        : m.fail === 'held' || m.held ? I18n.t('A Focus TwinDesk turned on is still on: turn it off yourself')
        : m.fail === 'on' || m.fail === 'shortcut' ? I18n.t('The shortcut didn’t turn a Focus on')
        : m.fail === 'off' ? I18n.t('The Focus wasn’t turned off again: turn it off yourself')
        : m.fail === 'unseen' ? I18n.t('The Focus couldn’t be read after the shortcut ran: turn it off yourself if it is on')
        : m.fail === 'other' ? I18n.t('Another Focus came on: turn it off and check again')
        : !m.probe || m.probe.missing ? I18n.t('Pick the shortcut that reads the Focus')
        : v.follow && !pair ? I18n.t('Pick both shortcuts')
        : v.follow && !m.dedicated ? I18n.t('Confirm the Focus is TwinDesk’s alone, then check')
        : !m.seen.none || (v.follow && !m.seen.pair) ? I18n.t('Turn every Focus off, then check. TwinDesk runs your shortcuts once')
        : !m.seen.other ? I18n.t('Now turn one of your own Focus modes on and check again')
        : I18n.t('Checked on this Mac'));
    };

    body.append(
      UI.pair(UI.dir('m2w', [sendRow, fdaRow, hideRow]), UI.dir('w2m', [recvRow, nativeRow])),
      silCard,
      UI.card(I18n.t('Apps'), [apps]),
      hist.el,
    );

    let key = '';
    return (s) => {
      const n = s.notifs;
      hist.update(s);
      silence(s);
      if (!n) return;
      const p = UI.peer(s);
      sendSw.set(n.send);
      hideSw.set(n.hideText);
      recvSw.set(n.receive);
      const native = n.nativeAccess || {};
      nativeRow.hidden = !n.receive || (native.authorization === 'authorized' && native.alerts === 'enabled' && !n.nativeFailure);
      nativeBtn.textContent = I18n.t(native.authorization === 'not-determined' ? 'Allow' : 'Open Settings');
      nativeRow.setHint(native.authorization === 'denied' ? I18n.t('Notifications are disabled for this app in macOS Settings.')
        : native.alerts === 'disabled' ? I18n.t('Enable alerts for this app in macOS Notifications settings.')
        : n.nativeFailure ? I18n.t('macOS could not show the notification. Check this app’s notification settings.')
        : native.authorization === 'not-determined' ? I18n.t('Allow macOS notifications to see alerts from your paired device.')
        : I18n.t('Notification authorization could not be checked. Open macOS Notifications settings.'));
      fdaRow.hidden = n.access !== 'noAccess';
      sendRow.setHint(!n.send ? '' : n.access === 'noAccess' ? I18n.t('Needs Full Disk Access')
        : !s.client ? I18n.t('Also switches it on the other computer') : n.sent ? I18n.t('{count} sent', { count: n.sent }) : I18n.t('As native notifications there'));
      recvRow.setHint(n.receive && n.shown ? I18n.t('{count} shown', { count: n.shown }) : I18n.t('As native notifications, from TwinDesk'));
      void p;

      const k = JSON.stringify([n.apps.map((a) => a.app), n.muted]);
      if (k === key) return;
      key = k;
      apps.replaceChildren(...(n.apps.length
        ? n.apps.map((a) => {
          const sw = UI.switch((v) => api.muteNotifApp({ app: a.app, muted: !v }), { label: I18n.t('Send {app}', { app: a.appName }) });
          sw.set(!(n.muted || []).includes(a.app));
          return UI.row(a.appName, '', [sw], { literal: true });
        })
        : [UI.row(I18n.t('No notifications yet'), I18n.t('Apps show up here after their first notification'))]));
    };
  },
});
