//! :diff layouts for the floating diff window (src/diffview.ts).
//!
//! unified: git's own output, colored.
//! split:   side by side, old on the left and new on the right, with line
//!          numbers; removed and added lines are paired up row by row.
//!
//! Both return the line indices of hunk headers so ]c / [c can jump.

use super::float::FLine;
use crate::ui::text::{fit, width};

pub struct DiffView {
    pub lines: Vec<FLine>,
    pub jumps: Vec<usize>,
}

fn line_group(line: &str) -> &'static str {
    if line.starts_with("+++") || line.starts_with("---") {
        "Title"
    } else if line.starts_with('+') {
        "Added"
    } else if line.starts_with('-') {
        "Removed"
    } else if line.starts_with("@@") {
        "Special"
    } else if ["diff --git", "index ", "new file", "deleted file", "similarity", "rename "].iter().any(|p| line.starts_with(p)) {
        "Comment"
    } else {
        "NormalFloat"
    }
}

fn lines_of(text: &str) -> Vec<&str> {
    text.strip_suffix('\n').unwrap_or(text).split('\n').collect()
}

pub fn unified_view(text: &str) -> DiffView {
    let raw = lines_of(text);
    DiffView {
        lines: raw.iter().map(|l| vec![(l.to_string(), line_group(l))]).collect(),
        jumps: raw.iter().enumerate().filter(|(_, l)| l.starts_with("@@")).map(|(i, _)| i).collect(),
    }
}

/// `truncateToWidth(text, w, "…")`: the empty string at width 0.
fn cut(text: &str, w: usize) -> String {
    if w == 0 { String::new() } else { fit(text, w) }
}

fn cell(no: Option<usize>, text: Option<&str>, w: usize, group: &'static str) -> Vec<(String, &'static str)> {
    let Some(text) = text else { return vec![(" ".repeat(w), "NonText")] };
    let num = no.map(|n| format!("{n:>4}")).unwrap_or_else(|| "    ".into());
    let body = cut(&text.replace('\t', "  "), w.saturating_sub(5));
    let room = w.saturating_sub(5).saturating_sub(width(&body));
    vec![(format!("{num} "), "LineNr"), (format!("{body}{}", " ".repeat(room)), group)]
}

/// The `@@ -a,b +c,d @@` numbers: (old start, new start).
fn hunk_starts(line: &str) -> Option<(usize, usize)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(' ')?;
    let rest = rest.strip_prefix('+')?;
    let (new, rest) = rest.split_once(' ')?;
    rest.starts_with("@@")
        .then_some(())
        .and_then(|_| Some((old.split(',').next()?.parse().ok()?, new.split(',').next()?.parse().ok()?)))
}

/// Side-by-side layout for a window `w` columns wide (inside its border).
pub fn split_view(text: &str, w: usize) -> DiffView {
    let col = 12.max(w.saturating_sub(3) / 2);
    let mut lines: Vec<FLine> = vec![];
    let mut jumps = vec![];
    let (mut old_no, mut new_no) = (0usize, 0usize);
    let mut dels: Vec<(usize, String)> = vec![];
    let mut adds: Vec<(usize, String)> = vec![];

    let row = |lines: &mut Vec<FLine>, l: Option<&(usize, String)>, r: Option<&(usize, String)>, lg: &'static str, rg: &'static str| {
        let mut v = cell(l.map(|x| x.0), l.map(|x| x.1.as_str()), col, lg);
        v.push((" │ ".into(), "NonText"));
        v.extend(cell(r.map(|x| x.0), r.map(|x| x.1.as_str()), col, rg));
        lines.push(v);
    };
    let flush = |lines: &mut Vec<FLine>, dels: &mut Vec<(usize, String)>, adds: &mut Vec<(usize, String)>| {
        for i in 0..dels.len().max(adds.len()) {
            row(lines, dels.get(i), adds.get(i), "Removed", "Added");
        }
        dels.clear();
        adds.clear();
    };

    for line in lines_of(text) {
        if line.starts_with("diff --git") {
            flush(&mut lines, &mut dels, &mut adds);
            if !lines.is_empty() {
                lines.push(vec![]);
            }
            continue;
        }
        if let Some(name) = line.strip_prefix("+++ ") {
            let name = name.strip_prefix("b/").unwrap_or(name);
            let name = if name == "/dev/null" { "(deleted file)" } else { name };
            lines.push(vec![(name.to_string(), "Title")]);
            continue;
        }
        if ["---", "index ", "new file", "deleted file", "similarity", "rename ", "\\ No newline"].iter().any(|p| line.starts_with(p)) {
            continue;
        }
        if let Some((o, n)) = hunk_starts(line) {
            flush(&mut lines, &mut dels, &mut adds);
            (old_no, new_no) = (o, n);
            jumps.push(lines.len());
            lines.push(vec![(line.to_string(), "Special")]);
            continue;
        }
        if let Some(t) = line.strip_prefix('-') {
            dels.push((old_no, t.to_string()));
            old_no += 1;
        } else if let Some(t) = line.strip_prefix('+') {
            adds.push((new_no, t.to_string()));
            new_no += 1;
        } else {
            flush(&mut lines, &mut dels, &mut adds);
            let t = line.strip_prefix(' ').unwrap_or(line).to_string();
            row(&mut lines, Some(&(old_no, t.clone())), Some(&(new_no, t)), "NormalFloat", "NormalFloat");
            old_no += 1;
            new_no += 1;
        }
    }
    flush(&mut lines, &mut dels, &mut adds);
    DiffView { lines, jumps }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "diff --git a/cart.js b/cart.js\nindex 1..2 100644\n--- a/cart.js\n+++ b/cart.js\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -10,2 +10,3 @@ fn\n ten\n+ten and a half\n eleven\n";

    fn plain(l: &FLine) -> String {
        l.iter().map(|(t, _)| t.as_str()).collect()
    }

    #[test]
    fn unified_colors_git_and_jumps_to_hunks() {
        let v = unified_view(DIFF);
        assert_eq!(v.jumps, [4, 9]);
        assert_eq!(v.lines[0][0].1, "Comment");
        assert_eq!(v.lines[3][0].1, "Title");
        assert_eq!(v.lines[6][0], ("-two".to_string(), "Removed"));
        assert_eq!(v.lines[7][0], ("+TWO".to_string(), "Added"));
    }

    #[test]
    fn split_pairs_removed_and_added_lines_with_numbers() {
        let v = split_view(DIFF, 63);
        let text: Vec<String> = v.lines.iter().map(plain).collect();
        assert_eq!(text[0], "cart.js");
        assert_eq!(v.jumps, [1, 5]);
        assert!(text[2].starts_with("   1 one"), "{:?}", text[2]);
        assert!(text[3].starts_with("   2 two") && text[3].contains(" │    2 TWO"), "{:?}", text[3]);
        assert!(text[7].contains("│   11 ten and a half"), "{:?}", text[7]);
        assert_eq!(v.lines[7][0].1, "NonText", "nothing on the left");
        assert!(text.iter().all(|t| width(t) <= 63));
    }
}
