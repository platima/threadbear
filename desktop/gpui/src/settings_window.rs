// The Settings window (⌘,), a port of the Swift app's SettingsView: the
// runner's settings in the grouped form every Mac app's settings use, with a
// sidebar like System Settings' rather than tabs, so the window keeps one
// height and each section scrolls. All of it lives in the runner (runner.json)
// and this only shows it and sends changes, apart from the appearance, which
// is this app's own (desktop-settings.json).
//
// Every section says, behind its ⓘ, what it is and what to ask your agent:
// agents edit runner.json and the rest, so the window shows what's set with
// few controls (Mike, 5 Nov). A change shows at once; the runner's answer, or
// its error under the form, has the last word.
use crate::app::Threadbear;
use crate::home_page::info_tip;
use crate::{call, icons, style};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, Icon, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use serde_json::{json, Value};
use std::time::Duration;
use threadbear_core::new_thread::abbreviate_home;
use threadbear_core::runner_settings::{experiment_about, BringIn, RunnerSettings, StandingInstructions};

/// The sections down the sidebar (`SettingsTab`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tab {
    General,
    Models,
    Pools,
    Runners,
    Devices,
    Keyboard,
}

impl Tab {
    pub(crate) const ALL: [Tab; 6] = [Tab::General, Tab::Models, Tab::Pools, Tab::Runners, Tab::Devices, Tab::Keyboard];

    pub(crate) fn title(self) -> &'static str {
        match self {
            Tab::General => "General",
            Tab::Models => "Models",
            Tab::Pools => "Pools",
            Tab::Runners => "Runners",
            Tab::Devices => "Phone & browser",
            Tab::Keyboard => "Keyboard",
        }
    }

    fn symbol(self) -> &'static str {
        match self {
            Tab::General => "gearshape",
            Tab::Models => "sparkles",
            Tab::Pools => "square.stack",
            Tab::Runners => "server.rack",
            Tab::Devices => "iphone",
            Tab::Keyboard => "keyboard",
        }
    }

    /// The Swift app's raw value, as scripts name it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Tab::General => "general",
            Tab::Models => "models",
            Tab::Pools => "pools",
            Tab::Runners => "runners",
            Tab::Devices => "devices",
            Tab::Keyboard => "keyboard",
        }
    }

    pub(crate) fn from_name(name: &str) -> Option<Tab> {
        Tab::ALL.into_iter().find(|t| t.name() == name)
    }
}

/// The sidebar's width, and the window's, at 100% (`SettingsLayout`).
const SIDEBAR_WIDTH: f32 = 215.;

impl Threadbear {
    /// ⌘, or the gear: the window, brought forward if it's open, on `tab` if
    /// one's given (Settings › Models from the Librarian's page, say).
    pub(crate) fn open_settings(&mut self, tab: Option<Tab>, cx: &mut Context<Self>) {
        if let Some((handle, view)) = self.settings_window.clone() {
            let alive = handle
                .update(cx, |_, window, cx| {
                    window.activate_window();
                    if let Some(tab) = tab {
                        view.update(cx, |v, cx| v.show(tab, window, cx));
                    }
                })
                .is_ok();
            if alive {
                return;
            }
            self.settings_window = None;
        }
        let app = cx.entity().downgrade();
        let tab = tab.unwrap_or(Tab::General);
        // Handed what it needs: it can't read the app while the app is the
        // one opening it.
        let (client, instructions) = (self.client.clone(), self.standing_instructions.clone());
        // Opened once this update is over: `open_window` draws the window's
        // first frame there and then, and its drawing reads the app.
        let me = cx.entity();
        cx.defer(move |cx| {
            let bounds = Bounds::centered(None, size(px(880.), px(620.)), cx);
            let opened = gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions { title: Some(tab.title().into()), appears_transparent: false, traffic_light_position: None }),
                    window_min_size: Some(size(px(640.), px(420.))),
                    app_id: Some("threadbear".into()),
                    ..Default::default()
                },
                cx,
                move |window, cx| cx.new(|cx| SettingsWindow::new(app, client, instructions, tab, window, cx)),
            );
            me.update(cx, |me, cx| match opened {
                Ok((handle, view)) => {
                    me.settings_window = Some((handle, view));
                    cx.notify();
                }
                Err(e) => me.show_error(format!("Settings didn't open: {e}"), cx),
            });
        });
        // What's in the Instructions box, fresh each time the window opens.
        self.load_standing_instructions(cx);
    }

    /// `loadStandingInstructions`: None from a runner without them (their
    /// experiment off, or too old), when General shows no box.
    pub(crate) fn load_standing_instructions(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, "instructions.get", json!({})).await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => this.standing_instructions = Some(StandingInstructions::decode(&v["instructions"])),
                    // -32601: none for this runner.
                    Err(e) if e.code == -32601 => this.standing_instructions = None,
                    Err(_) => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// The window's content (`SettingsView`).
