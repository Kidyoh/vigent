//! ~/.config/vigent/config.toml ($XDG_CONFIG_HOME) and the project's
//! .vigent.toml, read the way src/config.ts reads them: every section into a
//! struct, and every problem a warning (a typo never stops vigent from starting).
//!
//!   theme = "tokyonight"
//!   [ui]            sidebar, sidebar_width, sidebar_position, number, tilde, icons, timeoutlen, termguicolors, transparent, whichkey, notify
//!   [engines.<id>]  args, model, effort, allow, ask  (or command = [...]: an engine of your own)
//!   [keys.<mode>]   mappings      [highlights]  colors over the theme
//!   [worktree]      enabled, dir, branch, base, backend
//!   [templates.<name>]  [hooks]  [statusline]  [winbar]  [commands]  [style]
//!
//! A project's .vigent.toml layers over yours (`LoadOptions::base`); until it's
//! trusted, what runs programs (hooks, engine args and commands, Claude Code
//! permission rules, shell commands) is left out and named in `gated`.
//!
//! EXTENSION POINT (Config area): a new top-level key is a match arm in
//! [`load_str`]; a new [ui] option is a line in [`UI_ALIASES`] and an arm in
//! [`set_option`]. Edits that keep comments (:settings) are line-based, as in
//! src/config-edit.ts; toml.rs only reads.

use std::path::{Path, PathBuf};

use crate::keys::{KeyMode, RhsValue};

pub use crate::toml::Val;

fn rhs(v: &Val) -> RhsValue {
    match v {
        Val::Str(s) => RhsValue::Str(s.clone()),
        Val::Bool(b) => RhsValue::Bool(*b),
        Val::Arr(a) => RhsValue::List(a.iter().map(rhs).collect()),
        _ => RhsValue::Other,
    }
}

/// Parse TOML text into a table. The error is one line.
pub fn parse_toml(text: &str) -> Result<Vec<(String, Val)>, String> {
    crate::toml::parse(text)
}

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------

pub const ICON_SETS: [&str; 3] = ["unicode", "nerd", "ascii"];
pub const NOTIFY_MODES: [&str; 4] = ["auto", "bell", "desktop", "off"];
pub const WORKTREE_BACKENDS: [&str; 3] = ["auto", "riftri", "git"];
pub const HOOK_NAMES: [&str; 3] = ["worktree_created", "before_merge", "agent_finished"];
pub const STATUSLINE_PARTS: [&str; 10] = ["mode", "agent", "branch", "engine", "model", "effort", "usage", "agents", "path", "clock"];
pub const WINBAR_PARTS: [&str; 8] = ["agent", "model", "engine", "effort", "status", "path", "branch", "usage"];
pub const SIDEBAR_STYLES: [&str; 3] = ["tree", "cards", "compact"];
pub const MESSAGE_STYLES: [&str; 3] = ["plain", "labeled", "bubbles"];
pub const TOOL_ICON_STYLES: [&str; 3] = ["none", "unicode", "nerd"];
pub const SEPARATOR_STYLES: [&str; 4] = ["none", "round", "arrow", "slant"];
pub const ICON_NAMES: [&str; 21] = [
    "prompt", "worktree", "folded", "open", "cursor", "bullet", "queued", "open_agent", "here", "unread", "light", "ok", "warn", "off", "sep", "idle", "waiting", "paused", "error", "user", "agent",
];
const CUSTOM_OUTPUTS: [&str; 6] = ["text", "claude", "codex", "opencode", "gemini", "cursor"];

/// The project's own config, at the repository root.
pub const PROJECT_CONFIG: &str = ".vigent.toml";

#[derive(Clone, Debug, PartialEq)]
pub enum Transparent {
    On,
    Off,
    /// what the theme says
    Auto,
}

/// [ui] (also live: :set)
#[derive(Clone, Debug, PartialEq)]
pub struct UiOptions {
    pub sidebar: bool,
    pub sidebar_width: u16,
    /// "left" or "right"
    pub sidebar_position: String,
    pub number: bool,
    pub tilde: bool,
    /// "unicode", "nerd" or "ascii"
    pub icons: String,
    /// ms to wait for the rest of a multi-key mapping
    pub timeoutlen: u64,
    /// 24-bit color; off maps colors to the nearest of 256
    pub termguicolors: bool,
    pub transparent: Transparent,
    /// after <leader>, show what can follow (which-key)
    pub whichkey: bool,
    /// "auto", "bell", "desktop", "off"
    pub notify: String,
}

impl Default for UiOptions {
    fn default() -> Self {
        UiOptions {
            sidebar: true,
            sidebar_width: 30,
            sidebar_position: "left".into(),
            number: true,
            tilde: true,
            icons: "unicode".into(),
            timeoutlen: 1000,
            // macOS Terminal.app can't show 24-bit color
            termguicolors: std::env::var("TERM_PROGRAM").map(|p| p != "Apple_Terminal").unwrap_or(true),
            transparent: Transparent::Auto,
            whichkey: true,
            notify: "auto".into(),
        }
    }
}

