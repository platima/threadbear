// The window's page is served from the bridge on http://127.0.0.1, which Tauri treats
// as a remote origin. Since Tauri 2.11.1 a remote origin can reach the app's own
// commands only through a permission its capability grants ("Enforce ACL checks for IPC
// requests from remote origins even when no `AppManifest` is configured"), so the five
// commands the page calls are declared here and granted in capabilities/default.json
// (allow-get-exit-on-close and the rest). Without this every call is refused with
// "Command ... not allowed by ACL" before the Rust runs: the Start the runner button
// did nothing, and Settings never showed an Exit on close box.
//
// The list must match tauri::generate_handler! in src/lib.rs, and the permissions in the
// capability must name each of them (underscores become hyphens).
const COMMANDS: &[&str] = &["get_exit_on_close", "set_exit_on_close", "runner_setup", "start_runner", "open_claude_login"];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
