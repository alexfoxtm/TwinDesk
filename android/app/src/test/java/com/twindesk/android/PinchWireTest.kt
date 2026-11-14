// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// phone.in pinch dialects. The node contract is shared/test/pinch-compat.js.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PinchWireTest {
    @Test
    fun capabilityNamesDoNotShareADialect() {
        assertEquals(listOf("input.pinch", "input.pinch.stroke"), PinchWire.caps(true))
        assertEquals(emptyList<String>(), PinchWire.caps(false))
        // The fork name alone is legacy. It is not the pixel stroke.
        assertEquals(PinchWire.Dialect.LEGACY, PinchWire.dialect(listOf("mirror.native", "input.pinch")))
        // The additive name wins when both are advertised (this app).
        assertEquals(PinchWire.Dialect.STROKE, PinchWire.dialect(listOf("input.pinch", "input.pinch.stroke")))
        assertEquals(PinchWire.Dialect.STROKE, PinchWire.dialect(listOf("input.pinch.stroke")))
        // Upstream advertises no pinch capability and still speaks the pixel stroke.
        assertEquals(PinchWire.Dialect.STROKE, PinchWire.dialect(listOf("mirror.native")))
        assertEquals(PinchWire.Dialect.STROKE, PinchWire.dialect(emptyList()))
        assertEquals(PinchWire.Dialect.STROKE, PinchWire.dialect(null))
    }

    @Test
    fun mixedOrPartialMessagesAreNotAPinch() {
        assertEquals(PinchWire.Kind.STROKE, PinchWire.kind(hasFrom = true, hasTo = true, hasVert = true, hasV = false))
        assertEquals(PinchWire.Kind.STROKE, PinchWire.kind(true, true, false, false))
        assertEquals(PinchWire.Kind.LEGACY, PinchWire.kind(false, false, false, true))
        // Both families: do not pick a magnitude and hope.
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(true, true, true, true))
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(true, true, false, true))
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(true, false, false, false))
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(false, true, false, false))
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(false, false, true, false))
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(false, false, true, true))
        assertEquals(PinchWire.Kind.REJECT, PinchWire.kind(false, false, false, false))
    }

    @Test
    fun legacyGeometryMatchesTheForkPhone() {
        // 1080×2400, 420 dpi, density 2.625: the center, spreading by 0.3.
        val spread = legacyFingers(0.5, 0.5, 0.3, 1080f, 2400f, 2.625f, 420)
        requireNotNull(spread)
        assertEquals(false, spread.horizontal)
        assertEquals(252f, spread.start, 0.01f)
        assertEquals(540f, spread.x, 0.01f)
        assertEquals(1200f, spread.y, 0.01f)
        assertTrue(spread.end > spread.start)
        assertTrue(spread.end < 672f)
        val close = legacyFingers(0.5, 0.5, -0.3, 1080f, 2400f, 2.625f, 420)
        requireNotNull(close)
        assertEquals(672f, close.start, 0.01f)
        assertTrue(close.end < close.start)
    }

    @Test
    fun legacyGeometryRefusesAPinchThatCannotBePlaced() {
        assertNull(legacyFingers(0.5, 0.5, 0.0, 1080f, 2400f, 2.625f, 420))
        assertNull(legacyFingers(Double.NaN, 0.5, 0.3, 1080f, 2400f, 2.625f, 420))
        assertNull(legacyFingers(0.5, Double.NaN, 0.3, 1080f, 2400f, 2.625f, 420))
        assertNull(legacyFingers(0.5, 0.5, Double.NaN, 1080f, 2400f, 2.625f, 420))
        assertNull(legacyFingers(0.5, 0.5, 0.3, 0f, 2400f, 2.625f, 420))
        assertNull(legacyFingers(0.5, 0.5, 0.3, 20f, 20f, 2.625f, 420))
    }
}
