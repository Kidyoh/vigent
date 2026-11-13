//! What runs agents: the coding-agent CLIs you have installed, each with its
//! own login (vigent never reads credentials). The same shape as
//! src/cli-engines.ts (CliAdapter), src/engines.ts (EngineInfo, detection,
//! custom engines, auto) and src/choices.ts (models, efforts).
//!
//! EXTENSION POINT (Engines area): an engine is one file here with a type that
//! implements [`Adapter`], plus one line in [`ADAPTERS`]. Everything that lists
//! engines (the sidebar, the start screen, :checkhealth, :engine) reads
//! [`KNOWN`] and the registry, so nothing else needs editing to add one.
//! Engines of your own (`[engines.<id>] command = [...]`) are registered at
//! startup with [`register_custom`] and show up everywhere the same way.
//! pi isn't a CLI adapter: it's one long-running RPC process per agent (pi.rs).

pub mod choices;
pub mod claude;
pub mod codex;
pub mod common;
pub mod cursor;
pub mod custom;
pub mod detect;
pub mod gemini;
pub mod opencode;
pub mod permissions;
pub mod pi;
pub mod picker;
pub mod run;
pub mod select;

use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::RwLock;

pub use choices::Choice;
pub use detect::Env;

/// What one line of a CLI's output means to the transcript (src/cli-engines.ts CliEvent).
#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    /// the CLI's conversation id, passed back to resume it
    Session(String),
    /// a message the CLI saved, by its id (Claude Code), to fork the conversation at it later
    Message(String),
    Model(String),
    /// a piece of the reply being written
    TextDelta(String),
    /// a finished reply (replaces what was streamed for it)
    Text(String),
    /// a tool call; the same id again (within a turn) updates the line it started
    Tool { id: String, name: String, summary: String },
    ToolResult { id: String, output: String },
    /// the model started or stopped thinking
    Thinking(bool),
    Usage { tokens: u64, cost: Option<f64> },
    Error(String),
    /// tools the CLI's permission settings refused to run (Claude Code's permission_denials)
    Denied(Vec<Denial>),
    /// the model ended its turn, before the CLI exits (Claude Code summarizes for a few seconds)
    TurnEnd,
    /// the model started a message: after TurnEnd, the turn went on (a Stop hook)
    TurnStart,
    Done { ok: bool, error: Option<String> },
}

/// A tool call the CLI refused because its permission settings don't allow it.
#[derive(Debug, Clone, PartialEq)]
pub struct Denial {
    pub name: String,
    pub input: Value,
}

/// How to run one turn (src/cli-engines.ts CliRunOptions).
#[derive(Debug, Clone, Default)]
pub struct RunOpts {
    /// the agent's folder (OpenCode takes it with --dir)
    pub cwd: String,
    pub model: Option<String>,
    /// reasoning effort: claude --effort, codex model_reasoning_effort, opencode --variant
    pub effort: Option<String>,
    /// the CLI's conversation id, to continue it
    pub resume: Option<String>,
    /// continue `resume` as a new conversation, leaving that one as it is
    pub fork: bool,
    /// the message to fork at (Claude Code)
    pub fork_at: Option<String>,
    /// [engines.<id>] args from config: replaces the adapter's default_args
    pub extra_args: Option<Vec<String>>,
    /// files attached with @path (OpenCode takes them with -f)
    pub files: Vec<String>,
    /// Claude Code permission rules allowed for this run (--allowedTools)
    pub allowed_tools: Vec<String>,
}

