// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's shared folder in Android's Files app and every app's file picker, while it shares
// one with this phone (FolderShare.kt, shared/foldershare.js there): browse, open, save, new
// folder, rename, delete. Files open from a copy here (apps want to seek in them); what an app
// writes goes back to the computer when it closes the file. No root when nothing is shared.
// Over paired HTTPS on the LAN or cable, or through the exact TwinDesk Network session.
package com.twindesk.android

import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.util.Log
import android.webkit.MimeTypeMap
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class PcShareProvider : DocumentsProvider() {
    companion object {
        const val ROOT = "pc"
        fun authority(ctx: Context) = "${ctx.packageName}.pcshare"
        private val ROOT_COLS = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_MIME_TYPES, Root.COLUMN_AVAILABLE_BYTES)
        private val DOC_COLS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
    }

    private val auth get() = authority(context!!)
    private val writes by lazy { Handler(HandlerThread("td-pcshare").apply { start() }.looper) }
    @Volatile private var free = -1L

    override fun onCreate() = true

    private val core get() = Core.get(context!!)

    private fun pc(): FolderShare.Pc = core.share.pc?.also(::requireCurrent)
        ?: throw FileNotFoundException("not shared")

    private fun requireCurrent(p: FolderShare.Pc) {
        if (core.share.pc !== p || p.embeddedRoute?.let(core.link::isEmbeddedRoute) == false) {
            throw FileNotFoundException("share ended")
        }
    }

    // Document ids: "/" the folder, "/a/b" inside it.
    private fun rel(id: String) = id.trim('/')
    private fun idOf(rel: String) = "/" + rel.trim('/')
    private fun parentId(id: String) = idOf(rel(id).substringBeforeLast('/', ""))

    private fun path(p: FolderShare.Pc, op: String, id: String, extra: String = "") =
        "/${p.token}/$op?p=${Uri.encode(rel(id))}$extra"

    private fun open(p: FolderShare.Pc, op: String, id: String, extra: String = ""): HttpsURLConnection {
        requireCurrent(p)
        core.net.touch("folder") // Keep Wi-Fi Direct up while Files uses the share.
        val c = URL("https://${if (p.host.contains(':')) "[${p.host}]" else p.host}:${p.port}${path(p, op, id, extra)}").openConnection() as HttpsURLConnection
        c.sslSocketFactory = pinned(p.fp).socketFactory
        c.hostnameVerifier = HostnameVerifier { _, _ -> true } // the pin is the identity, not the name
        return c
    }

    private val contexts = HashMap<String, SSLContext>()

    // Only the computer's own certificate (the one paired with), whatever else is presented.
    @Synchronized
    private fun pinned(fp: String): SSLContext = contexts.getOrPut(fp) {
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("no clients")
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String?) {
                if (fp.isEmpty() || Proto.sha256(chain[0].encoded).hex() != fp) throw CertificateException("not the paired computer")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    }

    private fun <T> withEmbeddedResponse(
        p: FolderShare.Pc, relativePath: String, method: String, body: RequestBody? = null,
        signal: CancellationSignal? = null, use: (Response) -> T,
    ): T {
        requireCurrent(p)
        signal?.throwIfCanceled()
        return try {
            core.link.embeddedFolderCall(checkNotNull(p.embeddedRoute), relativePath, method, body) { call ->
                requireCurrent(p)
                signal?.setOnCancelListener { call.cancel() }
                try {
                    signal?.throwIfCanceled()
                    call.execute().use(use)
                } finally {
                    signal?.setOnCancelListener(null)
                }
            }
        } catch (e: IOException) {
            signal?.throwIfCanceled()
            throw e
        }
    }

    // A request to the computer: (status, body text).
    private fun call(p: FolderShare.Pc, method: String, op: String, id: String, extra: String = "", body: File? = null): Pair<Int, String> {
        if (p.embeddedRoute != null) {
            val requestBody = body?.asRequestBody() ?: if (method == "GET") null else ByteArray(0).toRequestBody()
            return withEmbeddedResponse(p, path(p, op, id, extra), method, requestBody) { response ->
                response.code to runCatching { response.body.string() }.getOrDefault("")
            }
        }
        val c = open(p, op, id, extra)
        try {
            c.requestMethod = method
            c.connectTimeout = 8000
            c.readTimeout = 60000
            if (body != null) {
                c.doOutput = true
                c.setFixedLengthStreamingMode(body.length())
                body.inputStream().use { i -> c.outputStream.use { o -> i.copyTo(o, 64 * 1024) } }
            } else if (method == "PUT") {
                c.doOutput = true
                c.setFixedLengthStreamingMode(0)
                c.outputStream.close()
            }
            val code = c.responseCode
            val text = runCatching { (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: "" }.getOrDefault("")
            return code to text
        } finally {
            c.disconnect()
        }
    }

    private fun mime(name: String, dir: Boolean) = if (dir) Document.MIME_TYPE_DIR
    else MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    private fun addRow(c: MatrixCursor, id: String, o: JSONObject, rootName: String) {
        val dir = o.optBoolean("dir")
        val name = o.optString("name")
        val root = rel(id).isEmpty()
        c.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, id)
            add(Document.COLUMN_DISPLAY_NAME, if (root) rootName else name)
            add(Document.COLUMN_MIME_TYPE, mime(name, dir))
            add(Document.COLUMN_SIZE, if (dir) null else o.optLong("size"))
            add(Document.COLUMN_LAST_MODIFIED, o.optLong("mtime"))
            add(
                Document.COLUMN_FLAGS,
                (if (dir) Document.FLAG_DIR_SUPPORTS_CREATE else Document.FLAG_SUPPORTS_WRITE) or
                    (if (root) 0 else Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME),
            )
        }
    }

    private fun notifyChildren(parent: String) =
        context!!.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(auth, parent), null)

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: ROOT_COLS)
        val p = core.share.pc?.takeUnless { it.embeddedRoute?.let(core.link::isEmbeddedRoute) == false }
            ?: return c.apply { setNotificationUri(context!!.contentResolver, DocumentsContract.buildRootsUri(auth)) }
        c.newRow().apply {
            add(Root.COLUMN_ROOT_ID, ROOT)
            add(Root.COLUMN_DOCUMENT_ID, "/")
            add(Root.COLUMN_TITLE, p.name)
            add(Root.COLUMN_SUMMARY, "TwinDesk")
            add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD)
            add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            add(Root.COLUMN_MIME_TYPES, "*/*")
            add(Root.COLUMN_AVAILABLE_BYTES, if (free >= 0) free else null)
        }
        c.setNotificationUri(context!!.contentResolver, DocumentsContract.buildRootsUri(auth))
        return c
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        val p = pc()
        val (code, text) = call(p, "GET", "stat", documentId)
        if (code != 200) throw FileNotFoundException(documentId)
        addRow(c, documentId, JSONObject(text), p.name)
        return c
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        val p = pc()
        val (code, text) = call(p, "GET", "list", parentDocumentId)
        if (code != 200) throw FileNotFoundException(parentDocumentId)
        val o = JSONObject(text)
        free = o.optLong("free", -1)
        val items = o.optJSONArray("items")
        val base = rel(parentDocumentId)
        for (i in 0 until (items?.length() ?: 0)) {
            val it = items!!.getJSONObject(i)
            addRow(c, idOf(if (base.isEmpty()) it.optString("name") else "$base/${it.optString("name")}"), it, p.name)
        }
        c.setNotificationUri(context!!.contentResolver, DocumentsContract.buildChildDocumentsUri(auth, parentDocumentId))
        return c
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        val p = rel(parentDocumentId)
        val d = rel(documentId)
        return p.isEmpty() && d.isNotEmpty() || d.startsWith("$p/")
    }

    private fun tempFile() = File.createTempFile("pcshare-", ".part", File(context!!.cacheDir, "pcshare").apply { mkdirs() })

    private fun copyTo(input: InputStream, f: File, signal: CancellationSignal?) {
        input.use { i ->
            f.outputStream().use { o ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    signal?.throwIfCanceled()
                    val n = i.read(buf)
                    if (n < 0) break
                    o.write(buf, 0, n)
                }
            }
        }
    }

    // A private copy per descriptor, so concurrent opens do not truncate or upload each other's bytes.
    private fun copy(p: FolderShare.Pc, id: String, signal: CancellationSignal?): File {
        signal?.throwIfCanceled()
        val f = tempFile()
        try {
            if (p.embeddedRoute != null) {
                withEmbeddedResponse(p, path(p, "file", id), "GET", signal = signal) { response ->
                    if (response.code != 200) throw FileNotFoundException(id)
                    copyTo(response.body.byteStream(), f, signal)
                }
            } else {
                val c = open(p, "file", id)
                try {
                    c.connectTimeout = 8000
                    c.readTimeout = 60000
                    if (c.responseCode != 200) throw FileNotFoundException(id)
                    copyTo(c.inputStream, f, signal)
                } finally {
                    c.disconnect()
                }
            }
            signal?.throwIfCanceled()
            requireCurrent(p)
            return f
        } catch (e: Exception) {
            f.delete()
            throw e
        }
    }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        val m = ParcelFileDescriptor.parseMode(mode)
        val p = pc()
        if (!mode.contains('w')) {
            val f = copy(p, documentId, signal)
            try {
                return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
            } finally {
                f.delete()
            }
        }
        // Writing: from what's there unless it's being replaced (w, wt), then back on close.
        signal?.throwIfCanceled()
        val f = if (mode.contains('t') || mode == "w") tempFile() else copy(p, documentId, signal)
        try {
            return ParcelFileDescriptor.open(f, m, writes) { e ->
                try {
                    if (e == null) {
                        val (code, _) = call(p, "PUT", "file", documentId, body = f)
                        if (code in 200..299) notifyChildren(parentId(documentId))
                        else Log.w("TwinDesk", "pcshare: write back failed, HTTP $code")
                    }
                } catch (e: Exception) {
                    Log.w("TwinDesk", "pcshare: write back failed (${e.javaClass.simpleName})")
                } finally {
                    f.delete()
                }
            }
        } catch (e: Exception) {
            f.delete()
            throw e
        }
    }

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
        val base = rel(parentDocumentId)
        val dir = mimeType == Document.MIME_TYPE_DIR
        val clean = displayName.replace(Regex("[/\\\\\\u0000-\\u001f]"), "_").trim().ifEmpty { if (dir) "New Folder" else "File" }
        // Name taken: "name 2.ext", as Finder does.
        val p = pc()
        val (code0, text) = call(p, "GET", "list", parentDocumentId)
        val taken = if (code0 == 200) JSONObject(text).optJSONArray("items")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).optString("name").lowercase() }.toSet() } ?: emptySet() else emptySet()
        var name = clean
        var n = 2
        val stem = if (dir) clean else clean.substringBeforeLast('.', clean)
        val ext = if (dir || !clean.contains('.')) "" else "." + clean.substringAfterLast('.')
        while (name.lowercase() in taken) name = "$stem ${n++}$ext"
        val id = idOf(if (base.isEmpty()) name else "$base/$name")
        val (code, _) = if (dir) call(p, "POST", "mkdir", id) else call(p, "PUT", "file", id)
        if (code !in 200..299) throw FileNotFoundException("couldn’t make $name")
        notifyChildren(parentDocumentId)
        return id
    }

    override fun deleteDocument(documentId: String) {
        val (code, _) = call(pc(), "POST", "delete", documentId)
        if (code !in 200..299) throw FileNotFoundException("couldn’t delete")
        notifyChildren(parentId(documentId))
    }

    override fun renameDocument(documentId: String, displayName: String): String {
        val (code, _) = call(pc(), "POST", "rename", documentId, "&name=${Uri.encode(displayName)}")
        if (code !in 200..299) throw FileNotFoundException("couldn’t rename")
        val p = rel(parentId(documentId))
        notifyChildren(parentId(documentId))
        return idOf(if (p.isEmpty()) displayName else "$p/$displayName")
    }
}
