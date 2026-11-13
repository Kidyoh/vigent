//! One agent: its transcript, its state, its queue of prompts and the CLI
//! running its current turn. The same model as src/session.ts (Session) and
//! the CLI half of src/cli-engines.ts (CliSession), apart from the App.
//!
//! States are src/session.ts's: running, waiting (finished while you looked
//! elsewhere), idle, paused, error. An agent whose worktree is still being
//! made is *held*: paused with a hold reason; prompts wait in its queue until
//! release().
//!
//! EXTENSION POINT (Sessions area): new per-agent state goes on [`Session`];
//! new engine events are folded into the transcript in [`Session::apply`].

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Child;
use std::sync::mpsc::Sender;

use crate::app::Msg;
use crate::engines::{self, Ev, RunOpts};
use crate::worktree::Made;

/// A line of the transcript (src/session.ts TranscriptItem).
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User(String),
    Text(String),
    Tool { id: String, name: String, summary: String },
    Info(String),
    Error(String),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum State {
    Idle,
    Running,
    /// finished while you looked elsewhere
    Waiting,
    /// :pause'd, or held (see Session::hold_reason)
    Paused,
    Error,
}

/// What submit() did with a prompt.
#[derive(Debug, PartialEq)]
pub enum Submitted {
    /// it goes out now: the caller sends it (App::send)
    Now(String),
    /// it waits; this many are waiting now
    Queued(usize),
}

pub struct Session {
    /// its slot in App::sessions: what the threads' messages name it by
    pub slot: usize,
    pub name: String,
    /// what runs it: an engine id ("claude")
    pub engine: String,
    pub branch: Option<String>,
    pub path: PathBuf,
    pub base: String,
    pub made: Option<Made>,
    pub state: State,
    /// why it's held before it can run (its worktree being made); shown instead of "paused"
    pub hold_reason: Option<String>,
    pub items: Vec<Item>,
    streaming: Option<usize>,
    /// prompts waiting for the current run to finish
    pub queue: VecDeque<String>,
    /// the CLI's conversation id, to resume it
    pub resume_id: Option<String>,
    /// the last message the CLI saved (Claude Code), to fork at
    pub last_message: Option<String>,
    pub model: Option<String>,
    /// asked for with --model / :model (None: the CLI's own default)
    pub requested_model: Option<String>,
    pub effort: Option<String>,
    pub thinking: bool,
    pub tokens: u64,
    pub cost: f64,
    pub stat: (usize, usize),
    pub child: Option<Child>,
    pub done_seen: bool,
    pub stream_ended: bool,
    pub stderr: String,
    /// stopped on purpose (abort, pause): its exit isn't a failure
    pub aborted: bool,
    /// :kill'd: hidden, but its slot stays so the threads' messages still find the right agent
    pub closed: bool,
    /// the last error the CLI reported in this run (said only if the run fails)
    pub last_error: Option<String>,
    /// the run's reply has ended; its CLI is still wrapping up (Claude Code's TurnEnd)
    pub finishing: bool,
    /// how its current run was started (permission rules, for what a refusal says)
    pub launch: engines::Launch,
    /// a pi agent's RPC process (engines/pi.rs)
    pub pi: Option<Box<engines::pi::Pi>>,
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

impl Session {
    pub fn new(slot: usize, name: &str, engine: &str, path: PathBuf) -> Session {
        Session {
            slot,
            name: name.to_string(),
            engine: engine.to_string(),
            branch: None,
            path,
            base: String::new(),
            made: None,
            state: State::Idle,
            hold_reason: None,
            items: vec![],
            streaming: None,
            queue: VecDeque::new(),
            resume_id: None,
            last_message: None,
            model: None,
            requested_model: None,
            effort: None,
            thinking: false,
            tokens: 0,
            cost: 0.0,
            stat: (0, 0),
            child: None,
            done_seen: false,
            stream_ended: false,
            stderr: String::new(),
            aborted: false,
            closed: false,
            last_error: None,
            finishing: false,
            launch: Default::default(),
            pi: None,
        }
    }

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

    /// held: waiting for its worktree (or a setup hook) before it can run
    pub fn held(&self) -> bool {
        self.hold_reason.is_some()
    }