/// [engines.<id>] for a built-in engine
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineOptions {
    /// replaces vigent's default extra arguments for that CLI
    pub args: Option<Vec<String>>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Claude Code permission rules every run may use (--allowedTools)
    pub allow: Option<Vec<String>>,
    /// Claude Code: when a tool is refused, ask to allow it and retry
    pub ask: Option<bool>,
}

/// [engines.<id>] with a command: an agent CLI of your own (src/engines.ts CustomEngine)
#[derive(Clone, Debug, PartialEq)]
pub struct CustomEngine {
    pub id: String,
    pub name: String,
    /// the program and its arguments; {prompt} is the prompt, {model} the model
    pub command: Vec<String>,
    /// "text", or the JSON of a CLI vigent knows: "claude", "codex", ...
    pub output: String,
    pub model_args: Option<Vec<String>>,
    pub models: Option<Vec<String>>,
    pub resume_args: Option<Vec<String>>,
}

/// One [highlights] entry: a table, a vim :hi string, or a group to link to.
#[derive(Clone, Debug, PartialEq)]
pub enum HiSpec {
    Attr { fg: Option<String>, bg: Option<String>, link: Option<String>, bold: Option<bool>, italic: Option<bool>, underline: Option<bool>, reverse: Option<bool> },
    /// "guibg=#2a2f3a", "bold", "NONE": parsed like :hi (Config area: src/theme.ts parseHighlightCommand)
    Command(String),
    Link(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeConfig {
    pub enabled: bool,
    /// where worktrees go; relative to the repo root. {repo} = repo folder name
    pub dir: String,
    /// branch name pattern: {type} and {name}
    pub branch: String,
    /// branch to start from; None: the branch checked out
    pub base: Option<String>,
    /// "auto", "riftri", "git"
    pub backend: String,
}

impl Default for WorktreeConfig {
    fn default() -> Self {
        WorktreeConfig { enabled: true, dir: "../{repo}-worktrees".into(), branch: "{type}/{name}".into(), base: None, backend: "auto".into() }
    }
}

/// [templates.<name>]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Template {
    pub name: String,
    pub prompt: String,
    pub description: Option<String>,
    pub engine: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// false: run in your checkout instead of a new worktree
    pub worktree: Option<bool>,
}

/// [hooks]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Hooks {
    pub worktree_created: Option<String>,
    pub before_merge: Option<String>,
    pub agent_finished: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sections {
    pub left: Vec<String>,
    pub right: Vec<String>,
}

/// [statusline] and [winbar]
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub statusline: Sections,
    pub winbar: Sections,
}

impl Default for Layout {
    fn default() -> Self {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect();
        Layout {
            statusline: Sections { left: v(&["mode", "agent", "branch"]), right: v(&["model", "usage", "agents"]) },
            winbar: Sections { left: v(&["agent", "model", "status"]), right: vec![] },
        }
    }
}

/// [style]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct StyleSpec {
    pub sidebar: Option<String>,
    pub messages: Option<String>,
    pub tool_icons: Option<String>,
    pub separators: Option<String>,
    pub user_label: Option<String>,
    pub icons: Vec<(String, String)>,
    pub nerd_icons: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Config {
    pub theme: Option<String>,
    /// model for new pi agents
    pub model: Option<String>,
    /// engine for new agents: a built-in, one from [engines], or "auto"
    pub engine: Option<String>,
    pub engines: Vec<(String, EngineOptions)>,
    pub custom_engines: Vec<CustomEngine>,
    pub leader: Option<String>,
    pub ui: UiOptions,
    pub highlights: Vec<(String, HiSpec)>,
    /// raw mappings, in order; validated when the keymap is built
    pub keys: Vec<(KeyMode, String, RhsValue)>,
    pub worktree: WorktreeConfig,
    pub templates: Vec<Template>,
    pub hooks: Hooks,
    pub layout: Layout,
    /// [commands]: name → steps
    pub commands: Vec<(String, Vec<String>)>,
    pub style: StyleSpec,
}

impl Config {
    pub fn engine_options(&self, id: &str) -> Option<&EngineOptions> {
        self.engines.iter().find(|(k, _)| k == id).map(|(_, o)| o)
    }
    pub fn is_engine_id(&self, id: &str) -> bool {
        crate::engines::KNOWN.iter().any(|s| s.id == id) || self.custom_engines.iter().any(|e| e.id == id)
    }
}

fn upsert<T>(list: &mut Vec<(String, T)>, key: &str, v: T) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = v,
        None => list.push((key.to_string(), v)),
    }
}

