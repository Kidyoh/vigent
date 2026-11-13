//! Config area: colors, options, mappings and your own commands
//! (:colorscheme, :hi, :set, :nmap, :unmap, :command, :let, :settings,
//! :permissions, :templates, :trust, :!cmd, and the commands you define).

use super::{Command, Ex};
use crate::app::App;
use crate::keys::{KeyMode, RhsValue};

pub static COMMANDS: &[Command] = &[
    Command { name: "theme", aliases: &["colorscheme", "colo"], also: None, run: theme },
    Command { name: "highlight", aliases: &["hi"], also: None, run: |app, ex| crate::looks::exec_highlight(app, ex.arg) },
    Command { name: "set", aliases: &["se"], also: None, run: |app, ex| crate::looks::exec_set(app, ex.arg) },
    Command { name: "settings", aliases: &["options", "prefs"], also: None, run: |app, _| crate::settings::open(app) },
    Command { name: "permissions", aliases: &["permission", "perms", "perm"], also: None, run: |app, ex| crate::permissions::exec(app, ex.arg) },
    Command { name: "templates", aliases: &["template", "tpl"], also: None, run: |app, ex| crate::templates::exec(app, ex.arg) },
    Command {
        name: "trust",
        aliases: &[],
        also: None,
        run: |app, _| {
            let msg = crate::trust::execute_project_trust(app);
            app.say(msg, "ModeMsg");
        },
    },
    Command { name: "let", aliases: &[], also: None, run: |app, ex| exec_let(app, ex.arg) },
    Command { name: "map", aliases: &[], also: Some(is_map), run: |app, ex| exec_map(app, ex.name, ex.raw) },
    Command { name: "unmap", aliases: &[], also: Some(is_unmap), run: |app, ex| exec_unmap(app, ex.name, ex.arg) },
    Command { name: "command", aliases: &["com"], also: None, run: |app, ex| crate::usercmd::exec_command(app, ex.arg, ex.bang) },
    Command { name: "delcommand", aliases: &["delc"], also: None, run: |app, ex| crate::usercmd::delete(app, ex.arg) },
    Command { name: "!", aliases: &[], also: None, run: |app, ex| crate::usercmd::run_shell(app, ex.arg, None, None) },
    Command { name: "User", aliases: &[], also: Some(crate::usercmd::is_user_name), run: crate::usercmd::run_user },
];

/// `[nicvx]?(nore)?map`: the mode letter
fn map_letter(name: &str) -> Option<&str> {
    let first = name.get(..1).filter(|c| "nicvx".contains(*c));
    [Some(("", name)), first.map(|c| (c, &name[1..]))].into_iter().flatten().find(|(_, rest)| *rest == "map" || *rest == "noremap").map(|(l, _)| l)
}

/// `[nicvx]?unmap`: the mode letter
fn unmap_letter(name: &str) -> Option<&str> {
    let first = name.get(..1).filter(|c| "nicvx".contains(*c));
    [Some(("", name)), first.map(|c| (c, &name[1..]))].into_iter().flatten().find(|(_, rest)| *rest == "unmap").map(|(l, _)| l)
}

fn is_map(name: &str) -> bool {
    map_letter(name).is_some()
}

fn is_unmap(name: &str) -> bool {
    unmap_letter(name).is_some()
}

/// :colorscheme [name], :theme save[!] [name]
fn theme(app: &mut App, ex: &Ex) {
    let cmd = if ex.name.starts_with("theme") { "theme" } else { "colorscheme" };
    // `:theme save!` reaches here as name "theme" with "save!" in the argument
    crate::looks::exec_theme(app, cmd, ex.arg);
}

fn modes(letter: &str) -> Vec<KeyMode> {
    match letter {
        "i" => vec![KeyMode::Insert],
        "c" => vec![KeyMode::Command],
        "x" | "v" => vec![KeyMode::Visual],
        _ => vec![KeyMode::Normal],
    }
}

fn mode_letter(m: KeyMode) -> &'static str {
    match m {
        KeyMode::Normal => "n",
        KeyMode::Insert => "i",
        KeyMode::Visual => "x",
        KeyMode::Command => "c",
    }
}


