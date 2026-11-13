//! A list to pick from, vim-style (src/picker.ts ChoicePicker): `j`/`k`
//! (↓/↑, Ctrl-n/p, Tab) move, `g`/`G` jump, Enter picks, `q`/Esc closes.
//! `/` starts a search: type to filter (fuzzy, like pi-tui's), Esc ends it.
//! With `custom`, Enter on a search that matches nothing picks the text itself.
//! The `@` file picker, and every area's pickers (:model, :theme, ...), are these.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::text::{fit, width};
use crate::app::App;
use crate::theme::Theme;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Choice {
    pub value: String,
    /// what the list shows (default: the value)
    pub label: Option<String>,
    pub note: Option<String>,
    /// a heading shown above each run of choices with the same group
    pub group: Option<String>,
}

impl Choice {
    pub fn new(value: impl Into<String>) -> Choice {
        Choice { value: value.into(), ..Default::default() }
    }
}

/// Where the picker goes on screen.
#[derive(Clone, Copy, Debug)]
pub enum Place {
    Center { width: u16 },
    /// a completion menu: its bottom-left corner at (col, rows + offset_y)
    BottomLeft { col: u16, offset_y: i16, width: u16 },
}

pub type Done = Box<dyn FnOnce(&mut App, Option<String>)>;

pub struct Picker {
    pub title: String,
    /// None while loading
    pub items: Option<Vec<Choice>>,
    pub current: Option<String>,
    pub custom: bool,
    pub query: String,
    pub searching: bool,
    pub index: usize,
    pub scroll: usize,
    pub rows: usize,
    pub place: Place,
    pub done: Option<Done>,
    pub back_out: Option<Box<dyn FnOnce(&mut App)>>,
}

impl Picker {
    pub fn new(title: &str, items: Option<Vec<Choice>>, current: Option<String>, custom: bool, done: Done) -> Picker {
        let mut p = Picker {
            title: title.into(),
            items: None,
            current,
            custom,
            query: String::new(),
            searching: false,
            index: 0,
            scroll: 0,
            rows: 14,
            place: Place::Center { width: 72 },
            done: Some(done),
            back_out: None,
        };
        if let Some(items) = items {
            p.set_items(items);
        }
        p
    }

    /// The list came (it may load in the background).
    pub fn set_items(&mut self, items: Vec<Choice>) {
        self.index = items.iter().position(|c| Some(&c.value) == self.current.as_ref()).unwrap_or(0);
        self.items = Some(items);
        self.keep_visible();
    }

    pub fn filtered(&self) -> Vec<Choice> {
        let items = self.items.clone().unwrap_or_default();
        if self.query.trim().is_empty() {
            return items;
        }
        fuzzy_filter(items, &self.query, |c| format!("{} {} {} {}", c.label.as_deref().unwrap_or(""), c.value, c.note.as_deref().unwrap_or(""), c.group.as_deref().unwrap_or("")))
    }

    /// The choices with their groups' headings between them: Err(heading) or Ok(index).
    fn rows_of(items: &[Choice]) -> Vec<Result<usize, String>> {
        let mut out = vec![];
        let mut group: Option<&String> = None;
        for (i, c) in items.iter().enumerate() {
            if let Some(g) = &c.group
                && Some(g) != group
            {
                out.push(Err(g.clone()));
            }
            group = c.group.as_ref();
            out.push(Ok(i));
        }
        out
    }

    fn keep_visible(&mut self) {
        let rows = Self::rows_of(&self.filtered());
        let Some(at) = rows.iter().position(|r| *r == Ok(self.index)) else {
            self.scroll = 0;
            return;
        };
        let top = if at > 0 && rows[at - 1].is_err() { at - 1 } else { at };
        if top < self.scroll {
            self.scroll = top;
        }
        if at >= self.scroll + self.rows {
            self.scroll = at + 1 - self.rows;
        }
        self.scroll = self.scroll.min(rows.len().saturating_sub(self.rows));
    }

    /// The picker's height on screen.
    pub fn height(&self) -> usize {
        self.rows + 4
    }