pub struct LoadOptions<'a> {
    /// layer this file over an existing config (a project's .vigent.toml over yours)
    pub base: Option<Config>,
    /// false: leave out what runs programs and name it in `gated`
    pub trusted: bool,
    /// how warnings name the file ("config" or ".vigent.toml")
    pub label: &'a str,
}

impl Default for LoadOptions<'_> {
    fn default() -> Self {
        LoadOptions { base: None, trusted: true, label: "config" }
    }
}

pub struct Loaded {
    pub config: Config,
    pub warnings: Vec<String>,
    pub gated: Vec<String>,
}

pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".config"));
    base.join("vigent")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

/// Load a config file (a missing file is the defaults).
pub fn load(file: &Path, opts: LoadOptions) -> Loaded {
    if !file.exists() {
        return Loaded { config: opts.base.unwrap_or_default(), warnings: vec![], gated: vec![] };
    }
    match std::fs::read_to_string(file) {
        Ok(text) => load_str(&text, &file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), opts),
        Err(e) => {
            let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            Loaded { config: opts.base.unwrap_or_default(), warnings: vec![format!("{name}: {e}")], gated: vec![] }
        }
    }
}

/// Whether this project file, with exactly this content, was trusted with :trust / `vigent trust`.
/// (Config area: src/trust.ts: sha256 of the content in $XDG_STATE_HOME/vigent/trusted.json.)
pub fn is_trusted(_file: &Path, _content: &str) -> bool {
    false
}

/// Your config, then the project's .vigent.toml over it (what runs programs waits for trust).
pub fn load_all(root: Option<&Path>) -> Loaded {
    let mut all = load(&config_path(), LoadOptions::default());
    if let Some(file) = root.map(|r| r.join(PROJECT_CONFIG)).filter(|f| f.exists()) {
        let content = std::fs::read_to_string(&file).unwrap_or_default();
        let trusted = is_trusted(&file, &content);
        let project = load_str(&content, PROJECT_CONFIG, LoadOptions { base: Some(all.config), trusted, label: PROJECT_CONFIG });
        all.config = project.config;
        all.warnings.extend(project.warnings);
        if !project.gated.is_empty() {
            all.warnings.push(format!("{PROJECT_CONFIG} wants to run commands ({}): :trust allows them", project.gated.join(", ")));
        }
    }
    all
}

/// Read config text. `file_name` names the file in a parse error.
pub fn load_str(text: &str, file_name: &str, opts: LoadOptions) -> Loaded {
    let mut config = opts.base.unwrap_or_default();
    let mut warnings = vec![];
    let mut gated = vec![];
    let w = opts.label;
    let may_run = opts.trusted;
    let mut raw = match parse_toml(text) {
        Ok(r) => r,
        Err(e) => return Loaded { config, warnings: vec![format!("{file_name}: {e}")], gated },
    };
    // [engines] first: engine = "gemini" and templates may name an engine it defines
    raw.sort_by_key(|(k, _)| k != "engines");
    for (key, value) in &raw {
        match key.as_str() {
            "theme" | "colorscheme" | "model" | "leader" | "mapleader" => match value.as_str() {
                Some(s) => {
                    let s = Some(s.to_string());
                    match key.as_str() {
                        "theme" | "colorscheme" => config.theme = s,
                        "model" => config.model = s,
                        _ => config.leader = s,
                    }
                }
                None => warnings.push(format!("{w}: '{key}' should be a string")),
            },
            "engine" => match value.as_str() {
                Some(s) if s == "auto" || config.is_engine_id(s) => config.engine = Some(s.into()),
                _ => {
                    let ids: Vec<String> = crate::engines::KNOWN.iter().map(|s| format!("\"{}\"", s.id)).collect();
                    warnings.push(format!("{w}: 'engine' should be \"auto\", {} or an engine from [engines]", ids.join(", ")));
                }
            },
            "engines" => parse_engines(value, w, may_run, &mut config, &mut warnings, &mut gated),
            "templates" => parse_templates(value, &mut config, &mut warnings),
            "style" => parse_style(value, w, &mut config.style, &mut warnings),
            "commands" => parse_commands(value, w, may_run, &mut config.commands, &mut warnings, &mut gated),
            "statusline" => parse_sections("statusline", value, &STATUSLINE_PARTS, &mut config.layout.statusline, w, &mut warnings),
            "winbar" => parse_sections("winbar", value, &WINBAR_PARTS, &mut config.layout.winbar, w, &mut warnings),
            "hooks" => {
                let Some(t) = value.as_table() else {
                    warnings.push(format!("{w}: [hooks] should be a table"));
                    continue;
                };
                for (name, cmd) in t {
                    if !HOOK_NAMES.contains(&name.as_str()) {
                        warnings.push(format!("{w} [hooks]: unknown hook '{name}' ({})", HOOK_NAMES.join(", ")));
                    } else if !cmd.as_str().is_some_and(|c| !c.trim().is_empty()) {
                        warnings.push(format!("{w} [hooks]: '{name}' should be a command, e.g. \"npm ci\""));
                    } else if !may_run {
                        gated.push(format!("hooks.{name}"));
                    } else {
                        let c = Some(cmd.as_str().unwrap_or_default().trim().to_string());
                        match name.as_str() {
                            "worktree_created" => config.hooks.worktree_created = c,
                            "before_merge" => config.hooks.before_merge = c,
                            _ => config.hooks.agent_finished = c,
                        }
                    }
                }
            }
            "keys" => {
                let Some(t) = value.as_table() else {
                    warnings.push(format!("{w}: [keys] should be a table"));
                    continue;
                };
                for (k, v) in t {
                    match (KeyMode::from_name(k), v) {
                        (Some(mode), Val::Table(maps)) => config.keys.extend(maps.iter().map(|(lhs, r)| (mode, lhs.clone(), rhs(r)))),
                        (Some(_), _) => warnings.push(format!("{w}: [keys.{k}] should be a table")),
                        // keys directly under [keys] are normal-mode mappings
                        (None, _) => config.keys.push((KeyMode::Normal, k.clone(), rhs(v))),
                    }
                }
            }
            "ui" => {
                if let Some(t) = value.as_table() {
                    for (opt, v) in t {
                        if let Err(msg) = set_option(&mut config.ui, opt, v) {
                            warnings.push(format!("{w} [ui]: {msg}"));
                        }
                    }
                }
            }
            "highlights" => {
                if let Some(t) = value.as_table() {
                    for (group, v) in t {
                        if let Some(h) = hi_spec(v) {
                            upsert(&mut config.highlights, group, h);
                        }
                    }
                }
            }
            "worktree" => {
                let Some(t) = value.as_table() else {
                    warnings.push(format!("{w}: [worktree] should be a table"));
                    continue;
                };
                for (opt, v) in t {
                    if let Err(msg) = set_worktree_option(&mut config.worktree, opt, v) {
                        warnings.push(format!("{w} [worktree]: {msg}"));
                    }
                }
            }
            _ => warnings.push(format!("{w}: unknown key '{key}'")),
        }
    }
    Loaded { config, warnings, gated }
}

