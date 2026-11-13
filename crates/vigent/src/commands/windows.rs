//! Windows area: splits and buffers (:split, :vsplit, :only, :close, :wincmd,
//! :b, :bn, :bp, :ls, :dash), search (:noh), :marks, :jumps, :history, and
//! the vim-style configuration commands the area's keys rely on: :set, the
//! :map / :unmap family, :command / :delcommand, your own commands ([commands]
//! in config.toml) and :!{command} (src/app.ts exec).

use std::io::Read;
use std::time::{Duration, Instant};

use super::{Command, Ex};
use crate::actions::windows as w;
use crate::app::{App, Msg};
use crate::config::{Transparent, UiOptions};
use crate::keys::{KeyMode, RhsValue};
use crate::session::Item;
use crate::toml::Val;
use crate::ui::floats::{Float, FloatLine};
use crate::windows::Dir;

pub static COMMANDS: &[Command] = &[
    Command { name: "split", aliases: &["sp"], also: None, run: |a, ex| w::split_window(a, Dir::Column, ex.arg) },
    Command { name: "vsplit", aliases: &["vs", "vsp"], also: None, run: |a, ex| w::split_window(a, Dir::Row, ex.arg) },
    Command { name: "only", aliases: &["on"], also: None, run: |a, _| a.windows.layout.only() },
    Command { name: "close", aliases: &["clo"], also: None, run: |a, _| w::close_window(a) },
    Command { name: "wincmd", aliases: &["winc"], also: None, run: |a, ex| w::exec_wincmd(a, ex.arg) },
    Command { name: "bnext", aliases: &["bn"], also: None, run: |a, _| crate::actions::run(a, "session.next", None) },
    Command { name: "bprevious", aliases: &["bprev", "bp", "bNext", "bN"], also: None, run: |a, _| crate::actions::run(a, "session.prev", None) },
    Command { name: "buffer", aliases: &["b"], also: None, run: buffer },
    Command { name: "ls", aliases: &["buffers", "files", "dash", "dashboard"], also: None, run: |a, _| w::open_dashboard(a) },
    Command { name: "nohlsearch", aliases: &["noh", "nohl"], also: None, run: |a, _| w::clear_search(a) },
    Command { name: "marks", aliases: &[], also: None, run: |a, _| list_places(a, "marks") },
    Command { name: "jumps", aliases: &[], also: None, run: |a, _| list_places(a, "jumps") },
    Command { name: "history", aliases: &["his"], also: None, run: |a, _| list_places(a, "history") },
    Command { name: "set", aliases: &["se"], also: None, run: set },
    Command { name: "map", aliases: &[], also: Some(is_map), run: map },
    Command { name: "unmap", aliases: &[], also: Some(is_unmap), run: unmap },
    Command { name: "command", aliases: &["com"], also: None, run: |a, ex| exec_command(a, ex.arg, ex.bang) },
    Command { name: "delcommand", aliases: &["delc"], also: None, run: delcommand },
    Command { name: "!", aliases: &[], also: None, run: |a, ex| run_shell(a, ex.arg, &format!(":!{}", ex.arg), None) },
    Command { name: "User", aliases: &[], also: Some(is_user_command), run: user_command },
];

fn buffer(app: &mut App, ex: &Ex) {
    if let Some(slot) = w::agent_named(app, ex.arg)
        && let Some(n) = app.open().iter().position(|&i| i == slot)
    {
        app.focus_agent(n);
    }
}

// ---------------------------------------------------------------------------
// :marks, :jumps, :history
// ---------------------------------------------------------------------------

