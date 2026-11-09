// How each transcript row is drawn. The rows themselves come from the reducer
// in threadbear-core; this is the look, in the order RowContent lists them.
use crate::thread::ThreadPane;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use threadbear_core::reducer::{ApprovalOption, ApprovalText, Pending, Row, RowContent, RowDebug, ToolPresentation, TurnOutcome};

impl ThreadPane {
    pub(crate) fn render_item(&mut self, ix: usize, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.feed.model().rows().get(ix).cloned() else { return div().into_any_element() };
        let theme = cx.theme();
        let (muted_bg, muted, border, danger, warning, fg, green) = (theme.muted, theme.muted_foreground, theme.border, theme.danger, theme.warning, theme.foreground, theme.success);
        let column = |el: Div| h_flex().w_full().justify_center().child(el.w_full().max_w(px(760.)));
        let note = |text: String, color: Hsla| column(div().text_sm().text_center().text_color(color).child(text)).into_any_element();
        let el: AnyElement = match &row.content {
            RowContent::User(message) if message.shows_as_note() => note(message.text.clone(), muted),
            RowContent::User(message) => {
                let bubble = div().max_w(relative(0.8)).px_3p5().py_2().rounded_2xl().bg(muted_bg).text_color(fg).when(message.pending.is_some(), |s| s.opacity(0.6)).child(message.text.clone());
                let queued = matches!(message.pending, Some(Pending::Queued));
                column(h_flex().justify_end().when(queued, |s| s.child(div().text_xs().text_color(muted).mr_2().child("Queued"))).child(bubble)).into_any_element()
            }
            RowContent::Assistant(item) => column(div().child(TextView::markdown(ElementId::Name(format!("md-{}", item.item_id).into()), item.text.clone()).selectable(true))).into_any_element(),
            RowContent::Reasoning(item) => {
                let open = self.row_open(&row);
                let label = if item.is_streaming { "Thinking" } else { "Thought" };
                let mut col = v_flex().gap_1().child(self.chevron_line(ix, &row, label.to_string(), muted, cx));
                if open {
                    col = col.child(div().pl_3p5().text_sm().italic().text_color(muted).child(item.text.clone()));
                }
                column(col).into_any_element()
            }
            RowContent::Tool(tool) => {
                let open = self.row_open(&row);
                let title = if tool.failed() { format!("{} (failed)", tool.title()) } else { tool.title() };
                let mut col = v_flex().gap_1().child(self.chevron_line(ix, &row, title, if tool.failed() { danger } else { muted }, cx));
                if open {
                    col = col.child(div().pl_3p5().text_sm().font_family("monospace").text_color(muted).child(ToolPresentation::output_preview(tool, 40)));
                }
                column(col).into_any_element()
            }
            RowContent::Images { images, .. } => {
                let mut grid = h_flex().gap_2().flex_wrap();
                for image in images {
                    grid = grid.child(img(std::path::PathBuf::from(&image.path)).max_w(px(320.)).max_h(px(240.)).rounded_lg());
                }
                column(grid).into_any_element()
            }
            RowContent::Approval(item) => {
                match &item.resolution {
                    Some(res) => note(format!("{} ({})", ApprovalText::title(&item.request), ApprovalText::decision(res.decision)), muted),
                    None => {
                        let mut card = card(warning).child(div().font_semibold().child(ApprovalText::title(&item.request)));
                        let target = ApprovalText::target(&item.request);
                        if !target.is_empty() {
                            card = card.child(div().text_sm().font_family("monospace").text_color(fg).child(ApprovalText::shown(&target)));
                        }
                        let mut buttons = h_flex().gap_2();
                        for (j, option) in item.request.options.iter().enumerate() {
                            let (label, decision) = match option {
                                ApprovalOption::Allow => ("Allow", "allow"),
                                ApprovalOption::AllowAlways => ("Always allow", "allowAlways"),
                                ApprovalOption::Deny => ("Deny", "deny"),
                            };
                            let (id, thread) = (item.request.approval_id.clone(), self.summary.id.clone());
                            buttons = buttons.child(Button::new(("approve", ix * 10 + j)).small().label(label).when(matches!(option, ApprovalOption::Allow), |b| b.primary()).on_click(cx.listener(
                                move |this, _: &ClickEvent, _, cx| this.request("approvals.respond", json!({ "threadId": thread, "approvalId": id, "decision": decision }), cx),
                            )));
                        }
                        column(card.child(buttons)).into_any_element()
                    }
                }
            }
            RowContent::Question(item) => {
                let settled = item.resolution.is_some();
                let mut card = card(if settled { border } else { warning });
                let id = item.request.approval_id.clone();
                let chosen = self.chosen.get(&id).cloned().unwrap_or_default();
                for (qi, q) in item.request.questions.iter().enumerate() {
                    card = card.child(div().font_semibold().child(q.question.clone()));
                    if !settled {
                        let mut buttons = h_flex().gap_2().flex_wrap();
                        for (oi, option) in q.options.iter().enumerate() {
                            let picked = chosen.get(&qi).is_some_and(|c| c.contains(&option.label));
                            let (id, label, multi) = (id.clone(), option.label.clone(), q.multi_select);
                            buttons = buttons.child(Button::new(("pick", ix * 1000 + qi * 50 + oi)).small().label(option.label.clone()).when(picked, |b| b.primary()).on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                let picks = this.chosen.entry(id.clone()).or_default().entry(qi).or_default();
                                if multi {
                                    if let Some(at) = picks.iter().position(|p| *p == label) {
                                        picks.remove(at);
                                    } else {
                                        picks.push(label.clone());
                                    }
                                } else {
                                    *picks = vec![label.clone()];
                                }
                                cx.notify();
                            })));
                        }
                        card = card.child(buttons);
                    }
                }
                if settled {
                    card = card.child(div().text_sm().text_color(muted).child(item.resolution.as_ref().and_then(|r| r.message.clone()).unwrap_or_else(|| "Answered".into())));
                } else {
                    let (answers, line) = question_answers(item, &chosen);
                    let thread = self.summary.id.clone();
                    card = card.child(h_flex().child(Button::new(("answer", ix)).small().primary().label("Send answer").disabled(line.is_empty()).on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.request("approvals.respond", json!({ "threadId": thread, "approvalId": id, "decision": "answered", "answers": answers, "message": line }), cx)
                    }))));
                }
                column(card).into_any_element()
            }
            RowContent::Secret(item) => match item.resolved_text() {
                Some(text) => note(text, muted),
                None => {
                    let (id, thread) = (item.request.approval_id.clone(), self.summary.id.clone());
                    column(card(warning).child(div().font_semibold().child(item.request.label.clone())).child(div().text_sm().text_color(muted).child(item.request.reason.clone())).child(
                        h_flex().child(Button::new(("decline", ix)).small().label("Decline").on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.request("secrets.answer", json!({ "threadId": thread, "approvalId": id, "decline": true }), cx)
                        }))),
                    ))
                    .into_any_element()
                }
            },
            RowContent::Review(review) => column(card(border).child(div().font_semibold().child(review.title.clone())).child(div().text_sm().text_color(muted).child("Options to compare"))).into_any_element(),
            RowContent::Plan(_) | RowContent::Note(_) | RowContent::Gap(_) | RowContent::Background(_) | RowContent::Working(_) => note(RowDebug::text(&row), muted),
            RowContent::PlanCard(_) => column(card(border).child(div().text_sm().child(RowDebug::text(&row)))).into_any_element(),
            RowContent::Footer(done) => {
                let color = if done.outcome == TurnOutcome::Completed { muted } else { danger };
                column(div().text_xs().text_color(color).child(RowDebug::text(&row))).into_any_element()
            }
            RowContent::Asks(asks) if asks.is_done() => {
                let mut col = v_flex().gap_1().child(div().font_semibold().child("Done"));
                for next in &asks.next {
                    col = col.child(div().text_sm().text_color(muted).child(next.clone()));
                }
                column(card(border).child(col)).into_any_element()
            }
            RowContent::Asks(asks) => {
                let mut card = card(if asks.is_open { warning } else { border });
                for (ai, ask) in asks.asks.iter().enumerate() {
                    let mut block = v_flex().gap_1().child(div().font_semibold().child(ask.action.clone()));
                    if let Some(why) = &ask.why {
                        block = block.child(div().text_sm().text_color(muted).child(TextView::markdown(("why", ix * 10 + ai), why.clone())));
                    }
                    if asks.is_open && !ask.options.is_empty() {
                        let mut buttons = h_flex().gap_2().flex_wrap().pt_1();
                        for (oi, option) in ask.options.iter().enumerate() {
                            let text = format!("{}\n{}", ask.action, option);
                            let answers = json!([{ "action": ask.action, "answer": option }]);
                            buttons = buttons.child(Button::new(("ask", ix * 100 + ai * 10 + oi)).small().label(option.clone()).when(ask.suggested == Some(oi), |b| b.primary()).on_click(cx.listener(
                                move |this, _: &ClickEvent, _, cx| this.send(text.clone(), Some(answers.clone()), cx),
                            )));
                        }
                        block = block.child(buttons);
                    }
                    card = card.child(block);
                }
                column(card).into_any_element()
            }
            RowContent::Error { message, .. } => note(message.clone(), danger),
            RowContent::Group(group) => {
                let color = if group.failed_count > 0 { danger } else { muted };
                column(v_flex().child(self.chevron_line(ix, &row, group.summary.clone(), color, cx))).into_any_element()
            }
            RowContent::Changes(changes) => {
                let mut card = card(border).child(div().font_semibold().text_sm().child(changes.title()));
                for file in &changes.files {
                    card = card.child(h_flex().gap_2().text_sm().child(div().flex_1().truncate().child(file.path.clone())).child(div().text_color(green).child(format!("+{}", file.added))).child(div().text_color(danger).child(format!("-{}", file.removed))));
                }
                column(card).into_any_element()
            }
        };
        // A row folded into a group sits indented under it.
        if row.in_group {
            div().pl_6().child(el).into_any_element()
        } else {
            el
        }
    }

    fn chevron_line(&self, ix: usize, row: &Row, title: String, color: Hsla, cx: &mut Context<Self>) -> Stateful<Div> {
        let open = self.row_open(row);
        let row = row.clone();
        h_flex()
            .id(("line", ix))
            .gap_1p5()
            .cursor_pointer()
            .text_sm()
            .text_color(color)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_row(&row, cx)))
            .child(if open { "▾" } else { "▸" })
            .child(div().truncate().child(title))
    }
}

/// approvals.respond's answers for a question card, as the Mac app makes
/// them: each question's picks joined with ", ", and the whole lot in one
/// line, in the order asked.
fn question_answers(item: &threadbear_core::reducer::QuestionItem, chosen: &HashMap<usize, Vec<String>>) -> (serde_json::Map<String, Value>, String) {
    let mut answers = serde_json::Map::new();
    let mut line = vec![];
    for (i, q) in item.request.questions.iter().enumerate() {
        let picks: Vec<&str> = q.options.iter().filter(|o| chosen.get(&i).is_some_and(|c| c.contains(&o.label))).map(|o| o.label.as_str()).collect();
        if !picks.is_empty() {
            let joined = picks.join(", ");
            answers.insert(q.question.clone(), Value::String(joined.clone()));
            line.push(joined);
        }
    }
    (answers, line.join("; "))
}

fn card(border: Hsla) -> Div {
    v_flex().gap_3().p_3p5().rounded_xl().border_1().border_color(border)
}