fn parse_engines(value: &Val, w: &str, may_run: bool, config: &mut Config, warnings: &mut Vec<String>, gated: &mut Vec<String>) {
    let Some(t) = value.as_table() else {
        warnings.push(format!("{w}: [engines] should be a table"));
        return;
    };
    for (id, opts) in t {
        // a table with a command defines an engine of your own (with a built-in's name, it replaces that one)
        if opts.get("command").is_some() {
            if !may_run {
                gated.push(format!("engines.{id}.command"));
                continue;
            }
            if let Some(e) = parse_custom_engine(id, opts, &format!("{w} [engines.{id}]"), warnings) {
                config.custom_engines.retain(|c| c.id != e.id);
                config.custom_engines.push(e);
            }
            continue;
        }
        if !config.is_engine_id(id) {
            let ids: Vec<&str> = crate::engines::KNOWN.iter().map(|s| s.id).collect();
            warnings.push(format!("{w}: unknown engine [engines.{id}] ({}, or give it a command = [...] to add your own)", ids.join(", ")));
            continue;
        }
        if config.custom_engines.iter().any(|c| c.id == *id) {
            continue; // defined above
        }
        let Some(table) = opts.as_table() else {
            warnings.push(format!("{w}: [engines.{id}] should be a table"));
            continue;
        };
        let mut e = config.engine_options(id).cloned().unwrap_or_default();
        let efforts = crate::engines::efforts(id);
        let at = format!("{w} [engines.{id}]");
        for (k, v) in table {
            let k = k.as_str();
            if (k == "args" || k == "allow") && !may_run {
                gated.push(format!("engines.{id}.{k}"));
                continue;
            }
            match (k, v) {
                ("args", _) if v.strings().is_some() => e.args = v.strings(),
                ("model", Val::Str(s)) => e.model = Some(s.clone()),
                ("effort", Val::Str(s)) if efforts.contains(&s.as_str()) => e.effort = Some(s.clone()),
                ("allow" | "ask", _) if id != "claude" => warnings.push(format!("{at}: '{k}' is for [engines.claude] (Claude Code's permission rules)")),
                ("allow", _) if v.strings().is_some() => e.allow = v.strings(),
                ("ask", Val::Bool(b)) => e.ask = Some(*b),
                ("allow", _) => warnings.push(format!("{at}: 'allow' should be a list of permission rules, e.g. [\"Bash(gh:*)\"]")),
                ("ask", _) => warnings.push(format!("{at}: 'ask' should be true or false")),
                ("effort", _) => warnings.push(format!("{at}: 'effort' should be one of {}", efforts.join(", "))),
                ("args", _) => warnings.push(format!("{at}: 'args' should be a list of strings")),
                ("model", _) => warnings.push(format!("{at}: 'model' should be a string")),
                _ => warnings.push(format!("{at}: unknown option '{k}'")),
            }
        }
        upsert(&mut config.engines, id, e);
    }
}

