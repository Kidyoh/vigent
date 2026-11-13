//! `:settings`: every option in one float, changed in place (src/settings.ts,
//! App.openSettings / saveSettings in src/app.ts). `:permissions` uses the
//! same panel.
//!
//!   j/k move · Enter or Space change · h/l step back or forward ·
//!   w save to config.toml · q / Esc close
//!
//! Changes apply at once. A key row waits for the new keys: type them, then
//! Enter (Esc cancels).
//!
//! The Config area's own state on the App is [`ConfigState`] (`app.cfg`).

use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};
use std::path::Path;

use crate::app::App;
use crate::config::{self, ICON_SETS, MESSAGE_STYLES, NOTIFY_MODES, SEPARATOR_STYLES, SIDEBAR_STYLES, Transparent};
use crate::keys::{self, KeyMode, RhsValue};
use crate::ui::text::width;

/// The Config area's state: the open panel, what :settings and :permissions changed, demo mode.
#[derive(Default)]
pub struct ConfigState {
    /// the :settings / :permissions float, when open (keys go to it)
    pub panel: Option<Panel>,
    /// the :colorscheme picker, when open
    pub picker: Option<crate::looks::ThemePicker>,
    /// the :templates picker, when open
    pub templates: Option<crate::templates::Picker>,
    /// engines whose permissions :permissions changed (what permissions::save writes)
    pub permissions_changed: Vec<String>,
    /// NORMAL-mode keys :settings rebound: lhs -> rhs (None: unmapped), what w writes to [keys.normal]
    pub key_changes: Vec<(String, Option<String>)>,
    /// --demo, or nothing can run agents: scripted sessions (src/demo.ts)
    pub demo: bool,
    /// user commands running user commands (E169 past 10)
    pub command_depth: usize,
}

pub type ValueFn = Box<dyn Fn(&App) -> String>;
pub type ChangeFn = Box<dyn Fn(&mut App, i32)>;
pub type OpenFn = Box<dyn Fn(&mut App)>;
pub type BindFn = Box<dyn Fn(&mut App, &[String]) -> String>;

/// One row of the panel.
pub struct Item {
    pub section: String,
    pub label: String,
    /// what it is now, shown at the right
    pub value: ValueFn,
    /// h/l, Enter or Space: step the value (1 forward, -1 back)
    pub change: Option<ChangeFn>,
    /// Enter opens something else instead (the theme picker)
    pub open: Option<OpenFn>,
    /// Enter waits for keys, then calls this with them (vim notation)
    pub bind: Option<BindFn>,
    /// shown under the list when the row is selected
    pub hint: String,
    /// read what's saved first (permissions: another vigent may have changed them)
    pub reload_first: bool,
}

impl Item {
    fn base(section: &str, label: &str, value: ValueFn, hint: &str) -> Item {
        Item { section: section.into(), label: label.into(), value, change: None, open: None, bind: None, hint: hint.into(), reload_first: false }
    }
    pub fn change(section: &str, label: &str, value: fn(&App) -> String, change: fn(&mut App, i32), hint: &str) -> Item {
        Item { change: Some(Box::new(change)), ..Item::base(section, label, Box::new(value), hint) }
    }
    pub fn change_with(section: &str, label: &str, value: ValueFn, change: ChangeFn, hint: &str) -> Item {
        Item { change: Some(change), ..Item::base(section, label, value, hint) }
    }
    pub fn info(section: &str, label: &str, value: fn(&App) -> String, hint: &str) -> Item {
        Item::base(section, label, Box::new(value), hint)
    }
    pub fn open(section: &str, label: &str, value: fn(&App) -> String, open: fn(&mut App), hint: &str) -> Item {
        Item { open: Some(Box::new(open)), ..Item::base(section, label, Box::new(value), hint) }
    }
}

/// The settings float (src/settings.ts SettingsFloat).
pub struct Panel {
    pub title: String,
    pub items: Vec<Item>,
    pub index: usize,
    scroll: usize,
    capturing: Option<Vec<String>>,
    pub message: String,
    /// widest it gets
    max_width: u16,
    on_save: fn(&mut App) -> String,
}

