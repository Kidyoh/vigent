//! vigent's state and the loop's three inputs: keys, messages from the
//! threads, and the clock. What keys and commands *do* is in actions/ and
//! commands/; agents are session.rs; drawing is ui/.
//!
//! EXTENSION POINTS:
//! - area state: each area keeps its own struct on the App ([`App::review`],
//!   [`App::windows`], [`App::serve`], [`App::engines`]); add fields there, in
//!   the area's file, not here.
//! - background work: send `Msg::Run(Box::new(move |app| ...))` from any
//!   thread to change the App on the UI thread, without a new Msg variant.

use crossterm::event::KeyEvent;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::engines::{self, EngineInfo, Engines, Ev};
use crate::keys::{self, Binding, KeyMode, Keymap, Rhs, Sequencer, Step};
use crate::session::{Session, Submitted};
use crate::theme::{self, Theme};
use crate::ui::floats::Float;
use crate::worktree::{self, Made};

/// What comes back from the threads: engines, worktrees, git.
pub enum Msg {
    Engine(usize, Vec<Ev>),
    StreamEnd(usize),
    Stderr(usize, String),
    WorktreeMade(usize, Result<Made, String>),
    Stat(usize, (usize, usize)),
    /// detection came back: every known engine
    Engines(Vec<EngineInfo>),
    /// anything else: run on the UI thread with the App
    Run(Box<dyn FnOnce(&mut App) + Send>),
}

/// vim's modes, as the statusline names them.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Normal,
    Insert,
    Command,
    /// / and ? (Windows area)
    #[allow(dead_code)]
    Search,
    /// V (Windows area)
    #[allow(dead_code)]
    Visual,
}

impl Mode {
    /// The keymap a mode reads.
    pub fn keys(self) -> KeyMode {
        match self {
            Mode::Normal => KeyMode::Normal,
            Mode::Insert => KeyMode::Insert,
            Mode::Command | Mode::Search => KeyMode::Command,
            Mode::Visual => KeyMode::Visual,
        }
    }
}

pub struct App {
    pub version: &'static str,
    pub root: Option<PathBuf>,
    pub cwd: PathBuf,
    /// every agent, by slot (a :kill'd one stays, closed, so messages still find theirs)
    pub sessions: Vec<Session>,
    pub focus: usize,
    pub mode: Mode,
    pub input: String,
    pub cmd: String,
    pub message: (String, &'static str),
    /// lines up from the bottom of the transcript (0: follow it)
    pub scroll: usize,
    pub theme: Theme,
    pub config: Config,
    pub keymap: Keymap,
    pub seq: Sequencer,
    pub float: Option<Float>,
    pub quit: bool,
    pub tx: Sender<Msg>,
    pub started: Instant,
    /// the transcript pane's height, from the last draw (for half-page scrolls)
    pub page: usize,
    // each area's own state
    pub engines: Engines,
    pub review: crate::review::Review,
    pub windows: crate::windows::Windows,
    pub serve: crate::serve::Serve,
    /// the Sessions area's (agents.rs): <C-^>, focus reporting, y/n questions
    pub agents: crate::agents::Agents,
}

impl App {
    pub fn new(version: &'static str, cwd: PathBuf, theme_name: &str, config: Config, keymap: Keymap, tx: Sender<Msg>) -> App {
        let theme = theme::load(theme_name).or_else(|| theme::load("default")).expect("the default theme");
        App {
            version,
            root: worktree::repo_root(&cwd),
            cwd,
            sessions: vec![],
            focus: 0,
            mode: Mode::Normal,
            input: String::new(),
            cmd: String::new(),
            message: (":help for keys".into(), "Comment"),
            scroll: 0,
            theme,
            config,
            keymap,
            seq: Sequencer::default(),
            float: None,
            quit: false,
            tx,
            started: Instant::now(),
            page: 20,
            engines: Engines::default(),
            review: Default::default(),
            windows: Default::default(),
            serve: Default::default(),
            agents: Default::default(),
        }
    }

    pub fn say(&mut self, text: impl Into<String>, group: &'static str) {
        self.message = (text.into(), group);
    }

    /// The open agents' slots, in order: what the sidebar numbers 1, 2, 3...
    pub fn open(&self) -> Vec<usize> {
        (0..self.sessions.len()).filter(|&i| !self.sessions[i].closed).collect()
    }