fn parse_custom_engine(id: &str, raw: &Val, at: &str, warnings: &mut Vec<String>) -> Option<CustomEngine> {
    let ok_id = id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok_id {
        warnings.push(format!("{at}: an engine name is letters, digits, - and _"));
        return None;
    }
    let Some(command) = raw.get("command").and_then(Val::some_strings) else {
        warnings.push(format!("{at}: 'command' should be the program and its arguments, e.g. [\"gemini\", \"-p\", \"{{prompt}}\"]"));
        return None;
    };
    let mut e = CustomEngine { id: id.into(), name: id.into(), command, output: "text".into(), model_args: None, models: None, resume_args: None };
    for (k, v) in raw.as_table().unwrap_or_default() {
        match (k.as_str(), v) {
            ("command", _) => {}
            ("name", Val::Str(s)) if !s.trim().is_empty() => e.name = s.trim().into(),
            ("output", Val::Str(s)) if CUSTOM_OUTPUTS.contains(&s.as_str()) => e.output = s.clone(),
            ("model_args", _) if v.some_strings().is_some() => e.model_args = v.some_strings(),
            ("models", _) if v.some_strings().is_some() => e.models = v.some_strings(),
            ("resume_args", _) if v.some_strings().is_some() => e.resume_args = v.some_strings(),
            ("output", _) => warnings.push(format!("{at}: 'output' should be {}", CUSTOM_OUTPUTS.map(|o| format!("\"{o}\"")).join(", "))),
            ("name", _) => warnings.push(format!("{at}: 'name' should be a string")),
            ("model_args" | "models" | "resume_args", _) => warnings.push(format!("{at}: '{k}' should be a list of strings")),
            _ => warnings.push(format!("{at}: unknown option '{k}' (name, command, output, model_args, models, resume_args)")),
        }
    }
    Some(e)
}

fn parse_templates(value: &Val, config: &mut Config, warnings: &mut Vec<String>) {
    let Some(t) = value.as_table() else {
        warnings.push("config: [templates] should be a table".into());
        return;
    };
    let mut out = config.templates.clone();
    for (name, raw) in t {
        let at = format!("config [templates.{name}]");
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
            warnings.push(format!("{at}: a template name is letters, digits, - and _"));
            continue;
        }
        let Some(table) = raw.as_table() else {
            warnings.push(format!("{at} should be a table"));
            continue;
        };
        let Some(prompt) = raw.get("prompt").and_then(Val::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
            warnings.push(format!("{at}: 'prompt' is required"));
            continue;
        };
        let mut tpl = Template { name: name.clone(), prompt: prompt.into(), ..Default::default() };
        for (k, v) in table {
            match (k.as_str(), v) {
                ("prompt", _) => {}
                ("description", Val::Str(s)) => tpl.description = Some(s.clone()),
                ("model", Val::Str(s)) => tpl.model = Some(s.clone()),
                ("description" | "model" | "effort", _) if v.as_str().is_none() => warnings.push(format!("{at}: '{k}' should be a string")),
                ("engine", Val::Str(s)) if config.is_engine_id(s) => tpl.engine = Some(s.clone()),
                ("engine", _) => {
                    let ids: Vec<String> = crate::engines::KNOWN.iter().map(|s| format!("\"{}\"", s.id)).collect();
                    warnings.push(format!("{at}: 'engine' should be {} or an engine from [engines]", ids.join(", ")));
                }
                ("worktree", Val::Bool(b)) => tpl.worktree = Some(*b),
                ("worktree", _) => warnings.push(format!("{at}: 'worktree' should be true or false")),
                ("effort", Val::Str(s)) => tpl.effort = Some(s.clone()),
                _ => warnings.push(format!("{at}: unknown option '{k}'")),
            }
        }
        if let (Some(effort), Some(engine)) = (&tpl.effort, &tpl.engine) {
            let efforts = crate::engines::efforts(engine);
            if !efforts.contains(&effort.as_str()) {
                let list = if efforts.is_empty() { "none for this engine".to_string() } else { efforts.join(", ") };
                warnings.push(format!("{at}: 'effort' should be one of {list}"));
                tpl.effort = None;
            }
        }
        out.retain(|o| o.name != tpl.name);
        out.push(tpl);
    }
    // a later file's templates replace earlier ones of the same name
    config.templates = out;
}

