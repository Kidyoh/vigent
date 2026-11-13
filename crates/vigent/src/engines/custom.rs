//! An engine from your config (src/cli-engines.ts customAdapter):
//!
//!   [engines.gemini]
//!   name = "Gemini CLI"
//!   command = ["gemini", "--yolo", "-p", "{prompt}"]
//!   output = "text"            # or "claude", "codex", ...: it prints their JSON
//!   model_args = ["-m", "{model}"]
//!   models = ["gemini-2.5-pro", "gemini-2.5-flash"]
//!   resume_args = ["--resume", "{id}"]   # with a JSON output: continue its conversation
//!
//! Its command, with {prompt}, {model} and {id} filled in, read as plain text
//! or as the JSON of a CLI vigent already knows.

use super::detect::{self, Env};
use super::{Adapter, Choice, EngineInfo, Ev, Parser, RunOpts};
use crate::config::CustomEngine;

pub struct CustomAdapter {
    pub e: CustomEngine,
    /// the built-in whose JSON it prints (None: plain text)
    pub json: Option<&'static dyn Adapter>,
}

impl CustomAdapter {
    /// What detection says: on PATH or not (vigent can't know a custom CLI's login; it runs as you set it up).
    pub fn info(&self, env: &Env) -> EngineInfo {
        let bin = &self.e.command[0];
        let installed = detect::on_path(bin, env);
        EngineInfo {
            id: self.e.id.clone(),
            name: self.e.name.clone(),
            installed,
            connected: installed,
            detail: if installed { format!("from your config · runs {bin}") } else { format!("{bin} isn't on PATH") },
            install: Some(format!("put {bin} on your PATH")),
            ..Default::default()
        }
    }
}

impl Adapter for CustomAdapter {
    fn id(&self) -> &str {
        &self.e.id
    }
    fn bin(&self) -> String {
        self.e.command[0].clone()
    }
    fn raw(&self) -> bool {
        self.json.is_none()
    }
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String> {
        let model = o.model.clone().unwrap_or_default();
        let id = o.resume.clone().unwrap_or_default();
        let fill = |a: &String| a.replace("{prompt}", prompt).replace("{model}", &model).replace("{id}", &id);
        let rest = &self.e.command[1..];
        let placed = rest.iter().any(|a| a.contains("{prompt}"));
        let mut out: Vec<String> = rest.iter().map(fill).collect();
        out.extend(o.extra_args.clone().unwrap_or_default());
        if o.model.is_some()
            && let Some(m) = &self.e.model_args
        {
            out.extend(m.iter().map(fill));
        }
        if o.resume.is_some()
            && let Some(r) = &self.e.resume_args
        {
            out.extend(r.iter().map(fill));
        }
        if !placed {
            out.push(prompt.into());
        }
        out
    }
    fn parser(&self) -> Parser {
        let Some(json) = self.json else { return Box::new(|_| vec![]) };
        let mut parse = json.parser();
        // without resume_args vigent can't pass a conversation back, so it doesn't keep one
        if self.e.resume_args.is_some() {
            parse
        } else {
            Box::new(move |v| parse(v).into_iter().filter(|e| !matches!(e, Ev::Session(_))).collect())
        }
    }
    fn models(&self, _env: &Env) -> Vec<Choice> {
        let mut out = super::choices::default_only(&self.e.name);
        out.extend(self.e.models.iter().flatten().map(|m| Choice::new(m, Some(m), None)));
        out
    }
    fn detect(&self, env: &Env, _timeout_ms: u64) -> EngineInfo {
        self.info(env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(command: &[&str], output: &str) -> CustomEngine {
        CustomEngine {
            id: "mine".into(),
            name: "Mine".into(),
            command: command.iter().map(|s| s.to_string()).collect(),
            output: output.into(),
            model_args: Some(vec!["-m".into(), "{model}".into()]),
            models: Some(vec!["gemini-2.5-pro".into()]),
            resume_args: None,
        }
    }

    #[test]
    fn prompt_where_you_put_it_or_at_the_end() {
        let a = CustomAdapter { e: engine(&["gemini", "--yolo", "-p", "{prompt}"], "text"), json: None };
        assert!(a.raw());
        assert_eq!(a.args("fix it", &RunOpts::default()), ["--yolo", "-p", "fix it"]);
        assert_eq!(a.args("fix it", &RunOpts { model: Some("gemini-2.5-pro".into()), ..Default::default() }), ["--yolo", "-p", "fix it", "-m", "gemini-2.5-pro"]);
        let c = CustomAdapter { e: engine(&["claudish"], "claude"), json: Some(&super::super::claude::Claude) };
        assert!(!c.raw());
        assert_eq!(c.args("hi", &RunOpts { extra_args: Some(vec!["--x".into()]), ..Default::default() }), ["--x", "hi"], "no {{prompt}}: it goes at the end");
        assert_eq!(c.args("more", &RunOpts { resume: Some("abc".into()), ..Default::default() }), ["more"], "no resume_args: nothing to continue with");
        let mut p = c.parser();
        assert!(p(&serde_json::json!({"type": "system", "subtype": "init", "session_id": "s1"})).is_empty(), "no resume_args: the id isn't kept");
        let mut r = engine(&["claudish"], "claude");
        r.resume_args = Some(vec!["--resume".into(), "{id}".into()]);
        let r = CustomAdapter { e: r, json: Some(&super::super::claude::Claude) };
        assert_eq!(r.args("more", &RunOpts { resume: Some("abc".into()), ..Default::default() }), ["--resume", "abc", "more"]);
        assert_eq!(r.models(&Env::new()).iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["default", "gemini-2.5-pro"]);
        let info = a.info(&crate::engines::detect::tests::env(&[("PATH", "")]));
        assert_eq!((info.installed, info.detail.as_str()), (false, "gemini isn't on PATH"));
    }
}
