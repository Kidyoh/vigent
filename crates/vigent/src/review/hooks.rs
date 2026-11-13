//! before_merge: a shell command vigent runs in the agent's worktree before
//! :merge and :pr; a failure stops them (src/hooks.ts).
//!
//!   [hooks]
//!   before_merge     = "npm test"    # before :merge and :pr; a failure stops them
//!
//! The other hooks (worktree_created, agent_finished), the runner and the
//! environment hooks see (VIGENT_HOOK, VIGENT_AGENT, VIGENT_BRANCH, ...) are
//! the Sessions area's, in agents.rs; this uses them. A hook runs on a thread;
//! its result comes back to the UI thread as a `Msg::Run`.

use std::time::Duration;

use crate::agents::{last_line, took};
use crate::app::{App, Msg};
use crate::session::Item;

/// How long before_merge may run before it's stopped (HOOK_TIMEOUT_MS).
const BEFORE_MERGE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// "exit 1", or "null" for a hook that was stopped (as TypeScript prints it).
fn code_text(code: Option<i32>) -> String {
    code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
}

fn info(app: &mut App, slot: usize, text: String) {
    if let Some(s) = app.sessions.get_mut(slot) {
        s.items.push(Item::Info(text));
    }
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
    let env = app.hook_env(slot, "before_merge", &[]);
    let (run, tx) = (app.agents.runner(), app.tx.clone());
    std::thread::spawn(move || {
        let r = run(&cmd, &cwd, &env, BEFORE_MERGE_TIMEOUT);
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| {
            if r.ok {
                return go(app);
            }
            let how = if r.timed_out { "timed out".to_string() } else { format!("failed (exit {})", code_text(r.code)) };
            let (no, nothing) = if what == Landing::Pr { ("pull request", "pushed") } else { ("merge", "merged") };
            let out = if r.output.is_empty() { String::new() } else { format!("\n{}", r.output) };
            info(app, slot, format!("before_merge {how} after {}, so no {no}{out}", took(r.took)));
            let last = last_line(&r.output);
            let why = if !last.is_empty() {
                last
            } else if r.timed_out {
                "timed out".into()
            } else {
                format!("exit {}", code_text(r.code))
            };
            app.say(format!("before_merge failed, nothing {nothing}: {why}"), "ErrorMsg");
        })));
    });
}

/// Every hook on the App: worktree_created and agent_finished run through
/// agents.rs, before_merge through `before_landing`; one runner for all three.
#[cfg(test)]
mod app_tests {
    use crate::agents::{HookResult, HookRunner};
    use crate::app::{App, Msg};
    use crate::session::{Item, State};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    type Calls = Arc<Mutex<Vec<(String, PathBuf, Vec<(String, String)>)>>>;

    /// An App whose hooks are recorded and answer `result`; one agent ("name", on feat/<name>) in a worktree folder.
    fn hooked(name: &str, result: HookResult) -> (App, std::sync::mpsc::Receiver<Msg>, Calls, crate::review::land::tests::Tmp) {
        let t = crate::review::land::tests::Tmp::new(&format!("hook-{name}"));
        let (mut a, rx) = crate::review::tests::app();
        a.root = Some(t.0.clone());
        a.agents.alerts = Some(vec![]);
        let calls: Calls = Arc::default();
        let c = Arc::clone(&calls);
        let runner: HookRunner = Arc::new(move |cmd: &str, cwd: &Path, env: &[(String, String)], _: Duration| {
            c.lock().unwrap().push((cmd.to_string(), cwd.to_path_buf(), env.to_vec()));
            result.clone()
        });
        a.agents.hook_runner = Some(runner);
        // an engine no build runs, so a prompt that goes out doesn't start a real CLI
        let mut s = crate::session::Session::new(0, name, "no-such-engine", t.0.clone());
        (s.branch, s.base) = (Some(format!("feat/{name}")), "main".into());
        a.sessions.push(s);
        (a, rx, calls, t)
    }

