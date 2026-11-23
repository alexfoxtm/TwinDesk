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
}