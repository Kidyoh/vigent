//! `:permissions`: what each agent may do without asking, toggled in place
//! (src/permissions.ts, and App.execPermissions / openPermissions /
//! savePermissions in src/app.ts).
//!
//! Every engine keeps its permissions in its own arguments ([engines.<id>]
//! args) and, for Claude Code, its allow rules and ask. These helpers read and
//! change just the permission part of those arguments, keeping anything else
//! you put there. Each change starts from what's saved now and is saved at
//! once, so two vigents open at once never undo each other's changes.

use std::path::Path;

use crate::app::App;
use crate::config::{self, EngineOptions, LoadOptions, PROJECT_CONFIG};
use crate::settings::{Item, Panel};

/// Claude Code's --permission-mode values.
pub const CLAUDE_MODES: [&str; 4] = ["acceptEdits", "default", "plan", "bypassPermissions"];
/// Codex's sandbox_mode values.
pub const CODEX_SANDBOXES: [&str; 3] = ["read-only", "workspace-write", "danger-full-access"];
/// Gemini CLI's --approval-mode values.
pub const GEMINI_APPROVALS: [&str; 3] = ["default", "auto_edit", "yolo"];

/// Allow rules worth a single key in the panel: (rule, label).
pub const CLAUDE_PRESETS: [(&str, &str); 5] = [("Bash(gh:*)", "GitHub CLI (gh)"), ("Bash(git:*)", "git, any subcommand"), ("Bash(npm:*)", "npm"), ("WebFetch", "fetch web pages"), ("WebSearch", "web search")];

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// The value after `flag` (`--permission-mode plan`), or None.
pub fn flag_value(args: &[String], flag: &str) -> Option<String> {
    if let Some(i) = args.iter().position(|a| a == flag)
        && i + 1 < args.len()
    {
        return Some(args[i + 1].clone());
    }
    let eq = format!("{flag}=");
    args.iter().find_map(|a| a.strip_prefix(&eq).map(str::to_string))
}

/// Set `flag value` (or remove the flag when value is None), keeping every other argument.
pub fn with_flag(args: &[String], flag: &str, value: Option<&str>) -> Vec<String> {
    let eq = format!("{flag}=");
    let mut out = vec![];
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            i += 2;
            continue;
        }
        if !args[i].starts_with(&eq) {
            out.push(args[i].clone());
        }
        i += 1;
    }
    if let Some(v) = value {
        out.push(flag.into());
        out.push(v.into());
    }
    out
}

/// A bare switch (`--force`) on or off.
pub fn with_switch(args: &[String], flag: &str, on: bool) -> Vec<String> {
    let mut rest: Vec<String> = args.iter().filter(|a| *a != flag).cloned().collect();
    if on {
        rest.push(flag.into());
    }
    rest
}

fn codex_key(arg: &str) -> Option<&str> {
    let (k, _) = arg.split_once('=')?;
    if k.is_empty() { None } else { Some(k.trim()) }
}

/// Codex's `-c key=value` overrides: the value for `key`, without TOML quotes.
pub fn codex_option(args: &[String], key: &str) -> Option<String> {
    for i in 0..args.len().saturating_sub(1) {
        if args[i] != "-c" && args[i] != "--config" {
            continue;
        }
        if let Some((k, v)) = args[i + 1].split_once('=')
            && !k.is_empty()
            && k.trim() == key
        {
            let v = v.trim();
            let v = if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') { &v[1..v.len() - 1] } else { v };
            return Some(v.to_string());
        }
    }
    None
}

/// A value for [`with_codex_option`]: strings are written TOML-quoted, like Codex expects.
pub enum CodexValue<'a> {
    Str(&'a str),
    Bool(bool),
}

/// Set (or remove) one `-c key=value`.
pub fn with_codex_option(args: &[String], key: &str, value: Option<CodexValue>) -> Vec<String> {
    let mut out = vec![];
    let mut i = 0;
    while i < args.len() {
        if (args[i] == "-c" || args[i] == "--config") && i + 1 < args.len() && codex_key(&args[i + 1]) == Some(key) {
            i += 2;
            continue;
        }
        out.push(args[i].clone());
        i += 1;
    }
    match value {
        None => out,
        Some(v) => {
            out.push("-c".into());
            out.push(match v {
                CodexValue::Bool(b) => format!("{key}={b}"),
                CodexValue::Str(s) => format!("{key}={}", serde_json::to_string(s).unwrap_or_default()),
            });
            out
        }
    }
}