fn parse_style(value: &Val, w: &str, style: &mut StyleSpec, warnings: &mut Vec<String>) {
    let Some(t) = value.as_table() else {
        warnings.push(format!("{w}: [style] should be a table, e.g. sidebar = \"cards\""));
        return;
    };
    fn one_of(w: &str, k: &str, v: &Val, allowed: &[&str], slot: &mut Option<String>, warnings: &mut Vec<String>) {
        match v.as_str() {
            Some(s) if allowed.contains(&s) => *slot = Some(s.into()),
            _ => warnings.push(format!("{w} [style]: '{k}' should be {}", allowed.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(", "))),
        }
    }
    let mut icon_tables = vec![];
    for (k, v) in t {
        match k.as_str() {
            "sidebar" => one_of(w, k, v, &SIDEBAR_STYLES, &mut style.sidebar, warnings),
            "messages" => one_of(w, k, v, &MESSAGE_STYLES, &mut style.messages, warnings),
            "tool_icons" => one_of(w, k, v, &TOOL_ICON_STYLES, &mut style.tool_icons, warnings),
            "separators" => one_of(w, k, v, &SEPARATOR_STYLES, &mut style.separators, warnings),
            "user_label" => match v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                Some(s) => style.user_label = Some(s.into()),
                None => warnings.push(format!("{w} [style]: 'user_label' should be a string")),
            },
            "icons" | "nerd_icons" => icon_tables.push((k.clone(), v.clone())),
            _ => warnings.push(format!("{w} [style]: unknown option '{k}' (sidebar, messages, tool_icons, separators, user_label, icons, nerd_icons)")),
        }
    }
    for (k, v) in icon_tables {
        let Some(table) = v.as_table() else {
            warnings.push(format!("{w} [style]: '{k}' should be a table, e.g. prompt = \"λ \""));
            continue;
        };
        for (name, glyph) in table {
            if !ICON_NAMES.contains(&name.as_str()) {
                warnings.push(format!("{w} [style.{k}]: unknown icon '{name}' ({})", ICON_NAMES.join(", ")));
            } else if let Some(g) = glyph.as_str() {
                let list = if k == "icons" { &mut style.icons } else { &mut style.nerd_icons };
                upsert(list, name, g.to_string());
            } else {
                warnings.push(format!("{w} [style.{k}]: '{name}' should be a string"));
            }
        }
    }
}

fn parse_commands(value: &Val, w: &str, may_run: bool, out: &mut Vec<(String, Vec<String>)>, warnings: &mut Vec<String>, gated: &mut Vec<String>) {
    let Some(t) = value.as_table() else {
        warnings.push(format!("{w}: [commands] should be a table, e.g. Test = \"!npm test\""));
        return;
    };
    let normalize = |s: &str| s.trim().trim_start_matches(':').trim_start().to_string();
    for (name, v) in t {
        let ok_name = name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && name.chars().all(|c| c.is_ascii_alphanumeric());
        if !ok_name {
            warnings.push(format!("{w} [commands]: '{name}' should start with a capital letter (letters and digits), like vim's :command"));
            continue;
        }
        let steps = match v {
            Val::Str(s) => Some(vec![s.clone()]),
            _ => v.some_strings(),
        };
        let Some(steps) = steps.filter(|s| s.iter().all(|x| !normalize(x).is_empty())) else {
            warnings.push(format!("{w} [commands]: '{name}' should be an ex command (\"new -t review {{args}}\"), a shell command (\"!npm test\") or a list of them"));
            continue;
        };
        if !may_run && steps.iter().any(|s| normalize(s).starts_with('!')) {
            gated.push(format!("commands.{name}"));
            continue;
        }
        upsert(out, name, steps.iter().map(|s| normalize(s)).collect());
    }
}

fn parse_sections(table: &str, value: &Val, parts: &[&str], into: &mut Sections, w: &str, warnings: &mut Vec<String>) {
    let Some(t) = value.as_table() else {
        warnings.push(format!("{w}: [{table}] should be a table with left = [...] and right = [...]"));
        return;
    };
    for (side, list) in t {
        if side != "left" && side != "right" {
            warnings.push(format!("{w} [{table}]: unknown option '{side}' (left, right)"));
            continue;
        }
        let Some(list) = list.strings() else {
            warnings.push(format!("{w} [{table}]: '{side}' should be a list, e.g. [\"{}\", \"{}\"]", parts[0], parts[1]));
            continue;
        };
        let mut ok = vec![];
        for p in list {
            if parts.contains(&p.as_str()) {
                ok.push(p);
            } else {
                warnings.push(format!("{w} [{table}]: unknown part '{p}' ({})", parts.join(", ")));
            }
        }
        if side == "left" {
            into.left = ok;
        } else {
            into.right = ok;
        }
    }
}

