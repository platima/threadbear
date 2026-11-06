// The Windows shell around the desktop UI (docs/windows-port-plan.md). It does
// only what a web page can't: a window of its own, a tray icon that keeps the
// app running when the window is closed, one copy at a time, the window's place
// remembered, toasts, a folder picker and links that open in the browser.
//
// The UI talks to the runner through desktop/bridge/bridge.ts, a small Node
// server that holds the runner's token and the handshake. This starts it on a
// free loopback port, with a key of its own for the launch, and points the
// window at the address it prints.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct Bridge(Mutex<Option<Child>>);

// The folder with bridge/bridge.ts in it: THREADBEAR_DESKTOP_DIR, or the one
// this program was built in (up from the exe, which is under src-tauri/target).
fn find_desktop_dir() -> Option<PathBuf> {
    let has_bridge = |p: &Path| p.join("bridge").join("bridge.ts").exists();
    if let Ok(d) = std::env::var("THREADBEAR_DESKTOP_DIR") {
        let p = PathBuf::from(d);
        if has_bridge(&p) {
            return Some(p);
        }
    }
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..8 {
        if has_bridge(&dir) {
            return Some(dir);
        }
        let nested = dir.join("desktop");
        if has_bridge(&nested) {
            return Some(nested);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

// Starts the bridge and waits for the line that gives its address.
fn start_bridge(desktop: &Path) -> Result<(Child, String), String> {
    let mut cmd = Command::new("node");
    cmd.arg(desktop.join("bridge").join("bridge.ts"))
        .env("THREADBEAR_BRIDGE_PORT", "0")
        .env("THREADBEAR_DIST", desktop.join("dist"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start Node to run the bridge ({e}). Node 24 or later needs to be on the PATH."))?;
    let stdout = child.stdout.take().ok_or("The bridge gave no output.")?;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(Ok(line)) = lines.next() {
        if let Some(url) = line.strip_prefix("READY ") {
            // Keep reading so the bridge never meets a closed pipe.
            std::thread::spawn(move || for _ in lines {});
            return Ok((child, url.trim().to_string()));
        }
    }
    let _ = child.kill();
    Err("The bridge stopped before it was ready.".into())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Bridge(Mutex::new(None)))
        .setup(|app| {
            let desktop = find_desktop_dir()
                .ok_or("Couldn't find the desktop folder with bridge/bridge.ts in it. Set THREADBEAR_DESKTOP_DIR.")?;
            let (child, url) = start_bridge(&desktop)?;
            *app.state::<Bridge>().0.lock().unwrap() = Some(child);
            let address: tauri::Url = url
                .parse()
                .map_err(|e| format!("The bridge gave an address that isn't one ({url}): {e}"))?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(address))
                .title("Threadbear")
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 420.0)
                .build()?;

            let show = MenuItem::with_id(app, "show", "Show Threadbear", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Threadbear")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // Closing the window keeps the app in the tray; Quit in its menu ends it.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't build the app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = app.state::<Bridge>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
