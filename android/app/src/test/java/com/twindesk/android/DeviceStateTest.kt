package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
