//! The template picker (`:templates`, T on the start screen): j/k, Enter, q.
//! The templates themselves, `:new -t` and the built-in four are the
//! Sessions area's (agents.rs: `all_templates`, `start_from_template`).

use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use crate::agents::{NewAgent, all_templates};
use crate::app::{App, Mode};
use crate::settings::truncate;
use crate::ui::text::width;

/// The template picker (a choice list: j/k, Enter, q).
pub struct Picker {
    rows: Vec<(String, String)>,
    index: usize,
}

pub fn open(app: &mut App) {
    app.seq.reset();
    let rows = all_templates(&app.config.templates)
        .into_iter()
        .map(|(t, is_builtin)| {
            let how: Vec<String> = [t.engine.as_deref().map(crate::engines::engine_name), t.model.clone(), t.effort.clone()].into_iter().flatten().filter(|s| !s.is_empty()).collect();
            let what = t.description.clone().unwrap_or_else(|| t.prompt.lines().next().unwrap_or_default().to_string());
            let how = if how.is_empty() { String::new() } else { format!(" ({})", how.join(" · ")) };
            let yours = if is_builtin { "" } else { " · yours" };
            (t.name, format!("{what}{how}{yours}"))
        })
        .collect();
    app.cfg.templates = Some(Picker { rows, index: 0 });
}

fn choose(app: &mut App, name: &str) {
    let list = all_templates(&app.config.templates);
    let found = list.iter().find(|(t, _)| t.name == name).cloned();
    if let Some((t, _)) = &found
        && !t.prompt.contains("{task}")
    {
        app.start_from_template(name, "", NewAgent::default());
        return;
    }
    app.mode = Mode::Command;
    app.cmd = format!("new -t {name} ");
    let review = found.is_some_and(|(t, b)| b && t.name == "review");
    app.say(if review { "what to focus on (optional), then Enter" } else { "what it's for, then Enter" }, "Comment");
}

pub fn key(app: &mut App, k: KeyEvent) {
    let Some(token) = crate::keys::token_from_event(&k) else { return };
    feed(app, &token);
}

pub fn feed(app: &mut App, key: &str) {
    let Some(mut p) = app.cfg.templates.take() else { return };
    let n = p.rows.len().max(1);
    match key {
        "q" | "<Esc>" | "<C-c>" => return,
        "j" | "<Down>" | "<Tab>" | "<C-n>" => p.index = (p.index + 1) % n,
        "k" | "<Up>" | "<S-Tab>" | "<C-p>" => p.index = (p.index + n - 1) % n,
        "g" => p.index = 0,
        "G" => p.index = n - 1,
        "<CR>" => {
            if let Some((name, _)) = p.rows.get(p.index).cloned() {
                choose(app, &name);
            }
            return;
        }
        _ => {}
    }
    app.cfg.templates = Some(p);
}

pub fn draw(f: &mut Frame, app: &App, area: Rect) {
    let Some(p) = &app.cfg.templates else { return };
    let t = &app.theme;
    let ascii = app.config.ui.icons == "ascii";
    let (tl, tr, bl, br, hz, vt) = if ascii { ("+", "+", "+", "+", "-", "|") } else { ("╭", "╮", "╰", "╯", "─", "│") };
    let w = 96.min(area.width.saturating_sub(4)).max(20) as usize;
    let inner = w - 2;
    let bg = t.hl("NormalFloat").bg;
    let on = |g: &str, b| Style { bg: b, ..t.hl(g) };
    let border = on("FloatBorder", bg);
    let sel_bg = t.hl("PmenuSel").bg.or(t.hl("Visual").bg);
    let title = " Start an agent from a template ";
    let mut lines = vec![Line::from(vec![Span::styled(format!("{tl}{hz}"), border), Span::styled(title, on("FloatTitle", bg)), Span::styled(format!("{}{tr}", hz.repeat(inner.saturating_sub(1 + width(title)))), border)])];
    let name_w = p.rows.iter().map(|(n, _)| width(n)).max().unwrap_or(4).min(20);
    for (i, (name, note)) in p.rows.iter().enumerate() {
        let selected = i == p.index;
        let rbg = if selected { sel_bg } else { bg };
        let group = if selected { "PmenuSel" } else { "NormalFloat" };
        let left = format!(" {name}{} ", " ".repeat(name_w.saturating_sub(width(name))));
        let note = truncate(note, inner.saturating_sub(width(&left) + 1), "…");
        let used = width(&left) + width(&note);
        lines.push(Line::from(vec![
            Span::styled(vt.to_string(), border),
            Span::styled(left, on(group, rbg)),
            Span::styled(note, on("Comment", rbg)),
            Span::styled(" ".repeat(inner.saturating_sub(used)), on("NormalFloat", rbg)),
            Span::styled(vt.to_string(), border),
        ]));
    }
    let keys = " j/k move · Enter pick · q close ";
    lines.push(Line::from(vec![Span::styled(format!("{bl}{}", hz.repeat(inner.saturating_sub(width(keys) + 1))), border), Span::styled(keys, on("Comment", bg)), Span::styled(format!("{hz}{br}"), border)]));
    let h = (lines.len() as u16).min(area.height);
    let r = Rect::new(area.x + (area.width.saturating_sub(w as u16)) / 2, area.y + (area.height - h) / 2, w as u16, h);
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines), r);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picking_a_template_that_needs_a_task_asks_for_it() {
        let mut a = crate::app::tests::app();
        open(&mut a);
        feed(&mut a, "j");
        feed(&mut a, "<CR>");
        assert_eq!((a.mode, a.cmd.as_str()), (Mode::Command, "new -t test "));
        assert!(a.cfg.templates.is_none());
    }
}
