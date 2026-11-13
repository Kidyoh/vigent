//! The theme engine (src/theme.ts, src/palette.ts): themes keyed by Neovim
//! highlight group names, so any vim/nvim colorscheme maps on directly.
//!
//! A group is resolved in this order:
//!   1. your overrides (config [highlights] and live `:hi`) and the theme's own
//!      definition, following `link`s
//!   2. colors derived from the theme for vigent's own groups it doesn't
//!      define (mode badges, the sidebar background)
//!   3. vim-style fallback links, ending at Normal
//!
//! A group with no foreground uses Normal's, like nvim. The built-in themes are
//! themes.txt (written from src/builtin-themes.ts by scripts/export-themes.mjs);
//! yours are files in ~/.config/vigent/themes (.toml, .json or .vim).

use ratatui::style::{Color, Modifier, Style};
use std::path::{Path, PathBuf};

use crate::color::{is_light, mix, nearest256, parse_hex};
use crate::config::{StyleSpec, Transparent, Val};

const THEMES: &str = include_str!("themes.txt");

/// A highlight group's attributes. Colors are "#rrggbb", or "NONE" for the terminal's own.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attr {
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub reverse: Option<bool>,
    /// follow another group instead, like `:hi link`
    pub link: Option<String>,
}

impl Attr {
    /// Anything but a link set.
    pub fn has_style(&self) -> bool {
        self.fg.is_some() || self.bg.is_some() || self.bold.is_some() || self.italic.is_some() || self.underline.is_some() || self.reverse.is_some()
    }
    /// `{ ...self, ...o }`
    pub fn merge(&mut self, o: &Attr) {
        macro_rules! m {
            ($($f:ident),*) => { $( if o.$f.is_some() { self.$f = o.$f.clone(); } )* };
        }
        m!(fg, bg, bold, italic, underline, reverse, link);
    }
    pub fn fg(c: &str) -> Attr {
        Attr { fg: Some(c.into()), ..Default::default() }
    }
}

/// The palette a theme can be built from (src/palette.ts). The first eight are required.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Palette(pub Vec<(String, String)>);

pub const PALETTE_KEYS: [&str; 15] = ["bg", "fg", "red", "yellow", "green", "cyan", "blue", "magenta", "bg_dark", "bg_alt", "selection", "muted", "subtle", "orange", "accent"];
const PALETTE_REQUIRED: [&str; 8] = ["bg", "fg", "red", "yellow", "green", "cyan", "blue", "magenta"];

impl Palette {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    fn req(&self, k: &str) -> String {
        self.get(k).unwrap_or("#808080").to_string()
    }
}

/// A theme as defined: groups, background, transparency, palette, style.
#[derive(Clone, Debug, Default)]
pub struct ThemeDef {
    pub name: String,
    pub background: Option<String>,
    pub groups: Vec<(String, Attr)>,
    pub transparent: bool,
    pub palette: Option<Palette>,
    pub style: Option<StyleSpec>,
}

impl ThemeDef {
    pub fn group(&self, g: &str) -> Option<&Attr> {
        self.groups.iter().find(|(n, _)| n == g).map(|(_, a)| a)
    }
    fn set(&mut self, g: &str, a: Attr) {
        match self.groups.iter_mut().find(|(n, _)| n == g) {
            Some(slot) => slot.1 = a,
            None => self.groups.push((g.to_string(), a)),
        }
    }
}

/// Groups that paint a background behind text. A transparent theme drops their
/// background so the terminal's shows through; selections, the cursorline,
/// popup menus and mode badges keep theirs.
pub const TRANSPARENT_GROUPS: [&str; 18] = [
    "Normal", "NormalNC", "NormalFloat", "FloatBorder", "FloatTitle", "MsgArea", "StatusLine", "StatusLineNC", "WinBar", "WinBarNC", "WinSeparator", "LineNr", "CursorLineNr", "SignColumn", "EndOfBuffer", "VigentSidebar", "NeoTreeNormal", "NvimTreeNormal",
];

