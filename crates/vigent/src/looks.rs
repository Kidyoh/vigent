//! Colors on screen: :colorscheme (and its picker with a live preview),
//! :theme save, :hi, :set, and the options that change how a theme is drawn
//! (transparent, termguicolors). src/app.ts openThemePicker, saveTheme,
//! execHighlight, applyColorMode; src/config.ts applySetCommand.

use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use crate::app::App;
use crate::config::{self, HiSpec, Transparent, UiOptions, Val};
use crate::settings::truncate;
use crate::theme::{self, Attr, ThemeDef};
use crate::ui::text::width;
use crate::vimcolors::{HiCommand, parse_highlight_command};

/// The options now, applied to how the theme is drawn (24-bit color, transparency).
pub fn apply_ui(app: &mut App) {
    app.theme.truecolor = app.config.ui.termguicolors;
    app.theme.transparency = app.config.ui.transparent.clone();
}

/// [highlights] from config.toml, as overrides over any theme.
pub fn highlight_overrides(list: &[(String, HiSpec)]) -> Vec<(String, Attr)> {
    let mut out: Vec<(String, Attr)> = vec![];
    for (group, h) in list {
        let a = match h {
            HiSpec::Link(to) => Attr { link: Some(to.clone()), ..Default::default() },
            HiSpec::Command(s) => match parse_highlight_command(&format!("{group} {s}")) {
                Some(HiCommand::Set { attr, .. }) => attr,
                _ => continue,
            },
            HiSpec::Attr { fg, bg, link, bold, italic, underline, reverse } => Attr { fg: fg.clone(), bg: bg.clone(), link: link.clone(), bold: *bold, italic: *italic, underline: *underline, reverse: *reverse },
        };
        out.retain(|(g, _)| g != group);
        out.push((group.clone(), a));
    }
    out
}

/// The theme for a start: overrides from [highlights], drawn with [ui]'s options.
pub fn startup_theme(def: ThemeDef, config: &config::Config) -> theme::Theme {
    let mut t = theme::Theme::new(def);
    t.overrides = highlight_overrides(&config.highlights);
    t.truecolor = config.ui.termguicolors;
    t.transparency = config.ui.transparent.clone();
    t
}

/// Switch to a theme by name; the message says what happened.
pub fn set_theme(app: &mut App, name: &str) {
    match theme::load_def(name) {
        Ok(def) => {
            app.theme.set_def(def);
            let msg = format!("colorscheme {}", app.theme.name);
            app.say(msg, "ModeMsg");
        }
        Err(e) => app.say(e, "ErrorMsg"),
    }
}

/// `:colorscheme [name]`, `:theme save[!] [name]`
pub fn exec_theme(app: &mut App, cmd: &str, arg: &str) {
    if arg.is_empty() {
        return open_theme_picker(app);
    }
    if cmd == "theme"
        && let Some(rest) = arg.strip_prefix("save")
    {
        let (force, rest) = match rest.strip_prefix('!') {
            Some(r) => (true, r),
            None => (false, rest),
        };
        if rest.is_empty() || rest.starts_with(char::is_whitespace) {
            let name = rest.trim();
            if !name.contains(char::is_whitespace) {
                return save_theme(app, name, force);
            }
        }
    }
    set_theme(app, arg);
}

