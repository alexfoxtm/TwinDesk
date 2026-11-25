package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test fun deniedPeerSoundStopsBeforeProjection() = withPeer { core ->
        for (suppressed in listOf(false, true)) {
            PeerScreen.standaloneSoundActive = true
            RuntimeGrant.record(core.store, mic, granted = !suppressed)
            val before = core.version.value
            val activity = Robolectric.buildActivity(PeerGrantActivity::class.java).create().get()
            if (!suppressed) {
                assertEquals(2, shadowOf(activity).nextStartedActivityForResult?.requestCode)
                activity.onRequestPermissionsResult(2, arrayOf(mic), intArrayOf(PackageManager.PERMISSION_DENIED))
            }
            assertNull("denied audio must not start the projection prompt", shadowOf(activity).nextStartedActivityForResult)
            assertFalse(PeerScreen.standaloneSoundActive)
            assertTrue(activity.isFinishing)
            assertTrue(core.version.value > before)
            assertTrue(PeerScreen.soundError.isNotEmpty())
        }
    }

    @Test fun screenRequestedDuringMicPromptSurvivesDenial() = withPeer { core ->
        val result = PeerGrantActivity::class.java.getDeclaredMethod(
            "onActivityResult", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Intent::class.java,
        ).apply { isAccessible = true }
        for (videoContinues in listOf(true, false)) {
            PeerScreen.screenActive = false
            PeerScreen.remoteWantsAudio = false
            PeerScreen.standaloneSoundActive = true
            RuntimeGrant.record(core.store, mic, granted = true)
            val activity = Robolectric.buildActivity(PeerGrantActivity::class.java).create().get()
            assertEquals(2, shadowOf(activity).nextStartedActivityForResult?.requestCode)
            PeerScreen.screenActive = true
            PeerScreen.remoteWantsAudio = true
            activity.onRequestPermissionsResult(2, arrayOf(mic), intArrayOf(PackageManager.PERMISSION_DENIED))
            assertEquals("video still needs its own projection consent", 1, shadowOf(activity).nextStartedActivityForResult?.requestCode)
            assertTrue(PeerScreen.screenActive)
            assertFalse(PeerScreen.standaloneSoundActive)
            assertTrue(core.store.flag("permission.denied.$mic", false))

            // If video was cancelled meanwhile, the OS result cannot start a service.
            PeerScreen.screenActive = videoContinues
            result.invoke(activity, 1, Activity.RESULT_OK, Intent())
            val service = shadowOf(activity).nextStartedService
            if (videoContinues) assertEquals(PeerCaptureService::class.java.name, service?.component?.className)
            else assertNull("a late projection result must not start a service", service)
        }
    }

    private fun withPeer(test: (Core) -> Unit) {
        val context = RuntimeEnvironment.getApplication()
        val core = Core::class.java.getDeclaredConstructor(Context::class.java)
            .apply { isAccessible = true }.newInstance(context)
        val instance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        val previous = instance.get(null)
        instance.set(null, core)
        // A connected peer with no socket or network listeners.
        Peer::class.java.getDeclaredField("role").apply { isAccessible = true }.set(core.peer, "host")
        try {
            test(core)
        } finally {
            PeerScreen.standaloneSoundActive = false
            PeerScreen.screenActive = false
            PeerScreen.remoteWantsAudio = false
            PeerScreen.soundError = ""
            instance.set(null, previous)
            core.timers.shutdownNow()
            core.bg.shutdownNow()
        }
    }
}