    /// a run is going (or its CLI is still wrapping up), or it's held
    pub fn busy(&self) -> bool {
        matches!(self.state, State::Running) || self.held() || self.child.is_some()
    }

    /// Send a prompt now, or queue it if the agent is busy, paused or has prompts waiting.
    pub fn submit(&mut self, text: String) -> Submitted {
        if self.busy() || self.state == State::Paused || !self.queue.is_empty() {
            self.queue.push_back(text);
            Submitted::Queued(self.queue.len())
        } else {
            Submitted::Now(text)
        }
    }

    /// The next queued prompt, once the agent is free to run it.
    pub fn next_prompt(&mut self) -> Option<String> {
        // busy, paused, closed, or its worktree couldn't be made: nothing to run it in
        if self.busy() || self.state == State::Paused || self.closed || (self.branch.is_some() && self.made.is_none()) {
            return None;
        }
        self.queue.pop_front()
    }

    /// Hold the agent: prompts wait in its queue until release().
    pub fn hold(&mut self, reason: &str) {
        self.hold_reason = Some(reason.to_string());
        self.state = State::Paused;
    }

    /// Let a held agent go (the caller drains its queue).
    pub fn release(&mut self) {
        if self.hold_reason.take().is_some() {
            self.state = State::Idle;
        }
    }

    /// Stop the current run: its CLI is killed, and its exit isn't a failure.
    pub fn abort(&mut self) {
        // a pi agent: pi stops the run and keeps running
        if let Some(p) = self.pi.as_mut() {
            engines::pi::abort_now(p);
        }
        if let Some(c) = self.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.child = None;
        self.aborted = true;
        self.streaming = None;
        if self.state == State::Running {
            self.state = State::Idle;
        }
    }

    /// Stop the current run and hold queued prompts until resume().
    pub fn pause(&mut self) {
        if self.state == State::Running || self.child.is_some() {
            self.abort();
        }
        self.state = State::Paused;
    }

    /// Continue a paused agent: returns what to send (the next queued prompt, or a nudge).
    pub fn resume(&mut self) -> Option<String> {
        if self.state != State::Paused || self.held() {
            return None;
        }
        self.state = State::Idle;
        Some(self.queue.pop_front().unwrap_or_else(|| "Continue where you left off.".into()))
    }

    /// Start a turn: the prompt goes into the transcript and to the engine's CLI
    /// (`launch`: its program, [engines.<id>] args and allow rules, what to leave out of its environment).
    pub fn send(&mut self, text: String, launch: &engines::Launch, tx: Sender<Msg>) {
        self.items.push(Item::User(text.clone()));
        self.streaming = None;
        self.done_seen = false;
        self.stream_ended = false;
        self.aborted = false;
        self.finishing = false;
        self.last_error = None;
        self.stderr.clear();
        self.launch = launch.clone();
        let name = engines::engine_name(&self.engine);
        let Some(adapter) = engines::adapter(&self.engine) else {
            self.items.push(Item::Error(format!("error: {name} doesn't run in this build yet")));
            self.state = State::Error;
            return;
        };
        let opts = RunOpts {
            cwd: self.path.to_string_lossy().into_owned(),
            resume: self.resume_id.clone(),
            model: self.requested_model.clone(),
            effort: self.effort.clone(),
            extra_args: launch.extra_args.clone(),
            allowed_tools: launch.allow.clone(),
            ..Default::default()
        };
        match engines::run::spawn(adapter, &launch.bin, self.slot, &self.path, &text, &opts, &launch.drop_env, tx) {
            Ok(child) => {
                self.child = Some(child);
                self.state = State::Running;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.items.push(Item::Error(format!("error: {} isn't installed (or isn't on PATH) · :checkhealth", launch.bin)));
                self.state = State::Error;
            }
            Err(e) => {
                self.items.push(Item::Error(format!("error: {}: {e}", launch.bin)));
                self.state = State::Error;
            }
        }
    }

