//! vigent as one native binary (the Rust port, #168). Milestone 1: Claude Code
//! agents, each in its own riftri worktree, in a vim-style terminal UI.

mod app;
mod engine;
mod names;
mod theme;
mod ui;
mod worktree;

use crossterm::event::{self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind};
use crossterm::execute;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::time::Duration;

const VERSION: &str = env!("VIGENT_VERSION");

const HELP: &str = "vigent — a vim-native orchestrator for coding-agent harnesses (the agent CLIs you have installed)

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

/// The theme from vigent's config (`theme = "..."` in config.toml), if set.
fn configured_theme() -> Option<String> {
    let dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    let text = std::fs::read_to_string(dir.join("vigent").join("config.toml")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break; // only the top-level key
        }
        if let Some(v) = line.strip_prefix("theme").map(str::trim_start).and_then(|r| r.strip_prefix('=')) {
            let v = v.split('#').next().unwrap_or("").trim().trim_matches('"');
            return (!v.is_empty()).then(|| v.to_string());
        }
    }
    None
}

fn worktree_command(args: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(root) = worktree::repo_root(&cwd) else {
        eprintln!("vigent: not inside a git repository");
        return 1;
    };
    match args.first().map(String::as_str) {
        None | Some("list") => {
            let all = worktree::list(&root);
            if all.is_empty() {
                println!("no agent worktrees (they go in {})", worktree::worktrees_dir(&root).display());
            }
            for (branch, path) in all {
                let how = if worktree::is_riftri(&root, &path) { "copy-on-write" } else { "full copy" };
                println!("{branch:<36} {how:<16} {}", path.display());
            }
            0
        }
        Some("remove" | "rm") => {
            let Some(query) = args.get(1) else {
                eprintln!("usage: vigent worktree remove <branch> [--force]");
                return 1;
            };
            let force = args.iter().any(|a| a == "--force");
            let found = worktree::list(&root).into_iter().find(|(b, p)| b == query || p.file_name().is_some_and(|n| n == query.as_str()));
            let Some((_, path)) = found else {
                eprintln!("vigent: no agent worktree '{query}' (see: vigent worktree list)");
                return 1;
            };
            match worktree::remove(&root, &path, force) {
                Ok(m) => {
                    println!("{m}");
                    0
                }
                Err(e) => {
                    eprintln!("vigent: {e}");
                    1
                }
            }
        }
        Some(other) => {
            eprintln!("vigent: unknown worktree command '{other}' (list, remove)");
            1
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-v" | "-V") => return println!("vigent {VERSION}"),
        Some("--help" | "-h" | "help") => return println!("{HELP}"),
        Some("theme" | "themes") => {
            if args.get(1).is_some_and(|a| a != "list") {
                eprintln!("usage: vigent theme list");
                std::process::exit(1);
            }
            for n in theme::names() {
                println!("{n}  (built-in)");
            }
            return;
        }
        Some("worktree" | "worktrees" | "wt") => std::process::exit(worktree_command(&args[1..])),
        _ => {}
    }
    let mut theme_name = configured_theme().unwrap_or_else(|| "default".into());
    let mut folder: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--theme" => theme_name = it.next().cloned().unwrap_or(theme_name),
            s if s.starts_with('-') => {
                eprintln!("vigent: unknown option '{s}' (vigent --help)");
                std::process::exit(1);
            }
            s => folder = Some(PathBuf::from(s)),
        }
    }
    if let Some(f) = &folder {
        if let Err(e) = std::env::set_current_dir(f) {
            eprintln!("vigent: can't open {}: {e}", f.display());
            std::process::exit(1);
        }
    }
    if theme::load(&theme_name).is_none() {
        eprintln!("vigent: no theme '{theme_name}' (vigent theme list)");
        std::process::exit(1);
    }
    std::process::exit(run(theme_name));
}

fn run(theme_name: String) -> i32 {
    let stop = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGHUP, signal_hook::consts::SIGINT] {
        let _ = signal_hook::flag::register(sig, Arc::clone(&stop));
    }
    let (tx, rx) = channel();
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut app = app::App::new(VERSION, cwd, &theme_name, tx.clone());
    std::thread::spawn(move || {
        let _ = tx.send(app::Msg::Claude(engine::detect_claude()));
    });

    // ratatui::init restores the terminal on a panic too
    let mut terminal = ratatui::init();
    let _ = execute!(std::io::stdout(), EnableBracketedPaste);
    let mut code = 0;
    while !app.quit && !stop.load(Ordering::Relaxed) {
        if let Err(e) = terminal.draw(|f| ui::draw(f, &mut app)) {
            eprintln!("vigent: {e}");
            code = 1;
            break;
        }
        match event::poll(Duration::from_millis(40)) {
            Ok(true) => match event::read() {
                Ok(Event::Key(k)) if k.kind != KeyEventKind::Release => app.key(k),
                Ok(Event::Paste(s)) => app.paste(&s),
                _ => {}
            },
            Ok(false) => {}
            Err(_) => break,
        }
        while let Ok(m) = rx.try_recv() {
            app.on_msg(m);
        }
        app.tick();
    }
    app.shutdown();
    let _ = execute!(std::io::stdout(), DisableBracketedPaste);
    ratatui::restore();
    code
}
