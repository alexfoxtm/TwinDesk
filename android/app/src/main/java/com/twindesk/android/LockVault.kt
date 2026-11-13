// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.Context
import android.app.KeyguardManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Credentials are private to the phone and bound to the paired host and certificate.
class LockVault(context: Context) {
    private val prefs = context.getSharedPreferences("lock-credentials", Context.MODE_PRIVATE)
    private val keyguard = context.getSystemService(KeyguardManager::class.java)
    val secure: Boolean get() = keyguard?.isDeviceSecure == true
    private fun name(id: String) = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("twindesk-lock-v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("twindesk-lock-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUnlockedDeviceRequired(true).build())
        }.generateKey()
    }
    private fun aad(host: Host, account: String) = "${host.id}\u0000${host.fp}\u0000$account".toByteArray(Charsets.UTF_8)
    fun has(id: String): Boolean = prefs.contains(name(id))
    fun account(host: Host): String? = runCatching {
        JSONObject(prefs.getString(name(host.id), null) ?: return null).let {
            if (it.getString("fp") == host.fp) it.getString("account") else null
        }
    }.getOrNull()
    fun save(host: Host, account: String, password: String): Boolean = runCatching {
        if (!secure) return false
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(aad(host, account)) }
        val plain = password.toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        val data = JSONObject().put("account", account).put("fp", host.fp).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP))
        prefs.edit().putString(name(host.id), data.toString()).commit()
    }.getOrDefault(false)
    fun load(host: Host): Pair<String, String>? = runCatching {
        if (!secure) return null
        val encoded = prefs.getString(name(host.id), null) ?: return null
        val data = JSONObject(encoded)
        if (data.getString("fp") != host.fp) return null
        val account = data.getString("account")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(data.getString("iv"), Base64.NO_WRAP)))
            updateAAD(aad(host, account))
        }
        val plain = cipher.doFinal(Base64.decode(data.getString("data"), Base64.NO_WRAP))
        try { account to String(plain, Charsets.UTF_8) } finally { plain.fill(0) }
    }.getOrNull()
    fun forget(id: String) { prefs.edit().remove(name(id)).apply() }
}
