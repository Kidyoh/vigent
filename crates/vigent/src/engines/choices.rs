//! What `:model` and `:effort` offer, per engine (src/choices.ts). Model lists
//! come from the engine itself where it can say (`pi --list-models`, `codex
//! debug models`, `opencode models`); any name can still be typed in the picker.

use serde_json::Value;
use std::sync::Mutex;

use super::detect::{self, Env};

/// A pick in :model, :effort, :engine (src/choices.ts Choice).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Choice {
    pub value: String,
    /// what the picker shows (default: the value)
    pub label: Option<String>,
    pub note: Option<String>,
}

impl Choice {
    pub fn new(value: &str, label: Option<&str>, note: Option<&str>) -> Choice {
        Choice { value: value.into(), label: label.map(str::to_string), note: note.map(str::to_string) }
    }
    pub fn shown(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.value)
    }
}

/// Claude Code's models, newest first: what `--model` takes, and their names (id, label, alias).
pub const CLAUDE_MODELS: [(&str, &str, &str); 4] = [
    ("claude-fable-5-1", "Claude Fable 5.1", "fable"),
    ("claude-opus-5-5", "Claude Opus 5.5", "opus"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", "sonnet"),
    ("claude-haiku-5-5", "Claude Haiku 5.5", "haiku"),
];

fn cap(w: &str) -> String {
    let mut c = w.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// one word of a name: known spellings, sizes in capitals (70b → 70B), versions as they are
fn word(w: &str) -> String {
    let known = match w {
        "gpt" => "GPT",
        "oss" => "OSS",
        "ai" => "AI",
        "xai" => "xAI",
        "llama" => "Llama",
        "gemini" => "Gemini",
        "deepseek" => "DeepSeek",
        "qwen" => "Qwen",
        "kimi" => "Kimi",
        "glm" => "GLM",
        "mini" => "Mini",
        "nano" => "Nano",
        "codex" => "Codex",
        _ => "",
    };
    if !known.is_empty() {
        return known.into();
    }
    // /^\d+(\.\d+)?[bkm]$/
    if let Some(num) = w.strip_suffix(['b', 'k', 'm']) {
        let (a, b) = num.split_once('.').unwrap_or((num, "0"));
        if all_digits(a) && all_digits(b) {
            return w.to_uppercase();
        }
    }
    if w.starts_with(|c: char| c.is_ascii_digit()) {
        return w.into();
    }
    cap(w)
}

fn words(s: &str) -> String {
    s.split('-').map(word).collect::<Vec<_>>().join(" ")
}

/// A model's name for people, from its id: claude-fable-5-1 → Claude Fable 5.1,
/// claude-sonnet-4-5-20250929 → Claude Sonnet 4.5, gpt-5.5-codex → GPT-5.5 Codex,
/// anthropic/claude-opus-4-1 → Claude Opus 4.1. Aliases: opus → Claude Opus (latest).
pub fn model_label(id: &str) -> String {
    if let Some((_, label, _)) = CLAUDE_MODELS.iter().find(|m| m.0 == id) {
        return label.to_string();
    }
    if let Some((_, label, _)) = CLAUDE_MODELS.iter().find(|m| m.2 == id) {
        let family = label.rsplit_once(' ').map(|(f, _)| f).unwrap_or(label);
        return format!("{family} (latest)");
    }
    let bare = id.rsplit('/').next().unwrap_or(id);
    if let Some(l) = claude_label(bare) {
        return l;
    }
    // gpt-5.5-codex, gpt-6-astra
    if let Some(rest) = bare.strip_prefix("gpt-") {
        let (ver, tail) = match rest.split_once('-') {
            Some((v, t)) => (v, Some(t)),
            None => (rest, None),
        };
        if !ver.is_empty() && ver.bytes().all(|b| b.is_ascii_digit() || b == b'.') && tail.is_none_or(|t| !t.is_empty()) {
            return format!("GPT-{ver}{}", tail.map(|t| format!(" {}", words(t))).unwrap_or_default());
        }
    }
    // o3-mini
    if bare.starts_with('o') && bare[1..].starts_with(|c: char| c.is_ascii_digit()) {
        return bare.into();
    }
    if let Some(rest) = bare.strip_prefix("gpt-") {
        return format!("GPT-{}", words(rest));
    }
    words(bare)
}

/// claude-<family>-<major>[-<minor>][-date][\[1m\]], or claude-<major>[-<minor>]-<family>[-date]
fn claude_label(bare: &str) -> Option<String> {
    let rest = bare.strip_prefix("claude-")?;
    let (rest, one_m) = match rest.strip_suffix("[1m]") {
        Some(r) => (r, true),
        None => (rest, false),
    };
    let t: Vec<&str> = rest.split('-').collect();
    let lower = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase());
    let date = |s: &str| s.len() == 8 && all_digits(s);
    // modern: family, major, minor?, date?
    if t.len() >= 2 && lower(t[0]) && all_digits(t[1]) {
        let mut i = 2;
        let mut minor = None;
        if t.get(i).is_some_and(|s| all_digits(s) && s.len() <= 2) {
            minor = Some(t[i]);
            i += 1;
        }
        if t.get(i).is_some_and(|s| date(s)) {
            i += 1;
        }
        if i == t.len() {
            return Some(format!("Claude {} {}{}{}", cap(t[0]), t[1], minor.map(|m| format!(".{m}")).unwrap_or_default(), if one_m { " (1M)" } else { "" }));
        }
    }
    if one_m {
        return None;
    }
    // legacy: major, minor?, family, date?
    if !t.is_empty() && all_digits(t[0]) {
        let mut i = 1;
        let mut minor = None;
        if t.get(i).is_some_and(|s| s.len() == 1 && all_digits(s)) {
            minor = Some(t[i]);
            i += 1;
        }
        let family = t.get(i).filter(|s| lower(s))?;
        i += 1;
        if t.get(i).is_some_and(|s| date(s)) {
            i += 1;
        }
        if i == t.len() {
            return Some(format!("Claude {} {}{}", cap(family), t[0], minor.map(|m| format!(".{m}")).unwrap_or_default()));
        }
    }
    None
}

/// `:effort`'s list for an engine: default, then its levels.
pub fn effort_choices(engine: &str) -> Vec<Choice> {
    let mut out = vec![Choice::new("default", None, Some("what the engine uses"))];
    out.extend(super::efforts(engine).iter().map(|v| Choice::new(v, None, None)));
    out
}

/// "Default · <engine>'s own choice", for engines that list nothing else.
pub fn default_only(name: &str) -> Vec<Choice> {
    vec![Choice::new("default", Some("Default"), Some(&format!("{name}'s own choice")))]
}

pub fn claude_models() -> Vec<Choice> {
    let mut out = vec![Choice::new("default", Some("Default"), Some("Claude Code's own choice"))];
    out.extend(CLAUDE_MODELS.iter().map(|(id, label, _)| Choice::new(id, Some(label), Some(id))));
    out
}

pub fn gemini_choices() -> Vec<Choice> {
    vec![
        Choice::new("default", Some("Default"), Some("Gemini CLI's own choice (auto)")),
        Choice::new("pro", Some("Gemini Pro"), Some("pro: Gemini CLI's alias for its Pro model")),
        Choice::new("flash", Some("Gemini Flash"), Some("flash")),
        Choice::new("flash-lite", Some("Gemini Flash Lite"), Some("flash-lite")),
    ]
}

pub fn cursor_choices() -> Vec<Choice> {
    vec![Choice::new("default", Some("Default"), Some("Cursor CLI's own choice (type any model name with /)"))]
}

/// Every engine's models (blocking: Codex, OpenCode and pi are asked; run it off the UI thread).
pub fn model_choices(engine: &str, env: &Env) -> Vec<Choice> {
    if engine == "pi" {
        return pi_choices(env);
    }
    match super::adapter(engine) {
        Some(a) => a.models(env),
        None => default_only(&super::engine_name(engine)),
    }
}

pub fn opencode_choices(env: &Env) -> Vec<Choice> {
    let mut out = vec![Choice::new("default", Some("Default"), Some("OpenCode's own choice"))];
    out.extend(opencode_models(env).iter().map(|v| Choice::new(v, Some(&model_label(v)), Some(v))));
    out
}

fn opencode_models(env: &Env) -> Vec<String> {
    let r = detect::run("opencode", &["models"], 20000, env);
    if !r.ok {
        return vec![];
    }
    let ok = |s: &str| {
        let Some((p, m)) = s.split_once('/') else { return false };
        !p.is_empty()
            && !m.is_empty()
            && p.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
            && m.chars().all(|c| c.is_alphanumeric() || "_.:@-".contains(c))
    };
    super::common::strip_ansi(&r.stdout).lines().map(str::trim).filter(|l| ok(l)).map(str::to_string).collect()
}

/// A model `codex debug models` lists.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexModel {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    /// the reasoning efforts this model takes
    pub efforts: Vec<String>,
}

