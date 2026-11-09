// The left side of the window: search, the sections and their rows.
use crate::app::Threadbear;
use crate::now_ms;
use gpui_kit::component::input::Input;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use threadbear_client::runner::Status;
use threadbear_core::inbox;

impl Threadbear {
    pub(crate) fn render_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (side, border, muted, accent_bg, fg) = (theme.sidebar, theme.sidebar_border, theme.muted_foreground, theme.sidebar_accent, theme.sidebar_foreground);
        let (orange, blue, green, red) = (theme.warning, theme.blue, theme.success, theme.danger);
        let now = now_ms();
        let sections = self.shown_sections(cx, now);
        let conn = match self.status {
            Status::Connected { .. } => green,
            Status::Connecting { .. } => muted,
            Status::Disconnected { .. } => red,
        };
        let mut ix = 0usize;
        let mut list = v_flex().gap_0p5().px_2().pb_4();
        for section in sections {
            let key = section.key;
            let folded = self.folded.contains(key);
            list = list.child(
                h_flex()
                    .id(key)
                    .gap_1()
                    .px_2()
                    .pt_3()
                    .pb_1()
                    .text_xs()
                    .font_semibold()
                    .text_color(muted)
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        if !this.folded.remove(key) {
                            this.folded.insert(key);
                        }
                        cx.notify();
                    }))
                    .child(section.title)
                    .child(div().font_normal().child(section.rows.len().to_string())),
            );
            if folded {
                continue;
            }
            if section.rows.is_empty() {
                list = list.child(div().px_2().text_sm().text_color(muted).child("Nothing here"));
            }
            for row in section.rows {
                ix += 1;
                let selected = self.selected.as_deref() == Some(row.id.as_str());
                let dot = if row.busy() { Some(blue.opacity(0.5)) } else if row.wants_you() { Some(orange) } else if row.unread() { Some(blue) } else { None };
                let id = row.id.clone();
                list = list.child(
                    h_flex()
                        .id(("row", ix))
                        .items_start()
                        .gap_2()
                        .px_2()
                        .py_1p5()
                        .rounded_md()
                        .cursor_pointer()
                        .hover(|s| s.bg(accent_bg.opacity(0.6)))
                        .when(selected, |s| s.bg(accent_bg))
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.open(id.clone(), window, cx)))
                        .child(div().mt(px(7.)).size(px(7.)).flex_none().rounded_full().when_some(dot, |s, c| s.bg(c)))
                        .child(
                            v_flex()
                                .min_w_0()
                                .flex_1()
                                .child(div().text_sm().font_medium().text_color(fg).truncate().child(row.title.clone()))
                                .child(div().text_xs().text_color(muted).truncate().child(format!("{} · {}", row.place(), inbox::ago(row.activity_ms(), now)))),
                        ),
                );
            }
        }
        v_flex()
            .w(px(300.))
            .h_full()
            .flex_none()
            .bg(side)
            .border_r_1()
            .border_color(border)
            .child(
                h_flex()
                    .justify_between()
                    .px_4()
                    .pt_3()
                    .pb_2()
                    .child(div().font_semibold().text_color(fg).child("Threadbear (GPUI)"))
                    .child(div().size(px(8.)).rounded_full().bg(conn)),
            )
            .child(div().px_3().pb_2().child(Input::new(&self.search).small().cleanable(true)))
            .when_some(self.connection_note(), |s, note| s.child(div().mx_3().mb_2().p_2().rounded_md().bg(theme_muted(cx)).text_sm().text_color(muted).child(note)))
            .when_some(self.list_error.clone(), |s, e| s.child(div().mx_3().mb_2().text_sm().text_color(red).child(e)))
            .child(div().flex_1().min_h_0().child(list.size_full().overflow_y_scrollbar()))
    }
}

fn theme_muted(cx: &App) -> Hsla {
    cx.theme().muted
}