fn list_places(app: &mut App, kind: &str) {
    let s = app.focused().map(|s| (s.slot, s.name.clone()));
    let lines = crate::ui::pane::current(app);
    let text = |line: usize| lines.get(line).map(|l| l.plain.trim().chars().take(60).collect::<String>()).unwrap_or_default();
    let mut out: Vec<FloatLine> = vec![];
    let win = &app.windows;
    match kind {
        "history" => {
            out.push(vec![("Title", "      #  cmd history".into())]);
            for (i, c) in win.cmd_history.iter().enumerate() {
                out.push(vec![("Comment", format!("{:>7}", i + 1)), ("NormalFloat", format!("  {c}"))]);
            }
            if !win.search_history.is_empty() {
                out.push(vec![]);
                out.push(vec![("Title", "      #  search history".into())]);
            }
            for (i, q) in win.search_history.iter().enumerate() {
                out.push(vec![("Comment", format!("{:>7}", i + 1)), ("NormalFloat", format!("  {q}"))]);
            }
        }
        "marks" => {
            let mut marks = s.clone().and_then(|(slot, _)| win.marks.get(&slot).cloned()).unwrap_or_default();
            marks.sort_by(|a, b| a.0.to_lowercase().cmp(b.0.to_lowercase()).then(a.0.cmp(&b.0)));
            out.push(vec![("Title", "mark  line  text".into())]);
            for (m, line) in marks {
                out.push(vec![("Identifier", format!(" {m}")), ("Comment", format!("{:>9}", line + 1)), ("NormalFloat", format!("  {}", text(line)))]);
            }
        }
        _ => {
            let (list, at) = s.clone().and_then(|(slot, _)| win.jumps.get(&slot).cloned()).unwrap_or_default();
            out.push(vec![("Title", " jump  line  text".into())]);
            for (i, line) in list.iter().enumerate() {
                out.push(vec![("Identifier", format!("{}{:>4}", if i == at { ">" } else { " " }, at.abs_diff(i))), ("Comment", format!("{:>6}", line + 1)), ("NormalFloat", format!("  {}", text(*line)))]);
            }
            if at == list.len() {
                out.push(vec![("Identifier", ">".into())]);
            }
        }
    }
    if out.len() == 1 {
        let msg = match kind {
            "marks" => "no marks set: m{a-z} sets one",
            "jumps" => "no jumps yet: G, gg, n, { and marks are jumps",
            _ => "no history yet",
        };
        return app.say(msg, "Comment");
    }
    let title = if kind == "history" { "history".to_string() } else { format!("{kind} · {}", s.map(|x| x.1).unwrap_or_default()) };
    app.seq.reset();
    app.float = Some(Float::rich(&title, out, 84.min(app.windows.cols.saturating_sub(4))));
}

// ---------------------------------------------------------------------------
// :set (src/config.ts applySetCommand)
// ---------------------------------------------------------------------------

const UI_KEYS: &[&str] = &["sidebar", "sidebar_width", "sidebar_position", "number", "tilde", "icons", "timeoutlen", "termguicolors", "transparent", "whichkey", "notify"];

fn is_bool(ui: &UiOptions, key: &str) -> Option<bool> {
    Some(match key {
        "sidebar" => ui.sidebar,
        "number" => ui.number,
        "tilde" => ui.tilde,
        "termguicolors" => ui.termguicolors,
        "whichkey" => ui.whichkey,
        "transparent" => match ui.transparent {
            Transparent::On => true,
            Transparent::Off => false,
            Transparent::Auto => return None,
        },
        _ => return None,
    })
}

fn show(ui: &UiOptions, key: &str) -> String {
    if let Some(b) = is_bool(ui, key) {
        return if b { format!("  {key}") } else { format!("no{key}") };
    }
    let v = match key {
        "sidebar_width" => ui.sidebar_width.to_string(),
        "sidebar_position" => ui.sidebar_position.clone(),
        "icons" => ui.icons.clone(),
        "timeoutlen" => ui.timeoutlen.to_string(),
        "transparent" => "auto".into(),
        "notify" => ui.notify.clone(),
        _ => String::new(),
    };
    format!("  {key}={v}")
}

fn set_bool(ui: &mut UiOptions, key: &str, v: bool) {
    match key {
        "sidebar" => ui.sidebar = v,
        "number" => ui.number = v,
        "tilde" => ui.tilde = v,
        "termguicolors" => ui.termguicolors = v,
        "whichkey" => ui.whichkey = v,
        "transparent" => ui.transparent = if v { Transparent::On } else { Transparent::Off },
        _ => {}
    }
}

