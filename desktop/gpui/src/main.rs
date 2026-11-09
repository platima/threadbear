// Threadbear as a native GPUI app: the runner connection (../client), drawn
// with GPUI and gpui-kit's components. GPUI has no tokio, so the
// connection runs on a runtime of its own and hands its events across on a
// channel; requests run there too and their results come back as tasks.
mod app;
#[cfg(feature = "automation")]
mod automation;
mod composer;
mod composer_card;
mod composer_chips;
mod icons;
mod rows;
mod sidebar;
mod style;
mod thread;

use app::Threadbear;
use gpui_kit::*;
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use threadbear_client::runner::{Client, RpcError, Sink, Status};
use tokio::sync::mpsc;

pub static RT: LazyLock<tokio::runtime::Runtime> =
    LazyLock::new(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a tokio runtime"));

pub enum Seen {
    Status(Status),
    Note(String, Value),
}

pub(crate) struct ChannelSink(pub(crate) mpsc::UnboundedSender<Seen>);

impl Sink for ChannelSink {
    fn status(&self, status: &Status) {
        let _ = self.0.send(Seen::Status(status.clone()));
    }
    fn notification(&self, method: &str, params: &Value) {
        let _ = self.0.send(Seen::Note(method.to_string(), params.clone()));
    }
}

/// A request on the connection's runtime, awaited from GPUI's.
pub async fn call(client: Arc<Client>, method: impl Into<String>, params: Value) -> Result<Value, RpcError> {
    let method = method.into();
    RT.spawn(async move { client.call(&method, params).await })
        .await
        .unwrap_or_else(|e| Err(RpcError { code: -1, message: e.to_string(), data: None }))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn main() {
    // All of Lucide (about 1 MB), so `icons.rs` can name any icon; the default
    // `Assets` has only gpui-kit's own hundred.
    gpui_kit::application().with_assets(gpui_kit::assets::AllAssets).run(|cx| {
        gpui_kit::init(cx);
        // ⌘ on the Mac, Control elsewhere. KeyBinding::new doesn't take GPUI's
        // "secondary-", which needs to know the platform.
        let (stop, archive) = if cfg!(target_os = "macos") { ("cmd-.", "cmd-e") } else { ("ctrl-.", "ctrl-e") };
        cx.bind_keys([KeyBinding::new(stop, app::StopTurn, Some("Threadbear")), KeyBinding::new(archive, app::ArchiveThread, Some("Threadbear"))]);
        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some("Threadbear (GPUI)".into()), ..Default::default() }),
                window_min_size: Some(size(px(720.), px(480.))),
                app_id: Some("threadbear".into()),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| Threadbear::new(window, cx)),
        )
        .expect("failed to open the window");
    });
}
