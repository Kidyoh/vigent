//! A style: how vigent lays things out, apart from its colors (src/style.ts,
//! src/icons.ts, the ICONS table in src/app.ts). A theme can carry one (a
//! `[style]` table in its file; the built-in nebula, neon and zen do), and
//! `[style]` in config.toml overrides it field by field:
//!
//!   [style]
//!   sidebar = "cards"         # tree (default), cards, compact
//!   messages = "bubbles"      # plain (default), labeled, bubbles
//!   tool_icons = "unicode"    # none, unicode, nerd (default: nerd with icons = "nerd", else none)
//!   user_label = "you"        # what labeled and bubble messages call you
//!   separators = "round"      # none (default), round, arrow, slant (needs icons = "nerd")
//!   [style.icons]             # any glyph by name, over the icon set
//!   [style.nerd_icons]        # the same, used only with icons = "nerd"
//!
//! Drawing reads [`resolve`] (the style in effect) and [`icons`] (the glyphs).

use crate::app::App;
use crate::config::StyleSpec;

/// The style in effect.
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    pub sidebar: String,
    pub messages: String,
    /// None: follow the icon set
    pub tool_icons: Option<String>,
    pub user_label: String,
    pub separators: String,
    pub icons: Vec<(String, String)>,
    pub nerd_icons: Vec<(String, String)>,
}

impl Default for Style {
    fn default() -> Self {
        Style { sidebar: "tree".into(), messages: "plain".into(), tool_icons: None, user_label: "You".into(), separators: "none".into(), icons: vec![], nerd_icons: vec![] }
    }
}

fn put(list: &mut Vec<(String, String)>, k: &str, v: &str) {
    match list.iter_mut().find(|(n, _)| n == k) {
        Some(slot) => slot.1 = v.to_string(),
        None => list.push((k.to_string(), v.to_string())),
    }
}

/// Layer one style spec over another, field by field (icons merged by name).
pub fn layer(into: &mut StyleSpec, own: &StyleSpec) {
    for (a, b) in [(&mut into.sidebar, &own.sidebar), (&mut into.messages, &own.messages), (&mut into.tool_icons, &own.tool_icons), (&mut into.separators, &own.separators), (&mut into.user_label, &own.user_label)] {
        if b.is_some() {
            *a = b.clone();
        }
    }
    for (k, v) in &own.icons {
        put(&mut into.icons, k, v);
    }
    for (k, v) in &own.nerd_icons {
        put(&mut into.nerd_icons, k, v);
    }
}

/// Layer styles, lowest first: the default, the theme's, yours.
pub fn resolve_layers(layers: &[Option<&StyleSpec>]) -> Style {
    let mut s = Style::default();
    for l in layers.iter().flatten() {
        if let Some(v) = &l.sidebar {
            s.sidebar = v.clone();
        }
        if let Some(v) = &l.messages {
            s.messages = v.clone();
        }
        if l.tool_icons.is_some() {
            s.tool_icons = l.tool_icons.clone();
        }
        if let Some(v) = &l.user_label {
            s.user_label = v.clone();
        }
        if let Some(v) = &l.separators {
            s.separators = v.clone();
        }
        for (k, v) in &l.icons {
            put(&mut s.icons, k, v);
        }
        for (k, v) in &l.nerd_icons {
            put(&mut s.nerd_icons, k, v);
        }
    }
    s
}

/// The style in effect: the theme's, then yours.
pub fn resolve(app: &App) -> Style {
    resolve_layers(&[app.theme.def.style.as_ref(), Some(&app.config.style)])
}

/// Powerline shapes (Nerd Fonts): the end of a segment pointing right, and one pointing left.
pub fn separator_glyphs(style: &str) -> Option<(&'static str, &'static str)> {
    match style {
        "round" => Some(("\u{e0b4}", "\u{e0b6}")),
        "arrow" => Some(("\u{e0b0}", "\u{e0b2}")),
        "slant" => Some(("\u{e0bc}", "\u{e0ba}")),
        _ => None,
    }
}

/// Nerd Font icons (`icons = "nerd"`), Nerd Fonts v3 codepoints.
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
    pub const FILE: &str = "\u{f15b}";
    pub const FILE_TEXT: &str = "\u{f15c}";
    pub const GLOBE: &str = "\u{f0ac}";
    pub const WRENCH: &str = "\u{f0ad}";
    pub const LIST: &str = "\u{f03a}";
    pub const CARET_RIGHT: &str = "\u{f0da}";
    pub const CARET_DOWN: &str = "\u{f0d7}";
    pub const BELL: &str = "\u{f0f3}";
}

/// What kind of tool a call is, by its name (every engine's names).
pub fn tool_kind(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let any = |ws: &[&str]| ws.iter().any(|w| n.contains(w));
    if any(&["bash", "shell", "exec", "command", "run", "terminal"]) {
        "terminal"
    } else if any(&["edit", "write", "patch", "apply", "replace"]) {
        "pencil"
    } else if any(&["read", "view", "cat", "open"]) {
        "fileText"
    } else if any(&["grep", "glob", "search", "find", "list"]) || n == "ls" {
        "search"
    } else if any(&["web", "fetch", "http", "url"]) {
        "globe"
    } else if any(&["todo", "plan", "task"]) {
        "list"
    } else {
        "wrench"
    }
}

