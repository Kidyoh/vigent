//! Scripted demo sessions so the UI can be explored without an agent CLI or
//! an API key (src/demo.ts, DemoSession in src/session.ts). `vigent --demo`
//! starts them; so does a machine where nothing can run agents (no Claude
//! Code, Codex or OpenCode, and pi without a key).
//!
//! A demo agent never touches your repository: its branch is only shown.
//! Its script plays on a thread that sends each step to the UI thread.

use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::app::{App, Msg};
use crate::session::{Item, Session, State};

/// One step of a demo script.
#[derive(Clone)]
pub enum Step {
    State(State),
    /// a reply; streamed a word at a time every `stream_ms` (0: all at once)
    Agent { text: &'static str, stream_ms: u64 },
    Tool { name: &'static str, summary: &'static str, output: &'static str },
}

/// Why vigent starts in demo mode by itself.
pub const AUTO_DEMO_NOTE: &str = "demo mode: these agents are scripted. For real ones, install and sign in to Claude Code, Codex or OpenCode, or set ANTHROPIC_API_KEY, then restart (:checkhealth)";

const PI_KEYS: [&str; 8] = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"];

/// pi is installed and has a key, a saved login or providers of its own (src/engines.ts detectPi).
pub fn pi_connected() -> bool {
    if !crate::engines::on_path("pi") {
        return false;
    }
    if PI_KEYS.iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty())) {
        return true;
    }
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
    let dir = match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(d) if !d.is_empty() => d.strip_prefix("~/").map(|r| home.join(r)).unwrap_or_else(|| d.into()),
        _ => home.join(".pi").join("agent"),
    };
    let has = |file: &str, key: Option<&str>| {
        std::fs::read_to_string(dir.join(file))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .map(|v| {
                let v = match key {
                    Some(k) => v.get(k).cloned().unwrap_or_default(),
                    None => v,
                };
                v.as_object().is_some_and(|o| !o.is_empty())
            })
            .unwrap_or(false)
    };
    has("auth.json", None) || has("models.json", Some("providers"))
}

/// Nothing here can run a real agent: no engine chosen, pi without a key, no CLI on PATH.
pub fn nothing_can_run(config: &crate::config::Config, engine_flag: Option<&str>) -> bool {
    let chosen = engine_flag.or(config.engine.as_deref().filter(|e| *e != "auto"));
    let any_cli = ["claude", "codex", "opencode"].iter().any(|b| crate::engines::on_path(b)) || config.custom_engines.iter().any(|e| e.command.first().is_some_and(|c| crate::engines::on_path(c)));
    chosen.is_none() && !pi_connected() && !any_cli
}

fn agent(app: &mut App, name: &str, model: &str, branch: bool, stat: (usize, usize), prompt: &str) -> usize {
    let slot = app.sessions.len();
    let mut s = Session::new(slot, name, "pi", app.cwd.clone());
    s.model = Some(model.into());
    if branch {
        s.branch = Some(crate::names::branch_name(name));
    }
    s.stat = stat;
    s.items.push(Item::User(prompt.into()));
    app.sessions.push(s);
    slot
}

/// The three demo agents, playing their scripts (src/demo.ts createDemoSessions).
pub fn start(app: &mut App) {
    app.cfg.demo = true;
    let auth = agent(app, "auth-refactor", "claude-sonnet-5-5", true, (41, 18), "Refactor the session middleware to use the new token store.");
    play(
        app,
        auth,
        vec![
            (300, Step::State(State::Running)),
            (400, Step::Agent { text: "I'll start by reading the current middleware to understand how sessions are validated today.", stream_ms: 90 }),
            (
                500,
                Step::Tool {
                    name: "read",
                    summary: "src/middleware/auth.ts",
                    output: "import { verify } from '../lib/jwt';\n\nexport async function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).end();\n  // legacy: validates against the jwt secret directly\n  const claims = verify(token, process.env.JWT_SECRET);\n  req.user = claims.sub;\n  next();\n}",
                },
            ),
            (
                900,
                Step::Tool {
                    name: "edit",
                    summary: "src/middleware/auth.ts (+41 −18)",
                    output: "- const claims = verify(token, process.env.JWT_SECRET);\n- req.user = claims.sub;\n+ const session = await tokenStore.resolve(token);\n+ if (!session) return res.status(401).end();\n+ req.user = session.userId;",
                },
            ),
            (800, Step::Tool { name: "bash", summary: "npm test -- auth", output: "PASS test/middleware/auth.test.ts\n  ✓ rejects missing token (3 ms)\n  ✓ resolves session from TokenStore (5 ms)\n  ✓ rejects revoked tokens (2 ms)\n\nTests: 14 passed, 14 total" }),
            (
                700,
                Step::Agent {
                    text: "Done. The middleware now resolves tokens through **TokenStore** instead of verifying JWTs inline:\n- revoked tokens are rejected with a `401`\n- all 14 tests pass\n```ts\nconst session = await tokenStore.resolve(token);\nif (!session) return res.status(401).end();\n```\nWant me to update the docs too?",
                    stream_ms: 80,
                },
            ),
            (300, Step::State(State::Waiting)),
        ],
    );
    let flaky = agent(app, "fix-flaky-test", "claude-haiku-5-5", true, (6, 2), "The checkout e2e test fails ~1 in 5 runs. Find the race and fix it.");
    play(
        app,
        flaky,
        vec![
            (1200, Step::State(State::Running)),
            (600, Step::Agent { text: "Reproducing first — running the suite 10 times to catch the failure.", stream_ms: 110 }),
            (1500, Step::Tool { name: "bash", summary: "for i in $(seq 10); do npm run e2e -- checkout; done", output: "run 1..6: pass\nrun 7: FAIL expected cart badge '3', got '2'\nrun 8..10: pass" }),
            (
                2500,
                Step::Agent {
                    text: "Caught it: the badge assertion runs before the cart mutation settles. The test clicks 'add' and asserts immediately instead of awaiting the network idle. Fixing with a proper waitFor on the cart response.",
                    stream_ms: 120,
                },
            ),
            (200, Step::State(State::Waiting)),
        ],
    );
    let docs = agent(app, "docs-pass", "claude-haiku-5-5", false, (0, 0), "Sweep the README for stale CLI flags.");
    play(
        app,
        docs,
        vec![
            (500, Step::Agent { text: "Swept README.md and docs/cli.md: fixed 3 stale flags (--watch → --dev, removed --legacy-peer, documented --json). Committed as docs: refresh CLI flags.", stream_ms: 0 }),
            (100, Step::State(State::Idle)),
        ],
    );
    app.focus = 0;
}

