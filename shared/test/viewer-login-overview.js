// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac viewer still has its old controls, and the new sheet does not pretend to show the desktop.
// Run with: node shared/test/desktop-overview.js
'use strict';


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const web = read('android/app/src/main/java/com/twindesk/android/Web.kt');
assert.match(read('android/app/src/main/java/com/twindesk/android/ViewerLoginSurface.kt'), /if \(showLogin\) \{[\s\S]*?^        \} else \{[\s\S]*?ViewerChrome\(/m);
const locked = web.slice(web.indexOf('fun lockChanged'), web.indexOf('fun setOpt', web.indexOf('fun lockChanged')));
assert.ok(locked.includes('endPreviewSession()'));
