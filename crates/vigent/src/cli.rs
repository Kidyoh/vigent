//! The command line: `vigent [folder] [flags]` starts the screen; the rest are
//! subcommands (src/cli.ts).
//!
//! EXTENSION POINTS: a subcommand is a [`Sub`] in [`SUBCOMMANDS`] (with its
//! function here or in the area's own file); a start flag is a field of
//! [`StartOptions`] and a line in [`START_FLAGS`].

use std::path::PathBuf;

use crate::{config, keys, theme, worktree};

pub const VERSION: &str = env!("VIGENT_VERSION");

/// `vigent --help`: the TypeScript vigent's text, word for word (src/cli.ts HELP).
pub const HELP: &str = include_str!("help.txt");

/// A subcommand: `vigent <name> ...`. `run` gets the arguments after the name and returns the exit code.
pub struct Sub {
    pub names: &'static [&'static str],
    pub run: fn(&[String]) -> i32,
}

/// Every subcommand (src/cli.ts). Areas add theirs here:
///   Sessions: `worktree prune`, `worktree gc`
pub static SUBCOMMANDS: &[Sub] = &[
    Sub { names: &["version"], run: |_| version() },
    Sub { names: &["theme", "themes"], run: crate::themecli::command },
    Sub { names: &["worktree", "worktrees", "wt"], run: worktree_command },
    Sub { names: &["config"], run: config_command },
    Sub { names: &["trust"], run: crate::trust::command },
];

fn version() -> i32 {
    println!("vigent {VERSION}");
    0
}

fn help() -> i32 {
    println!("{HELP}");
    0
}

/// `vigent config init` (a commented config.toml) and `vigent config check`.
fn config_command(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("init") => {
            let file = config::config_path();
            if file.exists() {
                eprintln!("{} already exists", file.display());
                return 1;
            }
            let r = file.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::write(&file, config::CONFIG_TEMPLATE));
            if let Err(e) = r {
                eprintln!("vigent: {e}");
                return 1;
            }
            println!("created {}", file.display());
            0
        }
        Some("check") => {
            let file = config::config_path();
            if !file.exists() {
                println!("no config at {} (defaults in use). Create one with: vigent config init", file.display());
                return 0;
            }
            let config::Loaded { config, mut warnings, .. } = config::load(&file, config::LoadOptions::default());
            let (keymap, key_warnings) = keys::build_keymap(config.leader.as_deref(), &config.keys);
            warnings.extend(key_warnings);
            if let Some(t) = &config.theme {
                let r = if crate::follow::is_follow(t) { crate::follow::follow_theme(t).map(|_| ()) } else { theme::load_def(t).map(|_| ()) };
                if let Err(e) = r {
                    warnings.push(e);
                }
            }
            let mappings: usize = keys::KEY_MODES.iter().map(|m| keymap.bindings(*m).iter().filter(|b| b.user).count()).sum();
            for w in &warnings {
                println!("warning: {w}");
            }
            let status = if warnings.is_empty() { "ok".to_string() } else { format!("{} problem(s)", warnings.len()) };
            println!(
                "{}: {status} · theme {} · leader {} · {mappings} mapping(s) · {} highlight override(s)",
                file.display(),
                config.theme.as_deref().unwrap_or("default"),
                config.leader.as_deref().unwrap_or("\\"),
                config.highlights.len()
            );
            i32::from(!warnings.is_empty())
        }
        _ => {
            // `vigent config` alone, or another word: a folder named config, as in TypeScript
            start(std::iter::once("config".to_string()).chain(args.iter().cloned()).collect())
        }
    }
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
    // like the TypeScript vigent: --version and --help anywhere on the line
    if args.iter().any(|a| a == "--version" || a == "-v") {
        return version();
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return help();
    }
    if let Some(first) = args.first()
        && let Some(sub) = SUBCOMMANDS.iter().find(|s| s.names.contains(&first.as_str()))
    {
        return (sub.run)(&args[1..]);
    }
    start(args)
}

/// Start the screen: `vigent [folder] [flags]`.
fn start(args: Vec<String>) -> i32 {
    let opts = match parse_start(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    if let Some(f) = &opts.folder
        && (!f.is_dir() || std::env::set_current_dir(f).is_err())
    {
        eprintln!("vigent: '{}' is not a folder (usage: vigent [folder])", f.display());
        return 1;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let root = worktree::repo_root(&cwd);
    let config::Loaded { config, mut warnings, .. } = config::load_all(root.as_deref());
    let (keymap, key_warnings) = keys::build_keymap(config.leader.as_deref(), &config.keys);
    warnings.extend(key_warnings);
    // engines of your own ([engines.<id>] command = [...]) are known everywhere engines are listed
    crate::engines::register_custom(&config.custom_engines);
    if let Some(e) = &opts.engine
        && !crate::engines::is_engine_id(e)
    {
        eprintln!("vigent: unknown engine '{e}' (pi, claude, codex or opencode)");
        return 1;
    }
    // theme = "nvim" / "vim": your editor's colorscheme (src/follow.ts)
    let theme_name = opts.theme.clone().or_else(|| config.theme.clone()).unwrap_or_else(|| "default".into());
    let loaded = if crate::follow::is_follow(&theme_name) { crate::follow::follow_theme(&theme_name) } else { theme::load_def(&theme_name) };
    let theme_def = match loaded {
        Ok(d) => d,
        Err(e) if opts.theme.is_some() => {
            eprintln!("vigent: {e}");
            return 1;
        }
        Err(e) => {
            warnings.push(format!("{e} (from config); using default"));
            theme::load_def("default").expect("the default theme")
        }
    };
    crate::tui::run(VERSION, cwd, theme_def, &theme_name, config, keymap, warnings, &opts)
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
