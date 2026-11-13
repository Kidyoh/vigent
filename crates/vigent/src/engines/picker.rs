//! A list to pick from (`:model`, `:effort`, `:engine`, a pi extension's
//! select), vim-style: the ChoicePicker of src/picker.ts. `j`/`k` (↓/↑,
//! Ctrl-n/p, Tab) move, `g`/`G` jump, Enter picks, `q`/Esc closes. `/` starts a
//! search: type to filter, Esc ends it (the filter stays; Esc again drops it,
//! then closes). With `custom`, Enter on a search that matches nothing picks
//! the text itself (a model the list doesn't know).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use super::Choice;
use crate::app::App;
use crate::ui::text::{fit, width};

/// What runs once a choice is picked (None: closed without one).
pub type Done = Box<dyn FnOnce(&mut App, Option<String>) + Send>;

pub struct Picker {
    pub title: String,
    /// None while the list loads
    pub items: Option<Vec<Choice>>,
    pub query: String,
    /// typing goes to the search (after `/`)
    pub searching: bool,
    pub index: usize,
    scroll: usize,
    pub current: String,
    pub custom: bool,
    pub rows: usize,
    done: Option<Done>,
    /// which list a background load fills (a newer picker ignores an older load)
    pub id: u64,
}

const VISIBLE: usize = 14;

impl Picker {
    pub fn new(title: &str, items: Option<Vec<Choice>>, current: &str, custom: bool, rows: Option<usize>, done: Done) -> Picker {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let mut p = Picker {
            title: title.into(),
            items: None,
            query: String::new(),
            searching: false,
            index: 0,
            scroll: 0,
            current: current.into(),
            custom,
            rows: rows.unwrap_or(VISIBLE),
            done: Some(done),
            id: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        };
        if let Some(list) = items {
            p.fill(list);
        }
        p
    }

    /// The list arrived: open on the current choice.
    pub fn fill(&mut self, list: Vec<Choice>) {
        self.index = list.iter().position(|c| c.value == self.current).unwrap_or(0);
        self.items = Some(list);
        self.keep_visible();
    }

    pub fn filtered(&self) -> Vec<&Choice> {
        let all: Vec<&Choice> = self.items.iter().flatten().collect();
        if self.query.trim().is_empty() {
            return all;
        }
        fuzzy_filter(all, &self.query, |c| format!("{} {} {}", c.label.as_deref().unwrap_or(""), c.value, c.note.as_deref().unwrap_or("")))
    }

    fn keep_visible(&mut self) {
        let n = self.filtered().len();
        if self.index < self.scroll {
            self.scroll = self.index;
        }
        if self.index >= self.scroll + self.rows {
            self.scroll = self.index + 1 - self.rows;
        }
        self.scroll = self.scroll.min(n.saturating_sub(self.rows));
    }

    /// A key; Some(result) when the picker is done (Some(None): closed).
    pub fn key(&mut self, k: &KeyEvent) -> Option<Option<String>> {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let n = self.filtered().len();
        let mv = |p: &mut Picker, by: isize| {
            if n > 0 {
                p.index = ((p.index as isize + by).rem_euclid(n as isize)) as usize;
            }
        };
        match k.code {
            KeyCode::Char('c') if ctrl => return Some(None),
            KeyCode::Enter => {
                let picked = self.filtered().get(self.index).map(|c| c.value.clone()).or_else(|| (self.custom && !self.query.trim().is_empty()).then(|| self.query.trim().to_string()));
                return picked.map(Some);
            }
            KeyCode::Down | KeyCode::Tab => mv(self, 1),
            KeyCode::Up | KeyCode::BackTab => mv(self, -1),
            KeyCode::Char('n' | 'j') if ctrl => mv(self, 1),
            KeyCode::Char('p' | 'k') if ctrl => mv(self, -1),
            _ if self.searching => match k.code {
                KeyCode::Esc => self.searching = false,
                KeyCode::Backspace => {
                    if self.query.pop().is_none() {
                        self.searching = false;
                    }
                    self.index = 0;
                }
                KeyCode::Char('u') if ctrl => {
                    self.query.clear();
                    self.index = 0;
                }
                KeyCode::Char(c) if !ctrl => {
                    self.query.push(c);
                    self.index = 0;
                }
                _ => {}
            },
            KeyCode::Char('j') => mv(self, 1),
            KeyCode::Char('k') => mv(self, -1),
            KeyCode::Char('g') => self.index = 0,
            KeyCode::Char('G') => self.index = n.saturating_sub(1),
            KeyCode::Char('/') => self.searching = true,
            KeyCode::Char('q') => return Some(None),
            KeyCode::Esc => {
                if self.query.is_empty() {
                    return Some(None);
                }
                // first Esc drops the filter, the next one closes
                self.query.clear();
                self.index = 0;
            }
            _ => {}
        }
        self.keep_visible();
        None
    }

