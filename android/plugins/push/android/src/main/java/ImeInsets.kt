package com.tinkerware.threadbear.push

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps the page above the on-screen keyboard (docs/android.md, "The keyboard").
 *
 * The app draws edge to edge, so Android no longer resizes the window for the keyboard, and
 * the WebView (139 and newer) takes it off its visual viewport only, never its layout
 * viewport. The page is as tall as its layout viewport, so its reply box sat behind the
 * keyboard and, once focused, the page panned up and the transcript went off the top.
 *
 * Here the activity's content view, which holds the WebView, is padded by the keyboard's
 * height, so the WebView ends where the keyboard starts and the page lays itself out in
 * what is left, as it did before Android 15.
 *
 * What goes on down to the WebView has the keyboard zeroed (it is padded for already, and
 * the WebView would take it off the viewport a second time) and, while the keyboard is up,
 * the navigation bar's bottom zeroed (the keyboard covers that bar, so the page's
 * env(safe-area-inset-bottom) must not pad for it again). Zeroed, not consumed, so the
 * WebView still hears when they change and keeps no padding from the last time. The status
 * bar and cutout insets go through as they were. Android's own guide to WebView and window
 * insets has this pattern ("The Zeroing approach").
 */
object ImeInsets {
    // The kind of activity the app has (the first one this was asked about), so that a
    // Google one that opens in this process is left as it is
    private var ours: Class<*>? = null
    private var watching = false

    /** From PushPlugin.load. Fits the activity that is up, and any the app opens later. */
    fun install(activity: Activity) {
        // Before Android 11 the keyboard is not an inset the app can read: those keep what they had
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (ours == null) ours = activity.javaClass
        fit(activity)
        if (watching) return
        watching = true
        // The plugin is loaded once per process, but the app can be backed out of and opened
        // again in the same process with a new activity (the one given to the plugin is then
        // finished), so each one is fitted as it resumes
        activity.application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(a: Activity) = fit(a)
            override fun onActivityCreated(a: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })
    }

    private fun fit(a: Activity) {
        if (a.javaClass != ours) return
        a.runOnUiThread {
            val content = a.findViewById<View>(android.R.id.content) ?: return@runOnUiThread
            // Said outright, rather than left to Android's choice between resizing and panning
            a.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
                val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                if (view.paddingBottom != keyboard) {
                    view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, keyboard)
                }
                if (keyboard == 0) {
                    insets
                } else {
                    val bar = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
                    WindowInsetsCompat.Builder(insets)
                        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                        .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(bar.left, bar.top, bar.right, 0))
                        .build()
                }
            }
            // The insets may have been handed out before this listener was there
            ViewCompat.requestApplyInsets(content)
        }
    }
}
