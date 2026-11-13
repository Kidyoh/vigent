//! The command line: `vigent [folder] [flags]` starts the screen; the rest are
//! subcommands (src/cli.ts).
//!
//! EXTENSION POINTS: a subcommand is a [`Sub`] in [`SUBCOMMANDS`] (with its
//! function here or in the area's own file); a start flag is a field of
//! [`StartOptions`] and a line in [`START_FLAGS`].

use std::path::PathBuf;

use crate::{config, keys, theme, worktree};

pub const VERSION: &str = env!("VIGENT_VERSION");

pub const HELP: &str = "vigent — a vim-native orchestrator for coding-agent harnesses (the agent CLIs you have installed)

usage:
  vigent --version                           which vigent this is
  vigent [folder] [--theme <name>]           start (in a git repository: each agent gets its own worktree)
  vigent theme list                          the built-in themes
  vigent worktree list                       the agents' worktrees in this repository
  vigent worktree remove <branch> [--force]  delete one (safe unless --force)

engines (what runs new agents; :checkhealth shows which are signed in):
  claude    your installed Claude Code CLI, with its own login

This is the native build (Rust, milestone 1 of #168): Claude Code agents in riftri
worktrees. Codex, OpenCode, Gemini CLI, Cursor CLI and pi come in milestone 2;
until then the npm package (npm install -g @vigent/cli) runs them all.

keys: i to type a task (Enter starts an agent), j/k gg G to scroll, ]s [s to switch,
      :new <task>, :kill, :theme <name>, :checkhealth, :help, :q";

/// A subcommand: `vigent <name> ...`. `run` gets the arguments after the name and returns the exit code.
pub struct Sub {
    pub names: &'static [&'static str],
    pub run: fn(&[String]) -> i32,
}

/// Every subcommand (src/cli.ts). Areas add theirs here:
///   Config: `config check`, `config init`, `trust`, `theme import|new|path`
///   Sessions: `worktree prune`, `worktree gc`
pub static SUBCOMMANDS: &[Sub] = &[
    Sub { names: &["--version", "-v", "-V", "version"], run: |_| version() },
    Sub { names: &["--help", "-h", "help"], run: |_| help() },
    Sub { names: &["theme", "themes"], run: theme_command },
    Sub { names: &["worktree", "worktrees", "wt"], run: worktree_command },
];

fn version() -> i32 {
    println!("vigent {VERSION}");
    0
}

fn help() -> i32 {
    println!("{HELP}");
    0
}

fn theme_command(args: &[String]) -> i32 {
    if args.first().is_some_and(|a| a != "list") {
        eprintln!("usage: vigent theme list");
        return 1;
    }
    for n in theme::names() {
        println!("{n}  (built-in)");
    }
    0
}

/// `vigent worktree list | remove <branch> [--force] | prune | gc` (src/cli.ts worktreeCommand).
fn worktree_command(args: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(root) = worktree::repo_root(&cwd) else {
        eprintln!("vigent: not inside a git repository");
        return 1;
    };
    let cfg = config::load_all(Some(&root)).config.worktree;
    match args.first().map(String::as_str) {
        None | Some("list") => {
            let all = match worktree::list(&root, &cfg) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("vigent: {e}");
                    return 1;
                }
            };
            if all.is_empty() {
                println!("no agent worktrees (they go in {})", worktree::worktrees_dir(&root, &cfg).display());
            }
            let paths: Vec<PathBuf> = all.iter().map(|w| w.path.clone()).collect();
            let backends = worktree::riftri_backends(&root, &paths);
            for w in all {
                let branch = w.branch.clone().unwrap_or_else(|| format!("(detached {})", w.head));
                let how = backends.get(&w.path).map(|b| worktree::backend_name(b)).unwrap_or_else(|| "full copy".into());
                println!("{branch:<36} {how:<16} {}", w.path.display());
            }
            0
        }
        Some("remove" | "rm") => {
            let Some(query) = args.get(1) else {
                eprintln!("usage: vigent worktree remove <branch> [--force]");
                return 1;
            };
            let Some(w) = worktree::find(&root, query, &cfg) else {
                eprintln!("vigent: no agent worktree '{query}' (see: vigent worktree list)");
                return 1;
            };
            let base = crate::records::load(&w.path).and_then(|m| m.base);
            let r = worktree::remove(&root, &w.path, w.branch.as_deref(), base.as_deref(), args.iter().any(|a| a == "--force"));
            println!("{}", r.message);
            if r.removed { 0 } else { 1 }
        }
        Some("prune") => {
            let ok = std::process::Command::new("git").args(["worktree", "prune", "-v"]).current_dir(&root).status().is_ok_and(|s| s.success());
            if ok { 0 } else { 1 }
        }
        Some("gc") => {
            if worktree::riftri_state_dir(&root).is_none() {
                println!("no shared worktree storage in this repository");
                return 0;
            }
            match worktree::riftri_gc(&root) {
                Ok(bytes) => {
                    println!("freed {}", worktree::format_bytes(bytes));
                    0
                }
                Err(e) => {
                    eprintln!("vigent: freeing worktree storage failed: {e}");
                    1
                }
            }
        }
        Some(_) => {
            eprintln!("usage: vigent worktree list | remove <branch> [--force] | prune | gc");
            1
        }
    }
}