/// Fallback links, mirroring how nvim links its default groups.
const LINKS: &[(&str, &str)] = &[
    ("NormalNC", "Normal"),
    ("NormalFloat", "Pmenu"),
    ("FloatBorder", "NormalFloat"),
    ("FloatTitle", "Title"),
    ("WinSeparator", "VertSplit"),
    ("VertSplit", "NonText"),
    ("EndOfBuffer", "NonText"),
    ("CursorLineNr", "LineNr"),
    ("LineNr", "NonText"),
    ("StatusLineNC", "StatusLine"),
    ("WinBar", "Title"),
    ("TabLine", "StatusLineNC"),
    ("TabLineSel", "StatusLine"),
    ("Directory", "Identifier"),
    ("Function", "Identifier"),
    ("Keyword", "Statement"),
    ("Title", "Normal"),
    ("MsgArea", "Normal"),
    ("PmenuSel", "Visual"),
    ("CurSearch", "Search"),
    ("IncSearch", "Search"),
    ("Added", "DiffAdd"),
    ("Removed", "DiffDelete"),
    ("Changed", "DiffChange"),
    ("NeoTreeNormal", "NvimTreeNormal"),
    ("NeoTreeIndentMarker", "NvimTreeIndentMarker"),
    ("NvimTreeIndentMarker", "NonText"),
    ("VigentSidebar", "NeoTreeNormal"),
    ("VigentIndent", "NeoTreeIndentMarker"),
    ("VigentUser", "Title"),
    ("VigentMention", "Directory"),
    ("VigentTool", "Function"),
    ("VigentToolOutput", "Comment"),
    ("VigentSpinner", "WarningMsg"),
    ("VigentCode", "String"),
    ("Question", "MoreMsg"),
    ("MoreMsg", "String"),
];

fn link_of(g: &str) -> Option<&'static str> {
    LINKS.iter().find(|(a, _)| *a == g).map(|(_, b)| *b)
}

/// The theme on screen: a definition plus your overrides, drawn with the
/// options now (24-bit color or 256, transparency). What src/theme.ts calls a Painter.
#[derive(Clone)]
pub struct Theme {
    pub name: String,
    pub def: ThemeDef,
    /// [highlights] and :hi
    pub overrides: Vec<(String, Attr)>,
    /// :set transparent / notransparent; Auto follows the theme
    pub transparency: Transparent,
    /// 24-bit color, else the nearest of 256 ('termguicolors')
    pub truecolor: bool,
}

/// Every built-in theme's name: default first, then the rest in order.
pub fn names() -> Vec<&'static str> {
    let mut all: Vec<&str> = THEMES.lines().filter_map(|l| l.strip_prefix("theme ")).filter_map(|l| l.split(' ').next()).collect();
    all.sort_by_key(|n| (*n != "default", *n));
    all
}

pub fn is_builtin(name: &str) -> bool {
    THEMES.lines().any(|l| l.strip_prefix("theme ").and_then(|l| l.split(' ').next()) == Some(name))
}

fn truecolor() -> bool {
    std::env::var("TERM_PROGRAM").map(|p| p != "Apple_Terminal").unwrap_or(true)
}

fn json_to_val(v: &serde_json::Value) -> Val {
    use serde_json::Value as J;
    match v {
        J::String(s) => Val::Str(s.clone()),
        J::Bool(b) => Val::Bool(*b),
        J::Number(n) => n.as_i64().map(Val::Int).unwrap_or_else(|| Val::Float(n.as_f64().unwrap_or(0.0))),
        J::Array(a) => Val::Arr(a.iter().map(json_to_val).collect()),
        J::Object(o) => Val::Table(o.iter().map(|(k, v)| (k.clone(), json_to_val(v))).collect()),
        J::Null => Val::Other("null".into()),
    }
}

fn builtin(name: &str) -> Option<ThemeDef> {
    let mut lines = THEMES.lines().skip_while(|l| l.strip_prefix("theme ").and_then(|l| l.split(' ').next()) != Some(name));
    let head = lines.next()?;
    let f: Vec<&str> = head.split(' ').collect();
    let mut def = ThemeDef { name: name.into(), background: f.get(2).map(|s| s.to_string()), transparent: head.ends_with(" transparent"), ..Default::default() };
    for l in lines.take_while(|l| !l.starts_with("theme ")) {
        if let Some(json) = l.strip_prefix("@palette ") {
            if let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(json) {
                def.palette = Some(Palette(o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()));
            }
            continue;
        }
        if let Some(json) = l.strip_prefix("@style ") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
                let mut spec = StyleSpec::default();
                crate::config::parse_style(&json_to_val(&v), "theme", &mut spec, &mut vec![]);
                def.style = Some(spec);
            }
            continue;
        }
        let f: Vec<&str> = l.split(' ').collect();
        if f.len() != 4 {
            continue;
        }
        let c = |s: &str| if s == "-" { None } else { Some(s.to_string()) };
        let flag = |ch: char| if f[3].contains(ch) { Some(true) } else { None };
        let a = Attr { fg: c(f[1]), bg: c(f[2]), bold: flag('b'), italic: flag('i'), underline: flag('u'), reverse: flag('r'), link: None };
        // a group that only links (themes.txt can't say where) falls back to vim's own link
        if a.has_style() {
            def.groups.push((f[0].to_string(), a));
        }
    }
    Some(def)
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

pub fn themes_dir() -> PathBuf {
    crate::config::config_dir().join("themes")
}

