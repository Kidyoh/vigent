//! Demo mode (src/demo.ts, DemoSession in src/session.ts): scripted agents so
//! the UI can be explored without an agent CLI or an API key. It starts with
//! `--demo`, or when nothing can run agents. Nothing touches your repo: a demo
//! agent's worktree is only shown, never made.
//!
//! A script plays on a thread of its own; each step runs on the UI thread
//! (`Msg::Run`). A newer script, a stop or an abort (<C-c>, :pause) ends it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::app::{App, Msg};
use crate::engines::Ev;
use crate::session::{Item, Session, State};

/// One step of a script (src/session.ts DemoStep).
#[derive(Clone)]
pub enum Step {
    State(u64, State),
    Info(u64, String),
    /// (delay, name, summary, output)
    Tool(u64, &'static str, String, String),
    /// (delay, text, ms per word: 0 is all at once)
    Agent(u64, String, u64),
}

impl Step {
    fn delay(&self) -> u64 {
        match self {
            Step::State(d, _) | Step::Info(d, _) | Step::Tool(d, ..) | Step::Agent(d, ..) => *d,
        }
    }
}

/// The message when the demo started because nothing can run agents.
pub const AUTO_NOTICE: &str = "demo mode: these agents are scripted. For real ones, install and sign in to Claude Code, Codex or OpenCode, or set ANTHROPIC_API_KEY, then restart (:checkhealth)";

/// Whether vigent starts in demo mode: --demo, or no engine chosen and nothing
/// that can run agents (no pi with a key, no agent CLI on PATH) (src/cli.ts).
pub fn wanted(app: &App, flag: bool) -> bool {
    if flag {
        return true;
    }
    let env = &app.engines.env;
    let chosen = app.engines.preferred != "auto";
    let pi = crate::engines::detect::detect_pi(env).connected;
    let any_cli = ["claude", "codex", "opencode"].iter().any(|id| crate::engines::detect::on_path(&crate::engines::bin(id), env))
        || app.config.custom_engines.iter().any(|e| e.command.first().is_some_and(|c| crate::engines::detect::on_path(c, env)));
    !chosen && !pi && !any_cli
}

/// Start in demo mode: the three scripted agents, the first one focused.
pub fn begin(app: &mut App, flag: bool, warnings: &mut Vec<String>) {
    app.serve.demo = true;
    for (s, script) in sessions() {
        let slot = app.add_session(s, false);
        play(app, slot, script);
    }
    app.focus = 0;
    if !flag {
        warnings.insert(0, AUTO_NOTICE.into());
    }
}

/// A demo agent (src/session.ts DemoSession): on "pi", so it shows its model, not an engine.
fn agent(name: &str, model: &str, branch: Option<String>, stat: (usize, usize)) -> Session {
    let mut s = Session::new(0, name, "pi", std::env::current_dir().unwrap_or_default());
    s.model = Some(model.into());
    s.branch = branch;
    s.stat = stat;
    s
}

fn tool(delay: u64, name: &'static str, summary: &str, output: &str) -> Step {
    Step::Tool(delay, name, summary.into(), output.into())
}

/// The three scripted agents (src/demo.ts createDemoSessions).
pub fn sessions() -> Vec<(Session, Vec<Step>)> {
    let branch = |n: &str| Some(crate::names::branch_name(n));
    let mut auth = agent("auth-refactor", "claude-sonnet-5-5", branch("auth-refactor"), (41, 18));
    auth.items.push(Item::User("Refactor the session middleware to use the new token store.".into()));
    let auth_script = vec![
        Step::State(300, State::Running),
        Step::Agent(400, "I'll start by reading the current middleware to understand how sessions are validated today.".into(), 90),
        tool(
            500,
            "read",
            "src/middleware/auth.ts",
            "import { verify } from '../lib/jwt';\n\nexport async function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).end();\n  // legacy: validates against the jwt secret directly\n  const claims = verify(token, process.env.JWT_SECRET);\n  req.user = claims.sub;\n  next();\n}",
        ),
        tool(
            900,
            "edit",
            "src/middleware/auth.ts (+41 −18)",
            "- const claims = verify(token, process.env.JWT_SECRET);\n- req.user = claims.sub;\n+ const session = await tokenStore.resolve(token);\n+ if (!session) return res.status(401).end();\n+ req.user = session.userId;",
        ),
        tool(
            800,
            "bash",
            "npm test -- auth",
            "PASS test/middleware/auth.test.ts\n  ✓ rejects missing token (3 ms)\n  ✓ resolves session from TokenStore (5 ms)\n  ✓ rejects revoked tokens (2 ms)\n\nTests: 14 passed, 14 total",
        ),
        Step::Agent(
            700,
            [
                "Done. The middleware now resolves tokens through **TokenStore** instead of verifying JWTs inline:",
                "- revoked tokens are rejected with a `401`",
                "- all 14 tests pass",
                "```ts",
                "const session = await tokenStore.resolve(token);",
                "if (!session) return res.status(401).end();",
                "```",
                "Want me to update the docs too?",
            ]
            .join("\n"),
            80,
        ),
        Step::State(300, State::Waiting),
    ];

    let mut flaky = agent("fix-flaky-test", "claude-haiku-5-5", branch("fix-flaky-test"), (6, 2));
    flaky.items.push(Item::User("The checkout e2e test fails ~1 in 5 runs. Find the race and fix it.".into()));
    let flaky_script = vec![
        Step::State(1200, State::Running),
        Step::Agent(600, "Reproducing first — running the suite 10 times to catch the failure.".into(), 110),
        tool(1500, "bash", "for i in $(seq 10); do npm run e2e -- checkout; done", "run 1..6: pass\nrun 7: FAIL expected cart badge '3', got '2'\nrun 8..10: pass"),
        Step::Agent(2500, "Caught it: the badge assertion runs before the cart mutation settles. The test clicks 'add' and asserts immediately instead of awaiting the network idle. Fixing with a proper waitFor on the cart response.".into(), 120),
        Step::State(200, State::Waiting),
    ];

    let mut docs = agent("docs-pass", "claude-haiku-5-5", None, (0, 0));
    docs.items.push(Item::User("Sweep the README for stale CLI flags.".into()));
    let docs_script = vec![
        Step::Agent(500, "Swept README.md and docs/cli.md: fixed 3 stale flags (--watch → --dev, removed --legacy-peer, documented --json). Committed as docs: refresh CLI flags.".into(), 0),
        Step::State(100, State::Idle),
    ];

    vec![(auth, auth_script), (flaky, flaky_script), (docs, docs_script)]
}

/// JavaScript's string length (UTF-16 units), for the demo's token counts.
fn js_len(s: &str) -> u64 {
    s.encode_utf16().count() as u64
}

/// Play a script on agent `slot`, ending the one it was playing.
pub fn play(app: &mut App, slot: usize, steps: Vec<Step>) {
    let stop_flag = Arc::new(AtomicBool::new(false));
    if let Some(old) = app.serve.plays.insert(slot, Arc::clone(&stop_flag)) {
        old.store(true, Ordering::Relaxed);
    }
    app.sessions[slot].aborted = false;
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        // a step on the UI thread, unless this script was ended (or the agent aborted)
        let run = |f: Box<dyn FnOnce(&mut Session) + Send>| {
            let flag = Arc::clone(&stop_flag);
            tx.send(Msg::Run(Box::new(move |app: &mut App| {
                let Some(s) = app.sessions.get_mut(slot) else { return };
                if s.aborted || s.closed {
                    flag.store(true, Ordering::Relaxed);
                }
                if flag.load(Ordering::Relaxed) {
                    return;
                }
                f(s);
            })))
            .is_ok()
        };
        for step in steps {
            std::thread::sleep(Duration::from_millis(step.delay()));
            if stop_flag.load(Ordering::Relaxed) {
                return;
            }
            let ok = match step {
                Step::State(_, st) => run(Box::new(move |s| s.state = st)),
                Step::Info(_, t) => run(Box::new(move |s| s.items.push(Item::Info(t)))),
                Step::Tool(_, name, summary, output) => {
                    let n = js_len(&output) + js_len(&summary);
                    run(Box::new(move |s| {
                        let id = format!("demo-{}", s.items.len());
                        s.apply(vec![Ev::Tool { id, name: name.into(), summary }], false);
                        s.tokens += n.div_ceil(4);
                    }))
                }
                Step::Agent(_, text, 0) => {
                    let n = js_len(&text).div_ceil(4);
                    run(Box::new(move |s| {
                        s.apply(vec![Ev::Text(text)], false);
                        s.tokens += n;
                    }))
                }
                Step::Agent(_, text, ms) => {
                    // word by word, a token each, then the reply settles
                    let words: Vec<String> = text.split(' ').map(str::to_string).collect();
                    let mut ok = true;
                    for (i, w) in words.into_iter().enumerate() {
                        if i > 0 {
                            std::thread::sleep(Duration::from_millis(ms));
                        }
                        if stop_flag.load(Ordering::Relaxed) {
                            return;
                        }
                        let piece = if i > 0 { format!(" {w}") } else { w };
                        ok = run(Box::new(move |s| {
                            s.apply(vec![Ev::TextDelta(piece)], false);
                            s.tokens += 1;
                        }));
                        if !ok {
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(ms));
                    ok && run(Box::new(move |s| s.apply(vec![Ev::Text(text)], false)))
                }
            };
            if !ok {
                return;
            }
        }
    });
}