impl Panel {
    pub fn new(title: &str, items: Vec<Item>, max_width: u16, on_save: fn(&mut App) -> String) -> Panel {
        Panel { title: title.into(), items, index: 0, scroll: 0, capturing: None, message: String::new(), max_width, on_save }
    }

    /// Select the row with this label.
    pub fn select(&mut self, label: &str) -> bool {
        match self.items.iter().position(|i| i.label == label) {
            Some(i) => {
                self.index = i;
                true
            }
            None => false,
        }
    }

    fn move_by(&mut self, d: isize) {
        let n = self.items.len() as isize;
        self.index = ((self.index as isize + d + n) % n) as usize;
    }

    /// The panel's text, for tests: each row "label  value".
    pub fn text(&self, app: &App) -> String {
        let mut out = vec![self.title.clone()];
        let mut section = "";
        for it in &self.items {
            if it.section != section {
                section = &it.section;
                out.push(format!(" {section}"));
            }
            out.push(format!("   {:<34} {}", it.label, (it.value)(app)));
        }
        out.join("\n")
    }
}

/// A path as the message line shows it: relative to here unless that climbs out two levels.
pub fn short_path(p: &Path) -> String {
    let cwd = std::env::current_dir().unwrap_or_default();
    match relative(&cwd, p) {
        Some(rel) if !rel.is_empty() && !rel.starts_with("../..") => rel,
        _ => p.display().to_string(),
    }
}

/// path.relative(from, to) for absolute paths.
fn relative(from: &Path, to: &Path) -> Option<String> {
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    if common == 0 {
        return None;
    }
    let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().to_string()));
    Some(parts.join("/"))
}

/// Cut text to `max` columns, ending in `tail` when it was longer (pi-tui truncateToWidth).
pub fn truncate(s: &str, max: usize, tail: &str) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    let room = max.saturating_sub(width(tail));
    let mut out = String::new();
    let mut w = 0;
    for c in s.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
        if w + cw > room {
            break;
        }
        out.push(c);
        w += cw;
    }
    out + tail
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/// A Config-area float is open (the panel, the theme picker, the template picker): keys go to it.
pub fn is_open(app: &App) -> bool {
    app.cfg.panel.is_some() || app.cfg.picker.is_some() || app.cfg.templates.is_some()
}

/// A key to whichever Config-area float is open.
pub fn key_any(app: &mut App, k: KeyEvent) {
    if app.cfg.picker.is_some() {
        crate::looks::picker_key(app, k)
    } else if app.cfg.templates.is_some() {
        crate::templates::key(app, k)
    } else {
        key(app, k)
    }
}

/// Draw whichever Config-area float is open, over the rest.
pub fn draw_any(f: &mut Frame, app: &mut App, area: Rect) {
    draw(f, app, area);
    crate::looks::draw_picker(f, app, area);
    crate::templates::draw(f, app, area);
}

/// A key while the panel is open.
pub fn key(app: &mut App, k: KeyEvent) {
    let Some(token) = keys::token_from_event(&k) else { return };
    feed(app, &token);
}

/// One key (vim notation) to the open panel.
pub fn feed(app: &mut App, key: &str) {
    let Some(mut p) = app.cfg.panel.take() else { return };
    if let Some(cap) = p.capturing.as_mut() {
        match key {
            "<Esc>" => {
                p.capturing = None;
                p.message = "cancelled".into();
            }
            "<CR>" => {
                let keys = p.capturing.take().unwrap_or_default();
                if keys.is_empty() {
                    p.message = "no keys typed".into();
                } else if let Some(bind) = &p.items[p.index].bind {
                    p.message = bind(app, &keys);
                }
            }
            "<BS>" => {
                cap.pop();
            }
            k => cap.push(k.to_string()),
        }
        return restore(app, p);
    }
    let i = p.index;
    let reload = p.items[i].reload_first;
    match key {
        "q" | "<Esc>" | "<C-c>" => return, // closed
        "j" | "<Down>" | "<Tab>" | "<C-n>" => p.move_by(1),
        "k" | "<Up>" | "<S-Tab>" | "<C-p>" => p.move_by(-1),
        "g" => p.index = 0,
        "G" => p.index = p.items.len() - 1,
        "l" | "<Right>" | "h" | "<Left>" => {
            let d = if matches!(key, "l" | "<Right>") { 1 } else { -1 };
            if let Some(change) = &p.items[i].change {
                if reload {
                    crate::permissions::reload(app);
                }
                change(app, d);
            }
            p.message.clear();
        }
        "<CR>" | "<Space>" => {
            p.message.clear();
            if let Some(open) = p.items[i].open.take() {
                // it replaces this panel with what it opens
                open(app);
                return;
            }
            if p.items[i].bind.is_some() {
                p.capturing = Some(vec![]);
            } else if let Some(change) = &p.items[i].change {
                if reload {
                    crate::permissions::reload(app);
                }
                change(app, 1);
            }
        }
        "w" => p.message = (p.on_save)(app),
        _ => {}
    }
    restore(app, p);
}

