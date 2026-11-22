package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IdleTimersTest {
    @Test fun onlyTimersWithWorkAreArmed() {
        assertFalse(peerTimerNeeded(false, false, false, false))
        assertTrue(peerTimerNeeded(false, false, true, false))
        assertFalse(netTimerNeeded(false, false))
        assertTrue(netTimerNeeded(false, true))
        assertFalse(returnTimerNeeded(false, true, false, false, false))
        assertTrue(returnTimerNeeded(false, false, false, false, false))
        assertFalse(bleTimerNeeded(false, true, true, false, false))
        assertFalse(bleTimerNeeded(true, true, true, true, false))
        assertTrue(bleTimerNeeded(true, true, true, true, true))
        assertTrue(bleTimerNeeded(false, true, true, true, true))
    }
}
