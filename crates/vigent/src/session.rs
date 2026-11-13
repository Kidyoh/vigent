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
use crate::engines::{self, EngineInfo, Ev, RunOpts};
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

    /// Start a turn: the prompt goes into the transcript and to the engine's CLI.
    pub fn send(&mut self, text: String, engine: Option<&EngineInfo>, tx: Sender<Msg>) {
        self.items.push(Item::User(text.clone()));
        self.streaming = None;
        self.done_seen = false;
        self.stream_ended = false;
        self.aborted = false;
        self.stderr.clear();
        let name = engines::engine_name(&self.engine);
        let Some(adapter) = engines::adapter(&self.engine) else {
            self.items.push(Item::Error(format!("{name} doesn't run in this build yet")));
            self.state = State::Error;
            return;
        };
        let opts = RunOpts { resume: self.resume_id.clone(), model: self.requested_model.clone(), effort: self.effort.clone(), ..Default::default() };
        let drop_env = engine.map(|e| e.drop_env.clone()).unwrap_or_default();
        let bin = engines::spec(&self.engine).bin;
        match engines::run::spawn(adapter, bin, self.slot, &self.path, &text, &opts, &drop_env, tx) {
            Ok(child) => {
                self.child = Some(child);
                self.state = State::Running;
            }
            Err(e) => {
                self.items.push(Item::Error(format!("couldn't start {name}: {e}")));
                self.state = State::Error;
            }
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
                    self.streaming = None;
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
                Ev::Error(e) => self.items.push(Item::Error(e)),
                // Engines area: :permissions / ask-to-allow (src/cli-engines.ts askToAllow)
                Ev::Denied(_) => {}
                Ev::TurnEnd | Ev::TurnStart => {}
                Ev::Done { ok, error } => {
                    self.done_seen = true;
                    self.streaming = None;
                    self.thinking = false;
                    if !ok {
                        self.items.push(Item::Error(error.unwrap_or_else(|| "failed".into())));
                    }
                    // done for you; the CLI may still wrap up before it exits
                    if self.state != State::Paused {
                        self.state = if !ok { State::Error } else if focused { State::Idle } else { State::Waiting };
                    }
                }
            }
        }
    }

    /// The CLI exited: was that the end of a turn, or did it stop without finishing?
    pub fn exited(&mut self, status: std::process::ExitStatus) {
        self.child = None;
        if !self.done_seen && !self.aborted {
            let name = engines::engine_name(&self.engine);
            let why = if self.stderr.is_empty() { format!("{name} stopped ({status})") } else { self.stderr.clone() };
            self.items.push(Item::Error(why));
            self.state = State::Error;
        }
    }

    pub fn kill_child(&mut self) {
        if let Some(c) = self.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.child = None;
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
