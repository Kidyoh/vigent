//! The page `:serve` shows on your phone (src/serve-page.ts): one
//! self-contained HTML file in the colors of the theme vigent is using. No
//! external scripts, styles or fonts.
//!
//! page.html is servePage's output with each color and the project name
//! left as a @@placeholder@@ (written from dist/serve-page.js).

use ratatui::style::Color;

use crate::theme::Theme;

const PAGE: &str = include_str!("page.html");

/// The colors the page uses (src/palette.ts Palette, every optional one filled in).
#[derive(Debug, Clone, PartialEq)]
pub struct Palette {
    pub bg: String,
    pub fg: String,
    pub red: String,
    pub yellow: String,
    pub green: String,
    pub cyan: String,
    pub blue: String,
    pub magenta: String,
    pub bg_dark: String,
    pub bg_alt: String,
    pub selection: String,
    pub muted: String,
    pub subtle: String,
    pub orange: String,
    pub accent: String,
}

/// The xterm 256-color palette, as RGB (a theme shown in 256 colors).
fn indexed(n: u8) -> (u8, u8, u8) {
    const BASE: [(u8, u8, u8); 16] = [
        (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
        (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
    ];
    match n {
        0..=15 => BASE[n as usize],
        16..=231 => {
            let i = n - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
            (level(i / 36), level(i / 6 % 6), level(i % 6))
        }
        _ => {
            let g = 8 + (n - 232) * 10;
            (g, g, g)
        }
    }
}

fn hex(c: Option<Color>) -> Option<String> {
    let (r, g, b) = match c? {
        Color::Rgb(r, g, b) => (r, g, b),
        Color::Indexed(n) => indexed(n),
        _ => return None,
    };
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

/// nvim-style fallback links, as far as the page's groups need them (src/theme.ts LINKS).
const LINKS: &[(&str, &str)] = &[
    ("NormalFloat", "Pmenu"),
    ("CursorLineNr", "LineNr"),
    ("LineNr", "NonText"),
    ("Directory", "Identifier"),
    ("Function", "Identifier"),
    ("Keyword", "Statement"),
    ("Title", "Normal"),
    ("Added", "DiffAdd"),
    ("Removed", "DiffDelete"),
    ("NeoTreeNormal", "NvimTreeNormal"),
    ("VigentSidebar", "NeoTreeNormal"),
];

fn rgb(h: &str) -> Option<(f64, f64, f64)> {
    let v = u32::from_str_radix(h.strip_prefix('#')?, 16).ok()?;
    Some(((v >> 16 & 0xff) as f64, (v >> 8 & 0xff) as f64, (v & 0xff) as f64))
}

/// Blend a toward black by t (src/color.ts mix), lighter themes less (isLight).
fn shade(h: &str) -> Option<String> {
    let (r, g, b) = rgb(h)?;
    let lin = |v: f64| {
        let s = v / 255.0;
        if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    let light = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.35;
    let t = if light { 0.05 } else { 0.22 };
    let c = |v: f64| (v + (0.0 - v) * t).round().clamp(0.0, 255.0) as u8;
    Some(format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b)))
}

/// A group resolved as the TypeScript Painter does: its own colors, else
/// through the fallback links, ending at Normal: (fg, bg, reverse).
fn resolve(theme: &Theme, group: &str) -> (Option<String>, Option<String>, bool) {
    let normal = theme.group("Normal").unwrap_or_default();
    let normal_bg = hex(theme.normal_bg);
    let mut g = Some(group);
    let mut seen = vec![];
    while let Some(name) = g {
        if seen.contains(&name) {
            break;
        }
        seen.push(name);
        if name == "Normal" {
            break;
        }
        if let Some(s) = theme.group(name)
            && (s.fg.is_some() || s.bg.is_some() || !s.add_modifier.is_empty())
        {
            return (hex(s.fg), hex(s.bg), s.add_modifier.contains(ratatui::style::Modifier::REVERSED));
        }
        // the last link of the sidebar chain: Normal's background, shaded
        if name == "NvimTreeNormal"
            && let Some(bg) = normal_bg.as_deref().and_then(shade)
        {
            return (hex(normal.fg), Some(bg), false);
        }
        g = LINKS.iter().find(|(from, _)| *from == name).map(|(_, to)| *to);
    }
    (hex(normal.fg), normal_bg, false)
}

/// The built-in themes' palettes, as src/theme.ts extractPalette gives them
/// (a theme made from a palette keeps it; its groups may say otherwise).
/// Written from the TypeScript: for each of dist/theme.js BUILTIN_THEMES, its
/// name and extractPalette's bg fg red yellow green cyan blue magenta bg_dark
/// bg_alt selection muted subtle orange accent.
const BUILTIN: &str = include_str!("palettes.txt");

impl Palette {
    /// The palette of the theme vigent is using (src/theme.ts extractPalette).
    pub fn of(theme: &Theme) -> Palette {
        Palette::builtin(&theme.name).unwrap_or_else(|| Palette::extract(theme))
    }

    /// A built-in theme's palette.
    pub fn builtin(name: &str) -> Option<Palette> {
        let line = BUILTIN.lines().find(|l| l.split(' ').next() == Some(name))?;
        let f: Vec<String> = line.split(' ').skip(1).map(str::to_string).collect();
        let [bg, fg, red, yellow, green, cyan, blue, magenta, bg_dark, bg_alt, selection, muted, subtle, orange, accent] = <[String; 15]>::try_from(f).ok()?;
        Some(Palette { bg, fg, red, yellow, green, cyan, blue, magenta, bg_dark, bg_alt, selection, muted, subtle, orange, accent })
    }

    /// The palette read back from a theme's groups, as the TypeScript does for a theme without one.
    pub fn extract(theme: &Theme) -> Palette {
        let normal_fg = hex(theme.group("Normal").unwrap_or_default().fg);
        let fallback_fg = normal_fg.clone().unwrap_or_else(|| "#c0c0c0".into());
        // a group's foreground (Normal's when it has none, unless it's reversed)
        let fg_of = |g: &str| {
            let (fg, _, reverse) = resolve(theme, g);
            fg.or_else(|| if reverse { None } else { normal_fg.clone() })
        };
        let fg = |groups: &[&str]| groups.iter().find_map(|g| fg_of(g)).unwrap_or_else(|| fallback_fg.clone());
        let base = hex(theme.normal_bg).unwrap_or_else(|| "#1a1b26".into());
        let bg = |groups: &[&str]| groups.iter().find_map(|g| resolve(theme, g).1).unwrap_or_else(|| base.clone());
        Palette {
            bg: base.clone(),
            fg: fg(&["Normal"]),
            red: fg(&["ErrorMsg", "DiagnosticError", "Removed"]),
            yellow: fg(&["WarningMsg", "Type"]),
            green: fg(&["String", "Added"]),
            cyan: fg(&["Special", "Function"]),
            blue: fg(&["Function", "Directory", "Title"]),
            magenta: fg(&["Statement", "Keyword", "Identifier"]),
            bg_dark: bg(&["VigentSidebar", "NormalFloat"]),
            bg_alt: bg(&["CursorLine", "StatusLine"]),
            selection: bg(&["Visual"]),
            muted: fg(&["Comment"]),
            subtle: fg(&["LineNr", "NonText"]),
            orange: fg(&["Constant", "WarningMsg"]),
            accent: fg(&["CursorLineNr", "Title"]),
        }
    }
}

/// &, <, >, " and ' as character references (src/serve-page.ts esc).
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' | '<' | '>' | '"' | '\'' => out.push_str(&format!("&#{};", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The page for a project, in a palette's colors (src/serve-page.ts servePage).
pub fn render(project: &str, p: &Palette) -> String {
    let mut html = PAGE.replace("content=\"@@bg_dark@@\"", &format!("content=\"{}\"", esc(&p.bg_dark)));
    for (k, v) in [
        ("bg_dark", &p.bg_dark),
        ("bg_alt", &p.bg_alt),
        ("bg", &p.bg),
        ("fg", &p.fg),
        ("red", &p.red),
        ("yellow", &p.yellow),
        ("green", &p.green),
        ("cyan", &p.cyan),
        ("blue", &p.blue),
        ("magenta", &p.magenta),
        ("selection", &p.selection),
        ("muted", &p.muted),
        ("subtle", &p.subtle),
        ("accent", &p.accent),
    ] {
        html = html.replace(&format!("@@{k}@@"), v);
    }
    let json = serde_json::to_string(project).unwrap_or_else(|_| "\"\"".into());
    html.replace("@@PJSON@@", &json).replace("@@P@@", &esc(project))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_in_the_themes_colors() {
        let t = crate::theme::load("lazyvim").unwrap();
        let p = Palette::of(&t);
        // lazyvim is transparent: the page still has its background
        assert_eq!(p.bg, "#222436");
        let html = render("shop", &p);
        assert!(html.contains("<title>vigent · shop</title>"));
        assert!(html.contains(&format!("--bg: {};", p.bg)));
        assert!(html.contains("project: \"shop\""));
        assert!(!html.contains("@@"));
        assert_eq!(esc("<a & 'b'>"), "&#60;a &#38; &#39;b&#39;&#62;");
        assert_eq!(indexed(196), (255, 0, 0));
    }

    #[test]
    fn every_builtin_theme_has_its_palette_and_others_are_read_from_their_groups() {
        for name in crate::theme::names() {
            let t = crate::theme::load(name).unwrap();
            assert_eq!(Some(Palette::of(&t)), Palette::builtin(name), "{name}");
        }
        // the 256-color fallback would round the colors
        let default = crate::theme::load("default").unwrap();
        if default.group("Normal").and_then(|s| s.fg).is_some_and(|c| !matches!(c, Color::Rgb(..))) {
            return;
        }
        // default has no palette of its own: the TypeScript reads it from the groups too (links, Normal's fg)
        assert_eq!(Some(Palette::extract(&default)), Palette::builtin("default"));
        // the sidebar's link chain ends shading Normal's background
        let lazy = crate::theme::load("lazyvim").unwrap();
        assert_eq!(Palette::extract(&lazy).bg, "#222436");
        assert_eq!(shade("#222436").as_deref(), Some("#1b1c2a"));
    }
}
