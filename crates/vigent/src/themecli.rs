//! `vigent theme list | path | new | import` (src/cli.ts themeCommand,
//! src/theme-new.ts).

use crate::theme::{self, extract_palette};

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

pub fn command(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("list") => {
            for t in theme::list() {
                if theme::is_builtin(&t) {
                    println!("{t}  (built-in)");
                } else {
                    println!("{t}");
                }
            }
            0
        }
        Some("path") => {
            println!("themes: {}", theme::themes_dir().display());
            println!("config: {}", crate::config::config_path().display());
            0
        }
        Some("new") => new(&args[1..]),
        Some("import") => import(&args[1..]),
        _ => {
            eprintln!("usage: vigent theme list | import [name|file] | new <name> | path");
            1
        }
    }
}

fn new(args: &[String]) -> i32 {
    let Some(name) = args.first().filter(|n| !n.starts_with('-')) else {
        eprintln!("usage: vigent theme new <name> [--from <theme>] [--palette] [--transparent | --no-transparent]");
        return 1;
    };
    let from = flag(args, "--from").unwrap_or("default");
    // fail early on a typo
    if let Err(e) = theme::load_def(from) {
        eprintln!("vigent: {e}");
        return 1;
    }
    let file = theme::themes_dir().join(format!("{name}.toml"));
    if file.exists() {
        eprintln!("{} already exists", file.display());
        return 1;
    }
    let transparent = if args.iter().any(|a| a == "--transparent") {
        Some(true)
    } else if args.iter().any(|a| a == "--no-transparent") {
        Some(false)
    } else {
        None
    };
    let text = match template(name, from, args.iter().any(|a| a == "--palette"), transparent) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("vigent: {e}");
            return 1;
        }
    };
    if let Err(e) = std::fs::create_dir_all(theme::themes_dir()).and_then(|_| std::fs::write(&file, text)) {
        eprintln!("vigent: {e}");
        return 1;
    }
    println!("created {}", file.display());
    println!("use it with: vigent --theme {name}  (or :colorscheme {name})");
    0
}

/// A commented theme file: start from a theme, and recolor it from a palette pre-filled with that theme's colors.
pub fn template(name: &str, from: &str, palette: bool, transparent: Option<bool>) -> Result<String, String> {
    let base = theme::load_def(from)?;
    let p = extract_palette(&base);
    let transparent = transparent.unwrap_or(base.transparent);
    let get = |k: &str| p.get(k).unwrap_or_default().to_string();
    let row = |key: &str, note: &str| {
        let kv = format!("{key} = \"{}\"", get(key));
        let note = if note.is_empty() { String::new() } else { format!("# {note}") };
        format!("{}{kv:<24}{note}", if palette { "" } else { "# " }).trim_end().to_string()
    };
    let head = if palette { format!("# made from {from}'s colors") } else { format!("\n# Start from any built-in or installed theme, then change what you like.\nextends = \"{from}\"") };
    let what = if palette { "The whole theme comes from these colors" } else { "Uncomment [palette] to recolor the whole theme from these colors" };
    let rows = [
        row("bg", "background"),
        row("fg", "text"),
        row("red", ""),
        row("yellow", ""),
        row("green", ""),
        row("cyan", ""),
        row("blue", ""),
        row("magenta", ""),
        row("bg_dark", "sidebar, floats"),
        row("bg_alt", "cursorline, statusline"),
        row("selection", "visual selection"),
        row("muted", "comments"),
        row("subtle", "line numbers, separators"),
        row("orange", ""),
        row("accent", "current line number"),
    ]
    .join("\n");
    Ok(format!(
        "# {name}: a vigent theme. Edit, then :colorscheme {name} to see it (the picker previews live).
# Docs: https://github.com/farming-labs/vigent/blob/main/docs/themes.md
name = \"{name}\"
{head}

# Draw on the terminal's own background (its blur, opacity or wallpaper shows
# through). Selections, the cursorline and mode badges keep their colors.
transparent = {transparent}

# {what}
# ({from}'s, read from its highlight groups). Only bg, fg and the six accents
# are required; leave out the rest and vigent derives them.
{}[palette]
{rows}

# Any highlight group, by its Neovim name: a table, a :hi string, or a group to link to.
# These win over extends and [palette]. Tweak live with :hi, then :theme save {name}!
[groups]
# Normal = {{ fg = \"{fg}\", bg = \"{bg}\" }}
# Comment = \"guifg={muted} gui=italic\"
# VigentSidebar = {{ bg = \"{bg_dark}\" }}
# VigentModeNormal = {{ fg = \"{bg}\", bg = \"{blue}\", bold = true }}
# VigentModeInsert = {{ fg = \"{bg}\", bg = \"{green}\", bold = true }}
# FloatBorder = {{ fg = \"{blue}\" }}
# CursorLineNr = \"Title\"
",
        if palette { "" } else { "# " },
        fg = get("fg"),
        bg = get("bg"),
        muted = get("muted"),
        bg_dark = get("bg_dark"),
        blue = get("blue"),
        green = get("green"),
    ))
}

fn import(rest: &[String]) -> i32 {
    let positional: Vec<&String> = rest.iter().enumerate().filter(|(i, a)| !a.starts_with("--") && (*i == 0 || rest[i - 1] != "--as") && *a != "as").map(|(_, a)| a).collect();
    let legacy_as = rest.iter().position(|a| a == "as").and_then(|i| rest.get(i + 1)).cloned();
    let has = |f: &str| rest.iter().any(|a| a == f);
    let opts = crate::import::ImportOptions {
        source: positional.first().map(|s| s.to_string()),
        as_name: flag(rest, "--as").map(String::from).or(legacy_as),
        editor: if has("--vim") {
            Some("vim".into())
        } else if has("--nvim") {
            Some("nvim".into())
        } else {
            None
        },
        background: if has("--light") {
            Some("light".into())
        } else if has("--dark") {
            Some("dark".into())
        } else {
            None
        },
        clean: has("--clean"),
        out_dir: None,
    };
    match crate::import::import_theme(&opts) {
        Ok(r) => {
            println!("imported '{}' ({} highlight groups, via {})", r.name, r.groups, r.via);
            println!("  -> {}", r.file.display());
            println!("use it with: vigent --theme {}  (or :colorscheme {})", r.name, r.name);
            0
        }
        Err(e) => {
            eprintln!("vigent: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_new_theme_file_loads() {
        let text = super::template("mine", "gruvbox", false, None).unwrap();
        assert!(text.contains("extends = \"gruvbox\"\n"));
        assert!(text.contains("# bg = \"#282828\"          # background\n"), "{text}");
        let spec = crate::toml::parse(&text).unwrap();
        let def = crate::theme::build(&spec, "mine", &mut vec![]).unwrap();
        assert_eq!(def.name, "mine");
        let pal = super::template("p", "nord", true, Some(true)).unwrap();
        let def = crate::theme::build(&crate::toml::parse(&pal).unwrap(), "p", &mut vec![]).unwrap();
        assert!(def.transparent, "an empty [groups] drops the palette, as in TypeScript");
    }
}