/// `vigent [folder] [flags]`, as given.
#[derive(Debug, Default)]
pub struct StartOptions {
    pub folder: Option<PathBuf>,
    pub theme: Option<String>,
    /// Engines area: the model for new agents on --engine
    pub model: Option<String>,
    /// Engines area: the engine for new agents
    pub engine: Option<String>,
    /// Serve area: scripted sessions, no network (src/demo.ts)
    pub demo: bool,
    /// Serve area: start :serve too (--local: this network only)
    pub serve: bool,
    pub local: bool,
}

/// The start flags: (flag, takes a value).
pub const START_FLAGS: &[(&str, bool)] = &[("--theme", true), ("--model", true), ("--engine", true), ("--demo", false), ("--serve", false), ("--local", false)];

pub fn parse_start(args: &[String]) -> Result<StartOptions, String> {
    let mut o = StartOptions::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let Some(&(flag, takes)) = START_FLAGS.iter().find(|(f, _)| f == a) else {
            if a.starts_with('-') {
                return Err(format!("vigent: unknown option '{a}' (vigent --help)"));
            }
            o.folder = Some(PathBuf::from(a));
            continue;
        };
        let value = if takes { Some(it.next().cloned().ok_or_else(|| format!("vigent: {flag} needs a value"))?) } else { None };
        match flag {
            "--theme" => o.theme = value,
            "--model" => o.model = value,
            "--engine" => o.engine = value,
            "--demo" => o.demo = true,
            "--serve" => o.serve = true,
            _ => o.local = true,
        }
    }
    Ok(o)
}

pub fn main(args: Vec<String>) -> i32 {
    if let Some(first) = args.first()
        && let Some(sub) = SUBCOMMANDS.iter().find(|s| s.names.contains(&first.as_str())) {
            return (sub.run)(&args[1..]);
        }
    let opts = match parse_start(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    if let Some(f) = &opts.folder
        && (!f.is_dir() || std::env::set_current_dir(f).is_err()) {
            eprintln!("vigent: '{}' is not a folder (usage: vigent [folder])", f.display());
            return 1;
        }
    let cwd = std::env::current_dir().unwrap_or_default();
    let root = worktree::repo_root(&cwd);
    let config::Loaded { mut config, mut warnings, .. } = config::load_all(root.as_deref());
    let (keymap, key_warnings) = keys::build_keymap(config.leader.as_deref(), &config.keys);
    warnings.extend(key_warnings);
    let theme_name = match (&opts.theme, &config.theme) {
        (Some(t), _) if theme::load(t).is_none() => {
            eprintln!("vigent: no theme '{t}' (vigent theme list)");
            return 1;
        }
        (Some(t), _) => t.clone(),
        (None, Some(t)) if theme::load(t).is_none() => {
            warnings.push(format!("no theme '{t}' (from config); using default"));
            "default".into()
        }
        (None, Some(t)) => t.clone(),
        (None, None) => "default".into(),
    };
    if let Some(e) = &opts.engine {
        // Engines area: run what --engine names (src/cli.ts), custom engines included
        if !config.is_engine_id(e) {
            eprintln!("vigent: unknown engine '{e}' (pi, claude, codex or opencode)");
            return 1;
        }
        // pi's agents still reopen (they say pi isn't there, or how to reach :new) before this build runs pi
        if crate::engines::adapter(e).is_none() && e != "pi" {
            eprintln!("vigent: {} doesn't run in this build yet (PORTING.md)", crate::engines::engine_name(e));
            return 1;
        }
        // what --engine names wins over config.toml's `engine`
        config.engine = Some(e.clone());
    }
    for (flag, given) in [("--model", opts.model.is_some()), ("--demo", opts.demo), ("--serve", opts.serve)] {
        if given {
            warnings.push(format!("{flag} isn't in this build yet (PORTING.md)"));
        }
    }
    crate::tui::run(VERSION, cwd, &theme_name, config, keymap, warnings, &opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn start_flags() {
        let a = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        let o = parse_start(&a("shop --theme nord --engine codex --serve")).unwrap();
        assert_eq!(o.folder.as_deref(), Some(Path::new("shop")));
        assert_eq!((o.theme.as_deref(), o.engine.as_deref(), o.serve), (Some("nord"), Some("codex"), true));
        assert!(parse_start(&a("--bogus")).unwrap_err().contains("unknown option '--bogus'"));
        assert!(parse_start(&a("--theme")).is_err());
    }
}
