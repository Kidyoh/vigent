//! Review area: what an agent changed, and landing it.
//!
//! - land.rs      `:merge` and `:pr` (src/review.ts)
//! - hunks.rs     the diff by file and hunk, dropping and restoring hunks (src/hunks.ts, diffText)
//! - diffview.rs  `:diff`'s unified and side-by-side layouts (src/diffview.ts)
//! - hunk_review.rs  the `:review` window (src/hunk-review.ts)
//! - float.rs     the window `:diff`, `:dash`, `:cost` and `:race` open (src/float.ts TextFloat)
//! - views.rs     `:diff`, `:review`, `:dash`, `:cost`, `:merge`, `:pr` on the App
//! - hooks.rs     before_merge (src/hooks.ts; worktree_created and agent_finished are agents.rs')
//! - export.rs    `:w` (src/export.ts)
//! - usage.rs     tokens and money, as an agent shows them (session.rs formats them)
//!
//! `:race` is the Sessions area's (race.rs); its window is this area's TextFloat.
//! Its state lives here, on App::review. The App calls in at two places:
//! [`key`] in App::key (an open window takes the key) and [`draw`] last in ui::draw.

pub mod diffview;
pub mod export;
pub mod float;
pub mod hooks;
pub mod hunk_review;
pub mod hunks;
pub mod land;
pub mod usage;
pub mod views;

use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;

use crate::app::{App, Msg};
use crate::session::{Session, State};
use float::{Out, TextFloat};
use hunk_review::{Ask, HunkReview};
use land::Wt;

/// A window of this area's, over the screen.
pub enum Win {
    Text(TextFloat),
    /// the :review window, and the worktree it reviews
    Hunks(HunkReview, Wt),
}

/// Review state on the App.
#[derive(Default)]
pub struct Review {
    pub win: Option<Win>,
}

/// The worktree an agent works in, if it has one that exists.
pub fn worktree_of(s: &Session) -> Option<Wt> {
    let branch = s.branch.clone()?;
    Some(Wt { branch, path: s.path.is_dir().then(|| s.path.clone()), base: (!s.base.is_empty()).then(|| s.base.clone()) })
}

/// Focus an agent by its slot.
pub fn focus_slot(app: &mut App, slot: usize) {
    if let Some(n) = app.open().iter().position(|&i| i == slot) {
        app.focus_agent(n);
    }
}

/// Open a window of this area's.
pub fn open(app: &mut App, f: TextFloat) {
    app.seq.pending.clear();
    app.review.win = Some(Win::Text(f));
}

/// A key, before the keymap: an open window takes it. Returns whether it did.
pub fn key(app: &mut App, k: &KeyEvent) -> bool {
    match app.review.win.as_mut() {
        None => false,
        Some(Win::Text(f)) => {
            match f.key(k) {
                Out::Stay => {}
                Out::Close => app.review.win = None,
                Out::Open(slot) => {
                    app.review.win = None;
                    focus_slot(app, slot);
                }
            }
            true
        }
        Some(Win::Hunks(h, wt)) => {
            let (ask, wt) = (h.key(k), wt.clone());
            match ask {
                Ask::Nothing => {}
                Ask::Close => app.review.win = None,
                Ask::Drop(patch) => apply(app, wt, patch, true),
                Ask::Restore(patch) => apply(app, wt, patch, false),
            }
            true
        }
    }
}

/// Drop or restore a patch off the UI thread, then reload the diff into the :review window.
fn apply(app: &App, wt: Wt, patch: String, drop: bool) {
    let tx = app.tx.clone();
    let focus = app.focus;
    std::thread::spawn(move || {
        let Some(path) = wt.path.clone() else { return };
        let r = if drop { hunks::drop_patch(&path, &patch) } else { hunks::restore_patch(&path, &patch) };
        let r = r.and_then(|_| hunks::diff_text(&path, wt.base.as_deref().unwrap_or(""), None).map(|t| hunks::parse_diff(&t)));
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| {
            if let Some(Win::Hunks(h, _)) = app.review.win.as_mut() {
                h.done(r);
            }
            if focus < app.sessions.len() {
                app.refresh_stat(focus);
            }
        })));
    });
}