/// `:theme save <name>`: what's on screen, :hi changes included, as a theme file.
pub fn save_theme(app: &mut App, name: &str, force: bool) {
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-') {
        return app.say("usage: :theme save <name>  (letters, digits, - _ .)", "ErrorMsg");
    }
    if theme::is_builtin(name) {
        return app.say(format!("'{name}' is a built-in theme; save under another name"), "ErrorMsg");
    }
    let file = theme::themes_dir().join(format!("{name}.toml"));
    let short = crate::settings::short_path(&file);
    if file.exists() && !force {
        return app.say(format!("E13: {short} exists (add ! to overwrite)"), "ErrorMsg");
    }
    let builtin_base = theme::is_builtin(&app.theme.def.name) && theme::load_def(&app.theme.def.name).map(|d| d.groups == app.theme.def.groups).unwrap_or(false);
    let text = theme::theme_file_for(name, &app.theme, builtin_base);
    let r = std::fs::create_dir_all(theme::themes_dir()).and_then(|_| std::fs::write(&file, text));
    match r.map_err(|e| e.to_string()).and_then(|_| theme::load_def(name)) {
        Ok(def) => {
            app.theme.set_def(def);
            app.say(format!("saved {short} · :colorscheme {name} (or theme = \"{name}\" in config.toml)"), "ModeMsg");
        }
        Err(e) => app.say(format!("couldn't save the theme: {e}"), "ErrorMsg"),
    }
}

fn describe_attr(a: &Attr) -> String {
    let mut parts = vec![];
    if let Some(fg) = &a.fg {
        parts.push(format!("guifg={fg}"));
    }
    if let Some(bg) = &a.bg {
        parts.push(format!("guibg={bg}"));
    }
    let flags: Vec<&str> = [("bold", a.bold), ("italic", a.italic), ("underline", a.underline), ("reverse", a.reverse)].iter().filter(|(_, v)| *v == Some(true)).map(|(k, _)| *k).collect();
    if !flags.is_empty() {
        parts.push(format!("gui={}", flags.join(",")));
    }
    if parts.is_empty() { "cleared".into() } else { parts.join(" ") }
}

/// `:hi Group guifg=… guibg=… gui=…`, `:hi link A B`, `:hi clear [Group]`, `:hi Group`
pub fn exec_highlight(app: &mut App, arg: &str) {
    let Some(cmd) = parse_highlight_command(arg) else {
        return app.say("usage: :hi Group guifg=#rrggbb guibg=#rrggbb gui=bold | :hi link A B | :hi clear", "Comment");
    };
    match cmd {
        HiCommand::Show { group } => {
            let a = app.theme.attr(&group);
            return app.say(format!("{group} xxx {}", describe_attr(&a)), "Normal");
        }
        HiCommand::Set { group, attr, .. } => app.theme.highlight(&group, &attr),
        HiCommand::Link { from, to } => app.theme.link(&from, &to),
        HiCommand::Clear { group } => app.theme.clear(group.as_deref()),
    }
    app.say("", "Normal");
}

// ---------------------------------------------------------------------------
// :set
// ---------------------------------------------------------------------------

fn show(ui: &UiOptions, key: &str) -> String {
    let b = |name: &str, v: bool| if v { format!("  {name}") } else { format!("no{name}") };
    match key {
        "sidebar" => b(key, ui.sidebar),
        "number" => b(key, ui.number),
        "tilde" => b(key, ui.tilde),
        "termguicolors" => b(key, ui.termguicolors),
        "whichkey" => b(key, ui.whichkey),
        "sidebar_width" => format!("  {key}={}", ui.sidebar_width),
        "sidebar_position" => format!("  {key}={}", ui.sidebar_position),
        "icons" => format!("  {key}={}", ui.icons),
        "timeoutlen" => format!("  {key}={}", ui.timeoutlen),
        "notify" => format!("  {key}={}", ui.notify),
        "transparent" => match ui.transparent {
            Transparent::On => b(key, true),
            Transparent::Off => b(key, false),
            Transparent::Auto => format!("  {key}=auto"),
        },
        _ => String::new(),
    }
}

/// The [ui] options in the order :set lists them (src/config.ts UiOptions).
const UI_KEYS: [&str; 11] = ["sidebar", "sidebar_width", "sidebar_position", "number", "tilde", "icons", "timeoutlen", "termguicolors", "transparent", "whichkey", "notify"];

fn is_bool(key: &str) -> bool {
    matches!(key, "sidebar" | "number" | "tilde" | "termguicolors" | "whichkey")
}

