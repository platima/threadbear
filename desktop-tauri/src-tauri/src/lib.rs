// The shell around the desktop UI, for Windows and for Linux
// (docs/windows-port-plan.md). It does only what a web page can't: a window of its own, a tray icon that keeps the
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

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

// The running bridge. Its standard input stays open for as long as this program
// lives: the bridge ends itself when that pipe closes, which Windows does for
// us if this program is killed or crashes (bridge.ts, THREADBEAR_BRIDGE_WATCH_STDIN),
// and which quitting does on purpose (end_in_order).
struct Bridge(Mutex<Option<Child>>);

// Set when this copy is ended by a second launch with `--quit`, which is how the installer
// asks for the files to be let go. That quit cannot wait for the bridge to wind itself up:
// the installer is about to replace the files its node.exe has open, so the bridge is killed
// at once, as it was before the quit gave it time.
struct QuitForSetup(AtomicBool);

// Whether closing the window may leave the app running in the tray: on Windows
// once the tray icon is made. Not on Linux, where making an indicator does not mean
// the desktop shows it (GNOME shows none without an extension), so there closing the
// window ends the app, as it always did.
struct TrayReady(AtomicBool);

// Set once this copy has started its bridge and window, so it is cleaned up when it
// exits however it exits. (A copy that only gets `--quit` to hand on never sets it,
// and so leaves a runner alone.)
struct UiStarted(AtomicBool);

// How long to wait for the bridge to say it is ready.
const BRIDGE_READY: Duration = Duration::from_secs(20);

// How long quitting gives the bridge to end itself once its input is closed, counted from
// the moment it is closed, before it is killed. A bridge that is stuck must not hold the
// quit up for long.
const BRIDGE_STOP_WAIT: Duration = Duration::from_secs(3);

// How long quitting gives the runner step (when the runner is one that runs only while the
// app is open), counted from when the step begins, which is beside the bridge's wait and not
// after it. The step is two runs of the set-up script, each its own Node, and 10 seconds is for
// both together: a Node still running when it is up is ended (run_until).
const RUNNER_STOP_WAIT: Duration = Duration::from_secs(10);

// How much longer than its own time the quit waits for the runner step's thread to say it is
// done: ending a Node and reaping it takes a moment. Only a step that did not keep to its time
// (it should always) is given up on, once this has passed as well.
const RUNNER_STEP_GRACE: Duration = Duration::from_secs(2);

// How often the waits in quitting look at what they wait for. std has no wait with a limit.
const POLL: Duration = Duration::from_millis(25);

// What the program is called where a person types it (in messages), and the
// name of the Node it brings, the script that sets the runner up, and the
// words for the sign-in step, which differ between Windows and Linux.
fn program_name() -> &'static str {
    if cfg!(windows) {
        "Threadbear.exe"
    } else {
        "threadbear-desktop"
    }
}

fn bundled_node(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("node").join("node.exe")
    } else {
        dir.join("node").join("bin").join("node")
    }
}

fn runner_script_name() -> &'static str {
    if cfg!(windows) {
        "install-windows.mjs"
    } else {
        "install-linux.mjs"
    }
}

// The Node to run things with, and where the choice came from (shell.log says both, so
// a node.exe on the PC can be told from the one this program started): THREADBEAR_NODE,
// else the one the installer put beside this program (node/node.exe, or node/bin/node on
// Linux), else whatever `node` is on the PATH.
fn node_choice() -> (PathBuf, &'static str) {
    if let Ok(n) = std::env::var("THREADBEAR_NODE") {
        let p = PathBuf::from(n);
        if p.exists() {
            return (p, "THREADBEAR_NODE");
        }
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        let bundled = bundled_node(&dir);
        if bundled.exists() {
            return (bundled, "the one beside the app");
        }
    }
    (PathBuf::from("node"), "the PATH")
}

fn find_node() -> PathBuf {
    node_choice().0
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

// Runs the runner's install-windows.mjs (install-linux.mjs on Linux) with these
// arguments (--installed, --start, --stop, --uninstall, --status, --dry-run,
// or none to install and start the task or service), waits, and gives back its
// exit code and what it printed. The script sits at runner/scripts beside the
// desktop folder, in the repo and in the installed layout alike. The task's
// name is the script's business: this never spells it out.
fn runner_script(args: &[String]) -> Result<(i32, String), String> {
    let mut cmd = script_command(args)?;
    let out = cmd.output().map_err(|e| format!("Couldn't start Node ({e})."))?;
    Ok((out.status.code().unwrap_or(1), joined_text(&out.stdout, &out.stderr)))
}

// Node with the set-up script and these arguments, ready to start, for runner_script (which
// waits for it as long as it takes) and runner_script_until (which does not).
fn script_command(args: &[String]) -> Result<Command, String> {
    let desktop = find_desktop_dir().ok_or("Couldn't find the desktop folder.")?;
    let script = desktop
        .parent()
        .ok_or("The desktop folder has no parent.")?
        .join("runner")
        .join("scripts")
        .join(runner_script_name());
    if !script.exists() {
        return Err(format!("Couldn't find {}.", script.display()));
    }
    let mut cmd = Command::new(find_node());
    cmd.arg(&script).args(args).stdin(Stdio::null());
    hide_window(&mut cmd);
    Ok(cmd)
}

// What a program printed, then what it printed on its error output, as one trimmed text.
fn joined_text(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(stdout).to_string();
    text.push_str(&String::from_utf8_lossy(stderr));
    text.trim().to_string()
}

// What running a program until a deadline came to.
#[derive(Debug, PartialEq, Eq)]
enum Ran {
    // It finished by itself in time: its exit code, and what it printed.
    Finished(i32, String),
    // It was still running at the deadline, and was ended; this is its process id.
    EndedAtDeadline(u32),
}

// Everything that comes out of one of a program's pipes, on a thread of its own so the program
// never stalls on a full one. It arrives once the pipe closes, which is when the program has
// gone (and anything it started that holds the pipe too).
fn read_all(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        let _ = tx.send(bytes);
    });
    rx
}

// How long what a program printed is waited for once it has gone, at least, when its time is up.
const OUTPUT_GRACE: Duration = Duration::from_millis(200);

// Starts `cmd` with no input and its output piped, for finish_by.
fn start(cmd: &mut Command) -> std::io::Result<Child> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.spawn()
}

// Runs `cmd` and waits for it until `deadline` (the time starting it takes counts), keeping
// the process it started: see finish_by.
fn run_until(cmd: &mut Command, deadline: Instant) -> std::io::Result<Ran> {
    finish_by(start(cmd)?, deadline)
}

// Waits for a program this started (with piped output, `start`) until `deadline`. One still
// running when the time is up is killed by its own handle and waited for (so the file it runs
// from is let go), and the answer is its process id. What it started itself is not reached.
// Its output is read as it goes, and once it has gone, no later than the deadline (a helper of
// its that kept the pipe would otherwise hold this up), so a program that finished in time and
// left such a helper gives its code and whatever it had printed by then.
fn finish_by(mut child: Child, deadline: Instant) -> std::io::Result<Ran> {
    let pid = child.id();
    let stdout = read_all(child.stdout.take());
    let stderr = read_all(child.stderr.take());
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let read_until = deadline.max(Instant::now() + OUTPUT_GRACE);
                let said = stdout.recv_timeout(read_until.saturating_duration_since(Instant::now())).unwrap_or_default();
                let complained = stderr.recv_timeout(read_until.saturating_duration_since(Instant::now())).unwrap_or_default();
                return Ok(Ran::Finished(status.code().unwrap_or(1), joined_text(&said, &complained)));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(Ran::EndedAtDeadline(pid));
            }
            Err(e) => {
                // It cannot be asked about, so it is ended rather than left.
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        }
    }
}

// runner_script for the steps of quitting: the same script and the same words, but run until
// `deadline`, when the Node it started is ended (run_until).
fn runner_script_until(args: &[String], deadline: Instant) -> Result<Ran, String> {
    if Instant::now() >= deadline {
        return Err("the step's time was already up".to_string());
    }
    let mut cmd = script_command(args)?;
    run_until(&mut cmd, deadline).map_err(|e| format!("Couldn't run Node ({e})."))
}

