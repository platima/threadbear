// One thread: its transcript (rows come from the reducer in threadbear-core),
// its cards and the composer. Reads the newest page of events, then subscribes
// from the last of them, as the Mac app's ThreadSession does.
use crate::{call, RT};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use threadbear_client::runner::Client;
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::reducer::{BackgroundTask, Event, EventsPage, FeedAction, PendingMessage, Row, RowContent, ThreadFeed, TranscriptChange, TranscriptModel};

/// Events asked for when a thread opens, as ThreadSession.eventsPage.
const EVENTS_PAGE: u64 = 500;
/// Streamed text arrives faster than it's worth drawing: flushed at most this
/// often, as ThreadSession does (30 Hz).
const FLUSH_EVERY: Duration = Duration::from_millis(33);

pub struct ThreadPane {
    client: Arc<Client>,
    pub(crate) summary: ThreadSummary,
    pub(crate) feed: ThreadFeed,
    loaded: bool,
    error: Option<String>,
    scroller: Entity<MessageScrollerState>,
    input: Entity<TextareaState>,
    /// Tool and thinking rows opened, by row id. Groups keep theirs in the model.
    open_rows: HashSet<String>,
    pub(crate) chosen: HashMap<String, HashMap<usize, Vec<String>>>,
    pending: Vec<PendingMessage>,
    next_pending: u64,
    flush_queued: bool,
    _subs: Vec<Subscription>,
}

