//! The terminal and the loop: draw, read a key (or paste), handle what the
//! threads sent, tick. Restores the terminal on exit, a signal or a panic.

use crossterm::event::{self, DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange, Event, KeyEventKind};
use crossterm::execute;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::time::Duration;

use crate::app::{App, Msg};
use crate::cli::StartOptions;
use crate::config::Config;
use crate::keys::Keymap;

pub fn run(version: &'static str, cwd: PathBuf, theme_name: &str, config: Config, keymap: Keymap, mut warnings: Vec<String>, opts: &StartOptions) -> i32 {
    let stop = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGHUP, signal_hook::consts::SIGINT] {
        let _ = signal_hook::flag::register(sig, Arc::clone(&stop));
    }
    // A terminal that hung up (its window closed) leaves crossterm reading EOF in a
    // loop, so the loop below never sees the signal: if it hasn't ended a moment after
    // one, stop the agents vigent started (its process group: pi, a CLI's run) and exit.
    #[cfg(unix)]
    {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(100));
            }
            std::thread::sleep(Duration::from_millis(1500));
            let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
            let pgid = stat.rsplit(')').next().and_then(|r| r.split_whitespace().nth(2)).map(str::to_string);
            // only a group vigent leads (a terminal's own session): never the script that started it
            if pgid.as_deref() == Some(std::process::id().to_string().as_str()) {
                let _ = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{}", std::process::id())]).status();
            }
            std::process::exit(129);
        });
    }
    let (tx, rx) = channel();
    let mut app = App::new(version, cwd, theme_name, config, keymap, tx.clone());
    // --engine / config's engine, and model and effort for new agents (before agents reopen: one saved
    // on pi moves to the engine new agents use when pi isn't here)
    crate::engines::select::startup(&mut app, opts.model.as_deref(), opts.engine.as_deref());
    // demo mode (scripted agents), else the agents that were open when vigent last quit (Sessions area);
    // warnings are said after, over its message
    if crate::serve::demo::wanted(&app, opts.demo) {
        crate::serve::demo::begin(&mut app, opts.demo, &mut warnings);
    } else {
        app.restore(&mut warnings);
    }
    if !warnings.is_empty() {
        app.say(warnings.join(" · "), "WarningMsg");
    }
    // installed? signed in? What's on PATH shows at once; the CLIs' sign-in checks take a moment
    let env = app.engines.env.clone();
    std::thread::spawn(move || {
        let _ = tx.send(Msg::Engines(crate::engines::detect_all(&env, 8000)));
    });

    // --serve: follow from your phone from the start (same as :serve)
    crate::serve::startup(&mut app, opts.serve, opts.local);
    // ratatui::init restores the terminal on a panic too
    let mut terminal = ratatui::init();
    // focus reports let a notification skip the agent you're looking at
    let _ = execute!(std::io::stdout(), EnableBracketedPaste, EnableFocusChange);
    let mut code = 0;
    while !app.quit && !stop.load(Ordering::Relaxed) {
        if let Err(e) = terminal.draw(|f| crate::ui::draw(f, &mut app)) {
            eprintln!("vigent: {e}");
            code = 1;
            break;
        }
        match event::poll(Duration::from_millis(40)) {
            Ok(true) => match event::read() {
                Ok(Event::Key(k)) if k.kind != KeyEventKind::Release => app.key(k),
                Ok(Event::Paste(s)) => app.paste(&s),
                Ok(Event::FocusGained) => app.focus_changed(true),
                Ok(Event::FocusLost) => app.focus_changed(false),
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
    let _ = execute!(std::io::stdout(), DisableBracketedPaste, DisableFocusChange);
    ratatui::restore();
    code
}
