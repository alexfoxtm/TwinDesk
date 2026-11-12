// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android;

import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

// The WebSocket reader waits here, never the UI thread. One chunk reaches the page at a time.
final class LockReadGate {
    private final Semaphore room = new Semaphore(1);
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final AtomicBoolean awaiting = new AtomicBoolean();

    boolean acquire() {
        if (cancelled.get()) return false;
        try {
            if (!room.tryAcquire(5, TimeUnit.SECONDS) || cancelled.get()) return false;
            awaiting.set(true);
            return !cancelled.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    void ack() {
        if (!cancelled.get() && awaiting.compareAndSet(true, false)) room.release();
    }

    void cancel() {
        if (cancelled.compareAndSet(false, true)) room.release();
    }
}
