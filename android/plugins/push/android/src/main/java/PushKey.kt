package com.tinkerware.threadbear.push

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * This phone's own push key: 32 random bytes made here, sent only to the
 * person's own backend (phone:registerDevice), which seals each notification
 * with it (convex/push.ts). Firebase and the relay carry the sealed text and
 * cannot read it. The key is kept wrapped by a key in the Android Keystore,
 * which does not leave the chip, so the stored copy is no use off this phone.
 */
object PushKey {
    private const val ALIAS = "threadbear.push.wrap"
    private const val PREFS = "threadbear.push"
    private const val WRAPPED = "key"

    fun get(context: Context): ByteArray {
        testKey()?.let { return it }
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(WRAPPED, null)?.let { stored -> unwrap(stored)?.let { return it } }
        // Nothing yet, or what was kept cannot be opened (a restored backup has
        // no Keystore key to open it with): a new one, which the page registers
        // the next time the app opens.
        val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }
        prefs.edit().putString(WRAPPED, wrap(fresh)).commit()
        return fresh
    }

    // The emulator check's key, when the build was given one (see build.gradle.kts)
    private fun testKey(): ByteArray? =
        BuildConfig.TEST_PUSH_KEY.takeIf { it.isNotEmpty() }?.let { Base64.decode(it, Base64.DEFAULT) }

    private fun wrappingKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun wrap(raw: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val sealed = cipher.doFinal(raw)
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    private fun unwrap(stored: String): ByteArray? =
        try {
            val parts = stored.split(":")
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val sealed = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, iv))
            cipher.doFinal(sealed)
        } catch (e: Exception) {
            null
        }
}
