//! Claude Code, run as installed (`claude -p --output-format stream-json`), in
//! the agent's worktree. Its JSON lines become events, the same way
//! src/cli-engines.ts (claudeAdapter) reads them.

use serde_json::Value;
use std::process::{Command, Stdio};

use super::{Adapter, Choice, EngineInfo, Ev, Parser, RunOpts};

pub struct Claude;

impl Adapter for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }
    // -p can't ask before a tool runs; edits are allowed, other tools follow your Claude Code settings
    fn default_args(&self) -> &'static [&'static str] {
        &["--permission-mode", "acceptEdits"]
    }
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String> {
        args(prompt, o)
    }
    fn parser(&self) -> Parser {
        Box::new(parse)
    }
    fn can_fork(&self) -> bool {
        true
    }
    fn models(&self) -> Vec<Choice> {
        vec![] // Engines area: src/choices.ts CLAUDE_MODELS
    }
    fn detect(&self) -> EngineInfo {
        detect()
    }
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
            if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta"
                && let Some(t) = ev["delta"]["text"].as_str().filter(|t| !t.is_empty()) {
                    out.push(Ev::TextDelta(t.into()));
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
pub fn args(prompt: &str, o: &RunOpts) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    match &o.extra_args {
        Some(extra) => a.extend(extra.iter().cloned()),
        None => a.extend(Claude.default_args().iter().map(|s| s.to_string())),
    }
    if !o.allowed_tools.is_empty() {
        a.push("--allowedTools".into());
        a.extend(o.allowed_tools.iter().cloned());
    }
    if let Some(m) = &o.model {
        a.extend(["--model".into(), m.clone()]);
    }
    if let Some(e) = &o.effort {
        a.extend(["--effort".into(), e.clone()]);
    }
    if let Some(id) = &o.resume {
        a.extend(["--resume".into(), id.clone()]);
        if o.fork {
            a.push("--fork-session".into());
            if let Some(at) = &o.fork_at {
                a.extend(["--resume-session-at".into(), at.clone()]);
            }
        }
    }
    a.extend(["--".into(), prompt.into()]);
    a
}

/// Claude Code on this machine: its version, and whether (and how) it's signed in.
/// (Engines area: port src/engines.ts detectClaude, API-key fallbacks included.)
pub fn detect() -> EngineInfo {
    let spec = super::spec("claude");
    let base = EngineInfo { connect: Some("claude".into()), ..EngineInfo::from_path(spec) };
    let run = |args: &[&str]| Command::new("claude").args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok().filter(|o| o.status.success());
    let Some(v) = run(&["--version"]) else {
        return EngineInfo { installed: false, detail: "not installed".into(), ..base };
    };
    let version = String::from_utf8_lossy(&v.stdout).split_whitespace().next().map(str::to_string);
    let status = run(&["auth", "status", "--json"]).and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok());
    let signed_in = status.as_ref().and_then(|s| s["loggedIn"].as_bool()).unwrap_or(false);
    let account = status.as_ref().and_then(|s| s["authMethod"].as_str()) == Some("claude.ai");
    if !signed_in {
        return EngineInfo { installed: true, version, detail: "not signed in".into(), ..base };
    }
    EngineInfo {
        installed: true,
        connected: true,
        version,
        detail: if account { "signed in (Claude account)".into() } else { "signed in".into() },
        // signed in with a Claude account: a stray key would be billed (or fail) instead
        drop_env: if account { vec!["ANTHROPIC_API_KEY".into()] } else { vec![] },
        connect: None,
        ..base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_recorded_claude_code_stream() {
        let fixture = include_str!("../../../../test/fixtures/claude-tool.jsonl");
        let evs: Vec<Ev> = fixture.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| parse(&v)).collect();
        assert!(evs.contains(&Ev::Session("3b248a3e-43fd-4fd1-98b5-f36e06e02d85".into())));
        assert!(evs.contains(&Ev::Model("claude-fable-5".into())));
        assert!(evs.iter().any(|e| matches!(e, Ev::Tool { name, summary, .. } if name == "Write" && summary == "/work/hello.txt")));
        assert!(evs.iter().any(|e| matches!(e, Ev::Done { ok: true, .. })));
        assert!(evs.iter().any(|e| matches!(e, Ev::Usage { tokens, .. } if *tokens > 0)));
    }

    #[test]
    fn follow_ups_resume_the_conversation() {
        let resume = RunOpts { resume: Some("abc".into()), ..Default::default() };
        assert_eq!(&args("go", &resume)[7..], ["--resume", "abc", "--", "go"]);
        assert_eq!(args("-x", &RunOpts::default()).last().unwrap(), "-x");
        let fork = RunOpts { resume: Some("abc".into()), fork: true, fork_at: Some("m1".into()), model: Some("opus".into()), ..Default::default() };
        let a = args("go", &fork);
        assert!(a.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(a.windows(3).any(|w| w == ["--fork-session", "--resume-session-at", "m1"]));
    }
}
