//! The start screen, while no agent is open (like LazyVim's): the logo, its
//! one-key actions (App::dashboard_key) and the engines.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};

use super::text::{pad, width};
use crate::app::App;

const LOGO: [&str; 6] = [
    "██╗   ██╗██╗ ██████╗ ███████╗███╗   ██╗████████╗",
    "██║   ██║██║██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
    "██║   ██║██║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
    "╚██╗ ██╔╝██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
    " ╚████╔╝ ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
    "  ╚═══╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

pub fn lines(app: &App, area: Rect) -> Vec<Line<'static>> {
    let t = &app.theme;
    let w = area.width as usize;
    let center = |s: &str| " ".repeat(w.saturating_sub(width(s)) / 2);
    let mut lines: Vec<Line<'static>> = vec![];
    for l in LOGO {
        lines.push(Line::from(vec![Span::raw(center(l)), Span::styled(l, t.fg("Function"))]));
    }
    let tag = "coding agents, the vim way · each one in its own git worktree";
    lines.push(Line::from(vec![Span::raw(center(tag)), Span::styled(tag, t.fg("Comment"))]));
    lines.push(Line::default());
    let keys = [("✎", "New agent: type a task, Enter", "i"), ("✓", "Check engines", "c"), ("⌘", "Keys", "?"), ("×", "Quit", "q")];
    let row_w = 46;
    for (icon, label, key) in keys {
        let row = format!("{icon} {}{key}", pad(label, row_w - 3));
        lines.push(Line::from(vec![
            Span::raw(center(&row)),
            Span::styled(format!("{icon} "), t.fg("Special")),
            Span::styled(pad(label, row_w - 3), t.fg("Normal")),
            Span::styled(key, t.fg("Keyword")),
        ]));
    }
    lines.push(Line::default());
    let mut engines: Vec<Span<'static>> = vec![];
    let mut plain = String::new();
    for e in &app.engines.infos {
        let name = &e.name;
        let (glyph, group) = if e.connected { ("●", "String") } else if e.installed { ("◐", "WarningMsg") } else { ("○", "Comment") };
        let piece = format!("{glyph} {name}   ");
        plain += &piece;
        engines.push(Span::styled(piece, t.fg(group)));
    }
    engines.insert(0, Span::raw(center(plain.trim_end())));
    lines.push(Line::from(engines));
    let footer = format!(
        "⚡ vigent {} · {} themes · {} of {} engines ready",
        app.version,
        crate::theme::names().len(),
        app.engines.ready_count(),
        app.engines.infos.len()
    );
    lines.push(Line::from(vec![Span::raw(center(&footer)), Span::styled(footer, t.fg("Comment"))]));
    let top = (area.height as usize).saturating_sub(lines.len()) / 2;
    let mut out = vec![Line::default(); top];
    out.extend(lines);
    out
}