/// The models `codex debug models` lists for people to pick (not the hidden ones).
pub fn parse_codex_models(json: &str) -> Vec<CodexModel> {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return vec![] };
    let Some(models) = v["models"].as_array() else { return vec![] };
    models
        .iter()
        .filter(|m| m["slug"].is_string() && (m.get("visibility").is_none_or(Value::is_null) || m["visibility"] == "list"))
        .map(|m| CodexModel {
            slug: m["slug"].as_str().unwrap_or_default().into(),
            name: m["display_name"].as_str().or(m["slug"].as_str()).unwrap_or_default().into(),
            description: m["description"].as_str().map(str::to_string),
            efforts: m["supported_reasoning_levels"]
                .as_array()
                .map(|l| l.iter().filter_map(|x| x.as_str().or(x["effort"].as_str()).map(str::to_string)).collect())
                .unwrap_or_default(),
        })
        .collect()
}

static CODEX_CATALOG: Mutex<Option<Vec<CodexModel>>> = Mutex::new(None);

/// The models your Codex offers (its own catalog). Asked once per run for vigent's
/// own environment; empty when Codex isn't installed or can't say.
pub fn codex_models(env: &Env, cache: bool) -> Vec<CodexModel> {
    if cache && let Some(c) = CODEX_CATALOG.lock().ok().and_then(|c| c.clone()) {
        return c;
    }
    let r = detect::run(&super::bin("codex"), &["debug", "models"], 20000, env);
    let list = if r.ok { parse_codex_models(&r.stdout) } else { vec![] };
    if cache
        && !list.is_empty()
        && let Ok(mut c) = CODEX_CATALOG.lock()
    {
        *c = Some(list.clone());
    }
    list
}

