// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications › Silence together: this phone's Do not disturb and the Mac's Focus, both ways,
// per pair. Only "silenced or not" is shared. The messages and the policy are shared/silence.js's,
// kept the same here line for line (silence.hello / silence.state / silence.ack):
//   - nothing until the person switches a direction on, here, for that computer;
//   - this phone is silenced for the computer only when it isn't silenced: that is the lease, held
//     for that computer and that session. Only the lease is ever undone, so Do not disturb or a
//     mode the person switched on is never switched off;
//   - the person turning it off during the lease ends it, and it stays off until the computer has
//     been off and on again;
//   - what was silenced for the computer is never told back as this phone's own (no echo), and
//     with "send" off here an answer says nothing of this phone's own state either;
//   - unknown is off: no access, a direction switched off, a message of another session;
//   - a dropped session keeps the lease GRACE_MS for the same computer; Disconnect, Forget, Exit
//     and another computer end it at once.
// This phone's own part (the "local" of silence.js):
//   read: NotificationManager.currentInterruptionFilter, and its broadcast while a direction is on;
//   set:  a Do not disturb rule of TwinDesk's own (AutomaticZenRule, its condition switched with
//     setAutomaticZenRuleState), on every Android here (10+), only with Do Not Disturb access,
//     which the person gives from the page (never asked for by itself). Android adds the rule to
//     whatever else is on, so switching it off takes away only what TwinDesk added: the person's
//     Do not disturb, their modes and schedules are other rules, which this never touches (scoped).
//     The global filter (setInterruptionFilter) is never set here: before Android 15 that is the
//     person's own Do not disturb, and from 15 it is the one rule the app shares with Do not
//     disturb turned on from the computer (DevCtl), which is the person's choice, not a lease.
//   kept: K_HELD is written before the rule is switched on and cleared once it is off again, so a
//     process that ended in between finds it and switches off its own rule (and only that).
// All of it runs on the main thread.
package com.twindesk.android

import android.app.AutomaticZenRule
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.notification.Condition
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.security.SecureRandom

class Silence(core: Core) : Feature(core) {
    companion object {
        const val HELLO = "silence.hello"
        const val STATE = "silence.state"
        const val ACK = "silence.ack"
        private const val V = 1
        private const val GRACE_MS = 30_000L // a dropped session's lease, kept for the same computer to return
        private const val SEEN_MS = 5_000L // the filter is seen changed within this, or nothing is claimed
        private const val UNDONE_MS = 1_500L // ours is undone; the person's own may stay on
        private const val LOOK_MS = 150L
        private const val MAX_APPLIES = 6 // … in APPLY_WINDOW_MS: two sides that keep undoing each other stop here
        private const val APPLY_WINDOW_MS = 60_000L
        private const val K_HELD = "silence.held"
        private val ACKS = setOf("applied", "kept", "released", "overridden", "refused", "failed")
        private val SID = Regex("^[0-9a-f]{8,32}$")
        // The computers that know these messages (Windows and Linux: add them with their own local).
        private val OS = setOf("mac")
    }

    private class Their(val sid: String, val read: Boolean, val set: Boolean, val send: Boolean, val follow: Boolean)
    private class Session(val id: String, val sid: String) {
        var their: Their? = null
        var seq = 0
        var rseq = 0
        var said = false // the computer told its state in this session…
        var remote: Boolean? = null // … true, false, or null: it can't tell
        var told = false // ours was told…
        var sent: Boolean? = null // … as this
        var hello = ""
        var done = false // this "on" of the computer's was answered (once)
        var ack: Pair<String, Boolean?>? = null
        var stopped = false
    }
    private class Lease(val id: String) { var until = 0L }
    class Last(val r: String, val why: String, val at: Long)
    class View(
        val peer: Boolean, val send: Boolean, val follow: Boolean, val canSet: Boolean, val ruleOff: Boolean, val state: Boolean?,
        val known: Boolean, val peerRead: Boolean, val peerSet: Boolean, val peerSend: Boolean, val peerFollow: Boolean,
        val remote: Boolean?, val ack: String, val leased: Boolean, val stale: Boolean, val overridden: Boolean, val last: Last?,
    )