    /// Paths inside the agent's folder, shown relative to it.
    pub fn relative(&self, text: &str) -> String {
        let mut out = text.to_string();
        let mut dirs = vec![self.path.to_string_lossy().into_owned()];
        if let Ok(real) = std::fs::canonicalize(&self.path) {
            dirs.push(real.to_string_lossy().into_owned());
        }
        for d in dirs {
            if !d.is_empty() {
                out = out.replace(&format!("{}/", d.trim_end_matches('/')), "");
            }
        }
        out
    }

    /// The reply being streamed is done (an empty one goes).
    fn end_streaming(&mut self) {
        if let Some(j) = self.streaming.take()
            && matches!(self.items.get(j), Some(Item::Text(t)) if t.is_empty())
        {
            self.items.remove(j);
        }
    }

    /// Fold an engine's events into the transcript. `focused`: you're looking at it
    /// (a finished run then goes idle rather than waiting).
    pub fn apply(&mut self, evs: Vec<Ev>, focused: bool) {
        for ev in evs {
            match ev {
                Ev::Session(id) => self.resume_id = Some(id),
                Ev::Message(id) => self.last_message = Some(id),
                Ev::Model(m) => self.model = Some(m),
                Ev::TextDelta(t) => match self.streaming {
                    Some(j) => {
                        if let Some(Item::Text(s)) = self.items.get_mut(j) {
                            s.push_str(&t);
                        }
                    }
                    None => {
                        self.items.push(Item::Text(t));
                        self.streaming = Some(self.items.len() - 1);
                    }
                },
                Ev::Text(t) => match self.streaming.take() {
                    Some(j) => self.items[j] = Item::Text(t),
                    None => self.items.push(Item::Text(t)),
                },
                Ev::Tool { id, name, summary } => {
                    self.end_streaming();
                    let summary: String = self.relative(&summary).chars().take(80).collect();
                    // the same tool, filled in, within this turn (after the last prompt)
                    let found = self.items.iter_mut().rev().take_while(|it| !matches!(it, Item::User(_))).find_map(|it| match it {
                        Item::Tool { id: tid, summary: s, .. } if *tid == id => Some(s),
                        _ => None,
                    });
                    match found {
                        Some(s) => *s = summary,
                        None => self.items.push(Item::Tool { id, name, summary }),
                    }
                }
                Ev::ToolResult { .. } => {}
                Ev::Thinking(on) => self.thinking = on,
                Ev::Usage { tokens, cost } => {
                    self.tokens += tokens;
                    self.cost += cost.unwrap_or(0.0);
                }
                // said only if the run fails (a CLI may report errors it recovers from)
                Ev::Error(e) => self.last_error = Some(e),
                Ev::Denied(tools) => {
                    // what was refused, and the rule that would allow it (asking to allow isn't in this build)
                    let name = engines::engine_name(&self.engine);
                    let mode = engines::permissions::flag_value(
                        &self.launch.extra_args.clone().unwrap_or_else(|| engines::adapter(&self.engine).map(|a| a.default_args().iter().map(|s| s.to_string()).collect()).unwrap_or_default()),
                        "--permission-mode",
                    )
                    .unwrap_or_else(|| "default".into());
                    let rel = |s: &str| self.relative(s);
                    let notes = engines::permissions::blocked_notes(&self.engine, &name, &tools, &self.launch.allow, &mode, &rel);
                    self.end_streaming();
                    self.items.extend(notes.into_iter().map(Item::Info));
                }
                Ev::TurnEnd => {
                    // done for you now; the CLI's result (usage, refused tools) still comes when it exits
                    if !self.aborted && self.state == State::Running {
                        self.thinking = false;
                        self.finishing = true;
                        self.state = if focused { State::Idle } else { State::Waiting };
                    }
                }
                Ev::TurnStart => {
                    // the turn went on after its reply (a Stop hook)
                    if self.finishing && self.queue.is_empty() {
                        self.finishing = false;
                        self.state = State::Running;
                    }
                }
                Ev::Done { ok, error } => {
                    self.done_seen = true;
                    self.end_streaming();
                    self.thinking = false;
                    if !ok {
                        let name = engines::engine_name(&self.engine);
                        let why = error.or_else(|| self.last_error.clone()).unwrap_or_else(|| "failed".into());
                        self.items.push(Item::Error(format!("error: {name}: {why}")));
                    }
                    // done for you; the CLI may still wrap up before it exits
                    if self.state != State::Paused {
                        self.state = if !ok { State::Error } else if focused { State::Idle } else { State::Waiting };
                    }
                }
            }
        }
    }

