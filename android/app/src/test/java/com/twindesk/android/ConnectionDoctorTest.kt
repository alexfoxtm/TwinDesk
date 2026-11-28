// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionDoctorTest {
    @Test
    fun reconnectKeepsTheSamePairsBoundedObservation() {
        val observations = ConnectionObservations()
        observations.closed("mac", "certificate", "replaced", false, 1234)
        observations.select("mac", "certificate")
        val event = observations.forPair("mac", "certificate")
        assertEquals(ConnectionCloseReason.REPLACED, event?.reason)
        assertEquals(1234L, event?.at)
        assertEquals(ConnectionCloseReason.INTERRUPTED, ConnectionCloseReason.from("private error text", false))
        assertEquals(ConnectionCloseReason.IDENTITY, ConnectionCloseReason.from(null, true))
        assertEquals("Ready", doctorFeaturePermission(true, true, "ok"))
        assertEquals("Limited", doctorFeaturePermission(true, true, "partial"))
        assertEquals("Settings on the computer", doctorFeaturePermission(true, false, "ok"))
        assertEquals("Allow Messages access in Android settings", doctorFeaturePermission(true, true, "ask"))
    }

    @Test
    fun anotherPairOrCertificateCannotInheritTheEvent() {
        val observations = ConnectionObservations()
        observations.closed("mac", "certificate", "local", false, 1234)
        assertNull(observations.forPair("other", "certificate"))
        assertEquals("Not connected", doctorFeaturePermission(false, true, "ok"))
        assertEquals("Unknown", doctorFeaturePermission(true, null, "ok"))
        assertEquals("Not supported", doctorFeaturePermission(true, true, "none"))
        assertNull(observations.forPair("mac", "replacement"))
        observations.select("other", "certificate")
        assertNull(observations.forPair("mac", "certificate"))
        observations.closed("other", "certificate", null, false, 1235)
        observations.select("other", "replacement")
        assertNull(observations.forPair("other", "certificate"))
    }
}
