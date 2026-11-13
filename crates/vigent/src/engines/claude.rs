//! Claude Code, run as installed (`claude -p --output-format stream-json`), in
//! the agent's worktree. Its JSON lines become events, the same way
//! src/cli-engines.ts (claudeAdapter) reads them.

use serde_json::Value;

use super::common::{content_of, js_string, summarize, text_of, truthy};
use super::detect::{self, Env};
use super::{Adapter, Choice, Denial, EngineInfo, Ev, Parser, RunOpts};

pub struct Claude;

impl Adapter for Claude {
    fn id(&self) -> &str {
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
        parser()
    }
    fn can_fork(&self) -> bool {
        true
    }
    fn models(&self, _env: &Env) -> Vec<Choice> {
        super::choices::claude_models()
    }
    fn detect(&self, env: &Env, timeout_ms: u64) -> EngineInfo {
        detect(env, timeout_ms)
    }
}

/// A parser for one run of `claude -p --output-format stream-json` (cli-engines.ts claudeAdapter.parser).
pub fn parser() -> Parser {
    let mut thinking_block: Option<Value> = None;
    Box::new(move |e: &Value| {
        let mut out = vec![];
        if !e.is_object() || e.get("parent_tool_use_id").is_some_and(truthy) {
            return out; // a subagent's own messages: only its result reaches the transcript
        }
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        match e.get("type").and_then(Value::as_str) {
            Some("system") if e.get("subtype").and_then(Value::as_str) == Some("init") => {
                if let Some(id) = s(e, "session_id").filter(|x| !x.is_empty()) {
                    out.push(Ev::Session(id));
                }
                if let Some(m) = s(e, "model").filter(|x| !x.is_empty()) {
                    out.push(Ev::Model(m));
                }
            }
            Some("stream_event") => {
                let ev = e.get("event").cloned().unwrap_or(Value::Null);
                let block = &ev["content_block"];
                let kind = ev["type"].as_str().unwrap_or("");
                if kind == "content_block_delta" && ev["delta"]["type"] == "text_delta" && ev["delta"]["text"].as_str().is_some_and(|t| !t.is_empty()) {
                    out.push(Ev::TextDelta(ev["delta"]["text"].as_str().unwrap_or("").into()));
                } else if kind == "content_block_start" && block["type"] == "tool_use" {
                    // the input is still being written; the assistant event that follows fills it in
                    out.push(Ev::Tool { id: js_string(&block["id"]), name: js_string(&block["name"]), summary: String::new() });
                } else if kind == "content_block_start" && block["type"] == "thinking" {
                    thinking_block = Some(ev["index"].clone());
                    out.push(Ev::Thinking(true));
                } else if kind == "content_block_stop" && thinking_block.as_ref().is_some_and(|b| *b == ev["index"]) {
                    thinking_block = None;
                    out.push(Ev::Thinking(false));
                } else if kind == "message_delta" && ev["delta"]["stop_reason"] == "end_turn" {
                    out.push(Ev::TurnEnd);
                } else if kind == "message_start" {
                    out.push(Ev::TurnStart);
                }
            }
            Some("assistant") => {
                if let Some(id) = s(e, "uuid") {
                    out.push(Ev::Message(id));
                }
                for b in content_of(&e["message"]) {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") if b.get("text").is_some_and(truthy) => out.push(Ev::Text(js_string(&b["text"]))),
                        Some("tool_use") => out.push(Ev::Tool { id: js_string(&b["id"]), name: js_string(&b["name"]), summary: summarize(&b["input"]) }),
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for b in content_of(&e["message"]) {
                    if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                        out.push(Ev::ToolResult { id: js_string(&b["tool_use_id"]), output: text_of(&b["content"]) });
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
                if let Some(id) = s(e, "session_id").filter(|x| !x.is_empty()) {
                    out.push(Ev::Session(id));
                }
                if let Some(d) = e["permission_denials"].as_array().filter(|d| !d.is_empty()) {
                    let tools = d
                        .iter()
                        .filter(|d| d["tool_name"].is_string())
                        .map(|d| Denial { name: js_string(&d["tool_name"]), input: d["tool_input"].clone() })
                        .collect();
                    out.push(Ev::Denied(tools));
                }
                let ok = !truthy(&e["is_error"]) && e["subtype"] == "success";
                let error = (!ok).then(|| {
                    if !e["result"].is_null() {
                        js_string(&e["result"])
                    } else if let Some(errs) = e["errors"].as_array() {
                        errs.iter().map(js_string).collect::<Vec<_>>().join("; ")
                    } else if !e["subtype"].is_null() {
                        js_string(&e["subtype"])
                    } else {
                        "failed".into()
                    }
                });
                out.push(Ev::Done { ok, error });
            }
            _ => {}
        }
        out
    })
}

/// One line of the stream, as events (a parser with no state carried over).
pub fn parse(e: &Value) -> Vec<Ev> {
    parser()(e)
}

/// The arguments for one turn, like the TypeScript claudeAdapter.
pub fn args(prompt: &str, o: &RunOpts) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].iter().map(|s| s.to_string()).collect();
    a.extend(o.extra_or(Claude.default_args()));
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

/// Claude Code on this machine: its version, and whether (and how) it's signed in (src/engines.ts detectClaude).
pub fn detect(env: &Env, timeout_ms: u64) -> EngineInfo {
    let base = EngineInfo {
        id: "claude".into(),
        name: "Claude Code".into(),
        install: Some(super::install("claude")),
        connect: Some("claude auth login".into()),
        ..Default::default()
    };
    let v = detect::run("claude", &["--version"], timeout_ms, env);
    if v.code.is_none() {
        return EngineInfo { detail: "not installed".into(), ..base };
    }
    let version = super::common::first_version(&v.stdout);
    let s = detect::run("claude", &["auth", "status", "--json"], timeout_ms, env);
    let base = EngineInfo { installed: true, version, ..base };
    let key = env.get("ANTHROPIC_API_KEY").is_some_and(|k| !k.is_empty());
    let Ok(st) = serde_json::from_str::<Value>(&s.stdout) else {
        if key {
            return EngineInfo { connected: true, detail: "using ANTHROPIC_API_KEY".into(), connect: None, ..base };
        }
        return EngineInfo { detail: "couldn't read sign-in status".into(), ..base };
    };
    if !truthy(&st["loggedIn"]) {
        return EngineInfo { detail: "not signed in".into(), ..base };
    }
    let uses_key = |st: &Value| st["authMethod"] == "api_key" || truthy(&st["apiKeySource"]);
    // ANTHROPIC_API_KEY wins over a signed-in Claude account. When there is an account too,
    // leave the key out, so Claude Code runs on the login you use it with (an unscoped or
    // spent key otherwise fails every request, e.g. "not scoped to a workspace")
    if uses_key(&st) && key {
        let mut without = env.clone();
        without.remove("ANTHROPIC_API_KEY");
        let account = detect::run("claude", &["auth", "status", "--json"], timeout_ms, &without);
        if let Ok(a) = serde_json::from_str::<Value>(&account.stdout)
            && truthy(&a["loggedIn"])
            && !uses_key(&a)
        {
            return EngineInfo {
                connected: true,
                detail: "signed in (Claude account; ANTHROPIC_API_KEY left out)".into(),
                connect: None,
                drop_env: vec!["ANTHROPIC_API_KEY".into()],
                ..base
            };
        }
    }
    let how = if uses_key(&st) { "API key" } else { "Claude account" };
    EngineInfo { connected: true, detail: format!("signed in ({how})"), connect: None, ..base }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::detect::tests::{env, fake_bin, tmp};
    use serde_json::json;

    fn events(fixture: &str) -> Vec<Ev> {
        let mut p = parser();
        fixture.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| p(&v)).collect()
    }

    #[test]
    fn reads_the_recorded_claude_code_stream() {
        let evs = events(include_str!("../../../../test/fixtures/claude-tool.jsonl"));
        assert_eq!(evs[0], Ev::Session("3b248a3e-43fd-4fd1-98b5-f36e06e02d85".into()));
        assert_eq!(evs[1], Ev::Model("claude-fable-5".into()));
        let tools: Vec<&Ev> = evs.iter().filter(|e| matches!(e, Ev::Tool { .. })).collect();
        assert_eq!(tools.len(), 2);
        assert!(matches!(tools[0], Ev::Tool { name, summary, .. } if name == "Write" && summary.is_empty()), "shown when it starts");
        assert!(matches!(tools[1], Ev::Tool { name, summary, .. } if name == "Write" && summary == "/work/hello.txt"));
        assert!(evs.iter().any(|e| matches!(e, Ev::ToolResult { output, .. } if output.contains("File created successfully"))));
        let deltas: Vec<&Ev> = evs.iter().filter(|e| matches!(e, Ev::TextDelta(_))).collect();
        assert_eq!(deltas, [&Ev::TextDelta("done".into())]);
        assert_eq!(evs.last(), Some(&Ev::Done { ok: true, error: None }));
        assert!(evs.iter().any(|e| matches!(e, Ev::Usage { tokens, .. } if *tokens > 0)));
        let mut p = parser();
        assert!(p(&json!({"type": "assistant", "parent_tool_use_id": "toolu_1", "message": {"content": [{"type": "text", "text": "inner"}]}})).is_empty());
        assert_eq!(
            p(&json!({"type": "result", "subtype": "error_max_turns", "is_error": true, "result": "hit the turn limit"})).last(),
            Some(&Ev::Done { ok: false, error: Some("hit the turn limit".into()) })
        );
        let d = p(&json!({"type": "result", "subtype": "success", "permission_denials": [{"tool_name": "Bash", "tool_input": {"command": "gh pr list"}}]}));
        assert!(matches!(&d[0], Ev::Denied(t) if t[0].name == "Bash"));
    }

    #[test]
    fn follow_ups_resume_the_conversation() {
        let a = args("-fix it", &RunOpts::default());
        assert_eq!(a, ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits", "--", "-fix it"]);
        let o = RunOpts { model: Some("opus".into()), resume: Some("abc".into()), extra_args: Some(vec!["--permission-mode".into(), "plan".into()]), ..Default::default() };
        assert_eq!(&args("go", &o)[5..], ["--permission-mode", "plan", "--model", "opus", "--resume", "abc", "--", "go"]);
        let e = RunOpts { model: Some("opus".into()), effort: Some("high".into()), ..Default::default() };
        let a = args("go", &e);
        assert_eq!(&a[a.len() - 6..], ["--model", "opus", "--effort", "high", "--", "go"]);
        assert!(!args("go", &RunOpts::default()).contains(&"--effort".to_string()), "no effort: the CLI decides");
        let fork = RunOpts { resume: Some("abc".into()), fork: true, fork_at: Some("m1".into()), ..Default::default() };
        assert!(args("go", &fork).windows(3).any(|w| w == ["--fork-session", "--resume-session-at", "m1"]));
        let allow = RunOpts { allowed_tools: vec!["Bash(gh:*)".into()], ..Default::default() };
        assert!(args("go", &allow).windows(2).any(|w| w == ["--allowedTools", "Bash(gh:*)"]));
    }

    #[test]
    fn detection_and_the_api_key_rule() {
        let dir = tmp("claude-detect");
        let bin = dir.join("bin");
        // signed in with an account; with ANTHROPIC_API_KEY set, status reports the key
        fake_bin(
            &bin,
            "claude",
            r#"case "$*" in
  "--version") echo "2.1.319 (Claude Code)";;
  "auth status --json") if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; else echo '{"loggedIn":true,"authMethod":"claude.ai"}'; fi;;
esac"#,
        );
        let p = bin.to_str().unwrap();
        let e = detect(&env(&[("PATH", p)]), 5000);
        assert_eq!((e.installed, e.connected, e.version.as_deref(), e.detail.as_str()), (true, true, Some("2.1.319"), "signed in (Claude account)"));
        assert!(e.drop_env.is_empty());
        let k = detect(&env(&[("PATH", p), ("ANTHROPIC_API_KEY", "sk")]), 5000);
        assert_eq!(k.detail, "signed in (Claude account; ANTHROPIC_API_KEY left out)");
        assert_eq!(k.drop_env, ["ANTHROPIC_API_KEY"]);
        let none = detect(&env(&[("PATH", "")]), 5000);
        assert_eq!((none.installed, none.detail.as_str(), none.connect.as_deref()), (false, "not installed", Some("claude auth login")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