const THEME_EXTS: [&str; 3] = [".toml", ".json", ".vim"];
const SPEC_KEYS: [&str; 8] = ["name", "background", "extends", "transparent", "palette", "groups", "highlights", "style"];

/// Every theme: the built-ins and yours, default first, then by name.
pub fn list() -> Vec<String> {
    let mut all: Vec<String> = names().into_iter().map(String::from).collect();
    if let Ok(rd) = std::fs::read_dir(themes_dir()) {
        for e in rd.flatten() {
            let f = e.file_name().to_string_lossy().to_string();
            if let Some(ext) = THEME_EXTS.iter().find(|x| f.ends_with(*x)) {
                let n = f[..f.len() - ext.len()].to_string();
                if !all.contains(&n) {
                    all.push(n);
                }
            }
        }
    }
    all.sort_by(|a, b| match (a == "default", b == "default") {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)),
    });
    all
}

fn find_file(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') || THEME_EXTS.iter().any(|e| name.ends_with(e)) {
        let p = match name.strip_prefix("~/") {
            Some(rest) => std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(rest),
            None => PathBuf::from(name),
        };
        let p = std::path::absolute(&p).unwrap_or(p);
        return p.exists().then_some(p);
    }
    THEME_EXTS.iter().map(|e| themes_dir().join(format!("{name}{e}"))).find(|p| p.exists())
}

/// "did you mean"
fn did_you_mean(word: &str, names: &[String]) -> String {
    crate::suggest::did_you_mean(word, names.iter().map(String::as_str))
}

/// Group values as users write them: a table, a vim :hi string, or a group name to link to.
pub fn normalize_groups(input: &[(String, Val)]) -> Vec<(String, Attr)> {
    let mut out = vec![];
    for (group, value) in input {
        match value {
            Val::Str(s) => {
                let lower = s.to_lowercase();
                let attr_word = ["bold", "italic", "underline", "reverse", "none"].iter().any(|a| lower.starts_with(a) && lower[a.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_'));
                if s.contains('=') || attr_word {
                    if let Some(crate::vimcolors::HiCommand::Set { attr, .. }) = crate::vimcolors::parse_highlight_command(&format!("{group} {s}")) {
                        out.push((group.clone(), attr));
                    }
                } else {
                    out.push((group.clone(), Attr { link: Some(s.clone()), ..Default::default() }));
                }
            }
            Val::Table(_) => {
                let s = |k: &str| value.get(k).and_then(Val::as_str).map(str::to_string);
                let b = |k: &str| if let Some(Val::Bool(b)) = value.get(k) { Some(*b) } else { None };
                out.push((group.clone(), Attr { fg: s("fg"), bg: s("bg"), link: s("link"), bold: b("bold"), italic: b("italic"), underline: b("underline"), reverse: b("reverse") }));
            }
            _ => {}
        }
    }
    out
}

fn read_spec(file: &Path) -> Result<Vec<(String, Val)>, String> {
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let name = file.to_string_lossy();
    let raw = if name.ends_with(".toml") {
        crate::toml::parse(&text).map_err(|e| format!("{}: {e}", file.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default()))?
    } else {
        match serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())? {
            serde_json::Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), json_to_val(v))).collect(),
            _ => return Err(format!("{name}: a theme file is a table")),
        }
    };
    if !raw.iter().any(|(k, _)| SPEC_KEYS.contains(&k.as_str())) {
        return Ok(vec![("groups".into(), Val::Table(raw))]);
    }
    Ok(raw)
}

/// Load a built-in theme, a theme file from ~/.config/vigent/themes, or a path.
pub fn load_def(name: &str) -> Result<ThemeDef, String> {
    load_def_seen(name, &mut vec![])
}

fn load_def_seen(name: &str, seen: &mut Vec<String>) -> Result<ThemeDef, String> {
    if let Some(d) = builtin(name) {
        return Ok(d);
    }
    let Some(file) = find_file(name) else { return Err(format!("E185: Cannot find color scheme '{name}'{}", did_you_mean(name, &list()))) };
    let base = file.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let fallback = THEME_EXTS.iter().find_map(|e| base.strip_suffix(e)).unwrap_or(&base).to_string();
    if file.to_string_lossy().ends_with(".vim") {
        let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let p = crate::vimcolors::parse_vim_colorscheme(&text, None);
        return Ok(ThemeDef { name: p.name.unwrap_or(fallback), background: Some(p.background), groups: p.groups, ..Default::default() });
    }
    build(&read_spec(&file)?, &fallback, seen)
}