fn bool_key(key: &str) -> bool {
    matches!(key, "sidebar" | "number" | "tilde" | "termguicolors" | "whichkey")
}

/// `:set` lists the options; `opt`, `noopt`, `opt!`, `invopt`, `opt=val`, `opt?`, `opt&` change or show one.
pub fn apply_set(ui: &mut UiOptions, arg: &str) -> Result<String, String> {
    if arg.trim().is_empty() {
        return Ok(UI_KEYS.iter().map(|k| show(ui, k)).collect::<Vec<_>>().join("  "));
    }
    let alias = crate::config::ui_option;
    let mut shown = vec![];
    for part in arg.split_whitespace() {
        if let Some(name) = part.strip_suffix('?') {
            let Some(key) = alias(name) else { return Err(format!("E518: Unknown option: {name}")) };
            shown.push(show(ui, key));
            continue;
        }
        if let Some((name, value)) = part.split_once('=') {
            if let Err(e) = crate::config::set_option(ui, name, &Val::Str(value.to_string())) {
                return Err(format!("E518: {e}"));
            }
            continue;
        }
        if let Some(name) = part.strip_suffix('!').or_else(|| part.strip_prefix("inv")) {
            let key = alias(name);
            if key == Some("transparent") {
                let now = ui.transparent == Transparent::On;
                ui.transparent = if now { Transparent::Off } else { Transparent::On };
                continue;
            }
            match key.filter(|k| bool_key(k)) {
                Some(k) => {
                    let v = is_bool(ui, k).unwrap_or(false);
                    set_bool(ui, k, !v);
                }
                None => return Err(format!("E518: Unknown option: {part}")),
            }
            continue;
        }
        if let Some(name) = part.strip_suffix('&') {
            let Some(key) = alias(name) else { return Err(format!("E518: Unknown option: {name}")) };
            let d = UiOptions::default();
            match key {
                "sidebar_width" => ui.sidebar_width = d.sidebar_width,
                "sidebar_position" => ui.sidebar_position = d.sidebar_position,
                "icons" => ui.icons = d.icons,
                "timeoutlen" => ui.timeoutlen = d.timeoutlen,
                "transparent" => ui.transparent = d.transparent,
                "notify" => ui.notify = d.notify,
                k => set_bool(ui, k, is_bool(&d, k).unwrap_or(false)),
            }
            continue;
        }
        let off = part.strip_prefix("no").filter(|n| alias(n).is_some());
        let key = alias(off.unwrap_or(part));
        let Some(key) = key else { return Err(format!("E518: Unknown option: {part}")) };
        if !bool_key(key) && key != "transparent" {
            shown.push(show(ui, key));
            continue;
        }
        set_bool(ui, key, off.is_none());
    }
    Ok(shown.join("  "))
}

fn set(app: &mut App, ex: &Ex) {
    match apply_set(&mut app.config.ui, ex.arg) {
        Ok(m) => app.say(m, "Normal"),
        Err(e) => app.say(e, "ErrorMsg"),
    }
}

// ---------------------------------------------------------------------------
// :map and :unmap
// ---------------------------------------------------------------------------

fn split_letter<'a>(name: &'a str, word: &str) -> Option<&'a str> {
    let base = name.strip_suffix(word)?;
    let base = base.strip_suffix("nore").unwrap_or(base);
    (base.is_empty() || (base.len() == 1 && "nicvx".contains(base))).then_some(base)
}

fn is_map(name: &str) -> bool {
    split_letter(name, "map").is_some()
}

fn is_unmap(name: &str) -> bool {
    name.strip_suffix("unmap").is_some_and(|b| b.is_empty() || (b.len() == 1 && "nicvx".contains(b)))
}

fn map_modes(letter: &str) -> Vec<KeyMode> {
    match letter {
        "i" => vec![KeyMode::Insert],
        "c" => vec![KeyMode::Command],
        "x" | "v" => vec![KeyMode::Visual],
        _ => vec![KeyMode::Normal],
    }
}

