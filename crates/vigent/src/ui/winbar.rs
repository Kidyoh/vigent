//! Neovim-style 'winbar' over each window (src/app.ts renderWinbar): which
//! agent, its model, its status ([winbar] left / right pick the parts). With
//! several windows each bar is a strip of its own, so a split shows where one
//! window ends.

use ratatui::style::Style;

use super::icons::icons;
use super::text::{Seg, width};
use crate::app::App;
use crate::session::{Session, State};

/// The text of one [winbar] part, for an agent (or none).
pub fn part(app: &App, s: Option<&Session>, p: &str) -> String {
    let ic = icons(app);
    match p {
        "agent" => format!("{} {}", ic.open_agent, s.map(|s| s.name.as_str()).unwrap_or("[no agent]")),
        "model" => match s {
            Some(s) => {
                let engine = crate::engines::engine_name(&s.engine);
                let model = s.model.clone().or_else(|| s.requested_model.clone()).unwrap_or_else(|| engine.to_string());
                let prefix = if s.engine != "pi" && model != engine { format!("{engine} · ") } else { String::new() };
                let effort = s.effort.as_ref().map(|e| format!(" · {e}")).unwrap_or_default();
                format!("{prefix}{model}{effort}")
            }
            None => String::new(),
        },
        "engine" => s.map(|s| crate::engines::engine_name(&s.engine).to_string()).unwrap_or_default(),
        "effort" => s.and_then(|s| s.effort.clone()).unwrap_or_default(),
        "status" => match s {
            Some(s) if s.state == State::Paused || s.hold_reason.is_some() => s.hold_reason.clone().unwrap_or_else(|| "paused".into()),
            Some(s) if !s.queue.is_empty() => format!("{}{} queued", ic.queued, s.queue.len()),
            _ => String::new(),
        },
        "path" => match s {
            Some(s) if s.branch.is_some() => {
                let light = matches!(s.made, Some(crate::worktree::Made::Riftri(_)));
                format!("{}{}", short_path(&s.path), if light { format!(" {}", ic.light) } else { String::new() })
            }
            Some(_) => "this checkout".into(),
            None => String::new(),
        },
        "branch" => s.and_then(|s| s.branch.as_ref()).map(|b| format!("{}{b}", ic.worktree)).unwrap_or_default(),
        "usage" => s.map(|s| s.usage()).unwrap_or_default(),
        _ => String::new(),
    }
}

/// A path as the TypeScript shows it: relative to where vigent runs, unless that climbs too far.
pub fn short_path(p: &std::path::Path) -> String {
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Ok(rel) = p.strip_prefix(&cwd) {
        let r = rel.display().to_string();
        if !r.is_empty() {
            return r;
        }
    }
    // relative with ..: only one level up
    if let Some(parent) = cwd.parent()
        && let Ok(rel) = p.strip_prefix(parent)
        && !rel.as_os_str().is_empty()
    {
        return format!("../{}", rel.display());
    }
    p.display().to_string()
}

/// The winbar of a window showing `slot`, `w` columns wide.
pub fn segs(app: &App, slot: Option<usize>, w: usize, active: bool) -> Vec<Seg> {
    let t = &app.theme;
    let s = slot.and_then(|i| app.sessions.get(i)).filter(|s| !s.closed);
    let name = if active { "WinBar" } else { "WinBarNC" };
    let normal_bg = t.normal().bg;
    let own = t.hl(name).bg;
    let bg = if app.windows.layout.count() > 1 && (own.is_none() || own == normal_bg) {
        t.hl("CursorLine").bg.or(t.hl("StatusLineNC").bg).or(own).or(normal_bg)
    } else {
        own.or(normal_bg)
    };
    let on = |g: &str| {
        let st = t.fg(g);
        match bg {
            Some(b) => st.bg(b),
            None => st,
        }
    };
    let group = |p: &str| match p {
        "agent" => "WinBar",
        "status" => "WarningMsg",
        _ => "Comment",
    };
    let layout = &app.config.layout.winbar;
    let mut lefts: Vec<(String, &str)> = layout.left.iter().map(|p| (part(app, s, p), group(p))).filter(|(x, _)| !x.is_empty()).collect();
    let rights: Vec<String> = layout.right.iter().map(|p| part(app, s, p)).filter(|x| !x.is_empty()).collect();
    if s.is_none() && !lefts.iter().any(|(_, g)| *g == "WinBar") {
        lefts.insert(0, (format!("{} [no agent]", icons(app).open_agent), "WinBar"));
    }
    let mut out = vec![];
    let mut left_w = 0;
    for (i, (text, g)) in lefts.iter().enumerate() {
        let txt = format!("{}{text}", if i > 0 { "  " } else { " " });
        left_w += width(&txt);
        let style = if *g == "WinBar" { on(name).patch(Style::default().add_modifier(t.hl(name).add_modifier)) } else { on(g) };
        out.push(Seg::new(txt, style));
    }
    let where_ = rights.join("  ");
    let room = w as isize - left_w as isize - 3;
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
    let fill = w.saturating_sub(left_w + width(&right));
    out.push(Seg::new(" ".repeat(fill), on("Normal")));
    if !right.is_empty() {
        out.push(Seg::new(right, on("Comment")));
    }
    out
}
