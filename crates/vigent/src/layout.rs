//! What the statusline and the winbar show, and in which order, like
//! lualine's sections (src/layout.ts; renderStatusline, renderPowerline,
//! renderWinbar in src/app.ts):
//!
//!   [statusline]
//!   left = ["mode", "agent", "branch"]
//!   right = ["model", "usage", "agents"]
//!
//!   [winbar]
//!   left = ["agent", "model", "status"]
//!   right = []
//!
//! With `[style] separators` and a Nerd Font the statusline gets powerline shapes.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::app::{App, Mode};
use crate::session::{Session, State};
use crate::style::nerd;
use crate::theme::Attr;
use crate::ui::text::width;

pub fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M tok", n as f64 / 1e6)
    } else if n >= 1000 {
        format!("{:.1}k tok", n as f64 / 1e3)
    } else {
        format!("{n} tok")
    }
}

/// US dollars: cents, or a tenth of a cent below one cent.
pub fn format_cost(usd: f64) -> String {
    if usd > 0.0 && usd < 0.01 { format!("${usd:.3}") } else { format!("${usd:.2}") }
}

pub fn format_usage(s: &Session) -> String {
    if s.cost > 0.0 { format!("{} · {}", format_tokens(s.tokens), format_cost(s.cost)) } else { format_tokens(s.tokens) }
}

fn mode_name(app: &App) -> (&'static str, &'static str) {
    match app.mode {
        Mode::Normal => ("NORMAL", "VigentModeNormal"),
        Mode::Insert => ("INSERT", "VigentModeInsert"),
        Mode::Command => ("COMMAND", "VigentModeCommand"),
        Mode::Search => ("SEARCH", "VigentModeCommand"),
        Mode::Visual => ("VISUAL", "VigentModeVisual"),
    }
}

fn spinner(app: &App) -> String {
    let frames = crate::style::icons(app).spinner;
    let n = (app.started.elapsed().as_millis() / 80) as usize;
    frames[n % frames.len()].to_string()
}

/// A path as the statusline shows it (relative to here when it can be).
fn short(p: &std::path::Path) -> String {
    crate::settings::short_path(p)
}

pub fn statusline_part(app: &App, p: &str) -> String {
    let s = app.focused();
    let icons = crate::style::icons(app);
    match p {
        "mode" => mode_name(app).0.into(),
        "agent" => s.map(|s| s.name.clone()).unwrap_or_default(),
        "branch" => match s.and_then(|s| s.branch.as_ref().map(|b| (s, b))) {
            Some((s, b)) => {
                let changes = if s.stat.0 > 0 || s.stat.1 > 0 { format!(" +{} {}{}", s.stat.0, icons.minus, s.stat.1) } else { String::new() };
                format!("{}{b}{changes}", icons.worktree)
            }
            None => String::new(),
        },
        "engine" => s.map(|s| crate::engines::engine_name(&s.engine)).unwrap_or_default(),
        "model" => s.and_then(|s| s.model.clone()).unwrap_or_default(),
        "effort" => s.and_then(|s| s.effort.clone()).unwrap_or_default(),
        "usage" => s.map(format_usage).unwrap_or_default(),
        "agents" => {
            let open = app.open();
            let running = open.iter().filter(|&&i| app.sessions[i].state == State::Running).count();
            let spin = if running > 0 { format!(" {}", spinner(app)) } else { String::new() };
            format!("{running}/{}{spin}", open.len())
        }
        "path" => match s {
            Some(s) if s.branch.is_some() => short(&s.path),
            Some(_) => "this checkout".into(),
            None => String::new(),
        },
        "clock" => clock(),
        _ => String::new(),
    }
}

/// HH:MM, local time.
fn clock() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let local = secs + local_offset();
    let m = local.rem_euclid(86400) / 60;
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// The local UTC offset in seconds, from `date +%z` once (std has no time zones).
fn local_offset() -> i64 {
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("date").arg("+%z").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let (sign, digits) = match out.strip_prefix('-') {
            Some(d) => (-1, d),
            None => (1, out.strip_prefix('+').unwrap_or(&out)),
        };
        if digits.len() != 4 {
            return 0;
        }
        let h: i64 = digits[..2].parse().unwrap_or(0);
        let m: i64 = digits[2..].parse().unwrap_or(0);
        sign * (h * 3600 + m * 60)
    })
}