impl RunOpts {
    /// [engines.<id>] args, or the adapter's defaults.
    pub fn extra_or(&self, defaults: &[&str]) -> Vec<String> {
        match &self.extra_args {
            Some(a) => a.clone(),
            None => defaults.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// A fresh parser for one run (parsers may keep a little state between lines).
pub type Parser = Box<dyn FnMut(&Value) -> Vec<Ev> + Send>;

/// One agent CLI. Implement this in engines/<id>.rs and add it to [`ADAPTERS`].
pub trait Adapter: Sync + Send {
    /// "claude", "codex", ...: what config.toml, --engine and :engine call it
    fn id(&self) -> &str;
    /// the program it runs
    fn bin(&self) -> String {
        spec(self.id()).map(|s| s.bin).unwrap_or("").to_string()
    }
    /// default extra arguments, replaced by [engines.<id>] args
    fn default_args(&self) -> &'static [&'static str] {
        &[]
    }
    /// the arguments for one turn
    fn args(&self, prompt: &str, o: &RunOpts) -> Vec<String>;
    /// a parser for one run's output lines
    fn parser(&self) -> Parser;
    /// it prints plain text, not JSON: every line goes into the reply
    fn raw(&self) -> bool {
        false
    }
    /// it can fork a conversation (args reads RunOpts::fork)
    fn can_fork(&self) -> bool {
        false
    }
    /// fork `resume` right away, with no prompt: the new id comes back as Ev::Session
    fn fork_args(&self, _o: &RunOpts) -> Option<Vec<String>> {
        None
    }
    /// what :model offers (blocking: it may ask the CLI; call it off the UI thread)
    fn models(&self, _env: &Env) -> Vec<Choice> {
        choices::default_only(&engine_name(self.id()))
    }
    /// installed? signed in? Blocking (runs the CLI's version and status commands): call it off the UI thread.
    fn detect(&self, env: &Env, _timeout_ms: u64) -> EngineInfo {
        let s = spec(self.id());
        let installed = detect::on_path(&self.bin(), env);
        EngineInfo {
            id: self.id().into(),
            name: engine_name(self.id()),
            installed,
            detail: if installed { String::new() } else { "not installed".into() },
            install: s.map(|s| s.install.to_string()),
            ..Default::default()
        }
    }
}

/// EXTENSION POINT: every built-in CLI engine. One line per engine.
pub static ADAPTERS: &[&dyn Adapter] = &[&claude::Claude, &codex::Codex, &opencode::OpenCode, &gemini::Gemini, &cursor::Cursor];

/// Engines from config ([engines.<id>] with a command), registered at startup.
static CUSTOM: RwLock<Vec<&'static custom::CustomAdapter>> = RwLock::new(Vec::new());

/// Make engines of your own known everywhere engines are listed (src/engines.ts registerCustomEngine).
/// One with a built-in's id replaces that engine.
pub fn register_custom(list: &[crate::config::CustomEngine]) {
    let mut all = CUSTOM.write().unwrap_or_else(|e| e.into_inner());
    for e in list {
        let json = (e.output != "text").then(|| builtin(&e.output)).flatten();
        let a: &'static custom::CustomAdapter = Box::leak(Box::new(custom::CustomAdapter { e: e.clone(), json }));
        match all.iter_mut().find(|c| c.e.id == e.id) {
            Some(slot) => *slot = a,
            None => all.push(a),
        }
    }
}

/// The engines from your config.
pub fn customs() -> Vec<&'static custom::CustomAdapter> {
    CUSTOM.read().map(|v| v.clone()).unwrap_or_default()
}

fn custom(id: &str) -> Option<&'static custom::CustomAdapter> {
    customs().into_iter().find(|c| c.e.id == id)
}

fn builtin(id: &str) -> Option<&'static dyn Adapter> {
    ADAPTERS.iter().copied().find(|a| a.id() == id)
}

/// The adapter for a CLI engine: yours from config, else a built-in one (src/cli-engines.ts adapterFor).
pub fn adapter(id: &str) -> Option<&'static dyn Adapter> {
    match custom(id) {
        Some(c) => Some(c as &dyn Adapter),
        None => builtin(id),
    }
}

/// An engine vigent knows by name (src/engines.ts ENGINE_IDS, ENGINE_NAMES, ENGINE_BINS, INSTALL).
#[derive(Debug)]
pub struct Spec {
    pub id: &'static str,
    pub name: &'static str,
    pub bin: &'static str,
    pub install: &'static str,
}

pub const PI_INSTALL: &str = "npm install -g @mariozechner/pi-coding-agent";

/// The built-in engines, in the order vigent lists them.
pub static KNOWN: [Spec; 6] = [
    Spec { id: "pi", name: "pi", bin: "pi", install: PI_INSTALL },
    Spec { id: "claude", name: "Claude Code", bin: "claude", install: "npm install -g @anthropic-ai/claude-code" },
    Spec { id: "codex", name: "Codex", bin: "codex", install: "npm install -g @openai/codex" },
    Spec { id: "opencode", name: "OpenCode", bin: "opencode", install: "npm install -g opencode-ai" },
    Spec { id: "gemini", name: "Gemini CLI", bin: "gemini", install: "npm install -g @google/gemini-cli" },
    Spec { id: "cursor", name: "Cursor CLI", bin: "cursor-agent", install: "curl https://cursor.com/install -fsS | bash" },
];

/// The CLIs auto picks from, in order (src/engines.ts CLI_IDS).
pub const CLI_IDS: [&str; 5] = ["claude", "codex", "opencode", "gemini", "cursor"];

/// A built-in engine's spec.
pub fn spec(id: &str) -> Option<&'static Spec> {
    KNOWN.iter().find(|s| s.id == id)
}

/// The id as a `&'static str`: a built-in's or one from your config.
pub fn intern(id: &str) -> Option<&'static str> {
    if let Some(c) = custom(id) {
        return Some(c.e.id.as_str());
    }
    spec(id).map(|s| s.id)
}

