//! The start screen, while no agent is open (src/app.ts introLines, like
//! LazyVim's dashboard): the logo, one key per action, the engines.

use super::icons::{icons, nerd};
use super::pane::PaneLine;
use super::text::{Seg, segs_plain, width};
use crate::app::App;

const LOGO: [&str; 6] = [
    "██╗   ██╗██╗ ██████╗ ███████╗███╗   ██╗████████╗",
    "██║   ██║██║██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
    "██║   ██║██║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
    "╚██╗ ██╔╝██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
    " ╚████╔╝ ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
    "  ╚═══╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

/// key, unicode icon, label, Nerd Font icon
pub const DASHBOARD: [(&str, &str, &str, &str); 11] = [
    ("i", "✎", "New agent: type a task, Enter", nerd::PENCIL),
    ("n", "+", "New agent by name", nerd::PLUS),
    ("T", "▤", "New agent from a template", nerd::FILE_TEXT),
    ("t", "◐", "Theme", nerd::PALETTE),
    ("s", "⚙", "Settings", nerd::GEAR),
    ("m", "◆", "Model", nerd::CHIP),
    ("e", "↯", "Effort", nerd::BOLT),
    ("E", "⚑", "Engine: pi, Claude Code, Codex, OpenCode", nerd::WRENCH),
    ("c", "✓", "Check engines", nerd::CHECK),
    ("?", "⌘", "Keys", nerd::KEYBOARD),
    ("q", "×", "Quit", nerd::POWER),
];

pub fn lines(app: &App, pane_w: usize, pane_h: usize) -> Vec<PaneLine> {
    let t = &app.theme;
    let ic = icons(app);
    let set = app.config.ui.icons.as_str();
    let center = |plain: &str| " ".repeat(pane_w.saturating_sub(width(plain)) / 2);
    let mut rows: Vec<Vec<Seg>> = vec![];
    let add = |rows: &mut Vec<Vec<Seg>>, mut segs: Vec<Seg>, indent: String| {
        segs.insert(0, Seg::new(indent, t.fg("Normal")));
        rows.push(segs);
    };
    let logo = set != "ascii" && pane_w >= width(LOGO[0]) + 2 && pane_h >= 22;
    if logo {
        let groups = ["Function", "Function", "Special", "Special", "Keyword", "Keyword"];
        for (i, l) in LOGO.iter().enumerate() {
            add(&mut rows, vec![Seg::new(*l, t.hl(groups[i]))], center(l));
        }
    } else {
        add(&mut rows, vec![Seg::new("VIGENT", t.hl("Title"))], center("VIGENT"));
    }
    let tagline = "coding agents, the vim way · each one in its own git worktree";
    add(&mut rows, vec![Seg::new(tagline, t.hl("Comment"))], center(tagline));
    add(&mut rows, vec![], String::new());
    let label_w = DASHBOARD.iter().map(|d| d.2.chars().count()).max().unwrap_or(0);
    let block_w = 2 + label_w + 6;
    let indent = center(&"x".repeat(block_w));
    for (key, icon, label, nerd_icon) in DASHBOARD {
        let icon = match set {
            "nerd" => nerd_icon,
            "unicode" => icon,
            _ => "",
        };
        let lead = if icon.is_empty() { "  ".to_string() } else { format!("{icon} ") };
        let padded = format!("{label:<label_w$}");
        add(&mut rows, vec![Seg::new(lead, t.hl("Special")), Seg::new(padded, t.hl("Normal")), Seg::new("    ", t.fg("Normal")), Seg::new(key, t.hl("Title"))], indent.clone());
    }
    let infos = &app.engines.infos;
    if !infos.is_empty() {
        add(&mut rows, vec![], String::new());
        let def = app.new_agent_engine();
        let parts: Vec<(String, String)> = infos.iter().map(|e| ((if e.connected { &ic.ok } else if e.installed { &ic.warn } else { &ic.off }).clone(), e.name.clone())).collect();
        let plain = parts.iter().map(|(g, n)| format!("{g} {n}")).collect::<Vec<_>>().join("   ");
        let mut segs = vec![];
        for (i, e) in infos.iter().enumerate() {
            let group = if e.connected { "String" } else if e.installed { "WarningMsg" } else { "Comment" };
            if i > 0 {
                segs.push(Seg::new("   ", t.fg("Normal")));
            }
            segs.push(Seg::new(format!("{} ", parts[i].0), t.hl(group)));
            segs.push(Seg::new(e.name.clone(), t.hl(if e.id == def { "Title" } else { "Comment" })));
        }
        add(&mut rows, segs, center(&plain));
        let ready = infos.iter().filter(|e| e.connected).count();
        let bolt = match set {
            "nerd" => format!("{} ", nerd::BOLT),
            "unicode" => "⚡ ".into(),
            _ => String::new(),
        };
        let foot = format!("{bolt}vigent {} · {} themes · {ready} of {} engines ready", app.version, crate::theme::names().len(), infos.len());
        add(&mut rows, vec![Seg::new(foot.clone(), t.hl("Comment"))], center(&foot));
    }
    if app.root.is_none() {
        add(&mut rows, vec![], String::new());
        let note = "(not a git repository: agents will share this folder)";
        add(&mut rows, vec![Seg::new(note, t.hl("WarningMsg"))], center(note));
    }
    let top = pane_h.saturating_sub(rows.len()) / 2;
    let mut out: Vec<PaneLine> = vec![];
    for r in rows {
        out.push(PaneLine { plain: segs_plain(&r), segs: r, ..Default::default() });
    }
    let bottom = pane_h.saturating_sub(top + out.len());
    out.extend((0..bottom).map(|_| PaneLine::default()));
    // the view is the last pane_h lines, so the space above comes from cutting at the bottom
    let _ = top;
    out
}