/// A theme from a spec (a theme file's table): extends, palette, groups, style.
pub fn build(spec: &[(String, Val)], fallback: &str, seen: &mut Vec<String>) -> Result<ThemeDef, String> {
    let get = |k: &str| spec.iter().find(|(n, _)| n == k).map(|(_, v)| v);
    let name = get("name").and_then(Val::as_str).unwrap_or(fallback).to_string();
    let mut def = ThemeDef { name: name.clone(), background: get("background").and_then(Val::as_str).map(str::to_string), ..Default::default() };
    let own_transparent = match get("transparent") {
        Some(Val::Bool(b)) => Some(*b),
        _ => None,
    };
    let mut transparent = own_transparent;
    if let Some(ext) = get("extends").and_then(Val::as_str) {
        if seen.iter().any(|s| s == ext) {
            return Err(format!("theme '{name}' extends itself through '{ext}'"));
        }
        seen.push(name.clone());
        let base = load_def_seen(ext, seen)?;
        def.groups = base.groups;
        def.background = def.background.or(base.background);
        transparent = transparent.or(Some(base.transparent));
        def.palette = base.palette;
        def.style = base.style;
    }
    if let Some(st) = get("style") {
        let mut own = StyleSpec::default();
        crate::config::parse_style(st, &format!("theme '{name}'"), &mut own, &mut vec![]);
        let mut s = def.style.take().unwrap_or_default();
        crate::style::layer(&mut s, &own);
        def.style = Some(s);
    }
    if let Some(p) = get("palette").and_then(Val::as_table) {
        let pal = Palette(p.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect());
        let missing: Vec<&str> = PALETTE_REQUIRED.iter().copied().filter(|k| pal.get(k).is_none_or(str::is_empty)).collect();
        if !missing.is_empty() {
            return Err(format!("theme '{name}': palette is missing {}", missing.join(", ")));
        }
        let t = from_palette(&name, &pal);
        for (g, a) in t.groups {
            def.set(&g, a);
        }
        def.background = def.background.or(t.background);
        def.palette = t.palette;
    }
    let groups = get("groups").and_then(Val::as_table).map(normalize_groups).unwrap_or_default();
    let highlights = get("highlights").and_then(Val::as_table).map(normalize_groups).unwrap_or_default();
    // groups set after the palette may have changed its colors; only keep it when they didn't
    if get("groups").is_some() || get("highlights").is_some() {
        def.palette = None;
    }
    for (g, a) in groups.into_iter().chain(highlights) {
        def.set(&g, a);
    }
    def.transparent = transparent.unwrap_or(false);
    Ok(def)
}