// What `--runner` may be followed by. Anything else is refused: the script
// would otherwise ignore it and go on to install and start the task.
const RUNNER_FLAGS: [&str; 8] = ["--installed", "--start", "--stop", "--uninstall", "--status", "--dry-run", "--on-demand", "--mode"];

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
            "{} --runner: {bad} is not an option.\nOptions: {}. With none, the runner is installed and started at sign-in.\n",
            program_name(),
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

// Where this program keeps its own small notes: %LOCALAPPDATA%\Threadbear on
// Windows, $XDG_STATE_HOME (else ~/.local/state)/Threadbear on Linux.
fn state_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
    } else if let Some(state) = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        PathBuf::from(state)
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".local").join("state")
    };
    Some(base.join("Threadbear"))
}

// Where a "no thanks" to the runner is remembered.
fn declined_marker() -> Option<PathBuf> {
    state_dir().map(|d| d.join("declined-runner-task"))
}

fn remember_declined() {
    if let Some(m) = declined_marker() {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(m, "declined\n");
    }
}

fn forget_declined() {
    if let Some(m) = declined_marker() {
        let _ = std::fs::remove_file(m);
    }
}

// Where the "Exit on close" choice is kept: a file that is there when it is on.
// It is read when the window is closed, so it lives where this program can read
// it at once, not in the page's own saved state.
fn exit_on_close_marker() -> Option<PathBuf> {
    state_dir().map(|d| d.join("exit-on-close"))
}

fn exit_on_close_on() -> bool {
    exit_on_close_marker().map(|m| m.exists()).unwrap_or(false)
}

// The page's "Exit on close" box (Settings, This app): whether closing the
// window ends the app, instead of leaving it in the tray. Off unless asked for.
// None on Linux, where closing the window always ends the app (see TrayReady), so
// the page has no box to show.
#[tauri::command]
fn get_exit_on_close() -> Option<bool> {
    if cfg!(windows) {
        Some(exit_on_close_on())
    } else {
        None
    }
}

#[tauri::command]
fn set_exit_on_close(on: bool) -> Result<(), String> {
    let marker = exit_on_close_marker().ok_or("Couldn't find the folder to keep the choice in.")?;
    if on {
        if let Some(dir) = marker.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&marker, "on\n").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// The page's sign-in buttons, under a failed turn whose login ran out: a terminal
// window running one of two fixed Claude Code commands, and nothing else (what is
// run is chosen here, not by the page). `config_dir` is the login's own folder when
// it isn't the default one; it goes to the command as CLAUDE_CONFIG_DIR.
#[tauri::command]
fn open_claude_login(kind: String, config_dir: Option<String>) -> Result<(), String> {
    let args: &[&str] = match kind.as_str() {
        "login" => &["auth", "login"],
        "setup-token" => &["setup-token"],
        _ => return Err("That isn't one of the sign-in commands.".to_string()),
    };
    let dir = match config_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_dir() => Some(d.to_string()),
        Some(_) => return Err("That login's folder isn't there.".to_string()),
        None => None,
    };
    open_in_terminal("claude", args, dir.as_deref())
}

// A console window of its own, left open (cmd /K) so the person can read what the
// command says: `claude setup-token` prints a token there.
#[cfg(windows)]
fn open_in_terminal(program: &str, args: &[&str], config_dir: Option<&str>) -> Result<(), String> {
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/C", "start", "Threadbear: sign in", "cmd.exe", "/K", program]).args(args);
    if let Some(d) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", d);
    }
    // The cmd that runs `start` stays hidden; `start` opens the visible window.
    hide_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| format!("Couldn't open a terminal ({e})."))
}

// Whichever terminal this desktop has, tried in turn, running the command and then
// waiting for Enter so what it printed can be read.
#[cfg(not(windows))]
fn open_in_terminal(program: &str, args: &[&str], config_dir: Option<&str>) -> Result<(), String> {
    let terminals: [(&str, &[&str]); 5] = [("x-terminal-emulator", &["-e"]), ("gnome-terminal", &["--"]), ("konsole", &["-e"]), ("xfce4-terminal", &["-x"]), ("xterm", &["-e"])];
    for (terminal, flags) in terminals {
        let mut cmd = Command::new(terminal);
        cmd.args(flags)
            .arg("sh")
            .arg("-c")
            .arg("\"$@\"; printf '\\nPress Enter to close this window. '; read _")
            .arg("sh")
            .arg(program)
            .args(args);
        if let Some(d) = config_dir {
            cmd.env("CLAUDE_CONFIG_DIR", d);
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err(format!("No terminal was found to open. Run it yourself: {} {}", program, args.join(" ")))
}

// How the runner is set up, by the script's own `--mode`: starting at sign-in,
// only when something starts it (this app, when it opens), or not at all.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum RunnerMode {
    None,
    SignIn,
    OnDemand,
}

fn parse_runner_mode(text: &str) -> RunnerMode {
    match text.trim() {
        "sign-in" => RunnerMode::SignIn,
        "on-demand" => RunnerMode::OnDemand,
        _ => RunnerMode::None,
    }
}

// The mode as the page and shell.log say it.
fn mode_word(mode: RunnerMode) -> &'static str {
    match mode {
        RunnerMode::SignIn => "sign-in",
        RunnerMode::OnDemand => "on-demand",
        RunnerMode::None => "none",
    }
}

// What a run of the script with --mode says the mode is, or why it could not say.
fn mode_from(ran: Result<Ran, String>) -> Result<RunnerMode, String> {
    match ran {
        Ok(Ran::Finished(0, text)) => Ok(parse_runner_mode(&text)),
        Ok(Ran::Finished(code, text)) => Err(format!("the script said {code}: {}", first_line(&text))),
        Ok(Ran::EndedAtDeadline(pid)) => Err(ended_at_deadline("mode check", pid)),
        Err(why) => Err(why),
    }
}

// What shell.log says of a Node that quitting ended because the runner step's time was up.
fn ended_at_deadline(what: &str, pid: u32) -> String {
    format!("the {what}'s Node (pid {pid}) was still running when the step's time was up, so it was ended")
}

// What the script says the mode is, or why it could not say.
fn read_runner_mode() -> Result<RunnerMode, String> {
    mode_from(runner_script(&["--mode".to_string()]).map(|(code, text)| Ran::Finished(code, text)))
}

// If the script can't say, it is taken as no runner of ours: nothing is stopped
// on quit that this can't vouch for.
fn runner_mode() -> RunnerMode {
    read_runner_mode().unwrap_or(RunnerMode::None)
}

// How a run of the script is asked for in the steps of quitting: its arguments and the time
// by which it must be done (runner_script_until).
type AskScript<'a> = &'a dyn Fn(&[String], Instant) -> Result<Ran, String>;

// A runner that was set up to run only while this app is open ends with it. A
// runner that starts at sign-in is left running, as it always was. What it did,
// in a line for shell.log. Both runs of the script, the mode and the stop, are held to the
// one `deadline`, and a Node still running at it is ended, so quitting leaves none behind.
fn stop_on_demand(ask: AskScript, deadline: Instant) -> String {
    match mode_from(ask(&["--mode".to_string()], deadline)) {
        Ok(RunnerMode::OnDemand) => match ask(&["--stop".to_string()], deadline) {
            Ok(Ran::Finished(code, text)) => format!("runner mode on-demand: stop script said {code}: {}", first_line(&text)),
            Ok(Ran::EndedAtDeadline(pid)) => format!("runner mode on-demand: {} (the runner may still be running)", ended_at_deadline("stop script", pid)),
            Err(why) => format!("runner mode on-demand: the stop script could not be run: {}", first_line(&why)),
        },
        Ok(mode) => format!("runner mode {}: left running", mode_word(mode)),
        Err(why) => format!("runner mode unknown ({why}): left running"),
    }
}

fn stop_runner_if_on_demand(deadline: Instant) -> String {
    stop_on_demand(&runner_script_until, deadline)
}

