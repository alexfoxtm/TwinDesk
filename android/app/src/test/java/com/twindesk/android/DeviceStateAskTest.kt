package com.twindesk.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStateAskTest {
    @Test fun legacyPeerStaysLiveAndAnAskLastsUntilItExpires() {
        assertEquals(150_000L, DEV_ASKED_MS)
        assertTrue(deviceStateLive(peerAsks = false, askedUntil = 0L, now = 1_000L))
        assertFalse(deviceStateLive(peerAsks = true, askedUntil = 0L, now = 1_000L))
        assertTrue(deviceStateLive(peerAsks = true, askedUntil = 5_000L, now = 4_999L))
        assertFalse(deviceStateLive(peerAsks = true, askedUntil = 5_000L, now = 5_000L))
        val stamped = stampDeviceAsks(JSONObject().put("qs", JSONObject()))
        assertEquals(1, stamped.optInt("asks"))
    }

    @Test fun topAppsStayCachedForFiveMinutesUntilThePackageSetChanges() {
        assertEquals(5 * 60_000L, TOP_FRESH_MS)
        val cache = TopCache()
        val apps = setOf("a.b", "c.d")
        assertNull(cache.get(0L, apps))
        cache.put(1_000L, apps, listOf("a.b"))
        assertEquals(listOf("a.b"), cache.get(1_000L + TOP_FRESH_MS - 1, apps))
        assertNull(cache.get(1_000L + TOP_FRESH_MS, apps))
        cache.put(1_000L, apps, listOf("a.b"))
        assertNull(cache.get(1_000L, apps + "e.f"))
        cache.put(1_000L, apps, listOf("a.b"))
        cache.invalidate()
        assertNull(cache.get(1_000L, apps))
    }

    @Test fun aBackwardClockDoesNotKeepTopAppsFresh() {
        val cache = TopCache()
        val apps = setOf("a")
        cache.put(5_000L, apps, listOf("a"))
        assertNull(cache.get(4_000L, apps))
        assertEquals(listOf("a"), cache.get(5_000L, apps))
        assertEquals(0L, monotonicAskDelay(until = 100L, now = 150L))
        assertEquals(40L, monotonicAskDelay(until = 140L, now = 100L))
    }

    @Test fun aPackageChangeDuringTheUsageQueryIsNotCachedAndAMissingGrantDoesNotScanApps() {
        val tops = TopLookup()
        var launches = 0
        val during = tops.lookup(1_000L, query = {
            tops.invalidate()
            listOf("stale")
        }, launchable = { launches++; setOf("new") })
        assertEquals(listOf("stale"), during)
        assertEquals(0, launches)
        var queries = 0
        assertEquals(listOf("fresh"), tops.lookup(1_000L, query = { queries++; listOf("fresh") }, launchable = { setOf("a") }))
        assertEquals(1, queries)
        assertEquals(listOf("fresh"), tops.lookup(1_000L, query = { queries++; error("cached") }, launchable = { error("cached") }))
        assertEquals(1, queries)

        val denied = TopLookup()
        assertNull(denied.lookup(1_000L, query = { null }, launchable = { launches++; emptySet() }))
        assertEquals(0, launches)
        assertEquals(listOf("a"), denied.lookup(2_000L, query = { listOf("a") }, launchable = { setOf("a") }))
    }

    @Test fun disconnectDropsTheCachedTopApps() {
        val tops = TopLookup()
        assertEquals(listOf("a"), tops.lookup(1_000L, { listOf("a") }, { setOf("a") }))
        tops.invalidate()
        var queries = 0
        assertEquals(listOf("b"), tops.lookup(1_500L, { queries++; listOf("b") }, { setOf("a", "b") }))
        assertEquals(1, queries)
    }

    @Test fun stoppingTheRingPublishesWhenNobodyIsAskingAndTheTorchSticksOnlyAfterItApplies() {
        assertTrue(ringStopPublishesNow(live = false))
        assertFalse(ringStopPublishesNow(live = true))
        assertFalse(torchReported(previous = false, requested = true, applied = false))
        assertTrue(torchReported(previous = true, requested = false, applied = false))
        assertTrue(torchReported(previous = false, requested = true, applied = true))
        assertFalse(torchReported(previous = true, requested = false, applied = true))
    }
}