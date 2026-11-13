//! Hooks: shell commands vigent runs at points in an agent's life (src/hooks.ts).
//!
//!   [hooks]
//!   worktree_created = "npm ci"      # in each new worktree, before the agent starts
//!   before_merge     = "npm test"    # before :merge and :pr; a failure stops them
//!   agent_finished   = "say done"    # whenever an agent stops (finished, failed, needs you)
//!
//! They run in the agent's worktree with a shell, and see VIGENT_HOOK,
//! VIGENT_AGENT, VIGENT_BRANCH, VIGENT_WORKTREE, VIGENT_REPO, VIGENT_ENGINE (and
//! VIGENT_STATE for agent_finished) in their environment. A hook runs on a
//! thread; its result comes back to the UI thread as a `Msg::Run`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::app::{App, Msg};
use crate::session::{Item, State};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Hook {
    WorktreeCreated,
    BeforeMerge,
    AgentFinished,
}

impl Hook {
    pub fn name(self) -> &'static str {
        match self {
            Hook::WorktreeCreated => "worktree_created",
            Hook::BeforeMerge => "before_merge",
            Hook::AgentFinished => "agent_finished",
        }
    }
    /// How long it may run before it's stopped (HOOK_TIMEOUT_MS).
    pub fn timeout(self) -> Duration {
        match self {
            Hook::WorktreeCreated | Hook::BeforeMerge => Duration::from_secs(15 * 60),
            Hook::AgentFinished => Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct HookResult {
    pub ok: bool,
    /// exit code, or None when it was stopped (timeout) or killed by a signal
    pub code: Option<i32>,
    /// the end of what it printed (stdout and stderr together)
    pub output: String,
    pub ms: u64,
    pub timed_out: bool,
}

/// How a hook is run.
#[derive(Clone, Debug, Default)]
pub struct HookOpts {
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub timeout: Option<Duration>,
}

/// What runs hooks (`run_hook`; tests put a stand-in here, as TypeScript's app.hookRunner).
pub type Runner = Arc<dyn Fn(&str, &HookOpts) -> HookResult + Send + Sync>;

const KEEP: usize = 4000;

/// The last `n` characters of `s` (JavaScript's slice(-n), on characters).
fn tail(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    let skip = s.char_indices().nth(count - n).map(|(i, _)| i).unwrap_or(0);
    &s[skip..]
}

/// Run a hook's command in `cwd` with a shell. Blocking; never fails: a failure is a result.
pub fn run_hook(command: &str, opts: &HookOpts) -> HookResult {
    let started = Instant::now();
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command).current_dir(&opts.cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return HookResult { ok: false, code: None, output: e.to_string(), ms: 0, timed_out: false },
    };
    let output = Arc::new(Mutex::new(String::new()));
    let mut readers = vec![];
    let pipes: Vec<Box<dyn Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    for mut pipe in pipes {
        let out = Arc::clone(&output);
        readers.push(std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut o = out.lock().unwrap();
                o.push_str(&String::from_utf8_lossy(&buf[..n]));
                if o.len() > KEEP * 2 {
                    *o = tail(&o, KEEP).to_string();
                }
            }
        }));
    }
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if opts.timeout.is_some_and(|t| started.elapsed() >= t) {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // like node's 'close': wait for its output to end (not after a timeout: what it started may hold it open)
    if !timed_out {
        for r in readers {
            let _ = r.join();
        }
    }
    let code = if timed_out { None } else { status.and_then(|s| s.code()) };
    let text = output.lock().unwrap().clone();
    HookResult {
        ok: code == Some(0) && !timed_out,
        code,
        output: tail(&text, KEEP).trim_end().to_string(),
        ms: started.elapsed().as_millis() as u64,
        timed_out,
    }
}

/// "3.2s", "1m 05s"
pub fn took(ms: u64) -> String {
    if ms < 60_000 {
        return format!("{:.1}s", (ms as f64 / 1000.0 * 10.0 + 1e-9).round() / 10.0);
    }
    let s = (ms as f64 / 1000.0).round() as u64;
    format!("{}m {:02}s", s / 60, s % 60)
}

