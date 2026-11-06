// The Windows shell around the desktop UI (docs/windows-port-plan.md). It does
// only what a web page can't: a window of its own, a tray icon that keeps the
// app running when the window is closed, one copy at a time, the window's place
// remembered, toasts, a folder picker and links that open in the browser.
//
// The UI talks to the runner through desktop/bridge/bridge.ts, a small Node
// server that holds the runner's token and the handshake. This starts it on a
// loopback port of this user's own, with a key of its own for the launch, and
// points the window at the address it prints.
//
// The port is the same every time, because the window keeps its saved state
// (theme, the update check's off switch, the tour being done) under the address
// it is served from. Only when something else is using the port does the bridge
// pick another, and that run starts without the saved state.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

// The running bridge. Its standard input stays open for as long as this program
// lives: the bridge ends itself when that pipe closes, which Windows does for
// us if this program is killed or crashes (bridge.ts, THREADBEAR_BRIDGE_WATCH_STDIN).
struct Bridge(Mutex<Option<Child>>);

// How long to wait for the bridge to say it is ready.
const BRIDGE_READY: Duration = Duration::from_secs(20);

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
// --start, --stop, --uninstall, --status, --dry-run, or none to install and
// start the task), waits, and gives back its exit code and what it printed.
// The script sits at runner/scripts beside the desktop folder, in the repo and
// in the installed layout alike. The task's name is the script's business: this
// never spells it out.
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

// What `--runner` may be followed by. Anything else is refused: the script
// would otherwise ignore it and go on to install and start the task.
const RUNNER_FLAGS: [&str; 6] = ["--installed", "--start", "--stop", "--uninstall", "--status", "--dry-run"];

fn unknown_runner_flag(rest: &[String]) -> Option<&String> {
    rest.iter().find(|a| !RUNNER_FLAGS.contains(&a.as_str()))
}

// Writing to the terminal that started this program. It is a program with no
// console of its own (it is a window program), so it joins its parent's, and
// writes to the redirected output when there is one. When nothing started it
// from a terminal (an installer, a shortcut) the text goes nowhere, as before.
// The two functions are declared here, in kernel32, rather than pulled in from
// a crate, so the dependencies stay as they are.
#[cfg(windows)]
mod console {
    use std::fs::OpenOptions;
    use std::io::Write;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
        fn GetStdHandle(std_handle: u32) -> isize;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;

    pub fn print(text: &str) {
        // SAFETY: plain system calls, with no pointers.
        let handle = unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS); // fails, harmlessly, when there is no parent console
            GetStdHandle(STD_OUTPUT_HANDLE)
        };
        if handle != 0 && handle != -1 {
            // Output was sent to a file or a pipe, or Windows has pointed it at the console.
            let mut out = std::io::stdout();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
        } else if let Ok(mut con) = OpenOptions::new().write(true).open("CONOUT$") {
            let _ = con.write_all(text.as_bytes());
        }
    }
}
#[cfg(not(windows))]
mod console {
    pub fn print(text: &str) {
        print!("{text}");
    }
}

