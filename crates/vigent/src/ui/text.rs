//! Text helpers every part of the screen uses: display width, cutting to a
//! width, padding, and wrapping styled pieces.

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

pub fn pad(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(width(s))))
}

/// Styled pieces of one logical line, wrapped to `w` columns (at spaces when it can).
pub fn wrap(parts: Vec<(String, Style)>, w: usize, indent: usize) -> Vec<Line<'static>> {
    let w = w.max(8);
    let mut lines = vec![];
    let mut cur: Vec<Span<'static>> = vec![];
    let mut col = 0;
    for (text, style) in parts {
        for word in text.split_inclusive(' ') {
            let ww = width(word);
            if col + width(word.trim_end()) > w && col > indent {
                lines.push(Line::from(std::mem::take(&mut cur)));
                cur.push(Span::raw(" ".repeat(indent)));
                col = indent;
            }
            if ww > w - indent.min(w - 1) {
                // a word longer than the line: cut it
                for c in word.chars() {
                    let cw = c.width().unwrap_or(0);
                    if col + cw > w {
                        lines.push(Line::from(std::mem::take(&mut cur)));
                        cur.push(Span::raw(" ".repeat(indent)));
                        col = indent;
                    }
                    cur.push(Span::styled(c.to_string(), style));
                    col += cw;
                }
            } else {
                cur.push(Span::styled(word.to_string(), style));
                col += ww;
            }
        }
    }
    lines.push(Line::from(cur));
    lines
}

