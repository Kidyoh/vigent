//! Cursor CLI, run as installed (`cursor-agent --print --output-format
//! stream-json`), in the agent's worktree (src/cli-engines.ts cursorAdapter,
//! src/engines.ts detectCursor).

use serde_json::Value;

use super::common::{content_of, first_version, js_string, strip_ansi, summarize, truthy};
use super::detect::{self, Env};
use super::{Adapter, Choice, EngineInfo, Ev, Parser, RunOpts};

pub struct Cursor;

impl Adapter for Cursor {
    fn id(&self) -> &str {
        "cursor"
    }
    // the agent works in its own worktree: let it edit and run commands there (headless can't ask)
    fn default_args(&self) -> &'static [&'static str] {
        &["--force"]
    }
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String> {
        let mut a: Vec<String> = ["--print", "--output-format", "stream-json"].iter().map(|s| s.to_string()).collect();
        a.extend(o.extra_or(self.default_args()));
        if let Some(m) = &o.model {
            a.extend(["--model".into(), m.clone()]);
        }
        if let Some(id) = &o.resume {
            a.extend(["--resume".into(), id.clone()]);
        }
        a.push(prompt.into());
        a
    }
    fn parser(&self) -> Parser {
        parser()
    }
    fn models(&self, _env: &Env) -> Vec<Choice> {
        super::choices::cursor_choices()
    }
    fn detect(&self, env: &Env, timeout_ms: u64) -> EngineInfo {
        detect(env, timeout_ms)
    }
}

/// Cursor names a tool call by its key: { readToolCall: {...} } is "read"; others are { function: { name } }.
fn cursor_tool(call: &Value) -> (String, Value, Value) {
    if let Some(f) = call.get("function").filter(|f| truthy(f)) {
        let mut args = f["arguments"].clone();
        if let Some(s) = args.as_str()
            && let Ok(v) = serde_json::from_str::<Value>(s)
        {
            args = v;
        }
        let name = if f["name"].is_null() { "tool".into() } else { js_string(&f["name"]) };
        return (name, args, call["result"].clone());
    }
    let keys: Vec<&String> = call.as_object().map(|o| o.keys().collect()).unwrap_or_default();
    let key = keys.iter().find(|k| k.ends_with("ToolCall")).or(keys.first()).map(|k| k.to_string()).unwrap_or_else(|| "tool".into());
    let body = &call[key.as_str()];
    (key.strip_suffix("ToolCall").unwrap_or(&key).to_string(), body["args"].clone(), body["result"].clone())
}

/// A parser for one run of Cursor CLI's stream-json.
pub fn parser() -> Parser {
    Box::new(|e: &Value| {
        let mut out = vec![];
        if !e.is_object() {
            return out;
        }
        match e["type"].as_str() {
            Some("system") if e["subtype"] == "init" => {
                if truthy(&e["session_id"]) {
                    out.push(Ev::Session(js_string(&e["session_id"])));
                }
                if truthy(&e["model"]) {
                    out.push(Ev::Model(js_string(&e["model"])));
                }
            }
            Some("assistant") => {
                let text: String = content_of(&e["message"]).iter().filter(|b| b["type"] == "text" && truthy(&b["text"])).map(|b| js_string(&b["text"])).collect();
                // with --stream-partial-output, pieces carry timestamp_ms; the flushes after them repeat the text
                if !text.is_empty() {
                    out.push(if truthy(&e["timestamp_ms"]) && !truthy(&e["model_call_id"]) { Ev::TextDelta(text) } else { Ev::Text(text) });
                }
            }
            Some("tool_call") => {
                let (name, args, r) = cursor_tool(&e["tool_call"]);
                let id = js_string(&e["call_id"]);
                if e["subtype"] == "started" {
                    out.push(Ev::Tool { id, name, summary: summarize(&args) });
                } else if e["subtype"] == "completed" {
                    let output = [&r["success"]["content"], &r["success"]["stdout"], &r["error"]["message"]]
                        .into_iter()
                        .find(|v| !v.is_null())
                        .map(js_string)
                        .unwrap_or_else(|| if truthy(&r) { if r["success"].is_null() { r.to_string() } else { r["success"].to_string() } } else { String::new() });
                    out.push(Ev::ToolResult { id, output });
                }
            }
            Some("result") => {
                if truthy(&e["session_id"]) {
                    out.push(Ev::Session(js_string(&e["session_id"])));
                }
                let ok = !truthy(&e["is_error"]) && e["subtype"] == "success";
                let error = (!ok).then(|| [&e["result"], &e["subtype"]].into_iter().find(|v| !v.is_null()).map(js_string).unwrap_or_else(|| "failed".into()));
                out.push(Ev::Done { ok, error });
            }
            _ => {}
        }
        out
    })
}

