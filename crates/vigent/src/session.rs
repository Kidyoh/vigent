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
    /// money spent, in US dollars, as the engine reports it; None: the engine doesn't say (Codex)
    pub cost: Option<f64>,
    pub stat: (usize, usize),
    pub child: Option<Child>,
    pub done_seen: bool,
    pub stream_ended: bool,
    pub stderr: String,
    /// stopped on purpose (abort, pause): its exit isn't a failure
    pub aborted: bool,
    /// :kill'd: hidden, but its slot stays so the threads' messages still find the right agent
    pub closed: bool,
    /// finished, failed or needs you while you looked elsewhere: ◆ in the sidebar until you open it
    pub unread: bool,
    /// the state the App last saw (agents.rs watches what changed: notifications, records, hooks)
    pub seen: State,
    /// the agent a split forked this one from; its worktree stays that agent's to save to and remove
    pub fork_of: Option<usize>,
    /// the next run forks `resume_id` (at `fork_at`); cleared once the new conversation reports its id
    pub forking: bool,
    pub fork_at: Option<String>,
    /// a prompt sent while the last run's CLI was still wrapping up: it starts once that one exits
    pub after_exit: Option<String>,
    /// its worktree's record says when it was made (agents reopen in that order)
    pub created_at: String,
    /// riftri's backend when riftri made its worktree, as reopened (Made says how a new one was made)
    pub riftri: Option<String>,
    /// the last error the CLI reported in this run (said only if the run fails)
    pub last_error: Option<String>,
    /// the run's reply has ended; its CLI is still wrapping up (Claude Code's TurnEnd)
    pub finishing: bool,
    /// how its current run was started (permission rules, for what a refusal says)
    pub launch: engines::Launch,
    /// a pi agent's RPC process (engines/pi.rs)
    pub pi: Option<Box<engines::pi::Pi>>,
    /// tools the CLI refused, to ask you about ([engines.claude] ask)
    pub ask: Option<engines::permissions::Ask>,
    /// each tool call's output, by its id (shown when its fold is open: za, zR)
    pub tool_output: std::collections::HashMap<String, String>,
}

/// 74800 -> "74.8k tok" (src/app.ts formatTokens)
pub fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M tok", js_round(n as f64 / 1e6, 1))
    } else if n >= 1000 {
        format!("{:.1}k tok", js_round(n as f64 / 1e3, 1))
    } else {
        format!("{n} tok")
    }
}

/// US dollars: cents, or a tenth of a cent below one cent (src/app.ts formatCost)
pub fn format_cost(usd: f64) -> String {
    if usd > 0.0 && usd < 0.01 { format!("${:.3}", js_round(usd, 3)) } else { format!("${:.2}", js_round(usd, 2)) }
}

/// JavaScript's toFixed rounds half away from zero on the decimal it prints; Rust's
/// formatter rounds half to even on the binary value. Close enough once nudged.
fn js_round(x: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (x * m + 1e-9_f64.copysign(x)).round() / m
}

/// "12.4k tok · $0.31", or just the tokens when the engine reports no price (src/app.ts formatUsage)
pub fn format_usage(tokens: u64, cost: Option<f64>) -> String {
    match cost {
        Some(c) => format!("{} · {}", format_tokens(tokens), format_cost(c)),
        None => format_tokens(tokens),
    }
}

/// Every agent's usage added up; cost counts the agents that report one (src/app.ts totalUsage):
/// (tokens, cost, how many agents used tokens but report no price).
pub fn total_usage<'a>(all: impl IntoIterator<Item = &'a Session>) -> (u64, Option<f64>, usize) {
    let (mut tokens, mut cost, mut unpriced) = (0, None, 0);
    for s in all {
        tokens += s.tokens;
        match s.cost {
            Some(c) => cost = Some(cost.unwrap_or(0.0) + c),
            None if s.tokens > 0 => unpriced += 1,
            None => {}
        }
    }
    (tokens, cost, unpriced)
}

