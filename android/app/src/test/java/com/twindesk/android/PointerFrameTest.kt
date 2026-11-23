package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Test

class PointerFrameTest {
    @Test fun onePostedRunAppliesOnlyTheLatestPosition() {
        val applied = mutableListOf<Pair<Int, Int>>()
        val frames = PointerFrames { x, y -> applied += x to y }
        var posts = 0
        frames.move(1, 2) { posts++ }
        frames.move(3, 4) { posts++ }
        frames.move(8, 9) { posts++ }
        assertEquals(0, applied.size)
        assertEquals(1, posts)
        frames.flush()
        assertEquals(listOf(8 to 9), applied)
        frames.flush()
        assertEquals(listOf(8 to 9), applied)
        frames.move(10, 11) { posts++ }
        frames.move(12, 13) { posts++ }
        assertEquals(2, posts)
        frames.flush()
        assertEquals(listOf(8 to 9, 12 to 13), applied)
    }

    @Test fun hideDropsAWaitingMoveAndTheNextOneStillLands() {
        val applied = mutableListOf<Pair<Int, Int>>()
        val frames = PointerFrames { x, y -> applied += x to y }
        frames.move(1, 2) {}
        frames.hide()
        frames.flush()
        assertEquals(emptyList<Pair<Int, Int>>(), applied)
        frames.move(5, 6) {}
        frames.flush()
        assertEquals(listOf(5 to 6), applied)
    }

    @Test fun hideCancelsThePostedRunnable() {
        val frames = PointerFrames { _, _ -> }
        var posts = 0
        var cancels = 0
        frames.move(1, 2) { posts++ }
        frames.hide { cancels++ }
        assertEquals(1, posts)
        assertEquals(1, cancels)
        frames.hide { cancels++ }
        assertEquals(1, cancels)
        frames.flush()
        frames.move(3, 4) { posts++ }
        assertEquals(2, posts)
    }
}