/// This area's windows, over everything else.
pub fn draw(f: &mut Frame, app: &mut App, area: Rect) {
    let App { review, theme, .. } = app;
    match review.win.as_mut() {
        Some(Win::Text(w)) => w.draw(f, theme, area),
        Some(Win::Hunks(h, _)) => h.draw(f, theme, area),
        None => {}
    }
}

/// The terminal's (columns, rows).
pub fn screen() -> (u16, u16) {
    crossterm::terminal::size().unwrap_or((120, 40))
}

/// The first line of text without Markdown's marks, on one line (plainPreview).
pub fn plain_preview(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .filter(|l| {
            let t = l.trim();
            !((t.starts_with("```") || t.starts_with("~~~")) && t[3..].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '+' || c == '-'))
        })
        .map(|l| {
            let t = l.trim_start();
            match t.chars().next() {
                Some('-' | '*' | '+') if t[1..].starts_with(char::is_whitespace) => t[1..].trim_start().to_string(),
                _ => l.to_string(),
            }
        })
        .collect();
    let joined = lines.join(" ").replace("**", "").replace("__", "").replace('`', "");
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A state's name, as the windows show it.
pub fn state_name(st: State) -> &'static str {
    match st {
        State::Idle => "idle",
        State::Running => "running",
        State::Waiting => "waiting",
        State::Paused => "paused",
        State::Error => "error",
    }
}

/// A state's highlight group in the windows.
pub fn state_group(st: State) -> &'static str {
    match st {
        State::Running => "String",
        State::Waiting => "WarningMsg",
        State::Error => "ErrorMsg",
        _ => "Comment",
    }
}

/// A state's glyph (the spinner while it runs).
pub fn state_glyph(app: &App, st: State) -> &'static str {
    match st {
        State::Running => crate::ui::spinner(app),
        State::Waiting => "◐",
        State::Idle => "○",
        State::Paused => "‖",
        State::Error => "✗",
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::config::Config;
    use crate::keys::Keymap;
    use crossterm::event::{KeyCode, KeyModifiers};
    use std::sync::mpsc::{Receiver, channel};

    /// An App whose threads' messages can be run (`settle`), with Claude Code and Codex signed in.
    pub fn app() -> (App, Receiver<Msg>) {
        let (tx, rx) = channel();
        let mut a = App::new("0.0.0", std::env::temp_dir(), "default", Config::default(), Keymap::default(), tx);
        a.root = None;
        for e in &mut a.engines.infos {
            e.checking = false;
            if e.id == "claude" || e.id == "codex" {
                (e.installed, e.connected) = (true, true);
            }
        }
        (a, rx)
    }

    /// Run what the threads sent until `done` holds (or 10 s pass).
    pub fn settle(a: &mut App, rx: &Receiver<Msg>, done: impl Fn(&App) -> bool) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !done(a) {
            assert!(std::time::Instant::now() < end, "timed out; message: {:?}", a.message.0);
            if let Ok(m) = rx.recv_timeout(std::time::Duration::from_millis(20)) {
                a.on_msg(m);
            }
        }
    }

    pub fn press(a: &mut App, keys: &str) {
        for c in keys.chars() {
            let code = match c {
                '\r' => KeyCode::Enter,
                '\x1b' => KeyCode::Esc,
                c => KeyCode::Char(c),
            };
            a.key(KeyEvent::new(code, KeyModifiers::NONE));
        }
    }

    pub fn ex(a: &mut App, cmd: &str) {
        crate::commands::exec(a, cmd);
    }

    #[test]
    fn plain_previews() {
        assert_eq!(plain_preview("**Fixed** it by `awaiting`:\n```js\nawait x\n```\n- one\n- two"), "Fixed it by awaiting: await x one two");
    }
}
