// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files with LocalSend-compatible apps on the phone: LocalSendCore.kt (the protocol, MPL-2.0) with
// what is the phone's own — the switch (off until turned on), Downloads › TwinDesk for what's
// accepted, the question for every arriving transfer (on the Files page and as a notification with
// Accept and Decline), the multicast lock while it's on. There is no "always accept".
//
// It runs while TwinDesk runs; nothing is listened for, announced or accepted while the switch is off.
// "LocalSend" names the protocol these apps speak; TwinDesk is not affiliated with it.
package com.twindesk.android

import android.app.KeyguardManager
import android.app.Notification
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import java.io.File
import java.io.OutputStream
import java.util.concurrent.Executors

class LocalSend(private val core: Core) : LsEvents {
    private val ctx: Context get() = core.ctx

    // What the page shows of a transfer of ours that asked for a PIN: the same files again, with it.
    private class Again(val peer: String, val sources: List<LsSource>)

    val on: Boolean get() = core.moduleOn("files") && "files" !in Modules.off(core.store) && core.store.flag(FLAG, false)
    @Volatile var starting = false; private set
    @Volatile var adding = false; private set
    @Volatile var addError = ""; private set
    @Volatile var failed = ""; private set // why it couldn't start at all
    @Volatile private var node: LocalSendCore? = null
    private val life = Executors.newSingleThreadExecutor { r -> Thread(r, "td-localsend-life").apply { isDaemon = true } } // start and stop, in order
    private val work = Executors.newCachedThreadPool { r -> Thread(r, "td-localsend-work").apply { isDaemon = true } } // nothing of the network on the main thread
    private val lock = Any()
    private val history = ArrayList<LsTransfer>() // newest first
    private val again = HashMap<String, Again>()
    private var multicast: WifiManager.MulticastLock? = null

    val running: Boolean get() = node?.running == true
    val receiving: Boolean get() = node?.receiving == true
    val error: String get() = node?.error ?: ""
    val peers: List<LsPeer> get() = node?.peers() ?: emptyList()
    val offers: List<LsOffer> get() = node?.offers() ?: emptyList()
    val transfers: List<LsTransfer> get() = synchronized(lock) { history.toList() }
    fun asksPin(id: String): Boolean = synchronized(lock) { again.containsKey(id) }

    // With the rest of TwinDesk (Core.start): not after Exit, and not before Core is whole.
    fun start() { apply() }

    fun set(value: Boolean) {
        core.store.setFlag(FLAG, value)
        apply()
        core.changed()
    }

    private fun apply() = life.execute {
        val want = on
        if (want && node == null) {
            starting = true
            failed = ""
            core.changed()
            try {
                // Android drops multicast for an app without this lock: the others' announces are how they're found.
                multicast = runCatching {
                    ctx.applicationContext.getSystemService(WifiManager::class.java).createMulticastLock("twindesk-localsend").apply { setReferenceCounted(false); acquire() }
                }.getOrNull()
                val n = LocalSendCore(File(ctx.filesDir, "localsend"), { core.store.deviceName }, sink, this,
                    LsOptions(deviceModel = Build.MODEL ?: "", deviceType = "mobile", log = { Log.d("TwinDesk", "localsend: $it") }))
                node = n
                n.start()
            } catch (e: Exception) {
                Log.d("TwinDesk", "localsend: $e")
                failed = e.message ?: e.javaClass.simpleName
                runCatching { multicast?.release() }
                multicast = null
            }
            starting = false
        } else if (!want && node != null) {
            val n = node
            node = null
            runCatching { n?.stop() }
            runCatching { multicast?.release() }
            multicast = null
            synchronized(lock) {
                for (i in history.indices) if (history[i].live) history[i] = history[i].copy(state = "cancelled")
                again.clear()
            }
            for (i in 0 until SLOTS) { Notify.nm(ctx).cancel(ID_OFFER + i); Notify.nm(ctx).cancel(ID_MOVE + i) }
            addError = ""
        }
        if (!want) failed = ""
        core.changed()
    }

    // ---- accepted files: Downloads › TwinDesk, as the computer's files ----

