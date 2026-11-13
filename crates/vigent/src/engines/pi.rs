//! A pi agent: your installed pi, in its RPC mode (`pi --mode rpc`), as
//! src/pi-session.ts runs it.
//!
//! One long-running pi per agent, in the agent's worktree. pi runs its own
//! loop (tools, retries, compaction, extensions, skills, prompt templates);
//! vigent sends prompts over stdin and draws what pi streams back on stdout.
//! Extensions' dialogs (confirm, select, input) come over the same pipe and
//! vigent answers them with a picker. The conversation lives in pi's session
//! file, in git's record of the worktree, so the agent survives a restart
//! (`--session-dir <dir> --continue`).
//!
//! Everything here runs on the UI thread with the App: the threads reading
//! pi's output send each line back as Msg::Run.

use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::common::{extract_text, js_string, summarize_args, truthy};
use crate::app::{App, Msg};
use crate::session::{Item, State};

/// What to do when pi isn't there at all.
pub const PI_MISSING_HINT: &str = "this agent runs on pi, which isn't installed. Install pi and send again, or press Esc and type :new <task> to start an agent on your default engine (:engine picks it, e.g. Claude Code or Codex); :kill removes this one.";

/// What to do when pi can't get through: this agent stays on pi, so start one elsewhere.
pub const PI_KEY_HINT: &str = "this agent runs on pi, and pi has no working API key. Agents keep the engine they started on: press Esc and type :new <task> to start one on the default engine (:engine picks it, e.g. Claude Code or Codex with your existing login); :kill removes this one.";

/// A response's callback: Ok(data) or Err(why).
type Cb = Box<dyn FnOnce(&mut App, usize, Result<Value, String>) + Send>;
/// What waits for pi to be ready.
type Then = Box<dyn FnOnce(&mut App, usize, Result<(), String>) + Send>;

/// One agent's pi process.
pub struct Pi {
    child: Child,
    stdin: Option<ChildStdin>,
    /// which start this is (lines from an older pi are ignored)
    start_id: u64,
    seq: u64,
    pending: HashMap<String, Cb>,
    /// pi has answered get_state (and what follows it)
    ready: bool,
    waiting: Vec<Then>,
    stderr: Arc<Mutex<String>>,
    pub session_file: Option<String>,
    /// a run started since the last prompt went out (an extension command may run none)
    run_started: bool,
    /// the run ended on a failed request
    failed: bool,
    /// the reply being streamed: its item
    streaming: Option<usize>,
    tools: HashMap<String, usize>,
    /// don't announce "resumed" for a restart vigent did itself
    quiet_resume: bool,
    /// what pi loaded (get_commands), for :pi
    pub commands: Vec<Value>,
    pub extension_errors: Vec<(String, String)>,
    /// statuses extensions keep up to date (ctx.ui.setStatus), shown in the winbar
    pub extension_status: BTreeMap<String, String>,
}

