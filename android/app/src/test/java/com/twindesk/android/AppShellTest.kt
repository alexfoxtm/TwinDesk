package com.twindesk.android

import androidx.compose.runtime.mutableStateOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Test

class AppShellTest {
    @Test fun aCoreChangeRechecksShellWithoutChangingItsValueForAnUnrelatedUpdate() {
        val revision = mutableStateOf(0)
        val initial = AppShell(false, false, emptyList(), false, false, "", false, null, null, null, false, false)
        var source = initial
        val shell = appShellState(revision) { source.copy() }
        val before = shell.value
        assertEquals(initial, before)
        revision.value++
        assertSame(before, shell.value)
        source = source.copy(connected = true)
        revision.value++
        assertEquals(source, shell.value)
    }

    @Test fun setupInputsTrackPermissionRefreshSources() {
        val revision = mutableStateOf(0)
        fun inputs(
            resumes: Int = 0, results: Int = 0, listener: Boolean = false,
            accessibility: Boolean = false, debugging: Int = 0, language: String = "en",
            focus: Int = 0, tick: Int = 0, visible: Boolean = true,
        ) = setupPermissionInputs(
            resumes, results, listener, accessibility, debugging, language, focus, tick, revision, visible,
        )
        val before = inputs()
        assertNotEquals("resume", before, inputs(resumes = 1))
        assertNotEquals("permission result", before, inputs(results = 1))
        assertNotEquals(before, inputs(listener = true))
        assertNotEquals(before, inputs(accessibility = true))
        assertNotEquals(before, inputs(debugging = 1))
        assertNotEquals(before, inputs(language = "fr"))
        assertNotEquals(before, inputs(focus = 1))
        assertNotEquals(before, inputs(tick = 1))
        val hidden = inputs(visible = false)
        revision.value++
        assertNotEquals(before, inputs())
        assertEquals(hidden, inputs(visible = false))
    }
}
