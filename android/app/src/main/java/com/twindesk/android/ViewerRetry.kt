// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

// One budget per viewer/socket. A late callback cannot restart a retired operation.
internal class ViewerRetry(private val now: () -> Long) {
    private var generation = 0

    fun cancel() { generation++ }

    fun schedule(post: (Long, () -> Unit) -> Unit, eligible: () -> Boolean, reoffer: () -> Unit) {
        val current = ++generation
        val deadline = now() + 12_000L
        for (delay in listOf(4_500L, 9_000L)) {
            post(delay) {
                if (current == generation && now() < deadline && eligible()) reoffer()
            }
        }
    }
}