    /// The picker as plain rows of styled pieces, `w` columns wide (TS ChoicePicker.render).
    pub fn render(&self, w: usize, icons: &str) -> Vec<Vec<(String, &'static str)>> {
        let ascii = icons == "ascii";
        let (tl, tr, bl, br, h, v, lt, rt) = if ascii { ("+", "+", "+", "+", "-", "|", "+", "+") } else { ("╭", "╮", "╰", "╯", "─", "│", "├", "┤") };
        let (cur, prompt) = match icons {
            "ascii" => ("*", ">"),
            "nerd" => ("\u{f00c}", "\u{f002}"),
            _ => ("●", "❯"),
        };
        let inner = w.max(20) - 2;
        let items = self.filtered();
        let mut lines: Vec<Vec<(String, &'static str)>> = vec![];
        let row = |mut parts: Vec<(String, &'static str)>, group: &'static str| {
            let used: usize = parts.iter().map(|(s, _)| width(s)).sum();
            parts.insert(0, (v.to_string(), "FloatBorder"));
            parts.push((" ".repeat(inner.saturating_sub(used)), group));
            parts.push((v.to_string(), "FloatBorder"));
            parts
        };
        let title = fit(&format!(" {} ", self.title), inner.saturating_sub(2));
        lines.push(vec![
            (format!("{tl}{h}"), "FloatBorder"),
            (title.clone(), "FloatTitle"),
            (format!("{}{tr}", h.repeat(inner.saturating_sub(1 + width(&title)))), "FloatBorder"),
        ]);
        if self.searching {
            lines.push(row(vec![(format!(" {prompt} "), "Title"), (self.query.clone(), "NormalFloat"), (" ".into(), "PmenuSel")], "NormalFloat"));
        } else {
            let hint = if self.query.is_empty() { format!("/ to search{}", if self.custom { " or type any name" } else { "" }) } else { format!("/{}", self.query) };
            lines.push(row(vec![(format!(" {prompt} {}", fit(&hint, inner.saturating_sub(4))), "Comment")], "NormalFloat"));
        }
        lines.push(vec![(format!("{lt}{}{rt}", h.repeat(inner)), "FloatBorder")]);
        // names line up in a column after the longest (up to a third of the width)
        let name_w = items.iter().map(|c| width(c.shown())).max().unwrap_or(0).min(inner / 3);
        for i in 0..self.rows {
            let at = self.scroll + i;
            let Some(c) = items.get(at) else {
                let text = if i == 0 && self.items.is_none() {
                    "  loading…".to_string()
                } else if i == 0 && items.is_empty() {
                    let all_empty = self.items.as_ref().is_none_or(|l| l.is_empty());
                    if self.custom && !self.query.trim().is_empty() {
                        format!("  Enter uses '{}'", self.query.trim())
                    } else if self.custom && all_empty {
                        "  type it, then Enter".into()
                    } else {
                        "  no match".into()
                    }
                } else {
                    String::new()
                };
                lines.push(row(vec![(fit(&text, inner), "Comment")], "NormalFloat"));
                continue;
            };
            let selected = at == self.index;
            let group = if selected { "PmenuSel" } else { "NormalFloat" };
            let marker = if c.value == self.current { format!("{cur} ") } else { "  ".into() };
            let label = c.shown();
            let padded = if c.note.is_some() { format!("{label}{}", " ".repeat(name_w.saturating_sub(width(label)))) } else { label.to_string() };
            let name = fit(&format!("{marker}{padded}"), inner.saturating_sub(4).max(10));
            let note = c.note.as_ref().map(|n| fit(&format!("  {n}"), inner.saturating_sub(2 + width(&name)))).unwrap_or_default();
            lines.push(row(vec![(format!(" {name}"), group), (note, if selected { "PmenuSel" } else { "Comment" })], group));
        }
        let keys = if self.searching { "type to filter · Esc done" } else { "j/k move · Enter pick · q close" };
        let count = format!(" {}/{} · {keys} ", if items.is_empty() { 0 } else { self.index + 1 }, items.len());
        lines.push(vec![
            (format!("{bl}{}", h.repeat(inner.saturating_sub(width(&count) + 1))), "FloatBorder"),
            (count, "Comment"),
            (format!("{h}{br}"), "FloatBorder"),
        ]);
        lines
    }
}

/// Open a picker over the screen; `done` runs with the choice.
pub fn open(app: &mut App, p: Picker) {
    app.seq.pending.clear();
    app.engines.picker = Some(p);
}

/// Fill the open picker `id` with a list that loaded in the background.
pub fn fill(app: &mut App, id: u64, list: Vec<Choice>) {
    if let Some(p) = app.engines.picker.as_mut().filter(|p| p.id == id) {
        p.fill(list);
    }
}

/// A key while a picker is open.
pub fn key(app: &mut App, k: KeyEvent) {
    let Some(p) = app.engines.picker.as_mut() else { return };
    let Some(result) = p.key(&k) else { return };
    let done = p.done.take();
    app.engines.picker = None;
    if let Some(done) = done {
        done(app, result);
    }
}

/// Draw the open picker, centered (width: up to 72 columns).
pub fn draw(f: &mut Frame, app: &App, area: Rect) {
    let Some(p) = &app.engines.picker else { return };
    let w = 72.min(area.width.saturating_sub(4)).max(20);
    let rows = p.render(w as usize, &app.config.ui.icons);
    let h = (rows.len() as u16).min(area.height);
    let r = Rect::new(area.x + (area.width.saturating_sub(w)) / 2, area.y + (area.height.saturating_sub(h)) / 2, w.min(area.width), h);
    let t = &app.theme;
    let float = t.hl("NormalFloat");
    let lines: Vec<Line> = rows
        .into_iter()
        .map(|parts| {
            Line::from(
                parts
                    .into_iter()
                    .map(|(s, g)| {
                        let st: Style = match g {
                            "NormalFloat" => float,
                            "PmenuSel" => t.hl("PmenuSel"),
                            g => float.patch(t.fg(g)),
                        };
                        Span::styled(s, st)
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines).style(float), r);
}

/// Fuzzy match (pi-tui's fuzzyMatch): every query character in order; lower score is better.
pub fn fuzzy_match(query: &str, text: &str) -> Option<f64> {
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let m = |q: &[char]| -> Option<f64> {
        if q.is_empty() {
            return Some(0.0);
        }
        if q.len() > t.len() {
            return None;
        }
        let (mut qi, mut score, mut last, mut consecutive) = (0usize, 0f64, -1isize, 0f64);
        for (i, &c) in t.iter().enumerate() {
            if qi >= q.len() {
                break;
            }
            if c == q[qi] {
                let boundary = i == 0 || " \t\n-_./:".contains(t[i - 1]);
                if last == i as isize - 1 {
                    consecutive += 1.0;
                    score -= consecutive * 5.0;
                } else {
                    consecutive = 0.0;
                    if last >= 0 {
                        score += (i as isize - last - 1) as f64 * 2.0;
                    }
                }
                if boundary {
                    score -= 10.0;
                }
                score += i as f64 * 0.1;
                last = i as isize;
                qi += 1;
            }
        }
        if qi < q.len() {
            return None;
        }
        if q == t.as_slice() {
            score -= 100.0;
        }
        Some(score)
    };
    if let Some(s) = m(&q) {
        return Some(s);
    }
    // "abc12" also matches "12abc" (and back)
    let split = q.iter().position(|c| c.is_ascii_digit() != q[0].is_ascii_digit())?;
    let (a, b) = q.split_at(split);
    let alpha = |s: &[char]| s.iter().all(|c| c.is_ascii_lowercase());
    let digit = |s: &[char]| s.iter().all(|c| c.is_ascii_digit());
    if !((alpha(a) && digit(b)) || (digit(a) && alpha(b))) {
        return None;
    }
    let swapped: Vec<char> = b.iter().chain(a.iter()).copied().collect();
    m(&swapped).map(|s| s + 5.0)
}

/// Items whose text matches every space-separated token, best first (pi-tui's fuzzyFilter).
pub fn fuzzy_filter<T>(items: Vec<T>, query: &str, text: impl Fn(&T) -> String) -> Vec<T> {
    let tokens: Vec<&str> = query.split_whitespace().collect();
    if tokens.is_empty() {
        return items;
    }
    let mut scored: Vec<(f64, usize, T)> = vec![];
    for (n, item) in items.into_iter().enumerate() {
        let t = text(&item);
        let mut total = 0.0;
        let mut all = true;
        for tok in &tokens {
            match fuzzy_match(tok, &t) {
                Some(s) => total += s,
                None => {
                    all = false;
                    break;
                }
            }
        }
        if all {
            scored.push((total, n, item));
        }
    }
    // a stable sort, as Array.prototype.sort is
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, i)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(p: &mut Picker, keys: &str) -> Option<Option<String>> {
        let mut last = None;
        for c in keys.chars() {
            let code = match c {
                '\r' => KeyCode::Enter,
                '\x1b' => KeyCode::Esc,
                c => KeyCode::Char(c),
            };
            last = p.key(&KeyEvent::new(code, KeyModifiers::NONE));
        }
        last
    }

    fn plain(p: &Picker) -> String {
        p.render(70, "unicode").iter().map(|r| r.iter().map(|(s, _)| s.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn letters_move_until_slash_searches() {
        let mut p = Picker::new("Model · 'racer'", Some(super::super::choices::claude_models()), "default", true, None, Box::new(|_, _| {}));
        let s = plain(&p);
        assert!(s.contains("Model · 'racer' "));
        assert!(s.contains("● Default"));
        assert!(s.contains("Claude Opus 5.5    claude-opus-5-5") || s.contains("Claude Opus 5.5   claude-opus-5-5"), "{s}");
        press(&mut p, "opu");
        assert!(plain(&p).contains("j/k move"));
        press(&mut p, "jj");
        assert!(plain(&p).contains(" 3/5 "));
        press(&mut p, "k");
        assert!(plain(&p).contains(" 2/5 "));
        press(&mut p, "/opu");
        assert!(plain(&p).contains("type to filter · Esc done"));
        assert_eq!(press(&mut p, "\r"), Some(Some("claude-opus-5-5".into())));
    }

    #[test]
    fn esc_ends_the_search_then_drops_the_filter_then_closes() {
        let mut p = Picker::new("Model", Some(super::super::choices::claude_models()), "default", false, None, Box::new(|_, _| {}));
        press(&mut p, "/hai");
        assert!(plain(&p).contains("haiku") && !plain(&p).contains("opus"));
        assert_eq!(press(&mut p, "\x1b"), None);
        assert!(plain(&p).contains("/hai") && plain(&p).contains("j/k move"));
        press(&mut p, "\x1b");
        assert!(plain(&p).contains("opus"));
        assert_eq!(press(&mut p, "q"), Some(None));
        let mut c = Picker::new("Model", Some(vec![]), "", true, None, Box::new(|_, _| {}));
        assert!(plain(&c).contains("/ to search or type any name"));
        press(&mut c, "/my-own-model");
        assert!(plain(&c).contains("Enter uses 'my-own-model'"));
        assert_eq!(press(&mut c, "\r"), Some(Some("my-own-model".into())));
    }
}
