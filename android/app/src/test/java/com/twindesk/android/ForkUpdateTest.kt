package com.twindesk.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ForkUpdateTest {
    private fun offer() = JSONObject().put("available", true).put("id", "a".repeat(32))
        .put("package", "io.github.alexfoxtm.twindesk.android").put("version", "3.2.1")
        .put("build", 78).put("versionCode", 100078).put("size", 44_000_000)
        .put("sha256", "b".repeat(64)).put("chunk", 512 * 1024)

    @Test fun higherBuildAtSameUpstreamVersionIsAccepted() {
        val candidate = ForkUpdate.parseOffer(offer(), "io.github.alexfoxtm.twindesk.android", 100077)
        assertEquals(78, candidate.build)
        assertEquals("3.2.1", candidate.version)
        assertEquals(100078L, candidate.code)
    }

    @Test fun staleWrongPackageAndMalformedOffersFailClosed() {
        val changes = listOf("package" to "another.app", "versionCode" to 100077, "version" to "3.1.0",
            "build" to 79, "size" to (257L * 1024 * 1024), "size" to 0,
            "sha256" to "invalid", "id" to "invalid", "chunk" to (512 * 1024 + 1),
            "size" to 2.5, "available" to false)
        for ((key, value) in changes) {
            try {
                ForkUpdate.parseOffer(offer().put(key, value), "io.github.alexfoxtm.twindesk.android", 100077)
                fail("accepted invalid $key")
            } catch (_: IllegalArgumentException) { }
        }
    }
}