impl Drop for Pi {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static GEN: AtomicU64 = AtomicU64::new(1);

/// Where pi keeps an agent's conversation: git's record of its worktree (src/agents.ts sessionDir).
pub fn session_dir(worktree: &std::path::Path) -> Option<PathBuf> {
    crate::records::agent_state_dir(worktree).map(|d| d.join("sessions"))
}

/// pi's arguments for an agent (src/pi-session.ts args).
pub fn args(model: Option<&str>, effort: Option<&str>, session_dir: Option<&std::path::Path>, extra: &[String]) -> Vec<String> {
    let mut a = vec!["--mode".to_string(), "rpc".into()];
    match session_dir {
        Some(d) => a.extend(["--session-dir".into(), d.to_string_lossy().into_owned(), "--continue".into()]),
        None => a.push("--no-session".into()),
    }
    if let Some(m) = model.filter(|m| !m.is_empty() && *m != "default" && *m != "pi") {
        a.extend(["--model".into(), m.into()]);
    }
    if let Some(e) = effort {
        a.extend(["--thinking".into(), e.into()]);
    }
    a.extend(extra.iter().cloned());
    a
}

fn signal_name(sig: i32) -> String {
    match sig {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        n => format!("signal {n}"),
    }
}

/// Start pi for agent `i`, in its folder. Errors say why (and the agent's transcript too).
fn start(app: &mut App, i: usize) -> Result<(), String> {
    let s = &app.sessions[i];
    let dir = if s.made.is_some() { session_dir(&s.path) } else { None };
    let extra = app.config.engine_options("pi").and_then(|o| o.args.clone()).unwrap_or_default();
    let model = s.requested_model.clone().or_else(|| s.model.clone());
    let a = args(model.as_deref(), s.effort.as_deref(), dir.as_deref(), &extra);
    let mut cmd = Command::new(super::bin("pi"));
    cmd.args(&a).current_dir(&s.path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let why = if e.kind() == std::io::ErrorKind::NotFound { format!("pi isn't installed: {}", super::PI_INSTALL) } else { format!("couldn't start pi: {e}") };
            lost(app, i, why.clone());
            return Err(why);
        }
    };
    let start_id = GEN.fetch_add(1, Ordering::Relaxed);
    let stdout = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let stderr = Arc::new(Mutex::new(String::new()));
    let keep = Arc::clone(&stderr);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = err.read(&mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(mut s) = keep.lock() {
                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                let over = s.chars().count().saturating_sub(4000);
                if over > 0 {
                    *s = s.chars().skip(over).collect();
                }
            }
        }
    });
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        // pi's framing: JSON lines split on \n only (a JSON string may hold U+2028)
        let mut reader = BufReader::new(stdout);
        let mut buf = vec![];
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end_matches('\n').trim_end_matches('\r');
            if line.trim().is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(line) else { continue }; // not ours (a stray print)
            if tx.send(Msg::Run(Box::new(move |app| on_line(app, i, start_id, msg)))).is_err() {
                return;
            }
        }
        let _ = tx.send(Msg::Run(Box::new(move |app| on_exit(app, i, start_id))));
    });
    let stdin = child.stdin.take();
    app.sessions[i].pi = Some(Box::new(Pi {
        child,
        stdin,
        start_id,
        seq: 0,
        pending: HashMap::new(),
        ready: false,
        waiting: vec![],
        stderr,
        session_file: None,
        run_started: false,
        failed: false,
        streaming: None,
        tools: HashMap::new(),
        quiet_resume: false,
        commands: vec![],
        extension_errors: vec![],
        extension_status: BTreeMap::new(),
    }));
    request(app, i, json!({"type": "get_state"}), Box::new(on_first_state));
    Ok(())
}