    /// The agent on screen, if any.
    pub fn focused(&self) -> Option<&Session> {
        self.sessions.get(self.focus).filter(|a| !a.closed)
    }

    /// The engine new agents start on: config's `engine`, --engine or :engine, else auto's pick.
    pub fn new_agent_engine(&self) -> &'static str {
        self.engines.default_engine()
    }

    /// Why a new agent can't start on the default engine, if it can't.
    pub fn cant_start(&self) -> Option<String> {
        engines::select::cant_start(self, None)
    }

    // -----------------------------------------------------------------
    // keys
    // -----------------------------------------------------------------

    pub fn key(&mut self, k: KeyEvent) {
        if self.answer(&k) {
            return;
        }
        // the Review area's windows (:diff, :review, :dash, :cost, the race list)
        if crate::review::key(self, &k) {
            return;
        }
        if self.engines.picker.is_some() {
            return engines::picker::key(self, k);
        }
        if self.float.is_some() {
            return crate::ui::floats::key(self, k);
        }
        let Some(token) = keys::token_from_event(&k) else { return };
        if self.dashboard_key(&token) {
            return;
        }
        for t in self.split_escape(token) {
            self.feed(t);
        }
    }

    /// Esc followed quickly by a key arrives as one Alt-key sequence (<M-j>):
    /// an Alt key nothing is mapped to is read as Esc and then the key, which
    /// is what was typed (src/app.ts splitEscape). A busy machine makes this common.
    fn split_escape(&self, token: String) -> Vec<String> {
        let Some(rest) = token.strip_prefix("<M-").and_then(|r| r.strip_suffix('>')) else { return vec![token] };
        let mut keys = self.seq.pending.clone();
        keys.push(token.clone());
        let r = self.keymap.lookup(self.mode.keys(), &keys, false);
        if r.exact.is_some() || r.prefix {
            return vec![token];
        }
        let key = if rest.chars().count() == 1 { rest.to_string() } else { format!("<{rest}>") };
        vec!["<Esc>".into(), key]
    }

    /// A key through the keymap: run what it's bound to (or wait for more keys).
    pub fn feed(&mut self, token: String) {
        let timeout = Duration::from_millis(self.config.ui.timeoutlen);
        let step = self.seq.feed(&self.keymap, self.mode.keys(), token, timeout);
        self.run_step(step);
    }

    fn run_step(&mut self, step: Step) {
        for (b, keys) in step.run {
            self.run_binding(b, &keys);
        }
        for k in step.refeed {
            self.feed(k);
        }
    }

    fn run_binding(&mut self, binding: Option<Binding>, keys: &[String]) {
        match binding {
            // unmapped: in INSERT and on the command line, keys type themselves
            None => {
                for k in keys {
                    if let Some(t) = keys::token_text(k) {
                        self.type_text(&t);
                    }
                }
            }
            Some(b) => {
                for rhs in b.rhs {
                    self.run_rhs(rhs);
                }
            }
        }
    }

    pub fn run_rhs(&mut self, rhs: Rhs) {
        match rhs {
            Rhs::Action { name, arg } => crate::actions::run(self, &name, arg.as_deref()),
            Rhs::Ex { cmd, execute: true } => crate::commands::exec(self, &cmd),
            Rhs::Ex { cmd, execute: false } => {
                self.mode = Mode::Command;
                self.cmd = cmd;
            }
            Rhs::Keys(list) => {
                let mut rest: &[String] = &list;
                while !rest.is_empty() {
                    let (b, n) = keys::replay_next(&self.keymap, self.mode.keys(), rest);
                    self.run_binding(b, &rest[..n]);
                    rest = &rest[n..];
                }
            }
            Rhs::Nop => {}
        }
    }

    fn type_text(&mut self, text: &str) {
        match self.mode {
            Mode::Insert => self.input.push_str(text),
            Mode::Command | Mode::Search => self.cmd.push_str(text),
            _ => {}
        }
    }

