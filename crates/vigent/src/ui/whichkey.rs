//! which-key.nvim's panel (src/app.ts whichKeyPanel): after <leader> (or any
//! prefix) and a pause, every key that can follow and what it does, over the
//! bottom of the screen.

use super::text::{Seg, exact, fit, width};
use crate::app::App;
use crate::keys::Rhs;

/// A key's job, short: what an ex command does (from :help), else the action's description.
pub fn label(rhs: &[Rhs]) -> String {
    let l = settings_label(rhs);
    // drop a trailing " (:cmd)"
    let l = match l.rfind(" (:") {
        Some(i) if l.ends_with(')') => l[..i].to_string(),
        _ => l,
    };
    let mut c = l.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => l,
    }
}

pub fn settings_label(rhs: &[Rhs]) -> String {
    if let [Rhs::Ex { cmd, execute }] = rhs {
        let word = cmd.split_whitespace().next().unwrap_or("");
        let help = crate::help::EX_HELP.iter().find(|(c, _)| *c == format!(":{word}") || c.starts_with(&format!(":{word} ")));
        let shown = format!(":{}{}", cmd.trim_end(), if *execute { "" } else { " …" });
        return match help {
            Some((_, d)) => format!("{} ({shown})", d.split(" (").next().unwrap_or(d)),
            None => shown,
        };
    }
    describe(rhs)
}

pub fn describe(rhs: &[Rhs]) -> String {
    rhs.iter()
        .map(|r| match r {
            Rhs::Action { name, arg } => {
                let d = crate::keys::ACTIONS.iter().find(|(n, _)| n == name).map(|(_, d)| *d).unwrap_or(name.as_str());
                format!("{d}{}", arg.as_ref().map(|a| format!(" ({a})")).unwrap_or_default())
            }
            Rhs::Ex { cmd, execute } => format!(":{}{}", cmd.trim_end(), if *execute { "" } else { " …" }),
            Rhs::Keys(k) => format!("same as {}", k.concat()),
            Rhs::Nop => "disabled".into(),
        })
        .collect::<Vec<_>>()
        .join(", then ")
}

pub fn panel(app: &App, w: usize, max_rows: usize) -> Vec<Vec<Seg>> {
    let t = &app.theme;
    let typed = &app.seq.pending;
    let mode = app.mode.keys();
    let mut next: Vec<(String, String, bool)> = vec![];
    let bindings = app.keymap.bindings(mode);
    for b in &bindings {
        if b.keys.len() <= typed.len() || !typed.iter().enumerate().all(|(i, k)| b.keys[i] == *k) {
            continue;
        }
        if b.rhs.len() == 1 && b.rhs[0] == Rhs::Nop {
            continue;
        }
        let key = b.keys[typed.len()].clone();
        if b.keys.len() == typed.len() + 1 {
            match next.iter_mut().find(|(k, _, _)| *k == key) {
                Some(e) => *e = (key, label(&b.rhs), false),
                None => next.push((key, label(&b.rhs), false)),
            }
        } else if !next.iter().any(|(k, _, _)| *k == key) {
            next.push((key, String::new(), true));
        }
    }
    for e in next.iter_mut().filter(|e| e.2) {
        let n = bindings.iter().filter(|b| b.keys.len() > typed.len() + 1 && b.keys[typed.len()] == e.0 && typed.iter().enumerate().all(|(i, k)| b.keys[i] == *k)).count();
        e.1 = format!("+{n} more");
    }
    next.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then(b.0.cmp(&a.0)));
    let float = t.hl("NormalFloat");
    let on = |g: &str| match float.bg {
        Some(bg) => t.fg(g).bg(bg),
        None => t.fg(g),
    };
    let (tl, tr, bl, br, h, v) = if app.config.ui.icons == "ascii" { ("+", "+", "+", "+", "-", "|") } else { ("╭", "╮", "╰", "╯", "─", "│") };
    let inner = w.saturating_sub(2);
    let key_w = next.iter().map(|(k, _, _)| width(k)).max().unwrap_or(1).max(1);
    let col_w = next.iter().map(|(k, l, _)| width(k) + 3 + width(l) + 3).max().unwrap_or(0).clamp(24, 46);
    let cols = (inner.saturating_sub(2) / col_w).max(1);
    let rows_needed = next.len().div_ceil(cols);
    let rows = rows_needed.min(max_rows.saturating_sub(2).max(1));
    let border = on("FloatBorder");
    let mut lines = vec![];
    let title = format!(" {} ", typed.concat());
    lines.push(exact(
        vec![Seg::new(format!("{tl}{h}"), border), Seg::new(title.clone(), on("FloatTitle")), Seg::new(format!("{}{tr}", h.repeat(inner.saturating_sub(1 + width(&title)))), border)],
        w,
        border,
    ));
    for r in 0..rows {
        let mut row = vec![Seg::new(v, border), Seg::new(" ", on("NormalFloat"))];
        let mut used = 1;
        for c in 0..cols {
            let Some((k, l, group)) = next.get(c * rows + r) else { break };
            let lab = fit(l, col_w.saturating_sub(key_w + 4));
            let cell_w = key_w + 3 + width(&lab);
            row.push(Seg::new(format!("{k:>key_w$}"), on("Special")));
            row.push(Seg::new(" → ", on("Comment")));
            row.push(Seg::new(lab, on(if *group { "Keyword" } else { "NormalFloat" })));
            row.push(Seg::new(" ".repeat(col_w.saturating_sub(cell_w)), on("NormalFloat")));
            used += col_w;
        }
        row.push(Seg::new(" ".repeat(inner.saturating_sub(used)), on("NormalFloat")));
        let mut row = exact(row, w.saturating_sub(1), on("NormalFloat"));
        row.push(Seg::new(v, border));
        lines.push(row);
    }
    let more = if next.len() > rows * cols { format!(" {} more: widen the terminal ", next.len() - rows * cols) } else { String::new() };
    let foot = format!(" Esc cancels{}", if more.is_empty() { " ".into() } else { format!(" ·{more}") });
    lines.push(exact(vec![Seg::new(bl, border), Seg::new(foot.clone(), on("Comment")), Seg::new(format!("{}{br}", h.repeat(inner.saturating_sub(width(&foot)))), border)], w, border));
    lines
}
