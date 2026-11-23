package com.twindesk.android

import android.content.ComponentCallbacks2
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryTrimTest {
    @After fun reset() = RebuildableCaches.clearForTest()

    @Test fun deckIconCacheDropsTheLeastRecentPastTheCap() {
        assertEquals(48, DECK_ICON_CACHE_MAX)
        val cache = BoundedIconCache<String>()
        repeat(DECK_ICON_CACHE_MAX) { cache["k$it"] = "v$it" }
        cache["k1"]
        cache["k${DECK_ICON_CACHE_MAX}"] = "newest"
        assertEquals(DECK_ICON_CACHE_MAX, cache.size)
        assertNull(cache["k0"])
        assertEquals("v1", cache["k1"])
        assertEquals("newest", cache["k${DECK_ICON_CACHE_MAX}"])
    }

    @Test fun trimDropsRebuildableCachesOnceTheAppIsBackgrounded() {
        assertFalse(shouldReleaseCaches(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE - 1))
        assertTrue(shouldReleaseCaches(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
        assertTrue(shouldReleaseCaches(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
        assertTrue(shouldReleaseCaches(ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
        val cache = BoundedIconCache<String>()
        cache["icon"] = "bytes"
        var drops = 0
        val unregister = RebuildableCaches.register {
            drops++
            cache.clear()
        }
        RebuildableCaches.trim(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE - 1)
        assertEquals(0, drops)
        assertEquals("bytes", cache["icon"])
        RebuildableCaches.trim(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)
        assertEquals(1, drops)
        assertNull(cache["icon"])
        unregister()
        RebuildableCaches.trim(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
        assertEquals(1, drops)
    }
}
