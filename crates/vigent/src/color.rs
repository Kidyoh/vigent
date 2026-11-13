//! Color helpers: hex math, the xterm-256 palette, and vim color names (src/color.ts).

pub type Rgb = [u8; 3];

pub fn parse_hex(hex: &str) -> Option<Rgb> {
    let h = hex.trim();
    let h = h.strip_prefix('#').unwrap_or(h);
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(h, 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

pub fn to_hex(c: [f64; 3]) -> String {
    let h = |v: f64| v.clamp(0.0, 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", h(c[0]), h(c[1]), h(c[2]))
}

/// Blend a toward b by t (0..1). Returns a unchanged if either color is invalid.
pub fn mix(a: &str, b: &str, t: f64) -> String {
    let (Some(x), Some(y)) = (parse_hex(a), parse_hex(b)) else { return a.to_string() };
    let m = |i: usize| x[i] as f64 + (y[i] as f64 - x[i] as f64) * t;
    to_hex([m(0), m(1), m(2)])
}

/// Relative luminance, 0 (black) .. 1 (white).
pub fn luminance(hex: &str) -> f64 {
    let Some(c) = parse_hex(hex) else { return 0.0 };
    let l = |v: u8| {
        let s = v as f64 / 255.0;
        if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2])
}

pub fn is_light(hex: Option<&str>) -> bool {
    hex.is_some_and(|h| luminance(h) > 0.35)
}

const XTERM_16: [&str; 16] = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];

/// An xterm-256 color index as hex.
pub fn xterm256(n: i64) -> Option<String> {
    if !(0..=255).contains(&n) {
        return None;
    }
    let n = n as usize;
    if n < 16 {
        return Some(XTERM_16[n].into());
    }
    if n < 232 {
        let levels = [0.0, 95.0, 135.0, 175.0, 215.0, 255.0];
        let i = n - 16;
        return Some(to_hex([levels[i / 36], levels[(i / 6) % 6], levels[i % 6]]));
    }
    let v = (8 + (n - 232) * 10) as f64;
    Some(to_hex([v, v, v]))
}

const CTERM_NAMES: &[(&str, i64)] = &[
    ("black", 0), ("darkred", 1), ("darkgreen", 2), ("brown", 3), ("darkyellow", 3), ("darkblue", 4), ("darkmagenta", 5), ("darkcyan", 6), ("lightgray", 7), ("lightgrey", 7), ("gray", 7), ("grey", 7), ("darkgray", 8), ("darkgrey", 8),
    ("red", 9), ("lightred", 9), ("green", 10), ("lightgreen", 10), ("yellow", 11), ("lightyellow", 11), ("blue", 12), ("lightblue", 12), ("magenta", 13), ("lightmagenta", 13), ("cyan", 14), ("lightcyan", 14), ("white", 15),
];

const GUI_NAMES: &[(&str, &str)] = &[
    ("black", "#000000"), ("white", "#ffffff"), ("red", "#ff0000"), ("green", "#00ff00"), ("blue", "#0000ff"), ("yellow", "#ffff00"), ("cyan", "#00ffff"), ("magenta", "#ff00ff"), ("gray", "#bebebe"), ("grey", "#bebebe"),
    ("darkgray", "#a9a9a9"), ("darkgrey", "#a9a9a9"), ("lightgray", "#d3d3d3"), ("lightgrey", "#d3d3d3"), ("darkred", "#8b0000"), ("darkgreen", "#006400"), ("darkblue", "#00008b"), ("darkcyan", "#008b8b"),
    ("darkmagenta", "#8b008b"), ("darkyellow", "#bbbb00"), ("brown", "#a52a2a"), ("orange", "#ffa500"), ("purple", "#a020f0"), ("lightblue", "#add8e6"), ("lightgreen", "#90ee90"), ("lightcyan", "#e0ffff"),
    ("lightred", "#ffbbbb"), ("lightmagenta", "#ffbbff"), ("lightyellow", "#ffffe0"), ("seagreen", "#2e8b57"), ("slateblue", "#6a5acd"), ("gold", "#ffd700"), ("khaki", "#f0e68c"), ("navy", "#000080"), ("wheat", "#f5deb3"),
    ("peru", "#cd853f"), ("salmon", "#fa8072"), ("orangered", "#ff4500"), ("skyblue", "#87ceeb"), ("violet", "#ee82ee"), ("tan", "#d2b48c"), ("olive", "#808000"), ("teal", "#008080"), ("maroon", "#800000"),
    ("silver", "#c0c0c0"), ("pink", "#ffc0cb"), ("indianred", "#cd5c5c"), ("steelblue", "#4682b4"), ("darkslategray", "#2f4f4f"), ("darkslategrey", "#2f4f4f"), ("darkolivegreen", "#556b2f"), ("darkorange", "#ff8c00"),
    ("lightslategray", "#778899"), ("midnightblue", "#191970"),
];

/// A vim color value as hex: "#rrggbb", "NONE", a GUI color name, grayN/greyN, or
/// (for cterm) an xterm index or cterm name. None if unknown.
pub fn resolve_vim_color(value: &str, cterm: bool) -> Option<String> {
    let v = value.trim();
    let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
    let v = v.strip_suffix(['"', '\'']).unwrap_or(v);
    let lower = v.to_lowercase();
    if lower == "none" {
        return Some("NONE".into());
    }
    if matches!(lower.as_str(), "fg" | "bg" | "foreground" | "background") {
        return None;
    }
    if parse_hex(v).is_some() {
        return Some(format!("#{}", v.trim_start_matches('#').to_lowercase()));
    }
    let squashed: String = lower.split_whitespace().collect();
    if cterm {
        if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) {
            return xterm256(v.parse().ok()?);
        }
        return CTERM_NAMES.iter().find(|(n, _)| *n == squashed).and_then(|(_, i)| xterm256(*i));
    }
    for p in ["gray", "grey"] {
        if let Some(d) = lower.strip_prefix(p)
            && !d.is_empty()
            && d.len() <= 3
            && d.chars().all(|c| c.is_ascii_digit())
        {
            let n = (d.parse::<f64>().ok()?.min(100.0) * 255.0 / 100.0).round();
            return Some(to_hex([n, n, n]));
        }
    }
    GUI_NAMES.iter().find(|(n, _)| *n == squashed).map(|(_, h)| h.to_string())
}

