//! The statusline ([statusline] left / right parts, src/app.ts
//! renderStatusline), the wildmenu that takes its place while a command is
//! typed, and the command line under it (renderCmdline): messages, the
//! prompt or the : / line being typed with its cursor, y/n questions,
//! VISUAL's hint and showcmd.

use super::icons::icons;
use super::text::{Seg, exact, fit, width};
use crate::app::{App, Mode};
use crate::line_edit::LineBuffer;
use crate::session::State;

pub fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::Normal => "NORMAL",
        Mode::Insert => "INSERT",
        Mode::Command => "COMMAND",
        Mode::Search => "SEARCH",
        Mode::Visual => "VISUAL",
    }
}

fn mode_group(m: Mode) -> &'static str {
    match m {
        Mode::Normal => "VigentModeNormal",
        Mode::Insert => "VigentModeInsert",
        Mode::Command | Mode::Search => "VigentModeCommand",
        Mode::Visual => "VigentModeVisual",
    }
}

/// The mode the statusline shows: NORMAL while the line is edited in NORMAL mode.
pub fn badge_mode(app: &App) -> Mode {
    if app.windows.line_normal(app.mode) { Mode::Normal } else { app.mode }
}

/// HH:MM, local time.
pub fn clock() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    #[cfg(unix)]
    {
        let t: libc::time_t = now as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: localtime_r writes into the tm we own
        if !unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
            return format!("{:02}:{:02}", tm.tm_hour, tm.tm_min);
        }
    }
    format!("{:02}:{:02}", (now / 3600) % 24, (now / 60) % 60)
}

/// The text of one [statusline] part.
pub fn part(app: &App, p: &str) -> String {
    let s = app.focused();
    let ic = icons(app);
    match p {
        "mode" => mode_name(app.mode).into(),
        "agent" => s.map(|s| s.name.clone()).unwrap_or_default(),
        "branch" => match s.and_then(|s| s.branch.as_ref().map(|b| (s, b))) {
            Some((s, b)) => {
                let changes = if s.stat.0 > 0 || s.stat.1 > 0 { format!(" +{} {}{}", s.stat.0, ic.minus, s.stat.1) } else { String::new() };
                format!("{}{b}{changes}", ic.worktree)
            }
            None => String::new(),
        },
        "engine" => s.map(|s| crate::engines::engine_name(&s.engine).to_string()).unwrap_or_default(),
        "model" => s.and_then(|s| s.model.clone()).unwrap_or_default(),
        "effort" => s.and_then(|s| s.effort.clone()).unwrap_or_default(),
        "usage" => s.map(|s| s.usage()).unwrap_or_default(),
        "agents" => {
            let open = app.open();
            let running = open.iter().filter(|&&i| app.sessions[i].state == State::Running).count();
            format!("{running}/{}{}", open.len(), if running > 0 { format!(" {}", super::spinner(app)) } else { String::new() })
        }
        "path" => match s {
            Some(s) if s.branch.is_some() => super::winbar::short_path(&s.path),
            Some(_) => "this checkout".into(),
            None => String::new(),
        },
        "clock" => clock(),
        _ => String::new(),
    }
}

/// [style] separators' glyphs: (toward the right, toward the left).
pub fn separator_glyphs(style: &str) -> Option<(&'static str, &'static str)> {
    match style {
        "round" => Some(("\u{e0b4}", "\u{e0b6}")),
        "arrow" => Some(("\u{e0b0}", "\u{e0b2}")),
        "slant" => Some(("\u{e0bc}", "\u{e0ba}")),
        _ => None,
    }
}

