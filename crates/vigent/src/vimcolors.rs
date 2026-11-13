//! Vim `:highlight` syntax (src/vimcolors.ts): one `:hi` command's arguments,
//! and a static reader for `.vim` colorscheme files, so classic vim themes can
//! be imported without vim or nvim installed.

use crate::color::resolve_vim_color;
use crate::theme::Attr;

#[derive(Debug, Clone, PartialEq)]
pub enum HiCommand {
    Set { group: String, attr: Attr, raw: RawHi },
    Link { from: String, to: String },
    Clear { group: Option<String> },
    Show { group: String },
}

/// Raw key/values as vim stores them before gui/cterm preference is applied.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawHi {
    pub guifg: Option<String>,
    pub guibg: Option<String>,
    pub gui: Option<String>,
    pub ctermfg: Option<String>,
    pub ctermbg: Option<String>,
    pub cterm: Option<String>,
}

impl RawHi {
    fn merge(&mut self, o: &RawHi) {
        for (a, b) in [(&mut self.guifg, &o.guifg), (&mut self.guibg, &o.guibg), (&mut self.gui, &o.gui), (&mut self.ctermfg, &o.ctermfg), (&mut self.ctermbg, &o.ctermbg), (&mut self.cterm, &o.cterm)] {
            if b.is_some() {
                *a = b.clone();
            }
        }
    }
    fn has_color(&self) -> bool {
        self.guifg.is_some() || self.guibg.is_some() || self.ctermfg.is_some() || self.ctermbg.is_some()
    }
}

/// Split on whitespace, keeping key='quoted' and key="quoted" values together.
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out = vec![];
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        // key=, then a quoted value
        let mut j = i;
        while j < b.len() && !b[j].is_whitespace() && b[j] != '=' {
            j += 1;
        }
        if j > start && j + 1 < b.len() && b[j] == '=' && (b[j + 1] == '\'' || b[j + 1] == '"') {
            let q = b[j + 1];
            if let Some(close) = b[j + 2..].iter().position(|&c| c == q) {
                let end = j + 2 + close + 1;
                out.push(b[start..end].iter().collect());
                i = end;
                continue;
            }
        }
        while i < b.len() && !b[i].is_whitespace() {
            i += 1;
        }
        out.push(b[start..i].iter().collect());
    }
    out
}

fn apply_attr_list(list: &str, attr: &mut Attr) {
    for word in list.to_lowercase().split(',') {
        match word {
            "none" => {
                attr.bold = Some(false);
                attr.italic = Some(false);
                attr.underline = Some(false);
                attr.reverse = Some(false);
            }
            "bold" => attr.bold = Some(true),
            "italic" => attr.italic = Some(true),
            "underline" | "undercurl" | "underdouble" | "underdotted" | "underdashed" => attr.underline = Some(true),
            "reverse" | "inverse" | "standout" => attr.reverse = Some(true),
            _ => {}
        }
    }
}

/// Raw vim values as an Attr, GUI colors over cterm ones. With keep_off,
/// attributes turned off by `gui=NONE` stay false (an override can switch off a theme's bold).
pub fn raw_to_attr(raw: &RawHi, keep_off: bool) -> Attr {
    let mut attr = Attr::default();
    let fg = raw.guifg.as_deref().and_then(|v| resolve_vim_color(v, false));
    let bg = raw.guibg.as_deref().and_then(|v| resolve_vim_color(v, false));
    attr.fg = fg.or_else(|| raw.ctermfg.as_deref().and_then(|v| resolve_vim_color(v, true)));
    attr.bg = bg.or_else(|| raw.ctermbg.as_deref().and_then(|v| resolve_vim_color(v, true)));
    if let Some(list) = raw.gui.as_deref().or(raw.cterm.as_deref()) {
        apply_attr_list(list, &mut attr);
    }
    if !keep_off {
        for f in [&mut attr.bold, &mut attr.italic, &mut attr.underline, &mut attr.reverse] {
            if *f == Some(false) {
                *f = None;
            }
        }
    }
    attr
}

fn unquote(v: &str) -> &str {
    let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
    v.strip_suffix(['"', '\'']).unwrap_or(v)
}

