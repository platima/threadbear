// The app's state: the connection, the thread list, what's open. The sidebar
// (sidebar.rs) and the thread pane (thread.rs) draw from it.
use crate::thread::ThreadPane;
use crate::{call, now_ms, ChannelSink, Seen, RT};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{h_flex, ActiveTheme as _, Theme};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use threadbear_client::config::RunnerConfig;
use threadbear_client::runner::{Client, Status};
use threadbear_core::inbox::{self, iso_time, ThreadSummary};
use tokio::sync::mpsc;

actions!(threadbear, [StopTurn, ArchiveThread]);

pub struct Threadbear {
    pub(crate) client: Arc<Client>,
    pub(crate) status: Status,
    pub(crate) threads: HashMap<String, ThreadSummary>,
    pub(crate) list_error: Option<String>,
    pub(crate) selected: Option<String>,
    pub(crate) pane: Option<Entity<ThreadPane>>,
    pub(crate) search: Entity<InputState>,
    /// The sections folded away under their headings, by key.
    pub(crate) folded: HashSet<&'static str>,
    /// What's typed for each thread that isn't open.
    drafts: HashMap<String, String>,
    _events: Task<()>,
    _subs: Vec<Subscription>,
}

impl Threadbear {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // gpui-kit starts in its light theme whatever the system says; follow
        // the system's light or dark, and keep following it when it changes.
        Theme::sync_system_appearance(Some(window), cx);
        let appearance = window.observe_window_appearance(|window, cx| Theme::sync_system_appearance(Some(window), cx));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let client = Client::new(RunnerConfig::from_env(), ChannelSink(tx));
        RT.spawn(client.clone().run());
        let events = cx.spawn(async move |this, cx| {
            while let Some(seen) = rx.recv().await {
                if this.update(cx, |this, cx| this.on_seen(seen, cx)).is_err() {
                    break;
                }
            }
        });
        let status = client.status();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search threads"));
        // The filter is worked out at render, so a change only needs a redraw.
        let searching = cx.subscribe(&search, |_, _, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        });
        #[cfg(feature = "automation")]
        crate::automation::serve(cx.entity().downgrade(), window.window_handle(), cx);
        Threadbear {
            client,
            status,
            threads: HashMap::new(),
            list_error: None,
            selected: None,
            pane: None,
            search,
            folded: HashSet::from(["hibernating", "archived"]),
            drafts: HashMap::new(),
            _events: events,
            _subs: vec![appearance, searching],
        }
    }

    fn on_seen(&mut self, seen: Seen, cx: &mut Context<Self>) {
        match seen {
            Seen::Status(status) => {
                let connected = matches!(status, Status::Connected { .. });
                self.status = status;
                // Each time it's connected, the whole list again, and the
                // open thread read again: thread.updated only says what changed.
                if connected {
                    self.load_list(cx);
                    if let Some(pane) = &self.pane {
                        pane.update(cx, |p, cx| p.load(cx));
                    }
                }
            }
            Seen::Note(method, params) => match method.as_str() {
                "thread.updated" => {
                    if let Ok(t) = serde_json::from_value::<ThreadSummary>(params["thread"].clone()) {
                        if let Some(pane) = &self.pane {
                            pane.update(cx, |p, cx| p.summary_changed(&t, cx));
                        }
                        self.threads.insert(t.id.clone(), t);
                    }
                }
                "thread.deleted" => {
                    self.threads.remove(params["threadId"].as_str().unwrap_or(""));
                }
                "thread.event" => {
                    if let Some(pane) = &self.pane {
                        pane.update(cx, |p, cx| p.event(&params, cx));
                    }
                }
                _ => {}
            },
        }
        cx.notify();
    }

    fn load_list(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, "threads.list", json!({ "include": ["inbox", "snoozed", "archived"] })).await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        let list: Vec<ThreadSummary> = serde_json::from_value(v["threads"].clone()).unwrap_or_default();
                        this.threads = list.into_iter().map(|t| (t.id.clone(), t)).collect();
                        this.list_error = None;
                    }
                    Err(e) => this.list_error = Some(e.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn open(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.as_deref() == Some(id.as_str()) {
            return;
        }
        let Some(summary) = self.threads.get(&id).cloned() else { return };
        if let Some(old) = &self.pane {
            old.read(cx).unsubscribe();
            let (thread, text) = (old.read(cx).thread_id().to_string(), old.read(cx).draft(cx));
            if text.is_empty() {
                self.drafts.remove(&thread);
            } else {
                self.drafts.insert(thread, text);
            }
        }
        let client = self.client.clone();
        let draft = self.drafts.get(&id).cloned().unwrap_or_default();
        self.selected = Some(id);
        self.pane = Some(cx.new(|cx| ThreadPane::new(client, summary, draft, window, cx)));
        cx.notify();
    }

    /// `threads.update` for the open thread, with the summary changed here
    /// first: anything clicked shows at once, and the runner's answer (or its
    /// thread.updated) puts it right.
    fn update_open(&mut self, change: impl FnOnce(&mut ThreadSummary), params: Value, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(id) = self.selected.clone() else { return Err("no thread open".into()) };
        let before = self.threads.get(&id).cloned();
        if let Some(t) = self.threads.get_mut(&id) {
            change(t);
        }
        let mut params = params;
        params["threadId"] = json!(id);
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, "threads.update", params).await;
            this.update(cx, |this, cx| {
                if let Err(e) = res {
                    this.list_error = Some(e.message);
                    if let Some(before) = before {
                        this.threads.insert(before.id.clone(), before);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
        Ok(())
    }

    pub(crate) fn archive_open(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        let now = iso_time(now_ms());
        self.update_open(move |t| t.archived_at = Some(now), json!({ "archived": true, "archivedBy": "mike" }), cx)
    }

    #[cfg(feature = "automation")]
    pub(crate) fn snooze_open(&mut self, seconds: i64, cx: &mut Context<Self>) -> Result<(), String> {
        let until = iso_time(now_ms() + seconds * 1000);
        let local = until.clone();
        self.update_open(move |t| t.snoozed_until = Some(local), json!({ "snoozedUntil": until }), cx)
    }

    fn stop_open(&mut self, cx: &mut Context<Self>) {
        if let Some(pane) = &self.pane {
            pane.update(cx, |p, cx| p.stop(cx));
        }
    }

    #[cfg(feature = "automation")]
    pub(crate) fn composer(&self, cx: &App) -> Option<Entity<gpui_kit::component::input::TextareaState>> {
        self.pane.as_ref().map(|p| p.read(cx).composer())
    }

    #[cfg(feature = "automation")]
    pub(crate) fn set_row_open(&mut self, row: &str, open: bool, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(pane) = &self.pane else { return Err("no thread open".into()) };
        pane.update(cx, |p, cx| p.set_row_open(row, open, cx))
    }

    #[cfg(feature = "automation")]
    pub(crate) fn load_all_events(&mut self, cx: &mut Context<Self>) {
        if let Some(pane) = &self.pane {
            pane.update(cx, |p, cx| p.load_all_events(cx));
        }
    }

    /// A thread named by the start of its id, as the Swift app's automation has it.
    #[cfg(feature = "automation")]
    pub(crate) fn thread_id_from(&self, start: &str) -> Result<String, String> {
        let mut found = self.threads.keys().filter(|id| id.starts_with(start));
        match (found.next(), found.next()) {
            (Some(id), None) => Ok(id.clone()),
            (None, _) => Err(format!("no thread starting {start:?}")),
            _ => Err(format!("more than one thread starts {start:?}")),
        }
    }

    /// The window as data, in the Swift app's shape (app/Sources/Threadbear/AppDump.swift).
    #[cfg(feature = "automation")]
    pub(crate) fn dump(&self, cx: &App) -> Value {
        let row = |t: &ThreadSummary| json!({ "id": t.id, "title": t.title, "status": t.status, "needsYou": t.needs_you, "unread": t.unread() });
        let now = now_ms();
        let shown = self.shown_sections(cx, now);
        let sections: Vec<Value> = shown.iter().map(|s| json!({ "name": s.title, "collapsed": self.folded.contains(s.key), "threads": s.rows.iter().map(row).collect::<Vec<_>>() })).collect();
        let snoozed = shown.iter().find(|s| s.key == "hibernating").map_or(0, |s| s.rows.len());
        let archived = shown.iter().find(|s| s.key == "archived").map_or(0, |s| s.rows.len());
        let connection = match self.status {
            Status::Connected { .. } => "connected",
            Status::Connecting { .. } => "connecting",
            Status::Disconnected { .. } => "lost",
        };
        let selected = self.selected.as_ref().and_then(|id| self.threads.get(id));
        let pane = self.pane.as_ref().map(|p| p.read(cx));
        json!({
            "connection": connection,
            "selection": selected.map(row),
            "sidebar": { "mode": "inbox", "sections": sections, "snoozed": snoozed, "archived": archived },
            "composer": { "draft": self.selected.clone().unwrap_or_else(|| "new".into()), "text": pane.map(|p| p.draft(cx)).unwrap_or_default() },
            "transcript": pane.map(|p| p.dump()).unwrap_or_else(|| json!({ "rows": [] })),
            "banner": Value::Null,
        })
    }

    /// The sections with the search applied, as they're drawn.
    pub(crate) fn shown_sections(&self, cx: &App, now: i64) -> Vec<inbox::Section> {
        let query = self.search.read(cx).value().trim().to_lowercase();
        inbox::sections(self.threads.values().filter(|t| query.is_empty() || inbox::matches(t, &query)), now)
    }

    pub(crate) fn connection_note(&self) -> Option<String> {
        match &self.status {
            Status::Connected { .. } => None,
            Status::Connecting { .. } => Some("Connecting to the runner…".into()),
            Status::Disconnected { reason, retry_in_ms, .. } => Some(format!("Can't reach the runner: {reason}. Trying again in {}s.", retry_in_ms.div_ceil(1000))),
        }
    }

}

impl Render for Threadbear {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let main = match &self.pane {
            Some(pane) => div().size_full().child(pane.clone()),
            None => div().size_full().flex().items_center().justify_center().text_color(muted).child(if matches!(self.status, Status::Connected { .. }) {
                "No thread open".to_string()
            } else {
                self.connection_note().unwrap_or_default()
            }),
        };
        h_flex()
            .key_context("Threadbear")
            .on_action(cx.listener(|this, _: &StopTurn, _, cx| this.stop_open(cx)))
            .on_action(cx.listener(|this, _: &ArchiveThread, _, cx| {
                let _ = this.archive_open(cx);
            }))
            .size_full()
            .items_start()
            .child(self.render_sidebar(cx))
            .child(div().flex_1().min_w_0().h_full().child(main))
    }
}
