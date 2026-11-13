//! The focused agent's transcript: prompts, replies, tool calls, and what
//! it's doing now.

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use super::markdown::reply;
use super::text::wrap;
use super::spinner;
use crate::app::App;
use crate::session::{Item, State};

pub fn lines(app: &App, w: usize) -> Vec<Line<'static>> {
    let t = &app.theme;
    let Some(a) = app.focused() else { return vec![] };
    let mut out: Vec<Line<'static>> = vec![];
    let mut prev: Option<&Item> = None;
    for item in &a.items {
        let gap = match (prev, item) {
            (None, _) => false,
            (_, Item::User(_)) | (_, Item::Text(_)) => true,
            (Some(Item::Text(_)), Item::Tool { .. }) => true,
            _ => false,
        };
        if gap {
            out.push(Line::default());
        }
        match item {
            Item::User(text) => {
                let s = t.fg("VigentUser").add_modifier(Modifier::BOLD);
                for (n, l) in text.lines().enumerate() {
                    out.extend(wrap(vec![(if n == 0 { "❯ " } else { "  " }.into(), t.fg("Identifier")), (l.to_string(), s)], w, 2));
                }
            }
            Item::Text(text) => out.extend(reply(text, w, t)),
            Item::Tool { name, summary, .. } => out.extend(wrap(
                vec![(" ▸ ".into(), t.fg("NonText")), (name.clone(), t.fg("VigentTool")), (format!(" {summary}"), t.fg("Comment"))],
                w,
                3,
            )),
            Item::Info(s) => out.extend(wrap(vec![(s.clone(), t.fg("Comment"))], w, 0)),
            Item::Error(s) => out.extend(wrap(vec![(s.clone(), t.fg("ErrorMsg"))], w, 0)),
        }
        prev = Some(item);
    }
    let spin = spinner(app);
    match (&a.hold_reason, a.state) {
        (Some(why), _) => out.push(Line::from(Span::styled(format!("{spin} {why}…"), t.fg("Comment")))),
        (None, State::Running) => {
            out.push(Line::default());
            out.push(Line::from(Span::styled(format!("{spin} working…"), t.fg("VigentSpinner"))));
        }
        _ => {}
    }
    out
}