fn mode_letter(m: KeyMode) -> &'static str {
    match m {
        KeyMode::Normal => "n",
        KeyMode::Insert => "i",
        KeyMode::Visual => "x",
        KeyMode::Command => "c",
    }
}

fn map(app: &mut App, ex: &Ex) {
    let letter = split_letter(ex.name.trim_end_matches('!'), "map").unwrap_or("");
    let modes = map_modes(letter);
    let raw = ex.raw.trim_start();
    if raw.trim().is_empty() {
        return open_mappings(app, &modes);
    }
    let end = raw.find(char::is_whitespace).unwrap_or(raw.len());
    let (lhs, rest) = raw.split_at(end);
    let rhs = rest.trim_start();
    if rhs.trim().is_empty() {
        let mut found = vec![];
        for m in &modes {
            if let Ok(keys) = crate::keys::parse_keys(lhs, &app.keymap.leader)
                && let Some(b) = app.keymap.lookup(*m, &keys, false).exact
            {
                found.push(format!("{}  {}  {}", mode_letter(*m), b.keys.concat(), b.rhs_text));
            }
        }
        return if found.is_empty() { app.say("No mapping found", "Comment") } else { app.say(found.join("   "), "Normal") };
    }
    for m in modes {
        if let Err(e) = app.keymap.set(m, lhs, &RhsValue::Str(rhs.to_string())) {
            return app.say(format!("E474: {e}"), "ErrorMsg");
        }
    }
    app.message = (String::new(), "Comment");
}

fn unmap(app: &mut App, ex: &Ex) {
    let letter = ex.name.trim_end_matches('!').strip_suffix("unmap").unwrap_or("");
    let lhs = ex.arg.trim();
    if lhs.is_empty() {
        return app.say("E474: Invalid argument", "ErrorMsg");
    }
    let mut removed = false;
    for m in map_modes(letter) {
        removed |= app.keymap.unset(m, lhs);
    }
    if !removed {
        app.say("E31: No such mapping", "ErrorMsg");
    }
}

/// `:map` with no arguments: your mappings, vim-style.
fn open_mappings(app: &mut App, modes: &[KeyMode]) {
    let mut lines: Vec<FloatLine> = vec![];
    for m in modes {
        for b in app.keymap.bindings(*m).into_iter().filter(|b| b.user) {
            lines.push(vec![("Comment", format!("{}  ", mode_letter(*m))), ("Title", format!("{:<14}", b.keys.concat())), ("NormalFloat", format!(" {}", b.rhs_text))]);
        }
    }
    if lines.is_empty() {
        return app.say("No mapping found", "Comment");
    }
    app.seq.reset();
    app.float = Some(Float::rich("Mappings", lines, 72));
}

// ---------------------------------------------------------------------------
// your own commands: [commands], :command, :delcommand, :!{command}
// ---------------------------------------------------------------------------