pub(crate) struct SettingsWindow {
    app: WeakEntity<Threadbear>,
    client: std::sync::Arc<threadbear_client::runner::Client>,
    pub(crate) tab: Tab,
    hovered: Option<Tab>,
    /// The Instructions box.
    instructions: Entity<TextareaState>,
    /// What the box was last filled from or saved as: what's typed is
    /// compared with it, so the runner's own change can come in while
    /// nothing's being typed.
    instructions_base: Option<String>,
    /// Set while the box is being filled from the runner, so that isn't
    /// taken for typing.
    filling: bool,
    instructions_status: Option<String>,
    /// The save a moment after typing stops (`scheduleSave`).
    instructions_save: Option<Task<()>>,
    /// The words being read when something other than Settings changed the
    /// file, kept as they were when he started reading
    /// (`InstructionsChangedOutside`).
    reviewed: Option<String>,
    resolving: bool,
    resolve_error: Option<String>,
    scroll: ScrollHandle,
    _subs: Vec<Subscription>,
}

impl SettingsWindow {
    fn new(app: WeakEntity<Threadbear>, client: std::sync::Arc<threadbear_client::runner::Client>, instructions_now: Option<StandingInstructions>, tab: Tab, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let instructions = cx.new(|cx| TextareaState::new(window, cx).placeholder("For example: I build with React, TypeScript and Convex. Write plainly and briefly."));
        let mut subs = vec![cx.subscribe_in(&instructions, window, |this, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) && !this.filling {
                this.schedule_instructions_save(cx);
            }
        })];
        if let Some(app) = app.upgrade() {
            // Everything it shows is the app's, so it draws again when that changes.
            subs.push(cx.observe_in(&app, window, |this, app, window, cx| {
                let saved = app.read(cx).standing_instructions.clone();
                this.follow_saved_instructions(saved, window, cx);
                cx.notify();
            }));
        }
        // In front, the app is: threads in the main window still read as
        // Mike looks at them (`Threadbear::looking_changed`).
        let looking_app = app.clone();
        subs.push(cx.observe_window_activation(window, move |_, window, cx| {
            let (key, active) = (crate::thread::window_key(window), window.is_window_active());
            if let Some(app) = looking_app.upgrade() {
                app.update(cx, |app, cx| app.looking_changed(key, active, cx));
            }
        }));
        // Closing it saves what's typed and not yet sent (`onDisappear`).
        let me = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            if let Some(me) = me.upgrade() {
                me.update(cx, |this, cx| this.commit_instructions(window, cx));
            }
            // Gone, it isn't in front, whether or not it says so first.
            crate::thread::set_looking(crate::thread::window_key(window), false);
            true
        });
        let mut this = SettingsWindow {
            app,
            client,
            tab,
            hovered: None,
            instructions,
            instructions_base: None,
            filling: false,
            instructions_status: None,
            instructions_save: None,
            reviewed: None,
            resolving: false,
            resolve_error: None,
            scroll: ScrollHandle::new(),
            _subs: subs,
        };
        this.follow_saved_instructions(instructions_now, window, cx);
        this
    }

    pub(crate) fn show(&mut self, tab: Tab, window: &mut Window, cx: &mut Context<Self>) {
        if self.tab != tab {
            self.commit_instructions(window, cx);
            self.tab = tab;
            window.set_window_title(tab.title());
            self.scroll.set_offset(point(gpui_kit::px(0.), gpui_kit::px(0.)));
            cx.notify();
        }
    }

    fn client(&self, _cx: &App) -> Option<std::sync::Arc<threadbear_client::runner::Client>> {
        Some(self.client.clone())
    }

    // The Instructions box.

    /// The runner's instructions came in or changed: the box shows them, unless
    /// something's being typed there (`onChange(of: saved)`). A file changed
    /// outside Settings is read as it was when reading started.
    fn follow_saved_instructions(&mut self, saved: Option<StandingInstructions>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(saved) = saved else { return };
        if saved.outside {
            if self.reviewed.is_none() {
                self.reviewed = Some(saved.text.clone());
            }
            return;
        }
        self.reviewed = None;
        let typed = self.instructions.read(cx).value().to_string();
        let first = self.instructions_base.is_none();
        if first || (self.instructions_save.is_none() && typed.trim() != saved.text.trim()) {
            self.filling = true;
            self.instructions.update(cx, |s, cx| s.set_value(saved.text.clone(), window, cx));
            self.filling = false;
            self.instructions_base = Some(saved.text);
        }
    }

    /// A second after typing stops, what's typed is saved.
    fn schedule_instructions_save(&mut self, cx: &mut Context<Self>) {
        self.instructions_status = None;
        self.instructions_save = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(1)).await;
            this.update(cx, |this, cx| this.write_instructions(cx)).ok();
        }));
        cx.notify();
    }

    /// Saves now if a save is waiting (`commit`).
    fn commit_instructions(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.instructions_save.take().is_some() {
            self.write_instructions(cx);
        }
    }

    fn write_instructions(&mut self, cx: &mut Context<Self>) {
        self.instructions_save = None;
        let wanted = self.instructions.read(cx).value().to_string();
        let saved = self.instructions_base.clone().unwrap_or_default();
        if wanted.trim() == saved.trim() {
            return;
        }
        let Some(client) = self.client(cx) else { return };
        cx.spawn(async move |this, cx| {
            let res = call(client, "instructions.set", json!({ "text": wanted })).await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        let now = StandingInstructions::decode(&v["instructions"]);
                        this.instructions_status = Some(if wanted.trim().is_empty() { "Cleared".into() } else { "Saved".into() });
                        this.instructions_base = Some(now.text.clone());
                        if let Some(app) = this.app.upgrade() {
                            app.update(cx, |app, cx| {
                                app.standing_instructions = Some(now);
                                cx.notify();
                            });
                        }
                    }
                    Err(e) => this.instructions_status = Some(e.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Use These or Clear on a file changed outside Settings: sends the words
    /// shown, never "trust the file".
    fn resolve_outside(&mut self, text: String, cx: &mut Context<Self>) {
        if self.resolving {
            return;
        }
        let Some(client) = self.client(cx) else { return };
        self.resolving = true;
        self.resolve_error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let res = call(client, "instructions.set", json!({ "text": text })).await;
            this.update(cx, |this, cx| {
                this.resolving = false;
                match res {
                    Ok(v) => {
                        let now = StandingInstructions::decode(&v["instructions"]);
                        this.reviewed = None;
                        this.instructions_base = None;
                        if let Some(app) = this.app.upgrade() {
                            app.update(cx, |app, cx| {
                                app.standing_instructions = Some(now);
                                cx.notify();
                            });
                        }
                    }
                    Err(e) => this.resolve_error = Some(e.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn update(&self, change: Value, cx: &mut App) {
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| app.update_runner_settings(change, cx));
        }
    }

    fn choose_default_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Choose".into()) });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = paths.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |this, cx| this.update(json!({ "defaultCwd": path.to_string_lossy() }), cx)).ok();
                }
            }
        })
        .detach();
    }

    fn add_private_folders(&mut self, current: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: true, prompt: Some("Add".into()) });
        let home = std::env::var("HOME").unwrap_or_default();
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                let mut folders = current;
                for path in paths {
                    let folder = abbreviate_home(&path.to_string_lossy(), &home);
                    if !folders.contains(&folder) {
                        folders.push(folder);
                    }
                }
                this.update(cx, |this, cx| this.update(json!({ "models": { "privateFolders": folders } }), cx)).ok();
            }
        })
        .detach();
    }

    // Drawing.

    fn render_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let hover = style::primary_opacity(cx, 0.05);
        let on_fill = style::primary_opacity(cx, 0.1);
        let (fg, secondary) = (cx.theme().foreground, style::secondary_text(cx));
        v_flex()
            .w(px(SIDEBAR_WIDTH))
            .flex_none()
            .h_full()
            .bg(cx.theme().sidebar)
            .border_r_1()
            .border_color(style::hairline(cx))
            .px(px(10.))
            .py(px(8.))
            .gap(px(2.))
            .children(Tab::ALL.into_iter().map(|tab| {
                let on = tab == self.tab;
                let hovered = self.hovered == Some(tab);
                crate::highlights::tipped(h_flex().id(SharedString::from(format!("settings-tab-{}", tab.name()))).h(px(30.)).px(px(8.)).gap(px(9.)).items_center().rounded(px(7.)), tab.title())
                    .when(on, |s| s.bg(on_fill))
                    .when(!on && hovered, |s| s.bg(hover))
                    .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                        this.hovered = if *over { Some(tab) } else if this.hovered == Some(tab) { None } else { this.hovered };
                        cx.notify();
                    }))
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.show(tab, window, cx)))
                    .child(div().w(px(18.)).flex().justify_center().child(icons::symbol(tab.symbol()).with_size(px(13.)).text_color(if on { fg } else { secondary })))
                    .child(div().text_size(px(13.)).line_height(px(16.)).text_color(fg).when(on, |s| s.font_medium()).child(tab.title()))
            }))
    }

    fn render_general(&mut self, settings: Option<&RunnerSettings>, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut sections = vec![self.appearance_section(cx)];
        let Some(settings) = settings else {
            sections.push(plain_note(&waiting_text(&self.app, cx), cx));
            return sections;
        };
        let home = std::env::var("HOME").unwrap_or_default();
        let folder = abbreviate_home(&settings.default_cwd, &home);
        let full = settings.default_cwd.clone();
        let folder_control = h_flex()
            .gap(px(8.))
            .items_center()
            .child(div().id("settings-default-folder").max_w(px(280.)).text_ellipsis_middle().whitespace_nowrap().overflow_hidden().text_size(px(13.)).text_color(style::secondary_text(cx)).tooltip(move |window, cx| Tooltip::new(full.clone()).build(window, cx)).child(folder))
            .child(self.button("settings-choose-folder", "Choose…", "Pick the folder new threads start in", cx, |this, window, cx| this.choose_default_folder(window, cx)));
        sections.push(section(
            "settings-new-threads",
            "New threads",
            "Where a new thread starts when you don't pick a folder.",
            "change it, or anything else about how threads run. Most settings aren't shown here, and your agent edits them in runner.json.",
            vec![row("Default folder", folder_control, cx)],
            cx,
        ));
        if let Some(instructions) = self.instructions_section(window, cx) {
            sections.push(instructions);
        }
        if settings.lab_review_supported {
            let on = settings.lab_review;
            let switch = self.switch("settings-lab-review", on, "Have another lab check each code change a thread makes", cx, |this, on, cx| this.update(json!({ "labReview": on }), cx));
            sections.push(section(
                "settings-code-review",
                "Code review",
                "When a thread changes code and is done, Threadbear has your other provider (Codex for a Claude thread, Claude for a Codex one) try to break the change in a review thread of its own.",
                "explain what a review found, or turn reviews on or off for you.",
                vec![row("Review code changes before a thread is done", switch, cx)],
                cx,
            ));
        }
        if let Some(on) = settings.keep_awake {
            let switch = self.switch("settings-keep-awake", on, "Stop your Mac sleeping on its own while a thread is working", cx, |this, on, cx| this.update(json!({ "keepAwake": on }), cx));
            sections.push(section(
                "settings-sleep",
                "Sleep",
                "While any thread is working, and for three minutes after, your Mac won't go to sleep on its own, so a long turn, or one you started from your phone, isn't cut off halfway. The screen still sleeps.",
                "check whether it's holding your Mac awake right now.",
                vec![row("Keep the Mac awake while threads work", switch, cx)],
                cx,
            ));
        }
        if settings.bring_in_supported && self.app.upgrade().is_some_and(|a| a.read(cx).upstream_on) {
            let current = settings.bring_in;
            let choices: Vec<(String, bool, Value)> = BringIn::choices(current).into_iter().map(|b| (b.title(), b == current, json!({ "bringIn": b.json() }))).collect();
            let menu = self.menu("settings-bring-in", current.title(), None, "How often a thread starts to bring in Mike's new releases", choices, cx);
            let menu = h_flex().child(menu);
            sections.push(section(
                "settings-updates",
                "Updates from Mike",
                "When Mike has a release your copy doesn't have, Threadbear starts a thread that merges it in and runs the checks, then asks you before it lands. Never more than one at a time.",
                "bring in Mike's latest release now, or change how often this happens.",
                vec![row("Bring them in", menu, cx)],
                cx,
            ));
        }
        if !settings.experiments.is_empty() {
            let rows = settings
                .experiments
                .iter()
                .map(|e| {
                    let (id, on) = (e.id.clone(), e.on);
                    let tip = if on { format!("Turn {} off", e.name) } else { format!("Try {}", e.name) };
                    let switch = self.switch_owned(format!("settings-experiment-{id}"), on, tip, cx, move |this, on, cx| this.update(json!({ "experiments": { id.clone(): on } }), cx));
                    let label = h_flex()
                        .gap(px(6.))
                        .items_center()
                        .child(e.name.clone())
                        .when(!e.does.is_empty(), |s| s.child(info_tip(SharedString::from(format!("experiment-{}", e.id)), experiment_about(&e.does), cx)));
                    row_with(label.into_any_element(), switch, cx)
                })
                .collect();
            sections.push(section(
                "settings-experiments",
                "Experiments",
                "New features still being tried out. Each starts off; turn one on to try it, and off again whenever you like. Once one has proved itself it becomes a standard part of Threadbear and its switch goes.",
                "explain an experiment, or turn one on or off for you.",
                rows,
                cx,
            ));
        }
        let version = self.app.upgrade().map(|a| a.read(cx).runner_version.clone()).unwrap_or_default();
        sections.push(section(
            "settings-runner",
            "Runner",
            "The background program that runs your threads. It updates itself.",
            "check on it if something seems wrong. Your agent can read its status and logs.",
            vec![row("Version", div().text_size(px(13.)).text_color(style::secondary_text(cx)).child(if version.is_empty() { "Not connected".to_owned() } else { version }), cx)],
            cx,
        ));
        sections
    }

    /// The appearance is this app's own, so it's here while the runner's away too.
    fn appearance_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let current = style::appearance();
        let app = self.app.clone();
        let menu = Button::new("settings-appearance").label(current.title()).small().secondary().dropdown_caret(true).tooltip("Light or dark for Threadbear, whatever the Mac is set to").dropdown_menu(move |menu: PopupMenu, _, _| {
            let mut menu = menu;
            for choice in style::Appearance::ALL {
                let app = app.clone();
                menu = menu.item(PopupMenuItem::new(choice.title()).checked(choice == current).on_click(move |_, window, cx| {
                    if let Some(app) = app.upgrade() {
                        app.update(cx, |app, cx| app.set_appearance(choice, window, cx));
                    }
                }));
            }
            menu
        });
        section(
            "settings-appearance-section",
            "Appearance",
            "Light or dark for Threadbear only. Same as the Mac follows System Settings > Appearance.",
            "change it for you.",
            vec![row("Appearance", div().id("settings-appearance-holder").test_support().aria_label("Light or dark for Threadbear, whatever the Mac is set to").child(menu), cx)],
            cx,
        )
    }

    /// `InstructionsSection`: the box, or, when the file was changed outside
    /// Settings, what it holds with Use These and Clear.
    fn instructions_section(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let current = self.app.upgrade()?.read(cx).standing_instructions.clone()?;
        let secondary = style::secondary_text(cx);
        let body: AnyElement = if current.outside {
            let reviewed = self.reviewed.clone().unwrap_or_else(|| current.text.clone());
            let newer = current.text != reviewed;
            let empty = reviewed.is_empty();
            let shown = if empty { "The file is gone, or can't be read.".to_owned() } else { reviewed.clone() };
            let (use_text, file_text) = (reviewed.clone(), current.text.clone());
            let mut buttons = h_flex().gap(px(8.)).items_center();
            if self.resolving {
                buttons = buttons.child(Spinner::new().with_size(px(12.)).color(secondary));
            }
            if newer {
                buttons = buttons.child(self.button("settings-instructions-newer", "Show Newer Version", "The file has changed again. Show what it holds now", cx, move |this, _, cx| {
                    this.reviewed = Some(file_text.clone());
                    cx.notify();
                }));
            }
            buttons = buttons
                .child(div().flex_1())
                .child(self.button("settings-instructions-clear", "Clear", "Delete these, so agents are given no standing instructions", cx, |this, _, cx| this.resolve_outside(String::new(), cx)))
                .child(
                    div().id("settings-instructions-use").test_support().aria_label("Give every agent exactly the text shown here").child(
                        Button::new("settings-instructions-use-button")
                            .label("Use These")
                            .small()
                            .secondary()
                            .disabled(empty || self.resolving)
                            .tooltip("Give every agent exactly the text shown here")
                            .on_click(cx.listener(move |this, _, _, cx| this.resolve_outside(use_text.clone(), cx))),
                    ),
                );
            v_flex()
                .gap(px(8.))
                .p(px(12.))
                .child(
                    h_flex()
                        .gap(px(6.))
                        .items_start()
                        .text_size(px(13.))
                        .line_height(px(17.))
                        .text_color(style::needs_you_text(cx))
                        .child(icons::symbol("exclamationmark.triangle").with_size(px(13.)))
                        .child(div().flex_1().child("Something other than Settings changed these, so agents aren't being given them.")),
                )
                .child(div().id("settings-instructions-file").max_h(px(160.)).overflow_y_scroll().text_size(px(13.)).line_height(px(17.)).when(empty, |s| s.text_color(secondary)).child(shown))
                .when_some(self.resolve_error.clone(), |s, e| s.child(div().text_size(px(11.)).text_color(style::failed(cx)).child(e)))
                .child(buttons)
                .into_any_element()
        } else {
            v_flex()
                .gap(px(6.))
                .p(px(12.))
                .child(div().id("settings-instructions").test_support().aria_label("What every thread's agent should always keep in mind").child(Textarea::new(&self.instructions).h(px(120.)).appearance(false)))
                .when_some(self.instructions_status.clone(), |s, status| s.child(div().text_size(px(11.)).text_color(secondary).child(status)))
                .into_any_element()
        };
        Some(section_with_body(
            "settings-instructions-section",
            "Instructions",
            "Threadbear gives these to every thread's agent in every session, on every login, Claude and Codex alike. A chat that's already going hears a change before your next message.",
            "draft some for you to paste here. Agents can't change them themselves: only what's saved here is given to them.",
            body,
            cx,
        ))
    }

    fn render_models(&mut self, settings: Option<&RunnerSettings>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let Some(settings) = settings else { return vec![plain_note(&waiting_text(&self.app, cx), cx)] };
        let mut sections = Vec::new();
        if settings.pool_supported {
            if let Some(app) = self.app.upgrade() {
                let small = app.read(cx).small_job_providers();
                let logins = app.read(cx).logins.clone();
                let pools: Vec<(String, String, Option<String>, String)> = logins
                    .pools
                    .iter()
                    .filter(|pool| pool.account_ids.iter().any(|id| logins.account(id).is_some_and(|a| small.iter().any(|p| p == a.provider_id()))))
                    .map(|pool| {
                        let provider = pool.account_ids.iter().find_map(|id| logins.account(id)).map_or("claude", |a| a.provider_id()).to_owned();
                        (pool.id.clone(), pool.title.clone(), pool.icon.clone().filter(|i| !i.is_empty()), provider)
                    })
                    .collect();
                let set = settings.pool.clone();
                // The pool's own icon, else its logins' provider's mark (`Pools.symbol`).
                let face: Option<Icon> = set.as_ref().and_then(|id| pools.iter().find(|p| &p.0 == id)).map(|(_, _, icon, provider)| match icon {
                    Some(symbol) => icons::symbol(symbol),
                    None => icons::provider_mark(provider),
                });
                let label = match &set {
                    Some(id) => pools.iter().find(|p| &p.0 == id).map_or_else(|| format!("{id}, which has no Claude login"), |p| p.1.clone()),
                    None => "None".to_owned(),
                };
                let mut choices: Vec<(String, bool, Value)> = pools.iter().map(|(id, title, _, _)| (title.clone(), set.as_deref() == Some(id.as_str()), json!({ "models": { "pool": id } }))).collect();
                choices.push(("None".into(), set.is_none(), json!({ "models": { "pool": Value::Null } })));
                let menu = self.menu("settings-small-jobs", label, face, "Which pool's Claude logins write titles and do the librarian's work", choices, cx);
                sections.push(section(
                    "settings-small-jobs-section",
                    "Small jobs",
                    "Titles and the librarian use Haiku on one of this pool's Claude logins, the one with the most room, and count towards its usage. When every login is out of room they wait. None turns them off.",
                    "change this, or which model and effort new threads start on. Your agent edits them in runner.json.",
                    vec![row("Run on", menu, cx)],
                    cx,
                ));
            }
        }
        let secondary = style::secondary_text(cx);
        let mut rows: Vec<AnyElement> = Vec::new();
        if settings.private_folders.is_empty() {
            rows.push(row_with(div().text_color(secondary).child("None yet").into_any_element(), div().into_any_element(), cx));
        }
        for folder in &settings.private_folders {
            let rest: Vec<String> = settings.private_folders.iter().filter(|f| *f != folder).cloned().collect();
            let remove = self.icon_button(format!("settings-private-remove-{folder}"), "minus.circle", "Stop keeping this folder private", cx, move |this, _, cx| this.update(json!({ "models": { "privateFolders": rest.clone() } }), cx));
            let label = h_flex().gap(px(8.)).items_center().min_w_0().child(icons::symbol("folder").with_size(px(13.)).text_color(secondary)).child(div().min_w_0().text_ellipsis_middle().whitespace_nowrap().overflow_hidden().child(folder.clone()));
            rows.push(row_with(label.into_any_element(), remove, cx));
        }
        let current = settings.private_folders.clone();
        let add = self.button("settings-private-add", "Add Folder…", "Keep a folder's threads from ever being sent for titles and other small jobs", cx, move |this, window, cx| this.add_private_folders(current.clone(), window, cx));
        rows.push(row_with(h_flex().child(add).into_any_element(), div().into_any_element(), cx));
        sections.push(section(
            "settings-private-folders",
            "Private folders",
            "Nothing from threads in these folders, or in folders inside them, is sent for titles and other small jobs.",
            "add several at once. Your agent keeps them in runner.json.",
            rows,
            cx,
        ));
        sections
    }

    // Controls.

    fn button(&self, id: &'static str, label: &'static str, tip: &'static str, cx: &mut Context<Self>, action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static) -> AnyElement {
        div()
            .id(SharedString::from(format!("{id}-holder")))
            .test_support()
            .aria_label(tip)
            .flex_none()
            .child(Button::new(id).label(label).small().secondary().tooltip(tip).on_click(cx.listener(move |this, _, window, cx| action(this, window, cx))))
            .into_any_element()
    }

    fn icon_button(&self, id: String, symbol: &'static str, tip: &'static str, cx: &mut Context<Self>, action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static) -> AnyElement {
        let (hover, secondary, fg) = (style::primary_opacity(cx, 0.08), style::secondary_text(cx), cx.theme().foreground);
        crate::highlights::tipped(div().id(SharedString::from(id)).flex_none().size(px(22.)).rounded(px(5.)).flex().items_center().justify_center().cursor_pointer().text_color(secondary).hover(move |s| s.bg(hover).text_color(fg)), tip)
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| action(this, window, cx)))
            .child(icons::symbol(symbol).with_size(px(13.)))
            .into_any_element()
    }

    fn switch(&self, id: &'static str, on: bool, tip: &'static str, cx: &mut Context<Self>, set: impl Fn(&mut Self, bool, &mut App) + 'static) -> AnyElement {
        self.switch_owned(id.to_owned(), on, tip.to_owned(), cx, set)
    }

    fn switch_owned(&self, id: String, on: bool, tip: String, cx: &mut Context<Self>, set: impl Fn(&mut Self, bool, &mut App) + 'static) -> AnyElement {
        let shown = tip.clone();
        let me = cx.entity().downgrade();
        let set = std::rc::Rc::new(set);
        div()
            .id(SharedString::from(format!("{id}-holder")))
            .test_support()
            .aria_label(tip)
            .tooltip(move |window, cx| Tooltip::new(shown.clone()).build(window, cx))
            .flex_none()
            .child(Switch::new(SharedString::from(id)).checked(on).small().on_click(move |on: &bool, _, cx| {
                let (on, set) = (*on, set.clone());
                me.update(cx, |this, cx| set(this, on, cx)).ok();
            }))
            .into_any_element()
    }

    /// A pop-up menu: what's chosen, and the choices, each the change it
    /// sends (`settings.update`).
    fn menu(&self, id: &'static str, label: String, face: Option<Icon>, tip: &'static str, choices: Vec<(String, bool, Value)>, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity().downgrade();
        let mut button = Button::new(id).label(label).small().secondary().dropdown_caret(true).tooltip(tip);
        if let Some(face) = face {
            button = button.icon(face);
        }
        div()
            .id(SharedString::from(format!("{id}-holder")))
            .test_support()
            .aria_label(tip)
            .flex_none()
            .child(button.dropdown_menu(move |menu: PopupMenu, _, _| {
                let mut menu = menu;
                for (title, checked, change) in &choices {
                    let (me, change) = (me.clone(), change.clone());
                    menu = menu.item(PopupMenuItem::new(title.clone()).checked(*checked).on_click(move |_, _, cx| {
                        let change = change.clone();
                        me.update(cx, |this, cx| this.update(change, cx)).ok();
                    }));
                }
                menu
            }))
            .into_any_element()
    }
}