/// `:map`, `:nmap`, `:inoremap`, ... (all mappings are non-recursive, like noremap).
pub fn exec_map(app: &mut App, name: &str, raw: &str) {
    let ms = modes(map_letter(name).unwrap_or(""));
    let arg = raw.trim_start();
    let (lhs, rhs) = match arg.split_once(char::is_whitespace) {
        Some((l, r)) if !r.trim().is_empty() => (l, Some(r.trim_start())),
        _ => (arg.trim_end(), None),
    };
    if lhs.is_empty() {
        return open_mappings(app, &ms);
    }
    let Some(rhs) = rhs else {
        let mut found = vec![];
        for &m in &ms {
            if let Ok(keys) = crate::keys::parse_keys(lhs, &app.keymap.leader)
                && let Some(b) = app.keymap.lookup(m, &keys, false).exact
            {
                found.push(format!("{}  {}  {}", mode_letter(m), b.keys.concat(), b.rhs_text));
            }
        }
        return if found.is_empty() { app.say("No mapping found", "Comment") } else { app.say(found.join("   "), "Normal") };
    };
    // a mapping keeps its trailing whitespace (":nmap x :new " opens ":new "), like vim
    let rhs = rhs.to_string();
    for m in ms {
        if let Err(e) = app.keymap.set(m, lhs, &RhsValue::Str(rhs.clone())) {
            return app.say(format!("E474: {e}"), "ErrorMsg");
        }
    }
    app.say("", "Normal");
}

/// `:map` with no arguments: your mappings, vim-style.
fn open_mappings(app: &mut App, ms: &[KeyMode]) {
    let mut lines: Vec<(String, &'static str)> = vec![];
    for &m in ms {
        for b in app.keymap.bindings(m).into_iter().filter(|b| b.user) {
            lines.push((format!("{}  {:<14} {}", mode_letter(m), b.keys.concat(), b.rhs_text), "NormalFloat"));
        }
    }
    if lines.is_empty() {
        return app.say("No mapping found", "Comment");
    }
    app.float = Some(crate::ui::floats::Float::new("Mappings", lines));
}

pub fn exec_unmap(app: &mut App, name: &str, arg: &str) {
    let lhs = arg.trim();
    if lhs.is_empty() {
        return app.say("E474: Invalid argument", "ErrorMsg");
    }
    if crate::keys::parse_keys(lhs, &app.keymap.leader).is_err() {
        return app.say(format!("E474: '{lhs}' is not a key"), "ErrorMsg");
    }
    let mut removed = false;
    for m in modes(unmap_letter(name).unwrap_or("")) {
        removed |= app.keymap.unset(m, lhs);
    }
    if !removed {
        app.say("E31: No such mapping", "ErrorMsg");
    }
}

/// `:let mapleader = ","` (affects mappings defined after it, like vim).
pub fn exec_let(app: &mut App, arg: &str) {
    let a = arg.trim();
    let a = a.strip_prefix("g:").unwrap_or(a);
    let parsed = a.strip_prefix("mapleader").map(str::trim_start).and_then(|r| r.strip_prefix('=')).map(str::trim).and_then(|v| {
        let q = v.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let inner = v.strip_prefix(q)?.strip_suffix(q)?;
        Some(inner.to_string())
    });
    let Some(key) = parsed else { return app.say("only  :let mapleader = \"<key>\"  is supported", "Comment") };
    if crate::keys::parse_keys(&key, crate::keys::DEFAULT_LEADER).is_err() {
        return app.say(format!("E474: leader '{key}' is not a key"), "ErrorMsg");
    }
    app.keymap.leader = key;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::exec;

    #[test]
    fn maps_unmaps_and_the_leader() {
        let mut a = crate::app::tests::app();
        exec(&mut a, "nnoremap Q :new ");
        let k = a.keymap.lookup(KeyMode::Normal, &["Q".into()], false).exact.unwrap();
        assert_eq!(k.rhs_text, ":new ");
        exec(&mut a, "nmap Q");
        assert!(a.message.0.contains("n  Q  :new "), "{}", a.message.0);
        exec(&mut a, "imap jk <Esc>");
        assert!(a.keymap.lookup(KeyMode::Insert, &["j".into()], false).prefix);
        exec(&mut a, "nunmap Q");
        assert!(a.keymap.lookup(KeyMode::Normal, &["Q".into()], false).exact.is_none());
        exec(&mut a, "nunmap Q");
        assert_eq!(a.message.0, "E31: No such mapping");
        exec(&mut a, "let mapleader = \",\"");
        assert_eq!(a.keymap.leader, ",");
        exec(&mut a, "let x = 1");
        assert!(a.message.0.starts_with("only  :let mapleader"));
        exec(&mut a, "nmap Z bogus.action");
        assert!(a.message.0.starts_with("E474: "), "{}", a.message.0);
    }

    #[test]
    fn set_and_hi_and_theme() {
        let mut a = crate::app::tests::app();
        exec(&mut a, "set nonumber");
        assert!(!a.config.ui.number);
        exec(&mut a, "colorscheme nord");
        assert_eq!((a.theme.name.as_str(), a.message.0.as_str()), ("nord", "colorscheme nord"));
        exec(&mut a, "colo nope");
        assert!(a.message.0.starts_with("E185: Cannot find color scheme 'nope'"));
        exec(&mut a, "hi Comment guifg=#00ff00");
        assert_eq!(a.theme.attr("Comment").fg.as_deref(), Some("#00ff00"));
        exec(&mut a, "trust");
        assert_eq!(a.message.0, "no .vigent.toml in this project");
    }
}
