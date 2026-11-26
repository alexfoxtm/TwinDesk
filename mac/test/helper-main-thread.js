// Blocking helper work stays off the main run loop, which hosts the HID event tap.
// This reads the helper sources. It does not build or run the helper.
// Run: node mac/test/helper-main-thread.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../../mac-helper/Sources/macshare-helper');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function caseBody(src, name) {
  const re = new RegExp(`case "${name}":([\\s\\S]*?)\\n  case `);
  const found = src.match(re);
  assert.ok(found, `missing case ${name}`);
  return found[1];
}

test('FrontWatch keeps Accessibility off the main run loop and bounds AX IPC', () => {
  const src = read('FrontWatch.swift');
  assert.doesNotMatch(src, /CFRunLoopGetMain\(/);
  assert.match(src, /AXUIElementSetMessagingTimeout\(el, 0\.25\)/);
  assert.match(src, /AXUIElementSetMessagingTimeout\(win, 0\.25\)/);
  assert.match(src, /CFRunLoopPerformBlock\(/);
  assert.match(src, /CFRunLoopWakeUp\(/);
  assert.match(src, /CFRunLoopAddSource\(CFRunLoopGetCurrent\(\), AXObserverGetRunLoopSource\(o\), \.defaultMode\)/);
  assert.match(src, /CFRunLoopRemoveSource\(CFRunLoopGetCurrent\(\), AXObserverGetRunLoopSource\(o\), \.defaultMode\)/);
  assert.match(src, /NSWorkspace\.applicationUserInfoKey/);
  assert.match(src, /queue: \.main/);
  assert.match(src, /func set\(on: Bool\) -> Bool/);
  assert.match(src, /return trusted/);
  assert.match(src, /generation &\+= 1/);
});

test('NotifWatch polls on its own queue, not a main-run-loop timer', () => {
  const src = read('Notifs.swift');
  assert.match(src, /DispatchQueue\(label: "macshare\.notifs", qos: \.utility\)/);
  assert.match(src, /DispatchSource\.makeTimerSource\(queue: self\.queue\)/);
  assert.match(src, /repeating: 1\.0, leeway: \.milliseconds\(200\)/);
  assert.match(src, /func set\(on: Bool, done: @escaping \(Bool\) -> Void\)/);
  assert.doesNotMatch(src, /Timer\.scheduledTimer/);
  assert.match(src, /sqlite3_busy_timeout\(db, 200\)/);
  assert.doesNotMatch(src, /func readable\(\) -> Bool[\s\S]*^  func /m);
});

test('Apps.iconCache is locked for the notification queue and the work queue', () => {
  const src = read('Apps.swift');
  assert.match(src, /private static let iconLock = NSLock\(\)/);
  assert.match(src, /private static var iconCache: \[String: String\] = \[:\]/);
  assert.match(src, /iconLock\.lock\(\)/);
  assert.match(src, /defer \{ iconLock\.unlock\(\) \}/);
  assert.match(src, /static func runningRegular\(\) -> \[ListedApp\]/);
  assert.match(src, /static func list\(running: \[ListedApp\]\)/);
  assert.doesNotMatch(src, /static func list\(\)/);
});

test('blocking commands leave handle() on the main run loop', () => {
  const main = read('main.swift');
  const wifi = read('Wifi.swift');
  assert.match(main, /private let helperWorkQueue = DispatchQueue\(label: "macshare\.work", qos: \.userInitiated\)/);
  assert.match(main, /String\(format: "main handle %@ took %\.1f ms", name, ms\)/);
  assert.match(main, /writerQueue\.async \{ log\(String\(format: "main handle %@ took %\.1f ms", name, ms\)\) \}/);
  assert.match(main, /if ms > 50 && finished - lastSlowHandle >= 5/);

  const textFocus = caseBody(main, 'textFocus');
  assert.match(textFocus, /helperWorkQueue\.async \{ reply\(id, textFocus\(\)\) \}/);
  assert.doesNotMatch(textFocus, /reply\(id, textFocus\(\)\)\s*$/m);

  const otpTarget = caseBody(main, 'otpTarget');
  assert.match(otpTarget, /helperWorkQueue\.async/);
  assert.match(otpTarget, /OtpTargetController\.shared\.capture/);

  const otpFill = caseBody(main, 'otpFill');
  assert.match(otpFill, /helperWorkQueue\.async/);
  assert.match(otpFill, /OtpTargetController\.shared\.fill/);

  const notifWatch = caseBody(main, 'notifWatch');
  assert.match(notifWatch, /NotifWatch\.shared\.set\(on: \(msg\["on"\] as\? Bool\) \?\? false\) \{ readable in/);
  assert.match(notifWatch, /reply\(id, \["readable": readable\]\)/);
  assert.doesNotMatch(notifWatch, /\.readable\(\)/);

  const windowAt = caseBody(main, 'windowAt');
  assert.match(windowAt, /helperWorkQueue\.async/);
  assert.match(windowAt, /CGWindowListCopyWindowInfo/);

  const smbUnmount = caseBody(main, 'smbUnmount');
  assert.match(smbUnmount, /helperWorkQueue\.async/);
  assert.match(smbUnmount, /Smb\.unmount\(path: path\)/);

  const appsList = caseBody(main, 'appsList');
  assert.match(appsList, /Apps\.runningRegular\(\)/);
  assert.match(appsList, /helperWorkQueue\.async \{ reply\(id, \["apps": Apps\.list\(running: running\)\]\) \}/);

  for (const name of ['appWindows', 'appResize', 'appMove', 'appPlace', 'appFocus', 'appClose']) {
    const body = caseBody(main, name);
    assert.match(body, /helperWorkQueue\.async/, name);
  }
  assert.match(caseBody(main, 'appFocus'), /Apps\.focus\(wid: wid, owners: owners\)/);
  assert.match(caseBody(main, 'appClose'), /Apps\.close\(wid: wid, owners: owners\)/);
  assert.match(caseBody(main, 'appResize'), /Apps\.resize\(wid: wid, w: w, h: h, owners: owners\)/);
  assert.match(caseBody(main, 'appPlace'), /Apps\.place\(wid: wid, x: x, y: y, owners: owners\)/);
  assert.match(caseBody(main, 'appMove'), /Apps\.moveOnto\(pid: pid, bounds: bounds\)/);
  assert.match(caseBody(main, 'appWindows'), /Apps\.windows\(pids: pids, popups: popups\)/);

  const wifiInfo = caseBody(main, 'wifiInfo');
  assert.match(wifiInfo, /WifiCtl\.shared\.info \{ dict in reply\(id, dict\) \}/);
  assert.doesNotMatch(wifiInfo, /WifiCtl\.shared\.info\(\)/);
  assert.match(wifi, /func info\(done: @escaping \(\[String: Any\]\) -> Void\)/);
  assert.match(wifi, /work\.async \{ done\(self\.info\(\)\) \}/);

  assert.match(caseBody(main, 'capture'), /Capture\.shared\.startCapture/);
  assert.match(caseBody(main, 'inject'), /injector\.injectRel/);
  assert.match(main, /pasteboardWatch\.set\(on:/);
  assert.match(main, /BlePeripheral\.shared\.start/);
  assert.match(main, /WindowGrab\.shared\.setKey/);
});

test('a click reads the drag pasteboard only while file drags can cross', () => {
  const src = read('Capture.swift');
  assert.match(src, /if type == \.leftMouseDown && edgeEnabled && dragFiles \{ dragPbCount = NSPasteboard\(name: \.drag\)\.changeCount \}/);
  assert.match(src, /if \(edgeEnabled && !self\.edgeEnabled\) \|\| \(dragFiles && !self\.dragFiles\) \{ dragPbCount = -1 \}/);
  assert.match(src, /func injectedLeftDown\(\) \{\s*dragPbCount = NSPasteboard\(name: \.drag\)\.changeCount/s);
  assert.match(src, /CGEvent\.tapCreate\(tap: \.cghidEventTap, place: \.headInsertEventTap, options: \.defaultTap,/);
});