// What the app tells the person when it offers to set the runner up.
fn offer_text() -> String {
    if cfg!(windows) {
        format!(
            "Threadbear's runner does the work in the background. Start it when you sign in to Windows?\n\n\
             This adds a Task Scheduler task for your account (no admin rights) and puts the tb command on your PATH. \
             {} --runner --uninstall removes both.",
            program_name()
        )
    } else {
        format!(
            "Threadbear's runner does the work in the background. Start it when you log in?\n\n\
             This adds a systemd user service for your account (no root) and puts the tb command in ~/.local/bin. \
             {} --runner --uninstall removes both.",
            program_name()
        )
    }
}

// What the app tells the person when it offers a runner that starts only while
// the app is open, which is the other way to have one.
fn on_demand_text() -> String {
    if cfg!(windows) {
        format!(
            "Start the runner only while Threadbear is open instead?\n\n\
             Threadbear does nothing without its runner. This way it starts when you open Threadbear and stops when you quit it; \
             closing the window leaves it running in the tray. Nothing starts when you sign in.\n\n\
             This adds a Task Scheduler task for your account with no sign-in trigger (no admin rights) and puts the tb command on your PATH. \
             {} --runner --uninstall removes both.",
            program_name()
        )
    } else {
        format!(
            "Start the runner only while Threadbear is open instead?\n\n\
             Threadbear does nothing without its runner. This way it starts when you open Threadbear and stops when you quit it; \
             closing the window quits it. Nothing starts when you log in.\n\n\
             This adds a systemd user service for your account (no root), which is not enabled, and puts the tb command in ~/.local/bin. \
             {} --runner --uninstall removes both.",
            program_name()
        )
    }
}

// Runs the setup script with these arguments and says in a window if it could not.
fn install_runner(handle: &AppHandle, args: &[String]) {
    match runner_script(args) {
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
}

// Offers the runner that starts at sign-in. Declined on the first run (not
// `asked`), it goes on to offer the one that runs only while the app is open,
// and only when that is declined too is the "no thanks" remembered. Asked for from
// the tray, a "no thanks" changes nothing.
fn offer_sign_in(app: &AppHandle, asked: bool) {
    let handle = app.clone();
    app.dialog()
        .message(offer_text())
        .title("Set up the runner?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Set up".into(), "No thanks".into()))
        .show(move |yes| {
            if !yes {
                if !asked {
                    offer_on_demand(&handle, false);
                }
                return;
            }
            forget_declined();
            install_runner(&handle, &[]);
        });
}

// Offers the runner that starts when the app opens and stops when it quits. A
// "no thanks" is remembered unless this was asked for from the tray or the page.
fn offer_on_demand(app: &AppHandle, asked: bool) {
    let handle = app.clone();
    app.dialog()
        .message(on_demand_text())
        .title("Run the runner while Threadbear is open?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Only while open".into(), "No thanks".into()))
        .show(move |yes| {
            if !yes {
                if !asked {
                    remember_declined();
                }
                return;
            }
            forget_declined();
            install_runner(&handle, &["--on-demand".to_string()]);
        });
}

// The runner is a Task Scheduler task (a systemd user service on Linux) for this
// user, and installing the app does not make one (an MSI, a portable zip or a
// tarball can't do it per user), so the app offers it the first time it opens
// and never again once declined. The tray menu offers it whenever someone asks
// (`asked`).
fn offer_runner(app: &AppHandle, asked: bool) {
    // Tests and scripted runs set this so no dialog opens on a real desktop.
    if !asked && std::env::var_os("THREADBEAR_NO_RUNNER_OFFER").is_some() {
        return;
    }
    let mode = runner_mode();
    if mode != RunnerMode::None {
        // The installer stops the task while it upgrades the app, and nothing
        // else brings it back before the next sign-in (or, for a runner that
        // runs only while the app is open, at all), so start it if it isn't running.
        // A failure is said in a window when someone asked, and only logged otherwise.
        let started = start_registered(app, asked);
        if asked && started {
            if mode == RunnerMode::OnDemand {
                // Only while the app is open now: switch it to sign-in if that is what was asked.
                offer_sign_in(app, true);
            } else {
                app.dialog()
                    .message("The runner already starts when you sign in.")
                    .title("Threadbear")
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
        }
        return;
    }
    if !asked && declined_marker().map(|m| m.exists()).unwrap_or(false) {
        return;
    }
    offer_sign_in(app, asked);
}

// Starts the runner task if it is set up (it also counts as started if it was already
// running). A failure is said in a window when `tell` (someone asked for the start),
// and only logged otherwise. Whether it started.
fn start_registered(app: &AppHandle, tell: bool) -> bool {
    match runner_script(&["--start".to_string()]) {
        Ok((0, _)) => {
            log_shell("start the runner task: started");
            true
        }
        Ok((_, text)) | Err(text) => {
            log_shell(&format!("start the runner task: failed: {text}"));
            if tell {
                app.dialog()
                    .message(format!("The runner could not be started.\n\n{text}"))
                    .title("Threadbear")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            } else {
                eprintln!("The runner could not be started: {text}");
            }
            false
        }
    }
}

// The tray's "only while Threadbear is open" item.
fn offer_runner_while_open(app: &AppHandle) {
    if runner_mode() == RunnerMode::OnDemand {
        if start_registered(app, true) {
            app.dialog()
                .message("The runner already starts when Threadbear opens, and stops when you quit it.")
                .title("Threadbear")
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        return;
    }
    offer_on_demand(app, true);
}

// One line in shell.log, in the folder this program keeps its notes in, so what it did
// about the runner and the bridge can be read afterwards. The program has no console, and
// when the page's Start the runner button once did nothing there was nothing to look at.
// The time is seconds since 1970. The file starts over past 200 KB (the old one is kept
// as shell.log.old), and what is written to it is the runner's start and set-up, the
// Node and process id the bridge was started with, and the steps of quitting (how the
// bridge ended, what was done about the runner): no text from the page and no thread.
fn log_shell(line: &str) {
    let Some(dir) = state_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("shell.log");
    if std::fs::metadata(&file).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("shell.log.old"));
    }
    if let Ok(mut out) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        use std::io::Write;
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(out, "{secs} {line}");
    }
}

// How the runner is set up, for the page's Start the runner button, which asks before it
// does anything: "sign-in", "on-demand", or "none" (no task of ours, or the script could
// not say). With none the page offers the two ways itself, in its own window, so the
// choice cannot be left waiting in a window of the shell's that nobody sees.
#[tauri::command]
async fn runner_setup() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mode = runner_mode();
        log_shell(&format!("runner setup asked: {mode:?}"));
        mode_word(mode).to_string()
    })
    .await
    .map_err(|e| format!("The shell could not look at the runner ({e})."))
}

// What the page may ask `start_runner` for, as the arguments for the runner's install
// script. The page names one of three ways and the shell decides what is run: "start" an
// existing task, or set the runner up "on-demand" (only while the app is open) or at
// "sign-in", which sets it up and starts it. Anything else is refused.
fn start_args(how: &str) -> Option<Vec<String>> {
    match how {
        "start" => Some(vec!["--start".to_string()]),
        "on-demand" => Some(vec!["--on-demand".to_string()]),
        "sign-in" => Some(Vec::new()),
        _ => None,
    }
}

// The page's "Start the runner" button, after it has asked how the runner is set up
// (`runner_setup`) and, with none set up, which way the person chose. It answers when
// that is done, so the page can show it is working until then and not take a second
// click; a failure comes back as words for the page.
#[tauri::command]
async fn start_runner(how: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || start_runner_now(&how))
        .await
        .map_err(|e| format!("The runner could not be started ({e})."))?
}

// The first line the script printed, which for --start says what it did: "Started the
// runner.", "The runner is already running.", "The runner task is turned off in Task
// Scheduler, so it was not started." or "... not installed, so nothing was started." (the
// script exits 0 for all four, and the page shows the line so none of them is silent).
fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

// What the page is told when the runner is set up and started by `how`: the script's own line
// for a start, and a plain sentence for a set-up (whose output is a longer account).
fn started_note(how: &str, text: &str) -> String {
    let line = first_line(text);
    if how == "start" {
        if line.is_empty() {
            "Started the runner.".to_string()
        } else {
            line
        }
    } else {
        "The runner is set up and starting.".to_string()
    }
}

