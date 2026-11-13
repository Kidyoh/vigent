//! The SESSIONS sidebar (src/app.ts renderSidebar): neo-tree's look (tree),
//! one row each (compact) or a box per agent (cards), as [style] sidebar
//! says; the engines at the bottom, like a second neo-tree source.

use super::icons::{icons, nerd};
use super::text::{Seg, exact, fit, segs_width, width};
use crate::app::App;
use crate::session::State;

/// Segments cut to fit `room` columns (the last one that doesn't fit ends in …).
fn fit_segments(segs: Vec<(&'static str, String)>, room: usize) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    let mut used = 0;
    for (g, t) in segs {
        if t.is_empty() {
            continue;
        }
        if used >= room {
            break;
        }
        let cut = if width(&t) > room - used { fit(&t, room - used) } else { t };
        used += width(&cut);
        out.push((g, cut));
    }
    out
}

pub fn lines(app: &App, w: usize, h: usize) -> Vec<Vec<Seg>> {
    let t = &app.theme;
    let ic = icons(app);
    let base_bg = t.hl("VigentSidebar").bg.or(t.normal().bg);
    let cl_bg = t.hl("CursorLine").bg.or(base_bg);
    let focused_sb = app.windows.sidebar_focused;
    let row = |segs: Vec<(&str, String)>, bg: Option<ratatui::style::Color>| -> Vec<Seg> {
        let mut out = vec![];
        let mut used = 0;
        for (g, text) in segs {
            let tx = fit(&text, w.saturating_sub(used));
            used += width(&tx);
            let mut st = t.fg(g);
            if let Some(b) = bg {
                st = st.bg(b);
            }
            out.push(Seg::new(tx, st));
        }
        let mut fill = t.fg("VigentSidebar");
        if let Some(b) = bg {
            fill = fill.bg(b);
        }
        exact(out, w, fill)
    };
    let mut lines: Vec<Vec<Seg>> = vec![];
    let open = app.open();
    let running = open.iter().filter(|&&i| app.sessions[i].state == State::Running).count();
    let right = if running > 0 { format!("{running} running ") } else { format!("{} ", open.len()) };
    let is_nerd = app.config.ui.icons == "nerd";
    let title = if focused_sb {
        format!("{} SESSIONS", ic.folded)
    } else if is_nerd {
        format!(" {} SESSIONS", nerd::LIST)
    } else {
        " SESSIONS".into()
    };
    lines.push(row(
        vec![(if focused_sb { "Title" } else { "WinBar" }, title.clone()), ("VigentSidebar", " ".repeat(1.max(w as isize - width(&title) as isize - width(&right) as isize) as usize)), ("Comment", right)],
        base_bg,
    ));
    let style = app.config.style.sidebar.clone().unwrap_or_else(|| "tree".into());
    let ascii = app.config.ui.icons == "ascii";
    let spin = super::spinner(app);
    for (n, &i) in open.iter().enumerate() {
        let s = &app.sessions[i];
        let last = n + 1 == open.len();
        let focused = i == app.focus;
        let row_bg = if focused {
            if focused_sb { t.hl("PmenuSel").bg.or(t.hl("Visual").bg).or(cl_bg) } else { cl_bg }
        } else {
            base_bg
        };
        let held = s.held();
        let glyph_group = match s.state {
            _ if held => "String",
            State::Running => "String",
            State::Waiting => "WarningMsg",
            State::Error => "ErrorMsg",
            _ => "Comment",
        };
        let glyph = match s.state {
            _ if held => spin.to_string(),
            State::Running => spin.to_string(),
            State::Waiting => ic.waiting.clone(),
            State::Idle => ic.idle.clone(),
            State::Paused => ic.paused.clone(),
            State::Error => ic.error.clone(),
        };
        let num = if app.config.ui.number { format!("{:>3} ", n + 1) } else { " ".into() };
        let model = crate::engines::shown_model(s).trim_start_matches("claude-").to_string();
        // finished, failed or needs you while you looked elsewhere (agents.rs), until you open it
        let unread = s.unread;
        let marks: Vec<(&str, String)> = vec![
            ("Comment", if s.queue.is_empty() { String::new() } else { format!(" {}{}", ic.queued, s.queue.len()) }),
            (if s.state == State::Error { "ErrorMsg" } else { "WarningMsg" }, if unread { format!(" {}", ic.unread) } else { String::new() }),
        ];
        let stat: Vec<(&str, String)> = if s.branch.is_some() && (s.stat.0 > 0 || s.stat.1 > 0) { vec![("Added", format!(" +{}", s.stat.0)), ("Removed", format!(" {}{}", ic.minus, s.stat.1))] } else { vec![] };
        let stat_w: usize = stat.iter().map(|(_, t)| width(t)).sum();
        let usage = { let u = s.usage(); if u.is_empty() { "0 tok".to_string() } else { u } };
        match style.as_str() {
            "compact" => {
                let bar = if focused { if ascii { "> " } else { "▎ " } } else { "  " };
                let lead = if app.config.ui.number { format!("{bar}{:>2} ", n + 1) } else { bar.to_string() };
                let mut left: Vec<(&str, String)> = vec![(if focused { "Title" } else { "LineNr" }, lead.clone()), (glyph_group, format!("{glyph} ")), (if focused { "Title" } else { "VigentSidebar" }, s.name.clone())];
                left.extend(marks.clone());
                let left_w: usize = left.iter().map(|(_, t)| width(t)).sum();
                let room = w.saturating_sub(stat_w + 2);
                let mut segs = fit_segments(left, room);
                segs.push(("VigentSidebar", " ".repeat(1.max(room as isize - left_w.min(room) as isize + 1) as usize)));
                segs.extend(stat.iter().map(|(g, t)| (if focused { *g } else { "Comment" }, t.clone())));
                lines.push(row(segs, row_bg));
                if focused {
                    let padn = width(&lead) + width(&format!("{glyph} "));
                    let room = 4.max(w.saturating_sub(padn + 1));
                    if let Some(b) = &s.branch {
                        lines.push(row(vec![("VigentSidebar", " ".repeat(padn)), ("Comment", fit(&format!("{}{b}", ic.worktree), room))], base_bg));
                    }
                    lines.push(row(vec![("VigentSidebar", " ".repeat(padn)), ("Comment", fit(&format!("{model} · {usage}"), room))], base_bg));
                }
            }
            "cards" => {
                let (tl, tr, bl, br, hz, vt) = if ascii { ("+", "+", "+", "+", "-", "|") } else { ("╭", "╮", "╰", "╯", "─", "│") };
                let border = if focused { if focused_sb { "Title" } else { "Special" } } else { "VigentIndent" };
                let inner = 4.max(w.saturating_sub(4));
                let label = if app.config.ui.number { format!("{hz} {} ", n + 1) } else { String::new() };
                let card = |segs: Vec<(&'static str, String)>| {
                    let fitted = fit_segments(segs, inner);
                    let used: usize = fitted.iter().map(|(_, t)| width(t)).sum();
                    let mut all = vec![(border, format!("{vt} "))];
                    all.extend(fitted);
                    all.push(("VigentSidebar", " ".repeat(inner.saturating_sub(used))));
                    all.push((border, format!(" {vt}")));
                    all
                };
                lines.push(row(vec![(border, format!("{tl}{label}{}{tr}", hz.repeat(w.saturating_sub(2 + width(&label)))))], base_bg));
                let mut first: Vec<(&'static str, String)> = vec![(glyph_group, format!("{glyph} ")), (if focused { "Title" } else { "VigentSidebar" }, s.name.clone())];
                first.extend(marks.iter().map(|(g, t)| (*g, t.clone())));
                lines.push(row(card(first), row_bg));
                if let Some(b) = &s.branch {
                    let branch = fit(b, 4.max(inner.saturating_sub(width(&ic.worktree) + stat_w)));
                    let mut segs: Vec<(&'static str, String)> = vec![("Comment", format!("{}{branch}", ic.worktree))];
                    segs.extend(stat.iter().map(|(g, t)| (*g, t.clone())));
                    lines.push(row(card(segs), row_bg));
                }
                lines.push(row(card(vec![("Comment", format!("{model} · {usage}"))]), row_bg));
                lines.push(row(vec![(border, format!("{bl}{}{br}", hz.repeat(w.saturating_sub(2))))], base_bg));
            }
            _ => {
                let mut segs: Vec<(&str, String)> = vec![
                    (if focused { "CursorLineNr" } else { "LineNr" }, num.clone()),
                    ("VigentIndent", if last { ic.last.clone() } else { ic.tee.clone() }),
                    (glyph_group, format!("{glyph} ")),
                    (if focused { "Title" } else { "VigentSidebar" }, s.name.clone()),
                ];
                segs.extend(marks);
                lines.push(row(segs, row_bg));
                let indent: Vec<(&str, String)> = vec![("LineNr", " ".repeat(num.chars().count())), ("VigentIndent", if last { "  ".into() } else { ic.pipe.clone() })];
                let mut second = indent;
                match &s.branch {
                    Some(b) => {
                        let room = w as isize - num.chars().count() as isize - 2 - 2 - width(&ic.worktree) as isize - stat_w as isize - 1;
                        let branch = fit(b, room.max(4) as usize);
                        second.push(("Comment", format!("  {}{branch}", ic.worktree)));
                        second.extend(stat);
                    }
                    None => second.push(("Comment", format!("  {model}"))),
                }
                lines.push(row(second, base_bg));
            }
        }
    }
    // engines at the bottom
    let infos = &app.engines.infos;
    let mut block: Vec<Vec<Seg>> = vec![];
    if h as isize - lines.len() as isize >= infos.len() as isize + 3 {
        let ready = infos.iter().filter(|e| e.connected).count();
        let title = if is_nerd { format!(" {} ENGINES", nerd::CHIP) } else { " ENGINES".into() };
        let count = format!("{ready}/{} ", infos.len());
        block.push(row(vec![("WinBar", title.clone()), ("VigentSidebar", " ".repeat(1.max(w as isize - width(&title) as isize - width(&count) as isize) as usize)), ("Comment", count)], base_bg));
        let def = app.new_agent_engine();
        let compact = style == "compact";
        for e in infos.iter().filter(|e| !(compact && !e.installed && !e.checking)) {
            let glyph = if e.connected { &ic.ok } else if e.installed { &ic.warn } else { &ic.off };
            let group = if e.connected { "String" } else if e.installed { "WarningMsg" } else { "Comment" };
            let note = if e.checking {
                "checking…".to_string()
            } else if e.connected {
                if e.id == def { "default".into() } else { String::new() }
            } else if e.id == "pi" && e.installed {
                "no API key".into()
            } else if e.installed {
                e.connect.clone().unwrap_or_else(|| "not signed in".into())
            } else {
                "not installed".into()
            };
            let left = format!("  {glyph} {}", e.name);
            let room = w.saturating_sub(width(&left) + 1);
            let tail = if note.is_empty() { String::new() } else { fit(&note, room.saturating_sub(1)) };
            block.push(row(
                vec![(group, format!("  {glyph} ")), (if e.connected { "VigentSidebar" } else { "Comment" }, e.name.clone()), ("VigentSidebar", " ".repeat(1.max(room as isize - width(&tail) as isize) as usize)), ("Comment", tail)],
                base_bg,
            ));
        }
        if compact {
            let rest = infos.iter().filter(|e| !e.installed && !e.checking).count();
            if rest > 0 {
                block.push(row(vec![("Comment", format!("  {} {rest} more · :checkhealth", ic.off))], base_bg));
            }
        }
    }
    while lines.len() + block.len() < h {
        lines.push(row(vec![("EndOfBuffer", if app.config.ui.tilde { "~".into() } else { String::new() })], base_bg));
    }
    lines.extend(block);
    lines.truncate(h);
    debug_assert!(lines.iter().all(|l| segs_width(l) == w));
    lines
}
