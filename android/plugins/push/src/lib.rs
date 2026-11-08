// Notifications for the Android app, through Firebase Cloud Messaging.
//
// The work is in Kotlin (android/): it starts Firebase, asks for the
// notification permission, makes the phone's own push key and opens what the
// push relay sends (docs/android.md). This file is the thin Rust side that
// lets the page call it, as `plugin:threadbear-push|status` and
// `plugin:threadbear-push|register`. Anywhere but Android both answer that
// notifications are not available.
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

// The Kotlin package, and the class in it that extends Tauri's Plugin
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.tinkerware.threadbear.push";

pub struct Push<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Push<R> {
    // The Kotlin side answers when it has the permission and the token, which
    // can wait on the person, so the wait is not on one of the async runtime's
    // own threads.
    async fn call(&self, command: &'static str) -> Result<Value, String> {
        #[cfg(target_os = "android")]
        {
            let handle = self.handle.clone();
            let joined = tauri::async_runtime::spawn_blocking(move || {
                handle.run_mobile_plugin::<Value>(command, ()).map_err(|e| e.to_string())
            })
            .await;
            match joined {
                Ok(answer) => answer,
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = command;
            Ok(json!({ "available": false, "permission": "unsupported" }))
        }
    }
}

// Whether this build has Firebase set up, and whether notifications are allowed
#[tauri::command]
async fn status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    app.state::<Push<R>>().call("status").await
}

// Asks for the permission if need be, and gives the page this phone's Firebase
// token and its push key (base64 of 32 bytes), to register with its backend
#[tauri::command]
async fn register<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    app.state::<Push<R>>().call("register").await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("threadbear-push")
        .invoke_handler(tauri::generate_handler![status, register])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let push = Push { handle: api.register_android_plugin(PLUGIN_IDENTIFIER, "PushPlugin")? };
            #[cfg(not(target_os = "android"))]
            let push = {
                let _ = &api;
                Push::<R> { _runtime: std::marker::PhantomData }
            };
            app.manage(push);
            Ok(())
        })
        .build()
}