/// An engine's own default arguments (src/cli-engines.ts CLI_ADAPTERS defaultArgs).
pub fn default_args(id: &str) -> Vec<String> {
    if let Some(a) = crate::engines::adapter(id) {
        return s(a.default_args());
    }
    match id {
        "claude" => s(&["--permission-mode", "acceptEdits"]),
        "codex" => s(&["-c", "sandbox_mode=\"workspace-write\""]),
        "gemini" => s(&["--approval-mode", "auto_edit"]),
        "cursor" => s(&["--force"]),
        _ => vec![],
    }
}

/// The arguments an engine runs with: yours from [engines.<id>] args, else its defaults.
pub fn engine_args(app: &App, id: &str) -> Vec<String> {
    app.config.engine_options(id).and_then(|o| o.args.clone()).unwrap_or_else(|| default_args(id))
}

fn options_mut<'a>(app: &'a mut App, id: &str) -> &'a mut EngineOptions {
    if app.config.engine_options(id).is_none() {
        app.config.engines.push((id.to_string(), EngineOptions::default()));
    }
    &mut app.config.engines.iter_mut().find(|(k, _)| k == id).expect("just added").1
}

/// Permissions as they're saved now, read the way startup reads them. Another vigent may have
/// changed them since this one started, and saving this one's old copy would undo that.
pub fn reload(app: &mut App) {
    let mut saved = config::load(&config::config_path(), LoadOptions::default()).config;
    if let Some(file) = crate::trust::project_file(app.root.as_deref()).filter(|f| f.exists()) {
        let content = std::fs::read_to_string(&file).unwrap_or_default();
        let trusted = crate::trust::is_trusted(&file, &content);
        saved = config::load_str(&content, PROJECT_CONFIG, LoadOptions { base: Some(saved), trusted, label: PROJECT_CONFIG }).config;
    }
    let mut ids: Vec<String> = app.config.engines.iter().map(|(k, _)| k.clone()).collect();
    for (k, _) in &saved.engines {
        if !ids.contains(k) {
            ids.push(k.clone());
        }
    }
    for id in ids {
        let from = saved.engine_options(&id).cloned().unwrap_or_default();
        let now = options_mut(app, &id);
        now.args = from.args;
        now.allow = from.allow;
        now.ask = from.ask;
    }
}

/// Change one engine's permission and save it at once.
fn set(app: &mut App, id: &str, f: impl FnOnce(&mut EngineOptions)) {
    f(options_mut(app, id));
    if !app.cfg.permissions_changed.iter().any(|x| x == id) {
        app.cfg.permissions_changed.push(id.to_string());
    }
    let saved = save(app);
    if saved.starts_with("couldn't") {
        app.say(format!("{saved} (it applies until vigent quits)"), "WarningMsg");
    }
}

/// The saved config text, or the commented template for a first config.toml.
pub fn config_text(file: &Path) -> String {
    if file.exists() { std::fs::read_to_string(file).unwrap_or_default() } else { config::CONFIG_TEMPLATE.to_string() }
}

/// Write what :permissions changed into config.toml ([engines.<id>] args, allow, ask), keeping the rest of the file.
pub fn save(app: &mut App) -> String {
    let file = config::config_path();
    let mut text = config_text(&file);
    let json = |v: &[String]| serde_json::to_string(v).unwrap_or_default();
    for id in &app.cfg.permissions_changed {
        let o = app.config.engine_options(id).cloned().unwrap_or_default();
        let section = format!("engines.{id}");
        if let Some(args) = &o.args {
            text = crate::config_edit::set_toml_value(&text, Some(&section), "args", &json(args));
        }
        if id == "claude" {
            text = crate::config_edit::set_toml_value(&text, Some(&section), "allow", &json(o.allow.as_deref().unwrap_or_default()));
            text = crate::config_edit::set_toml_value(&text, Some(&section), "ask", if o.ask == Some(true) { "true" } else { "false" });
        }
    }
    let r = file.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::write(&file, text));
    match r {
        Ok(()) => {
            app.cfg.permissions_changed.clear();
            format!("saved to {}", crate::settings::short_path(&file))
        }
        Err(e) => format!("couldn't save: {e}"),
    }
}

/// Several rules: a rule's own spaces stay inside its parentheses (`Bash(npm run test:*)`).
pub fn split_rules(text: &str) -> Vec<String> {
    let mut out = vec![];
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() || chars[i] == '(' {
            // [^\s(]+ needs at least one char before a '('
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '(' {
            i += 1;
        }
        if i < chars.len() && chars[i] == '(' {
            if let Some(close) = chars[i..].iter().position(|&c| c == ')') {
                i += close + 1;
            }
        }
        out.push(chars[start..i].iter().collect());
    }
    out
}

