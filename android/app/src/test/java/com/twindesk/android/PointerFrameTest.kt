package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Test

class PointerFrameTest {
    @Test fun oneFrameAppliesOnlyTheLatestPosition() {
        val applied = mutableListOf<Pair<Int, Int>>()
        val frames = PointerFrames { x, y -> applied += x to y }
        var posts = 0
        frames.move(1, 2) { posts++ }
        frames.move(3, 4) { posts++ }
        frames.move(8, 9) { posts++ }
        assertEquals(0, applied.size)
        assertEquals(1, posts)
        frames.onFrame()
        assertEquals(listOf(8 to 9), applied)
        frames.onFrame()
        assertEquals(listOf(8 to 9), applied)
    }

    @Test fun hideDropsAWaitingMoveAndTheNextOneStillLands() {
        val applied = mutableListOf<Pair<Int, Int>>()
        val frames = PointerFrames { x, y -> applied += x to y }
        frames.move(1, 2) {}
        frames.hide()
        frames.onFrame()
        assertEquals(emptyList<Pair<Int, Int>>(), applied)
        frames.move(5, 6) {}
        frames.onFrame()
        assertEquals(listOf(5 to 6), applied)
    }
}