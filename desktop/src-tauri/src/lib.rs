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
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct Bridge(Mutex<Option<Child>>);

// The Node to run things with: THREADBEAR_NODE, else the one the installer put
// beside this program (node/node.exe), else whatever `node` is on the PATH.
fn find_node() -> PathBuf {
    if let Ok(n) = std::env::var("THREADBEAR_NODE") {
        let p = PathBuf::from(n);
        if p.exists() {
            return p;
        }
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        let bundled = dir.join("node").join("node.exe");
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

// Runs the runner's install-windows.mjs with these arguments (--installed,
// --stop, --uninstall, --status, --dry-run, or none to install and start the
// task), waits, and gives back its exit code and what it printed. The script
// sits at runner/scripts beside the desktop folder, in the repo and in the
// installed layout alike.
fn runner_script(args: &[String]) -> Result<(i32, String), String> {
    let desktop = find_desktop_dir().ok_or("Couldn't find the desktop folder.")?;
    let script = desktop
        .parent()
        .ok_or("The desktop folder has no parent.")?
        .join("runner")
        .join("scripts")
        .join("install-windows.mjs");
    if !script.exists() {
        return Err(format!("Couldn't find {}.", script.display()));
    }
    let mut cmd = Command::new(find_node());
    cmd.arg(&script).args(args).stdin(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Couldn't start Node ({e})."))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(1), text.trim().to_string()))
}

// `Threadbear.exe --runner <what>`: the same script, for an installer or a
// terminal. Exits with the script's code instead of opening the window.
fn runner_command(rest: &[String]) -> ! {
    let code = match runner_script(rest) {
        Ok((code, _)) => code,
        Err(_) => 1,
    };
    std::process::exit(code)
}

fn declined_marker() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Threadbear").join("declined-runner-task"))
}

// The runner is a Task Scheduler task for this user, and installing the app
// does not make one (an MSI or a portable zip can't do it per user), so the app
// offers it the first time it opens and never again once declined. The tray
// menu offers it whenever someone asks (`asked`).
fn offer_runner(app: &AppHandle, asked: bool) {
    // Tests and scripted runs set this so no dialog opens on a real desktop.
    if !asked && std::env::var_os("THREADBEAR_NO_RUNNER_OFFER").is_some() {
        return;
    }
    let installed = matches!(runner_script(&["--installed".to_string()]), Ok((0, _)));
    if installed {
        if asked {
            app.dialog()
                .message("The runner already starts when you sign in.")
                .title("Threadbear")
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        return;
    }
    if !asked && declined_marker().map(|m| m.exists()).unwrap_or(false) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(
            "Threadbear's runner does the work in the background. Start it when you sign in to Windows?\n\n\
             This adds a Task Scheduler task for your account (no admin rights) and puts the tb command on your PATH. \
             Threadbear.exe --runner --uninstall removes both.",
        )
        .title("Set up the runner?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Set up".into(), "No thanks".into()))
        .show(move |yes| {
            if !yes {
                if let Some(m) = declined_marker() {
                    if let Some(dir) = m.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(m, "declined\n");
                }
                return;
            }
            if let Some(m) = declined_marker() {
                let _ = std::fs::remove_file(m);
            }
            match runner_script(&[]) {
                Ok((0, _)) => {}
                Ok((_, text)) | Err(text) => {
                    handle
                        .dialog()
                        .message(format!("The runner could not be set up.\n\n{text}"))
                        .title("Threadbear")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        });
}

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
    let mut cmd = Command::new(find_node());
    cmd.arg(desktop.join("bridge").join("bridge.ts"))
        .env("THREADBEAR_BRIDGE_PORT", "0")
        .env("THREADBEAR_DIST", desktop.join("dist"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        format!("Couldn't start Node to run the bridge ({e}). Run from the repo, Node 24 or later needs to be on the PATH.")
    })?;
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `--runner ...` is a command, not the app: run it and leave.
    if args.first().map(String::as_str) == Some("--runner") {
        runner_command(&args[1..]);
    }
    let quit_only = args.iter().any(|a| a == "--quit");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch with --quit is an installer asking this copy to
            // end (it has no window to close); any other second launch just
            // brings the window forward.
            if args.iter().any(|a| a == "--quit") {
                app.exit(0);
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Bridge(Mutex::new(None)))
        .setup(move |app| {
            // --quit with nothing running: there is nothing to end, so do not
            // start. (With a copy running, the plugin hands this launch's
            // arguments to it and this process never gets here.)
            if quit_only {
                app.handle().exit(0);
                return Ok(());
            }
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
            let runner = MenuItem::with_id(app, "runner", "Start the runner at sign-in...", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &runner, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Threadbear")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "runner" => {
                        let app = app.clone();
                        std::thread::spawn(move || offer_runner(&app, true));
                    }
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

            // Offer the runner on the first run, off the main thread so the
            // window is not held up by the check.
            let handle = app.handle().clone();
            std::thread::spawn(move || offer_runner(&handle, false));
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
