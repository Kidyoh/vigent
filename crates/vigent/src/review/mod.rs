//! Review area: what an agent changed, and landing it.
//!
//! - land.rs      `:merge` and `:pr` (src/review.ts)
//! - hunks.rs     the diff by file and hunk, dropping and restoring hunks (src/hunks.ts, diffText)
//! - diffview.rs  `:diff`'s unified and side-by-side layouts (src/diffview.ts)
//! - hunk_review.rs  the `:review` window (src/hunk-review.ts)
//! - float.rs     the window `:diff`, `:dash`, `:cost` and `:race` open (src/float.ts TextFloat)
//! - views.rs     `:diff`, `:review`, `:dash`, `:cost`, `:merge`, `:pr` on the App
//! - race.rs, races.rs  `:race` (src/race.ts, and its App half in src/app.ts)
//! - hooks.rs     worktree_created, before_merge, agent_finished (src/hooks.ts)
//! - export.rs    `:w` (src/export.ts)
//! - usage.rs     tokens and money (formatUsage, totalUsage)
//!
//! Its state lives here, on App::review. The App calls in at three places:
//! [`key`] first in App::key (an open window or a y/n question takes the key),
//! [`draw`] last in ui::draw, and [`watch`] in App::tick (agents that stopped:
//! agent_finished, races).

pub mod diffview;
pub mod export;
pub mod float;
pub mod hooks;
pub mod hunk_review;
pub mod hunks;
pub mod land;
pub mod race;
pub mod races;
pub mod usage;
pub mod views;

use std::sync::Arc;

use crossterm::event::{KeyCode, KeyEvent};
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

/// A y/n question on the message line, like vim's confirm prompts (`:race pick`).
pub struct Confirm {
    pub question: String,
    pub yes: Box<dyn FnOnce(&mut App) + Send>,
}

/// Review state on the App.
#[derive(Default)]
pub struct Review {
    pub win: Option<Win>,
    pub confirm: Option<Confirm>,
    pub races: Vec<race::Race>,
    pub next_race: usize,
    /// each agent's state when last looked at, by slot (to see who stopped)
    last: Vec<Option<State>>,
    /// what runs hooks (None: hooks::run_hook; tests put a stand-in here)
    pub runner: Option<hooks::Runner>,
    /// the race clock in ms (None: since vigent started; tests set it)
    pub clock: Option<u64>,
    /// each engine's model ids, for `:race --models` (loaded once)
    pub models: Option<Vec<(String, Vec<String>)>>,
    /// bells rung for races that ended while you looked elsewhere
    pub alerts: usize,
    /// tests: prompts to racers are recorded here instead of running a CLI
    #[cfg(test)]
    pub fake_send: Option<Vec<(usize, String)>>,
}

impl Review {
    pub fn runner(&self) -> hooks::Runner {
        self.runner.clone().unwrap_or_else(|| Arc::new(hooks::run_hook))
    }
}

/// The worktree an agent works in, if it has one that exists.
pub fn worktree_of(s: &Session) -> Option<Wt> {
    let branch = s.branch.clone()?;
    Some(Wt { branch, path: s.path.is_dir().then(|| s.path.clone()), base: (!s.base.is_empty()).then(|| s.base.clone()) })
}

/// Ask a y/n question; `yes` runs on y (a newer question replaces an unanswered one).
pub fn ask(app: &mut App, question: String, yes: impl FnOnce(&mut App) + Send + 'static) {
    app.seq.pending.clear();
    app.say(question.clone(), "Question");
    app.review.confirm = Some(Confirm { question, yes: Box::new(yes) });
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

/// A key, before the keymap: an open window or a question takes it. Returns whether it did.
pub fn key(app: &mut App, k: &KeyEvent) -> bool {
    if let Some(c) = app.review.confirm.take() {
        app.say("", "Normal");
        if matches!(k.code, KeyCode::Char('y' | 'Y')) {
            (c.yes)(app);
        }
        return true;
    }
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

/// The race clock, in ms.
pub fn now(app: &App) -> u64 {
    app.review.clock.unwrap_or_else(|| app.started.elapsed().as_millis() as u64)
}

/// The terminal's (columns, rows).
pub fn screen() -> (u16, u16) {
    crossterm::terminal::size().unwrap_or((120, 40))
}

/// Every frame: agents whose state changed since the last look (agent_finished, races), and races waiting to start.
pub fn watch(app: &mut App) {
    for i in 0..app.sessions.len() {
        let now = app.sessions[i].state;
        if app.review.last.len() <= i {
            app.review.last.resize(i + 1, None);
        }
        let before = app.review.last[i].replace(now);
        let Some(before) = before else { continue };
        if before == now || app.sessions[i].closed {
            continue;
        }
        if before == State::Running && matches!(now, State::Idle | State::Error | State::Waiting) {
            hooks::agent_finished(app, i);
        }
        races::watch_racer(app, i);
    }
    races::tick(app);
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
    use crossterm::event::KeyModifiers;
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

    #[test]
    fn a_question_takes_the_next_key() {
        let (mut a, _rx) = app();
        ask(&mut a, "really? (y/n)".into(), |app| app.say("yes!", "Normal"));
        assert_eq!(a.message.0, "really? (y/n)");
        press(&mut a, "n");
        assert_eq!(a.message.0, "");
        assert!(a.review.confirm.is_none());
        ask(&mut a, "really? (y/n)".into(), |app| app.say("yes!", "Normal"));
        press(&mut a, "y");
        assert_eq!(a.message.0, "yes!");
    }
}
