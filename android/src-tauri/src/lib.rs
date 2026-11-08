// Threadbear for Android: the website (web/) in a window of its own, and
// nothing else. The page does the work. It talks to the user's Convex
// deployment, which it is told about by the link that pairs it
// (web/src/pairing.ts), and it learns of that link from the deep-link plugin,
// which opens the app for a `threadbear://pair` link (the QR code in the
// computer app's Settings, Phone and browser).
//
// A link reaches the page two ways, so one missing does not leave the app
// deaf: the plugin's own event (`deep-link://new-url`, which the page listens
// for), and `pairing-link`, which this file sends itself when the plugin hands
// it a link. Either gives the page the same list of addresses.

use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

// The page says what it could reach, for whoever reads `adb logcat` (the
// emulator check in CI does). A few words: never a link and never a token.
#[tauri::command]
fn page_note(note: String) {
    let short: String = note.chars().take(120).collect();
    eprintln!("threadbear page: {short}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![page_note])
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                // How many, not what: the address carries a token
                eprintln!("threadbear: {} link(s) opened the app", urls.len());
                let _ = handle.emit("pairing-link", urls);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Threadbear could not start");
}
