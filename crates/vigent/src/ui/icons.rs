//! The icon sets ([ui] icons: unicode, nerd, ascii) as src/app.ts ICONS has
//! them, [style.icons] / [style.nerd_icons] over them, and tool glyphs
//! (src/icons.ts, src/style.ts UNICODE_TOOL_ICONS).

use crate::app::App;

pub mod nerd {
    pub const BRANCH: &str = "\u{e725}";
    pub const CHECK: &str = "\u{f00c}";
    pub const TIMES: &str = "\u{f00d}";
    pub const WARNING: &str = "\u{f071}";
    pub const CIRCLE: &str = "\u{f111}";
    pub const CIRCLE_O: &str = "\u{f10c}";
    pub const PAUSE: &str = "\u{f04c}";
    pub const CLOCK: &str = "\u{f017}";
    pub const HOURGLASS: &str = "\u{f252}";
    pub const SEARCH: &str = "\u{f002}";
    pub const PENCIL: &str = "\u{f044}";
    pub const PLUS: &str = "\u{f067}";
    pub const PALETTE: &str = "\u{f53f}";
    pub const GEAR: &str = "\u{f013}";
    pub const CHIP: &str = "\u{f2db}";
    pub const BOLT: &str = "\u{f0e7}";
    pub const KEYBOARD: &str = "\u{f11c}";
    pub const POWER: &str = "\u{f011}";
    pub const TERMINAL: &str = "\u{f489}";
    pub const FILE_TEXT: &str = "\u{f15c}";
    pub const GLOBE: &str = "\u{f0ac}";
    pub const WRENCH: &str = "\u{f0ad}";
    pub const LIST: &str = "\u{f03a}";
    pub const CARET_RIGHT: &str = "\u{f0da}";
    pub const CARET_DOWN: &str = "\u{f0d7}";
    pub const BELL: &str = "\u{f0f3}";
}

#[derive(Clone, Debug)]
pub struct Icons {
    pub spinner: Vec<String>,
    pub waiting: String,
    pub idle: String,
    pub paused: String,
    pub error: String,
    pub tee: String,
    pub last: String,
    pub pipe: String,
    pub sep: String,
    pub worktree: String,
    pub prompt: String,
    pub folded: String,
    pub open: String,
    pub cursor: String,
    pub minus: String,
    pub bullet: String,
    pub queued: String,
    pub open_agent: String,
    pub unread: String,
    pub serve: String,
    pub light: String,
    pub ok: String,
    pub warn: String,
    pub off: String,
    pub user: Option<String>,
    pub agent: Option<String>,
}

fn set(name: &str) -> Icons {
    let s = |x: &str| x.to_string();
    let spin = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let braille = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    match name {
        "ascii" => Icons {
            spinner: spin(&["|", "/", "-", "\\"]),
            waiting: s("~"),
            idle: s("o"),
            paused: s("="),
            error: s("x"),
            tee: s("|-"),
            last: s("`-"),
            pipe: s("| "),
            sep: s("|"),
            worktree: s("wt:"),
            prompt: s("> "),
            folded: s("+"),
            open: s("-"),
            cursor: s("_"),
            minus: s("-"),
            bullet: s("-"),
            queued: s("+"),
            open_agent: s(">"),
            unread: s("!"),
            serve: s("~ "),
            light: s("*"),
            ok: s("+"),
            warn: s("~"),
            off: s("-"),
            user: None,
            agent: None,
        },
        "nerd" => Icons {
            spinner: spin(&braille),
            waiting: s(nerd::HOURGLASS),
            idle: s(nerd::CIRCLE_O),
            paused: s(nerd::PAUSE),
            error: s(nerd::TIMES),
            tee: s("├╴"),
            last: s("└╴"),
            pipe: s("│ "),
            sep: s("│"),
            worktree: format!("{} ", nerd::BRANCH),
            prompt: s("❯ "),
            folded: s(nerd::CARET_RIGHT),
            open: s(nerd::CARET_DOWN),
            cursor: s("▍"),
            minus: s("−"),
            bullet: s("•"),
            queued: s(nerd::CLOCK),
            open_agent: s("▸"),
            unread: s(nerd::BELL),
            serve: s("\u{f10b} "),
            light: s("\u{f0e7}"),
            ok: s(nerd::CHECK),
            warn: s(nerd::WARNING),
            off: s(nerd::CIRCLE_O),
            user: None,
            agent: None,
        },
        _ => Icons {
            spinner: spin(&braille),
            waiting: s("◐"),
            idle: s("○"),
            paused: s("‖"),
            error: s("✗"),
            tee: s("├╴"),
            last: s("└╴"),
            pipe: s("│ "),
            sep: s("│"),
            worktree: s("⎇ "),
            prompt: s("❯ "),
            folded: s("▸"),
            open: s("▾"),
            cursor: s("▍"),
            minus: s("−"),
            bullet: s("•"),
            queued: s("⧗"),
            open_agent: s("▸"),
            unread: s("◆"),
            serve: s("⇄ "),
            light: s("✦"),
            ok: s("●"),
            warn: s("◐"),
            off: s("○"),
            user: None,
            agent: None,
        },
    }
}

