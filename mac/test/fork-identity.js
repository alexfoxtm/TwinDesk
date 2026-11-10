// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// The fork's macOS and Android identities must not be upstream's, or an extension can register
// against the upstream app. This does not read or change TCC, Keychain, or an installed app.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const UPSTREAM_BUNDLE = /org\.macshare\.mac(?:\.|$)/;
const UPSTREAM_SCHEME = /setAsDefaultProtocolClient\('macshare'\)|<string>macshare<\/string>|c\.scheme = "macshare"|URL\(string: "macshare:/;

function claimsUpstream(source) {
  return UPSTREAM_BUNDLE.test(source) || UPSTREAM_SCHEME.test(source);
}

const files = {
  'mac/build-app.sh': read('mac/build-app.sh'),
  'mac/main.js': read('mac/main.js'),
  'mac/mesh/main.js': read('mac/mesh/main.js'),
  'mac/login.js': read('mac/login.js'),
  'mac/vcam.js': read('mac/vcam.js'),
  'mac/dockstub.js': read('mac/dockstub.js'),
  'mac/phone-bridge.js': read('mac/phone-bridge.js'),
  'mac/wired.js': read('mac/wired.js'),
  'mac-helper/Sources/macshare-helper/Info.plist': read('mac-helper/Sources/macshare-helper/Info.plist'),
  'mac-helper/Sources/macshare-calls/Info.plist': read('mac-helper/Sources/macshare-calls/Info.plist'),
  'mac-helper/Sources/macshare-share/ShareViewController.swift': read('mac-helper/Sources/macshare-share/ShareViewController.swift'),
  'mac-helper/Sources/macshare-dockstub/main.swift': read('mac-helper/Sources/macshare-dockstub/main.swift'),
  'mac-helper/Sources/twindesk-vcam/main.swift': read('mac-helper/Sources/twindesk-vcam/main.swift'),
  'android/app/build.gradle.kts': read('android/app/build.gradle.kts'),
  'android/app/src/main/res/xml/shortcuts.xml': read('android/app/src/main/res/xml/shortcuts.xml'),
};

function main() {
  const build = files['mac/build-app.sh'];
  assert.match(build, /--app-bundle-id=io\.github\.alexfoxtm\.twindesk /);
  assert.match(build, /--helper-bundle-id=io\.github\.alexfoxtm\.twindesk\.helper /);
  assert.match(build, /<string>io\.github\.alexfoxtm\.twindesk\.share<\/string>/);
  assert.match(build, /<string>io\.github\.alexfoxtm\.twindesk\.camera<\/string>/);
  assert.match(build, /<string>alexfoxtm-twindesk<\/string>/);
  assert.doesNotMatch(build, /<string>macshare<\/string>/);
  assert.match(files['mac/main.js'], /app\.getPath\('appData'\), 'io\.github\.alexfoxtm\.twindesk'\)/);
  assert.match(files['mac/main.js'], /setAsDefaultProtocolClient\('alexfoxtm-twindesk'\)/);
  assert.match(files['mac/mesh/main.js'], /setAsDefaultProtocolClient\('alexfoxtm-twindesk'\)/);
  assert.match(files['mac/login.js'], /LABEL = 'io\.github\.alexfoxtm\.twindesk'/);
  assert.match(files['mac/vcam.js'], /io\.github\.alexfoxtm\.twindesk\.camera\.systemextension/);
  assert.match(files['mac-helper/Sources/macshare-helper/Info.plist'], /io\.github\.alexfoxtm\.twindesk\.native-helper/);
  assert.match(files['mac-helper/Sources/macshare-calls/Info.plist'], /io\.github\.alexfoxtm\.twindesk\.calls/);
  assert.match(files['mac-helper/Sources/twindesk-vcam/main.swift'], /extensionID = "io\.github\.alexfoxtm\.twindesk\.camera"/);
  assert.match(files['mac-helper/Sources/macshare-share/ShareViewController.swift'], /c\.scheme = "alexfoxtm-twindesk"/);
  assert.match(files['mac-helper/Sources/macshare-dockstub/main.swift'], /alexfoxtm-twindesk:\/\/pc-app\//);
  assert.match(files['mac/dockstub.js'], /io\.github\.alexfoxtm\.twindesk\.pcapp\./);
  assert.match(files['mac/phone-bridge.js'], /APP_ID = 'io\.github\.alexfoxtm\.twindesk\.android'/);
  assert.match(files['mac/phone-bridge.js'], /\$\{APP_ID\}\/\$\{APP_CLASS\}\.MainActivity/);
  assert.match(files['mac/wired.js'], /\$\{APP_ID\}\/\$\{APP_CLASS\}\.WiredReceiver/);
  assert.match(files['android/app/build.gradle.kts'], /applicationId = "io\.github\.alexfoxtm\.twindesk\.android"/);
  assert.match(files['android/app/build.gradle.kts'], /namespace = "com\.twindesk\.android"/);
  assert.match(files['android/app/src/main/res/xml/shortcuts.xml'], /targetPackage="io\.github\.alexfoxtm\.twindesk\.android"/);
  assert.match(files['android/app/src/main/res/xml/shortcuts.xml'], /targetClass="com\.twindesk\.android\.AdbActivity"/);
  for (const [name, source] of Object.entries(files)) {
    assert.equal(claimsUpstream(source), false, `${name} still claims an upstream identity`);
  }
}

function failure() {
  const appex = '<key>CFBundleIdentifier</key><string>org.macshare.mac.share</string>';
  const scheme = "app.setAsDefaultProtocolClient('macshare');";
  assert.equal(claimsUpstream(appex), true);
  assert.equal(claimsUpstream(scheme), true);
  assert.equal(claimsUpstream('<string>io.github.alexfoxtm.twindesk.share</string>'), false);
  assert.throws(() => {
    if (claimsUpstream(appex)) throw new Error('upstream share extension id');
  }, /upstream share extension id/);
}

main();
failure();
console.log('fork-identity: ok');
