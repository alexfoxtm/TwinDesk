// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Login hides the desktop overview and a locked Mac revokes preview access.
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
