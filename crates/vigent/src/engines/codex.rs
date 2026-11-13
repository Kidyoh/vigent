//! Codex, run as installed (`codex exec --json`), in the agent's worktree
//! (src/cli-engines.ts codexAdapter, src/engines.ts detectCodex).

use serde_json::Value;
use std::collections::HashSet;

use super::common::{first_version, js_string, shell_command, strip_ansi, summarize, text_of, truthy};
use super::detect::{self, Env};
use super::{Adapter, Choice, EngineInfo, Ev, Parser, RunOpts};

pub struct Codex;

impl Adapter for Codex {
    fn id(&self) -> &str {
        "codex"
    }
    // edits and commands inside the worktree, nothing outside it
    fn default_args(&self) -> &'static [&'static str] {
        &["-c", "sandbox_mode=\"workspace-write\""]
    }
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String> {
        let mut a = vec!["exec".to_string()];
        if o.resume.is_some() {
            a.push(if o.fork { "fork" } else { "resume" }.into());
        }
        a.extend(["--json".into(), "--skip-git-repo-check".into()]);
        a.extend(o.extra_or(self.default_args()));
        if let Some(m) = &o.model {
            a.extend(["-m".into(), m.clone()]);
        }
        if let Some(e) = &o.effort {
            a.extend(["-c".into(), format!("model_reasoning_effort=\"{e}\"")]);
        }
        if let Some(id) = &o.resume {
            a.push(id.clone());
        }
        a.extend(["--".into(), prompt.into()]);
        a
    }
    fn can_fork(&self) -> bool {
        true
    }
    // no prompt: codex forks the thread and stops (it reads an empty stdin)
    fn fork_args(&self, o: &RunOpts) -> Option<Vec<String>> {
        let mut a: Vec<String> = ["exec", "fork", "--json", "--skip-git-repo-check"].iter().map(|s| s.to_string()).collect();
        a.extend(o.extra_or(self.default_args()));
        a.push(o.resume.clone().unwrap_or_default());
        Some(a)
    }
    fn parser(&self) -> Parser {
        parser()
    }
    fn models(&self, env: &Env) -> Vec<Choice> {
        super::choices::codex_choices(env)
    }
    fn detect(&self, env: &Env, timeout_ms: u64) -> EngineInfo {
        detect(env, timeout_ms)
    }
}

fn tool(item: &Value) -> Option<Ev> {
    let id = js_string(&item["id"]);
    Some(match item["type"].as_str()? {
        "command_execution" => Ev::Tool { id, name: "bash".into(), summary: shell_command(&item["command"]) },
        "file_change" => {
            let changes = item["changes"].as_array().cloned().unwrap_or_default();
            let summary = changes
                .iter()
                .map(|c| {
                    let sign = match c["kind"].as_str() {
                        Some("add") => "+",
                        Some("delete") => "-",
                        _ => "",
                    };
                    format!("{sign}{}", js_string(&c["path"]))
                })
                .collect::<Vec<_>>()
                .join(", ");
            Ev::Tool { id, name: "edit".into(), summary }
        }
        "mcp_tool_call" => {
            let name = [&item["server"], &item["tool"]].iter().filter(|v| truthy(v)).map(|v| js_string(v)).collect::<Vec<_>>().join(".");
            Ev::Tool { id, name, summary: summarize(&item["arguments"]) }
        }
        "web_search" => Ev::Tool { id, name: "web_search".into(), summary: if item["query"].is_null() { String::new() } else { js_string(&item["query"]) } },
        _ => return None,
    })
}

/// A parser for one run of `codex exec --json`.
pub fn parser() -> Parser {
    let mut last_error: Option<String> = None;
    let mut started: HashSet<String> = HashSet::new();
    Box::new(move |e: &Value| {
        let mut out = vec![];
        if !e.is_object() {
            return out;
        }
        match e["type"].as_str() {
            Some("thread.started") => {
                if truthy(&e["thread_id"]) {
                    out.push(Ev::Session(js_string(&e["thread_id"])));
                }
            }
            Some("item.started") => {
                if let Some(t) = tool(&e["item"]) {
                    started.insert(js_string(&e["item"]["id"]));
                    out.push(t);
                }
            }
            Some("item.completed") => {
                let item = &e["item"];
                if item["type"] == "agent_message" && truthy(&item["text"]) {
                    out.push(Ev::Text(js_string(&item["text"])));
                    return out;
                }
                let Some(t) = tool(item) else { return out };
                let id = js_string(&item["id"]);
                if !started.contains(&id) {
                    out.push(t);
                }
                let output = match item["type"].as_str() {
                    Some("command_execution") => {
                        let agg = if item["aggregated_output"].is_null() { String::new() } else { js_string(&item["aggregated_output"]) };
                        let code = if truthy(&item["exit_code"]) { format!("\n(exit {})", js_string(&item["exit_code"])) } else { String::new() };
                        format!("{}{code}", agg.trim_end()).trim().to_string()
                    }
                    Some("mcp_tool_call") => {
                        let r = &item["result"]["content"];
                        if !r.is_null() { text_of(r) } else { text_of(&item["error"]["message"]) }
                    }
                    _ if item["status"] == "failed" => "failed".into(),
                    _ => String::new(),
                };
                out.push(Ev::ToolResult { id, output });
            }
            Some("turn.completed") => {
                let u = &e["usage"];
                let tokens = u["input_tokens"].as_u64().unwrap_or(0) + u["output_tokens"].as_u64().unwrap_or(0);
                if tokens > 0 {
                    out.push(Ev::Usage { tokens, cost: None });
                }
                out.push(Ev::Done { ok: true, error: None });
            }
            Some("turn.failed") => {
                let error = e["error"]["message"].as_str().map(str::to_string).or_else(|| last_error.clone()).unwrap_or_else(|| "turn failed".into());
                out.push(Ev::Done { ok: false, error: Some(error) });
            }
            Some("error") => {
                // "Reconnecting... 2/5" is codex retrying; only the final error matters
                if let Some(m) = e["message"].as_str()
                    && !m.starts_with("Reconnecting...")
                {
                    last_error = Some(m.into());
                }
            }
            _ => {}
        }
        out
    })
}