/// The arguments of a `:highlight` command (everything after `hi`): vim keys
/// (guifg, guibg, gui, ctermfg, ctermbg, cterm), the fg=/bg= shorthands, and bare words like `bold`.
pub fn parse_highlight_command(args: &str) -> Option<HiCommand> {
    let mut tokens = tokenize(args.trim());
    if tokens.first().is_some_and(|t| t == "!") {
        tokens.remove(0);
    }
    if tokens.first().is_some_and(|t| t == "default" || t == "def") {
        tokens.remove(0);
    }
    let first = tokens.first()?.clone();
    if first == "clear" {
        return Some(HiCommand::Clear { group: tokens.get(1).cloned() });
    }
    if first == "link" {
        if tokens.len() < 3 {
            return None;
        }
        return Some(HiCommand::Link { from: tokens[1].clone(), to: tokens[2].clone() });
    }
    if tokens.len() == 1 {
        return Some(HiCommand::Show { group: first });
    }
    let mut raw = RawHi::default();
    let mut extra = Attr::default();
    for tok in &tokens[1..] {
        let Some(eq) = tok.find('=') else {
            apply_attr_list(tok, &mut extra);
            continue;
        };
        let key = tok[..eq].to_lowercase();
        let value = Some(unquote(&tok[eq + 1..]).to_string());
        match key.as_str() {
            "guifg" | "fg" => raw.guifg = value,
            "guibg" | "bg" => raw.guibg = value,
            "gui" => raw.gui = value,
            "ctermfg" => raw.ctermfg = value,
            "ctermbg" => raw.ctermbg = value,
            "cterm" => raw.cterm = value,
            _ => {}
        }
    }
    let mut attr = raw_to_attr(&raw, true);
    attr.merge(&extra);
    Some(HiCommand::Set { group: first, attr, raw })
}

/// An `if` condition: only `&background` checks are understood; anything else is true.
fn eval_condition(cond: &str, background: &str) -> bool {
    let Some(at) = cond.find("&background").map(|i| i + 11).or_else(|| cond.find("&bg").map(|i| i + 3)) else { return true };
    let rest = cond[at..].trim_start();
    let (op, rest) = ["isnot", "is", "==", "!="].iter().find_map(|op| rest.strip_prefix(op).map(|r| (*op, r))).unwrap_or(("", rest));
    if op.is_empty() {
        return true;
    }
    let rest = rest.strip_prefix(['#', '?']).unwrap_or(rest).trim_start();
    let rest = rest.strip_prefix(['\'', '"']).unwrap_or("");
    let value = if rest.starts_with("dark") {
        "dark"
    } else if rest.starts_with("light") {
        "light"
    } else {
        return true;
    };
    let equal = value == background;
    if op == "==" || op == "is" { equal } else { !equal }
}

pub struct ParsedColorscheme {
    pub name: Option<String>,
    pub background: String,
    pub groups: Vec<(String, Attr)>,
}

struct Frame {
    active: bool,
    taken: bool,
    parent_active: bool,
}

