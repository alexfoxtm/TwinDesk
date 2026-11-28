// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class VideoHandoffTest {
    @Test fun canonicalSupportedVideoLinksCarryOnlyTheirTimestamp() {
        listOf(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s",
            "https://vimeo.com/123#t=24s",
            "https://www.twitch.tv/videos/123?t=3723s",
            "https://www.dailymotion.com/video/x123?start=10",
        ).forEach { assertNotNull(it, supportedVideoLink(it)) }
    }

    @Test fun substitutedDestinationsAndExtraOrDuplicateFieldsAreRefused() {
        listOf(
            "javascript:alert(1)",
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s",
            "https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ&t=1s",
            "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s&t=2s",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s&redirect=https://example.com",
            "https://vimeo.com/123#t=604801s",
            "https://example.com/video.mp4",
        ).forEach { assertNull(it, supportedVideoLink(it)) }
    }
}