/// A tool call's icon by the tool's name: Nerd Font or one-column unicode.
pub fn tool_icon(name: &str, nerd_font: bool) -> &'static str {
    let k = tool_kind(name);
    if nerd_font {
        match k {
            "terminal" => nerd::TERMINAL,
            "pencil" => nerd::PENCIL,
            "fileText" => nerd::FILE_TEXT,
            "search" => nerd::SEARCH,
            "globe" => nerd::GLOBE,
            "list" => nerd::LIST,
            _ => nerd::WRENCH,
        }
    } else {
        match k {
            "terminal" => "▶",
            "pencil" => "✎",
            "fileText" => "≡",
            "search" => "⌕",
            "globe" => "◍",
            "list" => "✓",
            _ => "✱",
        }
    }
}

/// The glyphs vigent draws with (the icon set, with the style's over it).
#[derive(Clone, Debug, PartialEq)]
pub struct Icons {
    pub spinner: Vec<&'static str>,
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
    pub here: String,
    pub unread: String,
    pub serve: String,
    pub light: String,
    pub ok: String,
    pub warn: String,
    pub off: String,
    pub user: Option<String>,
    pub agent: Option<String>,
}

/// One icon set as it comes (src/app.ts ICONS).
pub fn icon_set(set: &str) -> Icons {
    let braille = vec!["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let s = |v: &str| v.to_string();
    match set {
        "nerd" => Icons {
            spinner: braille,
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
            here: s(nerd::CIRCLE),
            unread: s(nerd::BELL),
            serve: s("\u{f10b} "),
            light: s("\u{f0e7}"),
            ok: s(nerd::CHECK),
            warn: s(nerd::WARNING),
            off: s(nerd::CIRCLE_O),
            user: None,
            agent: None,
        },
        "ascii" => Icons {
            spinner: vec!["|", "/", "-", "\\"],
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
            here: s("*"),
            unread: s("!"),
            serve: s("~ "),
            light: s("*"),
            ok: s("+"),
            warn: s("~"),
            off: s("-"),
            user: None,
            agent: None,
        },
        _ => Icons {
            spinner: braille,
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
            here: s("●"),
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

/// A Nerd Font glyph (the private use areas) only shows with one.
fn private_use(g: &str) -> bool {
    g.chars().any(|c| ('\u{e000}'..='\u{f8ff}').contains(&c) || c >= '\u{f0000}')
}

/// The icons in effect: the icon set, the style's [style.icons] over it, and
/// with a Nerd Font its [style.nerd_icons] too.
pub fn icons_for(set: &str, style: &Style) -> Icons {
    let mut base = icon_set(set);
    let mut o = style.icons.clone();
    if set == "nerd" {
        for (k, v) in &style.nerd_icons {
            put(&mut o, k, v);
        }
    } else {
        o.retain(|(_, g)| !private_use(g));
    }
    for (k, v) in o {
        let v = v.clone();
        match k.as_str() {
            "prompt" => base.prompt = v,
            "worktree" => base.worktree = v,
            "folded" => base.folded = v,
            "open" => base.open = v,
            "cursor" => base.cursor = v,
            "bullet" => base.bullet = v,
            "queued" => base.queued = v,
            "open_agent" => base.open_agent = v,
            "here" => base.here = v,
            "unread" => base.unread = v,
            "light" => base.light = v,
            "ok" => base.ok = v,
            "warn" => base.warn = v,
            "off" => base.off = v,
            "sep" => base.sep = v,
            "idle" => base.idle = v,
            "waiting" => base.waiting = v,
            "paused" => base.paused = v,
            "error" => base.error = v,
            "user" => base.user = Some(v),
            "agent" => base.agent = Some(v),
            _ => {}
        }
    }
    base
}

/// The icons on screen now.
pub fn icons(app: &App) -> Icons {
    icons_for(&app.config.ui.icons, &resolve(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn styles_layer_and_icons_follow_the_font() {
        let neon = crate::theme::load_def("neon").unwrap();
        let mine = StyleSpec { messages: Some("plain".into()), icons: vec![("prompt".into(), "λ ".into())], ..Default::default() };
        let s = resolve_layers(&[neon.style.as_ref(), Some(&mine)]);
        assert_eq!((s.sidebar.as_str(), s.messages.as_str()), ("cards", "plain"));
        assert_eq!(icons_for("unicode", &s).prompt, "λ ");
        assert_eq!(icons_for("unicode", &s).idle, "◇", "neon's own");
        let zen = crate::theme::load_def("zen").unwrap();
        let z = resolve_layers(&[zen.style.as_ref()]);
        assert_eq!(icons_for("nerd", &z).idle, "\u{f10c}");
        assert_eq!(icons_for("unicode", &z).idle, "·");
        let nebula = resolve_layers(&[crate::theme::load_def("nebula").unwrap().style.as_ref()]);
        assert_eq!(icons_for("unicode", &nebula).open_agent, "▸", "a Nerd Font glyph needs one");
        assert_eq!(tool_icon("Bash", false), "▶");
        assert_eq!(tool_kind("Glob"), "search");
        assert_eq!(icon_set("ascii").worktree, "wt:");
    }
}
