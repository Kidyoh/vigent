//! Ex commands (`:new`, `:kill`, `:theme`, ...): a table each area fills in
//! its own file, read the way src/app.ts exec() reads a command line.
//!
//! EXTENSION POINT: to add a command, add a [`Command`] to the `COMMANDS` list
//! in commands/<area>.rs (that file is the area's alone):
//!
//!   Command { name: "pause", aliases: &[], also: None, run: pause },
//!   fn pause(app: &mut App, ex: &Ex) { ... }
//!
//! `name!` reaches the same command with `ex.bang` set, unless `name!` is
//! itself listed. `also` claims names a list can't spell (`nmap`, `vnoremap`,
//! your own capitalized commands). Every area's list is in [`TABLES`] already,
//! so a new command never touches this file.

pub mod config;
pub mod core;
pub mod engines;
pub mod review;
pub mod serve;
pub mod sessions;
pub mod windows;

use crate::app::App;

/// One command line, as typed.
pub struct Ex<'a> {
    /// the name as typed, `!` included ("kill!")
    pub name: &'a str,
    /// it ended in `!` (and no command is listed under that name)
    pub bang: bool,
    /// what follows the name, trimmed
    pub arg: &'a str,
    /// what follows the name with its trailing whitespace kept (mappings: ":nmap x :new ")
    pub raw: &'a str,
}

pub type Handler = fn(&mut App, &Ex);

pub struct Command {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    /// also handles names this accepts (`[nicvx]?(nore)?map`, user commands)
    pub also: Option<fn(&str) -> bool>,
    pub run: Handler,
}

/// Every area's commands. Earlier tables win when two claim a name.
pub static TABLES: &[&[Command]] = &[core::COMMANDS, sessions::COMMANDS, engines::COMMANDS, review::COMMANDS, windows::COMMANDS, config::COMMANDS, serve::COMMANDS];

fn find(name: &str) -> Option<&'static Command> {
    let all = || TABLES.iter().flat_map(|t| t.iter());
    all()
        .find(|c| c.name == name || c.aliases.contains(&name))
        .or_else(|| all().find(|c| c.also.is_some_and(|f| f(name))))
}

/// The command a name runs (for completion and :help): its canonical name.
pub fn lookup(name: &str) -> Option<&'static str> {
    find(name).or_else(|| name.strip_suffix('!').and_then(find)).map(|c| c.name)
}

/// Every command's name and aliases (for completion).
pub fn names() -> Vec<&'static str> {
    TABLES.iter().flat_map(|t| t.iter()).flat_map(|c| std::iter::once(c.name).chain(c.aliases.iter().copied())).collect()
}

/// Run a command line (what's typed after `:`).
pub fn exec(app: &mut App, input: &str) {
    let trimmed = input.trim_start();
    if let Some(shell) = trimmed.strip_prefix('!') {
        // :!{command}, a shell command: the "!" command, when an area has added it
        if shell.trim().is_empty() {
            return app.say("E471: Argument required: :!{command}", "ErrorMsg");
        }
        return match find("!") {
            Some(c) => (c.run)(app, &Ex { name: "!", bang: false, arg: shell.trim(), raw: shell }),
            None => app.say(format!("E492: Not an editor command: !{}", shell.trim()), "ErrorMsg"),
        };
    }
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let (name, rest) = trimmed.split_at(end);
    if name.is_empty() {
        return;
    }
    let raw = rest.trim_start();
    let arg = raw.trim();
    let (cmd, bang) = match find(name) {
        Some(c) => (Some(c), false),
        None => match name.strip_suffix('!') {
            Some(base) => (find(base), true),
            None => (None, false),
        },
    };
    match cmd {
        Some(c) => (c.run)(app, &Ex { name, bang, arg, raw }),
        None => app.say(format!("E492: Not an editor command: {name}"), "ErrorMsg"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_across_areas() {
        let mut seen = std::collections::HashSet::new();
        for n in names() {
            assert!(seen.insert(n), "':{n}' is claimed twice");
        }
    }

    #[test]
    fn bang_and_aliases_find_their_command() {
        assert_eq!(lookup("q!"), Some("q"));
        assert_eq!(lookup("colo"), Some("theme"));
        assert_eq!(lookup("kill!"), Some("kill"));
        assert_eq!(lookup("nope"), None);
    }
}
