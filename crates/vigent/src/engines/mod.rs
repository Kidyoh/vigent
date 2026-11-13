//! What runs agents: the coding-agent CLIs you have installed, each with its
//! own login (vigent never reads credentials). The same shape as
//! src/cli-engines.ts (CliAdapter) and src/engines.ts (EngineInfo, detection).
//!
//! EXTENSION POINT (Engines area): an engine is one file here with a type that
//! implements [`Adapter`], plus one line in [`ADAPTERS`]. Everything that lists
//! engines (the sidebar, the start screen, :checkhealth, :engine) reads
//! [`KNOWN`] and the registry, so nothing else needs editing to add one.

pub mod claude;
pub mod run;

use serde_json::Value;

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

/// A fresh parser for one run (parsers may keep a little state between lines).
pub type Parser = Box<dyn FnMut(&Value) -> Vec<Ev> + Send>;

/// A pick in :model / :effort.
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

/// One agent CLI. Implement this in engines/<id>.rs and add it to [`ADAPTERS`].
pub trait Adapter: Sync {
    /// "claude", "codex", ...: what config.toml, --engine and :engine call it
    fn id(&self) -> &'static str;
    /// default extra arguments, replaced by [engines.<id>] args
    fn default_args(&self) -> &'static [&'static str];
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
    /// what :model offers (blocking is fine: called off the UI thread)
    fn models(&self) -> Vec<Choice> {
        vec![]
    }
    /// the reasoning efforts it takes (src/choices.ts EFFORTS)
    fn efforts(&self) -> &'static [&'static str] {
        efforts(self.id())
    }
    /// installed? signed in? Blocking (runs the CLI's version and status commands): call it off the UI thread.
    fn detect(&self) -> EngineInfo {
        let spec = spec(self.id());
        EngineInfo::from_path(spec)
    }
}

/// EXTENSION POINT: every engine this build can run. One line per engine.
pub static ADAPTERS: &[&dyn Adapter] = &[&claude::Claude];

/// The adapter for an engine id, if this build runs it.
pub fn adapter(id: &str) -> Option<&'static dyn Adapter> {
    ADAPTERS.iter().copied().find(|a| a.id() == id)
}

/// An engine vigent knows by name, ported or not (src/engines.ts ENGINE_IDS, ENGINE_NAMES, ENGINE_BINS, INSTALL).
#[derive(Debug)]
pub struct Spec {
    pub id: &'static str,
    pub name: &'static str,
    pub bin: &'static str,
    pub install: &'static str,
}

/// The built-in engines, in the order vigent lists them.
pub static KNOWN: [Spec; 6] = [
    Spec { id: "pi", name: "pi", bin: "pi", install: "npm install -g @mariozechner/pi-coding-agent" },
    Spec { id: "claude", name: "Claude Code", bin: "claude", install: "npm install -g @anthropic-ai/claude-code" },
    Spec { id: "codex", name: "Codex", bin: "codex", install: "npm install -g @openai/codex" },
    Spec { id: "opencode", name: "OpenCode", bin: "opencode", install: "npm install -g opencode-ai" },
    Spec { id: "gemini", name: "Gemini CLI", bin: "gemini", install: "npm install -g @google/gemini-cli" },
    Spec { id: "cursor", name: "Cursor CLI", bin: "cursor-agent", install: "curl https://cursor.com/install -fsS | bash" },
];

/// A built-in engine's spec (Claude Code's for an id that isn't built in: check `KNOWN` first).
pub fn spec(id: &str) -> &'static Spec {
    KNOWN.iter().find(|s| s.id == id).unwrap_or(&KNOWN[1])
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

/// What vigent calls an engine: "Claude Code" (a custom engine's own id until the Engines area registers its name).
pub fn engine_name(id: &str) -> String {
    KNOWN.iter().find(|s| s.id == id).map(|s| s.name.to_string()).unwrap_or_else(|| id.to_string())
}

/// An engine on this machine (src/engines.ts EngineInfo).
#[derive(Debug, Clone, Default)]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// signed in / has credentials it can use
    pub connected: bool,
    pub version: Option<String>,
    /// one line: how it's signed in, or why it isn't
    pub detail: String,
    /// the command to run to sign in
    pub connect: Option<String>,
    pub install: String,
    /// the real check hasn't come back yet
    pub checking: bool,
    /// environment variables left out when it runs, so the CLI uses its own login
    pub drop_env: Vec<String>,
}

impl EngineInfo {
    /// What's known without running anything: whether its binary is on PATH.
    pub fn from_path(s: &Spec) -> EngineInfo {
        EngineInfo {
            id: s.id.into(),
            name: s.name.into(),
            installed: on_path(s.bin),
            install: s.install.into(),
            ..Default::default()
        }
    }
    /// this build can run it
    pub fn ported(&self) -> bool {
        adapter(&self.id).is_some()
    }
    /// it can start agents now
    pub fn ready(&self) -> bool {
        self.ported() && self.installed && self.connected && !self.checking
    }
}

/// Every known engine before detection: installed or not, still checking the ported ones.
pub fn quick() -> Vec<EngineInfo> {
    KNOWN
        .iter()
        .map(|s| EngineInfo { checking: adapter(s.id).is_some(), ..EngineInfo::from_path(s) })
        .collect()
}

/// Every known engine, checked (blocking: run it off the UI thread).
pub fn detect_all() -> Vec<EngineInfo> {
    KNOWN
        .iter()
        .map(|s| match adapter(s.id) {
            Some(a) => a.detect(),
            None => EngineInfo::from_path(s),
        })
        .collect()
}

/// The engine new agents use: the first ready one (config's `engine` is the Engines area's to add).
pub fn default_engine(infos: &[EngineInfo]) -> Option<&EngineInfo> {
    infos.iter().find(|e| e.ready()).or_else(|| infos.iter().find(|e| e.id == "claude"))
}

/// Whether `bin` is on PATH.
pub fn on_path(bin: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|d| {
        let f = d.join(bin);
        f.is_file() || (cfg!(windows) && d.join(format!("{bin}.exe")).is_file())
    })
}

/// Engine-wide state on the App (Engines area: add fields here, not to App).
#[derive(Default)]
pub struct Engines {
    /// every known engine; `checking` until detection comes back
    pub infos: Vec<EngineInfo>,
}

impl Engines {
    pub fn get(&self, id: &str) -> Option<&EngineInfo> {
        self.infos.iter().find(|e| e.id == id)
    }
    pub fn ready_count(&self) -> usize {
        self.infos.iter().filter(|e| e.ready()).count()
    }
}