/// Why there are no runner settings to show yet (`settingsWaiting`).
fn waiting_text(app: &WeakEntity<Threadbear>, cx: &App) -> String {
    let Some(app) = app.upgrade() else { return "Not connected to the runner.".into() };
    let t = app.read(cx);
    if t.settings_unsupported {
        "This runner is too old for settings. It gets them when it next updates.".into()
    } else if !matches!(t.status, threadbear_client::runner::Status::Connected { .. }) {
        "Not connected to the runner.".into()
    } else {
        "Loading…".into()
    }
}

/// `SettingsSection`: its title, with what it is and what to ask your agent
/// behind the ⓘ, over its rows in a rounded group.
fn section(id: &'static str, title: &'static str, about: &str, ask: &str, rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    let hairline = style::hairline(cx);
    let mut group = v_flex();
    let count = rows.len();
    for (i, r) in rows.into_iter().enumerate() {
        group = group.child(r);
        if i + 1 < count {
            group = group.child(div().h(gpui_kit::px(1.)).mx(px(12.)).bg(hairline));
        }
    }
    section_with_body(id, title, about, ask, group.into_any_element(), cx)
}

fn section_with_body(id: &'static str, title: &'static str, about: &str, ask: &str, body: AnyElement, cx: &App) -> AnyElement {
    let info = format!("{about}\n\nAsk your agent to {ask}");
    v_flex()
        .id(id)
        .gap(px(6.))
        .child(h_flex().gap(px(6.)).items_center().px(px(4.)).child(div().text_size(px(13.)).line_height(px(16.)).font_semibold().child(title)).child(info_tip(SharedString::from(format!("{id}-info")), info, cx)))
        .child(div().rounded(px(8.)).bg(style::primary_opacity(cx, 0.04)).border_1().border_color(style::hairline(cx)).child(body))
        .into_any_element()
}

