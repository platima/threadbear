package com.tinkerware.threadbear.push

import org.json.JSONObject
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class Alert(val title: String, val body: String)

/**
 * Opens what the person's backend sealed (convex/push.ts seal): AES-256-GCM,
 * base64 of the 12-byte nonce, the ciphertext, then the 16-byte tag, in
 * that order, around {"title": ..., "body": ...}. The iPhone's notification
 * extension does the same (ios/NotificationService). Null for anything else,
 * so the caller shows the stand-in instead.
 */
object PushSeal {
    fun open(sealed: String, key: ByteArray): Alert? =
        try {
            val data = Base64.getMimeDecoder().decode(sealed)
            if (key.size != 32 || data.size < 12 + 16) {
                null
            } else {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, data, 0, 12))
                val plain = cipher.doFinal(data, 12, data.size - 12)
                val json = JSONObject(String(plain, Charsets.UTF_8))
                Alert(json.getString("title"), json.getString("body"))
            }
        } catch (e: Exception) {
            null
        }
}
