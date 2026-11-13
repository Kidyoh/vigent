//! Gemini CLI, run as installed (`gemini --output-format stream-json --prompt`),
//! in the agent's worktree (src/cli-engines.ts geminiAdapter, src/engines.ts
//! detectGemini). Its events: init, message, tool_use, tool_result, error, result.

use serde_json::Value;

use super::common::{first_version, js_string, summarize, truthy};
use super::detect::{self, Env};
use super::{Adapter, Choice, EngineInfo, Ev, Parser, RunOpts};

pub struct Gemini;

impl Adapter for Gemini {
    fn id(&self) -> &str {
        "gemini"
    }
    // file edits go ahead; other tools follow your Gemini CLI settings (headless can't ask)
    fn default_args(&self) -> &'static [&'static str] {
        &["--approval-mode", "auto_edit"]
    }
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String> {
        let mut a: Vec<String> = vec!["--output-format".into(), "stream-json".into()];
        a.extend(o.extra_or(self.default_args()));
        if let Some(m) = &o.model {
            a.extend(["--model".into(), m.clone()]);
        }
        if let Some(id) = &o.resume {
            a.extend(["--resume".into(), id.clone()]);
        }
        a.extend(["--prompt".into(), prompt.into()]);
        a
    }
    fn parser(&self) -> Parser {
        parser()
    }
    fn models(&self, _env: &Env) -> Vec<Choice> {
        super::choices::gemini_choices()
    }
    fn detect(&self, env: &Env, timeout_ms: u64) -> EngineInfo {
        detect(env, timeout_ms)
    }
}