fn start_runner_now(how: &str) -> Result<String, String> {
    let Some(args) = start_args(how) else {
        return Err(format!("The runner cannot be started by \"{how}\"."));
    };
    if how != "start" {
        forget_declined();
    }
    log_shell(&format!("start the runner, {how}: running the install script"));
    match runner_script(&args) {
        Ok((0, text)) => {
            let note = started_note(how, &text);
            log_shell(&format!("start the runner, {how}: done: {note}"));
            Ok(note)
        }
        Ok((code, text)) => {
            log_shell(&format!("start the runner, {how}: the script said {code}: {text}"));
            Err(format!("The runner could not be {}.\n\n{text}", if how == "start" { "started" } else { "set up" }))
        }
        Err(text) => {
            log_shell(&format!("start the runner, {how}: {text}"));
            Err(format!("The runner could not be {}.\n\n{text}", if how == "start" { "started" } else { "set up" }))
        }
    }
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
    let (node, node_from) = node_choice();
    let mut cmd = Command::new(&node);
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
             You can also set THREADBEAR_NODE to the full path of {}.",
            if cfg!(windows) { "node.exe" } else { "node" }
        )
    })?;
    // Which node.exe is the bridge's, for when one is found holding a file during an
    // upgrade. (The address it prints has the launch's key in it, so that is never written down.)
    log_shell(&format!("bridge started: pid {}, node {} ({node_from}), shell pid {}", child.id(), node.display(), std::process::id()));
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

// How the bridge came to be gone when it was stopped.
#[derive(Debug, PartialEq, Eq)]
enum BridgeEnd {
    // It had ended before it was asked to.
    Already(ExitStatus),
    // It ended itself, as it does when its input is closed.
    Closed(ExitStatus),
    // It was still there when the wait was over, and was killed.
    Killed,
    // It was killed without being given any time, as the quit came from a second launch
    // with --quit.
    KilledAtOnce,
}

impl BridgeEnd {
    // For shell.log.
    fn describe(&self, wait: Duration) -> String {
        match self {
            BridgeEnd::Already(status) => format!("had ended before quit asked it to ({status})"),
            BridgeEnd::Closed(status) => format!("ended itself once its input was closed ({status})"),
            BridgeEnd::Killed => format!("was still running {} after its input was closed, so it was killed", seconds(wait)),
            BridgeEnd::KilledAtOnce => "was killed at once, as the quit came from a second launch with --quit (the installer is about to replace its files)".to_string(),
        }
    }
}

// A length of time as shell.log says it: "3 seconds", "1 second", "0.7 seconds".
fn seconds(time: Duration) -> String {
    if time.subsec_millis() == 0 {
        let whole = time.as_secs();
        format!("{whole} second{}", if whole == 1 { "" } else { "s" })
    } else {
        format!("{:.1} seconds", time.as_secs_f64())
    }
}

// How quitting stops the bridge.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum BridgeStop {
    // Close its input, which it takes as the app being gone, and give it this long, counted
    // from then, to end by itself.
    Gracefully(Duration),
    // Kill it now.
    AtOnce,
}

// A quit that the installer asked for kills the bridge at once; any other gives it time.
fn bridge_stop(for_setup: bool) -> BridgeStop {
    if for_setup {
        BridgeStop::AtOnce
    } else {
        BridgeStop::Gracefully(BRIDGE_STOP_WAIT)
    }
}

// The first step of ending the bridge the way it is built to end: its standard input is
// closed, which it takes as the app being gone, and it runs its own exit handler (which
// ends the Terminal's shells) and goes. Gives how it ended when it had already, otherwise
// None, and poll_bridge, called until it answers, is the second step.
fn close_bridge_input(child: &mut Child) -> Option<BridgeEnd> {
    if let Ok(Some(status)) = child.try_wait() {
        return Some(BridgeEnd::Already(status));
    }
    // Dropping the handle closes the pipe, and the bridge sees the end of its input.
    drop(child.stdin.take());
    None
}

// The second step, one look at a time: has the bridge ended? If so, how. If it is still there
// once `deadline` has passed, it is killed (and waited for), so a stuck bridge cannot hold the
// quit up. None means it is still within its time. The child has been waited for whenever this
// answers. A look at a time, because the runner step goes on beside it (end_in_order).
fn poll_bridge(child: &mut Child, deadline: Instant) -> Option<BridgeEnd> {
    match child.try_wait() {
        Ok(Some(status)) => Some(BridgeEnd::Closed(status)),
        Ok(None) if Instant::now() < deadline => None,
        // Out of time, or it cannot be asked: either way, end it.
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Some(BridgeEnd::Killed)
        }
    }
}

// Kills the bridge now, and waits for it to be gone.
fn kill_bridge(child: &mut Child) -> BridgeEnd {
    if let Ok(Some(status)) = child.try_wait() {
        return BridgeEnd::Already(status);
    }
    let _ = child.kill();
    let _ = child.wait();
    BridgeEnd::KilledAtOnce
}

// The steps of the app's end, with the waits overlapping instead of adding up: the bridge is
// stopped first (killed now, or its input closed and its time started), and the runner step is
// started at once, on a thread of its own, within `runner_wait` counted from its start. Then
// both are watched together, each against its own clock: the bridge is killed once its time is
// up, counted from when its input was closed, whatever the runner step is still doing, and the
// step is given its deadline, so that it ends what it started when that comes (run_until). So the
// app is gone within the longer of the two, not both, and the runner's own processes start while
// the bridge winds up. A step that did not keep to its deadline is given up on a little later
// (RUNNER_STEP_GRACE) and quit goes on without it. `runner` is None when this copy never got as
// far as a window (`--quit` with nothing running), which has nothing to stop. Each step is a
// line said to `say`, which is shell.log, in the order the steps came to an end.
fn end_in_order<R>(bridge: Option<&mut Child>, how: BridgeStop, runner: Option<R>, runner_wait: Duration, say: &dyn Fn(&str))
where
    R: FnOnce(Instant) -> String + Send + 'static,
{
    let mut waiting: Option<(&mut Child, u32, Instant, Duration)> = None;
    if let Some(child) = bridge {
        let pid = child.id();
        match how {
            BridgeStop::AtOnce => {
                let end = kill_bridge(child);
                say(&format!("quit: bridge pid {pid} {}", end.describe(Duration::ZERO)));
            }
            BridgeStop::Gracefully(wait) => match close_bridge_input(child) {
                Some(end) => say(&format!("quit: bridge pid {pid} {}", end.describe(wait))),
                None => waiting = Some((child, pid, Instant::now() + wait, wait)),
            },
        }
    } else if runner.is_some() {
        // Its end was seen by watch_bridge, which took the child and said so in the log.
        say("quit: no bridge to stop");
    }
    // A runner set up to run only while the app is open ends with it, whichever way the
    // app ends (a failed bridge has taken its child already, which is why this goes by
    // the window having started). A runner that starts at sign-in is left alone.
    let mut step = runner.map(|run| {
        let deadline = Instant::now() + runner_wait;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            // Nobody is listening once the step has been given up on, which is fine.
            let _ = tx.send(run(deadline));
        });
        (rx, deadline + RUNNER_STEP_GRACE)
    });
    while step.is_some() || waiting.is_some() {
        if let Some((rx, give_up_at)) = &step {
            // Waiting for the step's answer is also what lets the bridge be looked at in turn.
            let line = match rx.recv_timeout(POLL) {
                Ok(what) => Some(format!("quit: {what}")),
                Err(mpsc::RecvTimeoutError::Disconnected) => Some("quit: the runner step failed".to_string()),
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= *give_up_at => Some(format!(
                    "quit: the runner step was still going {} after it began, so quit went on without it (an on-demand runner may still be running)",
                    seconds(runner_wait + RUNNER_STEP_GRACE)
                )),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
            };
            if let Some(line) = line {
                say(&line);
                step = None;
            }
        } else {
            std::thread::sleep(POLL);
        }
        if let Some((child, pid, deadline, wait)) = &mut waiting {
            if let Some(end) = poll_bridge(child, *deadline) {
                say(&format!("quit: bridge pid {pid} {}", end.describe(*wait)));
                waiting = None;
            }
        }
    }
}

