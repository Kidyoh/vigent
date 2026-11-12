//! Drawing: the sidebar, the agent's transcript (or the start screen), the
//! statusline and the message line, like the TypeScript vigent's layout.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, ENGINES, Item, Mode, State};
use crate::theme::Theme;

const SIDEBAR: u16 = 30;
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOGO: [&str; 6] = [
    "██╗   ██╗██╗ ██████╗ ███████╗███╗   ██╗████████╗",
    "██║   ██║██║██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
    "██║   ██║██║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
    "╚██╗ ██╔╝██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
    " ╚████╔╝ ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
    "  ╚═══╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// `s` cut to `max` columns, with … when it was longer.
fn fit(s: &str, max: usize) -> String {
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

fn pad(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(width(s))))
}

/// Styled pieces of one logical line, wrapped to `w` columns (at spaces when it can).
fn wrap(parts: Vec<(String, Style)>, w: usize, indent: usize) -> Vec<Line<'static>> {
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
fn reply(text: &str, w: usize, t: &Theme) -> Vec<Line<'static>> {
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

fn transcript(app: &App, w: usize) -> Vec<Line<'static>> {
    let t = &app.theme;
    let Some(a) = app.focused() else { return vec![] };
    let mut out: Vec<Line<'static>> = vec![];
    let mut prev: Option<&Item> = None;
    for item in &a.items {
        let gap = match (prev, item) {
            (None, _) => false,
            (_, Item::User(_)) | (_, Item::Text(_)) => true,
            (Some(Item::Text(_)), Item::Tool { .. }) => true,
            _ => false,
        };
        if gap {
            out.push(Line::default());
        }
        match item {
            Item::User(text) => {
                let s = t.fg("VigentUser").add_modifier(Modifier::BOLD);
                for (n, l) in text.lines().enumerate() {
                    out.extend(wrap(vec![(if n == 0 { "❯ " } else { "  " }.into(), t.fg("Identifier")), (l.to_string(), s)], w, 2));
                }
            }
            Item::Text(text) => out.extend(reply(text, w, t)),
            Item::Tool { name, summary, .. } => out.extend(wrap(
                vec![(" ▸ ".into(), t.fg("NonText")), (name.clone(), t.fg("VigentTool")), (format!(" {summary}"), t.fg("Comment"))],
                w,
                3,
            )),
            Item::Info(s) => out.extend(wrap(vec![(s.clone(), t.fg("Comment"))], w, 0)),
            Item::Error(s) => out.extend(wrap(vec![(s.clone(), t.fg("ErrorMsg"))], w, 0)),
        }
        prev = Some(item);
    }
    let spin = SPINNER[(app.started.elapsed().as_millis() / 80) as usize % SPINNER.len()];
    match a.state {
        State::Making => out.push(Line::from(Span::styled(format!("{spin} making its worktree…"), t.fg("Comment")))),
        State::Running => {
            out.push(Line::default());
            out.push(Line::from(Span::styled(format!("{spin} working…"), t.fg("VigentSpinner"))));
        }
        _ => {}
    }
    out
}

