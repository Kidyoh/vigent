//! vigent's state and what each key and command does. Drawing is in ui.rs.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Child;
use std::sync::mpsc::Sender;
use std::time::Instant;

use crate::engine::{self, Claude, Ev};
use crate::theme::{self, Theme};
use crate::worktree::{self, Made};

/// What comes back from the threads: engines, worktrees, git.
pub enum Msg {
    Engine(usize, Vec<Ev>),
    StreamEnd(usize),
    Stderr(usize, String),
    WorktreeMade(usize, Result<Made, String>),
    Stat(usize, (usize, usize)),
    Claude(Claude),
}

pub enum Item {
    User(String),
    Text(String),
    Tool { id: String, name: String, summary: String },
    Info(String),
    Error(String),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum State {
    /// its worktree is being made; prompts wait
    Making,
    Idle,
    Running,
    /// finished while you looked elsewhere
    Waiting,
    Failed,
}

pub struct Agent {
    pub name: String,
    pub branch: Option<String>,
    pub path: PathBuf,
    pub base: String,
    pub made: Option<Made>,
    pub state: State,
    pub items: Vec<Item>,
    streaming: Option<usize>,
    pub queue: VecDeque<String>,
    session: Option<String>,
    pub model: Option<String>,
    pub tokens: u64,
    pub cost: f64,
    pub stat: (usize, usize),
    child: Option<Child>,
    done_seen: bool,
    stream_ended: bool,
    stderr: String,
    /// :kill'd: hidden, but its slot stays so the threads' messages still find the right agent
    pub closed: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Normal,
    Insert,
    Command,
}

/// A window over the screen: :checkhealth, :help.
pub struct Float {
    pub title: String,
    pub lines: Vec<(String, &'static str)>,
    pub top: usize,
}

pub const ENGINES: [(&str, &str, &str); 6] = [
    ("pi", "pi", "npm install -g @mariozechner/pi-coding-agent"),
    ("Claude Code", "claude", "npm install -g @anthropic-ai/claude-code"),
    ("Codex", "codex", "npm install -g @openai/codex"),
    ("OpenCode", "opencode", "npm install -g opencode-ai"),
    ("Gemini CLI", "gemini", "npm install -g @google/gemini-cli"),
    ("Cursor CLI", "cursor-agent", "curl https://cursor.com/install -fsS | bash"),
];

pub struct App {
    pub version: &'static str,
    pub root: Option<PathBuf>,
    pub cwd: PathBuf,
    pub agents: Vec<Agent>,
    pub focus: usize,
    pub mode: Mode,
    pub input: String,
    pub cmd: String,
    pub message: (String, &'static str),
    /// lines up from the bottom of the transcript (0: follow it)
    pub scroll: usize,
    pub theme: Theme,
    /// None while it's being checked
    pub claude: Option<Claude>,
    pub installed: [bool; 6],
    pub float: Option<Float>,
    pending: Option<char>,
    pub quit: bool,
    tx: Sender<Msg>,
    pub started: Instant,
    /// the transcript pane's height, from the last draw (for half-page scrolls)
    pub page: usize,
}

fn tokens_text(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1000 {
        format!("{:.1}k", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}

impl Agent {
    pub fn usage(&self) -> String {
        if self.tokens == 0 && self.cost == 0.0 {
            return String::new();
        }
        let mut s = format!("{} tok", tokens_text(self.tokens));
        if self.cost > 0.0 {
            s += &format!(" · ${:.2}", self.cost);
        }
        s
    }
    pub fn busy(&self) -> bool {
        matches!(self.state, State::Making | State::Running) || self.child.is_some()
    }
}

impl App {
    pub fn new(version: &'static str, cwd: PathBuf, theme_name: &str, tx: Sender<Msg>) -> App {
        let theme = theme::load(theme_name).or_else(|| theme::load("default")).expect("the default theme");
        let installed = ENGINES.map(|(_, bin, _)| engine::on_path(bin));
        App {
            version,
            root: worktree::repo_root(&cwd),
            cwd,
            agents: vec![],
            focus: 0,
            mode: Mode::Normal,
            input: String::new(),
            cmd: String::new(),
            message: (":help for keys".into(), "Comment"),
            scroll: 0,
            theme,
            claude: None,
            installed,
            float: None,
            pending: None,
            quit: false,
            tx,
            started: Instant::now(),
            page: 20,
        }
    }

    fn say(&mut self, text: impl Into<String>, group: &'static str) {
        self.message = (text.into(), group);
    }

    /// The open agents' slots, in order: what the sidebar numbers 1, 2, 3...
    pub fn open(&self) -> Vec<usize> {
        (0..self.agents.len()).filter(|&i| !self.agents[i].closed).collect()
    }

    /// The agent on screen, if any.
    pub fn focused(&self) -> Option<&Agent> {
        self.agents.get(self.focus).filter(|a| !a.closed)
    }

    pub fn claude_ready(&self) -> bool {
        self.claude.as_ref().is_some_and(|c| c.version.is_some() && c.signed_in)
    }

    pub fn engines_ready(&self) -> usize {
        usize::from(self.claude_ready())
    }

    // -----------------------------------------------------------------
    // keys
    // -----------------------------------------------------------------

    pub fn key(&mut self, k: KeyEvent) {
        if self.float.is_some() {
            return self.float_key(k);
        }
        match self.mode {
            Mode::Insert => self.insert_key(k),
            Mode::Command => self.command_key(k),
            Mode::Normal => self.normal_key(k),
        }
    }

    pub fn paste(&mut self, text: &str) {
        match self.mode {
            Mode::Insert => self.input.push_str(text),
            Mode::Command => self.cmd.push_str(&text.replace('\n', " ")),
            Mode::Normal => {}
        }
    }

    fn scroll_by(&mut self, up: isize) {
        self.scroll = (self.scroll as isize + up).max(0) as usize;
    }

    fn normal_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let pending = self.pending.take();
        match (pending, k.code) {
            (_, KeyCode::Char('c')) if ctrl => self.say("Type  :q  and press <Enter> to exit vigent", "Comment"),
            (_, KeyCode::Char('d')) if ctrl => self.scroll_by(-((self.page / 2).max(1) as isize)),
            (_, KeyCode::Char('u')) if ctrl => self.scroll_by((self.page / 2).max(1) as isize),
            (Some('g'), KeyCode::Char('g')) => self.scroll = usize::MAX / 2,
            (Some(']'), KeyCode::Char('s')) => self.switch(1),
            (Some('['), KeyCode::Char('s')) => self.switch(-1),
            (Some(' '), KeyCode::Char(c @ '1'..='9')) => self.focus_agent(c as usize - '1' as usize),
            (_, KeyCode::Char(c @ ('g' | ']' | '[' | ' '))) => self.pending = Some(c),
            (_, KeyCode::Char('i') | KeyCode::Char('a')) => self.enter_insert(),
            (_, KeyCode::Char(':')) => {
                self.mode = Mode::Command;
                self.cmd.clear();
            }
            (_, KeyCode::Char('j') | KeyCode::Down) => self.scroll_by(-1),
            (_, KeyCode::Char('k') | KeyCode::Up) => self.scroll_by(1),
            (_, KeyCode::Char('G') | KeyCode::End) => self.scroll = 0,
            (_, KeyCode::Char('?')) => self.open_help(),
            (_, KeyCode::Char('c')) if self.focused().is_none() => self.open_health(),
            (_, KeyCode::Char('q')) if self.focused().is_none() => self.quit = true,
            (_, KeyCode::Char('q')) => self.say("Type  :q  and press <Enter> to exit vigent", "Comment"),
            _ => {}
        }
    }

    fn enter_insert(&mut self) {
        if self.focused().is_none() {
            if let Some(why) = self.cant_start() {
                return self.say(why, "ErrorMsg");
            }
        }
        self.mode = Mode::Insert;
    }

    /// Why a new agent can't start, if it can't.
    fn cant_start(&self) -> Option<String> {
        match &self.claude {
            Some(c) if c.version.is_none() => Some(format!("Claude Code isn't installed: {}", ENGINES[1].2)),
            Some(c) if !c.signed_in => Some("Claude Code isn't signed in: run  claude  once to sign in, then :checkhealth".into()),
            _ => None,
        }
    }

    fn insert_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Char('c') if ctrl => {
                self.input.clear();
                self.mode = Mode::Normal;
            }
            KeyCode::Char('u') if ctrl => self.input.clear(),
            KeyCode::Char('w') if ctrl => {
                let t = self.input.trim_end().len();
                let cut = self.input[..t].rfind(' ').map(|i| i + 1).unwrap_or(0);
                self.input.truncate(cut);
            }
            KeyCode::Enter => self.submit(),
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) if !ctrl => self.input.push(c),
            _ => {}
        }
    }

