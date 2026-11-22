package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StaleDialTest {
    @Test fun cappedBackoffAppliesOnlyWhenAway() {
        assertEquals(listOf(5_000L, 10_000L, 20_000L, 60_000L, 60_000L), (0..4).map { staleDialDelay(true, it) })
        assertEquals(5_000L, staleDialDelay(false, 4))
        assertTrue(lowPowerAdvertisingNeeded(false, false, false, false))
        assertFalse(lowPowerAdvertisingNeeded(true, false, false, false))
        assertFalse(lowPowerAdvertisingNeeded(false, true, false, false))
        assertFalse(lowPowerAdvertisingNeeded(false, false, true, false))
        assertFalse(lowPowerAdvertisingNeeded(false, false, false, true))
    }
}