fn set_bool(ui: &mut UiOptions, key: &str, v: bool) {
    match key {
        "sidebar" => ui.sidebar = v,
        "number" => ui.number = v,
        "tilde" => ui.tilde = v,
        "termguicolors" => ui.termguicolors = v,
        "whichkey" => ui.whichkey = v,
        "transparent" => ui.transparent = if v { Transparent::On } else { Transparent::Off },
        _ => {}
    }
}

fn get_bool(ui: &UiOptions, key: &str) -> bool {
    match key {
        "sidebar" => ui.sidebar,
        "number" => ui.number,
        "tilde" => ui.tilde,
        "termguicolors" => ui.termguicolors,
        _ => ui.whichkey,
    }
}

fn word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// vim's :set over [ui]: `opt`, `noopt`, `opt!`, `invopt`, `opt=val`, `opt?`, `opt&`, and none (list them).
/// `now_transparent` is what's on screen, for toggling an option that follows the theme.
/// Returns the message and whether it's an error.
pub fn apply_set(ui: &mut UiOptions, arg: &str, now_transparent: bool) -> (String, bool) {
    if arg.trim().is_empty() {
        return (UI_KEYS.iter().map(|k| show(ui, k)).collect::<Vec<_>>().join("  "), false);
    }
    let mut shown = vec![];
    for part in arg.split_whitespace() {
        if let Some(name) = part.strip_suffix('?').filter(|n| word(n)) {
            let Some(key) = config::ui_option(name) else { return (format!("E518: Unknown option: {name}"), true) };
            shown.push(show(ui, key));
            continue;
        }
        if let Some((name, value)) = part.split_once('=').filter(|(n, _)| word(n)) {
            if let Err(e) = config::set_option(ui, name, &Val::Str(value.to_string())) {
                return (format!("E518: {e}"), true);
            }
            continue;
        }
        if let Some(name) = part.strip_suffix('!').filter(|n| word(n)).or_else(|| part.strip_prefix("inv").filter(|n| word(n))) {
            let key = config::ui_option(name);
            if key == Some("transparent") {
                let now = match ui.transparent {
                    Transparent::Auto => now_transparent,
                    Transparent::On => true,
                    Transparent::Off => false,
                };
                set_bool(ui, "transparent", !now);
                continue;
            }
            match key {
                Some(k) if is_bool(k) => {
                    let v = get_bool(ui, k);
                    set_bool(ui, k, !v);
                }
                _ => return (format!("E518: Unknown option: {part}"), true),
            }
            continue;
        }
        if let Some(name) = part.strip_suffix('&').filter(|n| word(n)) {
            let Some(key) = config::ui_option(name) else { return (format!("E518: Unknown option: {name}"), true) };
            let d = UiOptions::default();
            match key {
                "sidebar_width" => ui.sidebar_width = d.sidebar_width,
                "sidebar_position" => ui.sidebar_position = d.sidebar_position,
                "icons" => ui.icons = d.icons,
                "timeoutlen" => ui.timeoutlen = d.timeoutlen,
                "notify" => ui.notify = d.notify,
                "transparent" => ui.transparent = d.transparent,
                k => set_bool(ui, k, get_bool(&d, k)),
            }
            continue;
        }
        let off = part.strip_prefix("no").filter(|n| config::ui_option(n).is_some());
        let Some(key) = config::ui_option(off.unwrap_or(part)) else { return (format!("E518: Unknown option: {part}"), true) };
        if !is_bool(key) && key != "transparent" {
            shown.push(show(ui, key));
            continue;
        }
        set_bool(ui, key, off.is_none());
    }
    (shown.join("  "), false)
}

/// `:set ...`
pub fn exec_set(app: &mut App, arg: &str) {
    let now = app.theme.transparent();
    let (msg, err) = apply_set(&mut app.config.ui, arg, now);
    apply_ui(app);
    app.say(msg, if err { "ErrorMsg" } else { "Normal" });
}

