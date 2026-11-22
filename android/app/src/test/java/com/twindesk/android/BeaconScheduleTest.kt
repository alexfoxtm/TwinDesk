package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BeaconScheduleTest {
    @Test fun connectedPhoneKeepsAdvertisingWithinDiscoveryExpiry() {
        assertEquals(3000L, beaconDelay(true, true, false))
        assertEquals(2000L, beaconDelay(true, false, false))
        assertEquals(2000L, beaconDelay(true, true, true))
        assertEquals(5000L, beaconDelay(false, true, false))
    }
}