/// The statusline: the mode and the parts you picked, left and right.
pub fn statusline(app: &App, w: usize) -> Line<'static> {
    let style = crate::style::resolve(app);
    if style.separators != "none" && app.config.ui.icons == "nerd"
        && let Some(g) = crate::style::separator_glyphs(&style.separators)
    {
        return powerline(app, w, g);
    }
    let t = &app.theme;
    let s = app.focused();
    let (mode, group) = mode_name(app);
    let mut spans: Vec<Span<'static>> = vec![];
    let mut used = 0;
    let mut first = true;
    for p in &app.config.layout.statusline.left {
        if p == "mode" {
            let badge = format!(" {mode} ");
            used += width(&badge);
            spans.push(Span::styled(badge, t.hl(group)));
            if app.cfg.demo {
                spans.push(Span::styled(" DEMO ", t.hl("VigentModeCommand")));
                used += 6;
            }
            continue;
        }
        let text = if p == "agent" && s.is_none() { "[no session]".to_string() } else { statusline_part(app, p) };
        if text.is_empty() {
            continue;
        }
        // the first part stands out, the rest are quieter; a branch keeps its space after
        let text = if p == "branch" { format!("{text} ") } else { format!(" {text} ") };
        used += width(&text);
        spans.push(Span::styled(text, t.hl(if first { "StatusLine" } else { "StatusLineNC" })));
        first = false;
    }
    let parts: Vec<String> = if s.is_some() { app.config.layout.statusline.right.iter().map(|p| if p == "mode" { format!(" {mode} ") } else { statusline_part(app, p) }).filter(|x| !x.is_empty()).collect() } else { vec![] };
    let serving = serving(app);
    let serve = if serving { crate::style::icons(app).serve } else { String::new() };
    let right = if s.is_some() {
        if parts.is_empty() && serve.is_empty() { String::new() } else { format!(" {serve}{} ", parts.join("  ")) }
    } else if serving {
        format!(" {serve}serving ")
    } else {
        String::new()
    };
    let fill = w.saturating_sub(used + width(&right));
    spans.push(Span::styled(" ".repeat(fill), t.hl(if first { "StatusLine" } else { "StatusLineNC" })));
    spans.push(Span::styled(right, t.hl("StatusLine")));
    Line::from(spans)
}

/// :serve is on (Serve area: its state says so once it's ported).
fn serving(_app: &App) -> bool {
    false
}

fn color(app: &App, c: &Option<String>) -> Option<Color> {
    app.theme.style_of(&Attr { fg: c.clone(), ..Default::default() }).fg
}

