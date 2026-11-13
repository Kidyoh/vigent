//! OpenCode, run as installed (`opencode run --format json`), in the agent's
//! worktree (src/cli-engines.ts opencodeAdapter, src/engines.ts detectOpenCode).

use serde_json::Value;

use super::common::{first_version, js_string, strip_ansi, summarize, truthy};
use super::detect::{self, Env};
use super::{Adapter, Choice, EngineInfo, Ev, Parser, RunOpts};

pub struct OpenCode;

impl Adapter for OpenCode {
    fn id(&self) -> &str {
        "opencode"
    }
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String> {
        let mut a: Vec<String> = ["run", "--format", "json", "--dir"].iter().map(|s| s.to_string()).collect();
        a.push(o.cwd.clone());
        a.extend(o.extra_or(self.default_args()));
        if let Some(m) = &o.model {
            a.extend(["-m".into(), m.clone()]);
        }
        if let Some(e) = &o.effort {
            a.extend(["--variant".into(), e.clone()]);
        }
        if let Some(id) = &o.resume {
            a.extend(["--session".into(), id.clone()]);
        }
        for f in &o.files {
            a.extend(["-f".into(), f.clone()]);
        }
        a.extend(["--".into(), prompt.into()]);
        a
    }
    fn parser(&self) -> Parser {
        parser()
    }
    fn models(&self, env: &Env) -> Vec<Choice> {
        super::choices::opencode_choices(env)
    }
    fn detect(&self, env: &Env, timeout_ms: u64) -> EngineInfo {
        detect(env, timeout_ms)
    }
}

/// A parser for one run of `opencode run --format json`.
pub fn parser() -> Parser {
    let mut session: Option<String> = None;
    Box::new(move |e: &Value| {
        let mut out = vec![];
        if !e.is_object() {
            return out;
        }
        if truthy(&e["sessionID"]) {
            let id = js_string(&e["sessionID"]);
            if session.as_deref() != Some(id.as_str()) {
                session = Some(id.clone());
                out.push(Ev::Session(id));
            }
        }
        let part = &e["part"];
        match e["type"].as_str() {
            Some("text") => {
                if let Some(t) = part["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    out.push(Ev::Text(t.into()));
                }
            }
            Some("tool_use") => {
                let st = &part["state"];
                let id = if !part["callID"].is_null() { js_string(&part["callID"]) } else { js_string(&part["id"]) };
                let name = if part["tool"].is_null() { "tool".into() } else { js_string(&part["tool"]) };
                let summary = if truthy(&st["title"]) { js_string(&st["title"]) } else { summarize(&st["input"]) };
                out.push(Ev::Tool { id: id.clone(), name, summary });
                let output = [&st["output"], &st["error"]].into_iter().find(|v| !v.is_null()).map(js_string).unwrap_or_default();
                out.push(Ev::ToolResult { id, output });
            }
            Some("step_finish") => {
                let t = &part["tokens"];
                let n = |v: &Value| v.as_u64().unwrap_or(0);
                let tokens = n(&t["input"]) + n(&t["output"]) + n(&t["reasoning"]) + n(&t["cache"]["read"]) + n(&t["cache"]["write"]);
                let cost = part["cost"].as_f64();
                if tokens > 0 || cost.is_some() {
                    out.push(Ev::Usage { tokens, cost });
                }
            }
            Some("error") => {
                let err = &e["error"];
                let msg = [&err["data"]["message"], &err["message"], &err["name"]].into_iter().find(|v| !v.is_null()).map(js_string).unwrap_or_else(|| "error".into());
                out.push(Ev::Error(msg));
            }
            _ => {}
        }
        out
    })
}

/// "(\d+)\s+<word>" in text: the number before a word, or 0.
fn count_before(text: &str, word: &str) -> u64 {
    let mut prev: Option<&str> = None;
    for w in text.split_whitespace() {
        if w.starts_with(word)
            && let Some(n) = prev.and_then(|p| p.parse::<u64>().ok())
        {
            return n;
        }
        prev = Some(w.rsplit(|c: char| !c.is_ascii_digit()).next().unwrap_or(w));
    }
    0
}

/// OpenCode on this machine (src/engines.ts detectOpenCode).
pub fn detect(env: &Env, timeout_ms: u64) -> EngineInfo {
    let base = EngineInfo { id: "opencode".into(), name: "OpenCode".into(), install: Some(super::install("opencode")), connect: Some("opencode auth login".into()), ..Default::default() };
    let v = detect::run("opencode", &["--version"], timeout_ms, env);
    if v.code.is_none() {
        return EngineInfo { detail: "not installed".into(), ..base };
    }
    let base = EngineInfo { installed: true, version: first_version(&v.stdout), ..base };
    let s = detect::run("opencode", &["auth", "list"], timeout_ms, env);
    let text = strip_ansi(&format!("{}\n{}", s.stdout, s.stderr));
    let creds = count_before(&text, "credential");
    let vars = {
        // "(\d+)\s+environment variables?"
        let words: Vec<&str> = text.split_whitespace().collect();
        words.windows(3).find(|w| w[1] == "environment" && w[2].starts_with("variable")).and_then(|w| w[0].parse::<u64>().ok()).unwrap_or(0)
    };
    if creds > 0 || vars > 0 {
        let mut parts = vec![];
        if creds > 0 {
            parts.push(format!("{creds} saved login{}", if creds == 1 { "" } else { "s" }));
        }
        if vars > 0 {
            parts.push(format!("{vars} provider key{} in the environment", if vars == 1 { "" } else { "s" }));
        }
        return EngineInfo { connected: true, detail: parts.join(", "), connect: None, ..base };
    }
    EngineInfo { detail: "no providers connected".into(), ..base }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(fixture: &str) -> Vec<Ev> {
        let mut p = parser();
        fixture.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| p(&v)).collect()
    }

    #[test]
    fn run_format_json() {
        let evs = events(include_str!("../../../../test/fixtures/opencode-tool.jsonl"));
        assert_eq!(evs[0], Ev::Session("ses_e4b13245fffeWLL1J14R855Rfg".into()));
        assert_eq!(evs[1], Ev::Tool { id: "call_1".into(), name: "bash".into(), summary: "npm test".into() });
        assert!(matches!(&evs[2], Ev::ToolResult { output, .. } if output == "1 failing\n"));
        assert_eq!(evs[3], Ev::Text("The cart test fails on an empty cart.".into()));
        assert_eq!(evs[4], Ev::Usage { tokens: 1240, cost: Some(0.0) });
        let err = events(include_str!("../../../../test/fixtures/opencode-error.jsonl"));
        assert!(matches!(&err[1], Ev::Error(m) if m.contains("security token included in the request is invalid")));
    }

    #[test]
    fn command_line() {
        let o = RunOpts { cwd: "/w".into(), resume: Some("ses_1".into()), model: Some("anthropic/claude-sonnet-4-5".into()), ..Default::default() };
        assert_eq!(OpenCode.args("go", &o), ["run", "--format", "json", "--dir", "/w", "-m", "anthropic/claude-sonnet-4-5", "--session", "ses_1", "--", "go"]);
        let e = OpenCode.args("go", &RunOpts { effort: Some("max".into()), ..Default::default() });
        assert_eq!(&e[e.len() - 4..], ["--variant", "max", "--", "go"]);
        assert_eq!(count_before("2 credentials\n1 environment variable", "credential"), 2);
    }
}
