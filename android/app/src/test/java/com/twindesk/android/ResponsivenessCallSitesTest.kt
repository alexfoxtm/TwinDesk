package com.twindesk.android

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponsivenessCallSitesTest {
    // These call sites depend on platform UI plumbing that the pure helper tests do not launch.
    private fun source(file: String) =
        File("src/main/java/com/twindesk/android/$file.kt").readText()

    @Test fun setupTickerFeedsTheVisibleSetupRefresh() {
        assertTrue(source("MainActivity").contains("if (showSetup) {\n            SetupRefreshEffect { tick++ }"))
    }

    @Test fun focusGainIncrementsTheSetupInput() {
        assertTrue(source("MainActivity").contains("if (hasFocus) focusGains.value++"))
    }

    @Test fun setupReadsTheFocusCount() {
        assertTrue(source("MainActivity").contains("I18n.lang, focusGains.value, tick, version"))
    }

    @Test fun beaconLoopWaitsForTheSelectedCadence() {
        assertTrue(source("Discovery").contains("beaconSignal.wait(beaconDelay(screenOn, connected, peerOn))"))
    }
}