/// The id of the last assistant message of a conversation Claude Code saved
/// (~/.claude/projects/<folder>/<id>.jsonl), to fork an agent reopened after
/// a restart where it's up to (src/cli-engines.ts lastClaudeMessage).
pub fn last_claude_message(cwd: &std::path::Path, session: &str, config_dir: Option<&std::path::Path>) -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let dir = config_dir.map(PathBuf::from).unwrap_or_else(|| home.join(".claude"));
    let folder: String = cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let text = std::fs::read_to_string(dir.join("projects").join(folder).join(format!("{session}.jsonl"))).ok()?;
    let mut last = None;
    for line in text.lines().filter(|l| l.contains("\"assistant\"")) {
        let Ok(e) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if e["type"] == "assistant" && e["isSidechain"] != true
            && let Some(u) = e["uuid"].as_str()
        {
            last = Some(u.to_string());
        }
    }
    last
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
            cost: None,
            stat: (0, 0),
            child: None,
            done_seen: false,
            stream_ended: false,
            stderr: String::new(),
            aborted: false,
            closed: false,
            unread: false,
            seen: State::Idle,
            fork_of: None,
            forking: false,
            fork_at: None,
            after_exit: None,
            created_at: String::new(),
            riftri: None,
            last_error: None,
            finishing: false,
            launch: Default::default(),
            pi: None,
            ask: None,
            tool_output: Default::default(),
        }
    }

    /// What it has used so far, for the statusline ("" before anything was used).
    pub fn usage(&self) -> String {
        if self.tokens == 0 && self.cost.is_none() {
            return String::new();
        }
        format_usage(self.tokens, self.cost)
    }

    /// It has a worktree of its own (a fork works in its original's, and one in your checkout has none).
    pub fn own_worktree(&self) -> bool {
        self.branch.is_some() && self.fork_of.is_none()
    }

    /// Where a fork made now starts: the last message (Claude Code forks at
    /// it), from this run or from the conversation Claude Code saved.
    pub fn fork_point(&self) -> Option<String> {
        if self.last_message.is_some() || self.engine != "claude" {
            return self.last_message.clone();
        }
        let id = self.resume_id.as_deref()?;
        let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        last_claude_message(&self.path, id, dir.as_deref())
    }

    /// The transcript line a reply is streaming into, if one is.
    pub fn streaming_at(&self) -> Option<usize> {
        self.streaming
    }

    /// held: waiting for its worktree (or a setup hook) before it can run
    pub fn held(&self) -> bool {
        self.hold_reason.is_some()
    }

    /// a run is going (or its CLI is still wrapping up), or it's held
    pub fn busy(&self) -> bool {
        matches!(self.state, State::Running) || self.held() || self.child.is_some()
    }

    /// Send a prompt now, or queue it if the agent is running or paused (held included).
    pub fn submit(&mut self, text: String) -> Submitted {
        if self.state == State::Running || self.state == State::Paused || self.held() {
            self.queue.push_back(text);
            Submitted::Queued(self.queue.len())
        } else {
            Submitted::Now(text)
        }
    }

    /// The next queued prompt, once the agent is free to run it.
    pub fn next_prompt(&mut self) -> Option<String> {
        // busy, paused, closed, or its worktree couldn't be made: nothing to run it in
        if self.busy() || self.state == State::Paused || self.closed {
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
        self.after_exit = None;
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
    /// While the last run's CLI is still wrapping up, it starts once that one
    /// exits (two runs at once would both write the conversation).
    pub fn send(&mut self, text: String, launch: &engines::Launch, tx: Sender<Msg>) {
        self.items.push(Item::User(text.clone()));
        if self.child.is_some() {
            self.end_streaming();
            self.state = State::Running;
            self.after_exit = Some(text);
            return;
        }
        self.run(text, launch, tx);
    }

    /// One run of the CLI (the prompt is in the transcript already).
    pub fn run(&mut self, text: String, launch: &engines::Launch, tx: Sender<Msg>) {
        self.streaming = None;
        self.done_seen = false;
        self.stream_ended = false;
        self.aborted = false;
        self.finishing = false;
        self.last_error = None;
        self.ask = None;
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
            fork: self.forking,
            fork_at: if self.forking { self.fork_at.clone() } else { None },
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

    /// Fold an engine's events into the transcript.
    pub fn apply(&mut self, evs: Vec<Ev>, _focused: bool) {
        for ev in evs {
            match ev {
                Ev::Session(id) => {
                    if self.resume_id.as_deref() != Some(id.as_str()) {
                        self.forking = false;
                        self.resume_id = Some(id);
                    }
                }
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
                Ev::ToolResult { id, output } => {
                    self.tool_output.insert(id, output);
                }
                Ev::Thinking(on) => self.thinking = on,
                Ev::Usage { tokens, cost } => {
                    self.tokens += tokens;
                    if let Some(c) = cost {
                        self.cost = Some(self.cost.unwrap_or(0.0) + c);
                    }
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
                    let (notes, ask) = engines::permissions::blocked(&self.engine, &name, &tools, &self.launch.allow, &mode, self.launch.ask, &rel);
                    self.end_streaming();
                    self.items.extend(notes.into_iter().map(Item::Info));
                    // [engines.claude] ask: once the CLI exits, the App asks you (engines::select::ask_to_allow)
                    self.ask = ask;
                }
                Ev::TurnEnd => {
                    // done for you now; the CLI's result (usage, refused tools) still comes when it exits
                    // (not the last run's, once a prompt waits for it to exit)
                    if !self.aborted && self.state == State::Running && self.after_exit.is_none() {
                        self.thinking = false;
                        self.finishing = true;
                        // finished while you looked elsewhere: the App marks it unread (agents.rs)
                        self.state = State::Idle;
                    }
                }
                Ev::TurnStart => {
                    // the turn went on after its reply (a Stop hook)
                    if self.finishing && self.queue.is_empty() && self.after_exit.is_none() {
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
                    // done for you; the CLI may still wrap up before it exits (a prompt sent since waits for that)
                    if self.state != State::Paused && self.after_exit.is_none() {
                        // finished while you looked elsewhere: the App marks it unread (agents.rs)
                        self.state = if ok { State::Idle } else { State::Error };
                    }
                }
            }
        }
    }

    /// The CLI exited (its output read to the end): was that the end of a turn,
    /// or did it stop without finishing? (TS CliSession's 'close') A prompt sent
    /// while it was wrapping up comes back, to run now.
    pub fn exited(&mut self, status: std::process::ExitStatus) -> Option<String> {
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
        if let Some(next) = self.after_exit.take() {
            // the prompt you sent since replaces asking about what the last run was refused
            self.ask = None;
            return (self.state == State::Running).then_some(next);
        }
        if self.aborted {
            self.ask = None;
            if self.state == State::Running {
                self.state = State::Idle;
            }
            return None;
        }
        if self.ask.is_some() {
            // it's asking you whether to allow what was refused
            self.state = State::Waiting;
            return None;
        }
        if self.done_seen {
            return None; // Done said how it went
        }
        if status.success() && self.last_error.is_none() {
            if self.state != State::Paused {
                self.state = State::Idle;
            }
            return None;
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
        None
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
