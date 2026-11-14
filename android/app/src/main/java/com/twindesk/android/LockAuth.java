// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android;

import java.nio.charset.StandardCharsets;

// Chooses whether an already enrolled Screen Sharing secret may be used.
// It never creates a secret and never returns one.
public final class LockAuth {
    private LockAuth() {}

    public static String decide(boolean deviceSecure, boolean enrolled, String username, String password) {
        if (!deviceSecure || !enrolled || username == null || password == null) return "prompt";
        if (username.isEmpty() || password.isEmpty()) return "prompt";
        if (utf8(username) > 63 || utf8(password) > 63) return "prompt";
        return "submit";
    }

    private static int utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }
}
