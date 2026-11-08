// Threadbear for Android: the website (web/) in a window of its own, and
// nothing else. The page does the work. It talks to the user's Convex
// deployment, which it is told about by the link that pairs it
// (web/src/pairing.ts), and it learns of that link from the deep-link plugin,
// which opens the app for a `threadbear://pair` link (the QR code in the
// computer app's Settings, Phone and browser).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .run(tauri::generate_context!())
        .expect("Threadbear could not start");
}
