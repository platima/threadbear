// The page may call these three (permissions/default.toml), and the Kotlin plugin
// in android/ answers them.
const COMMANDS: &[&str] = &["status", "register", "scan"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