    /// The start screen's one-key actions, while no agent is open (src/app.ts dashboardKey).
    fn dashboard_key(&mut self, token: &str) -> bool {
        if self.focused().is_some() || self.mode != Mode::Normal || !self.seq.pending.is_empty() {
            return false;
        }
        match token {
            "n" => {
                self.mode = Mode::Command;
                self.cmd = "new ".into();
            }
            "c" => crate::health::open(self),
            "T" => self.list_templates(),
            "?" => crate::help::open(self),
            "q" => crate::commands::exec(self, "q"),
            "m" => engines::select::open_model_picker(self),
            "e" => engines::select::open_effort_picker(self),
            "E" => engines::select::open_engine_picker(self),
            // Config area: t (themes), s (settings)
            _ => return false,
        }
        true
    }

    pub fn paste(&mut self, text: &str) {
        match self.mode {
            Mode::Insert => self.input.push_str(text),
            Mode::Command => self.cmd.push_str(&text.replace('\n', " ")),
            _ => {}
        }
    }

    pub fn scroll_by(&mut self, up: isize) {
        self.scroll = (self.scroll as isize + up).max(0) as usize;
    }

    pub fn switch(&mut self, by: isize) {
        let open = self.open();
        if open.is_empty() {
            return;
        }
        let at = open.iter().position(|&i| i == self.focus).unwrap_or(0) as isize;
        self.focus_agent(((at + by).rem_euclid(open.len() as isize)) as usize);
    }

    /// Focus the n-th open agent (0-based, as the sidebar numbers them from 1).
    pub fn focus_agent(&mut self, n: usize) {
        let Some(&i) = self.open().get(n) else { return };
        self.focus_slot(i);
    }

    // -----------------------------------------------------------------
    // agents
    // -----------------------------------------------------------------

    /// Enter in INSERT: the prompt goes to the focused agent (the first one starts an agent).
    pub fn submit(&mut self) {
        let text = std::mem::take(&mut self.input).trim().to_string();
        self.mode = Mode::Normal;
        if text.is_empty() {
            return;
        }
        if self.focused().is_none() {
            let name = crate::names::agent_name_from(&text);
            if self.start_agent(&name, Default::default()).is_none() {
                return;
            }
        }
        let i = self.focus;
        self.scroll = 0;
        match self.sessions[i].submit(text) {
            Submitted::Now(text) => self.send(i, text),
            Submitted::Queued(waiting) => {
                let a = &self.sessions[i];
                let after = if a.held() { "once its worktree is ready" } else { "after the current run" };
                let msg = format!("queued: '{}' gets it {after} ({waiting} waiting)", a.name);
                self.say(msg, "Comment");
            }
        }
    }

    pub fn send(&mut self, i: usize, text: String) {
        // pi: one long-running process per agent (engines/pi.rs); the CLIs: one process per turn
        if self.sessions[i].engine == "pi" {
            return engines::pi::send(self, i, text);
        }
        let tx = self.tx.clone();
        let launch = engines::select::launch(self, &self.sessions[i].engine);
        self.sessions[i].send(text, &launch, tx);
    }

    /// The next queued prompt, once the agent is free.
    pub fn drain(&mut self, i: usize) {
        if let Some(next) = self.sessions[i].next_prompt() {
            self.send(i, next);
        }
    }

    pub fn on_msg(&mut self, m: Msg) {
        match m {
            Msg::Engines(v) => self.engines.infos = v,
            Msg::Run(f) => f(self),
            Msg::WorktreeMade(i, r) => self.worktree_made(i, r),
            Msg::Stat(i, s) => {
                if let Some(a) = self.sessions.get_mut(i) {
                    a.stat = s;
                }
            }
            Msg::Stderr(i, s) => {
                if let Some(a) = self.sessions.get_mut(i) {
                    a.stderr = s;
                }
            }
            Msg::StreamEnd(i) => {
                if let Some(a) = self.sessions.get_mut(i) {
                    a.stream_ended = true;
                }
            }
            Msg::Engine(i, evs) => self.on_engine(i, evs),
        }
        // every change of state is seen, even one undone within a frame (agents.rs)
        self.watch_states();
    }