fn command_name_ok(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_user_command(name: &str) -> bool {
    command_name_ok(name)
}

/// One step of a command: ":new x" → "new x"; "!npm test" stays a shell command.
fn normalize_step(step: &str) -> String {
    step.trim().trim_start_matches(':').trim_start().to_string()
}

fn fill_args(step: &str, args: &str) -> String {
    step.replace("{args}", args).replace("<args>", args)
}

fn commands_of(app: &App) -> &Vec<(String, Vec<String>)> {
    if app.windows.commands_loaded { &app.windows.commands } else { &app.config.commands }
}

fn ensure_loaded(app: &mut App) {
    if !app.windows.commands_loaded {
        app.windows.commands_loaded = true;
        app.windows.commands = app.config.commands.clone();
    }
}

fn find_command(app: &App, name: &str) -> Option<Vec<String>> {
    commands_of(app).iter().find(|(n, _)| n == name).map(|(_, s)| s.clone())
}

/// `:command` lists yours, `:command Name` shows one, `:command[!] Name {cmd}` defines one (for this run).
pub fn exec_command(app: &mut App, arg: &str, bang: bool) {
    ensure_loaded(app);
    if arg.is_empty() {
        let mut names: Vec<&(String, Vec<String>)> = app.windows.commands.iter().collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        if names.is_empty() {
            return app.say("no commands of your own yet: :command Name {cmd}, or [commands] in config.toml", "Comment");
        }
        let msg = names.iter().map(|(n, s)| format!("{n} = {}", s.join(" | "))).collect::<Vec<_>>().join("   ");
        return app.say(msg, "Normal");
    }
    let end = arg.find(char::is_whitespace).unwrap_or(arg.len());
    let (name, rest) = arg.split_at(end);
    let rhs = rest.trim_start();
    if !command_name_ok(name) {
        return app.say(format!("E183: User defined commands must start with an uppercase letter: {name}"), "ErrorMsg");
    }
    if rhs.is_empty() {
        return match find_command(app, name) {
            Some(c) => app.say(format!("{name} = {}", c.join(" | ")), "Normal"),
            None => app.say(format!("E184: No such user-defined command: {name}"), "ErrorMsg"),
        };
    }
    if find_command(app, name).is_some() && !bang {
        return app.say(format!("E174: Command already exists: add ! to replace it: {name}"), "ErrorMsg");
    }
    // like vim, | separates commands (a shell step keeps the rest of the line)
    let parts: Vec<&str> = rhs.split('|').collect();
    let shell = parts.iter().position(|p| normalize_step(p).starts_with('!'));
    let mut steps: Vec<String> = match shell {
        Some(i) => parts[..i].iter().map(|p| p.to_string()).chain(std::iter::once(parts[i..].join("|"))).collect(),
        None => parts.iter().map(|p| p.to_string()).collect(),
    };
    steps = steps.iter().map(|s| normalize_step(s)).filter(|s| !s.is_empty()).collect();
    let msg = format!(":{name} = {}", steps.join(" | "));
    match app.windows.commands.iter_mut().find(|(n, _)| n == name) {
        Some(e) => e.1 = steps,
        None => app.windows.commands.push((name.to_string(), steps)),
    }
    app.say(msg, "Comment");
}

fn delcommand(app: &mut App, ex: &Ex) {
    ensure_loaded(app);
    let before = app.windows.commands.len();
    app.windows.commands.retain(|(n, _)| n != ex.arg);
    if app.windows.commands.len() == before {
        app.say(format!("E184: No such user-defined command: {}", ex.arg), "ErrorMsg");
    } else {
        app.say(format!("deleted :{}", ex.arg), "Comment");
    }
}

fn user_command(app: &mut App, ex: &Ex) {
    let name = ex.name.trim_end_matches('!');
    let Some(steps) = find_command(app, name) else {
        return app.say(format!("E492: Not an editor command: {name}"), "ErrorMsg");
    };
    if app.windows.command_depth >= 10 {
        return app.say(format!("E169: :{name} is too recursive"), "ErrorMsg");
    }
    let steps: Vec<String> = steps.iter().map(|s| fill_args(s, ex.arg)).collect();
    app.windows.command_depth += 1;
    run_steps(app, name.to_string(), steps);
    app.windows.command_depth -= 1;
}

/// Each step in turn; a shell step runs in the background and the rest wait for it (a failure stops them).
fn run_steps(app: &mut App, name: String, mut steps: Vec<String>) {
    while !steps.is_empty() {
        let step = steps.remove(0);
        if let Some(cmd) = step.strip_prefix('!') {
            let cmd = cmd.trim().to_string();
            let label = format!(":{name}");
            run_shell(
                app,
                &cmd,
                &label,
                Some(Box::new(move |app: &mut App, ok: bool| {
                    if ok {
                        run_steps(app, name, steps);
                    }
                })),
            );
            return;
        }
        crate::commands::exec(app, &step);
    }
}

/// "3.2s", "1m 05s"
pub fn took(ms: u128) -> String {
    if ms < 60_000 {
        return format!("{:.1}s", ms as f64 / 1000.0);
    }
    let s = (ms as f64 / 1000.0).round() as u64;
    format!("{}m {:02}s", s / 60, s % 60)
}

fn last_line(output: &str) -> String {
    output.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string()
}

pub struct ShellResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub output: String,
    pub ms: u128,
    pub timed_out: bool,
}

