//! Floating windows over the screen (src/float.ts TextFloat): :help,
//! :checkhealth, :marks, :map, lists. j/k gg G <C-d> <C-u> scroll, ]c / [c
//! jump, s switches to an alternate view, Enter picks a selectable row, q or
//! Esc closes. Pickers are ui/picker.rs.

use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::widgets::{Clear, Paragraph};

use super::text::{Seg, exact, fit, to_line, width};
use crate::app::App;

/// One row of a float: pieces, each in a highlight group.
pub type FloatLine = Vec<(&'static str, String)>;

/// A window over the screen: a title and lines.
pub struct Float {
    pub title: String,
    pub lines: Vec<FloatLine>,
    pub top: usize,
    pub width: u16,
    /// rows Enter can pick (j/k move between them); empty: j/k scroll
    pub selectable: Vec<usize>,
    pub selected: usize,
    pub on_select: Option<Box<dyn FnOnce(&mut App, usize)>>,
    /// rows ]c and [c jump to
    pub jumps: Vec<usize>,
    /// what s switches to (title, lines, jumps)
    pub alternate: Option<(String, Vec<FloatLine>, Vec<usize>)>,
    pending: Option<char>,
}

impl Float {
    /// A float whose lines are each one piece in one group.
    pub fn new(title: &str, lines: Vec<(String, &'static str)>) -> Float {
        Float::rich(title, lines.into_iter().map(|(t, g)| vec![(g, t)]).collect(), 86)
    }

    pub fn rich(title: &str, lines: Vec<FloatLine>, width: u16) -> Float {
        Float { title: title.into(), lines, top: 0, width, selectable: vec![], selected: 0, on_select: None, jumps: vec![], alternate: None, pending: None }
    }

    fn visible(&self, rows: u16) -> usize {
        3.max(self.lines.len().min((rows as usize).saturating_sub(4).saturating_sub(2)))
    }

    fn scroll(&mut self, delta: isize, rows: u16) {
        let max = self.lines.len().saturating_sub(self.visible(rows));
        self.top = (self.top as isize + delta).clamp(0, max as isize) as usize;
    }

    fn reveal(&mut self, line: usize, rows: u16) {
        let n = self.visible(rows);
        if line < self.top {
            self.top = line;
        } else if line >= self.top + n {
            self.top = self.lines.len().saturating_sub(n).min(line + 2 - n);
        }
    }

    fn select(&mut self, delta: isize, rows: u16) -> bool {
        if self.selectable.is_empty() {
            return false;
        }
        self.selected = (self.selected as isize + delta).clamp(0, self.selectable.len() as isize - 1) as usize;
        let l = self.selectable[self.selected];
        self.reveal(l, rows);
        true
    }
}

pub fn key(app: &mut App, k: KeyEvent) {
    let Some(token) = crate::keys::token_from_event(&k) else { return };
    feed(app, &token);
}

/// One key (vigent's notation) for the float on screen.
pub fn feed(app: &mut App, token: &str) {
    let rows = app.windows.rows;
    let Some(f) = app.float.as_mut() else { return };
    if let Some(p) = f.pending.take() {
        if token == "c" && (p == ']' || p == '[') {
            let top = f.top;
            let target = if p == ']' { f.jumps.iter().copied().find(|&j| j > top) } else { f.jumps.iter().rev().copied().find(|&j| j < top) };
            if let Some(t) = target {
                f.top = t.min(f.lines.len().saturating_sub(f.visible(rows)));
            }
        }
        return;
    }
    let half = (f.visible(rows) / 2) as isize;
    match token {
        "<CR>" => {
            let picked = f.selectable.get(f.selected).copied();
            let cb = f.on_select.take();
            app.float = None;
            if let (Some(line), Some(cb)) = (picked, cb) {
                cb(app, line);
            }
        }
        "<Esc>" | "q" | "<C-c>" => app.float = None,
        "]" | "[" => f.pending = token.chars().next(),
        "s" => {
            if let Some((t, l, j)) = f.alternate.take() {
                let old = (std::mem::replace(&mut f.title, t), std::mem::replace(&mut f.lines, l), std::mem::replace(&mut f.jumps, j));
                f.alternate = Some(old);
                f.top = 0;
            }
        }
        "j" | "<Down>" => {
            if !f.select(1, rows) {
                f.scroll(1, rows);
            }
        }
        "k" | "<Up>" => {
            if !f.select(-1, rows) {
                f.scroll(-1, rows);
            }
        }
        "<C-d>" | "<PageDown>" | "<Space>" => f.scroll(half, rows),
        "<C-u>" | "<PageUp>" => f.scroll(-half, rows),
        "g" => f.top = 0,
        "G" => {
            let n = f.lines.len() as isize;
            f.scroll(n, rows);
        }
        _ => {}
    }
}

/// The float's rows, `w` columns wide.
pub fn render(app: &App, f: &Float, w: usize) -> Vec<Vec<Seg>> {
    let t = &app.theme;
    let (tl, tr, bl, br, h, v) = if app.config.ui.icons == "ascii" { ("+", "+", "+", "+", "-", "|") } else { ("╭", "╮", "╰", "╯", "─", "│") };
    let inner = 10.max(w.saturating_sub(2));
    let bg = t.hl("NormalFloat").bg;
    let on = |g: &str, b: Option<ratatui::style::Color>| match b {
        Some(c) => t.fg(g).bg(c),
        None => t.fg(g),
    };
    let border = on("FloatBorder", bg);
    let title = format!(" {} ", f.title);
    let mut out = vec![vec![Seg::new(format!("{tl}{h}"), border), Seg::new(title.clone(), on("FloatTitle", bg)), Seg::new(format!("{}{tr}", h.repeat(inner.saturating_sub(1 + width(&title)))), border)]];
    let n = f.visible(app.windows.rows);
    let selected_line = f.selectable.get(f.selected).copied();
    let sel_bg = t.hl("PmenuSel").bg.or(t.hl("Visual").bg);
    for (i, line) in f.lines.iter().skip(f.top).take(n).enumerate() {
        let is_sel = Some(f.top + i) == selected_line;
        let row_bg = if is_sel { sel_bg } else { bg };
        let mut row = vec![Seg::new(v, border), Seg::new(" ", on("NormalFloat", row_bg))];
        let mut used = 0;
        for (g, seg) in line {
            let tx = fit(seg, inner.saturating_sub(1 + used));
            used += width(&tx);
            row.push(Seg::new(tx, on(if is_sel { "PmenuSel" } else { g }, row_bg)));
        }
        row.push(Seg::new(" ".repeat(inner.saturating_sub(1 + used)), on("NormalFloat", row_bg)));
        row.push(Seg::new(v, border));
        out.push(row);
    }
    // pad up to the visible rows (fewer lines than 3)
    while out.len() < n + 1 {
        out.push(vec![Seg::new(v, border), Seg::new(" ".repeat(inner), on("NormalFloat", bg)), Seg::new(v, border)]);
    }
    let more = if f.lines.len() > n { format!(" {}-{}/{} ", f.top + 1, f.lines.len().min(f.top + n), f.lines.len()) } else { String::new() };
    let hint = " q close ";
    out.push(vec![
        Seg::new(format!("{bl}{h}"), border),
        Seg::new(hint, on("Comment", bg)),
        Seg::new(h.repeat(inner.saturating_sub(2 + width(hint) + width(&more))), border),
        Seg::new(more, on("Comment", bg)),
        Seg::new(format!("{h}{br}"), border),
    ]);
    out.into_iter().map(|r| exact(r, inner + 2, t.normal())).collect()
}

pub fn draw(f: &mut Frame, app: &App, area: Rect, _body_h: u16) {
    let Some(fl) = &app.float else { return };
    let w = (fl.width as usize).min((area.width as usize).saturating_sub(4)).max(12);
    let rows = render(app, fl, w);
    let h = rows.len() as u16;
    let x = (area.width.saturating_sub(w as u16)) / 2;
    let y = (area.height.saturating_sub(h)) / 2;
    let r = Rect::new(x, y, (w as u16).min(area.width), h.min(area.height));
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(rows.into_iter().map(to_line).collect::<Vec<_>>()), r);
}