/// A parser for one run of Gemini CLI's stream-json.
pub fn parser() -> Parser {
    Box::new(|e: &Value| {
        let mut out = vec![];
        if !e.is_object() {
            return out;
        }
        match e["type"].as_str() {
            Some("init") => {
                if truthy(&e["session_id"]) {
                    out.push(Ev::Session(js_string(&e["session_id"])));
                }
                if truthy(&e["model"]) {
                    out.push(Ev::Model(js_string(&e["model"])));
                }
            }
            Some("message") => {
                if e["role"] == "assistant"
                    && let Some(t) = e["content"].as_str()
                {
                    out.push(if truthy(&e["delta"]) { Ev::TextDelta(t.into()) } else { Ev::Text(t.into()) });
                }
            }
            Some("tool_use") => {
                let name = if e["tool_name"].is_null() { "tool".into() } else { js_string(&e["tool_name"]) };
                out.push(Ev::Tool { id: js_string(&e["tool_id"]), name, summary: summarize(&e["parameters"]) });
            }
            Some("tool_result") => {
                let output = [&e["output"], &e["error"]["message"], &e["status"]].into_iter().find(|v| !v.is_null()).map(js_string).unwrap_or_default();
                out.push(Ev::ToolResult { id: js_string(&e["tool_id"]), output });
            }
            Some("error") => {
                if e["severity"] == "error" && truthy(&e["message"]) {
                    out.push(Ev::Error(js_string(&e["message"])));
                }
            }
            Some("result") => {
                let st = &e["stats"];
                let tokens = st["total_tokens"].as_u64().unwrap_or_else(|| st["input_tokens"].as_u64().unwrap_or(0) + st["output_tokens"].as_u64().unwrap_or(0));
                if tokens > 0 {
                    out.push(Ev::Usage { tokens, cost: None });
                }
                let ok = e["status"] == "success";
                let error = (!ok).then(|| e["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| "failed".into()));
                out.push(Ev::Done { ok, error });
            }
            _ => {}
        }
        out
    })
}

/// Gemini CLI on this machine (src/engines.ts detectGemini).
pub fn detect(env: &Env, timeout_ms: u64) -> EngineInfo {
    let base = EngineInfo {
        id: "gemini".into(),
        name: "Gemini CLI".into(),
        install: Some(super::install("gemini")),
        connect: Some("run gemini once and sign in (or export GEMINI_API_KEY)".into()),
        ..Default::default()
    };
    let v = detect::run("gemini", &["--version"], timeout_ms, env);
    if v.code.is_none() {
        return EngineInfo { detail: "not installed".into(), ..base };
    }
    let base = EngineInfo { installed: true, version: first_version(&v.stdout), ..base };
    let set = |k: &str| env.get(k).is_some_and(|v| !v.is_empty());
    let key = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].into_iter().find(|k| set(k)).or(set("GOOGLE_GENAI_USE_VERTEXAI").then_some("Vertex AI"));
    // a Google sign-in leaves its credentials in ~/.gemini; vigent only checks the file is there
    let dir = detect::home(env).join(".gemini");
    let signed_in = dir.join("oauth_creds.json").exists() || dir.join("google_accounts.json").exists();
    if key.is_some() || signed_in {
        let detail = match key {
            Some(k) => format!("using {k}"),
            None => "signed in (Google account)".into(),
        };
        return EngineInfo { connected: true, detail, connect: None, ..base };
    }
    EngineInfo { detail: "not signed in".into(), ..base }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::detect::tests::{env, fake_bin, tmp};

    #[test]
    fn stream_json() {
        let mut p = parser();
        let evs: Vec<Ev> = include_str!("../../../../test/fixtures/gemini-stream.jsonl").lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| p(&v)).collect();
        assert_eq!(evs[0], Ev::Session("c0ffee00-1111-2222-3333-444455556666".into()));
        assert_eq!(evs[1], Ev::Model("gemini-2.5-pro".into()));
        assert!(evs.contains(&Ev::Tool { id: "read_file-1".into(), name: "read_file".into(), summary: "cart.js".into() }));
        assert!(evs.contains(&Ev::ToolResult { id: "run_shell_command-2".into(), output: "1 failing".into() }));
        assert!(evs.contains(&Ev::Usage { tokens: 1234, cost: None }));
        assert_eq!(evs.last(), Some(&Ev::Done { ok: true, error: None }));
        let mut p = parser();
        assert!(p(&serde_json::json!({"type": "error", "severity": "warning", "message": "slow network"})).is_empty(), "warnings aren't errors");
        assert_eq!(
            p(&serde_json::json!({"type": "result", "status": "error", "error": {"message": "Quota exceeded"}})),
            [Ev::Done { ok: false, error: Some("Quota exceeded".into()) }]
        );
    }

    #[test]
    fn command_line_and_detection() {
        assert_eq!(Gemini.args("why?", &RunOpts::default()), ["--output-format", "stream-json", "--approval-mode", "auto_edit", "--prompt", "why?"]);
        let o = RunOpts { extra_args: Some(vec!["--approval-mode".into(), "yolo".into()]), model: Some("flash".into()), resume: Some("c0".into()), ..Default::default() };
        assert_eq!(Gemini.args("hi", &o), ["--output-format", "stream-json", "--approval-mode", "yolo", "--model", "flash", "--resume", "c0", "--prompt", "hi"]);
        let dir = tmp("gemini-detect");
        let bin = dir.join("bin");
        fake_bin(&bin, "gemini", r#"[ "$1" = "--version" ] && echo 0.12.0"#);
        let home = dir.join("home");
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        let e = |extra: &[(&str, &str)]| {
            let mut v = vec![("PATH", bin.to_str().unwrap()), ("HOME", home.to_str().unwrap())];
            v.extend_from_slice(extra);
            detect(&env(&v), 5000)
        };
        let d = e(&[]);
        assert_eq!((d.installed, d.connected, d.version.as_deref(), d.detail.as_str()), (true, false, Some("0.12.0"), "not signed in"));
        assert_eq!(e(&[("GEMINI_API_KEY", "x")]).detail, "using GEMINI_API_KEY");
        std::fs::write(home.join(".gemini").join("oauth_creds.json"), "{}").unwrap();
        assert_eq!(e(&[]).detail, "signed in (Google account)");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
