package com.tinkerware.threadbear.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives what the push relay sends through Firebase, with the app open or not.
 * The relay's message is data only: `e` is the notification sealed with this
 * phone's key (PushSeal), `threadId` says which thread. If it cannot be
 * opened, the stand-in the relay would show anyway is shown. What is logged is
 * whether it worked, never the words.
 */
class ThreadbearMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        super.onCreate()
        PushFirebase.ready(this)
    }

    override fun onNewToken(token: String) {
        // The page registers the new one with its backend the next time it opens
        Log.i(TAG, "the Firebase token changed")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val sealed = message.data["e"]
        val threadId = message.data["threadId"].orEmpty()
        val opened = sealed?.let { PushSeal.open(it, PushKey.get(this)) }
        Log.i(TAG, "a message came: ${if (sealed == null) "not sealed" else if (opened != null) "sealed, opened" else "sealed, could not be opened"}")
        Alerts.show(this, opened?.title ?: "Threadbear", opened?.body ?: "A thread needs you", threadId)
    }
}
