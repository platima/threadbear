// The page may call these two (permissions/default.toml), and the Kotlin plugin
// in android/ answers them.
const COMMANDS: &[&str] = &["status", "register"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