    pub fn lines(&self, w: usize, t: &Theme, icons: &str) -> Vec<Line<'static>> {
        let (tl, tr, bl, br, h, v, lt, rt, cur_mark, prompt) = match icons {
            "ascii" => ("+", "+", "+", "+", "-", "|", "+", "+", "*", ">"),
            "nerd" => ("╭", "╮", "╰", "╯", "─", "│", "├", "┤", "\u{f00c}", "\u{f002}"),
            _ => ("╭", "╮", "╰", "╯", "─", "│", "├", "┤", "●", "❯"),
        };
        let inner = w.max(20) - 2;
        let float = t.hl("NormalFloat");
        let bg = float.bg;
        let on = |g: &str| {
            let s = t.fg(g);
            match bg {
                Some(b) => s.bg(b),
                None => s,
            }
        };
        let border = on("FloatBorder");
        let row = |mut spans: Vec<Span<'static>>, used: usize, row_bg: Style| {
            let mut out = vec![Span::styled(v.to_string(), border)];
            out.append(&mut spans);
            out.push(Span::styled(" ".repeat(inner.saturating_sub(used)), row_bg));
            out.push(Span::styled(v.to_string(), border));
            Line::from(out)
        };
        let items = self.filtered();
        let title = fit(&format!(" {} ", self.title), inner.saturating_sub(2));
        let mut lines = vec![Line::from(vec![
            Span::styled(format!("{tl}{h}"), border),
            Span::styled(title.clone(), on("FloatTitle")),
            Span::styled(format!("{}{tr}", h.repeat(inner.saturating_sub(1 + width(&title)))), border),
        ])];
        if self.searching {
            let sel = t.hl("PmenuSel");
            lines.push(row(
                vec![Span::styled(format!(" {prompt} "), on("Title")), Span::styled(self.query.clone(), on("NormalFloat")), Span::styled(" ", sel)],
                width(&self.query) + 4,
                on("NormalFloat"),
            ));
        } else {
            let hint = if self.query.is_empty() { format!("/ to search{}", if self.custom { " or type any name" } else { "" }) } else { format!("/{}", self.query) };
            let text = fit(&hint, inner.saturating_sub(4));
            let used = width(&text) + 3;
            lines.push(row(vec![Span::styled(format!(" {prompt} {text}"), on("Comment"))], used, on("NormalFloat")));
        }
        lines.push(Line::from(Span::styled(format!("{lt}{}{rt}", h.repeat(inner)), border)));
        let all = Self::rows_of(&items);
        let name_w = (inner / 3).min(items.iter().map(|x| width(x.label.as_deref().unwrap_or(&x.value))).max().unwrap_or(0));
        for i in 0..self.rows {
            match all.get(self.scroll + i) {
                Some(Err(heading)) => {
                    let text = fit(&format!(" {heading}"), inner);
                    let n = width(&text);
                    lines.push(row(vec![Span::styled(text, on("Title"))], n, on("NormalFloat")));
                }
                Some(Ok(ci)) => {
                    let c = &items[*ci];
                    let selected = *ci == self.index;
                    let sel = t.hl("PmenuSel");
                    let row_bg = if selected { sel } else { on("NormalFloat") };
                    let group = if selected { sel } else { on("NormalFloat") };
                    let marker = if Some(&c.value) == self.current.as_ref() { format!("{cur_mark} ") } else { "  ".into() };
                    let label = c.label.clone().unwrap_or_else(|| c.value.clone());
                    let padded = if c.note.is_some() { format!("{label}{}", " ".repeat(name_w.saturating_sub(width(&label)))) } else { label };
                    let name = fit(&format!("{marker}{padded}"), 10usize.max(inner.saturating_sub(4)));
                    let note = c.note.as_ref().map(|n| fit(&format!("  {n}"), inner.saturating_sub(2 + width(&name)))).unwrap_or_default();
                    let used = 1 + width(&name) + width(&note);
                    let note_style = if selected { sel } else { on("Comment") };
                    lines.push(row(vec![Span::styled(format!(" {name}"), group), Span::styled(note, note_style)], used, row_bg));
                }
                None => {
                    let text = if i == 0 && self.items.is_none() {
                        "  loading…".to_string()
                    } else if i == 0 && items.is_empty() {
                        let q = self.query.trim();
                        if self.custom && !q.is_empty() {
                            format!("  Enter uses '{q}'")
                        } else if self.custom && self.items.as_ref().is_some_and(|x| x.is_empty()) {
                            "  type it, then Enter".into()
                        } else {
                            "  no match".into()
                        }
                    } else {
                        String::new()
                    };
                    let text = fit(&text, inner);
                    let n = width(&text).min(inner);
                    lines.push(row(vec![Span::styled(text, on("Comment"))], n, on("NormalFloat")));
                }
            }
        }
        let keys = if self.searching { "type to filter · Esc done" } else { "j/k move · Enter pick · q close" };
        let count = format!(" {}/{} · {keys} ", if items.is_empty() { 0 } else { self.index + 1 }, items.len());
        lines.push(Line::from(vec![
            Span::styled(format!("{bl}{}", h.repeat(inner.saturating_sub(width(&count) + 1))), border),
            Span::styled(count, on("Comment")),
            Span::styled(format!("{h}{br}"), border),
        ]));
        lines
    }
}

/// What the picker does with a key: nothing more, or it's done.
pub enum Outcome {
    Stay,
    Done(Option<String>),
    BackOut,
}