fn dashboard(app: &App, area: Rect) -> Vec<Line<'static>> {
    let t = &app.theme;
    let w = area.width as usize;
    let center = |s: &str| " ".repeat(w.saturating_sub(width(s)) / 2);
    let mut lines: Vec<Line<'static>> = vec![];
    for l in LOGO {
        lines.push(Line::from(vec![Span::raw(center(l)), Span::styled(l, t.fg("Function"))]));
    }
    let tag = "coding agents, the vim way · each one in its own git worktree";
    lines.push(Line::from(vec![Span::raw(center(tag)), Span::styled(tag, t.fg("Comment"))]));
    lines.push(Line::default());
    let keys = [("✎", "New agent: type a task, Enter", "i"), ("✓", "Check engines", "c"), ("⌘", "Keys", "?"), ("×", "Quit", "q")];
    let row_w = 46;
    for (icon, label, key) in keys {
        let row = format!("{icon} {}{key}", pad(label, row_w - 3));
        lines.push(Line::from(vec![
            Span::raw(center(&row)),
            Span::styled(format!("{icon} "), t.fg("Special")),
            Span::styled(pad(label, row_w - 3), t.fg("Normal")),
            Span::styled(key, t.fg("Keyword")),
        ]));
    }
    lines.push(Line::default());
    let mut engines: Vec<Span<'static>> = vec![];
    let mut plain = String::new();
    for (n, (name, _, _)) in ENGINES.iter().enumerate() {
        let ready = n == 1 && app.claude_ready();
        let piece = format!("{} {name}   ", if ready { "●" } else { "○" });
        plain += &piece;
        engines.push(Span::styled(piece, if ready { t.fg("String") } else { t.fg("Comment") }));
    }
    engines.insert(0, Span::raw(center(plain.trim_end())));
    lines.push(Line::from(engines));
    let footer = format!(
        "⚡ vigent {} · {} themes · {} of {} engines ready",
        app.version,
        crate::theme::names().len(),
        app.engines_ready(),
        ENGINES.len()
    );
    lines.push(Line::from(vec![Span::raw(center(&footer)), Span::styled(footer, t.fg("Comment"))]));
    let top = (area.height as usize).saturating_sub(lines.len()) / 2;
    let mut out = vec![Line::default(); top];
    out.extend(lines);
    out
}

