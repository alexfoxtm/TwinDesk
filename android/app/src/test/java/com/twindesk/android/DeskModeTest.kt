package com.twindesk.android

import android.app.Activity
import android.view.WindowManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class DeskModeTest {
    private fun awake(activity: Activity) =
        activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0

    @Test fun optInKeepsScreenOnOnlyWhilePluggedAndResumed() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val screen = DeskScreenAwake(activity.window)
        screen.update(enabled = false, plugged = true, resumed = true)
        assertFalse(awake(activity))
        screen.update(enabled = true, plugged = true, resumed = true)
        assertTrue(awake(activity))
        screen.update(enabled = true, plugged = false, resumed = true)
        assertFalse(awake(activity))
        screen.update(enabled = true, plugged = true, resumed = true)
        screen.update(enabled = true, plugged = true, resumed = false)
        assertFalse(awake(activity))
    }

    @Test fun leavingDeskModePreservesAnExistingWindowAwakePolicy() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val screen = DeskScreenAwake(activity.window)
        screen.update(enabled = false, plugged = false, resumed = false)
        assertTrue(awake(activity))
    }
}
