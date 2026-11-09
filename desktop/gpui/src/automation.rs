// Scripted control of a real window, for the behaviour specs (features/) and
// agents checking their own work. Only a build with the `automation` feature
// has this: a release never does. It takes the same JSON commands as the Swift
// app's automation (app/README.md, "Seeing and driving it from a script"), and
// its `dump` has the same shape, so one set of specs drives both.
//
// Commands arrive over a local socket, each line one JSON object carrying the
// token from the file named by THREADBEAR_AUTOMATION, and run on the app's own
// thread between frames. Clicks and keys are real GPUI events going through
// real hit testing (gpui-kit's test helpers work on a live window too), so a
// spec presses what a person would press.
use crate::app::Threadbear;
use crate::{call, RT};
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::*;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

type Request = (Value, oneshot::Sender<Value>);

/// Starts listening if THREADBEAR_AUTOMATION names a file to say where.
pub fn serve(app: WeakEntity<Threadbear>, window: AnyWindowHandle, cx: &mut App) {
    let Ok(file) = std::env::var("THREADBEAR_AUTOMATION") else { return };
    let (tx, mut rx) = mpsc::unbounded_channel::<Request>();
    RT.spawn(listen(file, tx));
    cx.spawn(async move |cx| {
        while let Some((cmd, reply)) = rx.recv().await {
            let out = run(&app, window, &cmd, cx).await;
            let line = match out {
                Ok(result) => json!({ "result": result }),
                Err(error) => json!({ "error": error }),
            };
            let _ = reply.send(line);
        }
    })
    .detach();
}

async fn listen(file: String, tx: mpsc::UnboundedSender<Request>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("a local port");
    let port = listener.local_addr().expect("its port").port();
    let token = threadbear_client::auth::new_nonce();
    write_private(&file, &json!({ "port": port, "token": token }).to_string());
    loop {
        let Ok((socket, _)) = listener.accept().await else { continue };
        let (tx, token) = (tx.clone(), token.clone());
        RT.spawn(async move {
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let cmd: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                let reply = if cmd["token"].as_str() == Some(token.as_str()) {
                    let (back, answer) = oneshot::channel();
                    if tx.send((cmd, back)).is_err() {
                        break;
                    }
                    answer.await.unwrap_or_else(|_| json!({ "error": "the app stopped" }))
                } else {
                    json!({ "error": "wrong token" })
                };
                if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
    }
}

// The port and token, written whole and readable only by this user: a spec
// waits for the file to appear, so it must never see half of one.
fn write_private(file: &str, text: &str) {
    let temp = format!("{file}.tmp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&temp).expect("the automation file");
        f.write_all(text.as_bytes()).expect("the automation file");
    }
    #[cfg(not(unix))]
    std::fs::write(&temp, text).expect("the automation file");
    std::fs::rename(&temp, file).expect("the automation file");
}

async fn run(app: &WeakEntity<Threadbear>, window: AnyWindowHandle, cmd: &Value, cx: &mut AsyncApp) -> Result<Value, String> {
    if cmd["cmd"] == "mock" {
        let method = format!("mock.{}", cmd["method"].as_str().unwrap_or(""));
        let client = app.read_with(cx, |t, _| t.client.clone()).map_err(|e| e.to_string())?;
        return call(client, method, cmd["params"].clone()).await.map_err(|e| e.message);
    }
    let Some(app) = app.upgrade() else { return Err("the app has gone".into()) };
    cx.update_window(window, |_, window, cx| step(&app, cmd, window, cx)).map_err(|e| e.to_string())?
}

fn text<'a>(cmd: &'a Value, key: &str) -> &'a str {
    cmd[key].as_str().unwrap_or("")
}

