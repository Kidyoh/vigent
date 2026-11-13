//! The `:review` window: the agent's changes hunk by hunk (src/hunk-review.ts).
//!
//!   j/k ]c/[c  next / previous hunk      J/K  next / previous file
//!   x  drop the hunk (take it out of the worktree)
//!   X  drop the whole file               u  undo the last drop
//!   q / Esc  close
//!
//! git runs on a thread; the window waits (busy) until the diff is reloaded.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use super::hunks::{FileDiff, patch_for};
use crate::theme::Theme;
use crate::ui::text::{fit, width};

struct Row {
    text: String,
    group: &'static str,
    /// index into the flat hunk list of the hunk this row belongs to (None for file headers)
    hunk: Option<usize>,
    header: bool,
}

/// What the window asks the App to do.
#[derive(Debug, PartialEq)]
pub enum Ask {
    Nothing,
    Close,
    /// take this patch out of the worktree (then call `done`)
    Drop(String),
    /// put this patch back (then call `done`)
    Restore(String),
}

pub struct HunkReview {
    pub title: String,
    pub files: Vec<FileDiff>,
    /// (file index, hunk index in that file), in order
    flat: Vec<(usize, usize)>,
    index: usize,
    top: usize,
    undo: Vec<(String, String)>,
    dropped: usize,
    pub message: String,
    pub busy: bool,
    pending_bracket: Option<char>,
    /// what's running: (patch, label, it's a drop)
    running: Option<(String, String, bool)>,
    /// the screen's rows, from the last draw
    rows: usize,
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

impl HunkReview {
    pub fn new(title: impl Into<String>, files: Vec<FileDiff>) -> HunkReview {
        let mut r = HunkReview {
            title: title.into(),
            files,
            flat: vec![],
            index: 0,
            top: 0,
            undo: vec![],
            dropped: 0,
            message: String::new(),
            busy: false,
            pending_bracket: None,
            running: None,
            rows: 40,
        };
        r.flatten();
        r
    }

    fn flatten(&mut self) {
        self.flat = self.files.iter().enumerate().flat_map(|(fi, f)| (0..f.hunks.len()).map(move |hi| (fi, hi))).collect();
        self.index = self.index.min(self.flat.len().saturating_sub(1));
    }

    pub fn left(&self) -> usize {
        self.flat.len()
    }

    fn rows(&self, w: usize) -> Vec<Row> {
        let mut out = vec![];
        let mut idx = 0;
        for f in &self.files {
            let what = if f.binary { "(binary: X drops it)".to_string() } else { plural(f.hunks.len(), "hunk") };
            out.push(Row { text: format!("{}  {what}", f.path), group: "Title", hunk: None, header: true });
            for h in &f.hunks {
                out.push(Row { text: h.header.clone(), group: "Special", hunk: Some(idx), header: true });
                for l in &h.lines {
                    let group = if l.starts_with('+') {
                        "Added"
                    } else if l.starts_with('-') {
                        "Removed"
                    } else if l.starts_with('\\') {
                        "Comment"
                    } else {
                        "NormalFloat"
                    };
                    out.push(Row { text: fit(&l.replace('\t', "  "), w.max(1)), group, hunk: Some(idx), header: false });
                }
                idx += 1;
            }
        }
        out
    }

    fn mv(&mut self, d: isize) {
        if !self.flat.is_empty() {
            self.index = (self.index as isize + d).clamp(0, self.flat.len() as isize - 1) as usize;
        }
    }

    fn move_file(&mut self, d: isize) {
        let cur = self.flat.get(self.index).map(|h| h.0).unwrap_or(0);
        let target = if d > 0 { self.flat.iter().position(|h| h.0 > cur) } else { self.flat.iter().position(|h| h.0 == cur.saturating_sub(1)) };
        if let Some(t) = target {
            self.index = t;
        }
    }

    fn run(&mut self, patch: String, label: String, drop: bool) -> Ask {
        self.busy = true;
        self.message = if drop { "dropping…" } else { "restoring…" }.into();
        self.running = Some((patch.clone(), label, drop));
        if drop { Ask::Drop(patch) } else { Ask::Restore(patch) }
    }

    /// git is done: the new diff, or git's reason.
    pub fn done(&mut self, result: Result<Vec<FileDiff>, String>) {
        self.busy = false;
        let Some((patch, label, drop)) = self.running.take() else { return };
        match result {
            Ok(files) => {
                if drop {
                    self.undo.push((patch, label.clone()));
                    self.dropped += 1;
                    self.message = format!("dropped {label} · u undoes");
                } else {
                    self.dropped = self.dropped.saturating_sub(1);
                    self.message = format!("restored {label}");
                }
                self.files = files;
                self.flatten();
            }
            Err(e) => {
                let _ = patch;
                self.message = format!("git couldn't {} {label}: {e}", if drop { "drop" } else { "restore" });
            }
        }
    }

    pub fn key(&mut self, k: &KeyEvent) -> Ask {
        if self.busy {
            return Ask::Nothing;
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Char('q') | KeyCode::Esc => return Ask::Close,
            KeyCode::Char('c') if ctrl => return Ask::Close,
            KeyCode::Char('j' | 'n') | KeyCode::Down | KeyCode::Tab => self.mv(1),
            KeyCode::Char('k' | 'N') | KeyCode::Up | KeyCode::BackTab => self.mv(-1),
            KeyCode::Char(c @ (']' | '[')) => {
                self.pending_bracket = Some(c);
                return Ask::Nothing;
            }
            KeyCode::Char('c') => {
                if let Some(b) = self.pending_bracket {
                    self.mv(if b == ']' { 1 } else { -1 });
                }
            }
            KeyCode::Char('J') => self.move_file(1),
            KeyCode::Char('K') => self.move_file(-1),
            KeyCode::Char('g') => self.index = 0,
            KeyCode::Char('G') => self.index = self.flat.len().saturating_sub(1),
            KeyCode::Char('x') => return self.drop_hunk(),
            KeyCode::Char('X') => return self.drop_file(),
            KeyCode::Char('u') => return self.undo_last(),
            _ => {}
        }
        self.pending_bracket = None;
        Ask::Nothing
    }

