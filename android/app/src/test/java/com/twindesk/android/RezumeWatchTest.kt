package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RezumeWatchTest {
    @Test fun treeIsReadOnAnAppSwitchAStaleAddressOrTheSafetyPass() {
        assertEquals(200L, REZUME_DEBOUNCE_MS)
        assertTrue(REZUME_SAFETY_MS in 10_000L..15_000L)
        assertTrue(rezumeShouldReadTree(packageChanged = true, addressFresh = true))
        assertTrue(rezumeShouldReadTree(packageChanged = false, addressFresh = false))
        assertTrue(rezumeShouldReadTree(packageChanged = false, addressFresh = true, safety = true))
        assertFalse(rezumeShouldReadTree(packageChanged = false, addressFresh = true))
    }

    @Test fun armedInteractiveScreenCoalescesWindowEventsAndKeepsOneSafetyRead() {
        val posted = mutableListOf<Long>()
        val safety = mutableListOf<Long>()
        var cancelledDebounce = 0
        var cancelledSafety = 0
        val watch = RezumeWatch(
            postDebounce = { posted += it },
            cancelDebounce = { cancelledDebounce++ },
            startSafety = { safety += it },
            cancelSafety = { cancelledSafety++ },
        )
        watch.onWindow(packageChanged = true, addressFresh = false)
        assertTrue(posted.isEmpty())
        assertTrue(safety.isEmpty())

        watch.setArmed(true)
        assertEquals(listOf(REZUME_DEBOUNCE_MS), posted)
        assertEquals(listOf(REZUME_SAFETY_MS), safety)

        assertTrue(watch.onWindow(packageChanged = true, addressFresh = true))
        assertTrue(watch.onWindow(packageChanged = false, addressFresh = false))
        assertEquals(1, posted.size)
        assertFalse(watch.onWindow(packageChanged = false, addressFresh = true))

        assertTrue(watch.debounceFired())
        assertTrue(watch.onWindow(packageChanged = true, addressFresh = true))
        assertEquals(2, posted.size)
        assertEquals(1, safety.size)
        assertEquals(0, cancelledSafety)
    }

    @Test fun screenOffPeerGoneOrFeatureOffRunsNothing() {
        val posted = mutableListOf<Long>()
        val safety = mutableListOf<Long>()
        var cancelledDebounce = 0
        var cancelledSafety = 0
        val watch = RezumeWatch(
            postDebounce = { posted += it },
            cancelDebounce = { cancelledDebounce++ },
            startSafety = { safety += it },
            cancelSafety = { cancelledSafety++ },
        )
        watch.setInteractive(false)
        watch.setArmed(true)
        assertTrue(posted.isEmpty())
        assertTrue(safety.isEmpty())
        assertFalse(watch.onWindow(packageChanged = true, addressFresh = false))

        watch.setInteractive(true)
        assertEquals(listOf(REZUME_DEBOUNCE_MS), posted)
        assertEquals(listOf(REZUME_SAFETY_MS), safety)

        watch.setInteractive(false)
        assertEquals(1, cancelledDebounce)
        assertEquals(1, cancelledSafety)
        assertFalse(watch.debounceFired())
        assertFalse(watch.onWindow(packageChanged = true, addressFresh = false))

        watch.setInteractive(true)
        watch.setArmed(false)
        assertEquals(2, cancelledSafety)
        assertTrue(watch.onWindow(packageChanged = true, addressFresh = false).not())
        assertEquals(2, posted.size)
    }
}