fn sidebar(app: &App, area: Rect) -> Vec<Line<'static>> {
    let t = &app.theme;
    let w = area.width as usize;
    let header = |name: &str, right: String| {
        Line::from(vec![
            Span::styled(format!(" {}", pad(name, w.saturating_sub(width(&right) + 2))), t.fg("Title").add_modifier(Modifier::BOLD)),
            Span::styled(format!("{right} "), t.fg("Comment")),
        ])
    };
    let open = app.open();
    let mut top = vec![header("SESSIONS", open.len().to_string())];
    let spin = SPINNER[(app.started.elapsed().as_millis() / 80) as usize % SPINNER.len()];
    for (n, &i) in open.iter().enumerate() {
        let a = &app.agents[i];
        let last = n + 1 == open.len();
        let (icon, group) = match a.state {
            State::Running | State::Making => (spin, "VigentSpinner"),
            State::Waiting => ("◐", "WarningMsg"),
            State::Failed => ("✗", "ErrorMsg"),
            State::Idle => ("○", "Comment"),
        };
        let mark = if a.state == State::Waiting { " ◆" } else { "" };
        let queued = if a.queue.is_empty() { String::new() } else { format!(" ⧗{}", a.queue.len()) };
        let focused = i == app.focus;
        let name_style = if focused { t.fg("Normal").add_modifier(Modifier::BOLD) } else { t.fg("Normal") };
        let num_style = if focused { t.fg("CursorLineNr") } else { t.fg("LineNr") };
        let name = fit(&format!("{}{mark}{queued}", a.name), w.saturating_sub(8));
        let mut row = Line::from(vec![
            Span::styled(format!("{:>3} ", n + 1), num_style),
            Span::styled(if last { "└╴" } else { "├╴" }, t.fg("NonText")),
            Span::styled(format!("{icon} "), t.fg(group)),
            Span::styled(name, name_style),
        ]);
        if focused {
            row = row.style(t.hl("CursorLine"));
        }
        top.push(row);
        if let Some(branch) = &a.branch {
            // "     │   ⎇ " is 11 columns, then the branch, then " +a −r"
            let stat = format!(" +{} −{}", a.stat.0, a.stat.1);
            let b = fit(branch, w.saturating_sub(11 + width(&stat)));
            top.push(Line::from(vec![
                Span::styled(format!("     {}   ", if last { " " } else { "│" }), t.fg("NonText")),
                Span::styled(format!("⎇ {b}"), t.fg("Comment")),
                Span::styled(format!(" +{}", a.stat.0), t.fg("Added")),
                Span::styled(format!(" −{}", a.stat.1), t.fg("Removed")),
            ]));
        }
    }
    let mut bottom = vec![header("ENGINES", format!("{}/{}", app.engines_ready(), ENGINES.len()))];
    for (n, (name, _, _)) in ENGINES.iter().enumerate() {
        let (icon, status, group) = if n == 1 {
            match &app.claude {
                None => ("…", "checking", "Comment"),
                Some(c) if c.version.is_none() => ("○", "not installed", "Comment"),
                Some(c) if !c.signed_in => ("◐", "sign in", "WarningMsg"),
                Some(_) => ("●", "default", "String"),
            }
        } else if app.installed[n] {
            ("○", "next milestone", "Comment")
        } else {
            ("○", "not installed", "Comment")
        };
        let left = format!("  {icon} {name}");
        bottom.push(Line::from(vec![
            Span::styled(format!("  {icon} "), t.fg(group)),
            Span::styled(pad(name, w.saturating_sub(width(&left) - width(name) + width(status) + 1)), t.fg("Normal")),
            Span::styled(status.to_string(), t.fg("Comment").add_modifier(Modifier::ITALIC)),
        ]));
    }
    let h = area.height as usize;
    let mut lines = top;
    lines.truncate(h.saturating_sub(bottom.len()));
    while lines.len() + bottom.len() < h {
        lines.push(Line::from(Span::styled("~", t.fg("NonText"))));
    }
    lines.extend(bottom);
    lines
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let t = &app.theme;
    let area = f.area();
    f.render_widget(Block::default().style(t.normal()), area);
    if area.height < 4 || area.width < 20 {
        return;
    }
    let body_h = area.height - 2;
    let side = if area.width >= 70 { SIDEBAR } else { 0 };
    if side > 0 {
        let r = Rect::new(0, 0, side - 1, body_h);
        let sb = t.hl("VigentSidebar");
        f.render_widget(Paragraph::new(sidebar(app, r)).style(sb), r);
        let sep: Vec<Line> = (0..body_h).map(|_| Line::from("│")).collect();
        f.render_widget(Paragraph::new(sep).style(t.hl("WinSeparator")), Rect::new(side - 1, 0, 1, body_h));
    }
    let main = Rect::new(side + 1, 0, area.width - side - 1, body_h);
    // winbar
    let winbar = match app.focused() {
        Some(a) => {
            let model = a.model.as_deref().map(|m| format!(" · {m}")).unwrap_or_default();
            Line::from(vec![
                Span::styled("▸ ", t.fg("NonText")),
                Span::styled(a.name.clone(), t.fg("WinBar").add_modifier(Modifier::BOLD)),
                Span::styled(format!("  Claude Code{model}"), t.fg("Comment").add_modifier(Modifier::ITALIC)),
            ])
        }
        None => Line::from(vec![Span::styled("▸ ", t.fg("NonText")), Span::styled("[no agent]", t.fg("Comment"))]),
    };
    f.render_widget(Paragraph::new(winbar), Rect::new(main.x, 0, main.width, 1));
    let pane = Rect::new(main.x, 1, main.width.saturating_sub(1), body_h - 1);
    app.page = pane.height as usize;
    let lines = if app.focused().is_some() { transcript(app, pane.width as usize) } else { dashboard(app, pane) };
    let h = pane.height as usize;
    let shown: Vec<Line> = if app.focused().is_none() {
        lines.into_iter().take(h).collect()
    } else if lines.len() <= h {
        app.scroll = 0;
        let mut v = vec![Line::default(); h - lines.len()];
        v.extend(lines);
        v
    } else {
        app.scroll = app.scroll.min(lines.len() - h);
        let start = lines.len() - h - app.scroll;
        lines.into_iter().skip(start).take(h).collect()
    };
    f.render_widget(Paragraph::new(shown), pane);

    // statusline
    let t = &app.theme;
    let (mode, mode_group) = match app.mode {
        Mode::Normal => ("NORMAL", "VigentModeNormal"),
        Mode::Insert => ("INSERT", "VigentModeInsert"),
        Mode::Command => ("COMMAND", "VigentModeCommand"),
    };
    let sl = t.hl("StatusLine");
    let mut left = vec![Span::styled(format!(" {mode} "), t.hl(mode_group).add_modifier(Modifier::BOLD))];
    let mut right = String::new();
    match app.focused() {
        Some(a) => {
            left.push(Span::styled(format!(" {}", a.name), sl.add_modifier(Modifier::BOLD)));
            if let Some(b) = &a.branch {
                left.push(Span::styled(format!(" ⎇ {b} +{} −{}", a.stat.0, a.stat.1), sl));
            }
            let open = app.open();
            let n = open.iter().position(|&i| i == app.focus).map(|p| p + 1).unwrap_or(0);
            let waiting = open.iter().filter(|&&i| app.agents[i].busy()).count();
            right = format!("{}  {}  {waiting}/{} ", a.model.as_deref().unwrap_or(""), a.usage(), open.len());
            let _ = n;
        }
        None => left.push(Span::styled(" [no session]", sl)),
    }
    let used: usize = left.iter().map(|s| width(&s.content)).sum();
    let gap = (area.width as usize).saturating_sub(used + width(&right));
    left.push(Span::styled(" ".repeat(gap), sl));
    left.push(Span::styled(right, sl));
    f.render_widget(Paragraph::new(Line::from(left)).style(sl), Rect::new(0, body_h, area.width, 1));

    // message line (and the cursor while typing)
    let y = body_h + 1;
    let msg = match app.mode {
        Mode::Insert => {
            let mut spans = vec![Span::styled("-- INSERT --  ", t.fg("ModeMsg").add_modifier(Modifier::BOLD)), Span::styled("❯ ", t.fg("Identifier"))];
            let shown = app.input.replace('\n', " ⏎ ");
            let room = (area.width as usize).saturating_sub(16);
            let tail: String = {
                let w = width(&shown);
                if w <= room { shown.clone() } else { shown.chars().rev().scan(0, |acc, c| { *acc += c.width().unwrap_or(0); (*acc <= room).then_some(c) }).collect::<Vec<_>>().into_iter().rev().collect() }
            };
            if app.input.is_empty() {
                let what = if app.focused().is_some() { "a follow-up; Enter sends it" } else { "what you want done; Enter starts an agent on Claude Code" };
                spans.push(Span::styled(format!("  type {what}"), t.fg("Comment")));
            } else {
                spans.push(Span::styled(tail.clone(), t.fg("Normal")));
            }
            f.set_cursor_position((16 + width(&tail) as u16, y));
            Line::from(spans)
        }
        Mode::Command => {
            f.set_cursor_position((1 + width(&app.cmd) as u16, y));
            Line::from(vec![Span::styled(format!(":{}", app.cmd), t.fg("Normal"))])
        }
        Mode::Normal => Line::from(Span::styled(fit(&app.message.0, area.width as usize), t.fg(app.message.1))),
    };
    f.render_widget(Paragraph::new(msg), Rect::new(0, y, area.width, 1));

    if let Some(fl) = &app.float {
        let w = (area.width.saturating_sub(6)).min(86);
        let h = (body_h.saturating_sub(2)).min(fl.lines.len() as u16 + 2);
        let r = Rect::new((area.width - w) / 2, 2.min(body_h - h), w, h);
        let inner_h = h.saturating_sub(2) as usize;
        let top = fl.top.min(fl.lines.len().saturating_sub(inner_h));
        let end = (top + inner_h).min(fl.lines.len());
        let body: Vec<Line> = fl.lines[top..end].iter().map(|(s, g)| Line::from(Span::styled(fit(s, w as usize - 4), t.fg(g)))).collect();
        let float = t.hl("NormalFloat");
        let block = Block::default()
            .borders(Borders::ALL)
            .padding(ratatui::widgets::Padding::horizontal(1))
            .border_type(ratatui::widgets::BorderType::Rounded)
            .border_style(float)
            .style(float)
            .title_top(format!(" {} ", fl.title))
            .title_bottom(Line::from(" q close "))
            .title_bottom(Line::from(format!(" {}-{}/{} ", top + 1, end, fl.lines.len())).right_aligned());
        f.render_widget(Clear, r);
        f.render_widget(Paragraph::new(body).block(block), r);
    }
}