/// lualine's look: the mode in its color, a lighter section, then the bar; the right side mirrors it.
fn powerline(app: &App, w: usize, (to_right, to_left): (&'static str, &'static str)) -> Line<'static> {
    let t = &app.theme;
    let s = app.focused();
    let (mode, group) = mode_name(app);
    let m = t.attr(group);
    let fill = t.attr("StatusLine").bg.or(t.attr("Normal").bg);
    let fill_fg = t.attr("Comment").fg.or(t.attr("Normal").fg);
    let middle = t.attr("CursorLine").bg.or(t.attr("Visual").bg).or(fill.clone());
    let mid_fg = t.attr("Normal").fg;
    let icon = |p: &str| match p {
        "mode" => Some("\u{e62b}"),
        "agent" => Some(nerd::CHIP),
        "model" => Some(nerd::BOLT),
        "engine" => Some(nerd::TERMINAL),
        "effort" => Some(nerd::GEAR),
        "usage" => Some("\u{f201}"),
        "agents" => Some(nerd::LIST),
        "path" => Some("\u{f07b}"),
        "clock" => Some(nerd::CLOCK),
        _ => None,
    };
    let text = |p: &str| -> String {
        if p == "mode" {
            return format!("{} {mode}{}", icon("mode").unwrap_or(""), if app.cfg.demo { " · DEMO" } else { "" });
        }
        let t = if p == "agent" && s.is_none() {
            "no agent".to_string()
        } else if s.is_some() || p == "clock" || p == "agents" {
            statusline_part(app, p)
        } else {
            String::new()
        };
        if t.is_empty() {
            return t;
        }
        match icon(p) {
            Some(i) if p != "branch" => format!("{i} {t}"),
            _ => t,
        }
    };
    struct Seg {
        text: String,
        fg: Option<String>,
        bg: Option<String>,
        bold: bool,
    }
    let build = |parts: &[String], from_end: bool| -> Vec<Seg> {
        let texts: Vec<String> = parts.iter().map(|p| text(p)).filter(|x| !x.is_empty()).collect();
        let n = texts.len();
        texts
            .into_iter()
            .enumerate()
            .map(|(i, x)| {
                let k = if from_end { n - 1 - i } else { i };
                let (fg, bg, bold) = match k {
                    0 => (m.fg.clone(), m.bg.clone(), true),
                    1 => (mid_fg.clone(), middle.clone(), false),
                    _ => (fill_fg.clone(), fill.clone(), false),
                };
                Seg { text: format!(" {x} "), fg, bg, bold }
            })
            .collect()
    };
    let left = build(&app.config.layout.statusline.left, false);
    let right = if s.is_some() || serving(app) { build(&app.config.layout.statusline.right, true) } else { vec![] };
    let paint = |fg: &Option<String>, bg: &Option<String>, bold: bool, x: String| {
        let mut st = Style::default();
        if let Some(c) = color(app, fg) {
            st = st.fg(c);
        }
        if let Some(c) = color(app, bg) {
            st = st.bg(c);
        }
        if bold {
            st = st.add_modifier(Modifier::BOLD);
        }
        Span::styled(x, st)
    };
    let mut out = vec![];
    let mut used = 0;
    if let Some(first) = left.first() {
        out.push(paint(&first.bg, &fill, false, to_left.into()));
        used += width(to_left);
    }
    for (i, seg) in left.iter().enumerate() {
        used += width(&seg.text);
        out.push(paint(&seg.fg, &seg.bg, seg.bold, seg.text.clone()));
        let next = left.get(i + 1).map(|n| n.bg.clone()).unwrap_or(fill.clone());
        out.push(paint(&seg.bg, &next, false, to_right.into()));
        used += width(to_right);
    }
    let mut tail = vec![];
    let mut tail_w = 0;
    for (i, seg) in right.iter().enumerate() {
        let prev = if i == 0 { fill.clone() } else { right[i - 1].bg.clone() };
        tail.push(paint(&seg.bg, &prev, false, to_left.into()));
        tail.push(paint(&seg.fg, &seg.bg, seg.bold, seg.text.clone()));
        tail_w += width(to_left) + width(&seg.text);
    }
    if let Some(last) = right.last() {
        tail.push(paint(&last.bg, &fill, false, to_right.into()));
        tail_w += width(to_right);
    }
    if used + tail_w > w {
        tail.clear();
        tail_w = 0;
    }
    out.push(paint(&None, &fill, false, " ".repeat(w.saturating_sub(used + tail_w))));
    out.extend(tail);
    Line::from(out)
}

pub fn winbar_part(app: &App, p: &str) -> String {
    let s = app.focused();
    let icons = crate::style::icons(app);
    match p {
        "agent" => format!("{} {}", icons.open_agent, s.map(|s| s.name.as_str()).unwrap_or("[no agent]")),
        "model" => match s {
            Some(s) => {
                let model = s.model.clone().unwrap_or_default();
                let name = crate::engines::engine_name(&s.engine);
                let engine = if s.engine != "pi" && model != name { format!("{name} · ") } else { String::new() };
                let effort = s.effort.as_ref().map(|e| format!(" · {e}")).unwrap_or_default();
                // no model yet: the engine alone
                let text = format!("{engine}{model}{effort}");
                if model.is_empty() && effort.is_empty() { name } else { text }
            }
            None => String::new(),
        },
        "engine" => s.map(|s| crate::engines::engine_name(&s.engine)).unwrap_or_default(),
        "effort" => s.and_then(|s| s.effort.clone()).unwrap_or_default(),
        "status" => match s {
            Some(s) if s.state == State::Paused => s.hold_reason.clone().unwrap_or_else(|| "paused".into()),
            Some(s) if !s.queue.is_empty() => format!("{}{} queued", icons.queued, s.queue.len()),
            _ => String::new(),
        },
        "path" => match s {
            Some(s) if s.branch.is_some() => {
                let light = if matches!(s.made, Some(crate::worktree::Made::Riftri(_))) { format!(" {}", icons.light) } else { String::new() };
                format!("{}{light}", short(&s.path))
            }
            Some(_) => "this checkout".into(),
            None => String::new(),
        },
        "branch" => s.and_then(|s| s.branch.as_ref()).map(|b| format!("{}{b}", icons.worktree)).unwrap_or_default(),
        "usage" => s.map(format_usage).unwrap_or_default(),
        _ => String::new(),
    }
}