/// lualine's look (src/app.ts renderPowerline): the mode in its color, a lighter section, then the bar; the right side mirrors it.
fn powerline(app: &App, w: usize, (to_right, to_left): (&str, &str)) -> Vec<Seg> {
    use super::icons::nerd;
    use ratatui::style::{Color, Modifier, Style};
    let t = &app.theme;
    let s = app.focused();
    let badge = badge_mode(app);
    let mode = t.hl(mode_group(badge));
    let fill = t.hl("StatusLine").bg.or(t.normal().bg);
    let fill_fg = t.hl("Comment").fg.or(t.normal().fg);
    let middle = t.hl("CursorLine").bg.or(t.hl("Visual").bg).or(fill);
    let mid_fg = t.normal().fg;
    let icon = |p: &str| -> Option<&str> {
        Some(match p {
            "mode" => "\u{e62b}",
            "agent" => nerd::CHIP,
            "model" => nerd::BOLT,
            "engine" => nerd::TERMINAL,
            "effort" => nerd::GEAR,
            "usage" => "\u{f201}",
            "agents" => nerd::LIST,
            "path" => "\u{f07b}",
            "clock" => nerd::CLOCK,
            _ => return None,
        })
    };
    let text = |p: &str| -> String {
        if p == "mode" {
            return format!("{} {}", icon("mode").unwrap(), mode_name(badge));
        }
        let tx = if p == "agent" && s.is_none() { "no agent".to_string() } else if s.is_some() || p == "clock" || p == "agents" { part(app, p) } else { String::new() };
        if tx.is_empty() {
            return tx;
        }
        match icon(p) {
            Some(i) if p != "branch" => format!("{i} {tx}"),
            _ => tx,
        }
    };
    let st = |fg: Option<Color>, bg: Option<Color>, bold: bool| {
        let mut x = Style::default();
        if let Some(f) = fg {
            x = x.fg(f);
        }
        if let Some(b) = bg {
            x = x.bg(b);
        }
        if bold {
            x = x.add_modifier(Modifier::BOLD);
        }
        x
    };
    let colors = |i: usize, n: usize, from_end: bool| {
        let k = if from_end { n - 1 - i } else { i };
        match k {
            0 => (mode.fg, mode.bg, true),
            1 => (mid_fg, middle, false),
            _ => (fill_fg, fill, false),
        }
    };
    let build = |parts: &[String], from_end: bool| -> Vec<(String, (Option<Color>, Option<Color>, bool))> {
        let texts: Vec<String> = parts.iter().map(|p| text(p)).filter(|x| !x.is_empty()).collect();
        let n = texts.len();
        texts.into_iter().enumerate().map(|(i, x)| (format!(" {x} "), colors(i, n, from_end))).collect()
    };
    let layout = &app.config.layout.statusline;
    let left = build(&layout.left, false);
    let right = if s.is_some() { build(&layout.right, true) } else { vec![] };
    let mut out = vec![];
    if let Some((_, c)) = left.first() {
        out.push(Seg::new(to_left, st(c.1, fill, false)));
    }
    for (i, (x, c)) in left.iter().enumerate() {
        out.push(Seg::new(x.clone(), st(c.0, c.1, c.2)));
        let next = left.get(i + 1).map(|n| n.1.1).unwrap_or(fill);
        out.push(Seg::new(to_right, st(c.1, next, false)));
    }
    let mut tail = vec![];
    for (i, (x, c)) in right.iter().enumerate() {
        let prev = if i > 0 { right[i - 1].1.1 } else { fill };
        tail.push(Seg::new(to_left, st(c.1, prev, false)));
        tail.push(Seg::new(x.clone(), st(c.0, c.1, c.2)));
    }
    if let Some((_, c)) = right.last() {
        tail.push(Seg::new(to_right, st(c.1, fill, false)));
    }
    let used = super::text::segs_width(&out);
    let mut tail_w = super::text::segs_width(&tail);
    if used + tail_w > w {
        tail.clear();
        tail_w = 0;
    }
    out.push(Seg::new(" ".repeat(w.saturating_sub(used + tail_w)), st(None, fill, false)));
    out.extend(tail);
    exact(out, w, st(None, fill, false))
}

