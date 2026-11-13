//! The terminal and the loop: draw, read a key (or paste), handle what the
//! threads sent, tick. Restores the terminal on exit, a signal or a panic.

use crossterm::event::{self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyEventKind};
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

pub fn run(version: &'static str, cwd: PathBuf, theme_name: &str, config: Config, keymap: Keymap, warnings: Vec<String>, _opts: &StartOptions) -> i32 {
    let stop = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGHUP, signal_hook::consts::SIGINT] {
        let _ = signal_hook::flag::register(sig, Arc::clone(&stop));
    }
    let (tx, rx) = channel();
    let mut app = App::new(version, cwd, theme_name, config, keymap, tx.clone());
    if !warnings.is_empty() {
        app.say(warnings.join(" · "), "WarningMsg");
    }
    std::thread::spawn(move || {
        let _ = tx.send(Msg::Engines(crate::engines::detect_all()));
    });

    // ratatui::init restores the terminal on a panic too
    let mut terminal = ratatui::init();
    let _ = execute!(std::io::stdout(), EnableBracketedPaste);
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