/// The winbar over the transcript: the parts you picked (the agent, model and status by default).
pub fn winbar(app: &App, w: usize) -> Line<'static> {
    let t = &app.theme;
    let s = app.focused();
    let bg = t.hl("WinBar").bg.or(t.hl("Normal").bg);
    let on = |g: &str| Style { bg, ..t.hl(g) };
    let part = |p: &String| {
        let text = winbar_part(app, p);
        if text.is_empty() {
            return None;
        }
        Some((text, if p == "agent" { "WinBar" } else if p == "status" { "WarningMsg" } else { "Comment" }))
    };
    let mut lefts: Vec<(String, &str)> = app.config.layout.winbar.left.iter().filter_map(part).collect();
    let rights: Vec<(String, &str)> = app.config.layout.winbar.right.iter().filter_map(part).collect();
    if s.is_none() && !lefts.iter().any(|(_, g)| *g == "WinBar") {
        lefts.insert(0, (format!("{} [no agent]", crate::style::icons(app).open_agent), "WinBar"));
    }
    let style = crate::style::resolve(app);
    let pill = if style.separators != "none" && app.config.ui.icons == "nerd" { crate::style::separator_glyphs(&style.separators) } else { None };
    let pill_bg = [t.attr("CursorLine").bg, t.attr("Visual").bg].into_iter().flatten().find(|c| color(app, &Some(c.clone())) != bg).and_then(|c| color(app, &Some(c)));
    let mut spans = vec![];
    let mut used = 0;
    for (i, (text, group)) in lefts.iter().enumerate() {
        if let (Some((to_right, to_left)), true) = (pill, *group == "WinBar") {
            let lead = if i > 0 { "  " } else { " " };
            let edge = Style { fg: pill_bg.or(bg), bg, ..Style::default() };
            spans.push(Span::styled(lead, on("Normal")));
            spans.push(Span::styled(to_left, edge));
            spans.push(Span::styled(format!(" {text} "), Style { fg: t.hl("Title").fg, bg: pill_bg.or(bg), ..Style::default() }.add_modifier(Modifier::BOLD)));
            spans.push(Span::styled(to_right, edge));
            used += width(lead) + width(to_left) + width(text) + 2 + width(to_right);
            continue;
        }
        let x = format!("{}{text}", if i > 0 { "  " } else { " " });
        used += width(&x);
        spans.push(Span::styled(x, on(group)));
    }
    let where_ = rights.iter().map(|(x, _)| x.as_str()).collect::<Vec<_>>().join("  ");
    let room = w as isize - used as isize - 3;
    let shown = if where_.is_empty() {
        String::new()
    } else if width(&where_) as isize <= room {
        where_
    } else if room > 4 {
        let chars: Vec<char> = where_.chars().collect();
        let keep = (room - 1) as usize;
        format!("…{}", chars[chars.len().saturating_sub(keep)..].iter().collect::<String>())
    } else {
        String::new()
    };
    let right = if shown.is_empty() { String::new() } else { format!("{shown} ") };
    spans.push(Span::styled(" ".repeat(w.saturating_sub(used + width(&right))), on("Normal")));
    spans.push(Span::styled(right, on("Comment")));
    Line::from(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(l: &Line) -> String {
        l.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn the_default_statusline_and_winbar() {
        let mut a = crate::app::tests::app();
        let mut s = Session::new(0, "cart total", "claude", "/tmp/wt/cart total".into());
        s.branch = Some("fix/cart-total".into());
        s.model = Some("claude-sonnet-4-5".into());
        s.effort = Some("high".into());
        a.sessions.push(s);
        a.sessions.push(Session::new(1, "other", "claude", "/tmp".into()));
        let st = text(&statusline(&a, 80));
        assert!(st.starts_with(" NORMAL  cart total ⎇ fix/cart-total "), "{st}");
        assert!(st.ends_with(" claude-sonnet-4-5  0 tok  0/2 "), "{st}");
        let wb = text(&winbar(&a, 60));
        assert!(wb.starts_with(" ▸ cart total  Claude Code · claude-sonnet-4-5 · high"), "{wb}");
        a.cfg.demo = true;
        assert!(text(&statusline(&a, 80)).starts_with(" NORMAL  DEMO "));
        a.config.layout.statusline.left = vec!["agent".into(), "engine".into(), "mode".into()];
        a.config.layout.statusline.right = vec!["effort".into(), "clock".into()];
        let st = text(&statusline(&a, 80));
        assert!(st.starts_with(" cart total  Claude Code  NORMAL "), "{st}");
        assert!(st.trim_end().ends_with(&clock()[..2]) || st.contains(':'), "{st}");
        assert_eq!(format_tokens(1500), "1.5k tok");
        assert_eq!(format_cost(0.004), "$0.004");
    }
}
