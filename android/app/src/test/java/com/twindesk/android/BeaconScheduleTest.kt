package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BeaconScheduleTest {
    @Test fun connectedPhoneSlowsItsBeaconAndReturnsWhenTheLinkDrops() {
        assertEquals(45_000L, BEACON_CONNECTED_MS)
        assertTrue(BEACON_CONNECTED_MS in 30_000L..60_000L)
        assertEquals(BEACON_CONNECTED_MS, beaconDelay(true, true, false))
        assertEquals(BEACON_CONNECTED_MS, beaconDelay(false, true, false))
        assertEquals(2000L, beaconDelay(true, false, false))
        assertEquals(Proto.BEACON_MS, beaconDelay(true, true, true))
        assertEquals(5000L, beaconDelay(false, true, true))
        assertEquals(5000L, beaconDelay(false, false, false))
        assertFalse(lowPowerAdvertisingNeeded(false, false, false, false, connected = true))
        assertTrue(lowPowerAdvertisingNeeded(false, false, false, false, connected = false))
    }
}