/// Everything in the window has settled for this frame, so what a spec reads
/// is what's on screen now.
fn step(app: &Entity<Threadbear>, cmd: &Value, window: &mut Window, cx: &mut App) -> Result<Value, String> {
    match text(cmd, "cmd") {
        "dump" => Ok(app.read(cx).dump(cx)),
        "status" => Ok(json!("ok")),
        "open" | "select" => {
            let id = app.read(cx).thread_id_from(text(cmd, "id"))?;
            app.update(cx, |t, cx| t.open(id.clone(), window, cx));
            Ok(json!(format!("open ok {id}")))
        }
        "search" => {
            let words = text(cmd, "text").to_string();
            let search = app.read(cx).search.clone();
            search.update(cx, |s, cx| s.set_value(words, window, cx));
            Ok(json!("ok"))
        }
        "type" | "send" => {
            type_in_composer(app, text(cmd, "text"), cmd["replace"].as_bool().unwrap_or(false), window, cx)?;
            if text(cmd, "cmd") == "send" {
                window.press("enter", cx);
            }
            Ok(json!("ok"))
        }
        "return" => {
            window.press(if cmd["shift"].as_bool().unwrap_or(false) { "shift-enter" } else { "enter" }, cx);
            Ok(json!("ok"))
        }
        "menu-key" => {
            let mut key = String::new();
            for m in cmd["modifiers"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                key.push_str(match m {
                    // ⌘ on the Mac, Control elsewhere.
                    "cmd" => "secondary-",
                    "ctrl" => "ctrl-",
                    "opt" => "alt-",
                    "shift" => "shift-",
                    _ => "",
                });
            }
            key.push_str(text(cmd, "key"));
            window.press(&key, cx);
            Ok(json!("ok"))
        }
        "click" => {
            let title = text(cmd, "title");
            window.render_frame(cx);
            let target = window.find_all_by_label(title).into_iter().find(|e| e.visible());
            let Some(target) = target else { return Err(format!("no button called {title:?}")) };
            let at = target.bounds().center();
            window.pointer_move(at, None, cx);
            window.pointer_down(at, MouseButton::Left, cx);
            window.pointer_up(at, MouseButton::Left, cx);
            Ok(json!("click ok"))
        }
        "expand" | "collapse" => {
            let open = text(cmd, "cmd") == "expand";
            let row = text(cmd, "row").to_string();
            app.update(cx, |t, cx| t.set_row_open(&row, open, cx))?;
            Ok(json!("ok"))
        }
        "archive" => {
            app.update(cx, |t, cx| t.archive_open(cx))?;
            Ok(json!("ok"))
        }
        "snooze" => {
            let seconds = cmd["seconds"].as_i64().unwrap_or(3600);
            app.update(cx, |t, cx| t.snooze_open(seconds, cx))?;
            Ok(json!("ok"))
        }
        // Nothing to do: this app marks a thread read when it's open, and the
        // Swift app only does when it's in front, which a scripted one never is.
        "focus" => Ok(json!("ok")),
        // Everything the thread has, not just its newest page, then how long a
        // frame takes to draw while it's scrolled (the risk check in stage 0).
        "load-all" => {
            app.update(cx, |t, cx| t.load_all_events(cx));
            Ok(json!("ok"))
        }
        "page-scroll" => {
            let (steps, dy) = (cmd["steps"].as_u64().unwrap_or(120) as usize, cmd["dy"].as_f64().unwrap_or(14.) as f32);
            let at = window.viewport_size().map(|v| v / 2.);
            let at = point(at.width, at.height);
            let mut frames = Vec::with_capacity(steps);
            for i in 0..steps {
                let sign = if i < steps / 2 { -1. } else { 1. };
                let event = ScrollEvent { position: at, delta: ScrollDelta::Pixels(point(px(0.), px(dy * sign))), modifiers: Modifiers::default(), touch_phase: TouchPhase::Moved, source: ScrollSource::Pointer };
                window.dispatch_event(event.to_platform_input(), cx);
                let started = std::time::Instant::now();
                window.render_frame(cx);
                frames.push(started.elapsed().as_secs_f64() * 1000.);
            }
            frames.sort_by(|a, b| a.total_cmp(b));
            let at = |p: f64| frames[((frames.len() - 1) as f64 * p) as usize];
            Ok(json!({ "frames": frames.len(), "medianMs": at(0.5), "p95Ms": at(0.95), "worstMs": at(1.0) }))
        }
        "screenshot" => {
            let path = text(cmd, "path");
            let image = window.render_to_image().map_err(|e| e.to_string())?;
            image.save(path).map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        other => Err(format!("unknown command {other:?}")),
    }
}

fn type_in_composer(app: &Entity<Threadbear>, words: &str, replace: bool, window: &mut Window, cx: &mut App) -> Result<(), String> {
    let Some(input) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
    if replace {
        input.update(cx, |s, cx| s.set_value("", window, cx));
    }
    let handle = input.read(cx).focus_handle(cx);
    window.focus(&handle, cx);
    window.render_frame(cx);
    window.input(words, cx);
    Ok(())
}