/// A full theme from a small palette (src/palette.ts fromPalette).
pub fn from_palette(name: &str, p: &Palette) -> ThemeDef {
    let (bg, fg) = (p.req("bg"), p.req("fg"));
    let (red, yellow, green, cyan, blue, magenta) = (p.req("red"), p.req("yellow"), p.req("green"), p.req("cyan"), p.req("blue"), p.req("magenta"));
    let light = is_light(Some(&bg));
    let or = |k: &str, d: String| p.get(k).map(str::to_string).unwrap_or(d);
    let bg_dark = or("bg_dark", mix(&bg, "#000000", if light { 0.05 } else { 0.22 }));
    let bg_alt = or("bg_alt", mix(&bg, &fg, 0.08));
    let selection = or("selection", mix(&bg, &blue, 0.28));
    let muted = or("muted", mix(&bg, &fg, 0.45));
    let subtle = or("subtle", mix(&bg, &fg, 0.25));
    let orange = or("orange", yellow.clone());
    let accent = or("accent", yellow.clone());
    let a = |fg: Option<&str>, bg: Option<&str>| Attr { fg: fg.map(String::from), bg: bg.map(String::from), ..Default::default() };
    let bold = |mut x: Attr| {
        x.bold = Some(true);
        x
    };
    let italic = |mut x: Attr| {
        x.italic = Some(true);
        x
    };
    let badge = |c: &str| bold(a(Some(&bg), Some(c)));
    let groups: Vec<(&str, Attr)> = vec![
        ("Normal", a(Some(&fg), Some(&bg))),
        ("NormalFloat", a(Some(&fg), Some(&bg_dark))),
        ("FloatBorder", a(Some(&subtle), Some(&bg_dark))),
        ("FloatTitle", bold(a(Some(&blue), Some(&bg_dark)))),
        ("WinSeparator", a(Some(&subtle), None)),
        ("StatusLine", a(Some(&fg), Some(&bg_alt))),
        ("StatusLineNC", a(Some(&muted), Some(&bg_dark))),
        ("WinBar", bold(a(Some(&fg), None))),
        ("CursorLine", a(None, Some(&bg_alt))),
        ("CursorLineNr", bold(a(Some(&accent), None))),
        ("LineNr", a(Some(&subtle), None)),
        ("Visual", a(None, Some(&selection))),
        ("Comment", italic(a(Some(&muted), None))),
        ("NonText", a(Some(&subtle), None)),
        ("Title", bold(a(Some(&blue), None))),
        ("Directory", a(Some(&blue), None)),
        ("Identifier", a(Some(&magenta), None)),
        ("Function", a(Some(&blue), None)),
        ("String", a(Some(&green), None)),
        ("Constant", a(Some(&orange), None)),
        ("Keyword", a(Some(&magenta), None)),
        ("Statement", a(Some(&magenta), None)),
        ("Type", a(Some(&yellow), None)),
        ("Special", a(Some(&cyan), None)),
        ("Search", a(Some(&bg), Some(&yellow))),
        ("CurSearch", a(Some(&bg), Some(&orange))),
        ("DiffAdd", a(None, Some(&mix(&bg, &green, 0.2)))),
        ("DiffDelete", a(None, Some(&mix(&bg, &red, 0.2)))),
        ("DiffChange", a(None, Some(&mix(&bg, &blue, 0.15)))),
        ("Added", a(Some(&green), None)),
        ("Removed", a(Some(&red), None)),
        ("Changed", a(Some(&blue), None)),
        ("ErrorMsg", a(Some(&red), None)),
        ("WarningMsg", a(Some(&yellow), None)),
        ("ModeMsg", bold(a(Some(&fg), None))),
        ("MoreMsg", a(Some(&green), None)),
        ("Pmenu", a(Some(&fg), Some(&bg_alt))),
        ("PmenuSel", bold(a(None, Some(&selection)))),
        ("VigentSidebar", a(Some(&fg), Some(&bg_dark))),
        ("VigentIndent", a(Some(&subtle), None)),
        ("VigentModeNormal", badge(&blue)),
        ("VigentModeInsert", badge(&green)),
        ("VigentModeVisual", badge(&magenta)),
        ("VigentModeCommand", badge(&yellow)),
        ("VigentUser", bold(a(Some(&blue), None))),
        ("VigentTool", a(Some(&cyan), None)),
        ("VigentToolOutput", a(Some(&muted), None)),
        ("VigentSpinner", a(Some(&orange), None)),
    ];
    let mut pal = vec![];
    for k in PALETTE_KEYS {
        let v = match k {
            "bg_dark" => bg_dark.clone(),
            "bg_alt" => bg_alt.clone(),
            "selection" => selection.clone(),
            "muted" => muted.clone(),
            "subtle" => subtle.clone(),
            "orange" => orange.clone(),
            "accent" => accent.clone(),
            k => p.req(k),
        };
        pal.push((k.to_string(), v));
    }
    ThemeDef {
        name: name.into(),
        background: Some(if light { "light" } else { "dark" }.into()),
        groups: groups.into_iter().map(|(g, a)| (g.to_string(), a)).collect(),
        transparent: false,
        palette: Some(Palette(pal)),
        style: None,
    }
}

/// The palette a theme's colors come from, read back from its groups (for `vigent theme new`).
pub fn extract_palette(def: &ThemeDef) -> Palette {
    if let Some(p) = &def.palette {
        return p.clone();
    }
    let t = Theme { name: def.name.clone(), def: def.clone(), overrides: vec![], transparency: Transparent::Off, truecolor: true };
    let fg = |groups: &[&str]| -> String {
        for g in groups {
            if let Some(c) = t.attr(g).fg.filter(|c| parse_hex(c).is_some()) {
                return c;
            }
        }
        t.attr("Normal").fg.unwrap_or_else(|| "#c0c0c0".into())
    };
    let bg = |fallback: &str, groups: &[&str]| -> String {
        for g in groups {
            if let Some(c) = t.attr(g).bg.filter(|c| parse_hex(c).is_some()) {
                return c;
            }
        }
        fallback.into()
    };
    let base = bg("#1a1b26", &["Normal"]);
    Palette(vec![
        ("bg".into(), base.clone()),
        ("fg".into(), fg(&["Normal"])),
        ("red".into(), fg(&["ErrorMsg", "DiagnosticError", "Removed"])),
        ("yellow".into(), fg(&["WarningMsg", "Type"])),
        ("green".into(), fg(&["String", "Added"])),
        ("cyan".into(), fg(&["Special", "Function"])),
        ("blue".into(), fg(&["Function", "Directory", "Title"])),
        ("magenta".into(), fg(&["Statement", "Keyword", "Identifier"])),
        ("bg_dark".into(), bg(&base, &["VigentSidebar", "NormalFloat"])),
        ("bg_alt".into(), bg(&base, &["CursorLine", "StatusLine"])),
        ("selection".into(), bg(&base, &["Visual"])),
        ("muted".into(), fg(&["Comment"])),
        ("subtle".into(), fg(&["LineNr", "NonText"])),
        ("orange".into(), fg(&["Constant", "WarningMsg"])),
        ("accent".into(), fg(&["CursorLineNr", "Title"])),
    ])
}