/// The xterm-256 index closest to a hex color (6x6x6 cube or grayscale ramp).
pub fn nearest256(hex: &str) -> u8 {
    let Some(c) = parse_hex(hex) else { return 7 };
    let levels = [0i32, 95, 135, 175, 215, 255];
    let idx = |v: u8| {
        let mut best = 0;
        for i in 1..6 {
            if (levels[i] - v as i32).abs() < (levels[best] - v as i32).abs() {
                best = i;
            }
        }
        best
    };
    let (r, g, b) = (idx(c[0]), idx(c[1]), idx(c[2]));
    let cube = 16 + 36 * r + 6 * g + b;
    let cube_rgb = [levels[r], levels[g], levels[b]];
    let avg = (c[0] as f64 + c[1] as f64 + c[2] as f64) / 3.0;
    let gray_idx = ((avg - 8.0) / 10.0).round().clamp(0.0, 23.0) as i32;
    let gray_v = 8 + gray_idx * 10;
    let dist = |x: [i32; 3]| (0..3).map(|i| (x[i] - c[i] as i32).pow(2)).sum::<i32>();
    if dist([gray_v, gray_v, gray_v]) < dist(cube_rgb) { (232 + gray_idx) as u8 } else { cube as u8 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors() {
        assert_eq!(mix("#000000", "#ffffff", 0.5), "#808080");
        assert_eq!(mix("nope", "#ffffff", 0.5), "nope");
        assert!(is_light(Some("#eeeeee")) && !is_light(Some("#111111")));
        assert_eq!(resolve_vim_color("DarkBlue", true).as_deref(), Some("#000080"));
        assert_eq!(resolve_vim_color("Gray50", false).as_deref(), Some("#808080"));
        assert_eq!(resolve_vim_color("'#ABCDEF'", false).as_deref(), Some("#abcdef"));
        assert_eq!(resolve_vim_color("none", false).as_deref(), Some("NONE"));
        assert_eq!(xterm256(196).as_deref(), Some("#ff0000"));
        assert_eq!(nearest256("#ff0000"), 196);
        assert_eq!(nearest256("#808080"), 244);
    }
}
