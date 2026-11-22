package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MulticastOwnershipTest {
    @Test fun aScreenEventCannotReacquireDiscoveryLockAfterStop() {
        assertTrue(discoveryMulticastNeeded(true, true))
        assertFalse(discoveryMulticastNeeded(true, false))
        assertFalse(discoveryMulticastNeeded(false, true))
    }
}
