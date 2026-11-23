package com.twindesk.android

import android.content.ComponentCallbacks2
import android.graphics.Bitmap
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class SessionIconTrimTest {
    @After fun reset() {
        NotifIcons.clear()
        RebuildableCaches.clearForTest()
    }

    @Test fun computerNotificationIconsStayThroughABackgroundTrim() {
        val icon = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
        NotifIcons.remember("com.example.browser", icon)
        val deck = BoundedIconCache<String>()
        deck["icon"] = "bytes"
        var rezumeDrops = 0
        val unregister = registerPhoneRebuildableCaches(
            deck = { deck.clear() },
            appList = lazy { Unit },
            appListDrop = { error("app list was not open") },
            rezume = { rezumeDrops++ },
        )
        RebuildableCaches.trim(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)
        assertSame(icon, NotifIcons.get("com.example.browser"))
        assertNull(deck["icon"])
        assertEquals(1, rezumeDrops)
        unregister()
    }
}