/// Put the panel back, unless what ran opened another one.
fn restore(app: &mut App, p: Panel) {
    if app.cfg.panel.is_none() {
        app.cfg.panel = Some(p);
    }
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

pub fn draw(f: &mut Frame, app: &mut App, area: Rect) {
    let Some(mut p) = app.cfg.panel.take() else { return };
    let w = p.max_width.min(area.width.saturating_sub(4)).max(32.min(area.width));
    let lines = render(&mut p, app, w as usize, area.height.saturating_sub(2) as usize);
    let h = (lines.len() as u16).min(area.height);
    let r = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines), r);
    app.cfg.panel = Some(p);
}

fn render(p: &mut Panel, app: &App, width: usize, height: usize) -> Vec<Line<'static>> {
    let t = &app.theme;
    let ascii = app.config.ui.icons == "ascii";
    let (tl, tr, bl, br, hz, vt, lt, rt) = if ascii { ("+", "+", "+", "+", "-", "|", "+", "+") } else { ("╭", "╮", "╰", "╯", "─", "│", "├", "┤") };
    let inner = width.max(30) - 2;
    let float = t.hl("NormalFloat");
    let bg = float.bg;
    let on = |group: &str, rbg: Option<ratatui::style::Color>| {
        let s = t.hl(group);
        Style { bg: rbg, ..s }
    };
    let border = on("FloatBorder", bg);
    let row = |content: Vec<Span<'static>>, used: usize, rbg: Option<ratatui::style::Color>| {
        let mut spans = vec![Span::styled(vt.to_string(), border)];
        spans.extend(content);
        spans.push(Span::styled(" ".repeat(inner.saturating_sub(used)), on("NormalFloat", rbg)));
        spans.push(Span::styled(vt.to_string(), border));
        Line::from(spans)
    };
    let title = format!(" {} ", p.title);
    let mut lines = vec![Line::from(vec![
        Span::styled(format!("{tl}{hz}"), border),
        Span::styled(title.clone(), on("FloatTitle", bg)),
        Span::styled(format!("{}{tr}", hz.repeat(inner.saturating_sub(1 + width_of(&title)))), border),
    ])];
    // rows: section headers and items
    let mut rows: Vec<Result<String, usize>> = vec![];
    let mut section = String::new();
    for (i, it) in p.items.iter().enumerate() {
        if it.section != section {
            section = it.section.clone();
            rows.push(Ok(section.clone()));
        }
        rows.push(Err(i));
    }
    let selected_row = rows.iter().position(|r| *r == Err(p.index)).unwrap_or(0);
    let room = height.saturating_sub(6).max(5);
    if selected_row < p.scroll {
        p.scroll = selected_row.saturating_sub(1);
    }
    if selected_row >= p.scroll + room {
        p.scroll = selected_row + 1 - room;
    }
    let sel_bg = t.hl("PmenuSel").bg.or(t.hl("Visual").bg);
    for r in rows.iter().skip(p.scroll).take(room) {
        match r {
            Ok(header) => lines.push(row(vec![Span::styled(format!(" {header}"), on("Title", bg))], width_of(header) + 1, bg)),
            Err(i) => {
                let it = &p.items[*i];
                let selected = *i == p.index;
                let rbg = if selected { sel_bg } else { bg };
                let group = if selected { "PmenuSel" } else { "NormalFloat" };
                let value = match (&p.capturing, selected) {
                    (Some(c), true) => format!("{}  (Enter keeps, Esc cancels)", if c.is_empty() { "…".to_string() } else { c.concat() }),
                    _ => (it.value)(app),
                };
                let label_w = 34.min(inner.saturating_sub(4));
                let label = truncate(&it.label, label_w, "…");
                let value_text = truncate(&value, inner.saturating_sub(label_w + 5).max(4), "…");
                let arrows = if it.change.is_some() && it.bind.is_none() { "‹ › " } else { "" };
                let tail = if selected { format!(" {arrows}") } else { String::new() };
                let used = 3 + label_w + 1 + width_of(&value_text) + width_of(&tail);
                lines.push(row(
                    vec![
                        Span::styled(format!("   {label}{} ", " ".repeat(label_w.saturating_sub(width_of(&label)))), on(group, rbg)),
                        Span::styled(value_text, on(if selected { "PmenuSel" } else { "Special" }, rbg)),
                        Span::styled(tail, on("Comment", rbg)),
                    ],
                    used,
                    rbg,
                ));
            }
        }
    }
    while lines.len() < room + 1 {
        lines.push(row(vec![], 0, bg));
    }
    let item = &p.items[p.index];
    let hint = if p.capturing.is_some() {
        "type the new keys, then Enter · Backspace removes one · Esc cancels".to_string()
    } else if !p.message.is_empty() {
        p.message.clone()
    } else {
        item.hint.clone()
    };
    lines.push(Line::from(Span::styled(format!("{lt}{}{rt}", hz.repeat(inner)), border)));
    let hint_group = if !p.message.is_empty() && p.capturing.is_none() { "ModeMsg" } else { "Comment" };
    let hint_text = format!(" {}", truncate(&hint, inner.saturating_sub(2), "…"));
    let hint_w = width_of(&hint_text);
    lines.push(row(vec![Span::styled(hint_text, on(hint_group, bg))], hint_w.min(inner), bg));
    let keys_text = truncate(" j/k move · Enter/Space change · h/l back/forward · w save to config.toml · q close ", inner, "");
    let kw = width_of(&keys_text);
    lines.push(Line::from(vec![Span::styled(bl.to_string(), border), Span::styled(keys_text, on("Comment", bg)), Span::styled(format!("{}{br}", hz.repeat(inner.saturating_sub(kw))), border)]));
    lines
}