impl ThreadPane {
    pub fn new(client: Arc<Client>, summary: ThreadSummary, draft: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextareaState::new(window, cx).placeholder("Message").auto_grow(2, 8).submit_on_enter(true).default_value(draft));
        let sub = cx.subscribe_in(&input, window, |this, input, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = ev {
                let text = input.read(cx).value().trim().to_string();
                if !text.is_empty() {
                    input.update(cx, |s, cx| s.set_value("", window, cx));
                    this.send(text, None, cx);
                }
            }
        });
        let mut pane = ThreadPane {
            client,
            summary,
            feed: ThreadFeed::new(TranscriptModel::new(None)),
            loaded: false,
            error: None,
            scroller: cx.new(|cx| MessageScrollerState::new(0, cx)),
            input,
            open_rows: HashSet::new(),
            chosen: HashMap::new(),
            pending: vec![],
            next_pending: 0,
            flush_queued: false,
            _subs: vec![sub],
        };
        pane.load(cx);
        pane
    }

    pub fn thread_id(&self) -> &str {
        &self.summary.id
    }

    /// What's typed and not yet sent.
    pub fn draft(&self, cx: &App) -> String {
        self.input.read(cx).value().to_string()
    }

    #[cfg(feature = "automation")]
    pub fn composer(&self) -> Entity<TextareaState> {
        self.input.clone()
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if self.summary.busy() {
            self.request("threads.interrupt", json!({ "threadId": self.summary.id }), cx);
        }
    }

    fn background_tasks(&self) -> Vec<BackgroundTask> {
        self.summary.background.iter().flatten().filter_map(BackgroundTask::decode).collect()
    }

    pub fn load(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let id = self.summary.id.clone();
        let root = self.summary.cwd.clone();
        let background = self.background_tasks();
        cx.spawn(async move |this, cx| {
            let page = match call(client.clone(), "threads.events", json!({ "threadId": id, "limit": EVENTS_PAGE })).await {
                Ok(v) => EventsPage::decode(&v).unwrap_or_default(),
                Err(e) => {
                    this.update(cx, |this, cx| {
                        this.error = Some(e.message);
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            };
            let after_seq = this
                .update(cx, |this, cx| {
                    let mut model = TranscriptModel::new(Some(root));
                    model.load(page.events, &page.in_progress);
                    model.known_start = page.at_start;
                    let _ = model.set_background(background);
                    this.feed = ThreadFeed::new(model);
                    this.feed.begin_subscribe();
                    this.loaded = true;
                    this.scroller.update(cx, |s, cx| s.reset(this.feed.model().rows().len(), cx));
                    this.mark_seen();
                    cx.notify();
                    this.feed.accepted_seq()
                })
                .unwrap_or(0);
            let sub = call(client, "threads.subscribe", json!({ "threadId": id, "afterSeq": after_seq })).await;
            this.update(cx, |this, cx| match sub.ok().and_then(|v| EventsPage::decode(&v)) {
                Some(page) => {
                    let action = this.feed.finish_subscribe(page.events, &page.in_progress);
                    this.handle(action, cx);
                }
                None => this.feed.catch_up_failed(),
            })
            .ok();
        })
        .detach();
    }

    // Opening it reads it, as on the Mac.
    fn mark_seen(&self) {
        if self.summary.unread() {
            let client = self.client.clone();
            let params = json!({ "threadId": self.summary.id, "seq": self.summary.last_seq });
            RT.spawn(async move { client.call("threads.markSeen", params).await });
        }
    }

    pub fn unsubscribe(&self) {
        let client = self.client.clone();
        let params = json!({ "threadId": self.summary.id });
        RT.spawn(async move { client.call("threads.unsubscribe", params).await });
    }

    pub fn summary_changed(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) {
        if t.id == self.summary.id {
            self.summary = t.clone();
            if self.loaded {
                self.mark_seen();
                let change = self.feed.set_background(self.background_tasks());
                self.apply(change, cx);
            }
            cx.notify();
        }
    }

    pub fn event(&mut self, params: &Value, cx: &mut Context<Self>) {
        if params["threadId"].as_str() != Some(self.summary.id.as_str()) {
            return;
        }
        if let Some(event) = Event::decode(&params["event"]) {
            let action = self.feed.receive(event);
            self.handle(action, cx);
        }
    }

    fn handle(&mut self, action: FeedAction, cx: &mut Context<Self>) {
        match action {
            FeedAction::None => {}
            FeedAction::ScheduleFlush => self.schedule_flush(cx),
            FeedAction::NeedsCatchUp { after_seq } => self.catch_up(after_seq, cx),
        }
    }

    fn schedule_flush(&mut self, cx: &mut Context<Self>) {
        if self.flush_queued {
            return;
        }
        self.flush_queued = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FLUSH_EVERY).await;
            this.update(cx, |this, cx| {
                this.flush_queued = false;
                let change = this.feed.flush();
                this.apply(change, cx);
            })
            .ok();
        })
        .detach();
    }

    fn catch_up(&mut self, after_seq: i64, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let id = self.summary.id.clone();
        cx.spawn(async move |this, cx| {
            let page = call(client, "threads.events", json!({ "threadId": id, "afterSeq": after_seq })).await;
            this.update(cx, |this, cx| match page.ok().and_then(|v| EventsPage::decode(&v)) {
                Some(page) => {
                    let action = this.feed.catch_up(page.events);
                    this.handle(action, cx);
                }
                None => this.feed.catch_up_failed(),
            })
            .ok();
        })
        .detach();
    }

    /// Tells the list what the reducer changed, so it keeps its place: rows
    /// gone first, from the bottom up, then new ones from the top down.
    fn apply(&mut self, change: TranscriptChange, cx: &mut Context<Self>) {
        self.pending = self.feed.model().pending().to_vec();
        if change.is_empty() {
            return;
        }
        self.scroller.update(cx, |s, cx| {
            for &i in change.removed.iter().rev() {
                s.splice(i..i + 1, 0, cx);
            }
            for &i in change.inserted.iter() {
                s.splice(i..i, 1, cx);
            }
            for &i in change.updated.iter() {
                s.remeasure_items(i..i + 1, cx);
            }
        });
        cx.notify();
    }

    pub(crate) fn send(&mut self, text: String, answers: Option<Value>, cx: &mut Context<Self>) {
        // Shown straight away and put right when the runner echoes it back.
        self.next_pending += 1;
        let message = PendingMessage::new(&format!("local-{}", self.next_pending), &text, self.feed.accepted_seq());
        self.pending.push(message);
        let change = self.feed.set_pending(self.pending.clone());
        self.apply(change, cx);
        self.scroller.update(cx, |s, cx| s.scroll_to_end(cx));

        let mut params = json!({ "threadId": self.summary.id, "text": text });
        if let Some(a) = answers {
            params["answers"] = a;
        }
        self.request("threads.send", params, cx);
    }

    pub(crate) fn request(&mut self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, method, params).await;
            this.update(cx, |this, cx| {
                this.error = res.err().map(|e| e.message);
                this.scroller.update(cx, |s, cx| s.scroll_to_end(cx));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn toggle_row(&mut self, row: &Row, cx: &mut Context<Self>) {
        let open = !self.row_open(row);
        self.set_open(row, open, cx);
    }

    fn set_open(&mut self, row: &Row, open: bool, cx: &mut Context<Self>) {
        if matches!(row.content, RowContent::Group(_)) {
            let change = self.feed.set_expanded(&row.id, open);
            self.apply(change, cx);
        } else {
            if open {
                self.open_rows.insert(row.id.clone());
            } else {
                self.open_rows.remove(&row.id);
            }
            if let Some(i) = self.feed.model().index_of(&row.id) {
                self.scroller.update(cx, |s, cx| {
                    s.remeasure_items(i..i + 1, cx);
                });
            }
        }
        cx.notify();
    }

    pub(crate) fn row_open(&self, row: &Row) -> bool {
        match &row.content {
            RowContent::Group(group) => group.is_expanded,
            _ => self.open_rows.contains(&row.id),
        }
    }
}

#[cfg(feature = "automation")]
impl ThreadPane {
    /// The rows as the Swift app's dump gives them.
    pub fn dump(&self) -> Value {
        let rows: Vec<Value> = self
            .feed
            .model()
            .rows()
            .iter()
            .map(|row| {
                let mut out = json!({ "id": row.id, "kind": row.kind().as_str(), "text": threadbear_core::reducer::RowDebug::excerpt(row, 100), "inGroup": row.in_group, "seq": row.seq });
                if let Some(turn) = &row.turn_id {
                    out["turn"] = json!(turn);
                }
                if matches!(row.content, RowContent::Group(_) | RowContent::Tool(_) | RowContent::Reasoning(_)) {
                    out["expanded"] = json!(self.row_open(row));
                }
                out
            })
            .collect();
        json!({ "threadId": self.summary.id, "state": if self.loaded { "loaded" } else { "loading" }, "atBottom": true, "hasMoreAbove": self.feed.model().has_older_events(), "rows": rows })
    }

    pub fn set_row_open(&mut self, row: &str, open: bool, cx: &mut Context<Self>) -> Result<(), String> {
        let found = self.feed.model().rows().iter().find(|r| r.id.starts_with(row)).cloned();
        let Some(found) = found else { return Err(format!("no row starting {row:?}")) };
        self.set_open(&found, open, cx);
        Ok(())
    }

    /// Every event the thread has, for the long-thread check.
    pub fn load_all_events(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let id = self.summary.id.clone();
        let root = self.summary.cwd.clone();
        cx.spawn(async move |this, cx| {
            let page = call(client, "threads.events", json!({ "threadId": id, "limit": 1000000 })).await;
            this.update(cx, |this, cx| {
                if let Some(page) = page.ok().and_then(|v| EventsPage::decode(&v)) {
                    let mut model = TranscriptModel::new(Some(root));
                    model.load(page.events, &page.in_progress);
                    this.feed = ThreadFeed::new(model);
                    this.scroller.update(cx, |s, cx| s.reset(this.feed.model().rows().len(), cx));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

impl Render for ThreadPane {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (border, muted, danger, bg) = (theme.border, theme.muted_foreground, theme.danger, theme.background);
        let busy = self.summary.busy();
        let model = threadbear_core::inbox::model_label(&self.summary.provider, self.summary.model_in_use.as_deref().or(self.summary.model.as_deref()));
        let meta = format!("{} · {} · {}", threadbear_core::inbox::folder_name(&self.summary.cwd), model, self.summary.status);
        v_flex()
            .size_full()
            .child(
                v_flex()
                    .px_7()
                    .pt_3p5()
                    .pb_2p5()
                    .border_b_1()
                    .border_color(border)
                    .child(div().font_semibold().truncate().child(self.summary.title.clone()))
                    .child(div().text_xs().text_color(muted).child(meta)),
            )
            .when_some(self.error.clone(), |s, e| s.child(div().px_7().py_1().text_sm().text_color(danger).child(e)))
            .when(!self.loaded && self.error.is_none(), |s| s.child(div().p_4().text_sm().text_center().text_color(muted).child("Loading…")))
            .child(
                div().flex_1().min_h_0().child(
                    MessageScroller::new("transcript", self.scroller.clone(), cx.processor(|this, ix: usize, window, cx| this.render_item(ix, window, cx)))
                        .with_bottom_fade(bg)
                        .size_full(),
                ),
            )
            .child(
                h_flex().justify_center().px_7().pt_3().pb_4().border_t_1().border_color(border).child(
                    v_flex()
                        .w_full()
                        .max_w(px(760.))
                        .gap_2()
                        .child(Textarea::new(&self.input).w_full())
                        .child(
                            h_flex()
                                .justify_end()
                                .gap_2()
                                .when(busy, |s| s.child(Button::new("stop").small().label("Stop").tooltip("Stop the turn").on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.stop(cx)))))
                                .child(Button::new("send").small().primary().label("Send").tooltip("Send (Enter)").on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                    let text = this.input.read(cx).value().trim().to_string();
                                    if !text.is_empty() {
                                        this.input.update(cx, |s, cx| s.set_value("", window, cx));
                                        this.send(text, None, cx);
                                    }
                                }))),
                        ),
                ),
            )
    }
}