// ---------------------------------------------------------------------------
// the theme picker
// ---------------------------------------------------------------------------

const VISIBLE: usize = 14;

/// `:colorscheme` with no name: pick a theme with a live preview (src/picker.ts ThemePicker).
pub struct ThemePicker {
    themes: Vec<String>,
    current: String,
    original: ThemeDef,
    query: String,
    searching: bool,
    index: usize,
    scroll: usize,
}

impl ThemePicker {
    fn filtered(&self) -> Vec<String> {
        if self.query.is_empty() {
            return self.themes.clone();
        }
        let q = self.query.to_lowercase();
        // fuzzy: the query's letters in order
        self.themes
            .iter()
            .filter(|t| {
                let mut it = t.to_lowercase().chars().collect::<Vec<_>>().into_iter();
                q.chars().all(|c| it.any(|x| x == c))
            })
            .cloned()
            .collect()
    }
}

pub fn open_theme_picker(app: &mut App) {
    app.seq.reset();
    let themes = theme::list();
    let current = app.theme.name.clone();
    let index = themes.iter().position(|t| *t == current).unwrap_or(0);
    app.cfg.picker = Some(ThemePicker { scroll: (index + 1).saturating_sub(VISIBLE), themes, current, original: app.theme.def.clone(), query: String::new(), searching: false, index });
}

fn preview(app: &mut App, name: &str) {
    match theme::load_def(name) {
        Ok(d) => {
            app.theme.set_def(d);
            app.say("", "Normal");
        }
        Err(e) => app.say(e, "ErrorMsg"),
    }
}

pub fn picker_key(app: &mut App, k: KeyEvent) {
    let Some(token) = crate::keys::token_from_event(&k) else { return };
    picker_feed(app, &token);
}

pub fn picker_feed(app: &mut App, key: &str) {
    let Some(mut p) = app.cfg.picker.take() else { return };
    let items = p.filtered();
    let done = |app: &mut App, p: &ThemePicker, pick: Option<String>| match pick {
        Some(name) => {
            preview(app, &name);
            app.say(format!("colorscheme {name}"), "ModeMsg");
        }
        None => app.theme.set_def(p.original.clone()),
    };
    let mut moved: Option<isize> = None;
    match key {
        "<C-c>" => return done(app, &p, None),
        "<CR>" => return done(app, &p, items.get(p.index).cloned()),
        "<Down>" | "<Tab>" | "<C-n>" | "<C-j>" => moved = Some(1),
        "<Up>" | "<S-Tab>" | "<C-p>" | "<C-k>" => moved = Some(-1),
        _ if p.searching => match key {
            "<Esc>" => p.searching = false,
            "<BS>" => {
                if p.query.pop().is_none() {
                    p.searching = false;
                } else {
                    reset(app, &mut p);
                }
            }
            "<C-u>" => {
                p.query.clear();
                reset(app, &mut p);
            }
            k => {
                if let Some(t) = crate::keys::token_text(k) {
                    p.query.push_str(&t);
                    reset(app, &mut p);
                }
            }
        },
        "j" => moved = Some(1),
        "k" => moved = Some(-1),
        "g" => moved = Some(-(p.index as isize)),
        "G" => moved = Some(items.len() as isize - 1 - p.index as isize),
        "/" => p.searching = true,
        "q" => return done(app, &p, None),
        "<Esc>" => {
            if p.query.is_empty() {
                return done(app, &p, None);
            }
            p.query.clear();
            reset(app, &mut p);
        }
        _ => {}
    }
    if let Some(d) = moved
        && !items.is_empty()
    {
        let n = items.len() as isize;
        p.index = ((p.index as isize + d + n) % n) as usize;
        if p.index < p.scroll {
            p.scroll = p.index;
        }
        if p.index >= p.scroll + VISIBLE {
            p.scroll = p.index + 1 - VISIBLE;
        }
        preview(app, &items[p.index]);
    }
    app.cfg.picker = Some(p);
}