/// The last non-empty line of a hook's output, for a one-line message.
pub fn last_line(output: &str) -> String {
    output.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string()
}

/// "exit 1", or "null" for a hook that was stopped (as TypeScript prints it).
fn code_text(code: Option<i32>) -> String {
    code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
}

/// The environment a hook sees for an agent.
pub fn env(app: &App, slot: usize, hook: Hook, extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let s = &app.sessions[slot];
    let wt = crate::review::worktree_of(s);
    let mut v = vec![
        ("VIGENT_HOOK".to_string(), hook.name().to_string()),
        ("VIGENT_AGENT".into(), s.name.clone()),
        ("VIGENT_ENGINE".into(), s.engine.clone()),
        ("VIGENT_BRANCH".into(), wt.as_ref().map(|w| w.branch.clone()).unwrap_or_default()),
        ("VIGENT_WORKTREE".into(), wt.as_ref().and_then(|w| w.path.as_ref()).map(|p| p.display().to_string()).unwrap_or_default()),
        ("VIGENT_REPO".into(), app.root.as_ref().map(|p| p.display().to_string()).unwrap_or_default()),
    ];
    v.extend(extra.iter().map(|(k, val)| (k.to_string(), val.to_string())));
    v
}

/// Run a hook on a thread; `then` gets its result on the UI thread.
pub fn spawn(app: &App, command: &str, opts: HookOpts, then: impl FnOnce(&mut App, HookResult) + Send + 'static) {
    let runner = app.review.runner();
    let (command, tx) = (command.to_string(), app.tx.clone());
    std::thread::spawn(move || {
        let r = runner(&command, &opts);
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| then(app, r))));
    });
}

fn info(app: &mut App, slot: usize, text: String) {
    if let Some(s) = app.sessions.get_mut(slot) {
        s.items.push(Item::Info(text));
    }
}

/// worktree_created: set the new worktree up (npm ci, ...) before the agent's
/// first prompt goes out. Holds the agent and returns true when there's a hook
/// to run; the hook's end releases it and sends what waited.
pub fn set_up_worktree(app: &mut App, slot: usize) -> bool {
    let Some(cmd) = app.config.hooks.worktree_created.clone() else { return false };
    let Some(s) = app.sessions.get(slot) else { return false };
    if s.branch.is_none() || !s.path.is_dir() {
        return false;
    }
    let cwd = s.path.clone();
    let env = env(app, slot, Hook::WorktreeCreated, &[]);
    let s = &mut app.sessions[slot];
    s.hold("setting up");
    s.items.push(Item::Info(format!("setting up the worktree: {cmd}")));
    spawn(app, &cmd, HookOpts { cwd, env, timeout: Some(Hook::WorktreeCreated.timeout()) }, move |app, r| {
        if r.ok {
            info(app, slot, format!("worktree ready ({})", took(r.ms)));
        } else {
            let how = if r.timed_out { "timed out".to_string() } else { format!("failed (exit {})", code_text(r.code)) };
            let out = if r.output.is_empty() { String::new() } else { format!("\n{}", r.output) };
            info(app, slot, format!("worktree_created {how} after {}; the agent starts anyway{out}", took(r.ms)));
            let last = last_line(&r.output);
            let why = if last.is_empty() { format!("exit {}", code_text(r.code)) } else { last };
            let name = app.sessions[slot].name.clone();
            app.say(format!("'{name}': worktree_created failed: {why}"), "WarningMsg");
        }
        if let Some(s) = app.sessions.get_mut(slot) {
            s.release();
        }
        app.drain(slot);
    });
    true
}

/// What :merge or :pr is about to do, for before_merge's messages.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Landing {
    Merge,
    Pr,
}

