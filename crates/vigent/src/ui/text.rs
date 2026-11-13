//! Text helpers every part of the screen uses: display width, cutting to a
//! width, padding, wrapping styled pieces, and [`Seg`]: a styled piece of a
//! row that may be a terminal hyperlink (OSC 8).

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// `s` cut to `max` columns, with … when it was longer.
pub fn fit(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = c.width().unwrap_or(0);
        if w + cw + 1 > max {
            break;
        }
        out.push(c);
        w += cw;
    }
    out + "…"
}

/// `s` cut to `max` columns, no ellipsis.
pub fn cut(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = c.width().unwrap_or(0);
        if w + cw > max {
            break;
        }
        out.push(c);
        w += cw;
    }
    out
}

pub fn pad(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(width(s))))
}

/// A styled piece of a row; `link` makes it a terminal hyperlink.
#[derive(Clone, Debug, PartialEq)]
pub struct Seg {
    pub text: String,
    pub style: Style,
    pub link: Option<String>,
}

impl Seg {
    pub fn new(text: impl Into<String>, style: Style) -> Seg {
        Seg { text: text.into(), style, link: None }
    }
}

pub fn segs_width(segs: &[Seg]) -> usize {
    segs.iter().map(|s| width(&s.text)).sum()
}

pub fn segs_plain(segs: &[Seg]) -> String {
    segs.iter().map(|s| s.text.as_str()).collect()
}

/// Cut a row of pieces to `max` columns.
pub fn fit_segs(segs: Vec<Seg>, max: usize) -> Vec<Seg> {
    let mut out = vec![];
    let mut used = 0;
    for s in segs {
        if used >= max {
            break;
        }
        let w = width(&s.text);
        if used + w <= max {
            used += w;
            out.push(s);
        } else {
            let t = cut(&s.text, max - used);
            used += width(&t);
            out.push(Seg { text: t, ..s });
        }
    }
    out
}

/// A row of pieces exactly `w` columns wide: cut, or padded in `fill`.
pub fn exact(segs: Vec<Seg>, w: usize, fill: Style) -> Vec<Seg> {
    let mut out = fit_segs(segs, w);
    let used = segs_width(&out);
    if used < w {
        out.push(Seg::new(" ".repeat(w - used), fill));
    }
    out
}

pub fn to_line(segs: Vec<Seg>) -> Line<'static> {
    Line::from(segs.into_iter().map(|s| Span::styled(s.text, s.style)).collect::<Vec<_>>())
}

/// Styled pieces wrapped to `w` columns at spaces, like pi-tui's
/// wrapTextWithAnsi: a word longer than the line is cut, the blanks where a
/// line breaks go.
pub fn wrap_segs(segs: &[Seg], w: usize) -> Vec<Vec<Seg>> {
    let w = w.max(1);
    let mut lines: Vec<Vec<Seg>> = vec![];
    let mut cur: Vec<Seg> = vec![];
    let mut col = 0;
    let push_piece = |cur: &mut Vec<Seg>, text: &str, s: &Seg| {
        if text.is_empty() {
            return;
        }
        if let Some(last) = cur.last_mut()
            && last.style == s.style
            && last.link == s.link
        {
            last.text.push_str(text);
            return;
        }
        cur.push(Seg { text: text.to_string(), style: s.style, link: s.link.clone() });
    };
    // words with the blanks after them, keeping which piece each part came from
    let mut words: Vec<Vec<(String, usize)>> = vec![vec![]];
    for (si, s) in segs.iter().enumerate() {
        let mut word = String::new();
        let mut in_blank = false;
        for c in s.text.chars() {
            if c == ' ' {
                in_blank = true;
                word.push(c);
            } else {
                if in_blank {
                    words.last_mut().unwrap().push((std::mem::take(&mut word), si));
                    words.push(vec![]);
                    in_blank = false;
                }
                word.push(c);
            }
        }
        if !word.is_empty() {
            words.last_mut().unwrap().push((word, si));
        }
        if in_blank {
            words.push(vec![]);
        }
    }
    for word in words {
        let text: String = word.iter().map(|(t, _)| t.as_str()).collect();
        if text.is_empty() {
            continue;
        }
        let ww = width(text.trim_end_matches(' '));
        if col > 0 && col + ww > w {
            trim_end(&mut cur);
            lines.push(std::mem::take(&mut cur));
            col = 0;
        }
        if ww > w {
            // longer than a line: cut it
            for (t, si) in &word {
                for c in t.chars() {
                    let cw = c.width().unwrap_or(0);
                    if col + cw > w && col > 0 {
                        trim_end(&mut cur);
                        lines.push(std::mem::take(&mut cur));
                        col = 0;
                        if c == ' ' {
                            continue;
                        }
                    }
                    push_piece(&mut cur, &c.to_string(), &segs[*si]);
                    col += cw;
                }
            }
        } else {
            for (t, si) in &word {
                push_piece(&mut cur, t, &segs[*si]);
            }
            col += width(&text);
        }
    }
    trim_end(&mut cur);
    lines.push(cur);
    lines
}

fn trim_end(cur: &mut Vec<Seg>) {
    while let Some(last) = cur.last_mut() {
        let t = last.text.trim_end_matches(' ').to_string();
        if t.is_empty() {
            cur.pop();
        } else {
            last.text = t;
            break;
        }
    }
}

/// Styled pieces of one logical line, wrapped to `w` columns, as ratatui lines (with a hanging indent).
pub fn wrap(parts: Vec<(String, Style)>, w: usize, indent: usize) -> Vec<Line<'static>> {
    let segs: Vec<Seg> = parts.into_iter().map(|(t, s)| Seg::new(t, s)).collect();
    wrap_segs(&segs, w.saturating_sub(indent).max(1))
        .into_iter()
        .enumerate()
        .map(|(i, mut l)| {
            if i > 0 && indent > 0 {
                l.insert(0, Seg::new(" ".repeat(indent), Style::default()));
            }
            to_line(l)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(lines: Vec<Vec<Seg>>) -> Vec<String> {
        lines.iter().map(|l| segs_plain(l)).collect()
    }

    #[test]
    fn wraps_at_spaces_and_cuts_long_words() {
        let s = vec![Seg::new("go to ", Style::default()), Seg::new("https://example.com/a/long/path", Style::default())];
        assert_eq!(plain(wrap_segs(&s, 20)), vec!["go to", "https://example.com/", "a/long/path"]);
        assert_eq!(plain(wrap_segs(&[Seg::new("", Style::default())], 10)), vec![""]);
        assert_eq!(plain(wrap_segs(&[Seg::new("  indented text here", Style::default())], 12)), vec!["  indented", "text here"]);
        assert_eq!(fit("abcdef", 4), "abc…");
        assert_eq!(segs_width(&exact(vec![Seg::new("漢字", Style::default())], 5, Style::default())), 5);
    }
}
