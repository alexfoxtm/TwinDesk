// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's LocalSend-compatible core (LocalSendCore.kt) on a plain JVM, for
// shared/test/localsend-android.js: one node on 127.0.0.1 that takes its orders as JSON lines on
// stdin and says what happens as JSON lines on stdout. Not part of the app (Gradle doesn't build
// this folder). Arguments: <directory> [approvalMs] [cooldownMs].
package com.twindesk.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.net.InetAddress

fun main(args: Array<String>) {
    val dir = File(args[0]).apply { mkdirs() }
    val received = File(dir, "received").apply { mkdirs() }
    val staging = File(dir, "staging").apply { mkdirs() }
    val stdout = java.io.PrintStream(java.io.FileOutputStream(java.io.FileDescriptor.out), false, "UTF-8")
    val stdin = System.`in`.bufferedReader(Charsets.UTF_8)
    fun say(o: JSONObject) = synchronized(stdout) { stdout.println(o.toString()); stdout.flush() }

    val sink = object : LsSink {
        override fun free() = received.usableSpace
        override fun open(session: String, folder: List<String>, name: String, type: String): LsOut {
            val part = File.createTempFile("ls-", ".part", staging)
            val stream = part.outputStream()
            return object : LsOut {
                override val out: OutputStream = stream
                override fun commit(): String {
                    stream.close()
                    val into = folder.fold(received) { a, b -> File(a, b) }.apply { mkdirs() }
                    var target = File(into, name)
                    var n = 2
                    while (target.exists()) target = File(into, "${name.substringBeforeLast('.', name)} (${n++})${if ('.' in name) "." + name.substringAfterLast('.') else ""}")
                    check(target.canonicalPath.startsWith(received.canonicalPath + File.separator)) { "outside the folder" }
                    check(part.renameTo(target)) { "rename" }
                    return target.path
                }
                override fun discard() { runCatching { stream.close() }; part.delete() }
            }
        }
    }
    val events = object : LsEvents {
        override fun changed() = say(JSONObject().put("ev", "changed"))
        override fun offer(o: LsOffer) = say(JSONObject().put("ev", "offer").put("id", o.id).put("ip", o.ip).put("alias", o.alias).put("fingerprint", o.fingerprint)
            .put("known", o.known).put("verified", o.verified).put("imitates", o.imitates).put("names", JSONArray(o.names)).put("files", o.files).put("total", o.total).put("text", o.text))
        override fun offerEnd(id: String, accepted: Boolean, why: String) = say(JSONObject().put("ev", "offerEnd").put("id", id).put("accepted", accepted).put("why", why))
        override fun transfer(t: LsTransfer) = say(JSONObject().put("ev", "transfer").put("id", t.id).put("incoming", t.incoming).put("peer", t.peer).put("names", JSONArray(t.names))
            .put("files", t.files).put("total", t.total).put("done", t.done).put("state", t.state).put("error", t.error).put("arrived", t.arrived).put("saved", JSONArray(t.saved)))
    }
    val node = LocalSendCore(dir, { "Kotlin node" }, sink, events, LsOptions(port = 0, bind = "127.0.0.1", multicast = false, deviceModel = "Harness",
        approvalMs = args.getOrNull(1)?.toLong() ?: 60_000, cooldownMs = args.getOrNull(2)?.toLong() ?: 300, log = { System.err.println(it) }))
    node.start()
    say(JSONObject().put("ev", "ready").put("port", node.port).put("fingerprint", node.fingerprint).put("receiving", node.receiving).put("received", received.path))

    while (true) {
        val line = stdin.readLine() ?: break
        val c = runCatching { JSONObject(line) }.getOrNull() ?: continue
        val tag = c.optString("tag")
        val answer = JSONObject().put("ev", "reply").put("tag", tag)
        try {
            when (c.optString("cmd")) {
                "probe" -> Thread {
                    say(try { answer.put("id", node.probe(c.getString("host"), c.getInt("port")).id) } catch (e: LsException) { answer.put("error", e.code) })
                }.start()
                "send" -> {
                    val files = c.getJSONArray("files")
                    val sources = (0 until files.length()).map { i ->
                        val f = files.getJSONObject(i)
                        val file = File(f.getString("path"))
                        LsSource(f.getString("name"), f.optLong("size", file.length()), "application/octet-stream", f.optString("sha256")) { file.inputStream() }
                    }
                    say(answer.put("id", node.send(c.getString("peer"), sources, c.optString("pin").ifEmpty { null })))
                }
                "answer" -> say(answer.put("ok", node.answer(c.getString("id"), c.getBoolean("accept"))))
                "cancel" -> say(answer.put("ok", node.cancel(c.getString("id"))))
                "heard" -> { node.heard(c.getString("text"), InetAddress.getByName(c.getString("from"))); say(answer) }
                "peers" -> say(answer.put("peers", JSONArray(node.peers().map {
                    JSONObject().put("id", it.id).put("alias", it.alias).put("ip", it.ip).put("port", it.port).put("fingerprint", it.fingerprint)
                        .put("verified", it.verified).put("supported", it.supported).put("why", it.why).put("protocol", it.protocol)
                })))
                "stop" -> { node.stop(); say(answer); return }
                else -> say(answer.put("error", "command"))
            }
        } catch (e: LsException) {
            say(answer.put("error", e.code))
        } catch (e: Exception) {
            say(answer.put("error", e.toString()))
        }
    }
    node.stop()
}