/// `:permissions [allow|remove <rule>...]`
pub fn exec(app: &mut App, arg: &str) {
    let arg = arg.trim();
    let (verb, rest) = arg.split_once(char::is_whitespace).map(|(v, r)| (v, r.trim())).unwrap_or((arg, ""));
    if matches!(verb, "allow" | "remove" | "unallow" | "deny") && !rest.is_empty() {
        reload(app);
        let rules = split_rules(rest);
        let mut allow = app.config.engine_options("claude").and_then(|o| o.allow.clone()).unwrap_or_default();
        for r in &rules {
            if verb == "allow" {
                if !allow.contains(r) {
                    allow.push(r.clone());
                }
            } else {
                allow.retain(|x| x != r);
            }
        }
        set(app, "claude", |o| o.allow = Some(allow));
        let did = if verb == "allow" { "allowed" } else { "removed" };
        return app.say(format!("{did} {} for Claude Code (saved; from its next prompt)", rules.join(" ")), "Comment");
    }
    if !arg.is_empty() {
        return app.say("usage: :permissions  |  :permissions allow <rule>  |  :permissions remove <rule>", "ErrorMsg");
    }
    open(app);
}

fn on_off(b: bool) -> String {
    (if b { "on" } else { "off" }).into()
}

fn cycle<'a>(values: &[&'a str], now: &str, dir: i32) -> &'a str {
    let n = values.len() as i32;
    let at = values.iter().position(|v| *v == now).map(|i| i as i32).unwrap_or(-1);
    values[((at + dir + n) % n) as usize]
}

fn allow(app: &App) -> Vec<String> {
    app.config.engine_options("claude").and_then(|o| o.allow.clone()).unwrap_or_default()
}

fn section(app: &App, id: &str) -> String {
    let name = crate::engines::engine_name(id);
    match app.engines.get(id) {
        Some(e) if !e.installed && !e.checking => format!("{name} (not installed)"),
        _ => name,
    }
}

