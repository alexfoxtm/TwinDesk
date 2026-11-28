// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class MacWidgetTest {
    private val app get() = RuntimeEnvironment.getApplication()
    private val launcher get() = shadowOf(app)
    private val manager get() = AppWidgetManager.getInstance(app)
    private val widgets get() = shadowOf(manager)
    private val store get() = Store(app)
    private val first = Host("first", "Studio Mac", "mac", "127.0.0.1", 1, "first-pin", "first-pair", 0L)
    private val second = Host("second", "Travel Mac", "mac", "127.0.0.1", 1, "second-pin", "second-pair", 0L)

    private fun widget() = widgets.createWidget(MacWidgetProvider::class.java, R.layout.mac_widget).also { id ->
        widgets.addBoundWidget(id, AppWidgetProviderInfo().apply {
            provider = ComponentName(app, MacWidgetProvider::class.java)
        })
        MacWidgetProvider().onUpdate(app, manager, intArrayOf(id))
    }

    private fun action(id: Int): Intent {
        val view = widgets.getViewFor(id)
        assertTrue(view.findViewById<Button>(R.id.widget_mac_action).performClick())
        return launcher.nextStartedActivity.also { assertNotNull(it) }
    }

    private fun assertLayout(id: Int) {
        val view = widgets.getViewFor(id)
        val density = app.resources.displayMetrics.density
        for (width in listOf(190, 310)) {
            view.measure(View.MeasureSpec.makeMeasureSpec((width * density).toInt(), View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec((132 * density).toInt(), View.MeasureSpec.EXACTLY))
            view.layout(0, 0, view.measuredWidth, view.measuredHeight)
            val button = view.findViewById<Button>(R.id.widget_mac_action)
            assertTrue(button.top >= view.findViewById<TextView>(R.id.widget_mac_status).bottom)
            assertTrue("Button bottom ${button.bottom}, widget height ${view.bottom}", button.bottom <= view.bottom)
        }
    }

    @Test
    fun widgetRendersBothIndependentConfigurationsAndDispatchesOnlyOnceForegrounded() {
        store.saveHosts(listOf(first, second))
        store.setPrefsString("language", "pt-BR")
        val a = widget()
        val b = widget()
        assertTrue(MacWidget.configure(app, a, store, first))
        assertTrue(MacWidget.configure(app, b, store, second))
        assertEquals("Studio Mac", widgets.getViewFor(a).findViewById<TextView>(R.id.widget_mac_name).text.toString())
        assertEquals("Não conectado", widgets.getViewFor(a).findViewById<TextView>(R.id.widget_mac_status).text.toString())
        assertEquals("Travel Mac", widgets.getViewFor(b).findViewById<TextView>(R.id.widget_mac_name).text.toString())
        assertEquals("Conectar", widgets.getViewFor(b).findViewById<Button>(R.id.widget_mac_action).text.toString())
        assertLayout(a)
        assertNull(Core.running())
        assertNull(launcher.nextStartedService)

        val tap = action(b)
        val pending = PendingIntent.getActivity(app, b, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
        assertNotNull(pending)
        assertTrue(pending!!.isImmutable)
        assertEquals(ComponentName(app, MacWidgetConnectActivity::class.java), tap.component)
        val busyTap = action(a)
        assertFalse(tap.filterEquals(busyTap))

        Robolectric.buildActivity(MacWidgetConnectActivity::class.java, tap).create()
        val dispatch = launcher.nextStartedActivity
        assertEquals(ComponentName(app, MainActivity::class.java), dispatch.component)
        assertNull(Core.running())

        val core = Core::class.java.getDeclaredConstructor(Context::class.java)
            .apply { isAccessible = true }.newInstance(app)
        val instance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        val lane = Link::class.java.getDeclaredField("exec").apply { isAccessible = true }.get(core.link) as ExecutorService
        Core::class.java.getDeclaredField("started").apply { isAccessible = true }.set(core, true)
        store.setFlag("ble", false)
        store.setFlag("tailscale", false)
        instance.set(null, core)
        val activity = Robolectric.buildActivity(MainActivity::class.java, dispatch)
        try {
            activity.create().start()
            assertNull(core.link.host)
            activity.resume()
            lane.submit {}.get(4, TimeUnit.SECONDS)
            assertEquals(second.id, core.link.host?.id)
            assertEquals(ComponentName(app, TwinService::class.java), launcher.nextStartedService.component)
            assertTouchpad(core, lane, a, b)

            // Busy is a valid tap whose requested connection cannot start. The app still starts
            // its service, and it must leave the different Mac's authenticated route alone.
            val whileBusy = MacWidget.forwardConnect(app, busyTap)!!
            activity.newIntent(whileBusy)
            assertEquals(ComponentName(app, TwinService::class.java), launcher.nextStartedService.component)
            assertEquals(second.id, core.link.host?.id)
            assertTrue(core.link.connected)
        } finally {
            activity.pause().stop().destroy()
            core.link.disconnect()
            lane.submit {}.get(4, TimeUnit.SECONDS)
            lane.shutdownNow()
            core.timers.shutdownNow()
            core.bg.shutdownNow()
            instance.set(null, null)
        }
    }

    // A local socket fixture supplies the already-authenticated route. The launcher, activity
    // and WebView bridge are the production entry points, with no Mac or network dependency.
    private class Socket : WebSocket {
        val frames = CopyOnWriteArrayList<String>()
        override fun request(): Request = Request.Builder().url("wss://127.0.0.1").build()
        override fun queueSize() = 0L
        override fun send(text: String) = frames.add(text)
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?) = true
        override fun cancel() = Unit
    }

    private fun assertTouchpad(core: Core, lane: ExecutorService, disconnected: Int, connected: Int) {
        val owner = Socket()
        val replacement = Socket()
        val link = core.link
        val setWs = Link::class.java.getDeclaredMethod("setWs", WebSocket::class.java).apply { isAccessible = true }
        val state = Link::class.java.getDeclaredField("state").apply { isAccessible = true }
        lane.submit {
            setWs.invoke(link, owner)
            state.set(link, "connected")
        }.get(4, TimeUnit.SECONDS)
        MacWidgetProvider().onUpdate(app, manager, intArrayOf(disconnected, connected))
        assertEquals("Não conectado", widgets.getViewFor(disconnected).findViewById<TextView>(R.id.widget_mac_status).text.toString())
        assertEquals("Conectado · Wi-Fi", widgets.getViewFor(connected).findViewById<TextView>(R.id.widget_mac_status).text.toString())
        val tap = action(connected)
        assertEquals(ComponentName(app, MacWidgetTouchpadActivity::class.java), tap.component)
        val pad = Robolectric.buildActivity(MacWidgetTouchpadActivity::class.java, tap).create().start()
        try {
            assertFalse(pad.get().isFinishing)
            val page = pad.get().findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as WebView
            val bridge = shadowOf(page).getJavascriptInterface("TD")
            val move = bridge.javaClass.getDeclaredMethod("move", Int::class.javaPrimitiveType,
                Double::class.javaPrimitiveType, Double::class.javaPrimitiveType, Boolean::class.javaPrimitiveType)
                .apply { isAccessible = true }
            move.invoke(bridge, 0, 3.0, 2.0, false)
            assertEquals("remote.mm", JSONObject(owner.frames.last()).getString("t"))
            val sent = owner.frames.size
            lane.submit {
                setWs.invoke(link, replacement)
                move.invoke(bridge, 0, 1.0, 1.0, false)
                setWs.invoke(link, owner)
            }.get(4, TimeUnit.SECONDS)
            move.invoke(bridge, 0, 2.0, 2.0, false)
            assertEquals(sent, owner.frames.size)
            assertTrue(replacement.frames.isEmpty())
        } finally {
            pad.stop().destroy()
        }
    }

    @Test
    fun oldTapCannotOpenMainAfterForgetAndRePairEvenWithIdenticalSavedCredentials() {
        store.saveHosts(listOf(first, second))
        val id = widget()
        assertTrue(MacWidget.configure(app, id, store, first))
        val stale = action(id)
        store.forgetHost(first.id)
        store.putHost(first)
        Robolectric.buildActivity(MacWidgetConnectActivity::class.java, stale).create()
        assertNull(launcher.nextStartedActivity)
        assertNull(launcher.nextStartedService)
        assertNull(Core.running())

        val spoof = Intent(app, MainActivity::class.java).setAction(MacWidget.DISPATCH_CONNECT)
        assertTrue(Robolectric.buildActivity(MainActivity::class.java, spoof).create().get().isFinishing)
        assertNull(Core.running())

        // A task restored after process death keeps Android's original launch intent, but the
        // one-use dispatch ticket has expired. Restore the ordinary screen without dialing.
        val core = Core::class.java.getDeclaredConstructor(Context::class.java)
            .apply { isAccessible = true }.newInstance(app)
        val instance = Core::class.java.getDeclaredField("instance").apply { isAccessible = true }
        Core::class.java.getDeclaredField("started").apply { isAccessible = true }.set(core, true)
        instance.set(null, core)
        try {
            val restored = Robolectric.buildActivity(MainActivity::class.java, Intent(spoof)).create(Bundle())
            try {
                assertFalse(restored.get().isFinishing)
                assertEquals(Intent.ACTION_MAIN, restored.get().intent.action)
                assertEquals(ComponentName(app, TwinService::class.java), launcher.nextStartedService.component)
                assertNull(core.link.host)
            } finally {
                restored.destroy()
            }
        } finally {
            core.timers.shutdownNow()
            core.bg.shutdownNow()
            instance.set(null, null)
        }
    }
}
