package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class RuntimeGrantTest {
    private val mic = Manifest.permission.RECORD_AUDIO

    @Test fun firstRequestAndGrantFromSettingsReadTheCurrentPermission() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val app = RuntimeEnvironment.getApplication()
        val store = Store(activity)
        assertEquals(listOf(mic), RuntimeGrant.requestable(activity, store, listOf(mic)))

        RuntimeGrant.record(store, mic, false)
        shadowOf(app).grantPermissions(mic) // Settings changed the OS grant, independent of our stored denial.
        assertTrue(RuntimeGrant.granted(activity, mic))
        assertTrue(RuntimeGrant.requestable(activity, store, listOf(mic)).isEmpty())
    }

    @Test fun suppressedPromptOpensSettingsForThisApp() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val store = Store(activity)
        RuntimeGrant.record(store, mic, false)
        assertTrue(RuntimeGrant.requestable(activity, store, listOf(mic)).isEmpty())
        assertTrue(RuntimeGrant.requestable(deniedBefore = true, rationale = true))
        assertFalse(RuntimeGrant.granted(activity, mic))
        RuntimeGrant.openSettings(activity)
        val appDetails = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, appDetails.action)
        assertEquals("package:${activity.packageName}", appDetails.dataString)

        RuntimeGrant.openSettings(activity, notifications = true)
        val notifications = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, notifications.action)
        assertEquals(activity.packageName, notifications.getStringExtra(Settings.EXTRA_APP_PACKAGE))
    }
}