/// The panel: every engine's permissions, each change saved at once.
pub fn open(app: &mut App) {
    app.seq.reset();
    reload(app);
    let claude = section(app, "claude");
    let mut items = vec![
        Item::change(
            &claude,
            "Mode",
            |a| flag_value(&engine_args(a, "claude"), "--permission-mode").unwrap_or_else(|| "default".into()),
            |a, d| {
                let args = engine_args(a, "claude");
                let now = flag_value(&args, "--permission-mode").unwrap_or_else(|| "default".into());
                let next = with_flag(&args, "--permission-mode", Some(cycle(&CLAUDE_MODES, &now, d)));
                set(a, "claude", |o| o.args = Some(next));
            },
            "acceptEdits: edits go ahead, other tools need a rule · default: only what's allowed · plan: read-only · bypassPermissions: everything (in its worktree)",
        ),
        Item::change(
            &claude,
            "Ask when it's refused a tool",
            |a| on_off(a.config.engine_options("claude").and_then(|o| o.ask) == Some(true)),
            |a, _| {
                let on = a.config.engine_options("claude").and_then(|o| o.ask) == Some(true);
                set(a, "claude", |o| o.ask = if on { None } else { Some(true) });
            },
            "allow once / always allow / no, then the agent runs again with the permission",
        ),
    ];
    for (rule, label) in CLAUDE_PRESETS {
        items.push(Item::change_with(
            &claude,
            &format!("Allow {label}"),
            Box::new(move |a: &App| if allow(a).iter().any(|r| r == rule) { format!("on  {rule}") } else { "off".into() }),
            Box::new(move |a: &mut App, _| {
                let mut list = allow(a);
                if list.iter().any(|r| r == rule) {
                    list.retain(|r| r != rule);
                } else {
                    list.push(rule.to_string());
                }
                set(a, "claude", |o| o.allow = Some(list));
            }),
            &format!("the rule {rule}, without asking"),
        ));
    }
    items.push(Item::info(
        &claude,
        "Other allowed",
        |a| {
            let other: Vec<String> = allow(a).into_iter().filter(|r| !CLAUDE_PRESETS.iter().any(|(p, _)| p == r)).collect();
            if other.is_empty() { "none".into() } else { crate::settings::truncate(&other.join(", "), 40, "…") }
        },
        ":permissions allow Bash(cargo:*) adds a rule · :permissions remove <rule> takes one away",
    ));
    let codex = section(app, "codex");
    items.push(Item::change(
        &codex,
        "Sandbox",
        |a| codex_option(&engine_args(a, "codex"), "sandbox_mode").unwrap_or_else(|| "read-only".into()),
        |a, d| {
            let args = engine_args(a, "codex");
            let now = codex_option(&args, "sandbox_mode").unwrap_or_else(|| "read-only".into());
            let next = with_codex_option(&args, "sandbox_mode", Some(CodexValue::Str(cycle(&CODEX_SANDBOXES, &now, d))));
            set(a, "codex", |o| o.args = Some(next));
        },
        "workspace-write: it edits its worktree · read-only: looks only · danger-full-access: no sandbox",
    ));
    items.push(Item::change(
        &codex,
        "Network (fetch, git, gh)",
        |a| on_off(codex_option(&engine_args(a, "codex"), "sandbox_workspace_write.network_access").as_deref() == Some("true")),
        |a, _| {
            let args = engine_args(a, "codex");
            let on = codex_option(&args, "sandbox_workspace_write.network_access").as_deref() == Some("true");
            let next = with_codex_option(&args, "sandbox_workspace_write.network_access", if on { None } else { Some(CodexValue::Bool(true)) });
            set(a, "codex", |o| o.args = Some(next));
        },
        "the workspace-write sandbox has no network unless this is on",
    ));
    let gemini = section(app, "gemini");
    items.push(Item::change(
        &gemini,
        "Approval",
        |a| flag_value(&engine_args(a, "gemini"), "--approval-mode").unwrap_or_else(|| "default".into()),
        |a, d| {
            let args = engine_args(a, "gemini");
            let now = flag_value(&args, "--approval-mode").unwrap_or_else(|| "default".into());
            let next = with_flag(&args, "--approval-mode", Some(cycle(&GEMINI_APPROVALS, &now, d)));
            set(a, "gemini", |o| o.args = Some(next));
        },
        "auto_edit: edits go ahead · yolo: edits, commands and fetches too · default: headless Gemini refuses what needs approval",
    ));
    let cursor = section(app, "cursor");
    items.push(Item::change(
        &cursor,
        "Run commands without asking",
        |a| on_off(engine_args(a, "cursor").iter().any(|x| x == "--force")),
        |a, _| {
            let args = engine_args(a, "cursor");
            let on = args.iter().any(|x| x == "--force");
            let next = with_switch(&args, "--force", !on);
            set(a, "cursor", |o| o.args = Some(next));
        },
        "--force: edits and commands in its worktree (headless Cursor can't ask)",
    ));
    // each change starts from what's saved now, so it never undoes one made in another vigent
    for item in &mut items {
        item.reload_first = true;
    }
    app.cfg.panel = Some(Panel::new("Permissions · saved as you change them, used from each agent's next prompt", items, 110, save));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        s(a)
    }

    #[test]
    fn helpers_change_only_the_permission_part() {
        let args = v(&["--verbose", "--permission-mode", "acceptEdits", "--add-dir", "/x"]);
        assert_eq!(flag_value(&args, "--permission-mode").as_deref(), Some("acceptEdits"));
        assert_eq!(with_flag(&args, "--permission-mode", Some("plan")), v(&["--verbose", "--add-dir", "/x", "--permission-mode", "plan"]));
        assert!(with_flag(&v(&["--permission-mode=plan"]), "--permission-mode", None).is_empty());
        assert_eq!(with_switch(&v(&["--x"]), "--force", true), v(&["--x", "--force"]));
        assert_eq!(with_switch(&v(&["--force", "--x"]), "--force", false), v(&["--x"]));
        let codex = v(&["-c", "sandbox_mode=\"workspace-write\"", "-c", "model_verbosity=low"]);
        assert_eq!(codex_option(&codex, "sandbox_mode").as_deref(), Some("workspace-write"));
        let mut more = codex.clone();
        more.extend(v(&["-c", "sandbox_workspace_write.network_access=true"]));
        assert_eq!(with_codex_option(&codex, "sandbox_workspace_write.network_access", Some(CodexValue::Bool(true))), more);
        assert_eq!(with_codex_option(&codex, "sandbox_mode", Some(CodexValue::Str("read-only"))), v(&["-c", "model_verbosity=low", "-c", "sandbox_mode=\"read-only\""]));
        assert_eq!(with_codex_option(&codex, "model_verbosity", None), v(&["-c", "sandbox_mode=\"workspace-write\""]));
    }

    #[test]
    fn rules_keep_their_spaces() {
        assert_eq!(split_rules("WebFetch Bash(npm run test:*)"), v(&["WebFetch", "Bash(npm run test:*)"]));
        assert_eq!(split_rules("Bash(cargo:*)"), v(&["Bash(cargo:*)"]));
    }
}