/// A demo agent's own scripted answer to a prompt (DemoSession.send).
pub fn send(app: &mut App, i: usize, text: String) {
    let s = &mut app.sessions[i];
    s.items.push(Item::User(text));
    s.state = State::Running;
    play(app, i, vec![(500, Step::Agent { text: "Got it — I'll take a look and get back to you. (demo mode: no model behind this session)", stream_ms: 60 }), (200, Step::State(State::Idle))]);
}

/// A new agent in demo mode: shown with its branch, nothing made.
pub fn start_agent(app: &mut App, name: &str) -> usize {
    let slot = app.sessions.len();
    let mut s = Session::new(slot, name, "pi", app.cwd.clone());
    s.model = Some("claude-sonnet-4-5".into());
    if app.root.is_some() && app.config.worktree.enabled {
        s.branch = Some(crate::names::branch_name(name));
    }
    app.sessions.push(s);
    app.focus = slot;
    slot
}

fn run(tx: &Sender<Msg>, f: impl FnOnce(&mut App) + Send + 'static) -> bool {
    tx.send(Msg::Run(Box::new(f))).is_ok()
}

/// Play a script on a thread: each step after its delay.
pub fn play(app: &mut App, slot: usize, steps: Vec<(u64, Step)>) {
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        for (delay, step) in steps {
            std::thread::sleep(Duration::from_millis(delay));
            let ok = match step {
                Step::State(st) => run(&tx, move |a| {
                    if let Some(s) = a.sessions.get_mut(slot) {
                        // finished while you looked elsewhere: waiting; here, idle
                        s.state = if st == State::Waiting && a.focus == slot { State::Idle } else { st };
                    }
                }),
                Step::Tool { name, summary, output } => run(&tx, move |a| {
                    if let Some(s) = a.sessions.get_mut(slot) {
                        s.items.push(Item::Tool { id: String::new(), name: name.into(), summary: summary.into() });
                        s.tokens += (output.len() + summary.len()).div_ceil(4) as u64;
                    }
                }),
                Step::Agent { text, stream_ms: 0 } => run(&tx, move |a| {
                    if let Some(s) = a.sessions.get_mut(slot) {
                        s.items.push(Item::Text(text.into()));
                        s.tokens += text.len().div_ceil(4) as u64;
                    }
                }),
                Step::Agent { text, stream_ms } => {
                    let mut ok = run(&tx, move |a| {
                        if let Some(s) = a.sessions.get_mut(slot) {
                            s.items.push(Item::Text(String::new()));
                        }
                    });
                    for (n, word) in text.split(' ').enumerate() {
                        if !ok {
                            break;
                        }
                        let w = if n > 0 { format!(" {word}") } else { word.to_string() };
                        ok = run(&tx, move |a| {
                            if let Some(s) = a.sessions.get_mut(slot)
                                && let Some(Item::Text(t)) = s.items.last_mut()
                            {
                                t.push_str(&w);
                                s.tokens += 1;
                            }
                        });
                        std::thread::sleep(Duration::from_millis(stream_ms));
                    }
                    ok
                }
            };
            if !ok {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_scripted_agents() {
        let mut a = crate::app::tests::app();
        start(&mut a);
        assert!(a.cfg.demo);
        let names: Vec<&str> = a.sessions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["auth-refactor", "fix-flaky-test", "docs-pass"]);
        assert_eq!(a.sessions[0].branch.as_deref(), Some(crate::names::branch_name("auth-refactor").as_str()));
        assert_eq!(a.sessions[2].branch, None);
    }
}
