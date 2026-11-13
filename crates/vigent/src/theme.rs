//! The built-in themes, the same ones as the TypeScript vigent: themes.txt is
//! written from src/builtin-themes.ts by scripts/export-themes.mjs.

use ratatui::style::{Color, Modifier, Style};
use std::collections::HashMap;

const THEMES: &str = include_str!("themes.txt");

pub struct Theme {
    pub name: String,
    groups: HashMap<String, Style>,
    /// Normal's background as the theme sets it, even when a transparent theme doesn't paint it (the :serve page)
    pub normal_bg: Option<Color>,
}

/// Every built-in theme's name: default first, then the rest in order (as `vigent theme list` prints them).
pub fn names() -> Vec<&'static str> {
    let mut all: Vec<&str> = THEMES.lines().filter_map(|l| l.strip_prefix("theme ")).filter_map(|l| l.split(' ').next()).collect();
    all.sort_by_key(|n| (*n != "default", *n));
    all
}

fn truecolor() -> bool {
    let ct = std::env::var("COLORTERM").unwrap_or_default();
    if ct == "truecolor" || ct == "24bit" {
        return true;
    }
    // Apple's Terminal shows 256 colors; most others take truecolor
    std::env::var("TERM_PROGRAM").map(|p| p != "Apple_Terminal").unwrap_or(true)
}

/// The nearest of the 256 xterm colors.
fn to_256(r: u8, g: u8, b: u8) -> u8 {
    let level = |v: u8| if v < 48 { 0 } else if v < 115 { 1 } else { (v - 35) / 40 };
    let (lr, lg, lb) = (level(r), level(g), level(b));
    let cube = 16 + 36 * lr + 6 * lg + lb;
    let gray = ((r as u16 + g as u16 + b as u16) / 3) as u8;
    if lr == lg && lg == lb && gray > 8 && gray < 238 { 232 + (gray - 8) / 10 } else { cube }
}

fn color(hex: &str, tc: bool) -> Option<Color> {
    let h = hex.strip_prefix('#')?;
    let v = u32::from_str_radix(h, 16).ok()?;
    let (r, g, b) = ((v >> 16) as u8, (v >> 8) as u8, v as u8);
    Some(if tc { Color::Rgb(r, g, b) } else { Color::Indexed(to_256(r, g, b)) })
}

pub fn load(name: &str) -> Option<Theme> {
    let tc = truecolor();
    let mut lines = THEMES.lines().skip_while(|l| !l.starts_with(&format!("theme {name} ")));
    let head = lines.next()?;
    let transparent = head.ends_with(" transparent");
    let mut groups = HashMap::new();
    let mut normal_bg = None;
    for l in lines.take_while(|l| !l.starts_with("theme ")) {
        let f: Vec<&str> = l.split(' ').collect();
        if f.len() != 4 {
            continue;
        }
        let mut s = Style::default();
        if let Some(c) = color(f[1], tc) {
            s = s.fg(c);
        }
        if let Some(c) = color(f[2], tc) {
            if f[0] == "Normal" {
                normal_bg = Some(c);
            }
            if !(transparent && f[0] == "Normal") {
                s = s.bg(c);
            }
        }
        for (flag, m) in [('b', Modifier::BOLD), ('i', Modifier::ITALIC), ('u', Modifier::UNDERLINED), ('r', Modifier::REVERSED)] {
            if f[3].contains(flag) {
                s = s.add_modifier(m);
            }
        }
        groups.insert(f[0].to_string(), s);
    }
    Some(Theme { name: name.to_string(), groups, normal_bg })
}

impl Theme {
    /// A highlight group, Normal's when the theme doesn't set it.
    pub fn hl(&self, group: &str) -> Style {
        self.groups.get(group).copied().unwrap_or_else(|| self.normal())
    }
    /// A group the theme sets (None: it doesn't).
    pub fn group(&self, group: &str) -> Option<Style> {
        self.groups.get(group).copied()
    }
    pub fn normal(&self) -> Style {
        self.groups.get("Normal").copied().unwrap_or_default()
    }
    /// Only the foreground (and bold/italic) of a group, over whatever is below.
    pub fn fg(&self, group: &str) -> Style {
        let s = self.hl(group);
        Style { bg: None, ..s }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_builtin_theme_loads() {
        let names = super::names();
        assert_eq!(names[0], "default");
        assert!(names.contains(&"lazyvim") && names.contains(&"tokyonight-moon") && names.len() >= 28);
        for n in names {
            assert!(super::load(n).unwrap().groups.contains_key("Normal"), "{n}");
        }
        assert_eq!(super::to_256(255, 0, 0), 196);
    }
}
