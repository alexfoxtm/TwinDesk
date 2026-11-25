package com.twindesk.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PhoneAppsRecoveryTest {
    @Test fun unchangedMetadataSkipsIconsAndUpdatesChangeTheDigest() {
        val config = listOf("en-US", "night", "icons")
        val first = listOf("fixture.a", "Launcher", "updated-at-1", "label-1", "icon-1")
        val other = listOf("fixture.b", "Launcher", "updated-at-1", "label-1", "icon-2")
        val version = phoneAppsVersion(config, listOf(first, other))
        assertEquals(version, phoneAppsVersion(config, listOf(other, first)))
        assertNotEquals(version, phoneAppsVersion(config, listOf(other)))
        assertNotEquals(version, phoneAppsVersion(config, listOf(first.dropLast(1) + "icon-3", other)))
        assertNotEquals(version, phoneAppsVersion(config, listOf(first.toMutableList().apply { set(2, "updated-at-2") }, other)))
        assertNotEquals(version, phoneAppsVersion(listOf("fr", "night", "icons"), listOf(first, other)))

        var builds = 0
        fun rows(): List<JSONObject> {
            builds++
            return listOf(JSONObject().put("id", "fixture.a"))
        }
        val unchanged = phoneAppsResponse(version, version, ::rows)
        assertEquals(version, unchanged.getString("version"))
        assertFalse(unchanged.has("apps"))
        assertEquals(0, builds)
        assertEquals(1, phoneAppsResponse(version, null, ::rows).getJSONArray("apps").length())
        assertEquals(1, phoneAppsResponse(version, "old-version", ::rows).getJSONArray("apps").length())
        assertEquals(2, builds)
    }

    @Test fun viewerRetriesAreBoundedAndCannotSurviveRevocationOrReplacement() {
        var now = 0L
        var active = true
        var reoffers = 0
        val tasks = mutableListOf<Pair<Long, () -> Unit>>()
        val retry = ViewerRetry { now }
        fun arm() = retry.schedule({ delay, task -> tasks.add(delay to task) }, { active }) { reoffers++ }
        arm()
        assertEquals(listOf(4_500L, 9_000L), tasks.map { it.first })
        now = 4_500L
        tasks[0].second()
        assertEquals(1, reoffers)
        active = false
        tasks[1].second()
        assertEquals(1, reoffers)
        active = true
        retry.cancel()
        tasks[1].second()
        assertEquals(1, reoffers)
        arm()
        now = 17_000L
        tasks.last().second()
        assertEquals(1, reoffers)
    }
}
