//! Markdown for agent replies, in vim's highlight groups (src/markdown.ts):
//! headings (Title), **bold**, *italic*, ~~strike~~, `code` and fenced code
//! blocks (VigentCode), links (clickable, as terminal hyperlinks), bullet /
//! numbered / task lists (nested), > quotes (Comment), --- rules and tables.
//! Code blocks are numbered so VISUAL-mode `ib` and `yib` can select them.

use ratatui::style::{Modifier, Style};

use super::text::{Seg, segs_plain, segs_width, width, wrap_segs};
use crate::theme::Theme;

#[derive(Clone, Debug)]
pub struct MdLine {
    pub segs: Vec<Seg>,
    pub plain: String,
    /// the code block this line belongs to
    pub block: Option<usize>,
    /// the block's language label: part of the block for selection, never copied
    pub label: bool,
}

fn md_line(segs: Vec<Seg>) -> MdLine {
    let plain = segs_plain(&segs);
    MdLine { segs, plain, block: None, label: false }
}

/// An http(s) URL a terminal can open, or None.
fn link_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    if rest.is_empty() || !url.chars().all(|c| ('\x21'..='\x7e').contains(&c)) {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    // URL() adds the slash after a bare host
    Some(if rest.contains('/') { url.to_string() } else { format!("{url}/") })
}

