// Adapted from AppShare (Copyright 2026 Rahim Nathwani). SPDX-License-Identifier: Apache-2.0.
package com.twindesk.android.embedded;

/**
 * Synchronous JNI entry. Call {@link #load()} once on a background thread before {@link #call}.
 * There is no static initializer, so a missing library does not crash class load.
 */
public final class NativeNode {
    private static boolean loaded;

    private NativeNode() {}

    public static synchronized void load() {
        if (loaded) return;
        System.loadLibrary("twindesk_network");
        loaded = true;
    }

    public static native String call(String request);
}
