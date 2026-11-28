// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.pm.PackageManager
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// Fork APKs arrive only in response to this phone's explicit request on this exact link.
// They never enter Downloads or the generic received-files installer.
class ForkUpdate(private val core: Core, private val install: (File, String) -> String?) {
    data class Offer(val id: String, val version: String, val build: Int, val code: Long,
        val size: Long, val sha256: String, val chunk: Int)

    @Volatile var offer: Offer? = null; private set
    @Volatile var stage = ""; private set
    @Volatile var progress = 0f; private set
    @Volatile var error = ""; private set
    @Volatile var checked = false; private set
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "td-fork-update").apply { isDaemon = true } }
    private var owner: Link.TrustedRoute? = null
    private var checkId = ""
    private var generation = 0L
    private var offset = 0L
    private var output: FileOutputStream? = null
    private var hash: MessageDigest? = null
    private var part: File? = null
    private var ready: File? = null

    init {
        io.execute {
            File(core.ctx.cacheDir, "fork-update").listFiles()?.forEach { file ->
                if (file.isFile && file.name.startsWith("apk-")) file.delete()
            }
        }
    }

    fun onWelcome(host: Host) { onClosed() }

    fun onClosed() = io.execute {
        clear()
        owner = null
        offer = null
        checkId = ""
        checked = false
        stage = ""
        error = ""
        core.changed()
    }

    fun checkNow() = io.execute {
        if (!BuildConfig.UPDATER) return@execute
        val route = core.link.currentTrustedRoute() ?: return@execute
        if (core.host?.os != "mac" || core.link.ble) return@execute
        clear()
        owner = route
        offer = null
        checked = false
        error = ""
        stage = "checking"
        checkId = ByteArray(16).also { SecureRandom().nextBytes(it) }.hex()
        if (!core.link.sendFor(route, msg("fork.update.check", "check" to checkId,
                "package" to core.ctx.packageName, "versionCode" to BuildConfig.VERSION_CODE))) {
            fail()
        } else deadline()
        core.changed()
    }

    fun download() = io.execute {
        val candidate = offer ?: return@execute
        if (stage != "offered" || !core.link.accepts(owner)) return@execute
        clear()
        offset = 0
        error = ""
        progress = 0f
        try {
            val dir = File(core.ctx.cacheDir, "fork-update").apply { mkdirs() }
            val file = File.createTempFile("apk-", ".apk", dir)
            part = file
            output = FileOutputStream(file)
            hash = MessageDigest.getInstance("SHA-256")
            stage = "downloading"
            request(candidate)
        } catch (_: Exception) { fail() }
        core.changed()
    }

    fun cancel() = io.execute {
        offer?.let { core.link.sendFor(owner, msg("fork.update.cancel", "id" to it.id)) }
        clear()
        offer = null
        stage = ""
        core.changed()
    }

    fun installNow() = io.execute {
        val candidate = offer ?: return@execute
        val file = ready ?: return@execute
        if (stage != "ready" || !core.link.accepts(owner)) return@execute
        try {
            validate(file, candidate)
            if (!core.link.accepts(owner)) { clear(); stage = ""; core.changed(); return@execute }
            stage = "installing"
            val version = "${candidate.version} (${candidate.build.toString().padStart(3, '0')})"
            error = install(file, version).orEmpty()
            if (error.isNotEmpty()) stage = "ready"
            core.changed()
        } catch (_: Exception) { stage = "ready"; error = tr("The update didn’t install"); core.changed() }
    }

    fun installAnswer(ok: Boolean, waiting: Boolean, message: String) = io.execute {
        if (waiting || stage != "installing") return@execute
        stage = if (ready?.isFile == true) "ready" else ""
        error = if (ok) "" else message.ifEmpty { tr("The update didn’t install") }
        core.changed()
    }

    fun onMessage(t: String, m: JSONObject, route: Link.TrustedRoute?): Boolean {
        if (!t.startsWith("fork.update.")) return false
        if (!core.link.accepts(route)) return true
        io.execute {
            val own = owner
            if (own == null || route == null || !own.matches(route.marker, route.id, route.fp) ||
                !core.link.accepts(own)) return@execute
            try {
                when (t) {
                    "fork.update.error" -> {
                        val checking = stage == "checking" && m.optString("check") == checkId
                        val downloading = stage == "downloading" && m.optString("id") == offer?.id
                        if (!checking && !downloading) return@execute
                        fail()
                    }
                    "fork.update.offer" -> {
                        if (stage != "checking" || m.optString("check") != checkId) return@execute
                        ++generation
                        checked = true
                        if (m.opt("available") == false) { stage = "current"; core.changed(); return@execute }
                        val candidate = parseOffer(m, core.ctx.packageName, BuildConfig.VERSION_CODE.toLong())
                        offer = candidate
                        stage = "offered"
                    }
                    "fork.update.chunk" -> {
                        val candidate = offer ?: return@execute
                        if (stage != "downloading" || m.optString("id") != candidate.id) return@execute
                        val at = m.opt("offset") as? Number ?: throw IllegalArgumentException()
                        if (at.toLong() != offset || at.toDouble() != offset.toDouble()) throw IllegalArgumentException()
                        val encoded = m.optString("data")
                        if (encoded.length > (candidate.chunk + 2) / 3 * 4) throw IllegalArgumentException()
                        val bytes = Base64.getDecoder().decode(encoded)
                        val expected = minOf(candidate.chunk.toLong(), candidate.size - offset).toInt()
                        if (bytes.size != expected || m.opt("done") != (offset + expected == candidate.size)) throw IllegalArgumentException()
                        output?.write(bytes) ?: throw IllegalStateException()
                        hash?.update(bytes)
                        offset += bytes.size
                        progress = offset.toFloat() / candidate.size
                        if (offset == candidate.size) {
                            output?.close(); output = null
                            val file = part ?: throw IllegalStateException()
                            if (hash?.digest()?.hex() != candidate.sha256) throw IllegalArgumentException()
                            validate(file, candidate)
                            part = null
                            ready = file
                            stage = "ready"
                            ++generation
                        } else request(candidate)
                    }
                }
            } catch (_: Exception) { fail() }
            core.changed()
        }
        return true
    }

    private fun request(candidate: Offer) {
        if (!core.link.sendFor(owner, msg("fork.update.request", "id" to candidate.id, "offset" to offset))) fail()
        else deadline()
    }

    private fun deadline() {
        val token = ++generation
        core.bg.schedule({ io.execute {
            if (token == generation && stage in setOf("checking", "downloading")) { fail(); core.changed() }
        } }, 30, TimeUnit.SECONDS)
    }

    private fun clear() {
        ++generation
        runCatching { output?.close() }
        output = null
        hash = null
        part?.delete(); part = null
        ready?.delete(); ready = null
        offset = 0
    }

    private fun fail() {
        clear()
        offer = null
        stage = "error"
        error = tr("The download didn’t match the release’s file")
    }

    private fun validate(file: File, candidate: Offer) {
        require(file.length() == candidate.size)
        val sha = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; sha.update(buffer, 0, n) }
        }
        require(sha.digest().hex() == candidate.sha256)
        val pm = core.ctx.packageManager
        @Suppress("DEPRECATION")
        val archive = pm.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: throw IllegalArgumentException()
        @Suppress("DEPRECATION")
        val current = pm.getPackageInfo(core.ctx.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        require(archive.packageName == core.ctx.packageName && archive.longVersionCode == candidate.code &&
            archive.longVersionCode > current.longVersionCode && archive.versionName == candidate.version &&
            archive.versionName == current.versionName)
        val incoming = archive.signingInfo?.apkContentsSigners?.map { it.toByteArray().hex() }?.toSet().orEmpty()
        val installed = current.signingInfo?.apkContentsSigners?.map { it.toByteArray().hex() }?.toSet().orEmpty()
        require(incoming.isNotEmpty() && incoming == installed)
    }

    companion object {
        private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
        internal fun parseOffer(m: JSONObject, packageName: String, currentCode: Long): Offer {
            fun integer(key: String): Long {
                val value = m.opt(key) as? Number ?: throw IllegalArgumentException()
                val integer = value.toLong()
                require(value.toDouble().isFinite() && value.toDouble() == integer.toDouble())
                return integer
            }
            val id = m.optString("id")
            val digest = m.optString("sha256")
            val version = m.optString("version")
            val build = integer("build")
            val code = integer("versionCode")
            val size = integer("size")
            val chunk = integer("chunk")
            require(m.opt("available") == true && m.optString("package") == packageName &&
                id.matches(Regex("[a-f0-9]{32}")) && digest.matches(Regex("[a-f0-9]{64}")) &&
                version == BuildConfig.VERSION_NAME && build in 1..9999 &&
                code == 100000 + build && code > currentCode && size in 1..(256L * 1024 * 1024) &&
                chunk in 1..(512L * 1024))
            return Offer(id, version, build.toInt(), code, size, digest, chunk.toInt())
        }
    }
}