/// A row of a group: what it is on the left, its control on the right.
fn row(label: &'static str, control: impl IntoElement, cx: &App) -> AnyElement {
    row_with(div().child(label).into_any_element(), control.into_any_element(), cx)
}

fn row_with(label: AnyElement, control: AnyElement, _cx: &App) -> AnyElement {
    h_flex()
        .min_h(px(36.))
        .px(px(12.))
        .py(px(6.))
        .gap(px(12.))
        .items_center()
        .text_size(px(13.))
        .line_height(px(17.))
        .child(div().flex_1().min_w_0().child(label))
        .child(control)
        .into_any_element()
}

/// A line on its own in place of a section (`Section { Text(...) }`).
fn plain_note(text: &str, cx: &App) -> AnyElement {
    div().px(px(4.)).text_size(px(13.)).line_height(px(17.)).text_color(style::secondary_text(cx)).child(text.to_owned()).into_any_element()
}

impl Render for SettingsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (settings, error) = match self.app.upgrade() {
            Some(app) => {
                let t = app.read(cx);
                (t.runner_settings.as_ref().map(RunnerSettings::decode), t.settings_error.clone())
            }
            None => (None, None),
        };
        let mut sections = match self.tab {
            Tab::General => self.render_general(settings.as_ref(), window, cx),
            Tab::Models => self.render_models(settings.as_ref(), cx),
            other => vec![plain_note(&format!("{} isn't in this app yet. The Swift app's Settings has it for now.", other.title()), cx)],
        };
        // The last change that didn't take, under the form (`SettingsErrorRow`).
        if let Some(error) = error.filter(|_| matches!(self.tab, Tab::General | Tab::Models)) {
            sections.push(
                h_flex()
                    .px(px(4.))
                    .gap(px(6.))
                    .items_center()
                    .text_size(px(13.))
                    .text_color(style::failed(cx))
                    .child(icons::symbol("exclamationmark.triangle").with_size(px(13.)))
                    .child(div().flex_1().child(error))
                    .into_any_element(),
            );
        }
        let sidebar = self.render_sidebar(cx);
        h_flex()
            .id("settings-window")
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(sidebar)
            .child(
                div().id("settings-pane").flex_1().min_w_0().h_full().overflow_y_scroll().track_scroll(&self.scroll).child(
                    // A grouped form stops its rows at about 700 points; wider
                    // than that adds even sides.
                    h_flex().w_full().justify_center().child(v_flex().w_full().max_w(px(700.)).px(px(20.)).pt(px(16.)).pb(px(24.)).gap(px(18.)).children(sections)),
                ),
            )
    }
}

/// The window in the dump, for the specs: which section is showing, and what
/// its switches and menus say.
#[cfg(feature = "automation")]
impl SettingsWindow {
    pub(crate) fn dump(&self, cx: &App) -> Value {
        let settings = self.app.upgrade().and_then(|a| a.read(cx).runner_settings.as_ref().map(RunnerSettings::decode));
        json!({
            "tab": self.tab.name(),
            "appearance": style::appearance().name(),
            "defaultFolder": settings.as_ref().map(|s| s.default_cwd.clone()),
            "keepAwake": settings.as_ref().and_then(|s| s.keep_awake),
            "labReview": settings.as_ref().map(|s| s.lab_review),
            "privateFolders": settings.as_ref().map(|s| s.private_folders.clone()),
            "smallJobsPool": settings.as_ref().and_then(|s| s.pool.clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Tab;

    #[test]
    fn tabs_go_by_the_swift_apps_names() {
        for tab in Tab::ALL {
            assert_eq!(Tab::from_name(tab.name()), Some(tab));
        }
    }
}
