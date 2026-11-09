// The Swift app's sizes and colours (Transcript/Theme.swift, TypeScale), so the
// two apps look alike and there's one place to change them. Colours take the
// light or dark value from the window's theme.
#![allow(dead_code)] // Filled in ahead of the views that use each value.
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::*;

/// Text sizes, as TypeScale has them at 100% zoom.
pub mod size {
    pub const BODY: f32 = 15.;
    pub const BODY_LINE: f32 = 23.;
    pub const WORK: f32 = 14.;
    pub const WORK_LINE: f32 = 20.;
    pub const CODE: f32 = 13.;
    pub const CODE_LINE: f32 = 19.5;
    pub const CARD_TITLE: f32 = 14.;
    pub const LABEL: f32 = 13.;
    pub const DETAIL: f32 = 12.;
    pub const SMALL: f32 = 11.;
    pub const SIDEBAR_TITLE: f32 = 14.;
    pub const SIDEBAR_PREVIEW: f32 = 13.;
    pub const SIDEBAR_META: f32 = 11.;
    pub const SIDEBAR_HEADING: f32 = 13.;
    pub const HEADER: f32 = 15.;
    pub const COMPOSER: f32 = 15.;
    pub const CHIP: f32 = 13.;
}

/// Widest the reading column gets; wider windows centre it.
pub const MAX_CONTENT_WIDTH: f32 = 780.;
pub const SIDE_INSET: f32 = 28.;

fn pick(cx: &App, dark: Hsla, light: Hsla) -> Hsla {
    if cx.theme().is_dark() {
        dark
    } else {
        light
    }
}

fn white(alpha: f32) -> Hsla {
    hsla(0., 0., 1., alpha)
}

fn black(alpha: f32) -> Hsla {
    hsla(0., 0., 0., alpha)
}

pub fn card_background(cx: &App) -> Hsla {
    pick(cx, white(0.035), black(0.02))
}

pub fn card_border(cx: &App) -> Hsla {
    pick(cx, white(0.12), black(0.12))
}

pub fn code_background(cx: &App) -> Hsla {
    pick(cx, white(0.045), black(0.03))
}

pub fn inline_code_background(cx: &App) -> Hsla {
    pick(cx, white(0.085), black(0.05))
}

pub fn hover_fill(cx: &App) -> Hsla {
    pick(cx, white(0.05), black(0.04))
}

pub fn hairline(cx: &App) -> Hsla {
    pick(cx, white(0.1), black(0.1))
}

pub fn faint_text(cx: &App) -> Hsla {
    pick(cx, white(0.36), black(0.45))
}

pub fn quiet_text(cx: &App) -> Hsla {
    pick(cx, white(0.55), black(0.6))
}

pub fn button_fill(cx: &App) -> Hsla {
    pick(cx, white(0.12), white(1.))
}

pub fn button_edge(cx: &App) -> Hsla {
    pick(cx, white(0.08), black(0.18))
}
