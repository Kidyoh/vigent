//! Claude Code, run as installed (`claude -p --output-format stream-json`), in
//! the agent's worktree. Its JSON lines become events, the same way
//! src/cli-engines.ts reads them.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

use crate::app::Msg;

/// What one line of Claude Code's stream says.
#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    Session(String),
    Model(String),
    TextDelta(String),
    Text(String),
    Tool { id: String, name: String, summary: String },
    ToolResult { id: String, output: String },
    Usage { tokens: u64, cost: Option<f64> },
    Done { ok: bool, error: Option<String> },
}

fn summarize(input: &Value) -> String {
    let v = ["command", "file_path", "filePath", "path", "pattern", "url", "description"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| if input.is_null() { String::new() } else { input.to_string() });
    v.chars().take(80).collect()
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// One line of the stream, as events.
pub fn parse(e: &Value) -> Vec<Ev> {
    let mut out = vec![];
    if e.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
        return out; // a subagent's own messages: only its result reaches the transcript
    }
    let blocks = |e: &Value| e.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
    match e.get("type").and_then(Value::as_str) {
        Some("system") if e.get("subtype").and_then(Value::as_str) == Some("init") => {
            if let Some(id) = e.get("session_id").and_then(Value::as_str) {
                out.push(Ev::Session(id.into()));
            }
            if let Some(m) = e.get("model").and_then(Value::as_str) {
                out.push(Ev::Model(m.into()));
            }
        }
        Some("stream_event") => {
            let ev = &e["event"];
            if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                if let Some(t) = ev["delta"]["text"].as_str().filter(|t| !t.is_empty()) {
                    out.push(Ev::TextDelta(t.into()));
                }
            }
        }
        Some("assistant") => {
            for b in blocks(e) {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                            out.push(Ev::Text(t.into()));
                        }
                    }
                    Some("tool_use") => out.push(Ev::Tool {
                        id: b["id"].as_str().unwrap_or_default().into(),
                        name: b["name"].as_str().unwrap_or_default().into(),
                        summary: summarize(&b["input"]),
                    }),
                    _ => {}
                }
            }
        }
        Some("user") => {
            for b in blocks(e) {
                if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                    out.push(Ev::ToolResult { id: b["tool_use_id"].as_str().unwrap_or_default().into(), output: text_of(&b["content"]) });
                }
            }
        }
        Some("result") => {
            let u = &e["usage"];
            let n = |k: &str| u[k].as_u64().unwrap_or(0);
            let tokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
            let cost = e["total_cost_usd"].as_f64();
            if tokens > 0 || cost.is_some() {
                out.push(Ev::Usage { tokens, cost });
            }
            if let Some(id) = e["session_id"].as_str() {
                out.push(Ev::Session(id.into()));
            }
            let ok = !e["is_error"].as_bool().unwrap_or(false) && e["subtype"] == "success";
            let error = (!ok).then(|| e["result"].as_str().or(e["subtype"].as_str()).unwrap_or("failed").to_string());
            out.push(Ev::Done { ok, error });
        }
        _ => {}
    }
    out
}

/// The arguments for one turn, like the TypeScript claudeAdapter.
pub fn args(prompt: &str, resume: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(id) = resume {
        a.extend(["--resume".into(), id.into()]);
    }
    a.extend(["--".into(), prompt.into()]);
    a
}

/// Start one turn. Its events, then its exit, come back as messages for `agent`.
pub fn start(agent: usize, cwd: PathBuf, prompt: &str, resume: Option<&str>, drop_api_key: bool, tx: Sender<Msg>) -> std::io::Result<Child> {
    let mut cmd = Command::new("claude");
    cmd.args(args(prompt, resume)).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if drop_api_key {
        // signed in with a Claude account: a stray key would be billed (or fail) instead
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_tx = tx.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        let last: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let tail = last[last.len().saturating_sub(3)..].join("\n");
        let _ = err_tx.send(Msg::Stderr(agent, tail));
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let evs = parse(&v);
                if !evs.is_empty() && tx.send(Msg::Engine(agent, evs)).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Msg::StreamEnd(agent));
    });
    Ok(child)
}

/// Claude Code on this machine: its version, and whether (and how) it's signed in.
#[derive(Clone, Debug, Default)]
pub struct Claude {
    pub version: Option<String>,
    pub signed_in: bool,
    pub method: Option<String>,
}

pub fn detect_claude() -> Claude {
    let run = |args: &[&str]| Command::new("claude").args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok().filter(|o| o.status.success());
    let Some(v) = run(&["--version"]) else { return Claude::default() };
    let version = String::from_utf8_lossy(&v.stdout).split_whitespace().next().map(str::to_string);
    let status = run(&["auth", "status", "--json"]).and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok());
    let signed_in = status.as_ref().and_then(|s| s["loggedIn"].as_bool()).unwrap_or(false);
    let method = status.as_ref().and_then(|s| s["authMethod"].as_str().map(str::to_string));
    Claude { version, signed_in, method }
}

/// Whether `bin` is on PATH.
pub fn on_path(bin: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|d| {
        let f = d.join(bin);
        f.is_file() || (cfg!(windows) && d.join(format!("{bin}.exe")).is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_recorded_claude_code_stream() {
        let fixture = include_str!("../../../test/fixtures/claude-tool.jsonl");
        let evs: Vec<Ev> = fixture.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| parse(&v)).collect();
        assert!(evs.contains(&Ev::Session("3b248a3e-43fd-4fd1-98b5-f36e06e02d85".into())));
        assert!(evs.contains(&Ev::Model("claude-fable-5".into())));
        assert!(evs.iter().any(|e| matches!(e, Ev::Tool { name, summary, .. } if name == "Write" && summary == "/work/hello.txt")));
        assert!(evs.iter().any(|e| matches!(e, Ev::Done { ok: true, .. })));
        assert!(evs.iter().any(|e| matches!(e, Ev::Usage { tokens, .. } if *tokens > 0)));
    }

    #[test]
    fn follow_ups_resume_the_conversation() {
        assert_eq!(&args("go", Some("abc"))[7..], ["--resume", "abc", "--", "go"]);
        assert_eq!(args("-x", None).last().unwrap(), "-x");
    }
}
