//! Drawing (src/app.ts render): the sidebar (left or right), the windows
//! over the transcript with their winbars, the statusline (or the wildmenu),
//! the command line, and over them the which-key panel, a picker or a float.
//! Every row is built as styled pieces exactly the screen's width, like the
//! TypeScript's strings, then drawn.
//!
//! EXTENSION POINT: each part of the screen is its own file and returns rows
//! of [`text::Seg`]s (or draws into the Rect it's given); this file only lays
//! them out. A new part is a new file here and one call in [`draw`].

pub mod dashboard;
pub mod floats;
pub mod icons;
pub mod markdown;
pub mod pane;
pub mod picker;
pub mod sidebar;
pub mod statusline;
pub mod text;
pub mod whichkey;
pub mod winbar;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::widgets::{Block, Clear, Paragraph};

use crate::app::App;
use text::{Seg, exact, to_line};

/// The spinner's frame now.
pub fn spinner(app: &App) -> &'static str {
    const BRAILLE: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const ASCII: [&str; 4] = ["|", "/", "-", "\\"];
    let frame = (app.started.elapsed().as_millis() / 120) as usize;
    if app.config.ui.icons == "ascii" { ASCII[frame % ASCII.len()] } else { BRAILLE[frame % BRAILLE.len()] }
}

/// A hyperlink on screen: row, first column, columns, URL.
pub type LinkSpot = (u16, u16, u16, String);

/// Every screen row, exactly `cols` wide, and the hyperlinks in them.
pub fn rows(app: &App) -> Vec<Vec<Seg>> {
    let t = &app.theme;
    let (cols, nrows) = (app.windows.cols as usize, app.windows.rows as usize);
    let side_h = nrows.saturating_sub(2).max(1);
    let sb_w = pane::sidebar_width(app, app.windows.cols) as usize;
    let sidebar = if sb_w > 0 { sidebar::lines(app, sb_w, side_h) } else { vec![] };
    let normal_bg = t.normal().bg;
    let sep_style = match normal_bg {
        Some(bg) => t.fg("WinSeparator").bg(bg),
        None => t.fg("WinSeparator"),
    };
    let sep = Seg::new(pane::icon_set(app).sep, sep_style);
    let area = pane::pane_area(app);
    let panes = pane::draw_panes(app, area, &sep);
    let right = app.config.ui.sidebar_position == "right";
    let mut out: Vec<Vec<Seg>> = vec![];
    for r in 0..side_h {
        let mut row = vec![];
        let p = panes.get(r).cloned().unwrap_or_default();
        if sb_w > 0 && !right {
            row.extend(sidebar.get(r).cloned().unwrap_or_default());
            row.push(sep.clone());
        }
        row.extend(p);
        if sb_w > 0 && right {
            row.push(sep.clone());
            row.extend(sidebar.get(r).cloned().unwrap_or_default());
        }
        out.push(exact(row, cols, t.normal()));
    }
    if crate::actions::windows::which_key_waiting(app) {
        let panel = whichkey::panel(app, cols, 3.max(side_h / 2));
        let n = panel.len().min(out.len());
        let at = out.len() - n;
        for (i, row) in panel.into_iter().take(n).enumerate() {
            out[at + i] = exact(row, cols, t.normal());
        }
    }
    out.push(statusline::wildmenu(app, cols).unwrap_or_else(|| statusline::statusline(app, cols)));
    out.push(statusline::cmdline(app, cols));
    let skip = out.len().saturating_sub(nrows);
    out.into_iter().skip(skip).collect()
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    app.windows.cols = area.width;
    app.windows.rows = area.height;
    let t = &app.theme;
    f.render_widget(Block::default().style(t.normal()), area);
    if area.height < 3 || area.width < 10 {
        return;
    }
    // what the half-page keys of other areas measure
    app.page = pane::content_height(pane::window_rect(app));
    let rows = rows(app);
    let mut links: Vec<LinkSpot> = vec![];
    for (y, row) in rows.iter().enumerate() {
        let mut x = 0u16;
        for s in row {
            let w = text::width(&s.text) as u16;
            if let Some(url) = &s.link
                && w > 0
            {
                links.push((y as u16, x, w, url.clone()));
            }
            x += w;
        }
    }
    let lines: Vec<_> = rows.into_iter().map(to_line).collect();
    f.render_widget(Paragraph::new(lines), area);
    // a picker (the @ file picker, every area's choices)
    if let Some(p) = &app.windows.picker {
        let (w, r) = picker_rect(app, p, area);
        let plines = p.lines(w as usize, &app.theme, &app.config.ui.icons);
        f.render_widget(Clear, r);
        f.render_widget(Paragraph::new(plines), r);
        links.retain(|(y, ..)| *y < r.y || *y >= r.y + r.height);
    }
    floats::draw(f, app, area, area.height.saturating_sub(2));
    if app.float.is_some() {
        links.clear();
    }
    app.windows.links = links;
}

