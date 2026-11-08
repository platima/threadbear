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

/**
 * What the page can ask of the phone for notifications (android/plugins/push):
 *
 *   status    { available, permission }   whether this build has Firebase, and whether
 *                                         notifications are allowed
 *   register  { token, key, permission }  asks for the permission if need be, then gives
 *                                         the Firebase token and the push key (base64 of 32 bytes)
 *
 * The page sends both to its own backend (phone:registerDevice); nothing here
 * talks to a server of ours.
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
