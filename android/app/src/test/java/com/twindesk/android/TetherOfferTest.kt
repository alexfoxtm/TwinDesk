// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TetherOfferTest {
    @Test
    fun acceptsAnActionForTheOriginalOfferOnItsCurrentSocket() {
        val route = Link.TrustedRoute(Any(), "mac", "fingerprint")
        val offer = Tether.Offer(47183, "test-token", route)

        assertTrue(offer.accepts(offer.id) { it.marker === route.marker })
    }

    @Test
    fun rejectsActionsThatOutliveTheOfferOrItsSocket() {
        val route = Link.TrustedRoute(Any(), "mac", "fingerprint")
        val reconnected = Link.TrustedRoute(Any(), route.id, route.fp)
        val old = Tether.Offer(47183, "test-token", route)
        val replaced = Tether.Offer(47183, "test-token", route)

        // Even a replacement on the same socket cannot reuse the old notification or prompt.
        assertFalse(replaced.accepts(old.id) { it.marker === route.marker })
        // Reconnecting with the same certificate does not authorize an action on the old socket.
        assertFalse(old.accepts(old.id) { it.marker === reconnected.marker })
    }
}