/// Every engine, built-in ones first (src/engines.ts allEngineIds).
pub fn all_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = KNOWN.iter().map(|s| s.id).collect();
    for c in customs() {
        if !ids.contains(&c.e.id.as_str()) {
            ids.push(c.e.id.as_str());
        }
    }
    ids
}

/// A built-in engine or one from your config (src/engines.ts isEngineId).
pub fn is_engine_id(id: &str) -> bool {
    intern(id).is_some()
}

/// This build can start agents on it: pi, or a CLI adapter.
pub fn runnable(id: &str) -> bool {
    id == "pi" || adapter(id).is_some()
}

/// Reasoning effort / thinking levels each built-in engine accepts (src/choices.ts EFFORTS).
pub fn efforts(id: &str) -> &'static [&'static str] {
    match id {
        "pi" => &["off", "minimal", "low", "medium", "high", "xhigh"],
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        // what Codex's models take between them; each model's own levels come from `codex debug models`
        "codex" => &["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        "opencode" => &["minimal", "low", "medium", "high", "max"],
        // gemini, cursor and custom engines take no effort setting of their own
        _ => &[],
    }
}

/// What vigent calls an engine: "Claude Code", or a custom engine's name.
pub fn engine_name(id: &str) -> String {
    if let Some(c) = custom(id) {
        return c.e.name.clone();
    }
    spec(id).map(|s| s.name.to_string()).unwrap_or_else(|| id.to_string())
}

/// The program an engine runs.
pub fn bin(id: &str) -> String {
    match adapter(id) {
        Some(a) => a.bin(),
        None => spec(id).map(|s| s.bin).unwrap_or(id).to_string(),
    }
}

/// How to install an engine.
pub fn install(id: &str) -> String {
    match custom(id) {
        Some(c) => format!("put {} on your PATH", c.e.command[0]),
        None => spec(id).map(|s| s.install).unwrap_or("").to_string(),
    }
}

/// An engine on this machine (src/engines.ts EngineInfo).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// signed in / has credentials it can use
    pub connected: bool,
    pub version: Option<String>,
    /// one line: how it's signed in, or why it isn't
    pub detail: String,
    /// the command to run to connect it
    pub connect: Option<String>,
    /// how to install it
    pub install: Option<String>,
    /// sign-in status not known yet (shown while the real check runs)
    pub checking: bool,
    /// environment variables left out when it runs, so the CLI uses its own login
    pub drop_env: Vec<String>,
}

impl EngineInfo {
    /// this build can run it
    pub fn ported(&self) -> bool {
        runnable(&self.id)
    }
    /// it can start agents now (signed in, as far as vigent can tell)
    pub fn ready(&self) -> bool {
        self.connected
    }
}

/// What's known instantly, without running anything: which CLIs are on PATH,
/// and pi's keys (src/engines.ts quickEngines).
pub fn quick(env: &Env) -> Vec<EngineInfo> {
    let customs = customs();
    let mut out = vec![detect::detect_pi(env)];
    for id in CLI_IDS.iter().filter(|id| !customs.iter().any(|c| c.e.id == **id)) {
        let s = spec(id).expect("a built-in");
        let installed = detect::on_path(s.bin, env);
        out.push(EngineInfo {
            id: s.id.into(),
            name: s.name.into(),
            installed,
            checking: installed,
            detail: if installed { "checking sign-in…".into() } else { "not installed".into() },
            install: Some(s.install.into()),
            ..Default::default()
        });
    }
    out.extend(customs.iter().map(|c| c.info(env)));
    out
}

/// Check every engine in parallel; each CLI check is bounded by `timeout_ms` (src/engines.ts detectEngines).
pub fn detect_all(env: &Env, timeout_ms: u64) -> Vec<EngineInfo> {
    let customs = customs();
    let mut handles = vec![];
    for id in CLI_IDS.iter().filter(|id| !customs.iter().any(|c| c.e.id == **id)) {
        let a = builtin(id).expect("a built-in adapter");
        let env = env.clone();
        handles.push(std::thread::spawn(move || a.detect(&env, timeout_ms)));
    }
    let mut out = vec![detect::detect_pi(env)];
    out.extend(handles.into_iter().filter_map(|h| h.join().ok()));
    out.extend(customs.iter().map(|c| c.info(env)));
    out
}

/// The engine new agents use when none is given ("auto"): the first signed-in
/// CLI, so your own login and settings are used; pi only when no CLI is ready
/// and pi has a key. While the sign-in checks run, an installed CLI still wins
/// over pi. With nothing ready, the first installed CLI, else pi.
pub fn default_engine(infos: &[EngineInfo]) -> &'static str {
    let cli = |ok: &dyn Fn(&EngineInfo) -> bool| CLI_IDS.iter().copied().find(|id| infos.iter().find(|e| e.id == *id).is_some_and(ok));
    if let Some(id) = cli(&|e| e.connected).or_else(|| cli(&|e| e.installed && e.checking)) {
        return id;
    }
    if infos.iter().find(|e| e.id == "pi").is_some_and(|e| e.connected) {
        return "pi";
    }
    cli(&|e| e.installed).unwrap_or("pi")
}

