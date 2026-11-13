//! The sessions sidebar: each agent with its state, branch and changes, then
//! the engines. (Windows area: focus, j/k, cards and compact styles, icons.)

use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use super::spinner;
use super::text::{fit, pad, width};
use crate::app::App;
use crate::session::State;

pub const WIDTH: u16 = 30;

pub fn lines(app: &App, area: Rect) -> Vec<Line<'static>> {
    let t = &app.theme;
    let w = area.width as usize;
    let header = |name: &str, right: String| {
        Line::from(vec![
            Span::styled(format!(" {}", pad(name, w.saturating_sub(width(&right) + 2))), t.fg("Title").add_modifier(Modifier::BOLD)),
            Span::styled(format!("{right} "), t.fg("Comment")),
        ])
    };
    let open = app.open();
    let mut top = vec![header("SESSIONS", open.len().to_string())];
    let spin = spinner(app);
    for (n, &i) in open.iter().enumerate() {
        let a = &app.sessions[i];
        let last = n + 1 == open.len();
        let (icon, group) = match a.state {
            _ if a.held() => (spin, "VigentSpinner"),
            State::Running => (spin, "VigentSpinner"),
            State::Waiting => ("◐", "WarningMsg"),
            State::Error => ("✗", "ErrorMsg"),
            State::Paused => ("‖", "WarningMsg"),
            State::Idle => ("○", "Comment"),
        };
        let mark = if a.state == State::Waiting { " ◆" } else { "" };
        let queued = if a.queue.is_empty() { String::new() } else { format!(" ⧗{}", a.queue.len()) };
        let focused = i == app.focus;
        let name_style = if focused { t.fg("Normal").add_modifier(Modifier::BOLD) } else { t.fg("Normal") };
        let num_style = if focused { t.fg("CursorLineNr") } else { t.fg("LineNr") };
        let name = fit(&format!("{}{mark}{queued}", a.name), w.saturating_sub(8));
        let mut row = Line::from(vec![
            Span::styled(format!("{:>3} ", n + 1), num_style),
            Span::styled(if last { "└╴" } else { "├╴" }, t.fg("NonText")),
            Span::styled(format!("{icon} "), t.fg(group)),
            Span::styled(name, name_style),
        ]);
        if focused {
            row = row.style(t.hl("CursorLine"));
        }
        top.push(row);
        if let Some(branch) = &a.branch {
            // "     │   ⎇ " is 11 columns, then the branch, then " +a −r"
            let stat = format!(" +{} −{}", a.stat.0, a.stat.1);
            let b = fit(branch, w.saturating_sub(11 + width(&stat)));
            top.push(Line::from(vec![
                Span::styled(format!("     {}   ", if last { " " } else { "│" }), t.fg("NonText")),
                Span::styled(format!("⎇ {b}"), t.fg("Comment")),
                Span::styled(format!(" +{}", a.stat.0), t.fg("Added")),
                Span::styled(format!(" −{}", a.stat.1), t.fg("Removed")),
            ]));
        }
    }
    let mut bottom = vec![header("ENGINES", format!("{}/{}", app.engines.ready_count(), app.engines.infos.len()))];
    let default = app.new_agent_engine();
    for e in &app.engines.infos {
        let name = e.name.as_str();
        // TS: connected ● (default), installed ◐ (checking…, how to sign in), else ○ not installed
        let (icon, group) = if e.connected { ("●", "String") } else if e.installed { ("◐", "WarningMsg") } else { ("○", "Comment") };
        let note = if e.checking {
            "checking…".to_string()
        } else if e.connected {
            if e.id == default { "default".into() } else { String::new() }
        } else if e.id == "pi" && e.installed {
            "no API key".into()
        } else if e.installed {
            e.connect.clone().unwrap_or_else(|| "not signed in".into())
        } else {
            "not installed".into()
        };
        let room = w.saturating_sub(width(&format!("  {icon} {name}")) + 1);
        let status = if note.is_empty() { note } else { fit(&note, room.saturating_sub(1)) };
        let status = status.as_str();
        let left = format!("  {icon} {name}");
        bottom.push(Line::from(vec![
            Span::styled(format!("  {icon} "), t.fg(group)),
            Span::styled(pad(name, w.saturating_sub(width(&left) - width(name) + width(status) + 1)), t.fg("Normal")),
            Span::styled(status.to_string(), t.fg("Comment").add_modifier(Modifier::ITALIC)),
        ]));
    }
    let h = area.height as usize;
    let mut lines = top;
    lines.truncate(h.saturating_sub(bottom.len()));
    while lines.len() + bottom.len() < h {
        lines.push(Line::from(Span::styled("~", t.fg("NonText"))));
    }
    lines.extend(bottom);
    lines
}

