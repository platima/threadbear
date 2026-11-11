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
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.firebase.messaging.FirebaseMessaging
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

// Frames of these are the language's, Android's and Tauri's own: not where a failure came from
private val SYSTEM_PACKAGES = listOf(
    "java.", "javax.", "kotlin.", "android.", "androidx.", "dalvik.", "libcore.", "sun.", "com.android.internal.", "app.tauri.",
)

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
        // The page above the keyboard (ImeInsets.kt). Nothing the person asked for rides on it, so
        // whatever goes wrong is only logged and the plugin still loads.
        try {
            ImeInsets.install(activity)
        } catch (e: Throwable) {
            Log.w(TAG, "the page could not be fitted above the keyboard", e)
        }
        // Only in the emulator check's build: say which token this copy has, so the
        // check knows where to send. The app people install never does.
        if (BuildConfig.LOG_PUSH_TOKEN && PushFirebase.ready(activity)) {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) Log.i(TAG, "test token ${task.result}") else Log.w(TAG, "no test token: ${task.exception?.javaClass?.simpleName}")
            }
        }
        fetchScannerModule()
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

    private fun scannerOptions(): GmsBarcodeScannerOptions =
        GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()

    // Backing out of the scanner is an answer, not an error. Google's scanner reports it
    // on the task's cancel listener or, by its own documentation, as a failure with
    // MlKitException.CODE_SCANNER_CANCELLED, so both end here.
    private fun cancelled(invoke: Invoke) {
        val answer = JSObject()
        answer.put("cancelled", true)
        invoke.resolve(answer)
    }

    // Why the scanner did not open, in words for the person, chosen by the error code Google
    // gives (the words are ours, Google supplies only the code): the first scan on an APK
    // installed by hand is likely to find Play services still fetching the scanner's module,
    // and "needs Google Play services" would be the wrong thing to tell a phone that has them.
    private fun scanFailure(e: Exception): String {
        val code = (e as? MlKitException)?.errorCode
        return when (code) {
            MlKitException.CODE_SCANNER_UNAVAILABLE ->
                "Google is still getting its scanner ready. Keep the phone online, wait a minute and tap Scan the code again, or paste the link."
            MlKitException.CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED ->
                "Google Play services has no permission to use the camera, which its scanner needs. Allow it under Settings, Apps, Google Play services, Permissions, or paste the link."
            MlKitException.CODE_SCANNER_GOOGLE_PLAY_SERVICES_VERSION_TOO_OLD ->
                "Google Play services needs updating before it can scan. Update it, or paste the link."
            else ->
                "The scanner could not open (${(e.message ?: "unknown reason").trimEnd('.', ' ')}). You can paste the link instead."
        }
    }

    // Asks Google Play services for the scanner's module now, without waiting for it, so it is
    // there by the first scan. The manifest's own request (com.google.mlkit.vision.DEPENDENCIES)
    // only fetches it for an app installed from the Play Store, and this one is installed by hand.
    // Whatever goes wrong here is only logged: it must never stop the plugin from loading, and
    // the scan will say what is wrong by itself.
    private fun fetchScannerModule() {
        try {
            val scanner = GmsBarcodeScanning.getClient(activity, scannerOptions())
            ModuleInstall.getClient(activity)
                .installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                .addOnFailureListener { e -> Log.i(TAG, "the scanner module was not requested: ${e.javaClass.simpleName}") }
        } catch (e: Throwable) {
            Log.w(TAG, "the scanner module was not requested", e)
        }
    }

    // Where a throwable came from, for the person and the log: its class, and the first frame
    // that is not the language's or Android's own (ours, or Google's). A release build has
    // renamed most of what is in a frame, so the class and line are what to look for in
    // `adb logcat -s ThreadbearPush:W`, which has the whole trace.
    private fun whereFrom(e: Throwable): String {
        val frames = e.stackTrace
        val frame = frames.firstOrNull { f -> SYSTEM_PACKAGES.none { f.className.startsWith(it) } } ?: frames.firstOrNull()
        val at = if (frame == null) "" else " at ${frame.className.substringAfterLast('.')}.${frame.methodName} (${frame.fileName?.take(24) ?: "unknown"}:${frame.lineNumber})"
        return "${e.javaClass.simpleName}$at"
    }

    // The scan went wrong somewhere our own code did not expect, so it is said in words the
    // person can read and send on, not whatever the exception's own message happens to be (a null
    // inside Google's code says "Attempt to invoke virtual method ... getClass() on a null
    // object reference", which names nothing).
    private fun scanBroke(invoke: Invoke, step: String, e: Throwable) {
        Log.w(TAG, "the code scanner failed to $step, on the ${Thread.currentThread().name} thread", e)
        try {
            invoke.reject("The scanner could not $step (${whereFrom(e)}). You can paste the link instead.")
        } catch (again: Throwable) {
            Log.w(TAG, "and the page could not be told", again)
        }
    }

    // Opens Google's code scanner for a QR code, for the pairing screen's "Scan the
    // code". Without Google Play services, or with its scanner not yet fetched, it fails
    // with words that say which, and the page leaves the paste box.
    @Command
    fun scan(invoke: Invoke) {
        try {
            GmsBarcodeScanning.getClient(activity, scannerOptions()).startScan()
                .addOnSuccessListener { barcode ->
                    try {
                        val answer = JSObject()
                        answer.put("text", barcode.rawValue ?: "")
                        invoke.resolve(answer)
                    } catch (e: Throwable) {
                        scanBroke(invoke, "read the code", e)
                    }
                }
                .addOnCanceledListener { cancelled(invoke) }
                .addOnFailureListener { e ->
                    Log.w(TAG, "the code scanner failed: ${e.javaClass.simpleName} ${(e as? MlKitException)?.errorCode ?: ""}")
                    if ((e as? MlKitException)?.errorCode == MlKitException.CODE_SCANNER_CANCELLED) cancelled(invoke)
                    else invoke.reject(scanFailure(e))
                }
        } catch (e: Throwable) {
            scanBroke(invoke, "start", e)
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