    fn drop_hunk(&mut self) -> Ask {
        let Some(&(fi, hi)) = self.flat.get(self.index) else { return Ask::Nothing };
        let f = &self.files[fi];
        let patch = patch_for(f, &f.hunks[hi..=hi]);
        let label = format!("hunk {} of {}", hi + 1, f.path);
        self.run(patch, label, true)
    }

    fn drop_file(&mut self) -> Ask {
        let fi = self.flat.get(self.index).map(|h| h.0).unwrap_or(0);
        let Some(f) = self.files.get(fi) else { return Ask::Nothing };
        if f.binary && f.hunks.is_empty() {
            self.message = "binary files can't be dropped here yet".into();
            return Ask::Nothing;
        }
        let (patch, label) = (patch_for(f, &f.hunks), f.path.clone());
        self.run(patch, label, true)
    }

    fn undo_last(&mut self) -> Ask {
        let Some((patch, label)) = self.undo.pop() else {
            self.message = "nothing to undo".into();
            return Ask::Nothing;
        };
        self.run(patch, label, false)
    }

    /// The window as plain text lines (what the tests read), `w` columns wide.
    pub fn render_plain(&mut self, w: usize) -> Vec<String> {
        self.render(w, None).iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect()
    }

    fn render(&mut self, w: usize, t: Option<&Theme>) -> Vec<Line<'static>> {
        let st = |g: &str, bg: Style| -> Style {
            match t {
                Some(t) => Style { bg: bg.bg, ..t.fg(g) },
                None => Style::default(),
            }
        };
        let base = t.map(|t| t.hl("NormalFloat")).unwrap_or_default();
        let sel = t.map(|t| t.hl("PmenuSel")).unwrap_or_default();
        let border = st("FloatBorder", base);
        let inner = 30.max(w) - 2;
        let row = |content: Vec<Span<'static>>, used: usize, bg: Style| {
            let mut spans = vec![Span::styled("│", border)];
            spans.extend(content);
            spans.push(Span::styled(" ".repeat(inner.saturating_sub(used)), st("NormalFloat", bg)));
            spans.push(Span::styled("│", border));
            Line::from(spans)
        };

        let total = self.flat.len();
        let dropped = if self.dropped > 0 { format!(" · {} dropped", self.dropped) } else { String::new() };
        let title = fit(&format!(" {} · {} left{dropped} ", self.title, plural(total, "hunk")), inner - 2);
        let mut lines = vec![Line::from(vec![
            Span::styled("╭─", border),
            Span::styled(title.clone(), st("FloatTitle", base)),
            Span::styled(format!("{}╮", "─".repeat(inner.saturating_sub(1 + width(&title)))), border),
        ])];

        let body = 3.max(self.rows.saturating_sub(2).saturating_sub(4));
        let mut rows = self.rows(inner - 3);
        if total == 0 {
            let text = if self.dropped > 0 { "every change is dropped: nothing would be merged (u undoes)" } else { "no changes" };
            rows = vec![Row { text: text.into(), group: "Comment", hunk: None, header: false }];
        }
        // keep the selected hunk's header in view, a little below the top
        if let Some(at) = rows.iter().position(|r| r.hunk == Some(self.index) && r.header) {
            if at < self.top || at >= self.top + body.saturating_sub(3) {
                self.top = at.saturating_sub(2);
            }
        }
        self.top = self.top.min(rows.len().saturating_sub(body));
        for r in rows.iter().skip(self.top).take(body) {
            let on = r.hunk == Some(self.index) && total > 0;
            let bg = if on && r.header { sel } else { base };
            let bar = if on { Span::styled("▌ ", st("Title", bg)) } else { Span::styled("  ", st("NormalFloat", bg)) };
            let text = fit(&r.text, inner - 3);
            let used = 2 + width(&text);
            lines.push(row(vec![bar, Span::styled(text, st(if on && r.header { "PmenuSel" } else { r.group }, bg))], used, bg));
        }
        while lines.len() < body + 1 {
            lines.push(row(vec![], 0, base));
        }
        let msg = if self.message.is_empty() { "x drop hunk · X drop file · u undo · j/k hunks · J/K files · q close · :merge takes what's left" } else { &self.message };
        lines.push(Line::from(Span::styled(format!("├{}┤", "─".repeat(inner)), border)));
        let shown = format!(" {}", fit(msg, inner - 2));
        let used = inner.min(width(msg) + 1);
        lines.push(row(vec![Span::styled(shown, st(if self.message.is_empty() { "Comment" } else { "ModeMsg" }, base))], used, base));
        lines.push(Line::from(Span::styled(format!("╰{}╯", "─".repeat(inner)), border)));
        lines
    }

    pub fn draw(&mut self, f: &mut Frame, theme: &Theme, area: Rect) {
        self.rows = area.height as usize;
        let w = area.width.saturating_sub(4).max(30);
        let lines = self.render(w as usize, Some(theme));
        let h = (lines.len() as u16).min(area.height);
        let r = Rect::new(area.x + area.width.saturating_sub(w) / 2, area.y + area.height.saturating_sub(h) / 2, w.min(area.width), h);
        f.render_widget(Clear, r);
        f.render_widget(Paragraph::new(lines), r);
    }
}