/// Before any check (no infos yet): the first CLI on PATH, else pi.
pub fn default_engine_on_path(env: &Env) -> &'static str {
    CLI_IDS.iter().copied().find(|id| detect::on_path(spec(id).map(|s| s.bin).unwrap_or(id), env)).unwrap_or("pi")
}

/// How the App runs an agent's next turn: its CLI, with what config and detection say.
#[derive(Debug, Clone, Default)]
pub struct Launch {
    pub bin: String,
    /// [engines.<id>] args (None: the adapter's defaults)
    pub extra_args: Option<Vec<String>>,
    /// [engines.claude] allow
    pub allow: Vec<String>,
    /// [engines.claude] ask
    pub ask: bool,
    /// leave these out of its environment (detection's dropEnv)
    pub drop_env: Vec<String>,
}

/// Engine-wide state on the App (Engines area: add fields here, not to App).
pub struct Engines {
    /// every known engine; `checking` until detection comes back
    pub infos: Vec<EngineInfo>,
    /// `engine` from config.toml, --engine or :engine; "auto" lets default_engine() pick
    pub preferred: &'static str,
    /// model for new agents, per engine ([engines.<id>] model, --model, :model with no agent open)
    pub new_model: BTreeMap<String, String>,
    /// effort for new agents, per engine ([engines.<id>] effort, :effort with no agent open)
    pub new_effort: BTreeMap<String, String>,
    /// :model, :effort, :engine
    pub picker: Option<picker::Picker>,
    /// the environment engines run with (and detection reads)
    pub env: Env,
}

impl Default for Engines {
    fn default() -> Self {
        let env = detect::process_env();
        Engines { infos: quick(&env), preferred: "auto", new_model: BTreeMap::new(), new_effort: BTreeMap::new(), picker: None, env }
    }
}

impl Engines {
    pub fn get(&self, id: &str) -> Option<&EngineInfo> {
        self.infos.iter().find(|e| e.id == id)
    }
    pub fn ready_count(&self) -> usize {
        self.infos.iter().filter(|e| e.ready()).count()
    }
    /// The engine new agents start on: the one you picked, else auto's pick.
    pub fn default_engine(&self) -> &'static str {
        if self.preferred == "auto" { default_engine(&self.infos) } else { self.preferred }
    }
}

/// The model an agent shows: the one asked for, else the one the engine reported, else the engine's name (TS Session.model).
pub fn shown_model(a: &crate::session::Session) -> String {
    a.requested_model.clone().or_else(|| a.model.clone()).unwrap_or_else(|| engine_name(&a.engine))
}

/// The winbar's model part: the engine (when the model isn't its name), the model and the effort.
pub fn model_text(a: &crate::session::Session) -> String {
    let model = shown_model(a);
    let name = engine_name(&a.engine);
    let engine = if a.engine != "pi" && model != name { format!("{name} · ") } else { String::new() };
    let effort = a.effort.as_ref().map(|e| format!(" · {e}")).unwrap_or_default();
    format!("{engine}{model}{effort}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, installed: bool, connected: bool, checking: bool) -> EngineInfo {
        EngineInfo { id: id.into(), name: id.into(), installed, connected, checking, ..Default::default() }
    }

    #[test]
    fn auto_picks_a_signed_in_cli_before_pi() {
        let pick = |pi: (bool, bool, bool), claude: (bool, bool, bool), codex: (bool, bool, bool)| {
            default_engine(&[e("pi", pi.0, pi.1, pi.2), e("claude", claude.0, claude.1, claude.2), e("codex", codex.0, codex.1, codex.2), e("opencode", false, false, false)])
        };
        let (none, inst, conn, check) = ((false, false, false), (true, false, false), (true, true, false), (true, false, true));
        assert_eq!(pick(conn, conn, inst), "claude");
        assert_eq!(pick(conn, inst, conn), "codex");
        assert_eq!(pick(conn, check, none), "claude", "while sign-in checks run: the installed CLI, not pi");
        assert_eq!(pick(conn, inst, inst), "pi");
        assert_eq!(pick(inst, inst, inst), "claude", "nothing ready: the first installed CLI");
        assert_eq!(pick(inst, none, none), "pi");
    }

    #[test]
    fn every_known_engine_runs() {
        for s in &KNOWN {
            assert!(runnable(s.id), "{}", s.id);
        }
        assert!(!runnable("bogus"));
        assert_eq!(all_ids()[..6], ["pi", "claude", "codex", "opencode", "gemini", "cursor"]);
    }
}