/// pi answered its first get_state: what it's using, and the conversation it continues.
fn on_first_state(app: &mut App, i: usize, r: Result<Value, String>) {
    let state = match r {
        Ok(v) => v,
        Err(e) => return fail_waiting(app, i, e),
    };
    apply_state(app, i, &state);
    if state["messageCount"].as_u64().unwrap_or(0) > 0 {
        request(
            app,
            i,
            json!({"type": "get_messages"}),
            Box::new(|app, i, r| {
                match r {
                    Ok(data) => {
                        let s = &mut app.sessions[i];
                        let restored = items_from_messages(data["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]));
                        let prompts = restored.items.iter().filter(|x| matches!(x, Item::User(_))).count();
                        s.items.extend(restored.items);
                        s.tokens += restored.tokens;
                        s.cost += restored.cost.unwrap_or(0.0);
                        if !s.pi.as_ref().is_some_and(|p| p.quiet_resume) {
                            s.items.push(Item::Info(format!("resumed: {prompts} earlier prompts")));
                        }
                        app.refresh_stat(i);
                    }
                    Err(e) => return fail_waiting(app, i, e),
                }
                load_commands(app, i);
            }),
        );
    } else {
        load_commands(app, i);
    }
}

fn load_commands(app: &mut App, i: usize) {
    if let Some(p) = app.sessions[i].pi.as_mut() {
        p.quiet_resume = false;
    }
    request(
        app,
        i,
        json!({"type": "get_commands"}),
        Box::new(|app, i, r| {
            // an older pi: :pi shows less
            if let (Ok(data), Some(p)) = (r, app.sessions[i].pi.as_mut()) {
                p.commands = data["commands"].as_array().cloned().unwrap_or_default();
            }
            let Some(p) = app.sessions[i].pi.as_mut() else { return };
            p.ready = true;
            let waiting = std::mem::take(&mut p.waiting);
            for then in waiting {
                then(app, i, Ok(()));
            }
        }),
    );
}

fn fail_waiting(app: &mut App, i: usize, why: String) {
    let waiting = app.sessions[i].pi.as_mut().map(|p| std::mem::take(&mut p.waiting)).unwrap_or_default();
    for then in waiting {
        then(app, i, Err(why.clone()));
    }
}

/// What pi says it's using: the model and thinking level, and its session file.
fn apply_state(app: &mut App, i: usize, state: &Value) {
    let s = &mut app.sessions[i];
    if let Some(p) = s.pi.as_mut()
        && let Some(f) = state["sessionFile"].as_str()
    {
        p.session_file = Some(f.into());
    }
    let m = &state["model"];
    let shown = s.requested_model.clone().or_else(|| s.model.clone());
    if let Some(id) = m["id"].as_str().filter(|id| !id.is_empty() && *id != "unknown")
        && shown.as_deref().is_none_or(|m| m == "default" || m == "pi")
    {
        s.model = Some(match m["provider"].as_str().filter(|p| !p.is_empty()) {
            Some(p) => format!("{p}/{id}"),
            None => id.into(),
        });
        if s.requested_model.as_deref() == Some("default") {
            s.requested_model = None;
        }
    }
    if let Some(t) = state["thinkingLevel"].as_str().filter(|t| !t.is_empty() && *t != "off") {
        s.effort = Some(t.into());
    }
}

/// Send a command to agent `i`'s pi; `cb` gets its response.
fn request(app: &mut App, i: usize, mut cmd: Value, cb: Cb) {
    let Some(p) = app.sessions.get_mut(i).and_then(|s| s.pi.as_mut()) else {
        return cb(app, i, Err("pi isn't running".into()));
    };
    p.seq += 1;
    let id = format!("v{}", p.seq);
    cmd["id"] = id.clone().into();
    let ok = p.stdin.as_mut().is_some_and(|w| writeln!(w, "{cmd}").and_then(|_| w.flush()).is_ok());
    if !ok {
        return cb(app, i, Err("pi isn't running".into()));
    }
    p.pending.insert(id, cb);
}

/// A message that needs no answer.
fn write(app: &mut App, i: usize, msg: Value) {
    if let Some(w) = app.sessions.get_mut(i).and_then(|s| s.pi.as_mut()).and_then(|p| p.stdin.as_mut()) {
        let _ = writeln!(w, "{msg}").and_then(|_| w.flush());
    }
}

/// Make sure pi is running (it starts again after it stopped; a saved conversation continues), then `then`.
fn alive(app: &mut App, i: usize, then: Then) {
    if app.sessions[i].pi.is_none()
        && let Err(e) = start(app, i)
    {
        return then(app, i, Err(e));
    }
    let p = app.sessions[i].pi.as_mut().expect("started");
    if p.ready {
        then(app, i, Ok(()));
    } else {
        p.waiting.push(then);
    }
}

/// Start pi now, so it's ready (and shows its model) before the first prompt.
pub fn warm(app: &mut App, i: usize) {
    if app.sessions[i].pi.is_none() {
        let _ = start(app, i);
    }
}

/// A prompt for agent `i`.
pub fn send(app: &mut App, i: usize, text: String) {
    let s = &mut app.sessions[i];
    s.items.push(Item::User(text.clone()));
    s.state = State::Running;
    s.aborted = false;
    alive(
        app,
        i,
        Box::new(move |app, i, r| {
            if let Err(e) = r {
                return send_failed(app, i, e);
            }
            if let Some(p) = app.sessions[i].pi.as_mut() {
                p.run_started = false;
            }
            // pi reports agent_end a moment before it's idle: a prompt sent right then queues instead of failing
            request(
                app,
                i,
                json!({"type": "prompt", "message": text, "streamingBehavior": "followUp"}),
                Box::new(|app, i, r| {
                    if let Err(e) = r {
                        return send_failed(app, i, e);
                    }
                    // an extension command (/name) runs no turn: nothing else will end it
                    request(
                        app,
                        i,
                        json!({"type": "get_state"}),
                        Box::new(|app, i, r| match r {
                            Ok(st) => {
                                let started = app.sessions[i].pi.as_ref().is_some_and(|p| p.run_started);
                                if !started && !truthy(&st["isStreaming"]) && app.sessions[i].state == State::Running {
                                    finish(app, i, false);
                                }
                            }
                            Err(e) => send_failed(app, i, e),
                        }),
                    );
                }),
            );
        }),
    );
}

fn send_failed(app: &mut App, i: usize, msg: String) {
    let s = &mut app.sessions[i];
    if s.state == State::Error {
        return; // already said (pi stopped)
    }
    let lower = msg.to_lowercase();
    let key = ["api key", "login", "auth", "no model"].iter().any(|w| lower.contains(w));
    s.items.push(Item::Error(format!("error: {}", if key { msg.lines().next().unwrap_or("") } else { &msg })));
    if key {
        s.items.push(Item::Info(PI_KEY_HINT.into()));
    }
    s.state = State::Error;
}

/// A run ended: idle (or waiting, when you look elsewhere), and the next queued prompt goes.
fn finish(app: &mut App, i: usize, failed: bool) {
    let focused = app.focus == i;
    let s = &mut app.sessions[i];
    if s.state != State::Paused {
        s.state = if failed { State::Error } else if focused { State::Idle } else { State::Waiting };
    }
    app.refresh_stat(i);
    app.drain(i);
}

/// Stop the current run (pi keeps running).
pub fn abort(app: &mut App, i: usize) {
    request(app, i, json!({"type": "abort"}), Box::new(|_, _, _| {}));
}

/// Write an abort without a callback (from Session::abort, which has no App).
pub fn abort_now(p: &mut Pi) {
    p.seq += 1;
    let id = format!("v{}", p.seq);
    if let Some(w) = p.stdin.as_mut() {
        let _ = writeln!(w, "{}", json!({"type": "abort", "id": id})).and_then(|_| w.flush());
    }
}

/// pi exited or never started: fail what's waiting; the next prompt starts it again.
fn lost(app: &mut App, i: usize, why: String) {
    let pi = app.sessions[i].pi.take();
    let (pending, waiting) = match pi {
        Some(mut p) => (std::mem::take(&mut p.pending), std::mem::take(&mut p.waiting)),
        None => (HashMap::new(), vec![]),
    };
    let s = &mut app.sessions[i];
    let text = format!("error: {why}");
    // a prompt was waiting: answer it, every time (at startup, once is enough)
    let prompted = matches!(s.state, State::Running | State::Waiting);
    if !s.closed && (prompted || !s.items.iter().any(|x| matches!(x, Item::Error(t) if *t == text))) {
        s.items.push(Item::Error(text));
        if why.starts_with("pi isn't installed") {
            s.items.push(Item::Info(PI_MISSING_HINT.into()));
        }
    }
    if prompted {
        s.state = State::Error;
    }
    for (_, cb) in pending {
        cb(app, i, Err(why.clone()));
    }
    for then in waiting {
        then(app, i, Err(why.clone()));
    }
}

fn on_exit(app: &mut App, i: usize, start_id: u64) {
    let Some(p) = app.sessions.get_mut(i).and_then(|s| s.pi.as_mut()).filter(|p| p.start_id == start_id) else { return };
    let status = p.child.wait().ok();
    let tail = p.stderr.lock().map(|s| s.trim().lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")).unwrap_or_default();
    let how = match status {
        #[cfg(unix)]
        Some(st) if std::os::unix::process::ExitStatusExt::signal(&st).is_some() => signal_name(std::os::unix::process::ExitStatusExt::signal(&st).unwrap_or(0)),
        Some(st) => format!("exit {}", st.code().unwrap_or(1)),
        None => "exit 1".into(),
    };
    let why = format!("pi stopped ({how}){}", if tail.is_empty() { String::new() } else { format!(": {tail}") });
    lost(app, i, why);
}

/// One line from pi: a response, a dialog from an extension, or an event.
pub fn on_line(app: &mut App, i: usize, start_id: u64, msg: Value) {
    let Some(p) = app.sessions.get_mut(i).and_then(|s| s.pi.as_mut()).filter(|p| p.start_id == start_id) else { return };
    match msg["type"].as_str() {
        Some("response") => {
            let Some(cb) = msg["id"].as_str().and_then(|id| p.pending.remove(id)) else { return };
            let r = if msg["success"] == false {
                Err(if msg["error"].is_null() { format!("pi refused {}", js_string(&msg["command"])) } else { js_string(&msg["error"]) })
            } else {
                Ok(msg["data"].clone())
            };
            cb(app, i, r);
        }
        Some("extension_ui_request") => on_ui_request(app, i, msg),
        _ => on_event(app, i, &msg),
    }
}

fn one_line(v: &Value) -> String {
    let s = if v.is_null() { String::new() } else { js_string(v) };
    s.lines().next().unwrap_or("").chars().take(200).collect()
}

fn short_ext_path(p: &Value) -> String {
    let s = if p.is_null() { "extension".to_string() } else { js_string(p) };
    let parts: Vec<&str> = s.split(['/', '\\']).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}

fn on_event(app: &mut App, i: usize, e: &Value) {
    let s = &mut app.sessions[i];
    let Some(p) = s.pi.as_mut() else { return };
    let info = |s: &mut crate::session::Session, t: String| s.items.push(Item::Info(t));
    match e["type"].as_str().unwrap_or("") {
        "agent_start" => {
            p.run_started = true;
            p.failed = false;
            s.state = State::Running;
        }
        "agent_end" => {
            let failed = p.failed;
            finish(app, i, failed);
            request(
                app,
                i,
                json!({"type": "get_state"}),
                Box::new(|app, i, r| {
                    if let Ok(st) = r {
                        apply_state(app, i, &st);
                    }
                }),
            );
        }
        "message_start" => {
            if e["message"]["role"] == "assistant" {
                s.items.push(Item::Text(String::new()));
                p.streaming = Some(s.items.len() - 1);
            }
        }
        "message_update" => {
            if let Some(j) = p.streaming
                && !e["message"]["content"].is_null()
                && let Some(Item::Text(t)) = s.items.get_mut(j)
            {
                *t = extract_text(&e["message"]["content"]);
            }
        }
        "message_end" => {
            let m = &e["message"];
            if m["role"] != "assistant" {
                return;
            }
            if let Some(j) = p.streaming.take() {
                if let Some(Item::Text(t)) = s.items.get_mut(j)
                    && !m["content"].is_null()
                {
                    *t = extract_text(&m["content"]);
                }
                if matches!(s.items.get(j), Some(Item::Text(t)) if t.is_empty()) {
                    s.items.remove(j); // a turn that only called tools
                }
            }
            if m["usage"].is_object() {
                s.tokens += usage_tokens(&m["usage"]);
                s.cost += m["usage"]["cost"]["total"].as_f64().unwrap_or(0.0);
            }
            // a failed request ends the reply with an error instead of throwing: say so
            if let Some(err) = pi_error(m) {
                p.failed = true;
                s.items.push(Item::Error(err));
            }
        }
        "tool_execution_start" => {
            s.items.push(Item::Tool { id: js_string(&e["toolCallId"]), name: js_string(&e["toolName"]), summary: summarize_args(&e["args"]) });
            if truthy(&e["toolCallId"]) {
                p.tools.insert(js_string(&e["toolCallId"]), s.items.len() - 1);
            }
        }
        "tool_execution_end" => {
            p.tools.remove(&js_string(&e["toolCallId"]));
            app.refresh_stat(i);
        }
        "auto_retry_start" => info(s, format!("retrying ({}/{}) after: {}", js_string(&e["attempt"]), js_string(&e["maxAttempts"]), one_line(&e["errorMessage"]))),
        "auto_retry_end" => {
            if !truthy(&e["success"]) && truthy(&e["finalError"]) {
                info(s, format!("gave up after {} tries: {}", js_string(&e["attempt"]), one_line(&e["finalError"])));
            }
        }
        "compaction_start" => info(s, format!("compacting the conversation ({})…", js_string(&e["reason"]))),
        "compaction_end" => {
            if truthy(&e["errorMessage"]) {
                info(s, format!("compaction failed: {}", one_line(&e["errorMessage"])));
            } else if !truthy(&e["aborted"]) {
                info(s, "conversation compacted".into());
            }
        }
        "extension_error" => {
            let at = if truthy(&e["event"]) { format!(", {}", js_string(&e["event"])) } else { String::new() };
            let where_ = format!("{}{at}", short_ext_path(&e["extensionPath"]));
            let path = if e["extensionPath"].is_null() { "extension".to_string() } else { js_string(&e["extensionPath"]) };
            let error = if e["error"].is_null() { "failed".to_string() } else { js_string(&e["error"]) };
            p.extension_errors.retain(|(k, _)| *k != path);
            p.extension_errors.push((path, error));
            info(s, format!("extension error ({where_}): {}", js_string(&e["error"])));
        }
        _ => {}
    }
}

/// An extension asked something (or said something): answer the dialogs with a picker, show the rest.
fn on_ui_request(app: &mut App, i: usize, req: Value) {
    let id = req["id"].clone();
    let str_of = |v: &Value| if v.is_null() { String::new() } else { js_string(v) };
    let who = format!("'{}'", app.sessions[i].name);
    let one = |t: &str| t.replace('\u{FE0F}', "").split_whitespace().collect::<Vec<_>>().join(" ");
    let method = req["method"].as_str().unwrap_or("").to_string();
    let reply = move |app: &mut App, i: usize, answer: Value| {
        let mut m = json!({"type": "extension_ui_response", "id": id});
        if let (Some(m), Some(a)) = (m.as_object_mut(), answer.as_object()) {
            m.extend(a.clone());
        }
        write(app, i, m);
    };
    // while you're asked, the agent waits for you
    let was = app.sessions[i].state;
    let ask = move |app: &mut App, i: usize, title: String, choices: Vec<super::Choice>, custom: bool, key: &'static str| {
        if was == State::Running {
            app.sessions[i].state = State::Waiting;
        }
        let rows = Some(if custom { 3 } else { choices.len().clamp(3, 10) });
        let done: super::picker::Done = Box::new(move |app, v| {
            let answer = match (key, v) {
                ("confirmed", Some(v)) => json!({"confirmed": v == "yes"}),
                ("confirmed", None) => json!({"confirmed": false}),
                (_, Some(v)) => json!({ "value": v }),
                (_, None) => json!({"cancelled": true}),
            };
            reply(app, i, answer);
            if app.sessions[i].state == State::Waiting {
                app.sessions[i].state = was;
            }
        });
        let mut p = super::picker::Picker::new(&title, Some(choices), "", custom, rows, done);
        p.searching = custom;
        super::picker::open(app, p);
    };
    match method.as_str() {
        "select" => {
            let options: Vec<super::Choice> = req["options"].as_array().into_iter().flatten().map(|o| super::Choice::new(&js_string(o), None, None)).collect();
            ask(app, i, format!("{who} · {}", one(&str_of(&req["title"]))), options, false, "value");
        }
        "confirm" => {
            let text = [str_of(&req["title"]), str_of(&req["message"])].iter().filter(|t| !t.is_empty()).map(|t| one(t)).collect::<Vec<_>>().join(": ");
            let yn = vec![super::Choice::new("yes", None, None), super::Choice::new("no", None, None)];
            ask(app, i, format!("{who} {text} (y/n)"), yn, false, "confirmed");
        }
        "input" | "editor" => {
            let hint = if method == "input" { &req["placeholder"] } else { &req["prefill"] };
            let extra = if truthy(hint) { format!(" ({})", one(&js_string(hint))) } else { String::new() };
            ask(app, i, format!("{who} · {}{extra}", one(&str_of(&req["title"]))), vec![], true, "value");
        }
        "notify" => {
            let message = str_of(&req["message"]);
            app.sessions[i].items.push(Item::Info(message.clone()));
            let group = match req["notifyType"].as_str() {
                Some("error") => "ErrorMsg",
                Some("warning") => "WarningMsg",
                _ => "ModeMsg",
            };
            app.say(format!("{who}: {message}"), group);
        }
        "setStatus" => {
            let key = if req["statusKey"].is_null() { "status".to_string() } else { js_string(&req["statusKey"]) };
            if let Some(p) = app.sessions[i].pi.as_mut() {
                match req["statusText"].as_str().filter(|t| !t.is_empty()) {
                    Some(t) => {
                        p.extension_status.insert(key, t.into());
                    }
                    None => {
                        p.extension_status.remove(&key);
                    }
                }
            }
        }
        // widgets, titles, editor text: pi's own TUI only
        _ => {}
    }
}

/// Set agent `i`'s model (provider/model, or a bare id pi knows); `done` gets how it went.
pub fn set_model(app: &mut App, i: usize, model: Option<String>, done: Box<dyn FnOnce(&mut App, Result<(), String>) + Send>) {
    let Some(model) = model.filter(|m| m != "default") else { return done(app, Ok(())) };
    alive(
        app,
        i,
        Box::new(move |app, i, r| {
            if let Err(e) = r {
                return done(app, Err(e));
            }
            let set = move |app: &mut App, i: usize, provider: String, id: String, done: Box<dyn FnOnce(&mut App, Result<(), String>) + Send>| {
                request(
                    app,
                    i,
                    json!({"type": "set_model", "provider": provider, "modelId": id}),
                    Box::new(move |app, i, r| match r {
                        Ok(_) => {
                            let m = format!("{provider}/{id}");
                            app.sessions[i].model = Some(m.clone());
                            app.sessions[i].requested_model = Some(m);
                            done(app, Ok(()));
                        }
                        Err(e) => done(app, Err(e)),
                    }),
                );
            };
            match model.split_once('/').filter(|(p, _)| !p.is_empty()) {
                Some((p, id)) => set(app, i, p.into(), id.into(), done),
                None => request(
                    app,
                    i,
                    json!({"type": "get_available_models"}),
                    Box::new(move |app, i, r| {
                        let found = r.ok().and_then(|d| d["models"].as_array().and_then(|l| l.iter().find(|m| m["id"].as_str() == Some(&model)).and_then(|m| m["provider"].as_str().map(str::to_string))));
                        match found {
                            Some(p) => set(app, i, p, model, done),
                            None => done(app, Err(format!("pi doesn't know the model '{model}' (provider/model, e.g. anthropic/claude-sonnet-4-5)"))),
                        }
                    }),
                ),
            }
        }),
    );
}

/// Set agent `i`'s thinking level (None or "default": off).
pub fn set_effort(app: &mut App, i: usize, effort: Option<String>, done: Box<dyn FnOnce(&mut App, Result<(), String>) + Send>) {
    let level = effort.filter(|e| e != "default").unwrap_or_else(|| "off".into());
    alive(
        app,
        i,
        Box::new(move |app, i, r| {
            if let Err(e) = r {
                return done(app, Err(e));
            }
            request(
                app,
                i,
                json!({"type": "set_thinking_level", "level": level}),
                Box::new(move |app, i, r| match r {
                    Ok(_) => {
                        app.sessions[i].effort = (level != "off").then_some(level);
                        done(app, Ok(()));
                    }
                    Err(e) => done(app, Err(e)),
                }),
            );
        }),
    );
}

/// pi's usage: every token the request read or wrote, cached ones included.
pub fn usage_tokens(u: &Value) -> u64 {
    u["totalTokens"].as_u64().unwrap_or_else(|| ["input", "output", "cacheRead", "cacheWrite"].iter().map(|k| u[*k].as_u64().unwrap_or(0)).sum())
}

/// The error of a reply whose request failed, with a hint when the key or login was refused (session.ts piError).
pub fn pi_error(m: &Value) -> Option<String> {
    if m["role"] != "assistant" || m["stopReason"] != "error" {
        return None;
    }
    let raw = if m["errorMessage"].is_null() { String::new() } else { js_string(&m["errorMessage"]) };
    let text = if raw.trim().is_empty() { "the request failed".to_string() } else { raw.trim().to_string() };
    let lower = text.to_lowercase();
    let word = |w: &str| lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|x| x == w);
    let auth = word("401")
        || word("403")
        || ["auth", "api key", "api_key", "api-key", "apikey", "unauthorized", "unauthorised", "forbidden", "credential", "expired", "login"].iter().any(|w| lower.contains(w));
    Some(if auth { format!("error: {text}\n{PI_KEY_HINT}") } else { format!("error: {text}") })
}

/// What pi's saved messages rebuild.
pub struct Restored {
    pub items: Vec<Item>,
    pub tokens: u64,
    pub cost: Option<f64>,
}

/// Rebuild the transcript from pi's saved messages: prompts, replies, tool calls (session.ts itemsFromMessages).
pub fn items_from_messages(messages: &[Value]) -> Restored {
    let mut items = vec![];
    let (mut tokens, mut cost) = (0u64, None::<f64>);
    for m in messages {
        match m["role"].as_str() {
            Some("user") => {
                let text = extract_text(&m["content"]);
                if !text.is_empty() {
                    items.push(Item::User(text));
                }
            }
            Some("assistant") => {
                let text = extract_text(&m["content"]);
                if !text.is_empty() {
                    items.push(Item::Text(text));
                }
                for b in m["content"].as_array().into_iter().flatten() {
                    if b["type"] == "toolCall" {
                        items.push(Item::Tool { id: js_string(&b["id"]), name: js_string(&b["name"]), summary: summarize_args(&b["arguments"]) });
                    }
                }
                if m["usage"].is_object() {
                    tokens += usage_tokens(&m["usage"]);
                    if let Some(c) = m["usage"]["cost"]["total"].as_f64() {
                        cost = Some(cost.unwrap_or(0.0) + c);
                    }
                }
                if let Some(err) = pi_error(m) {
                    items.push(Item::Info(err));
                }
            }
            _ => {}
        }
    }
    Restored { items, tokens, cost }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments() {
        assert_eq!(args(Some("default"), None, None, &[]), ["--mode", "rpc", "--no-session"]);
        let d = std::path::Path::new("/g/vigent/sessions");
        assert_eq!(
            args(Some("fake/test"), Some("high"), Some(d), &["--x".into()]),
            ["--mode", "rpc", "--session-dir", "/g/vigent/sessions", "--continue", "--model", "fake/test", "--thinking", "high", "--x"]
        );
    }

    #[test]
    fn saved_messages_rebuild_the_transcript() {
        let msgs: Vec<Value> = serde_json::from_str(
            r#"[{"role":"user","content":[{"type":"text","text":"fix the cart"}]},
                {"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"cat cart.js"}}],"usage":{"input":10,"output":5,"cost":{"total":0.01}}},
                {"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"x"}]},
                {"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"totalTokens":20}},
                {"role":"assistant","content":[],"stopReason":"error","errorMessage":"401 Unauthorized"}]"#,
        )
        .unwrap();
        let r = items_from_messages(&msgs);
        assert_eq!(r.items[0], Item::User("fix the cart".into()));
        assert_eq!(r.items[1], Item::Tool { id: "t1".into(), name: "bash".into(), summary: "cat cart.js".into() });
        assert_eq!(r.items[2], Item::Text("done".into()));
        assert!(matches!(&r.items[3], Item::Info(t) if t.starts_with("error: 401 Unauthorized\nthis agent runs on pi")));
        assert_eq!((r.tokens, r.cost), (35, Some(0.01)));
        assert_eq!(pi_error(&serde_json::json!({"role": "assistant", "stopReason": "error", "errorMessage": "overloaded"})).as_deref(), Some("error: overloaded"));
    }
}