/// Cursor CLI on this machine (src/engines.ts detectCursor).
pub fn detect(env: &Env, timeout_ms: u64) -> EngineInfo {
    let base = EngineInfo { id: "cursor".into(), name: "Cursor CLI".into(), install: Some(super::install("cursor")), connect: Some("cursor-agent login".into()), ..Default::default() };
    let v = detect::run("cursor-agent", &["--version"], timeout_ms, env);
    if v.code.is_none() {
        return EngineInfo { detail: "not installed".into(), ..base };
    }
    let base = EngineInfo { installed: true, version: first_version(&v.stdout), ..base };
    if env.get("CURSOR_API_KEY").is_some_and(|k| !k.is_empty()) {
        return EngineInfo { connected: true, detail: "using CURSOR_API_KEY".into(), connect: None, ..base };
    }
    let s = detect::run("cursor-agent", &["status"], timeout_ms, env);
    let text = strip_ansi(&format!("{}\n{}", s.stdout, s.stderr));
    let lower = text.to_lowercase();
    let yes = ["logged in", "signed in", "authenticated"].iter().any(|w| lower.contains(w));
    let no = ["not logged in", "not signed in", "unauthenticated"].iter().any(|w| lower.contains(w));
    if s.ok && yes && !no {
        let detail = match who(&text) {
            Some(w) => format!("signed in as {w}"),
            None => "signed in".into(),
        };
        return EngineInfo { connected: true, detail, connect: None, ..base };
    }
    EngineInfo { detail: "not signed in".into(), ..base }
}

/// /(?:as|account:?)\s+(\S+@\S+)/i
fn who(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    for w in words.windows(2) {
        let lead = w[0].to_lowercase();
        if (lead.ends_with("as") || lead.ends_with("account") || lead.ends_with("account:")) && w[1].contains('@') && !w[1].starts_with('@') && !w[1].ends_with('@') {
            return Some(w[1].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::detect::tests::{env, fake_bin, tmp};

    #[test]
    fn stream_json() {
        let mut p = parser();
        let evs: Vec<Ev> = include_str!("../../../../test/fixtures/cursor-stream.jsonl").lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| p(&v)).collect();
        assert_eq!(evs[0], Ev::Session("cur-5e55-10n".into()));
        assert_eq!(evs[2], Ev::Text("Reading the cart first.".into()));
        assert_eq!(evs[3], Ev::Tool { id: "call-1".into(), name: "read".into(), summary: "cart.js".into() });
        assert_eq!(evs[4], Ev::ToolResult { id: "call-1".into(), output: "export const total = (items) => items.length;".into() });
        assert_eq!(evs[5], Ev::Tool { id: "call-2".into(), name: "run_terminal_cmd".into(), summary: "npm test".into() });
        assert_eq!(evs[6], Ev::ToolResult { id: "call-2".into(), output: "1 passing".into() });
        assert_eq!(evs.last(), Some(&Ev::Done { ok: true, error: None }));
    }

    #[test]
    fn command_line_and_detection() {
        let o = RunOpts { model: Some("gpt-5".into()), ..Default::default() };
        assert_eq!(Cursor.args("why?", &o), ["--print", "--output-format", "stream-json", "--force", "--model", "gpt-5", "why?"]);
        assert_eq!(Cursor.args("hi", &RunOpts { extra_args: Some(vec![]), ..Default::default() }), ["--print", "--output-format", "stream-json", "hi"]);
        let dir = tmp("cursor-detect");
        let bin = dir.join("bin");
        fake_bin(&bin, "cursor-agent", r#"case "$*" in "--version") echo 2026.11.01-abc;; status) echo "✓ Logged in as dev@example.com";; esac"#);
        let d = detect(&env(&[("PATH", bin.to_str().unwrap())]), 5000);
        assert_eq!((d.installed, d.connected, d.detail.as_str()), (true, true, "signed in as dev@example.com"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