fn hi_spec(v: &Val) -> Option<HiSpec> {
    match v {
        Val::Str(s) => {
            let lower = s.to_lowercase();
            let attr_word = ["bold", "italic", "underline", "reverse", "none"].iter().any(|a| lower.starts_with(a) && lower[a.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_'));
            Some(if s.contains('=') || attr_word { HiSpec::Command(s.clone()) } else { HiSpec::Link(s.clone()) })
        }
        Val::Table(_) => {
            let s = |k: &str| v.get(k).and_then(Val::as_str).map(str::to_string);
            let b = |k: &str| if let Some(Val::Bool(b)) = v.get(k) { Some(*b) } else { None };
            Some(HiSpec::Attr { fg: s("fg"), bg: s("bg"), link: s("link"), bold: b("bold"), italic: b("italic"), underline: b("underline"), reverse: b("reverse") })
        }
        _ => None,
    }
}

fn set_worktree_option(wt: &mut WorktreeConfig, name: &str, v: &Val) -> Result<(), String> {
    match name {
        "enabled" => match v {
            Val::Bool(b) => wt.enabled = *b,
            _ => return Err("'enabled' should be true or false".into()),
        },
        "dir" | "base" => {
            let Some(s) = v.as_str() else { return Err(format!("'{name}' should be a string")) };
            if name == "dir" && s.trim().is_empty() {
                return Err("'dir' can't be empty".into());
            }
            if name == "dir" {
                wt.dir = s.into();
            } else {
                wt.base = Some(s.into());
            }
        }
        "backend" => match v.as_str() {
            Some(s) if WORKTREE_BACKENDS.contains(&s) => wt.backend = s.into(),
            _ => return Err("'backend' should be \"auto\", \"riftri\" or \"git\"".into()),
        },
        "branch" => {
            let Some(s) = v.as_str() else { return Err("'branch' should be a string".into()) };
            if !s.contains("{name}") {
                return Err("'branch' should contain {name}, e.g. \"{type}/{name}\" or \"agent/{name}\"".into());
            }
            wt.branch = s.into();
        }
        _ => return Err(format!("unknown option '{name}'")),
    }
    Ok(())
}

/// [ui] option names and their short forms (as :set takes them).
pub const UI_ALIASES: &[(&str, &str)] = &[
    ("sidebar", "sidebar"),
    ("sb", "sidebar"),
    ("sidebar_width", "sidebar_width"),
    ("sidebarwidth", "sidebar_width"),
    ("sbw", "sidebar_width"),
    ("sidebar_position", "sidebar_position"),
    ("sbp", "sidebar_position"),
    ("number", "number"),
    ("nu", "number"),
    ("tilde", "tilde"),
    ("icons", "icons"),
    ("timeoutlen", "timeoutlen"),
    ("tm", "timeoutlen"),
    ("termguicolors", "termguicolors"),
    ("tgc", "termguicolors"),
    ("transparent", "transparent"),
    ("transp", "transparent"),
    ("whichkey", "whichkey"),
    ("wk", "whichkey"),
    ("notify", "notify"),
];

pub fn ui_option(name: &str) -> Option<&'static str> {
    UI_ALIASES.iter().find(|(a, _)| *a == name).map(|(_, k)| *k)
}

/// Set one [ui] option from a config value (:set gives strings: "40", "true").
pub fn set_option(ui: &mut UiOptions, name: &str, v: &Val) -> Result<(), String> {
    let Some(key) = ui_option(name) else { return Err(format!("unknown option '{name}'")) };
    let num = || match v {
        Val::Int(i) => Some(*i),
        Val::Str(s) => s.trim().parse::<i64>().ok(),
        Val::Float(f) if f.fract() == 0.0 => Some(*f as i64),
        _ => None,
    };
    match key {
        "sidebar" | "number" | "tilde" | "termguicolors" | "whichkey" => {
            let Val::Bool(b) = v else { return Err(format!("'{name}' should be true or false")) };
            match key {
                "sidebar" => ui.sidebar = *b,
                "number" => ui.number = *b,
                "tilde" => ui.tilde = *b,
                "termguicolors" => ui.termguicolors = *b,
                _ => ui.whichkey = *b,
            }
        }
        "sidebar_width" => match num() {
            Some(n) if (16..=80).contains(&n) => ui.sidebar_width = n as u16,
            _ => return Err(format!("'{name}' should be a number from 16 to 80")),
        },
        "sidebar_position" => match v.as_str() {
            Some(s @ ("left" | "right")) => ui.sidebar_position = s.into(),
            _ => return Err(format!("'{name}' should be \"left\" or \"right\"")),
        },
        "notify" => match v.as_str() {
            Some(s) if NOTIFY_MODES.contains(&s) => ui.notify = s.into(),
            _ => return Err(format!("'{name}' should be \"auto\", \"bell\", \"desktop\" or \"off\"")),
        },
        "icons" => match v.as_str() {
            Some(s) if ICON_SETS.contains(&s) => ui.icons = s.into(),
            _ => return Err(format!("'{name}' should be \"unicode\", \"nerd\" or \"ascii\"")),
        },
        "transparent" => match v {
            Val::Bool(true) => ui.transparent = Transparent::On,
            Val::Bool(false) => ui.transparent = Transparent::Off,
            Val::Str(s) if s == "auto" => ui.transparent = Transparent::Auto,
            Val::Str(s) if s == "true" => ui.transparent = Transparent::On,
            Val::Str(s) if s == "false" => ui.transparent = Transparent::Off,
            _ => return Err(format!("'{name}' should be true, false or \"auto\" (follow the theme)")),
        },
        "timeoutlen" => match num() {
            Some(n) if (0..=10000).contains(&n) => ui.timeoutlen = n as u64,
            _ => return Err(format!("'{name}' should be milliseconds from 0 to 10000")),
        },
        _ => unreachable!("every alias has an arm"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(text: &str) -> Loaded {
        load_str(text, "config.toml", LoadOptions::default())
    }

    #[test]
    fn every_section_and_its_warnings() {
        let l = load(
            r##"
theme = "nord"
leader = ","
engine = "mine"
bogus = 1

[ui]
sidebar_width = 40
number = false
transparent = "auto"
nope = true

[engines.claude]
model = "sonnet"
effort = "high"
allow = ["Bash(gh:*)"]
[engines.codex]
ask = true
[engines.mine]
command = ["mine", "-p", "{prompt}"]
output = "claude"

[keys]
J = "scroll.half_down"
[keys.insert]
jk = "<Esc>"

[highlights]
Normal = { bg = "NONE" }
CursorLine = "guibg=#2a2f3a"
VigentSidebar = "NormalFloat"

[worktree]
branch = "agent/{name}"
backend = "zfs"

[templates.migrate]
prompt = "Write a migration that {task}."
engine = "claude"
effort = "turbo"

[hooks]
worktree_created = "npm ci"
nope = "x"

[statusline]
left = ["mode", "agent", "weather"]

[commands]
Test = "!npm test"
lower = "x"

[style]
sidebar = "cards"
[style.icons]
worktree = "⑂ "
"##,
        );
        let c = &l.config;
        assert_eq!(c.theme.as_deref(), Some("nord"));
        assert_eq!(c.engine.as_deref(), Some("mine"), "engine = can name an engine [engines] defines further down");
        assert_eq!(c.ui.sidebar_width, 40);
        assert!(!c.ui.number);
        assert_eq!(c.engine_options("claude").unwrap().allow.as_deref(), Some(&["Bash(gh:*)".to_string()][..]));
        assert_eq!(c.custom_engines[0].output, "claude");
        assert_eq!(c.keys.len(), 2);
        assert_eq!(c.highlights.len(), 3);
        assert!(matches!(c.highlights[2].1, HiSpec::Link(ref g) if g == "NormalFloat"));
        assert_eq!(c.worktree.branch, "agent/{name}");
        assert_eq!(c.templates[0].effort, None);
        assert_eq!(c.hooks.worktree_created.as_deref(), Some("npm ci"));
        assert_eq!(c.layout.statusline.left, ["mode", "agent"]);
        assert_eq!(c.commands, [("Test".to_string(), vec!["!npm test".to_string()])]);
        assert_eq!(c.style.sidebar.as_deref(), Some("cards"));
        let w = l.warnings.join("\n");
        for expected in [
            "config: unknown key 'bogus'",
            "config [ui]: unknown option 'nope'",
            "config [engines.codex]: 'ask' is for [engines.claude]",
            "config [worktree]: 'backend' should be",
            "config [templates.migrate]: 'effort' should be one of low, medium, high, xhigh, max",
            "config [hooks]: unknown hook 'nope'",
            "config [statusline]: unknown part 'weather'",
            "config [commands]: 'lower' should start with a capital letter",
        ] {
            assert!(w.contains(expected), "missing {expected:?} in\n{w}");
        }
        assert_eq!(l.warnings.len(), 8, "{w}");
    }

    #[test]
    fn an_untrusted_project_file_runs_nothing() {
        let base = load("theme = \"nord\"\n").config;
        let l = load_str("[hooks]\nbefore_merge = \"npm test\"\n[engines.claude]\nargs = [\"-x\"]\nmodel = \"opus\"\n[commands]\nT = \"!make\"\nR = \"new -t review\"\n", PROJECT_CONFIG, LoadOptions { base: Some(base), trusted: false, label: PROJECT_CONFIG });
        assert_eq!(l.gated, ["engines.claude.args", "hooks.before_merge", "commands.T"], "[engines] is read first");
        assert_eq!(l.config.theme.as_deref(), Some("nord"), "layered over yours");
        assert_eq!(l.config.engine_options("claude").unwrap().model.as_deref(), Some("opus"));
        assert_eq!(l.config.commands.len(), 1);
    }

    #[test]
    fn a_broken_file_is_one_warning() {
        let l = load("theme = \n");
        assert_eq!(l.warnings.len(), 1);
        assert!(l.warnings[0].starts_with("config.toml: "));
    }
}
