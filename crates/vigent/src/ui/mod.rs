//! Drawing: the sidebar, the agent's transcript (or the start screen), the
//! statusline and the message line, like the TypeScript vigent's layout.
//!
//! EXTENSION POINT: each part of the screen is its own file and returns lines
//! (or draws into the Rect it's given); this file only lays them out. A new
//! part (a picker, the which-key hint, a split) is a new file here and one
//! call in [`draw`].

pub mod dashboard;
pub mod floats;
pub mod markdown;
pub mod sidebar;
pub mod statusline;
pub mod text;
pub mod transcript;
pub mod winbar;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::{Block, Paragraph};

use crate::app::App;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// The spinner's frame now.
pub fn spinner(app: &App) -> &'static str {
    SPINNER[(app.started.elapsed().as_millis() / 80) as usize % SPINNER.len()]
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let t = &app.theme;
    let area = f.area();
    f.render_widget(Block::default().style(t.normal()), area);
    if area.height < 4 || area.width < 20 {
        return;
    }
    let body_h = area.height - 2;
    // [ui] sidebar, sidebar_width, sidebar_position (src/app.ts sidebarWidth)
    let ui = &app.config.ui;
    let side = if ui.sidebar && area.width >= ui.sidebar_width + 40 { ui.sidebar_width } else { 0 };
    let right = ui.sidebar_position == "right";
    let main_w = area.width - side - u16::from(side > 0);
    let main_x = if right || side == 0 { 0 } else { side + 1 };
    if side > 0 {
        let (sx, sep_x) = if right { (main_w + 1, main_w) } else { (0, side) };
        let r = Rect::new(sx, 0, side, body_h);
        let sb = t.hl("VigentSidebar");
        f.render_widget(Paragraph::new(sidebar::lines(app, r)).style(sb), r);
        let sep: Vec<Line> = (0..body_h).map(|_| Line::from("│")).collect();
        f.render_widget(Paragraph::new(sep).style(t.hl("WinSeparator")), Rect::new(sep_x, 0, 1, body_h));
    }
    let main = Rect::new(main_x, 0, main_w, body_h);
    f.render_widget(Paragraph::new(winbar::line(app, main.width as usize)), Rect::new(main.x, 0, main.width, 1));
    let pane = Rect::new(main.x + 1, 1, main.width.saturating_sub(2), body_h - 1);
    app.page = pane.height as usize;
    let lines = if app.focused().is_some() { transcript::lines(app, pane.width as usize) } else { dashboard::lines(app, pane) };
    let h = pane.height as usize;
    let shown: Vec<Line> = if app.focused().is_none() {
        lines.into_iter().take(h).collect()
    } else if lines.len() <= h {
        app.scroll = 0;
        let mut v = vec![Line::default(); h - lines.len()];
        v.extend(lines);
        v
    } else {
        app.scroll = app.scroll.min(lines.len() - h);
        let start = lines.len() - h - app.scroll;
        lines.into_iter().skip(start).take(h).collect()
    };
    f.render_widget(Paragraph::new(shown), pane);

    statusline::draw(f, app, Rect::new(0, body_h, area.width, 1));
    statusline::draw_message(f, app, Rect::new(0, body_h + 1, area.width, 1));
    floats::draw(f, app, area, body_h);
    crate::settings::draw_any(f, app, area);
}