/// Run a command with a shell in `cwd`, stdout and stderr together; never fails (a failure is a result).
pub fn run_hook(command: &str, cwd: &std::path::Path, env: &[(String, String)], timeout: Duration) -> ShellResult {
    let started = Instant::now();
    let child = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("exec 2>&1\n{command}"))
        .current_dir(cwd)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return ShellResult { ok: false, code: None, output: e.to_string(), ms: 0, timed_out: false },
    };
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if started.elapsed() > timeout => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break None,
        }
    };
    let out = String::from_utf8_lossy(&reader.join().unwrap_or_default()).to_string();
    let chars: Vec<char> = out.chars().collect();
    let output: String = chars[chars.len().saturating_sub(4000)..].iter().collect::<String>().trim_end().to_string();
    let code = if timed_out { None } else { status.and_then(|s| s.code()) };
    ShellResult { ok: code == Some(0) && !timed_out, code, output, ms: started.elapsed().as_millis(), timed_out }
}

type AfterShell = Box<dyn FnOnce(&mut App, bool) + Send>;

/// `:!cmd`: a shell command in the focused agent's worktree (else the repository); its output goes in the transcript.
pub fn run_shell(app: &mut App, command: &str, label: &str, then: Option<AfterShell>) {
    let s = app.focused();
    let slot = s.map(|s| s.slot);
    let cwd = s.map(|s| s.path.clone()).or_else(|| app.root.clone()).unwrap_or_else(|| app.cwd.clone());
    let worktree = s.filter(|s| s.branch.is_some()).map(|s| s.path.display().to_string()).unwrap_or_default();
    let env: Vec<(String, String)> = vec![
        ("VIGENT_AGENT".into(), s.map(|s| s.name.clone()).unwrap_or_default()),
        ("VIGENT_ENGINE".into(), s.map(|s| s.engine.clone()).unwrap_or_default()),
        ("VIGENT_BRANCH".into(), s.and_then(|s| s.branch.clone()).unwrap_or_default()),
        ("VIGENT_WORKTREE".into(), worktree),
        ("VIGENT_REPO".into(), app.root.as_ref().map(|r| r.display().to_string()).unwrap_or_default()),
    ];
    app.say(format!("{label} …"), "Comment");
    let (command, label, tx) = (command.to_string(), label.to_string(), app.tx.clone());
    std::thread::spawn(move || {
        let r = run_hook(&command, &cwd, &env, Duration::from_secs(15 * 60));
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| {
            let how = if r.ok {
                format!("done in {}", took(r.ms))
            } else if r.timed_out {
                format!("timed out after {}", took(r.ms))
            } else {
                format!("failed (exit {}) after {}", r.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()), took(r.ms))
            };
            if let Some(s) = slot.and_then(|i| app.sessions.get_mut(i)) {
                s.items.push(Item::Info(format!("$ {command}  ({how}){}", if r.output.is_empty() { String::new() } else { format!("\n{}", r.output) })));
            }
            let last = last_line(&r.output);
            let msg = format!("{label}: {how}{}", if last.is_empty() { String::new() } else { format!(" · {last}") });
            app.say(msg, if r.ok { "Comment" } else { "ErrorMsg" });
            if let Some(then) = then {
                then(app, r.ok);
            }
        })));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;

    #[test]
    fn set_shows_toggles_and_errs() {
        let mut ui = UiOptions::default();
        let all = apply_set(&mut ui, "").unwrap();
        assert!(all.starts_with("  sidebar    sidebar_width=30    sidebar_position=left"), "{all}");
        apply_set(&mut ui, "nonu").unwrap();
        assert!(!ui.number);
        apply_set(&mut ui, "nu!").unwrap();
        assert!(ui.number);
        apply_set(&mut ui, "sbw=40 sbp=right").unwrap();
        assert_eq!((ui.sidebar_width, ui.sidebar_position.as_str()), (40, "right"));
        assert_eq!(apply_set(&mut ui, "sbw?").unwrap(), "  sidebar_width=40");
        apply_set(&mut ui, "sbw&").unwrap();
        assert_eq!(ui.sidebar_width, 30);
        assert_eq!(apply_set(&mut ui, "bogus"), Err("E518: Unknown option: bogus".into()));
        assert_eq!(apply_set(&mut ui, "sbw=3"), Err("E518: 'sbw' should be a number from 16 to 80".into()));
        assert_eq!(apply_set(&mut ui, "nonu?").unwrap_err(), "E518: Unknown option: nonu");
    }

    #[test]
    fn maps_and_unmaps() {
        let mut a = app();
        crate::commands::exec(&mut a, "nnoremap <leader>x :colorscheme nord<CR>");
        crate::commands::exec(&mut a, "nmap <leader>x");
        assert_eq!(a.message.0, "n  <Space>x  :colorscheme nord<CR>");
        crate::commands::exec(&mut a, "nunmap <leader>x");
        crate::commands::exec(&mut a, "nunmap <leader>x");
        assert_eq!(a.message.0, "E31: No such mapping");
        crate::commands::exec(&mut a, "unmap");
        assert_eq!(a.message.0, "E474: Invalid argument");
        crate::commands::exec(&mut a, "imap jk <Esc>");
        crate::commands::exec(&mut a, "map");
        assert_eq!(a.message.0, "No mapping found", "plain :map lists NORMAL only");
    }

    #[test]
    fn user_commands() {
        let mut a = app();
        crate::commands::exec(&mut a, "command");
        assert!(a.message.0.contains("no commands of your own yet"));
        crate::commands::exec(&mut a, "command Ask colo nord | colo gruvbox");
        assert_eq!(a.windows.commands, vec![("Ask".to_string(), vec!["colo nord".to_string(), "colo gruvbox".to_string()])]);
        crate::commands::exec(&mut a, "Ask");
        assert_eq!(a.theme.name, "gruvbox");
        crate::commands::exec(&mut a, "command Ask x");
        assert!(a.message.0.starts_with("E174: Command already exists"));
        crate::commands::exec(&mut a, "command! Ask colo nord");
        crate::commands::exec(&mut a, "command Grep !git grep -n foo | head -3");
        assert_eq!(a.windows.commands[1].1, vec!["!git grep -n foo | head -3".to_string()]);
        crate::commands::exec(&mut a, "command");
        assert_eq!(a.message.0, "Ask = colo nord   Grep = !git grep -n foo | head -3");
        crate::commands::exec(&mut a, "command Ask");
        assert_eq!(a.message.0, "Ask = colo nord");
        crate::commands::exec(&mut a, "command lower x");
        assert!(a.message.0.starts_with("E183"));
        crate::commands::exec(&mut a, "delcommand Ask");
        crate::commands::exec(&mut a, "delc Ask");
        assert_eq!(a.message.0, "E184: No such user-defined command: Ask");
        crate::commands::exec(&mut a, "command Loop Loop");
        crate::commands::exec(&mut a, "Loop");
        assert_eq!(a.message.0, "E169: :Loop is too recursive");
        crate::commands::exec(&mut a, "Nope");
        assert_eq!(a.message.0, "E492: Not an editor command: Nope");
        crate::commands::exec(&mut a, "!");
        assert!(a.message.0.starts_with("E471"));
    }

    #[test]
    fn shell_commands_run_with_the_agent_env() {
        let dir = std::env::temp_dir();
        let r = run_hook("echo out; echo err >&2; exit 3", &dir, &[("VIGENT_REPO".into(), "/r/shop".into())], Duration::from_secs(5));
        assert_eq!((r.ok, r.code), (false, Some(3)));
        assert_eq!(r.output, "out\nerr");
        let r = run_hook("basename $VIGENT_REPO", &dir, &[("VIGENT_REPO".into(), "/r/shop".into())], Duration::from_secs(5));
        assert!(r.ok && r.output == "shop");
        assert_eq!(took(300), "0.3s");
        assert_eq!(took(65_000), "1m 05s");
    }
}