    fn command_key(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                let cmd = std::mem::take(&mut self.cmd);
                self.exec(cmd.trim());
            }
            KeyCode::Backspace => {
                if self.cmd.pop().is_none() {
                    self.mode = Mode::Normal;
                }
            }
            KeyCode::Char(c) if !k.modifiers.contains(KeyModifiers::CONTROL) => self.cmd.push(c),
            _ => {}
        }
    }

    fn float_key(&mut self, k: KeyEvent) {
        let pending = self.pending.take();
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let page = self.page.max(2);
        let Some(f) = self.float.as_mut() else { return };
        let max = f.lines.len().saturating_sub(1);
        match (pending, k.code) {
            (_, KeyCode::Char('q') | KeyCode::Esc) => self.float = None,
            (Some('g'), KeyCode::Char('g')) => f.top = 0,
            (_, KeyCode::Char('g')) => self.pending = Some('g'),
            (_, KeyCode::Char('G')) => f.top = max,
            (_, KeyCode::Char('d')) if ctrl => f.top = (f.top + page / 2).min(max),
            (_, KeyCode::Char('u')) if ctrl => f.top = f.top.saturating_sub(page / 2),
            (_, KeyCode::Char('j') | KeyCode::Down) => f.top = (f.top + 1).min(max),
            (_, KeyCode::Char('k') | KeyCode::Up) => f.top = f.top.saturating_sub(1),
            _ => {}
        }
    }

    fn switch(&mut self, by: isize) {
        let open = self.open();
        if open.is_empty() {
            return;
        }
        let at = open.iter().position(|&i| i == self.focus).unwrap_or(0) as isize;
        self.focus_agent(((at + by).rem_euclid(open.len() as isize)) as usize);
    }

    /// Focus the n-th open agent (0-based, as the sidebar numbers them from 1).
    fn focus_agent(&mut self, n: usize) {
        let Some(&i) = self.open().get(n) else { return };
        self.focus = i;
        self.scroll = 0;
        let a = &mut self.agents[i];
        if a.state == State::Waiting {
            a.state = State::Idle;
        }
    }

    // -----------------------------------------------------------------
    // agents
    // -----------------------------------------------------------------

    fn submit(&mut self) {
        let text = std::mem::take(&mut self.input).trim().to_string();
        self.mode = Mode::Normal;
        if text.is_empty() {
            return;
        }
        if self.focused().is_none() {
            let name = crate::names::agent_name_from(&text);
            if !self.start_agent(&name) {
                return;
            }
        }
        let i = self.focus;
        self.scroll = 0;
        let a = &mut self.agents[i];
        if a.busy() || !a.queue.is_empty() {
            a.queue.push_back(text);
            let waiting = a.queue.len();
            let after = if a.state == State::Making { "once its worktree is ready" } else { "after the current run" };
            let msg = format!("queued: '{}' gets it {after} ({waiting} waiting)", a.name);
            self.say(msg, "Comment");
        } else {
            self.send(i, text);
        }
    }

    /// A new agent, in a worktree of its own made in the background.
    fn start_agent(&mut self, name: &str) -> bool {
        if let Some(why) = self.cant_start() {
            self.say(why, "ErrorMsg");
            return false;
        }
        let taken: Vec<PathBuf> = self.agents.iter().map(|a| a.path.clone()).collect();
        let mut agent = Agent {
            name: name.to_string(),
            branch: None,
            path: self.cwd.clone(),
            base: String::new(),
            made: None,
            state: State::Idle,
            items: vec![],
            streaming: None,
            queue: VecDeque::new(),
            session: None,
            model: None,
            tokens: 0,
            cost: 0.0,
            stat: (0, 0),
            child: None,
            done_seen: false,
            stream_ended: false,
            stderr: String::new(),
            closed: false,
        };
        let index = self.agents.len();
        match &self.root {
            Some(root) => match worktree::plan(root, name, &taken) {
                Ok(p) => {
                    agent.branch = Some(p.branch.clone());
                    agent.path = p.path.clone();
                    agent.base = p.base.clone();
                    agent.state = State::Making;
                    let (root, tx) = (root.clone(), self.tx.clone());
                    std::thread::spawn(move || {
                        let r = worktree::make(&root, &p);
                        let _ = tx.send(Msg::WorktreeMade(index, r));
                    });
                    self.say(format!("'{name}' on {} · making its worktree…", agent.branch.as_deref().unwrap_or("")), "Comment");
                }
                Err(e) => {
                    self.say(format!("can't make a worktree for '{name}': {e}"), "ErrorMsg");
                    return false;
                }
            },
            None => agent.items.push(Item::Info("not a git repository: this agent works in this folder".into())),
        }
        self.agents.push(agent);
        self.focus = index;
        true
    }

    fn send(&mut self, i: usize, text: String) {
        let drop_key = self.claude.as_ref().and_then(|c| c.method.as_deref()) == Some("claude.ai");
        let tx = self.tx.clone();
        let a = &mut self.agents[i];
        a.items.push(Item::User(text.clone()));
        a.streaming = None;
        a.done_seen = false;
        a.stream_ended = false;
        a.stderr.clear();
        match engine::start(i, a.path.clone(), &text, a.session.as_deref(), drop_key, tx) {
            Ok(child) => {
                a.child = Some(child);
                a.state = State::Running;
            }
            Err(e) => {
                a.items.push(Item::Error(format!("couldn't start Claude Code: {e}")));
                a.state = State::Failed;
            }
        }
    }

    /// The next queued prompt, once the agent is free.
    fn drain(&mut self, i: usize) {
        let a = &mut self.agents[i];
        // busy, closed, or its worktree couldn't be made: nothing to run it in
        if a.busy() || a.closed || (a.branch.is_some() && a.made.is_none()) {
            return;
        }
        if let Some(next) = a.queue.pop_front() {
            self.send(i, next);
        }
    }

    pub fn on_msg(&mut self, m: Msg) {
        match m {
            Msg::Claude(c) => self.claude = Some(c),
            Msg::WorktreeMade(i, r) => {
                let Some(a) = self.agents.get_mut(i) else { return };
                match r {
                    Ok(made) => {
                        let how = match &made {
                            Made::Riftri(_) => " · lightweight copy".to_string(),
                            Made::Git(_) => " · full copy (:checkhealth says why)".to_string(),
                        };
                        let msg = format!("'{}' on {} in {}{how}", a.name, a.branch.as_deref().unwrap_or(""), a.path.display());
                        let group = if matches!(made, Made::Git(_)) { "WarningMsg" } else { "ModeMsg" };
                        a.made = Some(made);
                        a.state = State::Idle;
                        self.say(msg, group);
                        self.refresh_stat(i);
                        self.drain(i);
                    }
                    Err(e) => {
                        a.state = State::Failed;
                        a.items.push(Item::Error(format!("couldn't make its worktree: {e}")));
                        let msg = format!("'{}': couldn't make its worktree", a.name);
                        self.say(msg, "ErrorMsg");
                    }
                }
            }
            Msg::Stat(i, s) => {
                if let Some(a) = self.agents.get_mut(i) {
                    a.stat = s;
                }
            }
            Msg::Stderr(i, s) => {
                if let Some(a) = self.agents.get_mut(i) {
                    a.stderr = s;
                }
            }
            Msg::StreamEnd(i) => {
                if let Some(a) = self.agents.get_mut(i) {
                    a.stream_ended = true;
                }
            }
            Msg::Engine(i, evs) => {
                let focused = i == self.focus;
                let Some(a) = self.agents.get_mut(i) else { return };
                for ev in evs {
                    match ev {
                        Ev::Session(id) => a.session = Some(id),
                        Ev::Model(m) => a.model = Some(m),
                        Ev::TextDelta(t) => match a.streaming {
                            Some(j) => {
                                if let Some(Item::Text(s)) = a.items.get_mut(j) {
                                    s.push_str(&t);
                                }
                            }
                            None => {
                                a.items.push(Item::Text(t));
                                a.streaming = Some(a.items.len() - 1);
                            }
                        },
                        Ev::Text(t) => match a.streaming.take() {
                            Some(j) => a.items[j] = Item::Text(t),
                            None => a.items.push(Item::Text(t)),
                        },
                        Ev::Tool { id, name, summary } => {
                            a.streaming = None;
                            // the same tool, filled in, within this turn (after the last prompt)
                            let found = a.items.iter_mut().rev().take_while(|it| !matches!(it, Item::User(_))).find_map(|it| match it {
                                Item::Tool { id: tid, summary: s, .. } if *tid == id => Some(s),
                                _ => None,
                            });
                            match found {
                                Some(s) => *s = summary,
                                None => a.items.push(Item::Tool { id, name, summary }),
                            }
                        }
                        Ev::ToolResult { .. } => {}
                        Ev::Usage { tokens, cost } => {
                            a.tokens += tokens;
                            a.cost += cost.unwrap_or(0.0);
                        }
                        Ev::Done { ok, error } => {
                            a.done_seen = true;
                            a.streaming = None;
                            if !ok {
                                a.items.push(Item::Error(error.unwrap_or_else(|| "failed".into())));
                            }
                            // done for you; Claude Code may still wrap up before it exits
                            a.state = if !ok { State::Failed } else if focused { State::Idle } else { State::Waiting };
                        }
                    }
                }
                if self.agents[i].done_seen {
                    self.refresh_stat(i);
                }
            }
        }
    }

    fn refresh_stat(&self, i: usize) {
        let a = &self.agents[i];
        if a.branch.is_none() || a.made.is_none() {
            return;
        }
        let (path, base, tx) = (a.path.clone(), a.base.clone(), self.tx.clone());
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Stat(i, worktree::diff_stat(&path, &base)));
        });
    }

    /// Reap finished CLIs; the next queued prompt goes once the last one has exited.
    pub fn tick(&mut self) {
        for i in 0..self.agents.len() {
            let a = &mut self.agents[i];
            if a.closed {
                continue;
            }
            let Some(child) = a.child.as_mut() else { continue };
            let Ok(Some(status)) = child.try_wait() else { continue };
            a.child = None;
            if !a.done_seen {
                let why = if a.stderr.is_empty() { format!("Claude Code stopped ({status})") } else { a.stderr.clone() };
                a.items.push(Item::Error(why));
                a.state = State::Failed;
            }
            self.drain(i);
        }
    }

    pub fn shutdown(&mut self) {
        for a in &mut self.agents {
            if let Some(c) = a.child.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    // -----------------------------------------------------------------
    // commands
    // -----------------------------------------------------------------

    fn exec(&mut self, cmd: &str) {
        let (name, arg) = cmd.split_once(' ').map(|(n, a)| (n, a.trim())).unwrap_or((cmd, ""));
        let running = self.agents.iter().any(|a| !a.closed && a.busy());
        match name {
            "" => {}
            "q" | "quit" | "qa" | "qall" | "wq" | "x" if running => self.say("E37: an agent is still running (add ! to quit anyway)", "ErrorMsg"),
            "q" | "quit" | "qa" | "qall" | "wq" | "x" | "q!" | "quit!" | "qa!" | "qall!" => self.quit = true,
            "new" => {
                if arg.is_empty() {
                    return self.say("usage: :new <task>", "ErrorMsg");
                }
                let name = crate::names::agent_name_from(arg);
                if self.start_agent(&name) {
                    let i = self.agents.len() - 1;
                    self.agents[i].queue.push_back(arg.to_string());
                    self.drain(i);
                }
            }
            "checkhealth" | "health" => self.open_health(),
            "help" | "h" => self.open_help(),
            "theme" | "colorscheme" | "colo" => {
                if arg.is_empty() {
                    let msg = format!("{} (:theme <name>; vigent theme list)", self.theme.name);
                    return self.say(msg, "Comment");
                }
                match theme::load(arg) {
                    Some(t) => {
                        self.theme = t;
                        self.say(format!("colorscheme {arg}"), "Comment");
                    }
                    None => self.say(format!("E185: Cannot find color scheme '{arg}'"), "ErrorMsg"),
                }
            }
            "kill" | "kill!" => self.kill(name == "kill!"),
            _ => self.say(format!("E492: Not an editor command: {cmd}"), "ErrorMsg"),
        }
    }

    /// Stop the focused agent and close it. Its worktree is kept, unless :kill!.
    fn kill(&mut self, remove: bool) {
        if self.focused().is_none() {
            return self.say("no agent to kill", "ErrorMsg");
        }
        let a = &mut self.agents[self.focus];
        if let Some(c) = a.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        a.child = None;
        a.closed = true;
        a.queue.clear();
        let (name, branch, path) = (a.name.clone(), a.branch.clone(), a.path.clone());
        let open = self.open();
        self.focus = open.iter().rev().find(|&&i| i < self.focus).or(open.first()).copied().unwrap_or(self.agents.len());
        self.scroll = 0;
        match (self.root.clone(), branch.as_deref(), remove) {
            (Some(root), Some(branch), true) => match worktree::remove(&root, &path, true) {
                Ok(m) => self.say(format!("'{name}' killed; {m}"), "Comment"),
                Err(e) => self.say(format!("'{name}' killed; its worktree stays ({e}): vigent worktree remove {branch} --force"), "WarningMsg"),
            },
            (Some(_), Some(branch), false) => self.say(format!("'{name}' killed; its work stays in {} (vigent worktree remove {branch})", path.display()), "Comment"),
            _ => self.say(format!("'{name}' killed"), "Comment"),
        }
    }

    fn open_help(&mut self) {
        let keys = [
            ("i", "type a prompt; Enter sends it (the first one starts an agent)"),
            ("Esc", "back to NORMAL"),
            ("j / k", "scroll the transcript"),
            ("Ctrl-d / Ctrl-u", "half a page down / up"),
            ("gg / G", "top / bottom (G follows it again)"),
            ("]s / [s", "next / previous agent"),
            ("Space 1-9", "agent by number"),
            (":new <task>", "another agent, in its own worktree"),
            (":kill  :kill!", "close the agent (! also removes its worktree)"),
            (":theme <name>", "change colors (vigent theme list)"),
            (":checkhealth", "engines and worktrees"),
            (":q  :q!", "quit (! even with agents running)"),
        ];
        let mut lines: Vec<(String, &'static str)> = vec![("vigent keys".into(), "Title"), (String::new(), "Normal")];
        lines.extend(keys.iter().map(|(k, d)| (format!("{k:<18}{d}"), "Normal")));
        lines.push((String::new(), "Normal"));
        lines.push(("This Rust build runs Claude Code; the other engines come in milestone 2 (#168).".into(), "Comment"));
        self.float = Some(Float { title: "keys".into(), lines, top: 0 });
    }

    fn open_health(&mut self) {
        let mut l: Vec<(String, &'static str)> = vec![
            ("vigent: agent engines".into(), "Title"),
            ("Each CLI runs as installed, with its own login; vigent never reads credentials.".into(), "Comment"),
            (String::new(), "Normal"),
        ];
        for (n, (name, _, install)) in ENGINES.iter().enumerate() {
            if n == 1 {
                match &self.claude {
                    None => l.push(("… Claude Code  checking".into(), "Comment")),
                    Some(c) if c.version.is_none() => {
                        l.push(("○ Claude Code".into(), "Normal"));
                        l.push(("    not installed".into(), "Comment"));
                        l.push((format!("    install: {install}"), "Comment"));
                    }
                    Some(c) => {
                        let v = c.version.clone().unwrap_or_default();
                        l.push((format!("{} Claude Code  {v}  (default for :new)", if c.signed_in { "●" } else { "◐" }), "Normal"));
                        if c.signed_in {
                            let how = if c.method.as_deref() == Some("claude.ai") { " (Claude account)" } else { "" };
                            l.push((format!("    OK signed in{how}"), "ModeMsg"));
                        } else {
                            l.push(("    WARNING not signed in: run  claude  once to sign in".into(), "WarningMsg"));
                        }
                    }
                }
            } else if self.installed[n] {
                l.push((format!("○ {name}"), "Normal"));
                l.push(("    installed; this Rust build runs Claude Code only so far (milestone 2 adds the rest)".into(), "Comment"));
            } else {
                l.push((format!("○ {name}"), "Normal"));
                l.push(("    not installed".into(), "Comment"));
                l.push((format!("    install: {install}"), "Comment"));
            }
            l.push((String::new(), "Normal"));
        }
        l.push(("vigent: agent worktrees".into(), "Title"));
        l.push((String::new(), "Normal"));
        l.push(("● lightweight worktrees  copy-on-write: agents share unchanged files".into(), "Normal"));
        l.push(("    OK riftri is built into this binary".into(), "ModeMsg"));
        let mut seen = vec![];
        for a in &self.agents {
            match &a.made {
                Some(Made::Riftri(b)) if !seen.contains(b) => {
                    seen.push(b.clone());
                    l.push((format!("    OK copy-on-write worktrees ({b})"), "ModeMsg"));
                }
                Some(Made::Git(why)) => l.push((format!("    WARNING '{}' got a full copy: {why}", a.name), "WarningMsg")),
                _ => {}
            }
        }
        if self.root.is_none() {
            l.push(("    not in a git repository: agents work in this folder".into(), "Comment"));
        }
        self.float = Some(Float { title: "checkhealth".into(), lines: l, top: 0 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn app() -> App {
        let (tx, _rx) = channel();
        std::mem::forget(_rx);
        let mut a = App::new("0.0.0", std::env::temp_dir(), "default", tx);
        a.claude = Some(Claude { version: Some("2".into()), signed_in: true, method: None });
        a
    }

    #[test]
    fn a_reply_streams_in_and_settles() {
        let mut a = app();
        a.root = None;
        assert!(a.start_agent("x"));
        a.on_msg(Msg::Engine(0, vec![Ev::TextDelta("Hel".into()), Ev::TextDelta("lo".into())]));
        assert!(matches!(&a.agents[0].items[1], Item::Text(t) if t == "Hello"));
        a.on_msg(Msg::Engine(0, vec![Ev::Text("Hello!".into()), Ev::Tool { id: "t".into(), name: "Write".into(), summary: "".into() }]));
        a.on_msg(Msg::Engine(0, vec![Ev::Tool { id: "t".into(), name: "Write".into(), summary: "/x".into() }, Ev::Usage { tokens: 74_800, cost: Some(0.25) }, Ev::Done { ok: true, error: None }]));
        assert_eq!(a.agents[0].items.len(), 3, "the final text replaces the streamed one, the tool fills in");
        assert!(matches!(&a.agents[0].items[2], Item::Tool { summary, .. } if summary == "/x"));
        assert_eq!(a.agents[0].usage(), "74.8k tok · $0.25");
        assert_eq!(a.agents[0].state, State::Idle);
        // a later turn's tool gets its own line, even with an id seen before
        a.agents[0].items.push(Item::User("again".into()));
        a.on_msg(Msg::Engine(0, vec![Ev::Tool { id: "t".into(), name: "Write".into(), summary: "/y".into() }]));
        assert!(matches!(a.agents[0].items.last(), Some(Item::Tool { summary, .. }) if summary == "/y"));
    }

    #[test]
    fn prompts_wait_for_the_worktree() {
        let mut a = app();
        a.agents.push(Agent {
            name: "w".into(), branch: Some("feat/w".into()), path: "/nope".into(), base: "main".into(), made: None, state: State::Making,
            items: vec![], streaming: None, queue: VecDeque::new(), session: None, model: None, tokens: 0, cost: 0.0, stat: (0, 0),
            child: None, done_seen: false, stream_ended: false, stderr: String::new(), closed: false,
        });
        a.input = "go".into();
        a.submit();
        assert_eq!(a.message.0, "queued: 'w' gets it once its worktree is ready (1 waiting)");
        assert_eq!(a.agents[0].queue.len(), 1);
    }

    #[test]
    fn quitting_with_a_running_agent_needs_a_bang() {
        let mut a = app();
        a.exec("q");
        assert!(a.quit);
        let mut a = app();
        a.exec("bogus");
        assert!(a.message.0.starts_with("E492"));
    }
}