/// One key (in vigent's notation) for the picker.
pub fn feed(p: &mut Picker, key: &str) -> Outcome {
    let items = p.filtered();
    let n = items.len();
    let mv = |p: &mut Picker, by: isize| {
        if n > 0 {
            p.index = ((p.index as isize + by).rem_euclid(n as isize)) as usize;
        }
    };
    if key == "<C-c>" {
        return Outcome::Done(None);
    }
    if key == "<CR>" {
        let q = p.query.trim().to_string();
        let picked = items.get(p.index).map(|c| c.value.clone()).or(if p.custom && !q.is_empty() { Some(q) } else { None });
        return match picked {
            Some(v) => Outcome::Done(Some(v)),
            None => Outcome::Stay,
        };
    }
    if ["<Down>", "<Tab>", "<C-n>", "<C-j>"].contains(&key) {
        mv(p, 1);
    } else if ["<Up>", "<S-Tab>", "<C-p>", "<C-k>"].contains(&key) {
        mv(p, -1);
    } else if p.searching {
        match key {
            "<Esc>" => p.searching = false,
            "<BS>" | "<C-h>" => {
                if !p.query.is_empty() {
                    p.query.pop();
                } else if p.back_out.is_some() {
                    return Outcome::BackOut;
                } else {
                    p.searching = false;
                }
                p.index = 0;
            }
            "<C-u>" => {
                p.query.clear();
                p.index = 0;
            }
            k => {
                if let Some(text) = crate::keys::token_text(k) {
                    p.query.push_str(&text);
                    p.index = 0;
                }
            }
        }
    } else {
        match key {
            "j" => mv(p, 1),
            "k" => mv(p, -1),
            "g" => p.index = 0,
            "G" => p.index = n.saturating_sub(1),
            "/" => p.searching = true,
            "q" => return Outcome::Done(None),
            "<Esc>" => {
                if p.query.is_empty() {
                    return Outcome::Done(None);
                }
                p.query.clear();
                p.index = 0;
            }
            _ => {}
        }
    }
    p.keep_visible();
    Outcome::Stay
}

/// pi-tui's fuzzy match: every query character in order; lower scores are better.
pub fn fuzzy_match(query: &str, text: &str) -> Option<f64> {
    fn run(q: &[char], t: &[char]) -> Option<f64> {
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
                let boundary = i == 0 || matches!(t[i - 1], ' ' | '\t' | '-' | '_' | '.' | '/' | ':');
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
        if q == t {
            score -= 100.0;
        }
        Some(score)
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    if let Some(s) = run(&q, &t) {
        return Some(s);
    }
    // "abc12" also finds "12abc", and the other way
    let letters: String = q.iter().take_while(|c| c.is_ascii_lowercase()).collect();
    let digits: String = q.iter().skip(letters.chars().count()).collect();
    let swapped: Option<String> = if !letters.is_empty() && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
        Some(format!("{digits}{letters}"))
    } else {
        let d: String = q.iter().take_while(|c| c.is_ascii_digit()).collect();
        let l: String = q.iter().skip(d.chars().count()).collect();
        (!d.is_empty() && !l.is_empty() && l.chars().all(|c| c.is_ascii_lowercase())).then(|| format!("{l}{d}"))
    };
    let s: Vec<char> = swapped?.chars().collect();
    run(&s, &t).map(|x| x + 5.0)
}

/// Items whose text matches every space-separated token, best first.
pub fn fuzzy_filter<T>(items: Vec<T>, query: &str, text: impl Fn(&T) -> String) -> Vec<T> {
    let tokens: Vec<&str> = query.split_whitespace().collect();
    if tokens.is_empty() {
        return items;
    }
    let mut scored: Vec<(f64, usize, T)> = vec![];
    for (i, item) in items.into_iter().enumerate() {
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
            scored.push((total, i, item));
        }
    }
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, x)| x).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picker(items: &[&str]) -> Picker {
        Picker::new("Attach a file · shop", Some(items.iter().map(|s| Choice::new(*s)).collect()), None, false, Box::new(|_, _| {}))
    }

    #[test]
    fn filter_move_pick() {
        let mut p = picker(&["README.md", "src/cart.js", "src/checkout.js"]);
        p.searching = true;
        for k in ["c", "a", "r", "t"] {
            feed(&mut p, k);
        }
        assert_eq!(p.filtered().iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), vec!["src/cart.js"]);
        let t = crate::theme::load("default").unwrap();
        let text: String = p.lines(64, &t, "unicode").last().unwrap().spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains(" 1/1 · type to filter · Esc done "), "{text}");
        assert!(matches!(feed(&mut p, "<CR>"), Outcome::Done(Some(v)) if v == "src/cart.js"));
        let mut p = picker(&["a", "b"]);
        feed(&mut p, "j");
        assert_eq!(p.index, 1);
        feed(&mut p, "j");
        assert_eq!(p.index, 0);
        assert!(matches!(feed(&mut p, "q"), Outcome::Done(None)));
    }

    #[test]
    fn fuzzy_scores() {
        assert!(fuzzy_match("ct", "src/cart.js").is_some());
        assert!(fuzzy_match("xyz", "src/cart.js").is_none());
        let sorted = fuzzy_filter(vec!["src/checkout.js", "cart.js"], "cart", |s| s.to_string());
        assert_eq!(sorted[0], "cart.js");
    }
}