    /// The CLI exited (its output read to the end): was that the end of a turn,
    /// or did it stop without finishing? (TS CliSession's 'close')
    pub fn exited(&mut self, status: std::process::ExitStatus, focused: bool) {
        self.child = None;
        self.finishing = false;
        self.thinking = false;
        // a plain-text CLI: no trailing blank lines in the reply
        if engines::adapter(&self.engine).is_some_and(|a| a.raw())
            && let Some(j) = self.streaming
            && let Some(Item::Text(t)) = self.items.get_mut(j)
        {
            t.truncate(t.trim_end().len());
        }
        self.end_streaming();
        if self.aborted {
            if self.state == State::Running {
                self.state = State::Idle;
            }
            return;
        }
        if self.done_seen {
            return; // Done said how it went
        }
        if status.success() && self.last_error.is_none() {
            if self.state != State::Paused {
                self.state = if focused { State::Idle } else { State::Waiting };
            }
            return;
        }
        let name = engines::engine_name(&self.engine);
        let why = self.last_error.clone().or_else(|| engines::common::last_lines(&self.stderr)).unwrap_or_else(|| {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = status.signal() {
                    return format!("stopped by signal {sig}");
                }
            }
            format!("exited with code {}", status.code().unwrap_or(1))
        });
        self.items.push(Item::Error(format!("error: {name}: {why}")));
        self.state = State::Error;
    }

    pub fn kill_child(&mut self) {
        if let Some(c) = self.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.child = None;
        // a pi agent's process goes too (dropping it stops pi)
        self.pi = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_streams_in_and_settles() {
        let mut s = Session::new(0, "x", "claude", "/nope".into());
        s.items.push(Item::User("hi".into()));
        s.apply(vec![Ev::TextDelta("Hel".into()), Ev::TextDelta("lo".into())], true);
        assert!(matches!(&s.items[1], Item::Text(t) if t == "Hello"));
        s.apply(vec![Ev::Text("Hello!".into()), Ev::Tool { id: "t".into(), name: "Write".into(), summary: "".into() }], true);
        s.apply(vec![Ev::Tool { id: "t".into(), name: "Write".into(), summary: "/x".into() }, Ev::Usage { tokens: 74_800, cost: Some(0.25) }, Ev::Done { ok: true, error: None }], true);
        assert_eq!(s.items.len(), 3, "the final text replaces the streamed one, the tool fills in");
        assert!(matches!(&s.items[2], Item::Tool { summary, .. } if summary == "/x"));
        assert_eq!(s.usage(), "74.8k tok · $0.25");
        assert_eq!(s.state, State::Idle);
        // a later turn's tool gets its own line, even with an id seen before
        s.items.push(Item::User("again".into()));
        s.apply(vec![Ev::Tool { id: "t".into(), name: "Write".into(), summary: "/y".into() }], true);
        assert!(matches!(s.items.last(), Some(Item::Tool { summary, .. }) if summary == "/y"));
    }

    #[test]
    fn held_and_paused_agents_queue_their_prompts() {
        let mut s = Session::new(0, "w", "claude", "/nope".into());
        s.branch = Some("feat/w".into());
        s.hold("making its worktree");
        assert_eq!(s.submit("one".into()), Submitted::Queued(1));
        assert_eq!(s.next_prompt(), None, "held");
        s.made = Some(Made::Git("test".into()));
        s.release();
        assert_eq!(s.next_prompt().as_deref(), Some("one"));
        s.pause();
        assert_eq!(s.submit("two".into()), Submitted::Queued(1));
        assert_eq!(s.resume().as_deref(), Some("two"));
        s.pause();
        assert_eq!(s.resume().as_deref(), Some("Continue where you left off."));
        assert_eq!(s.submit("now".into()), Submitted::Now("now".into()));
    }
}