// What the app does as it ends, whichever way it ends (end_in_order), in shell.log.
fn end_everything(app: &AppHandle) {
    let started = app.state::<UiStarted>().0.load(Ordering::Relaxed);
    let for_setup = app.state::<QuitForSetup>().0.load(Ordering::Relaxed);
    let mut bridge = app.state::<Bridge>().0.lock().unwrap().take();
    end_in_order(bridge.as_mut(), bridge_stop(for_setup), started.then_some(stop_runner_if_on_demand), RUNNER_STOP_WAIT, &log_shell);
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
            let pid = child.id();
            guard.take();
            drop(guard);
            log_shell(&format!("the bridge (pid {pid}) ended by itself: {status}"));
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
    app.state::<UiStarted>().0.store(true, Ordering::Relaxed);
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
        .map_err(|e| {
            if cfg!(windows) {
                format!("Couldn't open the window ({e}). Threadbear needs Microsoft's WebView2 runtime, which comes with Windows 11.")
            } else {
                format!("Couldn't open the window ({e}). Threadbear needs WebKitGTK 4.1 (libwebkit2gtk-4.1) and a desktop session to show it in.")
            }
        })?;

    // On Linux the tray is a nicety, not part of the app: GNOME shows none unless an
    // extension adds one, so a tray that can't be made doesn't stop the window.
    match build_tray(app) {
        Err(why) if cfg!(windows) => return Err(why),
        Err(why) => eprintln!("{why}"),
        // Only on Windows does a tray icon that was made mean one that is shown (see TrayReady).
        Ok(()) => app.state::<TrayReady>().0.store(cfg!(windows), Ordering::Relaxed),
    }

    // Offer the runner on the first run, or start it if it is set up but
    // stopped, off the main thread so the window is not held up by the check.
    let handle = app.handle().clone();
    std::thread::spawn(move || offer_runner(&handle, false));
    watch_bridge(app.handle().clone());
    Ok(())
}