pub fn codex_choices(env: &Env) -> Vec<Choice> {
    codex_choices_from(&codex_models(env, true))
}

pub fn codex_choices_from(models: &[CodexModel]) -> Vec<Choice> {
    let mut out = vec![Choice::new("default", Some("Default"), Some("Codex's own choice"))];
    for m in models {
        let label = if m.name.chars().any(|c| c.is_ascii_uppercase()) { m.name.clone() } else { model_label(&m.slug) };
        let note = match &m.description {
            Some(d) => format!("{} · {d}", m.slug),
            None => m.slug.clone(),
        };
        out.push(Choice::new(&m.slug, Some(&label), Some(&note)));
    }
    out
}

/// `:effort` for an agent: the levels its engine takes; for Codex, the levels
/// of the model it uses (all of Codex's levels when that's its default).
pub fn effort_choices_for(engine: &str, model: Option<&str>, env: &Env) -> Vec<Choice> {
    if engine != "codex" {
        return effort_choices(engine);
    }
    effort_choices_codex(&codex_models(env, true), model)
}

pub fn effort_choices_codex(catalog: &[CodexModel], model: Option<&str>) -> Vec<Choice> {
    let own = catalog.iter().find(|m| Some(m.slug.as_str()) == model).map(|m| m.efforts.clone()).filter(|e| !e.is_empty());
    let levels: Vec<String> = own.unwrap_or_else(|| {
        let mut all: Vec<String> = vec![];
        for e in catalog.iter().flat_map(|m| m.efforts.iter()) {
            if !all.contains(e) {
                all.push(e.clone());
            }
        }
        all
    });
    if levels.is_empty() {
        return effort_choices("codex");
    }
    let known = super::efforts("codex");
    let mut out = vec![Choice::new("default", None, Some("what the model uses"))];
    out.extend(known.iter().filter(|e| levels.iter().any(|l| l == *e)).map(|v| Choice::new(v, None, None)));
    out.extend(levels.iter().filter(|l| !known.contains(&l.as_str())).map(|v| Choice::new(v, None, None)));
    out
}

