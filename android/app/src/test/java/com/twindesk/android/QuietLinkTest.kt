package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuietLinkTest {
    @Test fun onlyMutuallyIdleNetworkLinksGoQuiet() {
        assertTrue(quietLink(true, true, false))
        assertFalse(quietLink(false, true, false))
        assertFalse(quietLink(true, false, false))
        assertFalse(quietLink(true, true, true))
        assertEquals(300_000L, quietBeatDelay(300_000, 660_000, 0))
        assertEquals(1_000L, quietBeatDelay(300_000, 1_000, 0))
    }
}