fn word_at(line: &str, w: &str) -> bool {
    line.strip_prefix(w).is_some_and(|r| r.chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_'))
}

/// Statically read a `.vim` colorscheme file. Lines built at runtime (exe, functions) are skipped.
pub fn parse_vim_colorscheme(text: &str, background: Option<&str>) -> ParsedColorscheme {
    // join line continuations ("\" at the start of the next line)
    let text = text.replace('\r', "");
    let mut joined: Vec<String> = vec![];
    for l in text.split('\n') {
        match (l.trim_start().strip_prefix('\\'), joined.last_mut()) {
            (Some(rest), Some(prev)) => {
                prev.push(' ');
                prev.push_str(rest);
            }
            _ => joined.push(l.to_string()),
        }
    }
    let set_bg = text.lines().find_map(|l| {
        let t = l.trim_start();
        let r = t.strip_prefix("set")?.trim_start();
        let r = r.strip_prefix("background=").or_else(|| r.strip_prefix("bg="))?;
        if r.starts_with("dark") {
            Some("dark")
        } else if r.starts_with("light") {
            Some("light")
        } else {
            None
        }
    });
    let bg = background.or(set_bg).unwrap_or("dark").to_string();
    let mut raw: Vec<(String, RawHi)> = vec![];
    let mut links: Vec<(String, String)> = vec![];
    let mut stack: Vec<Frame> = vec![];
    let mut name = None;
    for original in &joined {
        let line = original.trim();
        if line.is_empty() || line.starts_with('"') {
            continue;
        }
        let active = stack.last().is_none_or(|f| f.active);
        if let Some(cond) = line.strip_prefix("if ").or_else(|| line.strip_prefix("if\t")) {
            let ok = active && eval_condition(cond, &bg);
            stack.push(Frame { active: ok, taken: ok, parent_active: active });
            continue;
        }
        if let Some(cond) = line.strip_prefix("elseif ") {
            if let Some(f) = stack.last_mut() {
                let ok = f.parent_active && !f.taken && eval_condition(cond, &bg);
                f.active = ok;
                f.taken |= ok;
            }
            continue;
        }
        if word_at(line, "else") {
            if let Some(f) = stack.last_mut() {
                f.active = f.parent_active && !f.taken;
                f.taken = true;
            }
            continue;
        }
        if word_at(line, "endif") {
            stack.pop();
            continue;
        }
        if !active {
            continue;
        }
        if word_at(line, "finish") || word_at(line, "fini") {
            break;
        }
        if let Some(r) = line.strip_prefix("let") {
            let r = r.trim_start();
            if let Some(r) = r.strip_prefix("g:colors_name") {
                let r = r.trim_start();
                if let Some(r) = r.strip_prefix('=') {
                    let r = r.trim_start();
                    if let Some(q) = r.chars().next().filter(|c| *c == '\'' || *c == '"') {
                        let inner = &r[1..];
                        if let Some(end) = inner.find(['\'', '"']) {
                            let _ = q;
                            name = Some(inner[..end].to_string());
                        }
                    }
                }
                continue;
            }
        }
        // hi, hig, ..., highlight, with an optional !
        let Some(rest) = line.strip_prefix("hi") else { continue };
        let word_end = rest.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(rest.len());
        if !"ghlight".starts_with(&rest[..word_end]) {
            continue;
        }
        let rest = &rest[word_end..];
        let rest = rest.strip_prefix('!').unwrap_or(rest);
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        // a trailing "comment
        let mut args = rest.trim().to_string();
        if let Some(q) = args.rfind(" \"").or_else(|| args.rfind("\t\""))
            && !args[q + 2..].contains('"')
        {
            args.truncate(q);
        }
        match parse_highlight_command(&args) {
            Some(HiCommand::Link { from, to }) => {
                links.retain(|(f, _)| *f != from);
                links.push((from, to));
            }
            Some(HiCommand::Set { group, raw: r, .. }) => {
                match raw.iter_mut().find(|(g, _)| *g == group) {
                    Some(slot) => slot.1.merge(&r),
                    None => raw.push((group.clone(), r.clone())),
                }
                // a group with its own colors stops following a link, as in vim
                if r.has_color() {
                    links.retain(|(f, _)| *f != group);
                }
            }
            _ => {}
        }
    }
    let mut groups: Vec<(String, Attr)> = vec![];
    for (g, r) in &raw {
        let a = raw_to_attr(r, false);
        if a != Attr::default() {
            groups.push((g.clone(), a));
        }
    }
    for (from, to) in links {
        if !groups.iter().any(|(g, _)| *g == from) {
            groups.push((from, Attr { link: Some(to), ..Default::default() }));
        }
    }
    ParsedColorscheme { name, background: bg, groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hi_commands() {
        let Some(HiCommand::Set { group, attr, .. }) = parse_highlight_command("Normal guifg=#AABBCC guibg=NONE gui=bold,italic") else { panic!() };
        assert_eq!(group, "Normal");
        assert_eq!((attr.fg.as_deref(), attr.bg.as_deref(), attr.bold, attr.italic), (Some("#aabbcc"), Some("NONE"), Some(true), Some(true)));
        assert_eq!(parse_highlight_command("link A B"), Some(HiCommand::Link { from: "A".into(), to: "B".into() }));
        assert_eq!(parse_highlight_command("clear"), Some(HiCommand::Clear { group: None }));
        assert_eq!(parse_highlight_command("Comment"), Some(HiCommand::Show { group: "Comment".into() }));
        assert_eq!(tokenize("X guifg='#fff' gui=NONE"), ["X", "guifg='#fff'", "gui=NONE"]);
    }

    #[test]
    fn vim_files() {
        let text = "set background=dark\nhi clear\nlet g:colors_name = \"mine\"\nif &background == 'light'\n  hi Normal guifg=#000000 guibg=#ffffff\nelse\n  hi Normal guifg=#ffffff guibg=#000000\nendif\nhi Comment ctermfg=8 \" grey\nhi link Title Comment\nhighlight! Visual\n      \\ guibg=#333333\n";
        let p = parse_vim_colorscheme(text, None);
        assert_eq!(p.name.as_deref(), Some("mine"));
        let get = |g: &str| p.groups.iter().find(|(n, _)| n == g).map(|(_, a)| a.clone()).unwrap();
        assert_eq!(get("Normal").bg.as_deref(), Some("#000000"));
        assert_eq!(get("Comment").fg.as_deref(), Some("#808080"));
        assert_eq!(get("Title").link.as_deref(), Some("Comment"));
        assert_eq!(get("Visual").bg.as_deref(), Some("#333333"));
        let light = parse_vim_colorscheme(text, Some("light"));
        assert_eq!(light.groups[0].1.bg.as_deref(), Some("#ffffff"));
    }
}
