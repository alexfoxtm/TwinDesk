package com.twindesk.android

import android.content.Context
import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.Composition
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ResponsivenessCallSitesTest {
    private fun Any.field(name: String) = javaClass.getDeclaredField(name).apply { isAccessible = true }

    @Test fun beaconLoopWaitsForTheSelectedCadence() {
        val discovery = Discovery(RuntimeEnvironment.getApplication(), { JSONObject() }, {}, {})
        val running = discovery.field("running")
        val screenOn = discovery.field("screenOn")
        data class Cadence(val screen: Boolean, val connected: Boolean, val peer: Boolean, val delay: Long)
        for ((screen, connection, peer, expected) in listOf(
            Cadence(true, true, false, 3000L),
            Cadence(false, true, false, 5000L),
            Cadence(true, true, true, Proto.BEACON_MS),
            Cadence(true, false, false, Proto.BEACON_MS),
        )) {
            running.setBoolean(discovery, true)
            screenOn.setBoolean(discovery, screen)
            discovery.sessionChanged(connection)
            discovery.peerOn = peer
            var cycles = 0
            discovery.onBeaconCycle = { assertTrue("Loop must wait after one cycle", ++cycles == 1) }
            var waited = 0L
            discovery.runBeaconLoop { delay ->
                waited = delay
                running.setBoolean(discovery, false)
            }
            assertEquals(expected, waited)
        }
    }

    @Test fun focusGainIncrementsTheSetupInput() {
        val context = RuntimeEnvironment.getApplication()
        val instance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        val previous = instance.get(null)
        val core = Core::class.java.getDeclaredConstructor(Context::class.java)
            .apply { isAccessible = true }.newInstance(context)
        instance.set(null, core)
        try {
            val activity = Robolectric.buildActivity(MainActivity::class.java).get()
            val focus = activity.field("focusGains").get(activity) as State<*>
            activity.onWindowFocusChanged(false)
            assertEquals(0, focus.value)
            activity.onWindowFocusChanged(true)
            assertEquals(1, focus.value)
            activity.onWindowFocusChanged(false)
            assertEquals(1, focus.value)
        } finally {
            instance.set(null, previous)
            core.timers.shutdownNow()
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun setupTickerFeedsTheVisibleSetupRefresh() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = object : MonotonicFrameClock {
            override suspend fun <R> withFrameNanos(onFrame: (Long) -> R): R =
                onFrame(testScheduler.currentTime * 1_000_000)
        }
        val owner = object : LifecycleOwner {
            override val lifecycle = LifecycleRegistry(this)
        }
        val recomposer = Recomposer(coroutineContext + clock)
        val composition = Composition(object : AbstractApplier<Unit>(Unit) {
            override fun insertTopDown(index: Int, instance: Unit) = Unit
            override fun insertBottomUp(index: Int, instance: Unit) = Unit
            override fun move(from: Int, to: Int, count: Int) = Unit
            override fun remove(index: Int, count: Int) = Unit
            override fun onClear() = Unit
        }, recomposer)
        val runner = launch(clock) { recomposer.runRecomposeAndApplyChanges() }
        try {
            owner.lifecycle.currentState = Lifecycle.State.RESUMED
            val focus = mutableStateOf(0)
            val show = mutableStateOf(true)
            var permission = "missing"
            var visibleRow = ""
            var reads = 0
            composition.setContent {
                CompositionLocalProvider(
                    LocalLifecycleOwner provides owner,
                    LocalContext provides RuntimeEnvironment.getApplication(),
                ) {
                    SetupGate(focus, { visible, tick, gains -> Triple(visible, tick, gains) },
                        { reads++; permission }, { show.value }) { row ->
                        SideEffect { visibleRow = row }
                    }
                }
            }
            runCurrent()
            assertEquals("missing", visibleRow)
            permission = "allowed"
            advanceTimeBy(1501)
            Snapshot.sendApplyNotifications()
            runCurrent()
            assertEquals("allowed", visibleRow)

            permission = "missing again"
            focus.value++
            Snapshot.sendApplyNotifications()
            runCurrent()
            assertEquals("missing again", visibleRow)

            owner.lifecycle.currentState = Lifecycle.State.CREATED
            val pausedReads = reads
            advanceTimeBy(4500)
            Snapshot.sendApplyNotifications()
            runCurrent()
            assertEquals(pausedReads, reads)
            show.value = false
            Snapshot.sendApplyNotifications()
            runCurrent()
            val hiddenReads = reads
            owner.lifecycle.currentState = Lifecycle.State.RESUMED
            advanceTimeBy(4500)
            Snapshot.sendApplyNotifications()
            runCurrent()
            assertEquals(hiddenReads, reads)
        } finally {
            composition.dispose()
            recomposer.cancel()
            runner.cancel()
            Dispatchers.resetMain()
        }
    }
}
