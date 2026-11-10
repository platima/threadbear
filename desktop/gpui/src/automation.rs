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
        // The sidebar's commands (sidebar.rs). Guarded ones only take the forms
        // that name a section, a row or a tip; the others fall through below.
        "hover" | "sort" | "archive-more" | "star" | "unstar" | "unarchive" | "new" | "realMenu" | "menu-popover" => crate::sidebar::automation(app, cmd, window, cx),
        "expand" | "collapse" if cmd.get("section").is_some() => crate::sidebar::automation(app, cmd, window, cx),
        "archive" | "snooze" if cmd.get("id").is_some() || cmd.get("said").is_some() => crate::sidebar::automation(app, cmd, window, cx),
        "click" if cmd.get("tip").is_some() || cmd.get("tipPrefix").is_some() => crate::sidebar::automation(app, cmd, window, cx),
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
        // The Swift app's `paste-image` and `drop`: a file through the same
        // route a paste or a drop takes.
        "paste-image" => {
            let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
            let path = std::path::PathBuf::from(text(cmd, "path"));
            if !crate::composer::is_picture(&path) {
                return Err("not an image".into());
            }
            composer.update(cx, |c, cx| c.take_paths(vec![path], window, cx));
            Ok(json!("ok"))
        }
        "drop" => {
            let position = point(px(cmd["x"].as_f64().unwrap_or(0.) as f32), px(cmd["y"].as_f64().unwrap_or(0.) as f32));
            if cmd["leave"].as_bool().unwrap_or(false) {
                window.dispatch_event(FileDropEvent::Exited.to_platform_input(), cx);
                return Ok(json!("ok"));
            }
            let paths = ExternalPaths(vec![std::path::PathBuf::from(text(cmd, "path"))].into());
            window.dispatch_event(FileDropEvent::Entered { position, paths }.to_platform_input(), cx);
            window.render_frame(cx);
            if !cmd["hover"].as_bool().unwrap_or(false) {
                window.dispatch_event(FileDropEvent::Submit { position }.to_platform_input(), cx);
            }
            Ok(json!("ok"))
        }
        // The Swift app's `composer-menu`: a chip's menu as text, or a click
        // on one of its items.
        "composer-menu" => {
            let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
            let data = composer.read(cx).chip_data(cx);
            match text(cmd, "menu") {
                "permission" => {
                    let summary = data.summary.clone().unwrap_or_default();
                    if let Some(title) = cmd["click"].as_str() {
                        let Some(mode) = crate::composer_chips::permission_modes(&summary).into_iter().find(|m| threadbear_core::logins::permission_title(m) == title) else { return Err(format!("no item {title}")) };
                        composer.update(cx, |c, cx| c.set_permission(mode, cx));
                        return Ok(json!("ok"));
                    }
                    Ok(json!(crate::composer_chips::permission_lines(&summary)))
                }
                "context" => match data.summary.as_ref().and_then(|t| threadbear_core::composer::ContextMeter::new(t.context_tokens, t.context_window)) {
                    Some(meter) => Ok(json!([meter.amount(), format!("{}%", meter.percent())])),
                    None => Err("no context meter on this thread".into()),
                },
                _ => {
                    if let Some(title) = cmd["click"].as_str() {
                        return crate::composer_chips::picker_click(&composer, title, cx).map(|_| json!("ok"));
                    }
                    Ok(json!(crate::composer_chips::picker_lines(&data)))
                }
            }
        }
        // The open card's picks (the Swift `decide`), and its buttons (`ask`).
        "decide" => {
            let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
            composer.update(cx, |c, cx| c.decide(cmd, window, cx)).map(|s| json!(s))
        }
        "ask" => {
            let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
            composer.update(cx, |c, cx| c.card_action(text(cmd, "action"), window, cx)).map(|_| json!("ok"))
        }
        "composer-peek" => {
            let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
            let number = cmd["number"].as_u64().map(|n| n as usize);
            composer.update(cx, |c, cx| c.debug_peek(number, cx))?;
            Ok(json!(if number.is_some() { "ok window 0" } else { "ok" }))
        }
        // `text` pasted as ⌘V would (the Swift app's `paste`): through the
        // clipboard, put back afterwards so a test machine's isn't left changed.
        "paste" => {
            let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
            let input = composer.read(cx).input.clone();
            let handle = input.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
            window.render_frame(cx);
            let saved = cx.read_from_clipboard();
            cx.write_to_clipboard(ClipboardItem::new_string(text(cmd, "text").to_string()));
            window.press("secondary-v", cx);
            if let Some(saved) = saved {
                cx.write_to_clipboard(saved);
            }
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
            let file = (!cmd["file"].is_null()).then(|| cmd["file"].clone());
            let all = cmd["all"].as_bool().unwrap_or(false);
            if file.is_some() || all {
                app.update(cx, |t, cx| t.update_pane(cx, |p, cx| p.expand_detail(&row, file.as_ref(), all, open, cx)))??;
            } else {
                app.update(cx, |t, cx| t.set_row_open(&row, open, cx))?;
            }
            Ok(json!("ok"))
        }
        "scroll" | "scroll-to" => {
            let (to, row, offset) = (cmd["to"].as_str().map(str::to_owned), cmd["row"].as_str().map(str::to_owned), cmd["offset"].as_f64().unwrap_or(0.) as f32);
            app.update(cx, |t, cx| t.update_pane(cx, |p, cx| p.scroll_command(to.as_deref(), row.as_deref(), offset, cx)))??;
            Ok(json!("ok"))
        }
        "bottom" => {
            app.update(cx, |t, cx| t.update_pane(cx, |p, cx| p.scroll_command(Some("bottom"), None, 0., cx)))??;
            Ok(json!("ok"))
        }
        "link" => {
            let (row, url) = (text(cmd, "row").to_string(), text(cmd, "url").to_string());
            app.update(cx, |t, cx| t.update_pane(cx, |p, cx| p.follow_link_command(&row, &url, window, cx)))??;
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
        "menu" => {
            let (row, click) = (text(cmd, "row").to_string(), cmd["click"].as_str().map(str::to_owned));
            let result = app.update(cx, |t, cx| t.update_pane(cx, |p, cx| p.menu_command(&row, click.as_deref(), cx)))??;
            Ok(json!(result))
        }
        "clipboard" => {
            let words = cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default();
            Ok(json!(format!("ok {}", serde_json::to_string(&words).unwrap_or_default())))
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
    let Some(composer) = app.read(cx).composer(cx) else { return Err("no thread open".into()) };
    let input = composer.read(cx).input.clone();
    if replace {
        input.update(cx, |s, cx| s.set_value("", window, cx));
    }
    let handle = input.read(cx).focus_handle(cx);
    window.focus(&handle, cx);
    window.render_frame(cx);
    window.input(words, cx);
    Ok(())
}