    fn env_of<'a>(env: &'a [(String, String)], k: &str) -> &'a str {
        env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("")
    }

    fn settle(a: &mut App, rx: &std::sync::mpsc::Receiver<Msg>, done: impl Fn(&App) -> bool) {
        crate::review::tests::settle(a, rx, done)
    }

    #[test]
    fn worktree_created_runs_in_the_new_worktree_and_the_first_prompt_waits() {
        let (mut a, rx, calls, t) = hooked("cart", HookResult { ok: true, code: Some(0), output: "added 120 packages".into(), took: Duration::from_millis(4200), timed_out: false });
        a.config.hooks.worktree_created = Some("npm ci".into());
        a.sessions[0].hold("making its worktree");
        a.input = "fix the cart total".into();
        a.submit();
        a.on_msg(Msg::WorktreeMade(0, Ok(crate::worktree::Made::Git("test".into()))));
        assert_eq!(a.sessions[0].hold_reason.as_deref(), Some("setting up"), "held while the worktree is set up");
        assert!(a.sessions[0].items.iter().all(|i| !matches!(i, Item::User(_))));
        assert_eq!(a.sessions[0].resume(), None, ":resume can't skip the setup");
        settle(&mut a, &rx, |a| a.sessions[0].items.iter().any(|i| matches!(i, Item::User(t) if t == "fix the cart total")));
        let c = calls.lock().unwrap();
        assert_eq!(c[0].0, "npm ci");
        assert_eq!(c[0].1, t.0);
        assert_eq!(env_of(&c[0].2, "VIGENT_HOOK"), "worktree_created");
        assert_eq!(env_of(&c[0].2, "VIGENT_BRANCH"), "feat/cart");
        assert!(a.sessions[0].items.contains(&Item::Info("setting up the worktree: npm ci".into())));
        assert!(a.sessions[0].items.contains(&Item::Info("worktree ready (4.2s)".into())));
    }

    #[test]
    fn a_failing_worktree_created_says_so_and_lets_the_agent_start_anyway() {
        let (mut a, rx, _calls, _t) = hooked("docs", HookResult { ok: false, code: Some(1), output: "npm ERR! missing lockfile".into(), took: Duration::from_millis(900), timed_out: false });
        a.config.hooks.worktree_created = Some("npm ci".into());
        a.sessions[0].hold("making its worktree");
        a.input = "update the docs".into();
        a.submit();
        a.on_msg(Msg::WorktreeMade(0, Ok(crate::worktree::Made::Git("test".into()))));
        settle(&mut a, &rx, |a| a.sessions[0].items.iter().any(|i| matches!(i, Item::User(_))));
        assert!(a.sessions[0].items.contains(&Item::Info("worktree_created failed (exit 1) after 0.9s; the agent starts anyway\nnpm ERR! missing lockfile".into())));
        assert_eq!(a.message.0, "'docs': worktree_created failed: npm ERR! missing lockfile");
    }

    #[test]
    fn before_merge_stops_merge_and_pr_when_it_fails() {
        let (mut a, rx, calls, _t) = hooked("race", HookResult { ok: false, code: Some(1), output: "✗ 2 failing".into(), took: Duration::from_millis(3000), timed_out: false });
        a.config.hooks.before_merge = Some("npm test".into());
        crate::commands::exec(&mut a, "merge");
        assert_eq!(a.message.0, "before_merge: npm test in feat/race…");
        settle(&mut a, &rx, |a| a.message.0.starts_with("before_merge failed"));
        assert_eq!(a.message.0, "before_merge failed, nothing merged: ✗ 2 failing");
        assert!(a.sessions[0].items.contains(&Item::Info("before_merge failed (exit 1) after 3.0s, so no merge\n✗ 2 failing".into())));
        crate::commands::exec(&mut a, "pr");
        settle(&mut a, &rx, |a| a.message.0.starts_with("before_merge failed, nothing pushed"));
        assert!(a.sessions[0].items.iter().any(|i| matches!(i, Item::Info(t) if t.contains("so no pull request"))));
        let c = calls.lock().unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(env_of(&c[1].2, "VIGENT_HOOK"), "before_merge");
    }

    #[test]
    fn agent_finished_runs_whenever_an_agent_stops_with_vigent_state() {
        let (mut a, rx, calls, _t) = hooked("tidy", HookResult { ok: true, code: Some(0), ..Default::default() });
        a.config.hooks.agent_finished = Some("notify-send done".into());
        a.watch_states();
        for st in [State::Running, State::Idle, State::Running, State::Error] {
            a.sessions[0].state = st;
            a.watch_states();
        }
        settle(&mut a, &rx, |_| calls.lock().unwrap().len() == 2);
        let got: Vec<(String, String, String)> = calls.lock().unwrap().iter().map(|(c, _, env)| (c.clone(), env_of(env, "VIGENT_STATE").into(), env_of(env, "VIGENT_AGENT").into())).collect();
        assert_eq!(got, [("notify-send done".into(), "finished".into(), "tidy".into()), ("notify-send done".into(), "failed".into(), "tidy".into())]);
    }
}