/// A theme as ratatui draws it.
pub fn load(name: &str) -> Option<Theme> {
    load_def(name).ok().map(Theme::new)
}

impl Theme {
    pub fn new(def: ThemeDef) -> Theme {
        Theme { name: def.name.clone(), def, overrides: vec![], transparency: Transparent::Auto, truecolor: truecolor() }
    }

    /// Another theme, keeping your overrides and options (src/theme.ts setTheme).
    pub fn set_def(&mut self, def: ThemeDef) {
        self.name = def.name.clone();
        self.def = def;
    }

    /// Is the terminal's background showing through right now?
    pub fn transparent(&self) -> bool {
        match self.transparency {
            Transparent::Auto => self.def.transparent,
            Transparent::On => true,
            Transparent::Off => false,
        }
    }

    /// Theme definition with your overrides merged on top.
    fn explicit(&self, group: &str) -> Option<Attr> {
        let t = self.def.group(group);
        let Some(o) = self.overrides.iter().find(|(g, _)| g == group).map(|(_, a)| a) else { return t.cloned() };
        if o.link.is_some() {
            return Some(Attr { link: o.link.clone(), ..Default::default() });
        }
        let mut base = t.filter(|a| a.link.is_none()).cloned().unwrap_or_default();
        base.merge(o);
        Some(base)
    }

    pub fn normal_attr(&self) -> Attr {
        self.explicit("Normal").filter(|n| n.link.is_none()).unwrap_or_default()
    }

    /// Colors computed from the theme when it doesn't define a group itself.
    fn derived(&self, group: &str) -> Option<Attr> {
        match group {
            "VigentModeNormal" => self.badge(&["Function", "Directory", "Identifier"]),
            "VigentModeInsert" => self.badge(&["String", "MoreMsg", "Added"]),
            "VigentModeVisual" => self.badge(&["Statement", "Constant", "Special"]),
            "VigentModeCommand" => self.badge(&["WarningMsg", "Type", "Todo"]),
            "NvimTreeNormal" => {
                let n = self.normal_attr();
                let bg = n.bg.filter(|b| parse_hex(b).is_some())?;
                Some(Attr { fg: n.fg, bg: Some(mix(&bg, "#000000", if is_light(Some(&bg)) { 0.05 } else { 0.22 })), ..Default::default() })
            }
            _ => None,
        }
    }

    /// A group, without filling in Normal's foreground.
    fn resolve(&self, group: &str) -> Attr {
        let mut seen: Vec<String> = vec![];
        let mut g = Some(group.to_string());
        while let Some(name) = g {
            if seen.contains(&name) {
                break;
            }
            seen.push(name.clone());
            let e = self.explicit(&name);
            if let Some(l) = e.as_ref().and_then(|e| e.link.clone()) {
                g = Some(l);
                continue;
            }
            if let Some(e) = e.filter(Attr::has_style) {
                return e;
            }
            if let Some(d) = self.derived(&name) {
                return d;
            }
            g = link_of(&name).map(String::from);
        }
        self.normal_attr()
    }

    /// A mode badge colored from the first candidate group with a usable foreground.
    fn badge(&self, candidates: &[&str]) -> Option<Attr> {
        let n = self.normal_attr();
        for c in candidates {
            let Some(color) = self.resolve(c).fg.filter(|f| parse_hex(f).is_some()) else { continue };
            if Some(&color) == n.fg.as_ref() {
                continue;
            }
            let text = match n.bg.as_deref().filter(|b| parse_hex(b).is_some()) {
                Some(b) => b.to_string(),
                None if is_light(Some(&color)) => "#111111".into(),
                None => "#eeeeee".into(),
            };
            return Some(Attr { fg: Some(text), bg: Some(color), bold: Some(true), ..Default::default() });
        }
        let s = self.resolve("StatusLine");
        if s.has_style() {
            return Some(Attr { bold: Some(true), ..s });
        }
        None
    }

    /// A group's attributes as drawn (Normal's foreground filled in, transparency applied).
    pub fn attr(&self, group: &str) -> Attr {
        let mut a = self.resolve(group);
        a.link = None;
        if group != "Normal" && a.fg.is_none() && a.reverse != Some(true) {
            a.fg = self.normal_attr().fg;
        }
        if self.transparent()
            && let Some(bg) = a.bg.clone()
            && bg != "NONE"
        {
            let nbg = self.normal_attr().bg;
            if TRANSPARENT_GROUPS.contains(&group) || nbg.is_some_and(|n| n.eq_ignore_ascii_case(&bg)) {
                a.bg = Some("NONE".into());
            }
        }
        a
    }