/// Codex on this machine (src/engines.ts detectCodex).
pub fn detect(env: &Env, timeout_ms: u64) -> EngineInfo {
    let base = EngineInfo { id: "codex".into(), name: "Codex".into(), install: Some(super::install("codex")), connect: Some("codex login".into()), ..Default::default() };
    let v = detect::run("codex", &["--version"], timeout_ms, env);
    if v.code.is_none() {
        return EngineInfo { detail: "not installed".into(), ..base };
    }
    let base = EngineInfo { installed: true, version: first_version(&v.stdout), ..base };
    let s = detect::run("codex", &["login", "status"], timeout_ms, env);
    let text = strip_ansi(&format!("{}\n{}", s.stdout, s.stderr)).trim().to_string();
    let lower = text.to_lowercase();
    if s.ok && lower.contains("logged in") && !lower.contains("not logged in") {
        let line = text.lines().find(|l| l.to_lowercase().contains("logged in")).unwrap_or("signed in").trim();
        let detail = if line.to_lowercase().starts_with("logged in") { format!("signed in{}", &line["logged in".len()..]) } else { line.to_string() };
        return EngineInfo { connected: true, detail, connect: None, ..base };
    }
    if env.get("OPENAI_API_KEY").is_some_and(|k| !k.is_empty()) {
        return EngineInfo { detail: "not signed in (OPENAI_API_KEY is set: printenv OPENAI_API_KEY | codex login --with-api-key)".into(), ..base };
    }
    EngineInfo { detail: "not signed in".into(), ..base }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::detect::tests::{env, fake_bin, tmp};

    fn events(fixture: &str) -> Vec<Ev> {
        let mut p = parser();
        fixture.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| p(&v)).collect()
    }

    #[test]
    fn exec_json_items_become_tools_and_replies() {
        let evs = events(include_str!("../../../../test/fixtures/codex-tool.jsonl"));
        let shape: Vec<String> = evs
            .iter()
            .map(|e| match e {
                Ev::Tool { name, summary, .. } => format!("tool:{name}:{summary}"),
                Ev::Text(t) => format!("text:{t}"),
                Ev::Session(_) => "session".into(),
                Ev::ToolResult { .. } => "tool_result".into(),
                Ev::Usage { .. } => "usage".into(),
                Ev::Done { .. } => "done".into(),
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(shape, ["session", "tool:bash:npm test", "tool_result", "tool:edit:src/cart.js", "tool_result", "text:Fixed the off-by-one in `cart.js`.", "usage", "done"]);
        assert!(matches!(&evs[2], Ev::ToolResult { output, .. } if output == "1 failing\n(exit 1)"));
        let failed = events(include_str!("../../../../test/fixtures/codex-unauthorized.jsonl"));
        assert_eq!(failed.len(), 2, "the Reconnecting... retries are skipped");
        assert!(matches!(&failed[1], Ev::Done { ok: false, error: Some(e) } if e.starts_with("unexpected status 401 Unauthorized")));
    }

    #[test]
    fn command_lines() {
        let a = |o: RunOpts| Codex.args("go", &o);
        assert_eq!(a(RunOpts::default()), ["exec", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"workspace-write\"", "--", "go"]);
        assert_eq!(
            a(RunOpts { resume: Some("t1".into()), model: Some("gpt-5".into()), ..Default::default() }),
            ["exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"workspace-write\"", "-m", "gpt-5", "t1", "--", "go"]
        );
        let e = a(RunOpts { effort: Some("xhigh".into()), ..Default::default() });
        assert_eq!(&e[e.len() - 4..], ["-c", "model_reasoning_effort=\"xhigh\"", "--", "go"]);
        assert_eq!(Codex.fork_args(&RunOpts { resume: Some("t1".into()), ..Default::default() }).unwrap().last().unwrap(), "t1");
    }

    #[test]
    fn detection() {
        let dir = tmp("codex-detect");
        let bin = dir.join("bin");
        fake_bin(&bin, "codex", r#"case "$*" in "--version") echo "codex-cli 0.167.0";; "login status") echo "Not logged in" >&2; exit 1;; esac"#);
        let p = bin.to_str().unwrap();
        let e = detect(&env(&[("PATH", p)]), 5000);
        assert_eq!((e.installed, e.connected, e.version.as_deref(), e.connect.as_deref()), (true, false, Some("0.167.0"), Some("codex login")));
        fake_bin(&bin, "codex", r#"case "$*" in "--version") echo "codex-cli 0.167.0";; "login status") echo "Logged in using ChatGPT";; esac"#);
        assert_eq!(detect(&env(&[("PATH", p)]), 5000).detail, "signed in using ChatGPT");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