pub fn statusline(app: &App, w: usize) -> Vec<Seg> {
    let t = &app.theme;
    if app.config.ui.icons == "nerd"
        && let Some(g) = app.config.style.separators.as_deref().and_then(separator_glyphs)
    {
        return powerline(app, w, g);
    }
    let s = app.focused();
    let layout = &app.config.layout.statusline;
    let mut out = vec![];
    let mut left_w = 0;
    let mut first = true;
    let badge = badge_mode(app);
    for p in &layout.left {
        if p == "mode" {
            let b = format!(" {} ", mode_name(badge));
            left_w += width(&b);
            out.push(Seg::new(b, t.hl(mode_group(badge))));
            continue;
        }
        let text = if p == "agent" && s.is_none() { "[no session]".to_string() } else { part(app, p) };
        if text.is_empty() {
            continue;
        }
        let txt = if p == "branch" { format!("{text} ") } else { format!(" {text} ") };
        left_w += width(&txt);
        out.push(Seg::new(txt, t.hl(if first { "StatusLine" } else { "StatusLineNC" })));
        first = false;
    }
    let parts: Vec<String> = if s.is_some() { layout.right.iter().map(|p| if p == "mode" { format!(" {} ", mode_name(badge)) } else { part(app, p) }).filter(|x| !x.is_empty()).collect() } else { vec![] };
    let right = if s.is_some() && !parts.is_empty() { format!(" {} ", parts.join("  ")) } else { String::new() };
    let fill = w.saturating_sub(left_w + width(&right));
    out.push(Seg::new(" ".repeat(fill), t.hl(if first { "StatusLine" } else { "StatusLineNC" })));
    out.push(Seg::new(right, t.hl("StatusLine")));
    exact(out, w, t.hl("StatusLine"))
}

/// The wildmenu over the statusline: what fits while you type, then what <Tab> goes through.
pub fn wildmenu(app: &App, w: usize) -> Option<Vec<Seg>> {
    if app.mode != Mode::Command {
        return None;
    }
    let (items, idx): (Vec<String>, isize) = match &app.windows.wild {
        Some(wl) if wl.shown == app.cmd => (wl.items.clone(), wl.idx as isize),
        _ => {
            let typing = crate::actions::windows::completion_as_typed(app)?;
            (typing.0, -1)
        }
    };
    if items.len() < 2 {
        return None;
    }
    let t = &app.theme;
    let sl = t.hl("StatusLine");
    let cells: Vec<String> = items.iter().map(|x| format!(" {x} ")).collect();
    let mut first = 0usize;
    let fits = |from: usize| {
        let upto = (idx + 1).max(0) as usize;
        cells[from.min(upto)..upto.min(cells.len())].iter().map(|c| width(c)).sum::<usize>() + 4 <= w
    };
    while idx >= 0 && (idx as usize) < cells.len() && (first as isize) < idx && !fits(first) {
        first += 1;
    }
    let mut out = vec![];
    let mut used = 0;
    if first > 0 {
        out.push(Seg::new("< ", sl));
        used = 2;
    }
    for (i, c) in cells.iter().enumerate().skip(first) {
        if used + width(c) + 2 > w {
            out.push(Seg::new(" >", sl));
            used += 2;
            break;
        }
        out.push(Seg::new(c.clone(), if i as isize == idx { t.hl("PmenuSel") } else { sl }));
        used += width(c);
    }
    out.push(Seg::new(" ".repeat(w.saturating_sub(used)), sl));
    Some(exact(out, w, sl))
}

