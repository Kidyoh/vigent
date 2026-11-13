//! A reply, lightly formatted: headings, bullets, code blocks, bold and code
//! spans. (Windows area: the full src/markdown.ts, with folds and tool icons.)

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::text::wrap;
use crate::theme::Theme;

/// `**bold**` and `code` inside a line of a reply.
fn inline(text: &str, base: Style, t: &Theme) -> Vec<(String, Style)> {
    let mut out = vec![];
    let mut rest = text;
    while !rest.is_empty() {
        let bold = rest.find("**");
        let code = rest.find('`');
        let (at, marker) = match (bold, code) {
            (Some(b), Some(c)) if c < b => (c, "`"),
            (Some(b), _) => (b, "**"),
            (None, Some(c)) => (c, "`"),
            (None, None) => break,
        };
        let after = &rest[at + marker.len()..];
        let Some(end) = after.find(marker) else { break };
        if at > 0 {
            out.push((rest[..at].to_string(), base));
        }
        let inner = after[..end].to_string();
        let style = if marker == "`" { t.fg("String") } else { base.add_modifier(Modifier::BOLD) };
        out.push((inner, style));
        rest = &after[end + marker.len()..];
    }
    if !rest.is_empty() {
        out.push((rest.to_string(), base));
    }
    out
}

/// A reply, lightly formatted: headings, bullets, code blocks, bold and code spans.
pub fn reply(text: &str, w: usize, t: &Theme) -> Vec<Line<'static>> {
    let normal = t.fg("Normal");
    let mut out = vec![];
    let mut fence = false;
    for line in text.lines() {
        if let Some(lang) = line.trim_start().strip_prefix("```") {
            fence = !fence;
            if fence && !lang.trim().is_empty() {
                out.push(Line::from(Span::styled(format!("  {}", lang.trim()), t.fg("NonText"))));
            }
            continue;
        }
        if fence {
            out.extend(wrap(vec![(format!("  {line}"), t.fg("String"))], w, 2));
        } else if let Some(h) = line.strip_prefix('#') {
            let h = h.trim_start_matches('#').trim();
            out.extend(wrap(vec![(h.to_string(), t.fg("Title").add_modifier(Modifier::BOLD))], w, 0));
        } else if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            let mut parts = vec![("• ".to_string(), normal)];
            parts.extend(inline(item, normal, t));
            out.extend(wrap(parts, w, 2));
        } else {
            out.extend(wrap(inline(line, normal, t), w, 0));
        }
    }
    out
}

