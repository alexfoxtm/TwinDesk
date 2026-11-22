package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34], manifest = org.robolectric.annotation.Config.NONE)
class DeviceStateTest {
    @Test fun currentSnapshotSendsOnlyChangesOrAsks() {
        val session = Any()
        assertTrue(shouldSendDeviceState(session, session, "old", "new", false))
        assertFalse(shouldSendDeviceState(session, session, "same", "same", false))
        assertTrue(shouldSendDeviceState(session, session, "same", "same", true))
    }

    @Test fun aCompletedBuildCannotSendToAReplacementSession() {
        assertFalse(shouldSendDeviceState(Any(), Any(), "old", "new", true))
    }
    @Test fun oneFollowUpRetainsAnAskAndSendsToTheCapturedSession() = with(Fixture()) {
        builds.request(false)
        builds.request(false)
        builds.request(true)
        builds.request(false)
        assertEquals(1, worker.size)
        finish()
        assertEquals(1, worker.size)
        val original = marker
        afterMarkerRead = { marker = Any() }
        finish()
        assertEquals(listOf(original to "1:false", original to "2:true"), sends)
        assertTrue(worker.isEmpty())
    }

    @Test fun closeDropsPendingAndReplacementRejectsTheOldBuild() = with(Fixture()) {
        builds.request(false)
        builds.request(true)
        builds.closed()
        marker = Any()
        finish()
        assertTrue(sends.isEmpty())
        assertTrue(worker.isEmpty())
        builds.request(false)
        finish()
        assertEquals(listOf(marker to "2:false"), sends)
    }

    @Test fun deadlineDiscardsLateResultAndWaitsForTheWorkerBeforeRetrying() = with(Fixture()) {
        builds.request(false)
        deadline.removeFirst().run()
        builds.request(true)
        assertEquals(1, timeouts)
        assertEquals(1, worker.size)
        finish()
        assertTrue(sends.isEmpty())
        finish()
        assertEquals(listOf(marker to "2:true"), sends)
    }

    @Test fun failedCaptureLeavesTheNextRequestFreeToBuild() = with(Fixture()) {
        failCapture = true
        builds.request(false)
        assertTrue(worker.isEmpty())
        assertTrue(deadline.isEmpty())
        failCapture = false
        builds.request(true)
        finish()
        assertEquals(listOf(marker to "1:true"), sends)
    }

    private class Fixture {
        var failCapture = false
        var marker = Any()
        var timeouts = 0
        var afterMarkerRead: (() -> Unit)? = null
        val worker = ArrayDeque<Runnable>()
        val main = ArrayDeque<Runnable>()
        val deadline = ArrayDeque<Runnable>()
        val sends = mutableListOf<Pair<Any, String>>()
        private var sequence = 0
        val builds = DeviceStateBuilds(
            executor = { worker.addLast(it) },
            post = { main.addLast(it) },
            scheduleDeadline = { deadline.addLast(it) },
            cancelDeadline = { deadline.remove(it) },
            current = {
                val owner = marker
                val onRead = afterMarkerRead
                afterMarkerRead = null
                onRead?.invoke()
                owner
            },
            capture = { ask ->
                check(!failCapture) { "capture unavailable" }
                val key = (++sequence).toString()
                val build = { key to "$key:$ask" }
                build
            },
            sendFor = { owner, message: String -> sends.add(owner to message) },
            onTimeout = { timeouts++ },
        )

        fun finish() {
            worker.removeFirst().run()
            main.removeFirst().run()
        }
    }
}