pub fn cmdline(app: &App, w: usize) -> Vec<Seg> {
    let t = &app.theme;
    let normal = t.fg("Normal");
    let win = &app.windows;
    let line_normal = win.line_normal(app.mode);
    let cursor_style = t.hl(if line_normal { "Cursor" } else { "PmenuSel" });
    let with_cursor = |b: &LineBuffer| {
        let (before, under, rest) = b.parts();
        vec![Seg::new(before, normal), Seg::new(under, cursor_style), Seg::new(rest, normal)]
    };
    let mut content: Vec<Seg> = vec![];
    if let Some(c) = &win.confirm {
        content.push(Seg::new(c.question.clone(), t.hl("Question")));
        content.push(Seg::new(" ", normal));
        content.push(Seg::new(" ", t.hl("PmenuSel")));
    } else {
        match app.mode {
            Mode::Command => {
                let b = LineBuffer::new(&app.cmd, cursor_pos(app, false));
                let rest = crate::actions::windows::completion_as_typed(app).map(|c| c.1).filter(|r| !r.is_empty());
                content.push(Seg::new(":", normal));
                match rest {
                    Some(rest) => {
                        let mut rc = rest.chars();
                        let first = rc.next().unwrap().to_string();
                        content.push(Seg::new(b.parts().0, normal));
                        content.push(Seg::new(first, cursor_style));
                        content.push(Seg::new(rc.collect::<String>(), t.hl("NonText")));
                    }
                    None => content.extend(with_cursor(&b)),
                }
            }
            Mode::Search => {
                let b = LineBuffer::new(&app.cmd, cursor_pos(app, false));
                content.push(Seg::new(if win.search_backward { "?" } else { "/" }, normal));
                content.extend(with_cursor(&b));
            }
            Mode::Visual => {
                let n = win.visual.0.abs_diff(win.visual.1) + 1;
                content.push(Seg::new("-- VISUAL LINE --", t.hl("ModeMsg")));
                content.push(Seg::new(format!("  {n} line{} · y yank · ib code block · Esc cancel", if n == 1 { "" } else { "s" }), t.hl("Comment")));
            }
            Mode::Insert => {
                let b = LineBuffer::new(&app.input, cursor_pos(app, true));
                let (before, under, rest) = b.parts();
                content.push(Seg::new(if line_normal { "-- NORMAL --" } else { "-- INSERT --" }, t.hl("ModeMsg")));
                content.push(Seg::new(format!("  {}", icons(app).prompt), normal));
                content.push(Seg::new(before.replace('\n', " "), normal));
                content.push(Seg::new(app.seq.pending.concat().replace("<Space>", " "), t.hl("Comment")));
                content.push(Seg::new(if under == "\n" { " ".into() } else { under }, cursor_style));
                content.push(Seg::new(rest.replace('\n', " "), normal));
                if app.open().is_empty() && app.input.is_empty() {
                    content.push(Seg::new(format!("  type what you want done; Enter starts an agent on {}", crate::engines::engine_name(app.new_agent_engine())), t.hl("Comment")));
                }
            }
            Mode::Normal => {
                if app.message.0.is_empty() {
                    content.push(Seg::new(":help for keys", t.hl("NonText")));
                } else {
                    content.push(Seg::new(crate::printable::one_row(&app.message.0), t.hl(app.message.1)));
                }
            }
        }
    }
    let showcmd = if line_normal {
        if app.mode == Mode::Insert { win.input_editor.pending_keys() } else { win.cmd_editor.pending_keys() }
    } else if app.mode == Mode::Insert {
        String::new()
    } else if let Some(m) = win.pending_mark {
        m.to_string()
    } else {
        app.seq.pending.concat()
    };
    let show_w = if showcmd.is_empty() { 0 } else { 10.max(width(&showcmd) + 1) };
    let mut row = super::text::fit_segs(content, w.saturating_sub(show_w));
    let used = super::text::segs_width(&row);
    let bg = t.hl("MsgArea");
    let bg = if bg == t.normal() { t.normal() } else { bg };
    row.push(Seg::new(" ".repeat(w.saturating_sub(used + show_w)), bg));
    if show_w > 0 {
        row.push(Seg::new(super::text::pad(&fit(&showcmd, show_w), show_w), normal));
    }
    exact(row, w, bg)
}

/// A line's cursor, in characters: the prompt's (INSERT) or the : / line's.
pub fn cursor_pos(app: &App, input: bool) -> usize {
    let (c, text) = if input { (&app.windows.input_cursor, &app.input) } else { (&app.windows.cmd_cursor, &app.cmd) };
    if c.seen == *text { c.pos } else { text.chars().count() }
}