    fn color(&self, c: &Option<String>) -> Option<Color> {
        let c = c.as_deref()?;
        if c == "NONE" {
            return Some(Color::Reset);
        }
        let rgb = parse_hex(c)?;
        Some(if self.truecolor { Color::Rgb(rgb[0], rgb[1], rgb[2]) } else { Color::Indexed(nearest256(c)) })
    }

    /// A ratatui style from attributes.
    pub fn style_of(&self, a: &Attr) -> Style {
        let mut s = Style::default();
        if let Some(c) = self.color(&a.fg) {
            s = s.fg(c);
        }
        if let Some(c) = self.color(&a.bg) {
            s = s.bg(c);
        }
        for (f, m) in [(a.bold, Modifier::BOLD), (a.italic, Modifier::ITALIC), (a.underline, Modifier::UNDERLINED), (a.reverse, Modifier::REVERSED)] {
            if f == Some(true) {
                s = s.add_modifier(m);
            }
        }
        s
    }

    /// A group the theme (or your overrides) sets itself, with its own colors
    /// (a link is followed); None: it doesn't set it (the :serve page's colors).
    pub fn group(&self, group: &str) -> Option<Style> {
        let a = self.explicit(group)?;
        Some(if a.link.is_some() { self.style_of(&self.resolve(group)) } else { self.style_of(&a) })
    }

    /// Normal's background as the theme sets it, even when a transparent theme doesn't paint it (the :serve page).
    pub fn normal_bg(&self) -> Option<Color> {
        self.color(&self.normal_attr().bg).filter(|c| *c != Color::Reset)
    }

    /// A highlight group's style.
    pub fn hl(&self, group: &str) -> Style {
        self.style_of(&self.attr(group))
    }
    pub fn normal(&self) -> Style {
        self.hl("Normal")
    }
    /// Only the foreground (and bold/italic) of a group, over whatever is below.
    pub fn fg(&self, group: &str) -> Style {
        let s = self.hl(group);
        Style { bg: None, ..s }
    }

    /// `:hi Group ...`: merge into the group, like vim.
    pub fn highlight(&mut self, group: &str, attr: &Attr) {
        match self.overrides.iter_mut().find(|(g, _)| g == group) {
            Some(slot) if slot.1.link.is_none() => slot.1.merge(attr),
            Some(slot) => slot.1 = attr.clone(),
            None => self.overrides.push((group.to_string(), attr.clone())),
        }
    }
    /// `:hi link From To`
    pub fn link(&mut self, from: &str, to: &str) {
        self.overrides.retain(|(g, _)| g != from);
        self.overrides.push((from.to_string(), Attr { link: Some(to.into()), ..Default::default() }));
    }
    /// `:hi clear [Group]`: back to the theme's colors.
    pub fn clear(&mut self, group: Option<&str>) {
        match group {
            Some(g) => self.overrides.retain(|(n, _)| n != g),
            None => self.overrides.clear(),
        }
    }
}

/// A theme file (TOML) for `:theme save`: what's on screen, as small as it can be.
pub fn theme_file_for(name: &str, t: &Theme, builtin_base: bool) -> String {
    let mut lines = vec![format!("# {name}: saved from vigent with :theme save. Edit freely; reload with :colorscheme {name}"), format!("name = \"{name}\"")];
    let mut groups: Vec<(String, Attr)> = if builtin_base { vec![] } else { t.def.groups.clone() };
    for (g, a) in &t.overrides {
        groups.retain(|(n, _)| n != g);
        groups.push((g.clone(), a.clone()));
    }
    if builtin_base {
        lines.push(format!("extends = \"{}\"", t.def.name));
    } else if let Some(b) = &t.def.background {
        lines.push(format!("background = \"{b}\""));
    }
    if t.transparent() != (builtin_base && t.def.transparent) || (!builtin_base && t.transparent()) {
        lines.push(format!("transparent = {}", t.transparent()));
    }
    lines.push(String::new());
    lines.push("[groups]".into());
    groups.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then(a.0.cmp(&b.0)));
    for (g, a) in groups {
        lines.push(format!("{} = {}", crate::config_edit::toml_key(&g), toml_attr(&a)));
    }
    format!("{}\n", lines.join("\n"))
}