    private val main = Handler(Looper.getMainLooper())
    private val ctx get() = core.ctx
    private val nm: NotificationManager get() = ctx.getSystemService(NotificationManager::class.java)
    // TwinDesk's rule is known by this, whatever its id.
    private val conditionId: Uri by lazy { Uri.Builder().scheme(Condition.SCHEME).authority(ctx.packageName).appendPath("silence").build() }

    private var peer: Session? = null
    private var lease: Lease? = null
    // Our rule was switched on and hasn't been seen off since: a process that ends with it finds it at the next start.
    private var held: Boolean
        get() = core.store.prefsString(K_HELD, "").isNotEmpty()
        set(v) = core.store.setPrefsString(K_HELD, if (v) "1" else "")
    private var disabled = false // the person switched TwinDesk's rule off in Settings: theirs to say
    private var override: String? = null // the computer whose silence the person here turned off
    private var forgot: String? = null
    private var stale = false // a silence of ours that couldn't be undone: not told as the person's
    private var busy = false
    private val applies = ArrayList<Long>()
    private var last: Last? = null
    private var watching = false
    var dropped = 0 // messages that weren't for this session
        private set

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) { main.post { localChanged() } }
    }
    private val graceEnd = Runnable {
        val l = lease ?: return@Runnable
        l.until = 0
        release()
        sync()
    }

    init {
        // A silence of ours the last process left on (it ended while the rule was on): our own
        // rule, switched off. Nothing of the person's is reached by that. Without access it can't
        // be done yet: kept for the next start.
        main.post {
            if (!held || lease != null || busy || !granted()) return@post
            held = !ruleOff()
        }
    }

    // ---- this phone (silence.js's local) ----

    private fun granted(): Boolean = runCatching { nm.isNotificationPolicyAccessGranted }.getOrDefault(false)

    private fun localState(): Boolean? = when (runCatching { nm.currentInterruptionFilter }.getOrDefault(NotificationManager.INTERRUPTION_FILTER_UNKNOWN)) {
        NotificationManager.INTERRUPTION_FILTER_ALL -> false
        NotificationManager.INTERRUPTION_FILTER_PRIORITY, NotificationManager.INTERRUPTION_FILTER_NONE, NotificationManager.INTERRUPTION_FILTER_ALARMS -> true
        else -> null
    }

    // TwinDesk's rule: its id. None when there is no access, when the person switched it off in
    // Settings, or when there isn't one yet: made only as this phone is first silenced for the computer.
    private fun rule(make: Boolean): String? {
        if (!granted()) return null
        return runCatching {
            val mine = nm.automaticZenRules.entries.firstOrNull { it.value.conditionId == conditionId }
            when {
                mine != null -> mine.key.takeIf { mine.value.isEnabled }
                make -> nm.addAutomaticZenRule(
                    AutomaticZenRule(tr("Silence together"), null, ComponentName(ctx, MainActivity::class.java), conditionId, null, NotificationManager.INTERRUPTION_FILTER_PRIORITY, true),
                )
                else -> null
            }
        }.getOrNull()
    }

    private fun ruleDisabled(): Boolean = granted() && runCatching { nm.automaticZenRules.values.any { it.conditionId == conditionId && !it.isEnabled } }.getOrDefault(false)

    // Android 15+ says whether a rule of ours is active; before, it can't be asked (null).
    private fun ruleActive(id: String): Boolean? =
        if (Build.VERSION.SDK_INT >= 35) runCatching { nm.getAutomaticZenRuleState(id) == Condition.STATE_TRUE }.getOrNull() else null

    // Ours off, whatever else is so: only TwinDesk's rule, so safe at any time. True: nothing of ours is on.
    private fun ruleOff(): Boolean {
        if (!granted()) return false
        val id = rule(false) ?: return true
        return runCatching { nm.setAutomaticZenRuleState(id, Condition(conditionId, "", Condition.STATE_FALSE)) }.isSuccess
    }

    // Still the silence set here. Android 15+ says when our rule was switched off under it: the
    // phone is then silenced by the person's own.
    private fun stillOurs(): Boolean {
        val id = rule(false) ?: return false
        return ruleActive(id) != false
    }

    private fun watch(on: Boolean) {
        if (on) {
            val f = IntentFilter().apply {
                addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
                addAction(NotificationManager.ACTION_NOTIFICATION_POLICY_ACCESS_GRANTED_CHANGED)
            }
            runCatching { ContextCompat.registerReceiver(ctx, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED) }
        } else runCatching { ctx.unregisterReceiver(receiver) }
    }

    // Silences this phone with TwinDesk's own rule, or undoes exactly that. done(ok, why) once it is seen, or isn't.
    private fun setLocal(on: Boolean, done: (Boolean, String) -> Unit) {
        if (!granted()) return done(false, "access")
        val id = rule(make = on) ?: return if (on) done(false, "rule") else done(true, "") // no rule of ours (or switched off by the person): nothing of ours is on
        val c = Condition(conditionId, "", if (on) Condition.STATE_TRUE else Condition.STATE_FALSE)
        if (runCatching { nm.setAutomaticZenRuleState(id, c) }.isFailure) return done(false, "error")
        seen(on, id, SystemClock.uptimeMillis() + (if (on) SEEN_MS else UNDONE_MS), done)
    }

    // On: the phone is seen silenced (and, where Android says, by our rule). Off: ours is off
    // whatever the phone still says, as the rest is the person's; waited for briefly, so that the
    // moment before it is seen isn't told as theirs.
    private fun seen(on: Boolean, id: String, until: Long, done: (Boolean, String) -> Unit) {
        val active = ruleActive(id)
        val ok = if (on) localState() == true && active != false else localState() == false
        if (ok) return done(true, "")
        if (SystemClock.uptimeMillis() >= until) return if (on || active == true) done(false, "unconfirmed") else done(true, "")
        main.postDelayed({ seen(on, id, until, done) }, LOOK_MS)
    }

    // ---- the session ----

    override fun onWelcome(host: Host) { main.post { welcome(host) } }

    override fun onClosed() {
        if (peer == null) return
        peer = null
        if (lease?.until == 0L) graceStart()
        sync()
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            HELLO -> hello(m)
            STATE -> state(m)
            ACK -> ack(m)
            else -> return false
        }
        return true
    }

    private fun welcome(host: Host) {
        peer = null
        if (lease != null && lease?.id != host.id) release() // never another computer's, whichever it is
        if (host.os !in OS) return sync()
        if (forgot == host.id) forgot = null // paired again
        if (lease?.until == 0L) graceStart() // a new session without the old one's end: it has the grace to say
        val b = ByteArray(8).also { SecureRandom().nextBytes(it) }
        peer = Session(host.id, b.hex())
        sync()
    }

    // The session we hold is the one that is up.
    private fun current(): Boolean = peer?.let { core.host?.id == it.id } == true

    private fun hello(m: JSONObject) {
        val p = peer
        val sid = m.opt("sid") as? String
        if (p == null || !current() || m.opt("v") != V || sid == null || !SID.matches(sid)) { dropped++; return }
        val first = p.their?.sid != sid
        if (first) { p.rseq = 0; p.said = false; p.remote = null; p.told = false; p.sent = null; p.ack = null }
        val th = Their(sid, m.opt("read") == true, m.opt("set") == true, m.opt("send") == true, m.opt("follow") == true)
        p.their = th
        if (!th.send || !th.read) { p.said = false; p.remote = null } // it tells nothing (any more): unknown
        if (first) p.hello = "" // ours again: it may have missed the one sent before it listened
        sync()
    }

    private fun state(m: JSONObject) {
        val p = peer
        val th = p?.their
        val seq = m.opt("seq") as? Int
        val on = m.opt("on")
        if (p == null || th == null || !current() || m.opt("sid") != th.sid || m.opt("to") != p.sid || seq == null || seq <= p.rseq ||
            !(on is Boolean || (m.has("on") && m.isNull("on")))
        ) { dropped++; return }
        p.rseq = seq
        if (!th.send || !th.read) return // it said it doesn't tell
        p.said = true
        p.remote = on as? Boolean
        if (on == false && override == p.id) override = null // off there: the next on counts again
        sync()
    }

    private fun ack(m: JSONObject) {
        val p = peer
        val th = p?.their
        val seq = m.opt("seq") as? Int
        val r = m.opt("r") as? String
        if (p == null || th == null || !current() || m.opt("sid") != th.sid || m.opt("to") != p.sid || seq == null || r == null || r !in ACKS) { dropped++; return }
        if (seq != p.seq) return // about a state we have since replaced
        p.ack = r to p.sent
        core.changed()
    }

    private fun tell(r: String, why: String = "") {
        last = Last(r, why, System.currentTimeMillis())
        val p = peer ?: return
        val th = p.their ?: return
        if (p.rseq <= 0 || !current()) return
        // Its own state is told only where the person switched "send" on: that it was silenced
        // already, or that they turned the silence off, isn't the computer's to learn from an answer.
        var wire = r
        if (!opt(p.id, "send")) {
            if (r == "kept") return
            if (r == "overridden") wire = "released"
        }
        core.send(msg(ACK, "sid" to p.sid, "to" to th.sid, "seq" to p.rseq, "r" to wire))
    }

    // ---- this phone's state changed ----

    private fun localChanged() {
        val st = localState()
        if (st == false) stale = false
        val l = lease
        if (l != null && !busy && (st == false || (st == true && !stillOurs()))) {
            // The person turned the silence off (or made it theirs): theirs to keep. Our rule goes
            // off with it (turned off from the shade it is only snoozed, and would come back).
            lease = null
            graceStop()
            held = !ruleOff()
            override = l.id
            tell("overridden")
        }
        sync()
    }

    // Silenced by us, not by the person here: never told to the computer as this phone's own.
    private val ours: Boolean get() = lease != null || busy || stale

    private fun opt(id: String, dir: String) = core.store.flag("silence.$dir.$id", false)

    private fun sync() {
        val p = peer
        val send = p != null && opt(p.id, "send")
        val follow = p != null && opt(p.id, "follow")
        val w = lease != null || send || follow
        if (w != watching) {
            watching = w
            watch(w)
        }
        if (p != null && current()) {
            disabled = ruleDisabled()
            val set = granted() && !disabled
            val hello = msg(HELLO, "v" to V, "sid" to p.sid, "read" to true, "set" to set, "send" to send, "follow" to follow)
            val k = hello.toString()
            if (k != p.hello) {
                p.hello = k
                core.send(hello)
            }
            val th = p.their
            // Ours, to a side that follows.
            if (p.stopped) { /* Disconnect: nothing more is told or followed in this session */ } else if (send && th != null && th.follow && th.set) {
                val st = localState()
                val on: Boolean? = if (st == null) null else st && !ours
                if (!p.told || on != p.sent) {
                    p.told = true
                    p.sent = on
                    p.ack = null
                    p.seq++
                    core.send(msg(STATE, "sid" to p.sid, "to" to th.sid, "seq" to p.seq, "on" to on))
                }
            } else { p.told = false; p.sent = null }
            followPeer(p, follow, set)
        }
        core.changed()
    }

    // Theirs, here.
    private fun followPeer(p: Session, follow: Boolean, set: Boolean) {
        val th = p.their
        val can = !p.stopped && follow && set
        val want = can && th != null && th.send && th.read && p.said && p.remote == true
        val l = lease
        if (l != null && l.id != p.id) { if (!busy) release(); return } // another computer's: undone first
        if (!want) {
            p.done = false
            if (l == null) return
            // Back within the grace, and it hasn't said yet: the timer decides, not this.
            if (l.until != 0L && can && !p.said) return
            return release()
        }
        if (l != null) {
            if (l.until != 0L) graceStop() // the same computer, the same state: the lease goes on
            p.done = true
            return
        }
        if (p.done || busy) return
        val st = localState() ?: return // unknown: nothing done, asked again when it's known
        p.done = true
        if (override == p.id) return tell("overridden")
        if (st) return if (stale) tell("failed", "stuck") else tell("kept") // silenced by its own person: theirs. (Or by us, stuck: not done again over it.)
        act(true, p.id)
    }

    private fun release() {
        val l = lease ?: return
        val st = localState()
        if (st == false) { // off already: our rule's condition with it
            lease = null
            graceStop()
            held = !ruleOff()
            return tell("released")
        }
        act(false, l.id) // unknown too: it is only our own rule that goes off
    }

    private fun act(on: Boolean, id: String) {
        if (busy) return // the one running ends in sync, which asks again
        val t = SystemClock.uptimeMillis()
        applies.removeAll { t - it >= APPLY_WINDOW_MS }
        if (on && applies.size >= MAX_APPLIES) { last = Last("failed", "flapping", System.currentTimeMillis()); return }
        applies.add(t)
        busy = true
        if (on) held = true // before the rule goes on: found again whatever happens next
        setLocal(on) { ok, why ->
            busy = false
            val st = localState()
            if (on) {
                if (ok && st == true) {
                    lease = Lease(id)
                    tell("applied")
                } else {
                    // Not seen on: our rule is switched off again, so nothing of ours comes on late.
                    val clean = ruleOff()
                    held = !clean
                    tell("failed", why.ifEmpty { "unconfirmed" })
                    if (!clean && st == true) stale = true // it is on and couldn't be undone: still not the person's
                }
            } else {
                lease = null
                graceStop()
                if (ok) { held = false; tell("released") }
                else {
                    tell("failed", why.ifEmpty { "unconfirmed" })
                    if (st != false) stale = true
                }
            }
            if (peer == null && lease != null) { if (forgot == lease?.id) release() else graceStart() } // the session went meanwhile
            sync()
        }
    }

    private fun graceStart() {
        val l = lease ?: return
        graceStop()
        l.until = SystemClock.uptimeMillis() + GRACE_MS
        main.postDelayed(graceEnd, GRACE_MS)
    }

    private fun graceStop() {
        main.removeCallbacks(graceEnd)
        lease?.until = 0
    }

    // ---- from the app ----

    private fun onMain(f: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) f() else main.post(f) }

    // The page's two switches, for the computer in the session.
    fun set(dir: String, on: Boolean) = onMain {
        val h = core.host ?: return@onMain
        if (dir != "send" && dir != "follow") return@onMain
        core.store.setFlag("silence.$dir.${h.id}", on)
        sync()
    }

    // Do Not Disturb access changed, or the page is shown again.
    fun refresh() = onMain { sync() }

    // The person turned Do not disturb off from the computer (DevCtl): what is on for the computer
    // goes with it, as if they had turned it off here.
    fun personOff() = onMain {
        val l = lease ?: return@onMain
        if (busy) return@onMain
        lease = null
        graceStop()
        held = !ruleOff()
        override = l.id
        tell("overridden")
        sync()
    }

    // Disconnect and Exit (Core.disconnect): the lease ends now, not after the grace.
    fun stop() = onMain {
        val p = peer
        if (p != null && !p.stopped) {
            p.stopped = true
            // The computer's lease for us ends too: told now, so it doesn't wait out the grace.
            val th = p.their
            if (th != null && p.told && p.sent != null && current()) {
                p.seq++
                core.send(msg(STATE, "sid" to p.sid, "to" to th.sid, "seq" to p.seq, "on" to null))
            }
            p.told = false
            p.sent = null
        }
        graceStop()
        if (lease != null) release()
        sync()
    }

    // The pairing was forgotten (Core.forget): nothing of that computer's is kept.
    fun forget(id: String) = onMain {
        forgot = id
        if (override == id) override = null
        if (lease?.id == id) { graceStop(); release() }
        if (peer?.id == id) peer = null
        core.store.setFlag("silence.send.$id", false)
        core.store.setFlag("silence.follow.$id", false)
        sync()
    }

    // For the page: the session's computer speaks these messages at all (a Mac), and what is so.
    fun view(): View {
        val p = peer
        val th = p?.their
        val send = p != null && opt(p.id, "send")
        val follow = p != null && opt(p.id, "follow")
        return View(
            peer = p != null, send = send, follow = follow, canSet = granted(), ruleOff = disabled, state = if (watching) localState() else null,
            known = th != null, peerRead = th?.read == true, peerSet = th?.set == true, peerSend = th?.send == true, peerFollow = th?.follow == true,
            remote = if (p != null && th != null && th.send && th.read && follow && p.said) p.remote else null,
            ack = p?.ack?.takeIf { it.second == true }?.first ?: "",
            leased = lease != null, stale = stale, overridden = p != null && override == p.id, last = last,
        )
    }
}