    pub fn refresh_stat(&self, i: usize) {
        let a = &self.sessions[i];
        if a.branch.is_none() || a.made.is_none() {
            return;
        }
        let (path, base, tx) = (a.path.clone(), a.base.clone(), self.tx.clone());
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Stat(i, worktree::diff_stat(&path, &base)));
        });
    }

    /// Every frame: pending keys that timed out, and finished CLIs (the next
    /// queued prompt goes once the last one has exited).
    pub fn tick(&mut self) {
        let step = self.seq.tick(&self.keymap, self.mode.keys());
        self.run_step(step);
        for i in 0..self.sessions.len() {
            let a = &mut self.sessions[i];
            if a.closed {
                continue;
            }
            // its output (and stderr) read to the end first, so the exit is judged with all of it
            if !a.stream_ended {
                continue;
            }
            let Some(child) = a.child.as_mut() else { continue };
            let Ok(Some(status)) = child.try_wait() else { continue };
            match a.exited(status) {
                // a prompt sent while it was wrapping up
                Some(next) => {
                    let (tx, launch) = (self.tx.clone(), engines::select::launch(self, &self.sessions[i].engine));
                    self.sessions[i].run(next, &launch, tx);
                }
                None => {
                    self.refresh_stat(i);
                    if self.sessions[i].ask.is_some() {
                        engines::select::ask_to_allow(self, i);
                        continue;
                    }
                    self.drain(i);
                }
            }
        }
        self.watch_states();
    }

    pub fn shutdown(&mut self) {
        for a in &mut self.sessions {
            a.kill_child();
        }
    }
}


#[cfg(test)]
pub mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};
    use std::sync::mpsc::channel;
    use crate::session::State;

    /// An App with Claude Code signed in, outside any repository.
    pub fn app() -> App {
        let (tx, rx) = channel();
        std::mem::forget(rx);
        let mut a = App::new("0.0.0", std::env::temp_dir(), "default", Config::default(), Keymap::default(), tx);
        a.root = None;
        for e in &mut a.engines.infos {
            e.checking = false;
            if e.id == "claude" {
                (e.installed, e.connected, e.version) = (true, true, Some("2".into()));
            }
        }
        a
    }

    fn press(a: &mut App, keys: &str) {
        for c in keys.chars() {
            let code = match c {
                '\r' => KeyCode::Enter,
                '\x1b' => KeyCode::Esc,
                c => KeyCode::Char(c),
            };
            a.key(KeyEvent::new(code, KeyModifiers::NONE));
        }
    }

    #[test]
    fn prompts_wait_for_the_worktree() {
        let mut a = app();
        let mut s = Session::new(0, "w", "claude", "/nope".into());
        s.branch = Some("feat/w".into());
        s.hold("making its worktree");
        a.sessions.push(s);
        a.input = "go".into();
        a.submit();
        assert_eq!(a.message.0, "queued: 'w' gets it once its worktree is ready (1 waiting)");
        assert_eq!(a.sessions[0].queue.len(), 1);
    }

    #[test]
    fn quitting_with_a_running_agent_needs_a_bang() {
        let mut a = app();
        crate::commands::exec(&mut a, "q");
        assert!(a.quit);
        let mut a = app();
        let mut s = Session::new(0, "r", "claude", "/nope".into());
        s.state = State::Running;
        a.sessions.push(s);
        crate::commands::exec(&mut a, "qa");
        assert_eq!(a.message.0, "E37: 1 agent is still running (add ! to quit anyway)");
        assert!(!a.quit);
        crate::commands::exec(&mut a, "qa!");
        assert!(a.quit);
        let mut a = app();
        crate::commands::exec(&mut a, "bogus arg");
        assert_eq!(a.message.0, "E492: Not an editor command: bogus");
    }

    #[test]
    fn keys_go_through_the_keymap() {
        let mut a = app();
        press(&mut a, ":theme nord\r");
        assert_eq!(a.theme.name, "nord");
        assert_eq!(a.mode, Mode::Normal);
        // the start screen's n opens :new
        press(&mut a, "n");
        assert_eq!((a.mode, a.cmd.as_str()), (Mode::Command, "new "));
        press(&mut a, "\x1b");
        // a mapping of your own, to an ex command
        a.keymap.set(KeyMode::Normal, "<leader>x", &keys::RhsValue::Str(":colorscheme gruvbox<CR>".into())).unwrap();
        a.key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
        press(&mut a, "x");
        assert_eq!(a.theme.name, "gruvbox");
        // INSERT types, <C-w> deletes a word, Esc leaves
        press(&mut a, "i");
        assert_eq!(a.mode, Mode::Insert);
        press(&mut a, "fix the bug");
        a.key(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL));
        assert_eq!(a.input, "fix the ");
        press(&mut a, "\x1b");
        assert_eq!(a.mode, Mode::Normal);
    }
}
