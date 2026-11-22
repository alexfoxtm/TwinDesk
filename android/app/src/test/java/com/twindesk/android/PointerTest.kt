package com.twindesk.android

import android.view.WindowManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PointerTest {
    @Test fun firstAddUsesRequestedPositionAndRepeatSkipsLayout() {
        val params = WindowManager.LayoutParams()
        val applied = mutableListOf<Pair<Int, Int>>()
        placePointer(params, 10, 20, initial = true) { applied += params.x to params.y }
        placePointer(params, 10, 20, initial = false) { applied += params.x to params.y }
        placePointer(params, 30, 40, initial = false) { applied += params.x to params.y }
        assertEquals(listOf(11 to 21, 31 to 41), applied)
    }

    @Test fun failedMoveRestoresPositionSoTheNextEventCanRetry() {
        val params = WindowManager.LayoutParams()
        placePointer(params, 10, 20, initial = true) {}
        assertFalse(placePointer(params, 30, 40, initial = false) { error("layout failed") })
        assertEquals(11 to 21, params.x to params.y)
        placePointer(params, 30, 40, initial = false) { assertEquals(31 to 41, params.x to params.y) }
    }
}
