//! A scrollable floating window with selectable rows (`:dash`, `:cost`,
//! `:race`) and jump points (`]c` / `[c` between `:diff` hunks), with a second
//! layout `s` switches to (src/float.ts TextFloat). Drawn the TypeScript way:
//! a rounded border, the title in it, " q close " and the position below.
//! (ui/floats.rs is the Windows area's plainer float; the two can merge.)

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use crate::theme::Theme;
use crate::ui::text::{fit, width};

/// One line: segments of text, each in a highlight group.
pub type FLine = Vec<(String, &'static str)>;

/// The other layout `s` switches to.
pub struct Alt {
    pub title: String,
    pub lines: Vec<FLine>,
    pub jumps: Vec<usize>,
}

pub struct TextFloat {
    pub title: String,
    pub lines: Vec<FLine>,
    /// the widest it may be
    pub width: u16,
    pub top: usize,
    /// index into `selectable`
    pub selected: usize,
    /// line indices that can be selected with j/k
    pub selectable: Vec<usize>,
    /// what Enter on each selectable line opens: an agent's slot
    pub targets: Vec<usize>,
    /// line indices `]c` / `[c` jump between
    pub jumps: Vec<usize>,
    pub alternate: Option<Alt>,
    pending: Option<char>,
    /// the screen's rows, from the last draw (the float is rows - 4 tall at most)
    rows: usize,
}

/// What a key did to the float.
#[derive(Debug, PartialEq)]
pub enum Out {
    Stay,
    Close,
    /// close, and open this agent
    Open(usize),
}

impl TextFloat {
    pub fn new(title: impl Into<String>, lines: Vec<FLine>, width: u16) -> TextFloat {
        TextFloat {
            title: title.into(),
            lines,
            width,
            top: 0,
            selected: 0,
            selectable: vec![],
            targets: vec![],
            jumps: vec![],
            alternate: None,
            pending: None,
            rows: 40,
        }
    }

    /// Rows j/k select (each opening the agent in `targets`), starting on `initial` (a line index).
    pub fn select_rows(mut self, rows: Vec<usize>, targets: Vec<usize>, initial: Option<usize>) -> TextFloat {
        self.selected = initial.and_then(|l| rows.iter().position(|&r| r == l)).unwrap_or(0);
        self.selectable = rows;
        self.targets = targets;
        if let Some(&l) = self.selectable.get(self.selected) {
            self.reveal(l);
        }
        self
    }

    pub fn with_jumps(mut self, jumps: Vec<usize>, alternate: Option<Alt>) -> TextFloat {
        self.jumps = jumps;
        self.alternate = alternate;
        self
    }

    pub fn set_rows(&mut self, rows: usize) {
        self.rows = rows;
    }

    fn visible(&self) -> usize {
        3.max(self.lines.len().min(self.rows.saturating_sub(4).saturating_sub(2)))
    }

    fn reveal(&mut self, line: usize) {
        let n = self.visible();
        if line < self.top {
            self.top = line;
        } else if line >= self.top + n {
            self.top = self.lines.len().saturating_sub(n).min((line + 2).saturating_sub(n));
        }
    }

    fn select(&mut self, d: isize) -> bool {
        if self.selectable.is_empty() {
            return false;
        }
        self.selected = (self.selected as isize + d).clamp(0, self.selectable.len() as isize - 1) as usize;
        self.reveal(self.selectable[self.selected]);
        true
    }

    fn scroll(&mut self, d: isize) {
        let max = self.lines.len().saturating_sub(self.visible()) as isize;
        self.top = (self.top as isize + d).clamp(0, max.max(0)) as usize;
    }

    fn jump(&mut self, forward: bool) {
        let target = if forward { self.jumps.iter().find(|&&j| j > self.top) } else { self.jumps.iter().rev().find(|&&j| j < self.top) };
        if let Some(&t) = target {
            self.top = t.min(self.lines.len().saturating_sub(self.visible()));
        }
    }

    /// The selected line's index, if rows are selectable.
    pub fn selected_line(&self) -> Option<usize> {
        self.selectable.get(self.selected).copied()
    }

    pub fn key(&mut self, k: &KeyEvent) -> Out {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if let Some(p) = self.pending.take() {
            if k.code == KeyCode::Char('c') {
                self.jump(p == ']');
            }
            return Out::Stay;
        }
        let half = (self.visible() / 2) as isize;
        match k.code {
            KeyCode::Enter => {
                return match self.targets.get(self.selected) {
                    Some(&slot) if !self.selectable.is_empty() => Out::Open(slot),
                    _ => Out::Close,
                };
            }
            KeyCode::Esc | KeyCode::Char('q') => return Out::Close,
            KeyCode::Char('c') if ctrl => return Out::Close,
            KeyCode::Char(c @ (']' | '[')) => self.pending = Some(c),
            KeyCode::Char('s') => {
                if let Some(alt) = self.alternate.take() {
                    let old = Alt { title: std::mem::take(&mut self.title), lines: std::mem::take(&mut self.lines), jumps: std::mem::take(&mut self.jumps) };
                    (self.title, self.lines, self.jumps) = (alt.title, alt.lines, alt.jumps);
                    self.alternate = Some(old);
                    self.top = 0;
                }
            }
            KeyCode::Char('d') if ctrl => self.scroll(half),
            KeyCode::Char('u') if ctrl => self.scroll(-half),
            KeyCode::Char('j') | KeyCode::Down => {
                if !self.select(1) {
                    self.scroll(1)
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if !self.select(-1) {
                    self.scroll(-1)
                }
            }
            KeyCode::PageDown | KeyCode::Char(' ') => self.scroll(half),
            KeyCode::PageUp => self.scroll(-half),
            KeyCode::Char('g') => self.top = 0,
            KeyCode::Char('G') => self.scroll(self.lines.len() as isize),
            _ => {}
        }
        Out::Stay
    }

    /// The window as plain text lines (what the tests read), `w` columns wide.
    pub fn render_plain(&self, w: usize) -> Vec<String> {
        self.render(w, None).iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect()
    }

    fn render(&self, w: usize, t: Option<&Theme>) -> Vec<Line<'static>> {
        let st = |g: &str, bg: Style| -> Style {
            match t {
                Some(t) => {
                    let s = t.fg(g);
                    Style { bg: bg.bg, ..s }
                }
                None => Style::default(),
            }
        };
        let base = t.map(|t| t.hl("NormalFloat")).unwrap_or_default();
        let sel_bg = t.map(|t| t.hl("PmenuSel")).unwrap_or_default();
        let border = st("FloatBorder", base);
        let inner = 10.max(w.saturating_sub(2));
        let title = format!(" {} ", fit(&self.title, inner.saturating_sub(3)));
        let mut out = vec![Line::from(vec![
            Span::styled("╭─", border),
            Span::styled(title.clone(), st("FloatTitle", base)),
            Span::styled(format!("{}╮", "─".repeat(inner.saturating_sub(1 + width(&title)))), border),
        ])];
        let n = self.visible();
        let sel = self.selected_line();
        for (i, line) in self.lines.iter().enumerate().skip(self.top).take(n) {
            let on = sel == Some(i);
            let row_bg = if on { sel_bg } else { base };
            let mut spans = vec![Span::styled("│", border), Span::styled(" ", st("NormalFloat", row_bg))];
            let mut used = 0;
            for (seg, g) in line {
                let room = inner.saturating_sub(1 + used);
                let text = if room == 0 { String::new() } else { fit(seg, room) };
                used += width(&text);
                spans.push(Span::styled(text, st(if on { "PmenuSel" } else { g }, row_bg)));
            }
            spans.push(Span::styled(" ".repeat(inner.saturating_sub(1 + used)), st("NormalFloat", row_bg)));
            spans.push(Span::styled("│", border));
            out.push(Line::from(spans));
        }
        let more = if self.lines.len() > n { format!(" {}-{}/{} ", self.top + 1, self.lines.len().min(self.top + n), self.lines.len()) } else { String::new() };
        let hint = " q close ";
        out.push(Line::from(vec![
            Span::styled("╰─", border),
            Span::styled(hint, st("Comment", base)),
            Span::styled("─".repeat(inner.saturating_sub(2 + width(hint) + width(&more))), border),
            Span::styled(more, st("Comment", base)),
            Span::styled("─╯", border),
        ]));
        out
    }

    pub fn draw(&mut self, f: &mut Frame, theme: &Theme, area: Rect) {
        self.rows = area.height as usize;
        let w = self.width.min(area.width.saturating_sub(4)).max(12);
        let lines = self.render(w as usize, Some(theme));
        let h = (lines.len() as u16).min(area.height);
        let r = Rect::new(area.x + (area.width.saturating_sub(w)) / 2, area.y + (area.height.saturating_sub(h)) / 2, w, h);
        f.render_widget(Clear, r);
        f.render_widget(Paragraph::new(lines), r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(f: &mut TextFloat, c: char) -> Out {
        f.key(&KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))
    }

    #[test]
    fn rows_select_and_enter_opens_one() {
        let lines: Vec<FLine> = (0..6).map(|i| vec![(format!("row {i}"), "Title")]).collect();
        let mut f = TextFloat::new("Dashboard", lines, 60).select_rows(vec![0, 2, 4], vec![7, 8, 9], Some(2));
        assert_eq!(f.selected_line(), Some(2));
        press(&mut f, 'j');
        press(&mut f, 'j');
        assert_eq!(f.selected_line(), Some(4), "stops at the last");
        press(&mut f, 'k');
        assert_eq!(f.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)), Out::Open(8));
        let text = f.render_plain(40).join("\n");
        assert!(text.starts_with("╭─ Dashboard ─"), "{text}");
        assert!(text.contains("│ row 0"));
        assert!(text.ends_with("╰─ q close ───────────────────────────╯") || text.contains(" q close "), "{text}");
        assert_eq!(press(&mut f, 'q'), Out::Close);
    }

    #[test]
    fn jumps_and_the_other_layout() {
        let lines: Vec<FLine> = (0..100).map(|i| vec![(format!("l{i}"), "NormalFloat")]).collect();
        let alt = Alt { title: "split".into(), lines: vec![vec![("x".into(), "Title")]], jumps: vec![] };
        let mut f = TextFloat::new("unified", lines, 80).with_jumps(vec![10, 50], Some(alt));
        f.set_rows(30);
        press(&mut f, ']');
        press(&mut f, 'c');
        assert_eq!(f.top, 10);
        press(&mut f, ']');
        press(&mut f, 'c');
        assert_eq!(f.top, 50);
        press(&mut f, '[');
        press(&mut f, 'c');
        assert_eq!(f.top, 10);
        press(&mut f, 'G');
        assert_eq!(f.top, 100 - 24);
        press(&mut f, 's');
        assert_eq!((f.title.as_str(), f.top, f.lines.len()), ("split", 0, 1));
        press(&mut f, 's');
        assert_eq!(f.title, "unified");
    }
}