/// before_merge: `go` runs only when it passes (right away when there's no hook).
pub fn before_landing(app: &mut App, slot: usize, what: Landing, go: impl FnOnce(&mut App) + Send + 'static) {
    let cmd = app.config.hooks.before_merge.clone();
    let wt = crate::review::worktree_of(&app.sessions[slot]);
    let (Some(cmd), Some(wt)) = (cmd, wt) else { return go(app) };
    let Some(cwd) = wt.path.clone() else { return go(app) };
    app.say(format!("before_merge: {cmd} in {}…", wt.branch), "Comment");
    let env = env(app, slot, Hook::BeforeMerge, &[]);
    spawn(app, &cmd, HookOpts { cwd, env, timeout: Some(Hook::BeforeMerge.timeout()) }, move |app, r| {
        if r.ok {
            return go(app);
        }
        let how = if r.timed_out { "timed out".to_string() } else { format!("failed (exit {})", code_text(r.code)) };
        let (no, nothing) = if what == Landing::Pr { ("pull request", "pushed") } else { ("merge", "merged") };
        let out = if r.output.is_empty() { String::new() } else { format!("\n{}", r.output) };
        info(app, slot, format!("before_merge {how} after {}, so no {no}{out}", took(r.ms)));
        let last = last_line(&r.output);
        let why = if !last.is_empty() {
            last
        } else if r.timed_out {
            "timed out".into()
        } else {
            format!("exit {}", code_text(r.code))
        };
        app.say(format!("before_merge failed, nothing {nothing}: {why}"), "ErrorMsg");
    });
}

/// agent_finished: tell your scripts an agent stopped (in the background; only a failure is shown).
pub fn agent_finished(app: &mut App, slot: usize) {
    let Some(cmd) = app.config.hooks.agent_finished.clone() else { return };
    let s = &app.sessions[slot];
    let state = match s.state {
        State::Error => "failed",
        State::Waiting => "needs-you",
        _ => "finished",
    };
    let cwd = crate::review::worktree_of(s)
        .and_then(|w| w.path)
        .or_else(|| app.root.clone())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| Path::new(".").into()));
    let env = env(app, slot, Hook::AgentFinished, &[("VIGENT_STATE", state)]);
    spawn(app, &cmd, HookOpts { cwd, env, timeout: Some(Hook::AgentFinished.timeout()) }, |app, r| {
        if r.ok {
            return;
        }
        let last = last_line(&r.output);
        let why = if !last.is_empty() {
            last
        } else if r.timed_out {
            "timed out".into()
        } else {
            format!("exit {}", code_text(r.code))
        };
        app.say(format!("agent_finished hook failed: {why}"), "WarningMsg");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(env: &[(&str, &str)], timeout_ms: Option<u64>) -> HookOpts {
        HookOpts {
            cwd: std::env::temp_dir(),
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            timeout: timeout_ms.map(Duration::from_millis),
        }
    }

    #[test]
    fn run_hook_output_exit_codes_environment_timeouts() {
        let r = run_hook("echo one; echo two >&2; echo $VIGENT_AGENT", &opts(&[("VIGENT_AGENT", "tidy")], None));
        assert!(r.ok);
        assert_eq!(r.code, Some(0));
        assert!(r.output.contains("one") && r.output.contains("two") && r.output.contains("tidy"), "{:?}", r.output);
        let r = run_hook("echo nope; exit 3", &opts(&[], None));
        assert_eq!((r.ok, r.code, r.output.as_str()), (false, Some(3), "nope"));
        let r = run_hook("sleep 5", &opts(&[], Some(200)));
        assert!(!r.ok && r.timed_out && r.code.is_none());
        assert!(r.ms < 4000);
        // a lot of output: only the end is kept
        let r = run_hook("i=0; while [ $i -lt 2000 ]; do echo line $i; i=$((i+1)); done", &opts(&[], None));
        assert!(r.output.chars().count() <= KEEP);
        assert!(r.output.ends_with("line 1999"));
    }

    #[test]
    fn took_and_last_line() {
        assert_eq!(took(900), "0.9s");
        assert_eq!(took(4200), "4.2s");
        assert_eq!(took(3000), "3.0s");
        assert_eq!(took(41_200), "41.2s");
        assert_eq!(took(65_000), "1m 05s");
        assert_eq!(last_line("a\n  b  \n\n"), "b");
        assert_eq!(last_line(""), "");
    }
}