fn width_of(s: &str) -> usize {
    width(s)
}

// ---------------------------------------------------------------------------
// :settings
// ---------------------------------------------------------------------------

fn on_off(b: bool) -> String {
    (if b { "on" } else { "off" }).into()
}

fn cycle<T: PartialEq + Clone>(values: &[T], now: &T, dir: i32) -> T {
    let n = values.len() as i32;
    let at = values.iter().position(|v| v == now).map(|i| i as i32).unwrap_or(-1);
    values[((at + dir + n) % n) as usize].clone()
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// Colors changed: the theme is drawn again with the options now (transparent, 24-bit color).
pub fn refresh(app: &mut App) {
    crate::looks::apply_ui(app);
}

/// `:settings`: theme, look, agents and keys in one float; w saves them to config.toml.
pub fn open(app: &mut App) {
    app.seq.reset();
    let mut items: Vec<Item> = vec![
        Item::open("Look", "Theme", |a| a.theme.name.clone(), crate::looks::open_theme_picker, &format!("{} themes, with a live preview · :theme save <name> keeps your own", crate::theme::list().len())),
        Item::change(
            "Look",
            "Transparent background",
            |a| match a.config.ui.transparent {
                Transparent::Auto => format!("auto ({}: the theme decides)", if a.theme.transparent() { "on" } else { "off" }),
                Transparent::On => "on".into(),
                Transparent::Off => "off".into(),
            },
            |a, d| {
                a.config.ui.transparent = cycle(&[Transparent::Auto, Transparent::On, Transparent::Off], &a.config.ui.transparent, d);
                refresh(a);
            },
            "the terminal's own background shows through (its blur, opacity or wallpaper)",
        ),
        Item::change(
            "Look",
            "Icons",
            |a| a.config.ui.icons.clone(),
            |a, _| {
                a.config.ui.icons = cycle(&strs(&ICON_SETS), &a.config.ui.icons, 1);
                refresh(a);
            },
            "nerd: Nerd Font icons (needs a Nerd Font) · ascii: fonts without box-drawing characters",
        ),
        Item::change(
            "Look",
            "24-bit color",
            |a| on_off(a.config.ui.termguicolors),
            |a, _| {
                a.config.ui.termguicolors = !a.config.ui.termguicolors;
                refresh(a);
            },
            "off: the nearest of the 256 standard colors (vim's 'termguicolors')",
        ),
        Item::change("Layout", "Sidebar", |a| on_off(a.config.ui.sidebar), |a, _| a.config.ui.sidebar = !a.config.ui.sidebar, ""),
        Item::change(
            "Layout",
            "Sidebar width",
            |a| format!("{} columns", a.config.ui.sidebar_width),
            |a, d| a.config.ui.sidebar_width = (a.config.ui.sidebar_width as i32 + 2 * d).clamp(16, 80) as u16,
            "h / l: 2 columns narrower / wider",
        ),
        Item::change(
            "Layout",
            "Sidebar side",
            |a| a.config.ui.sidebar_position.clone(),
            |a, _| a.config.ui.sidebar_position = if a.config.ui.sidebar_position == "left" { "right".into() } else { "left".into() },
            "",
        ),
        Item::change(
            "Layout",
            "Sidebar style",
            |a| crate::style::resolve(a).sidebar,
            |a, d| a.config.style.sidebar = Some(cycle(&strs(&SIDEBAR_STYLES), &crate::style::resolve(a).sidebar, d)),
            "tree (neo-tree), cards (a box per agent), compact (a row per agent)",
        ),
        Item::change(
            "Layout",
            "Messages",
            |a| crate::style::resolve(a).messages,
            |a, d| a.config.style.messages = Some(cycle(&strs(&MESSAGE_STYLES), &crate::style::resolve(a).messages, d)),
            "plain (❯ prompts), labeled (a header per message), bubbles (your prompts in boxes)",
        ),
        Item::change(
            "Layout",
            "Statusline shapes",
            |a| {
                let s = crate::style::resolve(a).separators;
                let needs = if s != "none" && a.config.ui.icons != "nerd" { " (needs icons = nerd)" } else { "" };
                format!("{s}{needs}")
            },
            |a, d| a.config.style.separators = Some(cycle(&strs(&SEPARATOR_STYLES), &crate::style::resolve(a).separators, d)),
            "lualine-style segments: round, arrow or slant (Nerd Font glyphs)",
        ),
        Item::change("Layout", "Session numbers", |a| on_off(a.config.ui.number), |a, _| a.config.ui.number = !a.config.ui.number, ""),
        Item::change("Layout", "~ on empty sidebar rows", |a| on_off(a.config.ui.tilde), |a, _| a.config.ui.tilde = !a.config.ui.tilde, ""),
        Item::open(
            "Agents",
            "Permissions",
            |_| "what each agent may do without asking".into(),
            crate::permissions::open,
            ":permissions · Claude Code's mode and allowed commands, Codex's sandbox and network, Gemini's approval",
        ),
        Item::change(
            "Agents",
            "Engine for new agents",
            |a| match a.config.engine.as_deref() {
                None | Some("auto") => format!("auto ({})", crate::engines::engine_name(a.new_agent_engine())),
                Some(e) => crate::engines::engine_name(e),
            },
            |a, d| {
                let mut all = vec!["auto".to_string()];
                all.extend(crate::engines::KNOWN.iter().map(|s| s.id.to_string()));
                all.extend(a.config.custom_engines.iter().map(|e| e.id.clone()));
                let now = a.config.engine.clone().unwrap_or_else(|| "auto".into());
                a.config.engine = Some(cycle(&all, &now, d));
            },
            "auto: the first signed-in CLI, else pi with an API key · :engine picks it from anywhere",
        ),
        Item::info(
            "Agents",
            "Model for new agents",
            |a| {
                let e = a.new_agent_engine();
                a.config.engine_options(e).and_then(|o| o.model.clone()).unwrap_or_else(|| format!("default ({}'s)", crate::engines::engine_name(e)))
            },
            ":model in an agent changes just that agent",
        ),
        Item::change(
            "Agents",
            "Effort for new agents",
            |a| a.config.engine_options(a.new_agent_engine()).and_then(|o| o.effort.clone()).unwrap_or_else(|| "default".into()),
            |a, d| {
                let e = a.new_agent_engine().to_string();
                let mut all = vec!["default".to_string()];
                all.extend(crate::engines::efforts(&e).iter().map(|s| s.to_string()));
                let now = a.config.engine_options(&e).and_then(|o| o.effort.clone()).unwrap_or_else(|| "default".into());
                let next = cycle(&all, &now, d);
                if a.config.engine_options(&e).is_none() {
                    a.config.engines.push((e.clone(), Default::default()));
                }
                if let Some((_, o)) = a.config.engines.iter_mut().find(|(k, _)| *k == e) {
                    o.effort = if next == "default" { None } else { Some(next) };
                }
            },
            "reasoning effort (pi: thinking level) · :effort in an agent changes just that agent",
        ),
        Item::change("Agents", "A worktree for each agent", |a| on_off(a.config.worktree.enabled), |a, _| a.config.worktree.enabled = !a.config.worktree.enabled, "off: agents work in this checkout"),
        Item::change(
            "Agents",
            "Worktree storage",
            |a| {
                match a.config.worktree.backend.as_str() {
                    "riftri" => "lightweight only",
                    "git" => "plain git",
                    _ => "auto (lightweight when it can)",
                }
                .into()
            },
            |a, d| a.config.worktree.backend = cycle(&strs(&["auto", "riftri", "git"]), &a.config.worktree.backend, d),
            "lightweight: copy-on-write worktrees that share unchanged files, so each agent costs almost no disk",
        ),
        Item::change(
            "Agents",
            "Notify when an agent finishes",
            |a| {
                match a.config.ui.notify.as_str() {
                    "auto" => "auto (bell, and a desktop notification where the terminal shows one)",
                    "bell" => "bell",
                    "desktop" => "desktop notification",
                    _ => "off",
                }
                .into()
            },
            |a, d| a.config.ui.notify = cycle(&strs(&NOTIFY_MODES), &a.config.ui.notify, d),
            "when an agent finishes, fails or needs you while you're looking at another one (or another window)",
        ),
        Item::change("Keys", "which-key popup", |a| on_off(a.config.ui.whichkey), |a, _| a.config.ui.whichkey = !a.config.ui.whichkey, "after <leader> (or any key that starts mappings), show what each next key does"),
        Item {
            bind: Some(Box::new(|a: &mut App, keys: &[String]| {
                if keys.len() != 1 {
                    return "the leader is one key".into();
                }
                a.keymap.leader = keys[0].clone();
                format!("leader is now {} (mappings written with <leader> use it from the next start)", keys[0])
            })),
            ..Item::base("Keys", "Leader key", Box::new(|a: &App| keys::parse_keys(&a.keymap.leader, keys::DEFAULT_LEADER).map(|k| k.concat()).unwrap_or_else(|_| a.keymap.leader.clone())), "Enter, then press the key <leader> should mean")
        },
    ];
    // every NORMAL-mode mapping, one row per thing it does
    let mut groups: Vec<(String, String)> = vec![];
    for b in app.keymap.bindings(KeyMode::Normal) {
        if matches!(b.rhs.as_slice(), [keys::Rhs::Nop]) {
            continue;
        }
        if matches!(b.rhs.as_slice(), [keys::Rhs::Action { name, .. }] if name == "session.goto") {
            continue;
        }
        if !groups.iter().any(|(r, _)| *r == b.rhs_text) {
            groups.push((b.rhs_text.clone(), crate::help::rhs_label(&b.rhs)));
        }
    }
    for (rhs_text, label) in groups {
        let mut cap = label.clone();
        if let Some(first) = cap.get(0..1) {
            cap = first.to_uppercase() + &cap[1..];
        }
        let shown = rhs_text.clone();
        let bound = rhs_text.clone();
        items.push(Item {
            bind: Some(Box::new(move |a: &mut App, keys: &[String]| bind_key(a, &bound, &label, keys))),
            ..Item::base(
                "Keys (NORMAL mode)",
                &cap,
                Box::new(move |a: &App| {
                    let k: Vec<String> = a.keymap.bindings(KeyMode::Normal).into_iter().filter(|b| b.rhs_text == shown).map(|b| b.keys.concat()).collect();
                    if k.is_empty() { "(none)".into() } else { k.join("  ") }
                }),
                "Enter, then the new keys (they replace these)",
            )
        });
    }
    app.cfg.panel = Some(Panel::new("Settings", items, 96, save));
}

fn bind_key(a: &mut App, rhs_text: &str, label: &str, keys: &[String]) -> String {
    let lhs = keys.concat();
    let Ok(parsed) = keys::parse_keys(&lhs, &a.keymap.leader) else { return format!("'{lhs}' isn't a key") };
    let taken = a.keymap.lookup(KeyMode::Normal, &parsed, false).exact;
    let old: Vec<String> = a.keymap.bindings(KeyMode::Normal).into_iter().filter(|b| b.rhs_text == rhs_text).map(|b| b.keys.concat()).collect();
    for o in old {
        a.keymap.unset(KeyMode::Normal, &o);
        set_key_change(a, &o, None);
    }
    if let Err(e) = a.keymap.set(KeyMode::Normal, &lhs, &RhsValue::Str(rhs_text.into())) {
        return e;
    }
    set_key_change(a, &lhs, Some(rhs_text.into()));
    let was = match taken {
        Some(t) if t.rhs_text != rhs_text => format!(" (was: {})", crate::help::rhs_label(&t.rhs)),
        _ => String::new(),
    };
    format!("{} now: {label}{was} · w saves it", parsed.concat())
}

fn set_key_change(a: &mut App, lhs: &str, rhs: Option<String>) {
    a.cfg.key_changes.retain(|(k, _)| k != lhs);
    a.cfg.key_changes.push((lhs.to_string(), rhs));
}

/// Write what :settings changed into config.toml, keeping everything else in the file as it is.
pub fn save(app: &mut App) -> String {
    use crate::config_edit::{set_toml_value, toml_str};
    let file = config::config_path();
    let mut text = crate::permissions::config_text(&file);
    let ui = &app.config.ui;
    let b = |v: bool| v.to_string();
    let mut set = |section: Option<&str>, key: &str, value: String| text = set_toml_value(&text, section, key, &value);
    set(None, "theme", toml_str(&app.theme.name));
    set(None, "engine", toml_str(app.config.engine.as_deref().unwrap_or("auto")));
    set(None, "leader", toml_str(&app.keymap.leader));
    set(Some("ui"), "sidebar", b(ui.sidebar));
    set(Some("ui"), "sidebar_width", ui.sidebar_width.to_string());
    set(Some("ui"), "sidebar_position", toml_str(&ui.sidebar_position));
    set(Some("ui"), "number", b(ui.number));
    set(Some("ui"), "tilde", b(ui.tilde));
    set(Some("ui"), "icons", toml_str(&ui.icons));
    set(Some("ui"), "termguicolors", b(ui.termguicolors));
    set(
        Some("ui"),
        "transparent",
        match ui.transparent {
            Transparent::Auto => toml_str("auto"),
            Transparent::On => "true".into(),
            Transparent::Off => "false".into(),
        },
    );
    set(Some("ui"), "whichkey", b(ui.whichkey));
    set(Some("ui"), "notify", toml_str(&ui.notify));
    let st = &app.config.style;
    for (k, v) in [("sidebar", &st.sidebar), ("messages", &st.messages), ("separators", &st.separators)] {
        if let Some(v) = v {
            set(Some("style"), k, toml_str(v));
        }
    }
    set(Some("worktree"), "enabled", b(app.config.worktree.enabled));
    set(Some("worktree"), "backend", toml_str(&app.config.worktree.backend));
    for (lhs, rhs) in &app.cfg.key_changes {
        set(Some("keys.normal"), lhs, rhs.as_deref().map(toml_str).unwrap_or_else(|| "false".into()));
    }
    let r = file.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::write(&file, &text));
    match r {
        Ok(()) => format!("saved to {}", short_path(&file)),
        Err(e) => format!("couldn't save: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_truncation() {
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/b/c/d")).as_deref(), Some("c/d"));
        assert_eq!(relative(Path::new("/a/b"), Path::new("/a/x")).as_deref(), Some("../x"));
        assert_eq!(truncate("abcdef", 4, "…"), "abc…");
        assert_eq!(truncate("abc", 4, "…"), "abc");
    }

    #[test]
    fn the_settings_panel_changes_options_in_place() {
        let mut a = crate::app::tests::app();
        open(&mut a);
        let p = a.cfg.panel.as_mut().unwrap();
        assert!(p.select("Sidebar side"));
        feed(&mut a, "<CR>");
        assert_eq!(a.config.ui.sidebar_position, "right");
        feed(&mut a, "j");
        feed(&mut a, "l");
        assert_eq!(crate::style::resolve(&a).sidebar, "cards");
        let p = a.cfg.panel.as_mut().unwrap();
        assert!(p.select("Sidebar width"));
        feed(&mut a, "h");
        assert_eq!(a.config.ui.sidebar_width, 28);
        feed(&mut a, "q");
        assert!(a.cfg.panel.is_none());
    }

    #[test]
    fn settings_like_the_typescript_test() {
        let mut a = crate::app::tests::app();
        open(&mut a);
        let text = a.cfg.panel.as_ref().unwrap().text(&a);
        assert!(text.contains("Engine for new agents") && text.contains("auto (Claude Code)"), "{text}");
        a.cfg.panel.as_mut().unwrap().select("Transparent background");
        feed(&mut a, "l");
        assert_eq!(a.config.ui.transparent, Transparent::On);
        assert_eq!(a.theme.attr("Normal").bg.as_deref(), Some("NONE"), "applied at once");
        a.cfg.panel.as_mut().unwrap().select("Engine for new agents");
        feed(&mut a, "<CR>");
        feed(&mut a, "l");
        feed(&mut a, "l");
        assert_eq!(a.config.engine.as_deref(), Some("codex"));
        a.cfg.panel.as_mut().unwrap().select("Worktree storage");
        feed(&mut a, "h");
        assert_eq!(a.config.worktree.backend, "git");
        // rebind: the dashboard moves from <Space>D to gd
        let p = a.cfg.panel.take().unwrap();
        let dash = p.items.iter().position(|i| (i.value)(&a).contains("<Space>D")).unwrap();
        a.cfg.panel = Some(p);
        a.cfg.panel.as_mut().unwrap().index = dash;
        feed(&mut a, "<CR>");
        feed(&mut a, "g");
        feed(&mut a, "d");
        feed(&mut a, "<CR>");
        let msg = a.cfg.panel.as_ref().unwrap().message.clone();
        assert!(msg.starts_with("gd now: ") && msg.ends_with("· w saves it"), "{msg}");
        assert_eq!(a.keymap.lookup(KeyMode::Normal, &["g".into(), "d".into()], false).exact.unwrap().rhs_text, ":dash<CR>");
        assert!(a.keymap.lookup(KeyMode::Normal, &["<Space>".into(), "D".into()], false).exact.is_none());
        assert!(a.cfg.key_changes.contains(&("<Space>D".to_string(), None)));
        // Esc cancels a capture
        feed(&mut a, "<CR>");
        feed(&mut a, "x");
        feed(&mut a, "<Esc>");
        assert!(a.keymap.lookup(KeyMode::Normal, &["x".into()], false).exact.is_none());
        assert_eq!(a.cfg.panel.as_ref().unwrap().message, "cancelled");
    }
}