/// A bare URL's end: not the sentence's punctuation, nor a `)` it didn't open.
fn trim_url(url: &str) -> String {
    let punct = |c: char| ".,;:!?*_~'\"".contains(c);
    let mut end = url.trim_end_matches(punct).to_string();
    while end.ends_with(')') && end.matches('(').count() < end.matches(')').count() {
        end.pop();
        end = end.trim_end_matches(punct).to_string();
    }
    end
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

enum Tok {
    Escape(char),
    Code(String),
    Bold(String),
    Strike(String),
    Italic(String),
    Link(String, String),
    Auto(String),
    Bare(String),
}

/// `open X close`, X non-blank at both ends and not the marker, shortest first.
fn delimited(c: &[char], i: usize, m: char, n: usize) -> Option<(String, usize)> {
    if i + n >= c.len() || !c[i..i + n].iter().all(|&x| x == m) {
        return None;
    }
    let s = i + n;
    if c[s] == m || c[s].is_whitespace() {
        return None;
    }
    let mut k = s + 1;
    while k + n <= c.len() {
        let last = c[k - 1];
        if last != m && !last.is_whitespace() && c[k..k + n].iter().all(|&x| x == m) {
            return Some((c[s..k].iter().collect(), k + n));
        }
        k += 1;
    }
    None
}

fn token_at(c: &[char], i: usize) -> Option<(Tok, usize)> {
    let ch = c[i];
    if ch == '\\' && i + 1 < c.len() && "\\`*_~[]()#>+-.!|".contains(c[i + 1]) {
        return Some((Tok::Escape(c[i + 1]), i + 2));
    }
    if ch == '`' {
        let mut n = 0;
        while i + n < c.len() && c[i + n] == '`' {
            n += 1;
        }
        let s = i + n;
        if s < c.len() && c[s] != '`' {
            let mut e = s + 1;
            while e + n <= c.len() {
                let fence_ok = c[e..e + n].iter().all(|&x| x == '`') && c.get(e + n) != Some(&'`') && c[e - 1] != '`';
                if fence_ok {
                    let mut code: String = c[s..e].iter().collect();
                    if code.len() >= 2 && code.starts_with(' ') && code.ends_with(' ') {
                        code = code[1..code.len() - 1].to_string();
                    }
                    return Some((Tok::Code(code), e + n));
                }
                e += 1;
            }
        }
    }
    if ch == '*' {
        if let Some((t, end)) = delimited(c, i, '*', 2) {
            return Some((Tok::Bold(t), end));
        }
    }
    if ch == '_'
        && let Some((t, end)) = delimited(c, i, '_', 2)
    {
        return Some((Tok::Bold(t), end));
    }
    if ch == '~'
        && let Some((t, end)) = delimited(c, i, '~', 2)
    {
        return Some((Tok::Strike(t), end));
    }
    if ch == '*'
        && let Some((t, end)) = delimited(c, i, '*', 1)
    {
        return Some((Tok::Italic(t), end));
    }
    if ch == '_' && (i == 0 || !is_word(c[i - 1])) {
        // like the TypeScript's regex: the shortest run whose close isn't followed by a word character
        if let Some(s) = (i + 1 < c.len() && c[i + 1] != '_' && !c[i + 1].is_whitespace()).then_some(i + 1) {
            let mut k = s + 1;
            while k < c.len() {
                if c[k] == '_' && c[k - 1] != '_' && !c[k - 1].is_whitespace() && c.get(k + 1).is_none_or(|&x| !is_word(x)) {
                    return Some((Tok::Italic(c[s..k].iter().collect()), k + 1));
                }
                k += 1;
            }
        }
    }
    if ch == '[' {
        if let Some(close) = c[i + 1..].iter().position(|&x| x == ']').map(|p| p + i + 1)
            && close > i + 1
            && c.get(close + 1) == Some(&'(')
        {
            let us = close + 2;
            let mut ue = us;
            while ue < c.len() && c[ue] != ')' && !c[ue].is_whitespace() {
                ue += 1;
            }
            if ue > us {
                let mut end = ue;
                // an optional "title"
                if end < c.len() && c[end].is_whitespace() {
                    let mut j = end;
                    while j < c.len() && c[j].is_whitespace() {
                        j += 1;
                    }
                    if c.get(j) == Some(&'"')
                        && let Some(q) = c[j + 1..].iter().position(|&x| x == '"').map(|p| p + j + 1)
                    {
                        end = q + 1;
                    }
                }
                if c.get(end) == Some(&')') {
                    return Some((Tok::Link(c[i + 1..close].iter().collect(), c[us..ue].iter().collect()), end + 1));
                }
            }
        }
    }
    if ch == '<' {
        let rest: String = c[i + 1..].iter().collect();
        if rest.starts_with("http://") || rest.starts_with("https://") {
            let mut e = i + 1;
            while e < c.len() && c[e] != '>' && !c[e].is_whitespace() {
                e += 1;
            }
            if c.get(e) == Some(&'>') {
                return Some((Tok::Auto(c[i + 1..e].iter().collect()), e + 1));
            }
        }
    }
    if ch == 'h' && (i == 0 || !(is_word(c[i - 1]) || c[i - 1] == '/')) {
        let rest: String = c[i..c.len().min(i + 8)].iter().collect();
        if rest.starts_with("http://") || rest.starts_with("https://") {
            let mut e = i;
            while e < c.len() && !c[e].is_whitespace() && !"<>`".contains(c[e]) {
                e += 1;
            }
            let raw: String = c[i..e].iter().collect();
            let scheme = if raw.starts_with("https://") { 8 } else { 7 };
            if raw.chars().count() > scheme {
                let url = trim_url(&raw);
                let n = url.chars().count();
                return Some((Tok::Bare(url), i + n));
            }
        }
    }
    None
}

/// Inline markdown in `base`'s style: `code`, **bold**, *italic*, ~~strike~~,
/// [links](url), <autolinks> and bare URLs (clickable).
pub fn inline(t: &Theme, text: &str, base: Style, urls: bool) -> Vec<Seg> {
    let c: Vec<char> = text.chars().collect();
    let mut out: Vec<Seg> = vec![];
    let mut plain = String::new();
    let flush = |out: &mut Vec<Seg>, plain: &mut String| {
        if !plain.is_empty() {
            out.push(Seg::new(std::mem::take(plain), base));
        }
    };
    let special = t.fg("Special").add_modifier(Modifier::UNDERLINED);
    let mut i = 0;
    while i < c.len() {
        let Some((tok, end)) = token_at(&c, i) else {
            plain.push(c[i]);
            i += 1;
            continue;
        };
        match tok {
            Tok::Escape(ch) => plain.push(ch),
            Tok::Code(code) => {
                flush(&mut out, &mut plain);
                out.push(Seg::new(code, t.hl("VigentCode")));
            }
            Tok::Bold(inner) | Tok::Strike(inner) | Tok::Italic(inner) if inner.is_empty() => plain.push_str(&inner),
            Tok::Bold(inner) => {
                flush(&mut out, &mut plain);
                out.extend(inline(t, &inner, base, urls).into_iter().map(|s| Seg { style: s.style.add_modifier(Modifier::BOLD), ..s }));
            }
            Tok::Strike(inner) => {
                flush(&mut out, &mut plain);
                out.extend(inline(t, &inner, base, urls).into_iter().map(|s| Seg { style: s.style.add_modifier(Modifier::CROSSED_OUT), ..s }));
            }
            Tok::Italic(inner) => {
                flush(&mut out, &mut plain);
                out.extend(inline(t, &inner, base, urls).into_iter().map(|s| Seg { style: s.style.add_modifier(Modifier::ITALIC), ..s }));
            }
            Tok::Link(label, url) => {
                flush(&mut out, &mut plain);
                out.push(Seg { text: label.clone(), style: special, link: link_url(&url) });
                if urls && url != label && !url.starts_with('#') {
                    out.push(Seg::new(format!(" ({url})"), t.fg("Comment")));
                }
            }
            Tok::Auto(url) | Tok::Bare(url) => {
                flush(&mut out, &mut plain);
                out.push(Seg { text: url.clone(), style: special, link: link_url(&url) });
            }
        }
        i = end;
    }
    flush(&mut out, &mut plain);
    out
}

#[derive(Clone, Copy, PartialEq)]
enum Align {
    Left,
    Center,
    Right,
}

/// `| --- | :-: |`: a table's separator row.
fn is_separator(line: &str) -> bool {
    let cs = cells(line);
    let has_pipe = line.contains('|');
    has_pipe
        && !cs.is_empty()
        && cs.iter().all(|c| {
            let c = c.trim();
            let inner = c.trim_start_matches(':').trim_end_matches(':');
            !inner.is_empty() && inner.chars().all(|x| x == '-')
        })
        && (cs.len() >= 2 || line.trim().starts_with('|') && line.trim().ends_with('|'))
}

/// The cells of a table row: `| a | b |` → ["a", "b"] (a `\|` stays in its cell).
fn cells(row: &str) -> Vec<String> {
    let mut s = row.trim();
    if let Some(r) = s.strip_prefix('|') {
        s = r;
    }
    if s.ends_with('|') && !s.ends_with("\\|") {
        s = &s[..s.len() - 1];
    }
    let mut out = vec![];
    let mut cur = String::new();
    let mut prev = ' ';
    for ch in s.chars() {
        if ch == '|' && prev != '\\' {
            out.push(cur.trim().replace("\\|", "|"));
            cur.clear();
        } else {
            cur.push(ch);
        }
        prev = ch;
    }
    out.push(cur.trim().replace("\\|", "|"));
    out
}

fn is_row(line: &str) -> bool {
    line.contains('|') && !line.trim().is_empty()
}

fn render_table(t: &Theme, rows: &[Vec<String>], aligns: &[Align], w: usize, ascii: bool) -> Vec<MdLine> {
    let (h, v, tl, tm, tr, ml, mm, mr, bl, bm, br) = if ascii { ("-", "|", "+", "+", "+", "+", "+", "+", "+", "+", "+") } else { ("─", "│", "┌", "┬", "┐", "├", "┼", "┤", "└", "┴", "┘") };
    let n = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let styled: Vec<Vec<Vec<Seg>>> = rows
        .iter()
        .enumerate()
        .map(|(ri, r)| (0..n).map(|c| inline(t, r.get(c).map(|s| s.as_str()).unwrap_or(""), if ri == 0 { t.fg("Title") } else { t.fg("Normal") }, false)).collect())
        .collect();
    let want: Vec<usize> = (0..n).map(|c| styled.iter().map(|r| segs_width(&r[c])).max().unwrap_or(1).max(1)).collect();
    let room = (n * 3).max(w.saturating_sub(3 * n + 1));
    let mut cols = want.clone();
    while cols.iter().sum::<usize>() > room {
        let max = *cols.iter().max().unwrap();
        let widest = cols.iter().position(|&x| x == max).unwrap();
        if cols[widest] <= 3 {
            break;
        }
        cols[widest] -= 1;
    }
    let non = t.fg("NonText");
    let border = |l: &str, m: &str, r: &str| {
        let s = format!("{l}{}{r}", cols.iter().map(|&cw| h.repeat(cw + 2)).collect::<Vec<_>>().join(m));
        md_line(vec![Seg::new(s, non)])
    };
    let mut out = vec![border(tl, tm, tr)];
    for (ri, row) in styled.iter().enumerate() {
        let wrapped: Vec<Vec<Vec<Seg>>> = row.iter().enumerate().map(|(c, cell)| wrap_segs(cell, cols[c])).collect();
        let height = wrapped.iter().map(|x| x.len()).max().unwrap_or(1);
        for li in 0..height {
            let mut segs = vec![Seg::new(v, non)];
            for c in 0..n {
                let piece = wrapped[c].get(li).cloned().unwrap_or_default();
                let padn = cols[c].saturating_sub(segs_width(&piece));
                let left = match aligns.get(c).copied().unwrap_or(Align::Left) {
                    Align::Right => padn,
                    Align::Center => padn / 2,
                    Align::Left => 0,
                };
                segs.push(Seg::new(format!(" {}", " ".repeat(left)), t.fg("Normal")));
                segs.extend(piece);
                segs.push(Seg::new(format!("{} ", " ".repeat(padn - left)), t.fg("Normal")));
                segs.push(Seg::new(v, non));
            }
            out.push(md_line(segs));
        }
        if ri == 0 {
            out.push(border(ml, mm, mr));
        }
    }
    out.push(border(bl, bm, br));
    out
}

/// A fence opening or closing: its marker run and language.
fn fence_at(raw: &str) -> Option<(String, String)> {
    let s = raw.trim_start();
    let m = s.chars().next()?;
    if m != '`' && m != '~' {
        return None;
    }
    let run: String = s.chars().take_while(|&c| c == m).collect();
    if run.chars().count() < 3 {
        return None;
    }
    let rest = s[run.len()..].trim_start();
    let lang: String = rest.chars().take_while(|c| c.is_alphanumeric() || "_+#.-".contains(*c)).collect();
    Some((run, lang))
}

/// Markdown as wrapped, styled lines; `bullet` is the list marker. Returns the lines and how many code blocks they number.
pub fn render(text: &str, width_: usize, t: &Theme, bullet: &str, start_block: usize, ascii: bool) -> (Vec<MdLine>, usize) {
    let mut lines: Vec<MdLine> = vec![];
    let w = width_.max(10);
    let mut block = start_block;
    let mut fence: Option<String> = None;
    let normal = t.fg("Normal");
    let push = |lines: &mut Vec<MdLine>, segs: Vec<Seg>, prefix: Vec<Seg>, rest: Vec<Seg>| {
        let pw = segs_width(&prefix);
        for (i, l) in wrap_segs(&segs, 4usize.max(w.saturating_sub(pw))).into_iter().enumerate() {
            let mut row = if i == 0 { prefix.clone() } else { rest.clone() };
            row.extend(l);
            lines.push(md_line(row));
        }
    };
    let src: Vec<&str> = text.split('\n').collect();
    let mut i = 0;
    while i < src.len() {
        let raw = src[i];
        let open = fence_at(raw);
        if let Some(f) = &fence {
            if let Some((run, lang)) = &open
                && run.chars().next() == f.chars().next()
                && run.chars().count() >= f.chars().count()
                && lang.is_empty()
            {
                fence = None;
                block += 1;
                i += 1;
                continue;
            }
            let mut l = md_line(vec![Seg::new("  ", normal), Seg::new(raw, t.hl("VigentCode"))]);
            l.block = Some(block);
            lines.push(l);
            i += 1;
            continue;
        }
        if let Some((run, lang)) = open {
            fence = Some(run);
            let label = format!("  {}", if lang.is_empty() { "code" } else { &lang });
            let mut l = md_line(vec![Seg::new(label, t.fg("NonText"))]);
            l.block = Some(block);
            l.label = true;
            lines.push(l);
            i += 1;
            continue;
        }
        if is_row(raw) && i + 1 < src.len() && is_separator(src[i + 1]) && !cells(raw).is_empty() {
            let aligns: Vec<Align> = cells(src[i + 1])
                .iter()
                .map(|c| match (c.starts_with(':'), c.ends_with(':')) {
                    (true, true) => Align::Center,
                    (_, true) => Align::Right,
                    _ => Align::Left,
                })
                .collect();
            let mut rows = vec![cells(raw)];
            let mut j = i + 2;
            while j < src.len() && is_row(src[j]) && !is_separator(src[j]) {
                rows.push(cells(src[j]));
                j += 1;
            }
            lines.extend(render_table(t, &rows, &aligns, w, ascii));
            i = j;
            continue;
        }
        let lead_spaces = raw.len() - raw.trim_start_matches(' ').len();
        let body = raw.trim_start_matches(' ');
        // # heading
        if lead_spaces <= 3 && body.starts_with('#') {
            let hashes = body.chars().take_while(|&c| c == '#').count();
            let after = &body[hashes..];
            if hashes <= 6 && (after.starts_with(' ') || after.starts_with('\t')) {
                let text = after.trim().trim_end_matches('#').trim_end();
                let mut segs = inline(t, text, t.fg("Title"), true);
                if hashes <= 2 {
                    for s in &mut segs {
                        s.style = s.style.add_modifier(Modifier::BOLD);
                    }
                }
                push(&mut lines, segs, vec![], vec![]);
                i += 1;
                continue;
            }
        }
        // --- rule
        let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        if lead_spaces <= 3 && compact.chars().count() >= 3 && compact.chars().all(|c| c == compact.chars().next().unwrap()) && matches!(compact.chars().next(), Some('-' | '*' | '_')) {
            let rule = (if ascii { "-" } else { "─" }).repeat(w.min(60));
            lines.push(md_line(vec![Seg::new(rule, t.fg("NonText"))]));
            i += 1;
            continue;
        }
        // > quote
        if lead_spaces <= 3 && body.starts_with('>') {
            let mut rest = body;
            let mut depth = 0;
            while let Some(r) = rest.strip_prefix('>') {
                depth += 1;
                rest = r.strip_prefix(' ').unwrap_or(r);
            }
            let bar = vec![Seg::new("▏ ".repeat(depth), t.fg("Comment"))];
            push(&mut lines, inline(t, rest, t.fg("Comment"), true), bar.clone(), bar);
            i += 1;
            continue;
        }
        // - item, 1. item, - [x] task
        if let Some((indent_n, marker, task, rest)) = list_item(raw) {
            let level = (indent_n / 2).min(6);
            let indent = "  ".repeat(level);
            let ordered = marker.chars().next().is_some_and(|c| c.is_ascii_digit());
            let (mark, group) = match task {
                Some(done) => (
                    if done {
                        if ascii { "[x]" } else { "☑" }
                    } else if ascii {
                        "[ ]"
                    } else {
                        "☐"
                    }
                    .to_string(),
                    if done { "String" } else { "Comment" },
                ),
                None => (if ordered { marker.clone() } else { bullet.to_string() }, "Special"),
            };
            let lead = vec![Seg::new(indent.clone(), normal), Seg::new(mark.clone(), t.fg(group)), Seg::new(" ", normal)];
            let hang = vec![Seg::new(" ".repeat(width(&indent) + width(&mark) + 1), normal)];
            push(&mut lines, inline(t, &rest, normal, true), lead, hang);
            i += 1;
            continue;
        }
        let segs = if raw.trim().is_empty() { vec![] } else { inline(t, raw, normal, true) };
        push(&mut lines, segs, vec![], vec![]);
        i += 1;
    }
    if fence.is_some() {
        block += 1;
    }
    (lines, block - start_block)
}

/// `  - [ ] text`: the indent (tabs as two), the marker, a task's state, the text.
fn list_item(raw: &str) -> Option<(usize, String, Option<bool>, String)> {
    let indent: String = raw.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let indent_n = indent.replace('\t', "  ").len();
    let s = &raw[indent.len()..];
    let marker: String = if s.starts_with(['-', '*', '+']) {
        s[..1].to_string()
    } else {
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || digits.len() > 9 {
            return None;
        }
        let next = s[digits.len()..].chars().next()?;
        if next != '.' && next != ')' {
            return None;
        }
        format!("{digits}{next}")
    };
    let after = &s[marker.len()..];
    if !after.starts_with([' ', '\t']) {
        return None;
    }
    let text = after.trim_start();
    if text.is_empty() {
        return None;
    }
    let task = if text.len() >= 4 && text.starts_with('[') && text[3..].starts_with([' ', '\t']) && text.as_bytes()[2] == b']' {
        match text.as_bytes()[1] {
            b' ' => Some(false),
            b'x' | b'X' => Some(true),
            _ => None,
        }
    } else {
        None
    };
    let text = if task.is_some() { text[3..].trim_start().to_string() } else { text.to_string() };
    Some((indent_n, marker, task, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(md: &str, w: usize) -> Vec<String> {
        let t = crate::theme::load("default").unwrap();
        render(md, w, &t, "•", 0, false).0.into_iter().map(|l| l.plain).collect()
    }

    #[test]
    fn blocks_lists_and_labels() {
        let t = crate::theme::load("default").unwrap();
        let reply = "# Plan\nFix the race in checkout with `waitFor`:\n- reproduce it\n- add a wait\n```js\nawait waitFor(() => cart.synced);\nexpect(badge).toBe(3);\n```\nDone.";
        let (lines, blocks) = render(reply, 80, &t, "•", 0, false);
        let p: Vec<&str> = lines.iter().map(|l| l.plain.as_str()).collect();
        assert_eq!(p, vec!["Plan", "Fix the race in checkout with waitFor:", "• reproduce it", "• add a wait", "  js", "  await waitFor(() => cart.synced);", "  expect(badge).toBe(3);", "Done."]);
        assert_eq!(blocks, 1);
        assert_eq!(lines.iter().map(|l| l.block).collect::<Vec<_>>(), vec![None, None, None, None, Some(0), Some(0), Some(0), None]);
        assert!(lines[4].label && !lines[5].label);
        assert!(lines[0].segs[0].style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn tables() {
        let md = "| Test | Runs | Notes |\n|:--|--:|:-:|\n| checkout | 50 | waits a fixed **50ms** before checking |\n| cart | 5 | [issue](https://example.com/1) |";
        assert_eq!(
            plain(md, 80),
            vec![
                "┌──────────┬──────┬────────────────────────────────────┐",
                "│ Test     │ Runs │               Notes                │",
                "├──────────┼──────┼────────────────────────────────────┤",
                "│ checkout │   50 │ waits a fixed 50ms before checking │",
                "│ cart     │    5 │               issue                │",
                "└──────────┴──────┴────────────────────────────────────┘",
            ]
        );
        let narrow = plain(md, 30);
        assert!(narrow.iter().all(|l| l.chars().count() <= 30), "{narrow:#?}");
    }

    #[test]
    fn lists_rules_quotes_inline() {
        let md = "1. first\n2. second\n  - nested\n- [x] done\n- [ ] todo\n---\n> a quote long enough to wrap onto a second line here\n*italic* ~~gone~~ [docs](https://vigent.farming-labs.dev/docs) \\*kept\\*";
        let p = plain(md, 40);
        assert_eq!(&p[..5], &["1. first", "2. second", "  • nested", "☑ done", "☐ todo"]);
        assert_eq!(p[5], "─".repeat(40));
        assert!(p[6].starts_with("▏ ") && p[7].starts_with("▏ "));
        assert_eq!(p[8..].join(" "), "italic gone docs (https://vigent.farming-labs.dev/docs) *kept*");
        assert_eq!(plain("three mugs show **3**, an empty cart **0**.", 80)[0], "three mugs show 3, an empty cart 0.");
        assert_eq!(plain("*a* and *b*, ~~x~~ or ~~y~~", 80)[0], "a and b, x or y");
    }

    #[test]
    fn links() {
        let t = crate::theme::load("default").unwrap();
        let md = "see https://example.com/a_b_c. then\n(https://en.wikipedia.org/wiki/Vim_(text_editor)) and `https://example.com/code`\nno ftp://example.com or javascript:alert(1) links";
        let (lines, _) = render(md, 200, &t, "•", 0, false);
        let urls = |l: &MdLine| l.segs.iter().filter_map(|s| s.link.clone()).collect::<Vec<_>>();
        assert_eq!(urls(&lines[0]), vec!["https://example.com/a_b_c"]);
        assert_eq!(lines[0].plain, "see https://example.com/a_b_c. then");
        assert_eq!(urls(&lines[1]), vec!["https://en.wikipedia.org/wiki/Vim_(text_editor)"]);
        assert!(urls(&lines[2]).is_empty());
        let long = plain("go to https://example.com/a/very/long/path/that/wraps/onto/the/next/line", 30);
        assert_eq!(long[0], "go to");
    }
}