/// Where a picker goes.
fn picker_rect(app: &App, p: &picker::Picker, area: Rect) -> (u16, Rect) {
    let h = (p.height() as u16).min(area.height);
    match p.place {
        picker::Place::Center { width } => {
            let w = width.min(area.width.saturating_sub(4)).max(22);
            (w, Rect::new(area.width.saturating_sub(w) / 2, area.height.saturating_sub(h) / 2, w.min(area.width), h))
        }
        picker::Place::BottomLeft { col, offset_y, width } => {
            let w = width.min(area.width.saturating_sub(col)).max(22).min(area.width);
            let bottom = (area.height as i32 + offset_y as i32).max(h as i32);
            let y = (bottom - h as i32).max(0) as u16;
            let x = col.min(area.width.saturating_sub(w));
            let _ = app;
            (w, Rect::new(x, y, w, h))
        }
    }
}

/// After a frame: make the links on screen clickable (OSC 8), printing their
/// cells again inside the hyperlink, since a terminal ties a link to what is
/// printed while it's open.
pub fn write_links(app: &App, buf: &ratatui::buffer::Buffer, out: &mut impl std::io::Write) {
    use crossterm::queue;
    use crossterm::style::{Attribute, Print, SetAttribute, SetBackgroundColor, SetForegroundColor};
    for (y, x, w, url) in &app.windows.links {
        let _ = queue!(out, crossterm::cursor::MoveTo(*x, *y));
        let _ = queue!(out, Print(format!("\x1b]8;;{url}\x1b\\")));
        let mut col = *x;
        while col < x + w {
            let Some(cell) = buf.cell((col, *y)) else { break };
            let s = cell.style();
            let _ = queue!(out, SetAttribute(Attribute::Reset));
            if let Some(fg) = s.fg.and_then(term_color) {
                let _ = queue!(out, SetForegroundColor(fg));
            }
            if let Some(bg) = s.bg.and_then(term_color) {
                let _ = queue!(out, SetBackgroundColor(bg));
            }
            if s.add_modifier.contains(ratatui::style::Modifier::UNDERLINED) {
                let _ = queue!(out, SetAttribute(Attribute::Underlined));
            }
            if s.add_modifier.contains(ratatui::style::Modifier::BOLD) {
                let _ = queue!(out, SetAttribute(Attribute::Bold));
            }
            let sym = cell.symbol().to_string();
            let cw = text::width(&sym).max(1) as u16;
            let _ = queue!(out, Print(sym));
            col += cw;
        }
        let _ = queue!(out, Print("\x1b]8;;\x1b\\"), SetAttribute(Attribute::Reset));
    }
    let _ = out.flush();
}

fn term_color(c: ratatui::style::Color) -> Option<crossterm::style::Color> {
    use ratatui::style::Color as R;
    Some(match c {
        R::Rgb(r, g, b) => crossterm::style::Color::Rgb { r, g, b },
        R::Indexed(i) => crossterm::style::Color::AnsiValue(i),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(app: &App) -> Vec<String> {
        rows(app).iter().map(|r| text::segs_plain(r)).collect()
    }

    #[test]
    fn the_start_screen_the_sidebar_and_the_statusline() {
        let mut a = crate::app::tests::app();
        a.windows.cols = 130;
        a.windows.rows = 30;
        let s = screen(&a);
        assert_eq!(s.len(), 30);
        assert!(s.iter().any(|l| l.contains("New agent: type a task, Enter") && l.trim_end().ends_with("    i")), "{s:#?}");
        assert!(s[0].starts_with(" SESSIONS"));
        assert!(s[28].contains(" NORMAL  [no session]"), "{}", s[28]);
        a.config.ui.sidebar_position = "right".into();
        let s = screen(&a);
        assert!(s[0].find("SESSIONS").unwrap() > 80);
        a.config.ui.icons = "nerd".into();
        a.config.style.separators = Some("round".into());
        assert!(screen(&a)[28].starts_with('\u{e0b6}'));
        a.config.ui.sidebar = false;
        assert!(!screen(&a)[0].contains("SESSIONS"));
    }
}
