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

    @Test fun returningFromSettingsAndReceivingPermissionResultsInvalidateSetup() {
        val before = SetupPermissionInputs(0, 0, false, false, 0, "en")
        assertNotEquals(before, before.copy(resumes = 1))
        assertNotEquals(before, before.copy(results = 1))
        assertNotEquals(before, before.copy(listenerConnected = true))
        assertNotEquals(before, before.copy(accessibilityConnected = true))
        assertNotEquals(before, before.copy(debuggingChanges = 1))
    }
}