    private val sink = object : LsSink {
        override fun free(): Long = runCatching { StatFs(Environment.getExternalStorageDirectory().path).availableBytes }.getOrDefault(-1L)

        // The names are LocalSendCore's (Ls.splitName): no "..", no separators. MediaStore gives a
        // name already taken a number, so nothing that's there is replaced.
        override fun open(session: String, folder: List<String>, name: String, type: String): LsOut {
            val resolver = ctx.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, Files.mimeOf(name)) // by its name, not what the sender calls it
                put(MediaStore.Downloads.RELATIVE_PATH, (listOf("Download", "TwinDesk") + folder).joinToString("/") + "/")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no space")
            val stream = try { resolver.openOutputStream(uri)!! } catch (e: Exception) { runCatching { resolver.delete(uri, null, null) }; throw e }
            return object : LsOut {
                override val out: OutputStream = stream
                override fun commit(): String {
                    stream.close()
                    resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                    return uri.toString()
                }
                override fun discard() {
                    runCatching { stream.close() }
                    runCatching { resolver.delete(uri, null, null) }
                }
            }
        }
    }

    // ---- what the page and the notifications do ----

    fun refresh() = work.execute { runCatching { node?.announce() } }

    // Accept needs the phone unlocked: the notification's button is on the lock screen and the page
    // shows over it, and whoever holds a locked phone isn't its owner saying yes. Decline never does.
    fun answer(id: String, accept: Boolean) {
        if (accept && locked()) {
            Handler(Looper.getMainLooper()).post { runCatching { Toast.makeText(ctx, tr("Unlock the phone to accept"), Toast.LENGTH_LONG).show() } }
            return
        }
        work.execute { runCatching { node?.answer(id, accept) } }
    }

    // Locked with a PIN, pattern, password or biometrics (a phone with none has nothing to unlock).
    // Unknown counts as locked.
    private fun locked(): Boolean = runCatching { ctx.getSystemService(KeyguardManager::class.java).isDeviceLocked }.getOrDefault(true)

    fun cancel(id: String) = work.execute { runCatching { node?.cancel(id) } }

    // "192.168.1.20" or "192.168.1.20:53317": a device the network doesn't let us find.
    fun add(text: String) {
        val n = node ?: return
        if (adding) return
        val m = Regex("^\\s*(\\d{1,3}(?:\\.\\d{1,3}){3})(?::(\\d{1,5}))?\\s*$").find(text)
        val port = m?.groupValues?.get(2)?.takeIf { it.isNotEmpty() }?.toInt() ?: Ls.PORT
        if (m == null || port !in 1..65535) { addError = "address"; return core.changed() }
        adding = true
        addError = ""
        core.changed()
        work.execute {
            val code = try { n.probe(m.groupValues[1], port); "" } catch (e: LsException) { e.code } catch (e: Exception) { "unreachable" }
            adding = false
            if (n === node) addError = code
            core.changed()
        }
    }

    // Files chosen here, to a device that was found.
    fun send(peerId: String, uris: List<Uri>) = work.execute {
        val seen = HashSet<String>()
        val sources = core.files.describe(uris).map { item ->
            var name = item.name
            var i = 2
            while (!seen.add(name)) name = item.name.substringBeforeLast('.') + " ${i++}" + item.name.substringAfterLast('.', "").let { e -> if (e.isEmpty()) "" else ".$e" }
            LsSource(name, item.size, Files.mimeOf(name)) { ctx.contentResolver.openInputStream(item.uri) ?: throw java.io.IOException("can't open") }
        }
        start(peerId, sources, null)
    }

    // The device asked for its PIN: the same files again, with it.
    fun sendWithPin(id: String, pin: String) {
        if (pin.isEmpty() || pin.length > 64) return
        val a = synchronized(lock) {
            val x = again.remove(id) ?: return
            history.removeAll { it.id == id }
            x
        }
        work.execute { start(a.peer, a.sources, pin) }
    }

    private fun start(peerId: String, sources: List<LsSource>, pin: String?) {
        val n = node ?: return
        val peer = n.peers().firstOrNull { it.id == peerId }
        try {
            val id = n.send(peerId, sources, pin)
            synchronized(lock) {
                again[id] = Again(peerId, sources)
                history.firstOrNull { it.id == id }?.let { if (!it.live && it.error != "pin") again.remove(id) } // it already ended
            }
        } catch (e: Exception) {
            // Shown where the transfers are: nothing was there to send, or the device is gone or not one we speak with.
            record(LsTransfer("x-${Ls.token()}", false, peer?.alias ?: "", peer?.ip ?: "", emptyList(), 0, 0, 0, "failed", (e as? LsException)?.code ?: "failed"))
            core.changed()
        }
    }

    fun clear() {
        synchronized(lock) {
            val gone = history.filter { !it.live }.map { it.id }
            history.removeAll { !it.live }
            for (id in gone) again.remove(id)
        }
        core.changed()
    }

    private fun record(t: LsTransfer) = synchronized(lock) {
        val i = history.indexOfFirst { it.id == t.id }
        if (i >= 0) history[i] = t else history.add(0, t)
        while (history.size > KEEP) {
            val old = history.indexOfLast { !it.live }
            if (old < 0) break
            again.remove(history.removeAt(old).id)
        }
        // Only a transfer that ended on the other device's PIN is kept for another try.
        if (!t.live && t.error != "pin") again.remove(t.id)
    }

    // ---- what the core reports (on its own threads) ----

    override fun changed() = core.changed()

    override fun offer(o: LsOffer) {
        val text = listOfNotNull(tr("From {address} with a LocalSend-compatible app.", "address" to o.ip),
            if (o.verified) null else tr("This sender didn’t prove which device it is: its name is only what it says."),
            if (o.imitates) tr("Another device uses this name: this may not be the one you think.") else null,
            if (o.known) null else tr("This device hasn’t been seen before: accept only if you expect it."),
            o.text.takeIf { it.isNotEmpty() }?.let { "“${it.take(200)}”" }).joinToString(" ")
        val slot = slot(o.id)
        runCatching {
            Notify.nm(ctx).notify(ID_OFFER + slot, Notification.Builder(ctx, Notify.CH_INVITE)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(tr("{name} wants to send {file} ({size})", "name" to o.alias, "file" to what(o.names, o.files), "size" to FileClip.size(o.total)))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(Notify.openApp(ctx))
                .setOnlyAlertOnce(true)
                // Decline first: the one a hurried tap lands on.
                .addAction(Notification.Action.Builder(null, tr("Decline"), Notify.action(ctx, ActionReceiver.LS_DECLINE, REQ_OFFER + slot * 2, o.id)).build())
                // Accept asks for the unlock first (Android 12 and later do it themselves; answer() refuses on a locked phone in any case).
                .addAction(Notification.Action.Builder(null, tr("Accept"), Notify.action(ctx, ActionReceiver.LS_ACCEPT, REQ_OFFER + slot * 2 + 1, o.id))
                    .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAuthenticationRequired(true) }.build())
                .build())
        }
        core.changed()
    }

    override fun offerEnd(id: String, accepted: Boolean, why: String) {
        runCatching { Notify.nm(ctx).cancel(ID_OFFER + slot(id)) }
        core.changed()
    }

    override fun transfer(t: LsTransfer) {
        record(t)
        val file = what(t.names, t.files)
        val slot = slot(t.id)
        runCatching {
            val b = Notification.Builder(ctx, Notify.CH_FILES).setOnlyAlertOnce(true).setOngoing(t.live).setAutoCancel(!t.live)
            val pct = Files.pct(t.done, t.total)
            when {
                t.state == "waiting" -> b.setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle(tr("Waiting for {name} to accept {file}", "name" to t.peer, "file" to file)).setProgress(100, 0, true)
                t.state == "running" -> b.setSmallIcon(if (t.incoming) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_upload)
                    .setContentTitle(if (t.incoming) tr("Receiving {file} from {name}", "file" to file, "name" to t.peer) else tr("Sending {file} to {name}", "file" to file, "name" to t.peer))
                    .setContentText("$pct%").setProgress(100, pct, false)
                else -> b.setSmallIcon(if (t.incoming) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_sys_upload_done)
                    .setContentTitle(line(t)).setContentText(if (t.incoming && t.arrived > 0) tr("In Downloads › TwinDesk") else "")
            }
            if (t.live) b.addAction(Notification.Action.Builder(null, tr("Cancel"), Notify.action(ctx, ActionReceiver.LS_CANCEL, REQ_MOVE + slot, t.id)).build())
            val open = if (!t.live && t.incoming && t.arrived > 0) openIntent(t) else null
            b.setContentIntent(if (open != null) android.app.PendingIntent.getActivity(ctx, REQ_MOVE + slot, open, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT) else Notify.openApp(ctx))
            Notify.nm(ctx).notify(ID_MOVE + slot, b.build())
        }
        core.changed()
    }

    // One file that arrived: itself; more: the Downloads app.
    fun openIntent(t: LsTransfer): Intent? {
        val uri = t.saved.singleOrNull()?.takeIf { t.files == 1 }?.let { runCatching { Uri.parse(it) }.getOrNull() }
        return if (uri != null) Notify.viewIntent(uri, ctx.contentResolver.getType(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        else Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    companion object {
        const val FLAG = "localsend"
        private const val KEEP = 30
        private const val SLOTS = 20
        private const val ID_OFFER = 30 // … 49: a question each
        private const val ID_MOVE = 50 // … 69: a transfer each
        private const val REQ_OFFER = 0x20000
        private const val REQ_MOVE = 0x20100

        private fun slot(id: String) = Math.floorMod(id.hashCode(), SLOTS)

        fun what(names: List<String>, files: Int): String = if (names.size == 1 && files == 1) names[0] else trCount(files, "file")

        fun short(fingerprint: String): String = if (fingerprint.length < 8) "" else fingerprint.substring(0, 4).uppercase() + " " + fingerprint.substring(4, 8).uppercase()

        // Why a device isn't one we send to, or "".
        fun unsupported(why: String): String = when (why) {
            "plain" -> tr("Encryption is off on that device: not supported")
            "v1" -> tr("Uses the older protocol (v1): not supported")
            "newer" -> tr("Uses a newer protocol: not supported")
            else -> ""
        }

        // A transfer in one line, as the page and its notification say it.
        fun line(t: LsTransfer): String {
            val name = t.peer.ifEmpty { tr("that device") }
            val file = what(t.names, t.files)
            if (!t.incoming) return when (t.state) {
                "waiting" -> tr("Waiting for {name} to accept {file}", "name" to name, "file" to file)
                "running" -> tr("Sending {file} to {name}", "file" to file, "name" to name)
                "done" -> tr("Sent {file} to {name}", "file" to file, "name" to name)
                "cancelled" -> tr("Stopped sending to {name}", "name" to name)
                else -> when (t.error) {
                    "declined" -> tr("Declined on {name}", "name" to name)
                    "pin" -> tr("{name} asks for its PIN", "name" to name)
                    "busy" -> tr("{name} is busy with another transfer", "name" to name)
                    "rate" -> tr("{name} asks to wait a moment", "name" to name)
                    "fingerprint" -> tr("The device at that address isn’t {name}: nothing was sent", "name" to name)
                    "unreachable", "timeout" -> tr("Couldn’t reach {name}", "name" to name)
                    "integrity" -> tr("A file arrived changed: the transfer was stopped")
                    "read" -> tr("A file couldn’t be read")
                    "empty" -> tr("Nothing to send")
                    "peer" -> tr("That device is gone")
                    "plain", "v1", "newer" -> unsupported(t.error)
                    else -> tr("Couldn’t send to {name}", "name" to name)
                }
            }
            return when {
                t.state == "running" -> tr("Receiving {file} from {name}", "file" to file, "name" to name)
                t.state == "done" -> tr("Received {file} from {name}", "file" to file, "name" to name)
                t.arrived > 0 -> tr("Stopped: {count} of {total} files from {name} arrived", "count" to t.arrived, "total" to t.files, "name" to name)
                else -> tr("Stopped: nothing from {name} was kept", "name" to name)
            }
        }
    }
}
