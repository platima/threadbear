package com.tinkerware.threadbear.push

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import org.json.JSONObject
import java.io.IOException

const val TAG = "ThreadbearPush"

/**
 * Starts Firebase from the project's google-services.json, which the build puts
 * in this plugin's assets (docs/android.md). The usual way, Google's Gradle
 * plugin, would mean editing the Gradle project Tauri makes; reading the file
 * here does the same without. A build with no file has no Firebase, and the
 * rest of the app does not mind.
 */
object PushFirebase {
    private const val FILE = "google-services.json"

    fun configured(context: Context): Boolean =
        try {
            context.applicationContext.assets.open(FILE).close()
            true
        } catch (e: IOException) {
            false
        }

    @Synchronized
    fun ready(context: Context): Boolean {
        val app = context.applicationContext
        if (FirebaseApp.getApps(app).isNotEmpty()) return true
        val options = optionsFor(app) ?: return false
        FirebaseApp.initializeApp(app, options)
        return true
    }

    private fun optionsFor(context: Context): FirebaseOptions? =
        try {
            val root = JSONObject(context.assets.open(FILE).bufferedReader().use { it.readText() })
            val project = root.getJSONObject("project_info")
            val clients = root.getJSONArray("client")
            // The entry made for this app's package name
            var found: JSONObject? = null
            for (i in 0 until clients.length()) {
                val client = clients.getJSONObject(i)
                val name = client.getJSONObject("client_info").getJSONObject("android_client_info").getString("package_name")
                if (name == context.packageName) found = client
            }
            if (found == null) {
                Log.w(TAG, "google-services.json has no app for ${context.packageName}")
                null
            } else {
                FirebaseOptions.Builder()
                    .setApplicationId(found.getJSONObject("client_info").getString("mobilesdk_app_id"))
                    .setApiKey(found.getJSONArray("api_key").getJSONObject(0).getString("current_key"))
                    .setProjectId(project.getString("project_id"))
                    .setGcmSenderId(project.getString("project_number"))
                    .build()
            }
        } catch (e: Exception) {
            Log.w(TAG, "google-services.json could not be read: ${e.javaClass.simpleName}")
            null
        }
}
