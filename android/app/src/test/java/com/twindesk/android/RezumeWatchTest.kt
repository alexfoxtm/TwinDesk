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

    @Test fun anAppSwitchSettlesAtStableMsWithoutWaitingForTheSafetyRead() {
        assertEquals(2_500L, Rezume.STABLE_MS)
        assertTrue(Rezume.STABLE_MS < REZUME_SAFETY_MS)
        val now = 50_000L
        assertEquals(RezumeOfferStep.WAIT, rezumeOfferStep("app com.android.chrome", "", now, now))
        assertEquals(RezumeOfferStep.WAIT, rezumeOfferStep("app com.android.chrome", "app com.android.chrome", now + Rezume.STABLE_MS - 1, now))
        assertEquals(RezumeOfferStep.SEND, rezumeOfferStep("app com.android.chrome", "app com.android.chrome", now + Rezume.STABLE_MS, now))
        assertEquals(Rezume.STABLE_MS, rezumeSettleDelay(now, now))
        assertEquals(Rezume.STABLE_MS - 1_000L, rezumeSettleDelay(now + 1_000L, now))
        assertEquals(Rezume.STABLE_MS, rezumeSettleDelay(now, now + 5_000L))

        val scheduled = mutableListOf<Pair<Long, Int>>()
        var cancels = 0
        val settle = RezumeSettle(
            schedule = { delay, generation -> scheduled += delay to generation },
            cancel = { cancels++ },
        )
        assertEquals(Rezume.STABLE_MS, settle.arm(now, now, live = true))
        assertEquals(listOf(Rezume.STABLE_MS to 1), scheduled)
        assertFalse(rezumeShouldReadTree(packageChanged = false, addressFresh = true))
        assertTrue(rezumeShouldReadTree(packageChanged = false, addressFresh = true, settling = true))
        assertTrue(settle.fired(1, live = true))

        assertEquals(Rezume.STABLE_MS - 400L, settle.arm(now + 400L, now, live = true))
        assertEquals(Rezume.STABLE_MS - 100L, settle.arm(now + 100L, now, live = true))
        assertEquals(1, cancels)
        assertFalse(settle.fired(2, live = true))
        assertTrue(settle.fired(3, live = true))
        assertEquals(-1L, settle.arm(now, now, live = false))
        assertFalse(settle.fired(4, live = true))
    }

    @Test fun aKeyboardOrAFocusedAddressBarIsNotAFreshTree() {
        assertFalse(rezumeTreeCacheable("com.google.android.inputmethod.latin", addressFocused = false))
        assertFalse(rezumeTreeCacheable("com.android.chrome", addressFocused = true))
        assertTrue(rezumeTreeCacheable("com.android.chrome", addressFocused = false))
        assertFalse(rezumeTreeFresh("com.google.android.inputmethod.latin", "com.google.android.inputmethod.latin", now = 5_000L, treeAt = 4_000L))
        assertFalse(rezumeTreeFresh("com.android.chrome", "com.android.chrome", now = 4_000L, treeAt = 5_000L))
        assertTrue(rezumeTreeFresh("com.android.chrome", "com.android.chrome", now = 5_000L, treeAt = 4_000L))
        assertFalse(rezumeTreeFresh("com.android.chrome", "com.android.chrome", now = 4_000L + REZUME_SAFETY_MS, treeAt = 4_000L))
    }
}