fn toml_attr(a: &Attr) -> String {
    if let Some(l) = &a.link {
        return crate::config_edit::toml_str(l);
    }
    let mut parts = vec![];
    for (k, v) in [("fg", &a.fg), ("bg", &a.bg)] {
        if let Some(v) = v {
            parts.push(format!("{k} = {}", crate::config_edit::toml_str(v)));
        }
    }
    for (k, v) in [("bold", a.bold), ("italic", a.italic), ("underline", a.underline), ("reverse", a.reverse)] {
        if let Some(v) = v {
            parts.push(format!("{k} = {v}"));
        }
    }
    format!("{{ {} }}", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_theme_loads() {
        let names = names();
        assert_eq!(names[0], "default");
        assert!(names.contains(&"lazyvim") && names.contains(&"tokyonight-moon") && names.len() >= 28);
        for n in names {
            assert!(load(n).unwrap().def.group("Normal").is_some(), "{n}");
        }
        assert!(load_def("neon").unwrap().style.unwrap().sidebar.as_deref() == Some("cards"));
        assert!(load_def("tokyonight").unwrap().palette.is_some());
    }

    #[test]
    fn groups_resolve_through_links_and_overrides() {
        let mut t = load("gruvbox").unwrap();
        // NormalFloat isn't in gruvbox: Pmenu, then Normal
        assert_eq!(t.attr("FloatBorder").fg, t.attr("Normal").fg);
        assert!(t.attr("VigentModeNormal").bold == Some(true), "a derived badge");
        t.highlight("Comment", &Attr::fg("#ff0000"));
        assert_eq!(t.attr("Comment").fg.as_deref(), Some("#ff0000"));
        assert_eq!(t.attr("Comment").italic, Some(true), "merged over the theme's");
        t.link("Title", "Comment");
        assert_eq!(t.attr("Title").fg.as_deref(), Some("#ff0000"));
        t.clear(None);
        assert_ne!(t.attr("Comment").fg.as_deref(), Some("#ff0000"));
        t.transparency = Transparent::On;
        assert_eq!(t.attr("Normal").bg.as_deref(), Some("NONE"));
        assert_eq!(t.hl("Normal").bg, Some(Color::Reset));
    }

    #[test]
    fn lazyvim_is_tokyonight_moon_on_the_terminal_background() {
        let p = load("lazyvim").unwrap();
        assert!(p.transparent());
        for g in ["Normal", "NormalFloat", "StatusLine", "VigentSidebar", "WinBar"] {
            assert!(matches!(p.attr(g).bg.as_deref(), None | Some("NONE")), "{g}: {:?}", p.attr(g).bg);
        }
        assert_eq!(p.attr("Normal").fg.as_deref(), Some("#c8d3f5"));
        assert_eq!(p.attr("FloatBorder").fg.as_deref(), Some("#589ed7"));
        assert_eq!(p.attr("CursorLineNr").fg.as_deref(), Some("#ff966c"));
        assert_eq!(p.attr("Visual"), Attr { bg: Some("#2d3f76".into()), fg: Some("#c8d3f5".into()), ..Default::default() });
        assert_eq!(p.attr("CursorLine").bg.as_deref(), Some("#2f334d"));
        assert_eq!(p.attr("VigentModeNormal"), Attr { fg: Some("#1b1d2b".into()), bg: Some("#82aaff".into()), bold: Some(true), ..Default::default() });
        assert_eq!(p.attr("PmenuSel").bg.as_deref(), Some("#363c58"));
        let moon = load("tokyonight-moon").unwrap();
        assert_eq!(moon.attr("Normal").bg.as_deref(), Some("#222436"));
        assert_eq!(moon.attr("VigentSidebar").bg.as_deref(), Some("#1e2030"));
        assert_eq!(extract_palette(&load_def("lazyvim").unwrap()), extract_palette(&load_def("tokyonight-moon").unwrap()));
        let mut lazy = load("lazyvim").unwrap();
        lazy.transparency = Transparent::Off;
        assert_eq!(lazy.attr("Normal").bg.as_deref(), Some("#222436"));
    }

    #[test]
    fn palettes_and_specs() {
        let spec = crate::toml::parse("name = \"x\"\nextends = \"nord\"\ntransparent = true\n[groups]\nComment = \"guifg=#123456 gui=bold\"\nTitle = \"Comment\"\n").unwrap();
        let d = build(&spec, "x", &mut vec![]).unwrap();
        assert!(d.transparent);
        assert_eq!(d.group("Comment").unwrap().fg.as_deref(), Some("#123456"));
        assert_eq!(d.group("Title").unwrap().link.as_deref(), Some("Comment"));
        let bad = crate::toml::parse("[palette]\nbg = \"#000000\"\n").unwrap();
        assert!(build(&bad, "y", &mut vec![]).unwrap_err().contains("palette is missing fg, red"));
        let p = extract_palette(&load_def("gruvbox").unwrap());
        assert_eq!(p.get("bg"), Some("#282828"));
        assert!(load_def("nope-theme").unwrap_err().starts_with("E185: Cannot find color scheme 'nope-theme'"));
    }
}
