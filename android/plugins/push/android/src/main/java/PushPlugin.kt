package com.tinkerware.threadbear.push

import android.Manifest
import android.app.Activity
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * What the page can ask of the phone (android/plugins/push):
 *
 *   status    { available, permission }   whether this build has Firebase, and whether
 *                                         notifications are allowed
 *   register  { token, key, permission }  asks for the permission if need be, then gives
 *                                         the Firebase token and the push key (base64 of 32 bytes)
 *   scan      { text } or { cancelled }   Google's own code scanner, over the app: the text of
 *                                         the QR code it reads, which the page checks is a
 *                                         pairing link before it offers anything
 *
 * The page sends the first two to its own backend (phone:registerDevice);
 * nothing here talks to a server of ours. The scanner is Google Play services'
 * (it has its own camera screen and asks for no camera permission of this app).
 */
@TauriPlugin(
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        super.load(webView)
        // Only in the emulator check's build: say which token this copy has, so the
        // check knows where to send. The app people install never does.
        if (BuildConfig.LOG_PUSH_TOKEN && PushFirebase.ready(activity)) {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) Log.i(TAG, "test token ${task.result}") else Log.w(TAG, "no test token: ${task.exception?.javaClass?.simpleName}")
            }
        }
    }

    private fun permission(): String =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) "granted" else (getPermissionState("notifications")?.toString() ?: "prompt")

    private fun granted(): Boolean = permission() == "granted"

    @Command
    fun status(invoke: Invoke) {
        val answer = JSObject()
        answer.put("available", PushFirebase.configured(activity))
        answer.put("permission", permission())
        invoke.resolve(answer)
    }

    @Command
    fun register(invoke: Invoke) {
        if (!PushFirebase.ready(activity)) {
            invoke.reject("This build of the app has no Firebase project set up")
            return
        }
        if (!granted() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAlias("notifications", invoke, "afterPermission")
        } else {
            giveToken(invoke)
        }
    }

    // Opens Google's code scanner for a QR code, for the pairing screen's "Scan the
    // code". Backing out of it is an answer ({ cancelled }), not an error. Without
    // Google Play services, or with the scanner not yet downloaded and no network, it
    // fails, and the page says so and leaves the paste box.
    @Command
    fun scan(invoke: Invoke) {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(activity, options).startScan()
            .addOnSuccessListener { barcode ->
                val answer = JSObject()
                answer.put("text", barcode.rawValue ?: "")
                invoke.resolve(answer)
            }
            .addOnCanceledListener {
                val answer = JSObject()
                answer.put("cancelled", true)
                invoke.resolve(answer)
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "the code scanner failed: ${e.javaClass.simpleName}")
                invoke.reject("The scanner could not open: ${e.message ?: "unknown reason"}. It needs Google Play services. You can paste the link instead.")
            }
    }

    @PermissionCallback
    private fun afterPermission(invoke: Invoke) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            giveToken(invoke)
        } else {
            invoke.reject("Notifications were not allowed for this app")
        }
    }

    private fun giveToken(invoke: Invoke) {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                invoke.reject("Firebase gave no token: ${task.exception?.message ?: "unknown reason"}")
                return@addOnCompleteListener
            }
            val answer = JSObject()
            answer.put("token", task.result)
            answer.put("key", Base64.encodeToString(PushKey.get(activity), Base64.NO_WRAP))
            answer.put("permission", "granted")
            invoke.resolve(answer)
        }
    }
}