fn reset(app: &mut App, p: &mut ThemePicker) {
    p.index = 0;
    p.scroll = 0;
    if let Some(first) = p.filtered().first() {
        preview(app, first);
    }
}

pub fn draw_picker(f: &mut Frame, app: &App, area: Rect) {
    let Some(p) = &app.cfg.picker else { return };
    let t = &app.theme;
    let ascii = app.config.ui.icons == "ascii";
    let (tl, tr, bl, br, hz, vt, lt, rt, cur, prompt) = if ascii {
        ("+", "+", "+", "+", "-", "|", "+", "+", "*", ">")
    } else if app.config.ui.icons == "nerd" {
        ("╭", "╮", "╰", "╯", "─", "│", "├", "┤", "\u{f00c}", "\u{f002}")
    } else {
        ("╭", "╮", "╰", "╯", "─", "│", "├", "┤", "●", "❯")
    };
    let w = 64.min(area.width.saturating_sub(4)).max(20) as usize;
    let inner = w - 2;
    let bg = t.hl("NormalFloat").bg;
    let on = |g: &str, b| Style { bg: b, ..t.hl(g) };
    let border = on("FloatBorder", bg);
    let row = |content: Vec<Span<'static>>, used: usize, rbg| {
        let mut s = vec![Span::styled(vt.to_string(), border)];
        s.extend(content);
        s.push(Span::styled(" ".repeat(inner.saturating_sub(used)), on("NormalFloat", rbg)));
        s.push(Span::styled(vt.to_string(), border));
        Line::from(s)
    };
    let items = p.filtered();
    let title = " Colorschemes ";
    let keys = if p.searching { "type to filter · Esc done" } else { "j/k move · Enter pick · q close" };
    let count = format!(" {}/{} · {keys} ", if items.is_empty() { 0 } else { p.index + 1 }, items.len());
    let mut lines = vec![Line::from(vec![Span::styled(format!("{tl}{hz}"), border), Span::styled(title, on("FloatTitle", bg)), Span::styled(format!("{}{tr}", hz.repeat(inner.saturating_sub(1 + width(title)))), border)])];
    if p.searching {
        let used = width(prompt) + 2 + width(&p.query) + 1;
        lines.push(row(vec![Span::styled(format!(" {prompt} "), on("Title", bg)), Span::styled(p.query.clone(), on("NormalFloat", bg)), Span::styled(" ", t.hl("PmenuSel"))], used, bg));
    } else {
        let hint = truncate(&if p.query.is_empty() { "/ to search".to_string() } else { format!("/{}", p.query) }, inner.saturating_sub(4), "…");
        let used = width(&hint) + 3;
        lines.push(row(vec![Span::styled(format!(" {prompt} {hint}"), on("Comment", bg))], used, bg));
    }
    lines.push(Line::from(Span::styled(format!("{lt}{}{rt}", hz.repeat(inner)), border)));
    let sel_bg = t.hl("PmenuSel").bg.or(t.hl("Visual").bg);
    for i in 0..VISIBLE {
        let Some(name) = items.get(p.scroll + i) else {
            lines.push(row(vec![], 0, bg));
            continue;
        };
        let selected = p.scroll + i == p.index;
        let rbg = if selected { sel_bg } else { bg };
        let group = if selected { "PmenuSel" } else { "NormalFloat" };
        let marker = if *name == p.current { format!("{cur} ") } else { "  ".into() };
        let look = theme::load_def(name).ok();
        let (colors, tags) = match &look {
            Some(d) => {
                let pal = theme::extract_palette(d);
                let colors: Vec<String> = ["bg", "red", "yellow", "green", "cyan", "blue", "magenta"].iter().map(|k| pal.get(k).unwrap_or("#000000").to_string()).collect();
                let mut tags = vec![if d.background.as_deref() == Some("light") { "light" } else { "dark" }];
                if d.transparent {
                    tags.push("transparent");
                }
                (colors, tags.join(" "))
            }
            None => (vec![], String::new()),
        };
        let swatch_w = if look.is_some() { colors.len() * 2 + 1 } else { 0 };
        let name_w = (inner.saturating_sub(2 + swatch_w + if tags.is_empty() { 0 } else { tags.len() + 1 })).clamp(8, 24);
        let text = truncate(&format!("{marker}{name}"), name_w, "…");
        let mut content = vec![Span::styled(format!(" {text}{} ", " ".repeat(name_w.saturating_sub(width(&text)))), on(group, rbg))];
        let mut used = name_w + 2;
        if look.is_some() && inner.saturating_sub(used) >= swatch_w {
            for c in &colors {
                content.push(Span::styled("  ", t.style_of(&Attr { bg: Some(c.clone()), ..Default::default() })));
            }
            content.push(Span::styled(" ", on(group, rbg)));
            used += swatch_w;
            if !tags.is_empty() && inner.saturating_sub(used) >= tags.len() {
                used += tags.len();
                content.push(Span::styled(tags, on("Comment", rbg)));
            }
        }
        lines.push(row(content, used, rbg));
    }
    if items.is_empty() {
        lines[3] = row(vec![Span::styled("  no match", on("Comment", bg))], 10, bg);
    }
    lines.push(Line::from(vec![Span::styled(format!("{bl}{}", hz.repeat(inner.saturating_sub(width(&count) + 1))), border), Span::styled(count.clone(), on("Comment", bg)), Span::styled(format!("{hz}{br}"), border)]));
    let h = (lines.len() as u16).min(area.height);
    let r = Rect::new(area.x + (area.width.saturating_sub(w as u16)) / 2, area.y + (area.height - h) / 2, w as u16, h);
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines), r);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_like_vim() {
        let mut ui = UiOptions::default();
        assert_eq!(apply_set(&mut ui, "nonumber sbw=40", false), (String::new(), false));
        assert!(!ui.number);
        assert_eq!(ui.sidebar_width, 40);
        apply_set(&mut ui, "sbp=right", false);
        assert_eq!(ui.sidebar_position, "right");
        assert!(apply_set(&mut ui, "sidebar_position?", false).0.contains("sidebar_position=right"));
        apply_set(&mut ui, "sidebar_position&", false);
        assert_eq!(ui.sidebar_position, "left");
        apply_set(&mut ui, "number!", false);
        assert!(ui.number);
        apply_set(&mut ui, "invtransparent", true);
        assert_eq!(ui.transparent, Transparent::Off, "following the theme: flip what's on screen");
        assert_eq!(apply_set(&mut ui, "bogus", false), ("E518: Unknown option: bogus".into(), true));
        assert!(apply_set(&mut ui, "sbw=3", false).0.starts_with("E518: 'sbw' should be a number"));
        let all = apply_set(&mut ui, "", false).0;
        assert!(all.starts_with("  sidebar    sidebar_width=40"), "{all}");
    }

    #[test]
    fn hi_and_themes() {
        let mut a = crate::app::tests::app();
        exec_highlight(&mut a, "Comment guifg=#ff0000");
        assert_eq!(a.theme.attr("Comment").fg.as_deref(), Some("#ff0000"));
        exec_theme(&mut a, "colorscheme", "nord");
        assert_eq!(a.theme.name, "nord");
        assert_eq!(a.theme.attr("Comment").fg.as_deref(), Some("#ff0000"), ":hi survives a colorscheme change");
        exec_highlight(&mut a, "clear");
        exec_theme(&mut a, "theme", "save default");
        assert!(a.message.0.contains("built-in"));
        exec_theme(&mut a, "colorscheme", "");
        picker_feed(&mut a, "j");
        assert_ne!(a.theme.name, "nord", "j previews the next one");
        picker_feed(&mut a, "q");
        assert_eq!(a.theme.name, "nord", "q puts the old one back");
        assert!(a.cfg.picker.is_none());
    }
}
