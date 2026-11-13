//! The statusline (mode, agent, branch ... model, usage, agents) and the
//! message line under it (messages, or the prompt / command line being typed).
//! (Windows area: [statusline] left/right parts, separators, showcmd.)

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthChar;

use super::text::{fit, width};
use crate::app::{App, Mode};

pub fn draw(f: &mut Frame, app: &App, r: Rect) {
    let t = &app.theme;
    let (mode, mode_group) = match app.mode {
        Mode::Normal => ("NORMAL", "VigentModeNormal"),
        Mode::Insert => ("INSERT", "VigentModeInsert"),
        Mode::Command => ("COMMAND", "VigentModeCommand"),
        Mode::Search => ("SEARCH", "VigentModeCommand"),
        Mode::Visual => ("VISUAL", "VigentModeVisual"),
    };
    let sl = t.hl("StatusLine");
    let mut left = vec![Span::styled(format!(" {mode} "), t.hl(mode_group).add_modifier(Modifier::BOLD))];
    let mut right = String::new();
    match app.focused() {
        Some(a) => {
            left.push(Span::styled(format!(" {}", a.name), sl.add_modifier(Modifier::BOLD)));
            if let Some(b) = &a.branch {
                left.push(Span::styled(format!(" ⎇ {b} +{} −{}", a.stat.0, a.stat.1), sl));
            }
            let open = app.open();
            let waiting = open.iter().filter(|&&i| app.sessions[i].busy()).count();
            right = format!("{}  {}  {waiting}/{} ", a.model.as_deref().unwrap_or(""), a.usage(), open.len());
        }
        None => left.push(Span::styled(" [no session]", sl)),
    }
    let used: usize = left.iter().map(|s| width(&s.content)).sum();
    let gap = (r.width as usize).saturating_sub(used + width(&right));
    left.push(Span::styled(" ".repeat(gap), sl));
    left.push(Span::styled(right, sl));
    f.render_widget(Paragraph::new(Line::from(left)).style(sl), r);
}

/// The message line, and the cursor while typing.
pub fn draw_message(f: &mut Frame, app: &App, r: Rect) {
    let t = &app.theme;
    let y = r.y;
    let msg = match app.mode {
        Mode::Insert => {
            let mut spans = vec![Span::styled("-- INSERT --  ", t.fg("ModeMsg").add_modifier(Modifier::BOLD)), Span::styled("❯ ", t.fg("Identifier"))];
            let shown = app.input.replace('\n', " ⏎ ");
            let room = (r.width as usize).saturating_sub(16);
            let tail: String = if width(&shown) <= room {
                shown.clone()
            } else {
                let mut acc = 0;
                let mut keep: Vec<char> = shown
                    .chars()
                    .rev()
                    .take_while(|c| {
                        acc += c.width().unwrap_or(0);
                        acc <= room
                    })
                    .collect();
                keep.reverse();
                keep.into_iter().collect()
            };
            if app.input.is_empty() {
                let what = if app.focused().is_some() {
                    "a follow-up; Enter sends it".to_string()
                } else {
                    format!("what you want done; Enter starts an agent on {}", crate::engines::engine_name(app.new_agent_engine()))
                };
                spans.push(Span::styled(format!("  type {what}"), t.fg("Comment")));
            } else {
                spans.push(Span::styled(tail.clone(), t.fg("Normal")));
            }
            f.set_cursor_position((16 + width(&tail) as u16, y));
            Line::from(spans)
        }
        Mode::Command | Mode::Search => {
            let lead = if app.mode == Mode::Search { "/" } else { ":" };
            f.set_cursor_position((1 + width(&app.cmd) as u16, y));
            Line::from(vec![Span::styled(format!("{lead}{}", app.cmd), t.fg("Normal"))])
        }
        Mode::Normal | Mode::Visual => Line::from(Span::styled(fit(&app.message.0, r.width as usize), t.fg(app.message.1))),
    };
    f.render_widget(Paragraph::new(msg), r);
}