/// A prompt to a demo agent: it answers that there's no model behind it.
pub fn send(app: &mut App, slot: usize, text: String) {
    let s = &mut app.sessions[slot];
    s.items.push(Item::User(text));
    s.state = State::Running;
    play(
        app,
        slot,
        vec![
            Step::Agent(500, "Got it — I'll take a look and get back to you. (demo mode: no model behind this session)".into(), 60),
            Step::State(200, State::Idle),
        ],
    );
}

/// End the script a demo agent is playing.
pub fn stop(app: &mut App, slot: usize) {
    if let Some(f) = app.serve.plays.remove(&slot) {
        f.store(true, Ordering::Relaxed);
    }
}

/// A new agent in demo mode: scripted, its worktree only shown (src/cli.ts newSession).
pub fn start_agent(app: &mut App, name: &str, model: Option<String>, worktree: Option<bool>) -> usize {
    let with_worktree = worktree != Some(false) && app.config.worktree.enabled;
    let branch = with_worktree.then(|| crate::names::branch_name_with(name, &app.config.worktree.branch));
    let model = model.or_else(|| app.config.model.clone()).unwrap_or_else(|| "claude-sonnet-4-5".into());
    let s = agent(name, &model, branch.clone(), (0, 0));
    match &branch {
        Some(b) => app.say(format!("'{name}' on {b}"), "ModeMsg"),
        None => app.say(format!("'{name}' in this checkout"), "ModeMsg"),
    }
    app.add_session(s, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_races_three_scripted_agents() {
        let mut app = crate::app::tests::app();
        app.serve.demo = true;
        crate::commands::exec(&mut app, "race add dark mode");
        let names: Vec<&str> = app.sessions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["add dark mode claude", "add dark mode codex", "add dark mode gemini"]);
        assert!(app.sessions.iter().all(|s| s.state == State::Running), "{}", app.message.0);
    }

    #[test]
    fn three_scripted_agents() {
        let all = sessions();
        let names: Vec<&str> = all.iter().map(|(s, _)| s.name.as_str()).collect();
        assert_eq!(names, ["auth-refactor", "fix-flaky-test", "docs-pass"]);
        assert_eq!(all[0].0.branch.as_deref(), Some("refactor/auth"), "branchName(name), as src/demo.ts");
        assert_eq!(all[0].0.stat, (41, 18));
        assert_eq!(all[2].0.branch, None);
        assert!(matches!(all[1].1.last(), Some(Step::State(200, State::Waiting))));
    }

    #[test]
    fn a_script_plays_and_a_prompt_gets_its_answer() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut app = crate::app::tests::app();
        app.tx = tx;
        app.serve.demo = true;
        let slot = start_agent(&mut app, "try it", None, Some(false));
        assert_eq!(app.message.0, "'try it' in this checkout");
        play(&mut app, slot, vec![Step::Agent(0, "one two three".into(), 1), Step::Tool(0, "bash", "ls".into(), "a".into()), Step::State(0, State::Waiting)]);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while app.sessions[slot].state != State::Waiting && std::time::Instant::now() < deadline {
            if let Ok(Msg::Run(f)) = rx.recv_timeout(Duration::from_millis(50)) {
                f(&mut app);
            }
        }
        let s = &app.sessions[slot];
        assert_eq!(s.items, vec![Item::Text("one two three".into()), Item::Tool { id: "demo-1".into(), name: "bash".into(), summary: "ls".into() }]);
        assert_eq!(s.tokens, 3 + 1);
        assert_eq!(s.streaming_at(), None);
        // a prompt: the answer streams in, then it's idle; an abort ends it early
        send(&mut app, slot, "hello".into());
        assert_eq!(app.sessions[slot].state, State::Running);
        app.sessions[slot].abort();
        std::thread::sleep(Duration::from_millis(800));
        while let Ok(Msg::Run(f)) = rx.try_recv() {
            f(&mut app);
        }
        assert_eq!(app.sessions[slot].items.last(), Some(&Item::User("hello".into())), "aborted: no answer");
        assert_eq!(app.sessions[slot].state, State::Idle);
    }
}