// `Threadbear.exe --runner <what>`: the same script, for an installer or a
// terminal. Prints what the script said to the terminal and exits with its
// code instead of opening the window.
fn runner_command(rest: &[String]) -> ! {
    if let Some(bad) = unknown_runner_flag(rest) {
        console::print(&format!(
            "Threadbear.exe --runner: {bad} is not an option.\nOptions: {}. With none, the runner is installed and started at sign-in.\n",
            RUNNER_FLAGS.join(" ")
        ));
        std::process::exit(2);
    }
    let (code, text) = match runner_script(rest) {
        Ok(done) => done,
        Err(why) => (1, why),
    };
    if !text.is_empty() {
        console::print(&format!("{text}\n"));
    }
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
        // The installer stops the task while it upgrades the app, and nothing
        // else brings it back before the next sign-in, so start it if it isn't running.
        let _ = runner_script(&["--start".to_string()]);
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

// This user's port for the bridge, in the range Windows hands out to programs
// as they ask (50000 to 59999, chosen from the user name so two people signed
// in to one PC each have their own). 0 is "any free port", for a run that must
// not share an address (THREADBEAR_DESKTOP_PORT=0). The bridge moves to a free
// port by itself if this one is taken.
fn port_for(user: &str) -> u16 {
    let mut hash: u32 = 0x811c_9dc5; // FNV-1a
    for b in user.to_lowercase().bytes() {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    50_000 + (hash % 10_000) as u16
}

fn bridge_port() -> u16 {
    if let Some(p) = std::env::var("THREADBEAR_DESKTOP_PORT").ok().and_then(|v| v.trim().parse::<u16>().ok()) {
        if p == 0 || p >= 1024 {
            return p;
        }
    }
    port_for(&std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default())
}

// Starts the bridge and waits for the line that gives its address. If it can't
// be started, stops before it says so, or is silent for too long, the error
// says what Node printed, so the person is not left with a window that never comes.
fn start_bridge(desktop: &Path) -> Result<(Child, String), String> {
    let mut cmd = Command::new(find_node());
    cmd.arg(desktop.join("bridge").join("bridge.ts"))
        .env("THREADBEAR_BRIDGE_PORT", bridge_port().to_string())
        .env("THREADBEAR_BRIDGE_FALLBACK", "random")
        .env("THREADBEAR_BRIDGE_WATCH_STDIN", "1")
        .env("THREADBEAR_DIST", desktop.join("dist"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Couldn't start Node to run Threadbear's bridge ({e}).\n\nNode 24 or later needs to be installed and on your PATH. \
             You can also set THREADBEAR_NODE to the full path of node.exe."
        )
    })?;
    let stdout = child.stdout.take().ok_or("The bridge gave no output.")?;
    let stderr = child.stderr.take().ok_or("The bridge gave no error output.")?;

    // What Node says on its error output, the last 4 KB of it, kept read so it never fills.
    let said = Arc::new(Mutex::new(String::new()));
    {
        let said = Arc::clone(&said);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut text = said.lock().unwrap();
                text.push_str(&line);
                text.push('\n');
                while text.len() > 4000 {
                    match text.find('\n') {
                        Some(i) => {
                            text.drain(..=i);
                        }
                        None => text.clear(),
                    }
                }
            }
        });
    }
    let said_so_far = move || {
        let text = said.lock().unwrap().trim().to_string();
        if text.is_empty() {
            String::new()
        } else {
            format!("\n\nNode said:\n{text}")
        }
    };

    // The line with the address, or the end of the output without one. Output
    // goes on being read afterwards so the bridge never meets a closed pipe.
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut told = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !told {
                if let Some(url) = line.strip_prefix("READY ") {
                    told = true;
                    let _ = tx.send(Some(url.trim().to_string()));
                }
            }
        }
        if !told {
            let _ = tx.send(None);
        }
    });
    match rx.recv_timeout(BRIDGE_READY) {
        Ok(Some(url)) => Ok((child, url)),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            std::thread::sleep(Duration::from_millis(200));
            Err(format!("Threadbear's bridge stopped before it was ready.{}", said_so_far()))
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("Threadbear's bridge did not start within {} seconds.{}", BRIDGE_READY.as_secs(), said_so_far()))
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// A start that can't go on is said in a window, then the program ends with a
// failing code. (It is a window program: without this the person would see
// nothing at all, and the release build aborts on a panic.)
fn fail_and_exit(app: &AppHandle, message: &str) {
    let handle = app.clone();
    app.dialog()
        .message(message.to_string())
        .title("Threadbear couldn't start")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

// If the bridge ends while the app is running, the window is of no use. Say so.
fn watch_bridge(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let state = app.state::<Bridge>();
        let mut guard = state.0.lock().unwrap();
        let Some(child) = guard.as_mut() else { return }; // taken when the app quit
        if let Ok(Some(status)) = child.try_wait() {
            guard.take();
            drop(guard);
            fail_and_exit(&app, &format!("The part of Threadbear that talks to the runner stopped ({status}). Start Threadbear again."));
            return;
        }
    });
}

// The window, the tray icon and the bridge behind them. Any error is a
// sentence for fail_and_exit.
fn start_ui(app: &mut tauri::App) -> Result<(), String> {
    let desktop = find_desktop_dir().ok_or("Couldn't find the desktop folder with bridge/bridge.ts in it. Set THREADBEAR_DESKTOP_DIR.")?;
    let (child, url) = start_bridge(&desktop)?;
    *app.state::<Bridge>().0.lock().unwrap() = Some(child);
    let address: tauri::Url = url.parse().map_err(|e| format!("The bridge gave an address that isn't one ({url}): {e}"))?;

    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(address))
        .title("Threadbear")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 420.0)
        // Without this the window takes pictures dropped on it for itself, and
        // the page's own drag and drop (pictures onto the message box) never
        // sees them. Tauri documents it as needed for HTML5 drag and drop on Windows.
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| format!("Couldn't open the window ({e}). Threadbear needs Microsoft's WebView2 runtime, which comes with Windows 11 and current Windows 10."))?;

    let build_err = |e: tauri::Error| format!("Couldn't set up the tray icon ({e}).");
    let show = MenuItem::with_id(app, "show", "Show Threadbear", true, None::<&str>).map_err(build_err)?;
    let runner = MenuItem::with_id(app, "runner", "Start the runner at sign-in...", true, None::<&str>).map_err(build_err)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(build_err)?;
    let menu = Menu::with_items(app, &[&show, &runner, &quit]).map_err(build_err)?;
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
    tray.build(app).map_err(build_err)?;

    // Offer the runner on the first run, or start it if it is set up but
    // stopped, off the main thread so the window is not held up by the check.
    let handle = app.handle().clone();
    std::thread::spawn(move || offer_runner(&handle, false));
    watch_bridge(app.handle().clone());
    Ok(())
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
            // A failure is shown, then the program ends. Returning it from here
            // instead would end in a panic that, in the release build, says nothing.
            if let Err(message) = start_ui(app) {
                fail_and_exit(app.handle(), &message);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_the_same_for_a_user_and_in_range() {
        assert_eq!(port_for("Owner"), port_for("owner"));
        for user in ["", "a", "Owner", "someone.else", "DOMAIN user"] {
            let p = port_for(user);
            assert!((50_000..60_000).contains(&p), "{user} gave {p}");
        }
        assert_ne!(port_for("alice"), port_for("bob"));
    }

    #[test]
    fn only_the_scripts_own_options_follow_runner() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(unknown_runner_flag(&args(&[])).is_none());
        assert!(unknown_runner_flag(&args(&["--status"])).is_none());
        assert!(unknown_runner_flag(&args(&["--start"])).is_none());
        assert!(unknown_runner_flag(&args(&["--dry-run", "--uninstall"])).is_none());
        assert_eq!(unknown_runner_flag(&args(&["--staus"])).map(String::as_str), Some("--staus"));
        assert_eq!(unknown_runner_flag(&args(&["--status", "now"])).map(String::as_str), Some("now"));
    }
}
