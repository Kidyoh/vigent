//! Floating windows over the screen (:checkhealth, :help), like nvim's
//! floats: j/k gg G <C-d> <C-u> scroll, q or Esc closes.
//! (Windows area: pickers, confirm prompts and styled spans, src/float.ts and src/picker.ts.)

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph};

use super::text::fit;
use crate::app::App;

/// A window over the screen: a title and lines, each in a highlight group.
pub struct Float {
    pub title: String,
    pub lines: Vec<(String, &'static str)>,
    pub top: usize,
    /// a key waiting for the next one (g, for gg)
    pending: Option<char>,
}

impl Float {
    pub fn new(title: &str, lines: Vec<(String, &'static str)>) -> Float {
        Float { title: title.into(), lines, top: 0, pending: None }
    }
}

pub fn key(app: &mut App, k: KeyEvent) {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let page = app.page.max(2);
    let Some(f) = app.float.as_mut() else { return };
    let pending = f.pending.take();
    let max = f.lines.len().saturating_sub(1);
    match (pending, k.code) {
        (_, KeyCode::Char('q') | KeyCode::Esc) => app.float = None,
        (Some('g'), KeyCode::Char('g')) => f.top = 0,
        (_, KeyCode::Char('g')) => f.pending = Some('g'),
        (_, KeyCode::Char('G')) => f.top = max,
        (_, KeyCode::Char('d')) if ctrl => f.top = (f.top + page / 2).min(max),
        (_, KeyCode::Char('u')) if ctrl => f.top = f.top.saturating_sub(page / 2),
        (_, KeyCode::Char('j') | KeyCode::Down) => f.top = (f.top + 1).min(max),
        (_, KeyCode::Char('k') | KeyCode::Up) => f.top = f.top.saturating_sub(1),
        _ => {}
    }
}

pub fn draw(f: &mut Frame, app: &App, area: Rect, body_h: u16) {
    let Some(fl) = &app.float else { return };
    let t = &app.theme;
    let w = (area.width.saturating_sub(6)).min(86);
    let h = (body_h.saturating_sub(2)).min(fl.lines.len() as u16 + 2);
    let r = Rect::new((area.width - w) / 2, 2.min(body_h - h), w, h);
    let inner_h = h.saturating_sub(2) as usize;
    let top = fl.top.min(fl.lines.len().saturating_sub(inner_h));
    let end = (top + inner_h).min(fl.lines.len());
    let body: Vec<Line> = fl.lines[top..end].iter().map(|(s, g)| Line::from(Span::styled(fit(s, w as usize - 4), t.fg(g)))).collect();
    let float = t.hl("NormalFloat");
    let block = Block::default()
        .borders(Borders::ALL)
        .padding(Padding::horizontal(1))
        .border_type(BorderType::Rounded)
        .border_style(float)
        .style(float)
        .title_top(format!(" {} ", fl.title))
        .title_bottom(Line::from(" q close "))
        .title_bottom(Line::from(format!(" {}-{}/{} ", top + 1, end, fl.lines.len())).right_aligned());
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(body).block(block), r);
}