/// pi's models: what your pi can use now (`pi --list-models`), as provider/model.
pub fn pi_choices(env: &Env) -> Vec<Choice> {
    let models = pi_models(env);
    if models.is_empty() {
        return vec![Choice::new("default", Some("Default"), Some("pi's own choice (pi isn't installed or lists no models)"))];
    }
    let mut out = vec![Choice::new("default", Some("Default"), Some("pi's own choice"))];
    out.extend(models.iter().map(|(p, id)| {
        let v = format!("{p}/{id}");
        Choice::new(&v, Some(&model_label(id)), Some(&v))
    }));
    out
}

/// `pi --list-models`: "provider/id" pairs (empty when pi isn't installed).
pub fn pi_models(env: &Env) -> Vec<(String, String)> {
    let mut env = env.clone();
    env.insert("PI_OFFLINE".into(), "1".into());
    let r = detect::run("pi", &["--list-models"], 20000, &env);
    if !r.ok {
        return vec![];
    }
    // pi prints the table on stderr (stdout stays clean for piping); take whichever has it
    parse_model_list(&format!("{}\n{}", r.stdout, r.stderr))
}

/// `provider  model  context ...` rows, under a `provider  model` header (src/pi-cli.ts parseModelList).
pub fn parse_model_list(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut table = false;
    for line in text.lines() {
        let mut w = line.split_whitespace();
        let (Some(p), Some(id)) = (w.next(), w.next()) else { continue };
        if p == "provider" && id == "model" {
            table = true;
            continue;
        }
        if table {
            out.push((p.to_string(), id.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_spell_out_versions() {
        let cases = [
            ("claude-fable-5-1", "Claude Fable 5.1"),
            ("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
            ("claude-3-5-haiku-20241022", "Claude Haiku 3.5"),
            ("claude-opus-5-5[1m]", "Claude Opus 5.5 (1M)"),
            ("opus", "Claude Opus (latest)"),
            ("gpt-5.5-codex", "GPT-5.5 Codex"),
            ("gpt-5.1-codex-mini", "GPT-5.1 Codex Mini"),
            ("gpt-oss-120b", "GPT-OSS 120B"),
            ("o3-mini", "o3-mini"),
            ("anthropic/claude-opus-4-1", "Claude Opus 4.1"),
            ("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
        ];
        for (id, name) in cases {
            assert_eq!(model_label(id), name, "{id}");
        }
    }

    #[test]
    fn lists_per_engine() {
        let c = claude_models();
        assert_eq!(c.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["default", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
        assert_eq!(c[2].shown(), "Claude Opus 5.5");
        let none = crate::engines::detect::tests::env(&[("PATH", "")]);
        assert_eq!(model_choices("codex", &none).iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["default"]);
        assert_eq!(model_choices("pi", &none).iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["default"]);
        assert_eq!(model_choices("gemini", &none).iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["default", "pro", "flash", "flash-lite"]);
        assert_eq!(effort_choices("pi")[0].value, "default");
        assert_eq!(super::super::efforts("claude"), ["low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn codex_catalog() {
        let json = r#"{"models":[
            {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","description":"Frontier intelligence.","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"ultra"}]},
            {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"}]},
            {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","supported_reasoning_levels":[]}]}"#;
        let m = parse_codex_models(json);
        assert_eq!(m.iter().map(|m| m.slug.as_str()).collect::<Vec<_>>(), ["gpt-6-astra", "gpt-5.5"]);
        assert_eq!(m[0].efforts, ["low", "high", "ultra"]);
        assert!(parse_codex_models("not json").is_empty());
        let c = codex_choices_from(&m);
        assert_eq!((c[1].shown(), c[1].note.as_deref()), ("GPT-6-Astra", Some("gpt-6-astra · Frontier intelligence.")));
        let v = |l: Vec<Choice>| l.into_iter().map(|c| c.value).collect::<Vec<_>>();
        assert_eq!(v(effort_choices_codex(&m, Some("gpt-6-astra"))), ["default", "low", "high", "ultra"]);
        assert_eq!(v(effort_choices_codex(&m, None)), ["default", "low", "medium", "high", "ultra"]);
        assert_eq!(v(effort_choices_codex(&[], None)), v(effort_choices("codex")));
    }

    #[test]
    fn pi_model_table() {
        let t = "Loading...\nprovider  model     context\nfake      test      128k\nanthropic claude-x  200k\n";
        assert_eq!(parse_model_list(t), [("fake".to_string(), "test".to_string()), ("anthropic".into(), "claude-x".into())]);
    }
}