fn private_use(g: &str) -> bool {
    g.chars().any(|c| ('\u{e000}'..='\u{f8ff}').contains(&c) || c as u32 >= 0xf0000)
}

/// The icons in effect: the set [ui] icons picks, with [style.icons] (and, with a Nerd Font, [style.nerd_icons]) over it.
pub fn icons(app: &App) -> Icons {
    let set_name = app.config.ui.icons.as_str();
    let mut i = set(set_name);
    let style = &app.config.style;
    let mut over: Vec<(String, String)> = style.icons.clone();
    if set_name == "nerd" {
        over.extend(style.nerd_icons.iter().cloned());
    } else {
        over.retain(|(_, g)| !private_use(g));
    }
    for (k, v) in over {
        let slot = match k.as_str() {
            "idle" => &mut i.idle,
            "waiting" => &mut i.waiting,
            "paused" => &mut i.paused,
            "error" => &mut i.error,
            "tee" => &mut i.tee,
            "last" => &mut i.last,
            "pipe" => &mut i.pipe,
            "sep" => &mut i.sep,
            "worktree" => &mut i.worktree,
            "prompt" => &mut i.prompt,
            "folded" => &mut i.folded,
            "open" => &mut i.open,
            "cursor" => &mut i.cursor,
            "minus" => &mut i.minus,
            "bullet" => &mut i.bullet,
            "queued" => &mut i.queued,
            "open_agent" => &mut i.open_agent,
            "unread" => &mut i.unread,
            "serve" => &mut i.serve,
            "light" => &mut i.light,
            "ok" => &mut i.ok,
            "warn" => &mut i.warn,
            "off" => &mut i.off,
            "user" => {
                i.user = Some(v);
                continue;
            }
            "agent" => {
                i.agent = Some(v);
                continue;
            }
            _ => continue,
        };
        *slot = v;
    }
    i
}

/// A tool call's kind (src/icons.ts toolKind).
pub fn tool_kind(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["bash", "shell", "exec", "command", "run", "terminal"]) {
        "terminal"
    } else if has(&["edit", "write", "patch", "apply", "replace"]) {
        "pencil"
    } else if has(&["read", "view", "cat", "open"]) {
        "fileText"
    } else if has(&["grep", "glob", "search", "find", "list"]) || n == "ls" {
        "search"
    } else if has(&["web", "fetch", "http", "url"]) {
        "globe"
    } else if has(&["todo", "plan", "task"]) {
        "list"
    } else {
        "wrench"
    }
}

/// A tool call's glyph and a space, or nothing (as [style] tool_icons and the icon set say).
pub fn tool_glyph(app: &App, name: &str) -> String {
    let set = app.config.ui.icons.as_str();
    let mode = app.config.style.tool_icons.clone().unwrap_or_else(|| if set == "nerd" { "nerd".into() } else { "none".into() });
    let kind = tool_kind(name);
    let unicode = match kind {
        "terminal" => "▶",
        "pencil" => "✎",
        "fileText" => "≡",
        "search" => "⌕",
        "globe" => "◍",
        "list" => "✓",
        _ => "✱",
    };
    let nerd = match kind {
        "terminal" => nerd::TERMINAL,
        "pencil" => nerd::PENCIL,
        "fileText" => nerd::FILE_TEXT,
        "search" => nerd::SEARCH,
        "globe" => nerd::GLOBE,
        "list" => nerd::LIST,
        _ => nerd::WRENCH,
    };
    match mode.as_str() {
        "nerd" => format!("{} ", if set == "nerd" || app.config.style.tool_icons.as_deref() == Some("nerd") { nerd } else { unicode }),
        "unicode" => format!("{unicode} "),
        _ => String::new(),
    }
}