// The tray icon and its menu: show the window, set up the runner (at sign-in, or
// only while the app is open), quit.
fn build_tray(app: &mut tauri::App) -> Result<(), String> {
    let build_err = |e: tauri::Error| format!("Couldn't set up the tray icon ({e}).");
    let show = MenuItem::with_id(app, "show", "Show Threadbear", true, None::<&str>).map_err(build_err)?;
    let runner = MenuItem::with_id(app, "runner", "Start the runner at sign-in...", true, None::<&str>).map_err(build_err)?;
    let runner_open = MenuItem::with_id(app, "runner_open", "Start the runner only while Threadbear is open...", true, None::<&str>).map_err(build_err)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(build_err)?;
    let menu = Menu::with_items(app, &[&show, &runner, &runner_open, &quit]).map_err(build_err)?;
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
            "runner_open" => {
                let app = app.clone();
                std::thread::spawn(move || offer_runner_while_open(&app));
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
            // brings the window forward. The installer is about to replace the
            // files, so the end it gets does not wait for anything (QuitForSetup).
            if args.iter().any(|a| a == "--quit") {
                if let Some(flag) = app.try_state::<QuitForSetup>() {
                    flag.0.store(true, Ordering::Relaxed);
                }
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
        .manage(TrayReady(AtomicBool::new(false)))
        .manage(UiStarted(AtomicBool::new(false)))
        .manage(QuitForSetup(AtomicBool::new(false)))
        // What the page may ask of the shell besides the plugins' own commands
        // (capabilities/default.json): the "Exit on close" box and "Start the runner".
        .invoke_handler(tauri::generate_handler![get_exit_on_close, set_exit_on_close, runner_setup, start_runner, open_claude_login])
        .setup(move |app| {
            // --quit with nothing running: there is nothing to end, so do not
            // start. (With a copy running, the plugin hands this launch's
            // arguments to it and this process never gets here.)
            if quit_only {
                app.handle().exit(0);
                return Ok(());
            }
            // One line so shell.log shows this copy started: a missing line for a click
            // then means the click never reached the shell, and not that the log is off.
            log_shell(&format!("Threadbear {} started", env!("CARGO_PKG_VERSION")));
            // A failure is shown, then the program ends. Returning it from here
            // instead would end in a panic that, in the release build, says nothing.
            if let Err(message) = start_ui(app) {
                fail_and_exit(app.handle(), &message);
            }
            Ok(())
        })
        // On Windows, closing the window keeps the app in the tray; Quit in its menu ends it.
        // Not when the person turned on "Exit on close" (Settings, This app). On Linux closing
        // it always ends the app (a tray may not be shown), and a runner that starts at login
        // goes on as its service.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let tray = window.app_handle().state::<TrayReady>().0.load(Ordering::Relaxed);
                if tray && !exit_on_close_on() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't build the app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            end_everything(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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
    fn the_scripts_mode_is_read_and_anything_else_is_no_runner() {
        assert_eq!(parse_runner_mode("sign-in"), RunnerMode::SignIn);
        assert_eq!(parse_runner_mode("on-demand\n"), RunnerMode::OnDemand);
        assert_eq!(parse_runner_mode("  none "), RunnerMode::None);
        // Whatever it can't read is no runner of ours, so nothing is stopped on quit by guesswork.
        assert_eq!(parse_runner_mode(""), RunnerMode::None);
        assert_eq!(parse_runner_mode("sign-in on-demand"), RunnerMode::None);
        assert_eq!(parse_runner_mode("ERROR: something"), RunnerMode::None);
    }

    #[test]
    fn the_page_may_ask_for_three_ways_to_start_the_runner_and_nothing_else() {
        assert_eq!(start_args("start"), Some(vec!["--start".to_string()]));
        assert_eq!(start_args("on-demand"), Some(vec!["--on-demand".to_string()]));
        // Setting it up at sign-in is the script with no option.
        assert_eq!(start_args("sign-in"), Some(Vec::new()));
        // The page can't have the script do any of its other things.
        for other in ["", "--uninstall", "--stop", "uninstall", "start ", "Start"] {
            assert_eq!(start_args(other), None, "{other:?} should be refused");
        }
    }

    #[test]
    fn a_start_tells_the_page_what_the_script_said() {
        assert_eq!(started_note("start", "Started the runner.\n"), "Started the runner.");
        assert_eq!(started_note("start", "\n  The runner is already running.  \nmore"), "The runner is already running.");
        assert_eq!(started_note("start", ""), "Started the runner.");
        // A set-up prints a longer account; the page is told one sentence.
        assert_eq!(started_note("on-demand", "Register the task...\nStarted the runner.\n"), "The runner is set up and starting.");
        assert_eq!(started_note("sign-in", ""), "The runner is set up and starting.");
        assert_eq!(first_line("\n\n  one  \ntwo"), "one");
    }

    #[test]
    fn the_exit_on_close_choice_is_kept_beside_the_declined_note() {
        let (a, b) = (exit_on_close_marker(), declined_marker());
        if let (Some(a), Some(b)) = (a, b) {
            assert_eq!(a.parent(), b.parent());
            assert_ne!(a, b);
        }
    }

    #[test]
    fn only_the_scripts_own_options_follow_runner() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(unknown_runner_flag(&args(&[])).is_none());
        assert!(unknown_runner_flag(&args(&["--status"])).is_none());
        assert!(unknown_runner_flag(&args(&["--start"])).is_none());
        assert!(unknown_runner_flag(&args(&["--dry-run", "--uninstall"])).is_none());
        assert!(unknown_runner_flag(&args(&["--on-demand"])).is_none());
        assert!(unknown_runner_flag(&args(&["--mode"])).is_none());
        assert_eq!(unknown_runner_flag(&args(&["--staus"])).map(String::as_str), Some("--staus"));
        assert_eq!(unknown_runner_flag(&args(&["--status", "now"])).map(String::as_str), Some("now"));
    }

    #[test]
    fn the_modes_word_reads_back_as_the_same_mode() {
        for mode in [RunnerMode::SignIn, RunnerMode::OnDemand, RunnerMode::None] {
            assert_eq!(parse_runner_mode(mode_word(mode)), mode);
        }
    }

    // The bridge stand-ins: copies of Node in a folder of the test's own, standing in for
    // the bridge with the input start_bridge gives it (a pipe this side holds). They are
    // ended by the handle the test holds, in drop, however the test went, and by nothing
    // else: never a search for a process, and each stand-in also ends itself after two minutes.

    // The bridge's way of ending (bridge.ts): it exits when its input does, and its exit
    // handler, which is where the real one ends the Terminal's shells, leaves a note in the file
    // it is given.
    const ENDS_WITH_ITS_INPUT: &str = "const fs=require('node:fs');process.on('exit',()=>fs.writeFileSync(process.argv[1],'bye'));process.stdin.on('end',()=>process.exit(0));process.stdin.resume();setTimeout(()=>process.exit(3),120000)";
    // A bridge that never looks at its input.
    const IGNORES_ITS_INPUT: &str = "setTimeout(()=>process.exit(3),120000)";
    // A bridge that has gone before it is asked.
    const IS_ALREADY_GONE: &str = "process.exit(7)";

    // The runner step's Node (install-windows.mjs --mode and --stop), as stand-ins. One that keeps
    // on running: it leaves a beat in the marker file every 50 ms, so a test can tell if it is still
    // alive, and it ends itself after 20 seconds.
    const BEATS_UNTIL_ENDED: &str = "const fs=require('node:fs');const beat=()=>fs.writeFileSync(process.argv[1],String(Date.now()));beat();setInterval(beat,50);setTimeout(()=>process.exit(3),20000)";
    // One that says something on each output and is done.
    const SAYS_AND_EXITS_WITH_5: &str = "process.stdout.write('said');process.stderr.write(' and complained');process.exitCode=5";
    // One that says more than a pipe holds, which it can only do if the output is being read as it goes.
    const SAYS_A_LOT: &str = "process.stdout.write('x'.repeat(3000000))";
    // One that is done at once but leaves a helper holding its output for 4 seconds (the helper
    // ends itself).
    const LEAVES_A_HELPER_HOLDING_ITS_OUTPUT: &str = "const h=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore','inherit','inherit']});h.unref()";

    // Where Node is: THREADBEAR_NODE, or the first one on the PATH.
    fn real_node() -> PathBuf {
        let found = find_node();
        if found.is_file() {
            return found;
        }
        let name = format!("node{}", std::env::consts::EXE_SUFFIX);
        let path = std::env::var_os("PATH").expect("these tests need Node: put it on the PATH or set THREADBEAR_NODE");
        let on_path = std::env::split_paths(&path).map(|dir| dir.join(&name)).find(|p| p.is_file());
        on_path.expect("these tests need Node: put it on the PATH or set THREADBEAR_NODE")
    }

    // A folder of the test's own with a copy of Node in it, so the process that is started and
    // ended is never anyone else's node.exe. It is removed when the test is over.
    struct Folder {
        dir: PathBuf,
    }

    impl Folder {
        fn new(name: &str) -> Folder {
            let dir = std::env::temp_dir().join(format!("threadbear-stop-bridge-test-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            // Dropped, and so removed, if the copy fails.
            let folder = Folder { dir };
            std::fs::copy(real_node(), folder.exe()).unwrap();
            // Started once, and left to end by itself, before any test's clock starts: Windows
            // looks over a new executable the first time it runs, which can take seconds.
            let mut warm_up = Command::new(folder.exe());
            warm_up.arg("-e").arg("0").stdout(Stdio::null()).stderr(Stdio::null());
            hide_window(&mut warm_up);
            let _ = warm_up.status();
            folder
        }

        fn exe(&self) -> PathBuf {
            self.dir.join(format!("standin-node{}", std::env::consts::EXE_SUFFIX))
        }

        // The note a stand-in leaves (or the beat it keeps up).
        fn marker(&self) -> PathBuf {
            self.dir.join("marker")
        }

        // The copy of Node running `script`, which is given the marker's path to write to.
        fn command(&self, script: &str) -> Command {
            let mut cmd = Command::new(self.exe());
            cmd.arg("-e").arg(script).arg(self.marker());
            hide_window(&mut cmd);
            cmd
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            // Windows lets go of the exe a moment after the process is gone (and a stand-in's own
            // helper, which one test leaves behind to end by itself, holds it a little longer).
            for _ in 0..50 {
                if !self.dir.exists() || std::fs::remove_dir_all(&self.dir).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    struct Standin {
        child: Child,
        folder: Folder,
    }

    impl Standin {
        fn start(name: &str, script: &str) -> Standin {
            let folder = Folder::new(name);
            let mut cmd = folder.command(script);
            cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
            let child = cmd.spawn().unwrap_or_else(|e| panic!("couldn't start the stand-in: {e}"));
            Standin { child, folder }
        }

        // The note the stand-in's exit handler leaves.
        fn marker(&self) -> PathBuf {
            self.folder.marker()
        }
    }

    impl Drop for Standin {
        // Ended by the handle that started it, however the test went. (The folder goes after.)
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    // Both steps of stopping the bridge gracefully, as end_in_order does them when there is
    // nothing else to do beside.
    fn stop_bridge(child: &mut Child, wait: Duration) -> BridgeEnd {
        let deadline = Instant::now() + wait;
        close_bridge_input(child).unwrap_or_else(|| loop {
            if let Some(end) = poll_bridge(child, deadline) {
                break end;
            }
            std::thread::sleep(Duration::from_millis(10));
        })
    }

    #[test]
    fn a_bridge_is_stopped_by_closing_its_input_and_gets_to_run_its_exit_handler() {
        let mut bridge = Standin::start("closes", ENDS_WITH_ITS_INPUT);
        // Far longer than it needs, since this proves the way it went and not how fast. A bridge
        // killed outright (as quit once did) would end as Killed and leave no note.
        let end = stop_bridge(&mut bridge.child, Duration::from_secs(60));
        assert!(matches!(end, BridgeEnd::Closed(_)), "{end:?}");
        assert!(bridge.marker().exists(), "it was gone, but its exit handler did not run");
        assert!(matches!(bridge.child.try_wait(), Ok(Some(_))), "it is still running");
    }

    #[test]
    fn a_bridge_that_ignores_its_input_is_killed_when_the_wait_is_over() {
        let mut bridge = Standin::start("ignores", IGNORES_ITS_INPUT);
        let wait = Duration::from_millis(700);
        let started = Instant::now();
        let end = stop_bridge(&mut bridge.child, wait);
        let took = started.elapsed();
        assert_eq!(end, BridgeEnd::Killed);
        assert!(took >= wait, "it was killed before the wait was over, after {took:?}");
        assert!(took < wait + Duration::from_secs(20), "it was not bounded, {took:?}");
        assert!(matches!(bridge.child.try_wait(), Ok(Some(_))), "it is still running");
        assert!(!bridge.marker().exists());
    }

    #[test]
    fn a_bridge_that_had_already_ended_is_said_to_have() {
        let mut bridge = Standin::start("gone", IS_ALREADY_GONE);
        let status = bridge.child.wait().unwrap();
        assert_eq!(stop_bridge(&mut bridge.child, Duration::from_secs(5)), BridgeEnd::Already(status));
    }

    // The whole end, in order (end_in_order), with the lines it says to shell.log.

    #[test]
    fn only_the_installers_quit_kills_the_bridge_at_once() {
        assert_eq!(bridge_stop(true), BridgeStop::AtOnce);
        assert_eq!(bridge_stop(false), BridgeStop::Gracefully(BRIDGE_STOP_WAIT));
    }

    #[test]
    fn a_quit_for_the_installer_kills_the_bridge_without_waiting_for_it() {
        let mut bridge = Standin::start("at-once", ENDS_WITH_ITS_INPUT);
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        let started = Instant::now();
        end_in_order(Some(&mut bridge.child), BridgeStop::AtOnce, None::<fn(Instant) -> String>, RUNNER_STOP_WAIT, &say);
        let took = started.elapsed();
        assert!(matches!(bridge.child.try_wait(), Ok(Some(_))), "it is still running");
        // Given no time, it never got to its exit handler, as when quit killed it outright.
        assert!(!bridge.marker().exists(), "its exit handler ran, so it was given time");
        assert!(took < Duration::from_secs(2), "it waited, {took:?}");
        let lines = lines.into_inner();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("killed at once"), "{lines:?}");
    }

    #[test]
    fn the_runner_step_starts_while_the_bridge_is_still_winding_up_and_the_waits_overlap() {
        let mut bridge = Standin::start("overlap", IGNORES_ITS_INPUT);
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        let origin = Instant::now();
        let runner_began = Arc::new(Mutex::new(None::<Duration>));
        let began = runner_began.clone();
        let runner = move |_deadline: Instant| {
            *began.lock().unwrap() = Some(origin.elapsed());
            std::thread::sleep(Duration::from_millis(300));
            "runner stopped".to_string()
        };
        let wait = Duration::from_secs(2);
        end_in_order(Some(&mut bridge.child), BridgeStop::Gracefully(wait), Some(runner), Duration::from_secs(30), &say);
        let total = origin.elapsed();
        let began = runner_began.lock().unwrap().expect("the runner step never ran");
        // One after the other it would start only once the bridge's two seconds were up.
        assert!(began < Duration::from_secs(1), "the runner step waited for the bridge, starting after {began:?}");
        // The bridge's time is counted from when its input was closed, not from after the runner step.
        assert!(total >= wait, "the bridge was killed early, after {total:?}");
        assert!(total < wait + Duration::from_secs(1), "the waits added up, {total:?}");
        assert!(matches!(bridge.child.try_wait(), Ok(Some(_))), "it is still running");
        let lines = lines.into_inner();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0], "quit: runner stopped");
        assert!(lines[1].contains("was still running 2 seconds after its input was closed, so it was killed"), "{lines:?}");
    }

    #[test]
    fn a_bridge_that_ends_during_the_runner_step_is_said_to_have_ended_itself_when_it_did() {
        let mut bridge = Standin::start("during", ENDS_WITH_ITS_INPUT);
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        let runner = |_deadline: Instant| {
            std::thread::sleep(Duration::from_millis(1500));
            "runner stopped".to_string()
        };
        end_in_order(Some(&mut bridge.child), BridgeStop::Gracefully(Duration::from_secs(60)), Some(runner), Duration::from_secs(30), &say);
        assert!(bridge.marker().exists(), "it was gone, but its exit handler did not run");
        let lines = lines.into_inner();
        assert_eq!(lines.len(), 2, "{lines:?}");
        // Said as it happened: the bridge went in a moment, well before the runner step was done.
        assert!(lines[0].contains("ended itself once its input was closed"), "{lines:?}");
        assert_eq!(lines[1], "quit: runner stopped");
    }

    #[test]
    fn with_no_bridge_the_runner_is_still_stopped_and_with_nothing_started_nothing_is_said() {
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        end_in_order(None, bridge_stop(false), Some(|_deadline: Instant| "runner stopped".to_string()), Duration::from_secs(30), &say);
        assert_eq!(lines.borrow().as_slice(), ["quit: no bridge to stop", "quit: runner stopped"]);
        lines.borrow_mut().clear();
        // A copy that never got as far as a window (`--quit` with nothing running).
        end_in_order(None, bridge_stop(false), None::<fn(Instant) -> String>, Duration::from_secs(30), &say);
        assert!(lines.borrow().is_empty(), "{:?}", lines.borrow());
    }

    // The runner step's own programs: ended by the handle that started them at the deadline.
    // Each test starts the program first and only then takes its deadline from the clock: how long
    // Windows takes to start a copy of Node varies by seconds when many are started at once (as
    // the tests do), and that is not what these are about.

    fn started(folder: &Folder, script: &str) -> Child {
        start(&mut folder.command(script)).expect("couldn't start the stand-in")
    }

    #[test]
    fn a_program_still_running_at_the_deadline_is_ended_by_the_handle_that_started_it() {
        let folder = Folder::new("late");
        let child = started(&folder, BEATS_UNTIL_ENDED);
        let wait = Duration::from_secs(2);
        let began = Instant::now();
        let ran = finish_by(child, began + wait).unwrap();
        let took = began.elapsed();
        let Ran::EndedAtDeadline(pid) = ran else { panic!("it was not ended at the deadline: {ran:?}") };
        assert_ne!(pid, 0);
        assert!(took >= wait, "it was ended early, after {took:?}");
        assert!(took < wait + Duration::from_secs(1), "it was not ended at the deadline, but after {took:?}");
        // Gone, and not just given up on: its beat has stopped.
        let beat = std::fs::read_to_string(folder.marker()).expect("it never ran");
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(std::fs::read_to_string(folder.marker()).unwrap(), beat, "it is still running");
    }

    #[test]
    fn a_program_that_finishes_in_time_is_not_ended_and_gives_its_code_and_what_it_said() {
        let folder = Folder::new("quick");
        let mut cmd = folder.command(SAYS_AND_EXITS_WITH_5);
        let ran = run_until(&mut cmd, Instant::now() + Duration::from_secs(60)).unwrap();
        // What it printed, then what it complained of, as the script's output is read everywhere else.
        assert_eq!(ran, Ran::Finished(5, "said and complained".to_string()));
    }

    #[test]
    fn a_program_that_says_more_than_a_pipe_holds_is_not_held_up_by_it() {
        let folder = Folder::new("a-lot");
        let mut cmd = folder.command(SAYS_A_LOT);
        match run_until(&mut cmd, Instant::now() + Duration::from_secs(60)).unwrap() {
            Ran::Finished(0, text) => assert_eq!(text.len(), 3_000_000),
            other => panic!("it did not finish by itself: {other:?}"),
        }
    }

    #[test]
    fn a_helper_left_holding_the_output_does_not_hold_the_step_past_its_time() {
        let folder = Folder::new("helper");
        let child = started(&folder, LEAVES_A_HELPER_HOLDING_ITS_OUTPUT);
        let wait = Duration::from_millis(1500);
        let began = Instant::now();
        let ran = finish_by(child, began + wait).unwrap();
        let took = began.elapsed();
        // The program itself was done, so it is not said to have been ended.
        assert!(matches!(ran, Ran::Finished(0, _)), "{ran:?}");
        // The helper holds the pipe for 4 seconds; the step gave up on its output at its time.
        assert!(took < Duration::from_secs(3), "it waited for the helper, {took:?}");
    }

    #[test]
    fn a_program_whose_time_was_up_by_the_time_it_started_is_ended_too() {
        // The time starting it took counts: with the deadline already past, it is started and ended.
        let folder = Folder::new("past");
        let mut cmd = folder.command(BEATS_UNTIL_ENDED);
        let ran = run_until(&mut cmd, Instant::now()).unwrap();
        assert!(matches!(ran, Ran::EndedAtDeadline(pid) if pid != 0), "{ran:?}");
    }

    #[test]
    fn the_runner_step_that_runs_past_its_time_has_its_program_ended_and_quit_goes_on() {
        let folder = Folder::new("step-late");
        let child = started(&folder, BEATS_UNTIL_ENDED);
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        let wait = Duration::from_secs(2);
        let step = move |deadline: Instant| match finish_by(child, deadline) {
            Ok(Ran::EndedAtDeadline(pid)) => format!("ended at the deadline: pid {pid}"),
            other => format!("not ended: {other:?}"),
        };
        let began = Instant::now();
        end_in_order(None, bridge_stop(false), Some(step), wait, &say);
        let took = began.elapsed();
        assert!(took >= wait, "quit went on early, after {took:?}");
        assert!(took < wait + Duration::from_secs(1), "quit waited past the runner step's time, {took:?}");
        let lines = lines.into_inner();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0], "quit: no bridge to stop");
        assert!(lines[1].starts_with("quit: ended at the deadline: pid "), "{lines:?}");
        // The program is gone, not left running past the end of the step.
        let beat = std::fs::read_to_string(folder.marker()).expect("it never ran");
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(std::fs::read_to_string(folder.marker()).unwrap(), beat, "it is still running");
    }

    // The bridge's own time, counted from when its input was closed, whatever the runner step is doing.

    #[test]
    fn a_bridge_that_ignores_its_input_is_killed_at_its_own_time_while_the_runner_step_is_still_going() {
        let mut bridge = Standin::start("kill-during", IGNORES_ITS_INPUT);
        let origin = Instant::now();
        let lines = RefCell::new(Vec::<(Duration, String)>::new());
        let say = |line: &str| lines.borrow_mut().push((origin.elapsed(), line.to_string()));
        let wait = Duration::from_millis(700);
        let runner_takes = Duration::from_secs(3);
        let runner = move |_deadline: Instant| {
            std::thread::sleep(runner_takes);
            "runner stopped".to_string()
        };
        end_in_order(Some(&mut bridge.child), BridgeStop::Gracefully(wait), Some(runner), Duration::from_secs(30), &say);
        let total = origin.elapsed();
        let lines = lines.into_inner();
        assert_eq!(lines.len(), 2, "{lines:?}");
        // The bridge was killed first, at its own time, with the runner step still going.
        let (killed_at, said) = &lines[0];
        assert!(said.starts_with("quit: bridge pid ") && said.contains("so it was killed"), "{lines:?}");
        assert!(*killed_at >= wait, "it was killed before its time, at {killed_at:?}");
        assert!(*killed_at < Duration::from_secs(2), "it was killed only at {killed_at:?}, after the runner step went on to {runner_takes:?}");
        assert!(matches!(bridge.child.try_wait(), Ok(Some(_))), "it is still running");
        // Then the runner step finished, and the total is the longer of the two, not the sum.
        assert_eq!(lines[1].1, "quit: runner stopped");
        assert!(lines[1].0 >= runner_takes, "{lines:?}");
        assert!(total < runner_takes + Duration::from_secs(2), "the waits added up, {total:?}");
    }

    // The runner step's own time, and how it is said to end.

    #[test]
    fn the_runner_step_is_given_its_time_counted_from_when_it_begins_whatever_the_bridge_does() {
        let mut bridge = Standin::start("deadline", ENDS_WITH_ITS_INPUT);
        let origin = Instant::now();
        let given = Arc::new(Mutex::new(None::<Instant>));
        let got = given.clone();
        let runner = move |deadline: Instant| {
            *got.lock().unwrap() = Some(deadline);
            "runner stopped".to_string()
        };
        let wait = Duration::from_secs(8);
        end_in_order(Some(&mut bridge.child), BridgeStop::Gracefully(Duration::from_secs(60)), Some(runner), wait, &|_| {});
        let deadline = given.lock().unwrap().expect("the runner step never ran");
        let after = deadline.duration_since(origin);
        // Its own 8 seconds, not stretched by the bridge's time or shortened by the bridge ending.
        assert!(after >= wait && after < wait + Duration::from_secs(2), "{after:?}");
    }

    #[test]
    fn a_runner_step_that_ignores_its_deadline_is_given_up_on_a_little_after_it() {
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        let wait = Duration::from_millis(300);
        let step = |_deadline: Instant| {
            std::thread::sleep(Duration::from_secs(6));
            "too late".to_string()
        };
        let started = Instant::now();
        end_in_order(None, bridge_stop(false), Some(step), wait, &say);
        let took = started.elapsed();
        assert!(took >= wait + RUNNER_STEP_GRACE, "it was given up on early, after {took:?}");
        assert!(took < wait + RUNNER_STEP_GRACE + Duration::from_secs(2), "it was waited for, {took:?}");
        assert_eq!(
            lines.into_inner(),
            [
                "quit: no bridge to stop",
                "quit: the runner step was still going 2.3 seconds after it began, so quit went on without it (an on-demand runner may still be running)"
            ]
        );
    }

    #[test]
    fn a_runner_step_that_fails_is_said_to_have() {
        let lines = RefCell::new(Vec::<String>::new());
        let say = |line: &str| lines.borrow_mut().push(line.to_string());
        let step = |_deadline: Instant| -> String { panic!("on purpose, for the test") };
        end_in_order(None, bridge_stop(false), Some(step), Duration::from_secs(30), &say);
        assert_eq!(lines.into_inner(), ["quit: no bridge to stop", "quit: the runner step failed"]);
    }

    #[test]
    fn times_are_said_the_way_they_were_waited_for() {
        assert_eq!(seconds(Duration::from_secs(3)), "3 seconds");
        assert_eq!(seconds(Duration::from_secs(1)), "1 second");
        assert_eq!(seconds(Duration::from_millis(700)), "0.7 seconds");
        assert_eq!(seconds(Duration::from_millis(2300)), "2.3 seconds");
        assert_eq!(BridgeEnd::Killed.describe(Duration::from_secs(3)), "was still running 3 seconds after its input was closed, so it was killed");
    }

    // What the exit step does with the script's two runs (stop_on_demand), with the script faked.

    fn answer(text: &str) -> Result<Ran, String> {
        Ok(Ran::Finished(0, text.to_string()))
    }

    #[test]
    fn quitting_stops_an_on_demand_runner_with_both_runs_held_to_the_one_deadline() {
        let asked = RefCell::new(Vec::<(String, Instant)>::new());
        let ask = |args: &[String], deadline: Instant| -> Result<Ran, String> {
            asked.borrow_mut().push((args.join(" "), deadline));
            if args[0] == "--mode" {
                answer("on-demand\n")
            } else {
                answer("Stopped the runner.\nmore")
            }
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        assert_eq!(stop_on_demand(&ask, deadline), "runner mode on-demand: stop script said 0: Stopped the runner.");
        let asked = asked.into_inner();
        assert_eq!(asked.iter().map(|(args, _)| args.as_str()).collect::<Vec<_>>(), ["--mode", "--stop"]);
        assert!(asked.iter().all(|(_, d)| *d == deadline), "the two runs were given different times");
    }

    #[test]
    fn quitting_leaves_a_runner_that_starts_at_sign_in_alone() {
        let asked = RefCell::new(Vec::<String>::new());
        let ask = |args: &[String], _deadline: Instant| -> Result<Ran, String> {
            asked.borrow_mut().push(args.join(" "));
            answer("sign-in")
        };
        assert_eq!(stop_on_demand(&ask, Instant::now() + Duration::from_secs(10)), "runner mode sign-in: left running");
        assert_eq!(asked.into_inner(), ["--mode"]);
    }

    #[test]
    fn a_stop_still_running_at_the_deadline_is_said_to_have_been_ended_and_with_its_pid() {
        let ask = |args: &[String], _deadline: Instant| -> Result<Ran, String> {
            if args[0] == "--mode" {
                answer("on-demand")
            } else {
                Ok(Ran::EndedAtDeadline(4242))
            }
        };
        assert_eq!(
            stop_on_demand(&ask, Instant::now() + Duration::from_secs(10)),
            "runner mode on-demand: the stop script's Node (pid 4242) was still running when the step's time was up, so it was ended (the runner may still be running)"
        );
    }

    #[test]
    fn a_mode_check_still_running_at_the_deadline_is_ended_and_no_stop_is_tried() {
        let asked = RefCell::new(Vec::<String>::new());
        let ask = |args: &[String], _deadline: Instant| -> Result<Ran, String> {
            asked.borrow_mut().push(args.join(" "));
            Ok(Ran::EndedAtDeadline(77))
        };
        assert_eq!(
            stop_on_demand(&ask, Instant::now() + Duration::from_secs(10)),
            "runner mode unknown (the mode check's Node (pid 77) was still running when the step's time was up, so it was ended): left running"
        );
        assert_eq!(asked.into_inner(), ["--mode"]);
    }

    #[test]
    fn a_script_that_fails_or_cannot_be_run_is_said_so_and_the_runner_is_left() {
        let failing = |_: &[String], _: Instant| -> Result<Ran, String> { Ok(Ran::Finished(1, "boom\nmore".to_string())) };
        assert_eq!(stop_on_demand(&failing, Instant::now() + Duration::from_secs(10)), "runner mode unknown (the script said 1: boom): left running");
        let ask = |args: &[String], _: Instant| -> Result<Ran, String> {
            if args[0] == "--mode" {
                answer("on-demand")
            } else {
                Err("Couldn't run Node (nope).".to_string())
            }
        };
        assert_eq!(
            stop_on_demand(&ask, Instant::now() + Duration::from_secs(10)),
            "runner mode on-demand: the stop script could not be run: Couldn't run Node (nope)."
        );
    }

    #[test]
    fn a_script_is_not_started_once_the_steps_time_is_already_up() {
        let why = runner_script_until(&["--mode".to_string()], Instant::now()).unwrap_err();
        assert_eq!(why, "the step's time was already up");
    }
}
