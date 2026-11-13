//! Agents' lives on the App (Sessions area): starting one in a worktree made
//! in the background, saving its record, reopening agents after a restart,
//! :kill / :attach / :worktrees, the queue, pause and resume, forks for
//! splits, notifications when an agent you aren't looking at stops, and the
//! worktree_created / agent_finished hooks. The same behavior and messages as
//! src/app.ts (startAgent, killFocused, execAttach, execWorktree, execQueue,
//! watchState) and src/cli.ts (reopen, movedOffPi, persist, forkSession).
//!
//! Per-agent state is on [`Session`]; what's App-wide is [`Agents`] (App::agents).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::app::{App, Msg};
use crate::engines;
use crate::records::{self, AgentMeta};
use crate::session::{Item, Session, State};
use crate::ui::floats::Float;
use crate::worktree::{self, Made};

pub const PI_INSTALL: &str = "npm install -g @mariozechner/pi-coding-agent";
/// What to do when pi isn't there at all (src/session.ts PI_MISSING_HINT).
pub const PI_MISSING_HINT: &str = "this agent runs on pi, which isn't installed. Install pi and send again, or press Esc and type :new <task> to start an agent on your default engine (:engine picks it, e.g. Claude Code or Codex); :kill removes this one.";
/// Every few seconds the agents' changes are counted again: edits made outside them (you, your editor) show up too.
const STAT_EVERY: Duration = Duration::from_secs(5);

/// The App-wide part of the Sessions area.
pub struct Agents {
    /// the agent before the one on screen (<C-^>)
    pub alt: usize,
    /// the terminal window has focus (focus reporting; assumed until told otherwise)
    pub terminal_focused: bool,
    /// a y/n question on the message line (dd): what `y` does
    pub confirm: Option<Confirm>,
    /// notifications, kept here instead of written to the terminal (tests)
    pub alerts: Option<Vec<String>>,
    /// the message shown while a worktree is made, replaced once it's there (unless something else was said since)
    making: Vec<(usize, String)>,
    last_stat: Option<Instant>,
    /// races started this time (race.rs)
    pub races: Vec<crate::race::Race>,
    /// can agent worktrees be copy-on-write here (riftri)? None until checked
    pub storage: Option<worktree::Health>,
}

impl Default for Agents {
    fn default() -> Self {
        Agents { alt: 0, terminal_focused: true, confirm: None, alerts: None, making: vec![], last_stat: None, races: vec![], storage: None }
    }
}

/// Text in lines of at most `w` columns, broken between words.
fn wrap_words(text: &str, w: usize) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    for word in text.split_whitespace() {
        if !cur.is_empty() && crate::ui::text::width(&cur) + 1 + crate::ui::text::width(word) > w {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

/// The worktrees part of :checkhealth: riftri, and what agent worktrees cost on disk (src/app.ts storageHealthLines).
pub fn storage_health_lines(h: &worktree::Health) -> Vec<(String, &'static str)> {
    let (glyph, group) = if h.ready {
        ("●", "String")
    } else if h.installed {
        ("◐", "WarningMsg")
    } else {
        ("○", "Comment")
    };
    let mut l: Vec<(String, &'static str)> = vec![(String::new(), "Normal"), ("vigent: agent worktrees".into(), "Title"), (String::new(), "Normal")];
    l.push((format!("{glyph} lightweight worktrees  copy-on-write: agents share unchanged files"), group));
    let tag = if h.ready {
        "OK "
    } else if h.installed {
        "WARNING "
    } else {
        ""
    };
    l.push((format!("    {tag}{}", h.detail), if h.ready { "NormalFloat" } else { group }));
    for b in &h.blockers {
        for (n, line) in wrap_words(b, 74).into_iter().enumerate() {
            l.push((format!("    {}{line}", if n == 0 { "- " } else { "  " }), "WarningMsg"));
        }
    }
    if let Some(next) = &h.next {
        l.push((format!("    try: {next}"), "Comment"));
    }
    if !h.installed {
        l.push((format!("    install: {}", worktree::RIFTRI_INSTALL), "Comment"));
    }
    if let Some((views, logical, allocated)) = h.views {
        let saved = logical.saturating_sub(allocated);
        let saves = if saved > 0 { format!(" (saves {})", worktree::format_bytes(saved)) } else { String::new() };
        l.push((
            format!("    {views} worktree{}: {} of files in {} on disk{saves}", if views == 1 { "" } else { "s" }, worktree::format_bytes(logical), worktree::format_bytes(allocated)),
            "NormalFloat",
        ));
    }
    l
}

/// A y/n question, like vim's confirm prompts.
pub struct Confirm {
    pub question: String,
    pub on_yes: Box<dyn FnOnce(&mut App)>,
}

/// How to start an agent (:new's flags, templates).
#[derive(Default, Clone, Debug)]
pub struct NewAgent {
    /// false: in your checkout, no worktree (:new!)
    pub worktree: Option<bool>,
    pub model: Option<String>,
    pub engine: Option<String>,
    pub effort: Option<String>,
}

/// `p` relative to where vigent runs, unless that climbs out twice (src/app.ts shortPath).
pub fn short_path(cwd: &Path, p: &Path) -> String {
    let (a, b): (Vec<_>, Vec<_>) = (cwd.components().collect(), p.components().collect());
    let same = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let ups = a.len() - same;
    let mut rel = PathBuf::new();
    for _ in 0..ups {
        rel.push("..");
    }
    for c in &b[same..] {
        rel.push(c.as_os_str());
    }
    let rel = rel.to_string_lossy().to_string();
    if rel.is_empty() || ups >= 2 { p.display().to_string() } else { rel }
}

/// The bytes for a notification: a bell, an OSC 9 desktop notification, both, or nothing (src/notify.ts).
pub fn alert_sequence(text: &str, mode: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    if mode == "off" {
        return String::new();
    }
    let desktop = mode == "desktop" || (mode == "auto" && shows_desktop_notifications(env));
    let mut out = if mode == "desktop" { String::new() } else { "\x07".into() };
    if desktop {
        // no control characters inside the notification text
        let clean: String = text.chars().map(|c| if (c as u32) < 0x20 || c as u32 == 0x7f { ' ' } else { c }).collect();
        let osc = format!("\x1b]9;{clean}\x07");
        // tmux swallows OSC 9 unless it's wrapped in a passthrough
        if env("TMUX").is_some_and(|t| !t.is_empty()) {
            out += &format!("\x1bPtmux;{}\x1b\\", osc.replace('\x1b', "\x1b\x1b"));
        } else {
            out += &osc;
        }
    }
    out
}

/// Does this terminal turn OSC 9 into a desktop notification?
pub fn shows_desktop_notifications(env: &dyn Fn(&str) -> Option<String>) -> bool {
    let set = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    let program = env("TERM_PROGRAM").unwrap_or_default();
    let term = env("TERM").unwrap_or_default();
    ["iTerm.app", "WezTerm", "ghostty"].contains(&program.as_str())
        || set("KITTY_WINDOW_ID")
        || set("GHOSTTY_RESOURCES_DIR")
        || set("WEZTERM_PANE")
        || term.contains("kitty")
        || term.contains("ghostty")
}

fn real_env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

// ---------------------------------------------------------------------------
// hooks (src/hooks.ts)
// ---------------------------------------------------------------------------

/// What a hook did.
pub struct HookResult {
    pub ok: bool,
    /// exit code; None when it was stopped (timeout) or couldn't start
    pub code: Option<i32>,
    /// the end of what it printed, stdout and stderr together
    pub output: String,
    pub took: Duration,
    pub timed_out: bool,
}

/// Run a hook's command with a shell in `cwd`. Blocking: run it off the UI thread.
pub fn run_hook(command: &str, cwd: &Path, env: &[(String, String)], timeout: Duration) -> HookResult {
    let started = Instant::now();
    let (shell, flag) = if cfg!(windows) { ("cmd", "/C") } else { ("sh", "-c") };
    // stdout and stderr into one pipe, in the order they were written
    let spawned = (|| {
        let (reader, writer) = std::io::pipe()?;
        let mut cmd = Command::new(shell);
        cmd.arg(flag).arg(command).current_dir(cwd).envs(env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null()).stdout(writer.try_clone()?).stderr(writer);
        // its own process group, so a timeout stops what it started too
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let child = cmd.spawn()?;
        drop(cmd); // the pipe's write ends: only the hook holds them now
        Ok::<_, std::io::Error>((child, reader))
    })();
    let (mut child, mut reader) = match spawned {
        Ok(c) => c,
        Err(e) => return HookResult { ok: false, code: None, output: e.to_string(), took: Duration::ZERO, timed_out: false },
    };
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = std::io::Read::read_to_end(&mut reader, &mut buf);
        let _ = done_tx.send(buf);
    });
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                #[cfg(unix)]
                let _ = Command::new("kill").args(["-TERM", &format!("-{}", child.id())]).stderr(Stdio::null()).status();
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    // what it printed; something it started that's still running may hold the pipe open, so don't wait for long
    let bytes = done_rx.recv_timeout(Duration::from_secs(if timed_out { 1 } else { 5 })).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    let keep: String = text.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
    let code = if timed_out { None } else { status.and_then(|s| s.code()) };
    HookResult { ok: code == Some(0) && !timed_out, code, output: keep.trim_end().to_string(), took: started.elapsed(), timed_out }
}

/// "3.2s", "1m 05s"
pub fn took(d: Duration) -> String {
    let ms = d.as_millis();
    if ms < 60_000 {
        return format!("{:.1}s", ms as f64 / 1000.0);
    }
    let s = (ms as f64 / 1000.0).round() as u64;
    format!("{}m {:02}s", s / 60, s % 60)
}

/// The last non-empty line of a hook's output.
pub fn last_line(output: &str) -> String {
    output.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string()
}

// ---------------------------------------------------------------------------
// templates (src/templates.ts)
// ---------------------------------------------------------------------------

/// The built-in templates: (name, description, prompt). One in config.toml with the same name replaces it.
pub const BUILTIN_TEMPLATES: [(&str, &str, &str); 4] = [
    (
        "fix",
        "reproduce a bug with a failing test, then fix it",
        "Find and fix this bug: {task}\n\nFirst reproduce it with a failing test. Then make the smallest change that makes the test pass, and run the whole test suite before you finish.",
    ),
    (
        "test",
        "write tests in the project's own style",
        "Write tests for {task}. Cover the usual cases and the edge cases, follow the style of the tests already in the project, and run them. Don't change the code under test; if a test finds a bug, say so.",
    ),
    (
        "review",
        "review this branch's work; changes nothing",
        "Review the work on this branch: compare it with the branch it started from using git. Look for bugs, missing tests and code that's hard to follow.{task}\n\nList what you find by file and line, most serious first. Don't change any files.",
    ),
    (
        "explain",
        "how something works and where it lives; changes nothing",
        "Explain {task}: how it works, where it lives in the code, and what would break if it changed. Don't change any files.",
    ),
];

/// A template, and whether it's a built-in one.
pub type Tpl = (crate::config::Template, bool);

/// Built-ins first, then yours (yours replace a built-in of the same name), in config order.
pub fn all_templates(user: &[crate::config::Template]) -> Vec<Tpl> {
    let mut out: Vec<Tpl> = BUILTIN_TEMPLATES
        .iter()
        .map(|(name, description, prompt)| match user.iter().find(|t| t.name == *name) {
            Some(t) => (t.clone(), false),
            None => (crate::config::Template { name: name.to_string(), prompt: prompt.to_string(), description: Some(description.to_string()), ..Default::default() }, true),
        })
        .collect();
    out.extend(user.iter().filter(|t| !BUILTIN_TEMPLATES.iter().any(|b| b.0 == t.name)).map(|t| (t.clone(), false)));
    out
}

/// The prompt for a task: `{task}` takes it; a template without one gets it
/// added after. The built-in review's `{task}` is an optional focus.
pub fn fill_template(t: &Tpl, task: &str) -> String {
    let text = task.trim();
    if !t.0.prompt.contains("{task}") {
        return if text.is_empty() { t.0.prompt.clone() } else { format!("{}\n\n{text}", t.0.prompt) };
    }
    if t.0.name == "review" && t.1 {
        return t.0.prompt.replace("{task}", &if text.is_empty() { String::new() } else { format!(" Focus on: {text}.") });
    }
    t.0.prompt.replace("{task}", text)
}

const WORKTREE_CREATED_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const AGENT_FINISHED_TIMEOUT: Duration = Duration::from_secs(60);

impl App {
    // -----------------------------------------------------------------
    // starting agents
    // -----------------------------------------------------------------

    /// The engine `:new` uses when it isn't given one is "auto" (Engines area: --engine, :engine).
    fn engine_is_auto(&self) -> bool {
        self.config.engine.as_deref().is_none_or(|e| e == "auto")
    }

    /// "no engine is signed in: run claude auth login or codex login · :checkhealth" (src/app.ts noEngineReady)
    pub fn no_engine_ready(&self) -> String {
        let logins: Vec<String> = self.engines.infos.iter().filter(|e| e.id != "pi" && e.installed).filter_map(|e| e.connect.clone()).collect();
        let pi = self.engines.get("pi").and_then(|e| e.connect.clone());
        let mut ways = vec![];
        if !logins.is_empty() {
            ways.push(format!("run {}", logins.join(" or ")));
        }
        if let Some(p) = pi {
            ways.push(format!("for pi {p}"));
        }
        let ways = ways.join(", or ");
        format!("no engine is signed in{} · :checkhealth", if ways.is_empty() { String::new() } else { format!(": {ways}") })
    }

    /// The model and effort new agents of an engine start with ([engines.<id>] model / effort).
    fn new_agent_settings(&self, engine: &str) -> (Option<String>, Option<String>) {
        let o = self.config.engine_options(engine);
        (o.and_then(|o| o.model.clone()), o.and_then(|o| o.effort.clone()))
    }

    /// A new agent, in a worktree of its own made in the background (src/app.ts startAgent).
    /// Its slot, or None (and why, on the message line).
    pub fn start_agent(&mut self, name: &str, o: NewAgent) -> Option<usize> {
        let engine = o.engine.clone().unwrap_or_else(|| self.new_agent_engine().to_string());
        if !self.config.is_engine_id(&engine) {
            self.say(format!("unknown engine '{engine}': pi, claude, codex or opencode"), "ErrorMsg");
            return None;
        }
        if let Some(info) = self.engines.get(&engine) {
            if !info.installed {
                let msg = format!("{} isn't installed: {} · :checkhealth", info.name, info.install);
                self.say(msg, "ErrorMsg");
                return None;
            }
            // auto lands on an engine that isn't ready only when none is; an agent started there could never answer
            if o.engine.is_none() && self.engine_is_auto() && !info.connected && !info.checking {
                let msg = self.no_engine_ready();
                self.say(msg, "ErrorMsg");
                return None;
            }
        }
        let with_worktree = o.worktree != Some(false) && self.config.worktree.enabled;
        let (model, effort) = {
            let (m, e) = self.new_agent_settings(&engine);
            (o.model.clone().or(m), o.effort.clone().or(e))
        };
        let index = self.sessions.len();
        let mut s = Session::new(index, name, &engine, self.cwd.clone());
        if engine != "pi" {
            s.requested_model = model.clone();
            s.model = model.clone();
        }
        s.effort = effort.clone().filter(|e| e != "default");
        let by = if engine != "pi" { format!(" · {}", engines::engine_name(&engine)) } else { String::new() };
        let root = self.root.clone().filter(|_| with_worktree);
        match root {
            Some(root) => {
                let cfg = self.config.worktree.clone();
                let p = match worktree::plan(&root, name, &cfg) {
                    Ok(p) => p,
                    Err(e) => {
                        self.say(e, "ErrorMsg");
                        return None;
                    }
                };
                s.branch = Some(p.branch.clone());
                s.path = p.path.clone();
                s.base = p.base.clone();
                s.hold("making worktree");
                let making = format!("'{name}'{by} on {} · making its worktree…", p.branch);
                self.say(making.clone(), "Comment");
                self.agents.making.push((index, making));
                let tx = self.tx.clone();
                std::thread::spawn(move || {
                    let r = worktree::make(&root, &p, &cfg);
                    let _ = tx.send(Msg::WorktreeMade(index, r));
                });
            }
            None => {
                let why = if with_worktree && self.config.worktree.enabled { " (not a git repo, so no worktree)" } else { "" };
                self.say(format!("'{name}'{by} in this checkout{why}"), "ModeMsg");
            }
        }
        Some(self.add_session(s, true))
    }

    /// `:new -t <template> [task]`: an agent on the template's engine, model
    /// and effort, sent the template's prompt. Flags you type (--engine,
    /// --model) win over the template's (src/app.ts startFromTemplate).
    pub fn start_from_template(&mut self, name: &str, task: &str, o: NewAgent) -> Option<usize> {
        let all = all_templates(&self.config.templates);
        let Some(t) = all.iter().find(|t| t.0.name == name).cloned() else {
            let names: Vec<&str> = all.iter().map(|t| t.0.name.as_str()).collect();
            let msg = format!("no template '{name}'{} · :templates lists them", crate::keys::did_you_mean(name, &names));
            self.say(msg, "ErrorMsg");
            return None;
        };
        let review = t.1 && t.0.name == "review";
        if t.0.prompt.contains("{task}") && task.is_empty() && !review {
            self.say(format!("template '{}' needs a task: :new -t {} <what>", t.0.name, t.0.name), "ErrorMsg");
            self.mode = crate::app::Mode::Command;
            self.cmd = format!("new -t {} ", t.0.name);
            return None;
        }
        let typed_engine = o.engine.clone();
        let engine = typed_engine.clone().or_else(|| t.0.engine.clone());
        let same = engine == t.0.engine || t.0.engine.is_none();
        let agent = if task.is_empty() { t.0.name.clone() } else { crate::names::agent_name_from(task) };
        let i = self.start_agent(
            &agent,
            NewAgent {
                worktree: o.worktree.or(t.0.worktree),
                model: o.model.or_else(|| if same { t.0.model.clone() } else { None }),
                engine,
                effort: if typed_engine.is_none() || typed_engine == t.0.engine { t.0.effort.clone() } else { None },
            },
        )?;
        let prompt = fill_template(&t, task);
        if let crate::session::Submitted::Now(p) = self.sessions[i].submit(prompt) {
            self.send(i, p);
        }
        let (msg, group) = (format!("{} · template {}", self.message.0, t.0.name), self.message.1);
        self.say(msg, group);
        Some(i)
    }

    /// `:templates` with no name: what there is to start from (Windows area: a picker that starts one).
    pub fn list_templates(&mut self) {
        let lines = all_templates(&self.config.templates)
            .iter()
            .map(|(t, builtin)| {
                let how: Vec<String> = [t.engine.as_deref().map(engines::engine_name), t.model.clone(), t.effort.clone()].into_iter().flatten().collect();
                let what = t.description.clone().unwrap_or_else(|| t.prompt.lines().next().unwrap_or("").to_string());
                let how = if how.is_empty() { String::new() } else { format!(" ({})", how.join(" · ")) };
                (format!("{:<10} {what}{how}{}", t.name, if *builtin { "" } else { " · yours" }), "NormalFloat")
            })
            .collect();
        self.float = Some(Float::new("Start an agent from a template", lines));
    }

    /// Put an agent in the list (focused or not): its slot.
    pub fn add_session(&mut self, mut s: Session, focus: bool) -> usize {
        let i = self.sessions.len();
        s.slot = i;
        s.seen = s.state;
        self.sessions.push(s);
        if focus {
            if self.focused().is_some() {
                self.agents.alt = self.focus;
            }
            self.focus = i;
            self.scroll = 0;
        }
        self.refresh_stat(i); // reopened agents show their changes right away
        i
    }

    /// Its worktree is there (or couldn't be made): save its record, then its prompts go.
    pub fn worktree_made(&mut self, i: usize, r: Result<Made, String>) {
        let making = self.agents.making.iter().position(|(j, _)| *j == i).map(|k| self.agents.making.remove(k).1);
        let Some(a) = self.sessions.get_mut(i) else { return };
        if a.closed {
            // killed while it was being made: nothing ran in it yet, so it goes too
            if let (Ok(_), Some(root)) = (&r, self.root.clone()) {
                let (path, branch, base) = (a.path.clone(), a.branch.clone(), a.base.clone());
                worktree::remove(&root, &path, branch.as_deref(), Some(&base), true);
            }
            return self.race_worktree_settled(i);
        }
        match r {
            Ok(made) => {
                a.created_at = records::iso_now();
                let meta = AgentMeta {
                    name: a.name.clone(),
                    model: if a.engine == "pi" { a.model.clone().unwrap_or_default() } else { a.requested_model.clone().unwrap_or_default() },
                    base: Some(a.base.clone()),
                    created_at: a.created_at.clone(),
                    engine: (a.engine != "pi").then(|| a.engine.clone()),
                    requested_model: a.requested_model.clone(),
                    effort: a.effort.clone(),
                    ..Default::default()
                };
                let _ = records::save(&a.path, &meta);
                let by = if a.engine != "pi" { format!(" · {}", engines::engine_name(&a.engine)) } else { String::new() };
                let how = match &made {
                    Made::Riftri(_) => " · lightweight copy",
                    Made::Git(_) => " · full copy (:checkhealth says why)",
                    Made::Plain => "",
                };
                let from = if a.base.is_empty() { String::new() } else { format!(" (from {})", a.base) };
                let text = format!("'{}'{by} on {} in {}{from}{how}", a.name, a.branch.as_deref().unwrap_or(""), short_path(&self.cwd, &a.path));
                let group = if matches!(made, Made::Git(_)) { "WarningMsg" } else { "ModeMsg" };
                let riftri = matches!(made, Made::Riftri(_));
                if let Made::Riftri(b) = &made {
                    a.riftri = Some(b.clone());
                }
                a.made = Some(made);
                if making.is_some_and(|m| m == self.message.0) {
                    self.say(text, group);
                }
                if riftri {
                    self.refresh_storage();
                }
                self.refresh_stat(i);
                // worktree_created holds it again until the hook has run; without one, its prompts go now
                if self.config.hooks.worktree_created.is_some() {
                    self.set_up_worktree(i);
                } else {
                    self.sessions[i].release();
                    self.drain(i);
                }
            }
            Err(e) => {
                let name = a.name.clone();
                self.forget_agent(i);
                self.say(format!("'{name}' couldn't start: {e}"), "ErrorMsg");
            }
        }
        self.race_worktree_settled(i);
    }

    /// Recount what riftri's worktrees cost (and whether it can make them here), in the background.
    pub fn refresh_storage(&self) {
        if !self.config.worktree.enabled {
            return;
        }
        let (root, cfg, tx) = (self.root.clone(), self.config.worktree.clone(), self.tx.clone());
        std::thread::spawn(move || {
            let h = worktree::riftri_health(root.as_deref(), &cfg);
            let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| app.agents.storage = Some(h))));
        });
    }

    /// Take an agent out (it couldn't start, or was killed): stop it and close its slot.
    pub fn forget_agent(&mut self, i: usize) {
        let open = self.open();
        let at = open.iter().position(|&j| j == i);
        let a = &mut self.sessions[i];
        a.abort();
        a.kill_child();
        a.closed = true;
        a.queue.clear();
        a.unread = false;
        if i == self.focus {
            let open = self.open();
            // as src/app.ts does: the next agent takes its place, or the last one
            self.focus = at.and_then(|p| open.get(p).or(open.last())).copied().unwrap_or(self.sessions.len());
            self.scroll = 0;
        }
    }

    /// worktree_created: set the new worktree up (npm ci, ...) before the agent's first prompt goes out.
    fn set_up_worktree(&mut self, i: usize) {
        let Some(cmd) = self.config.hooks.worktree_created.clone() else { return };
        let env = self.hook_env(i, "worktree_created", &[]);
        let a = &mut self.sessions[i];
        a.hold("setting up");
        a.items.push(Item::Info(format!("setting up the worktree: {cmd}")));
        let (cwd, tx) = (a.path.clone(), self.tx.clone());
        std::thread::spawn(move || {
            let r = run_hook(&cmd, &cwd, &env, WORKTREE_CREATED_TIMEOUT);
            let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| {
                let a = &mut app.sessions[i];
                if r.ok {
                    a.items.push(Item::Info(format!("worktree ready ({})", took(r.took))));
                } else {
                    let what = if r.timed_out { "timed out".to_string() } else { format!("failed (exit {})", r.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())) };
                    let out = if r.output.is_empty() { String::new() } else { format!("\n{}", r.output) };
                    a.items.push(Item::Info(format!("worktree_created {what} after {}; the agent starts anyway{out}", took(r.took))));
                    let last = last_line(&r.output);
                    let why = if last.is_empty() { format!("exit {}", r.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())) } else { last };
                    let msg = format!("'{}': worktree_created failed: {why}", a.name);
                    app.say(msg, "WarningMsg");
                }
                app.sessions[i].release();
                app.drain(i);
            })));
        });
    }

    /// The environment hooks see (src/app.ts hookEnv).
    fn hook_env(&self, i: usize, hook: &str, extra: &[(&str, &str)]) -> Vec<(String, String)> {
        let a = &self.sessions[i];
        let works_in = self.works_in(i);
        let mut env = vec![
            ("VIGENT_HOOK".to_string(), hook.to_string()),
            ("VIGENT_AGENT".into(), a.name.clone()),
            ("VIGENT_ENGINE".into(), a.engine.clone()),
            ("VIGENT_BRANCH".into(), works_in.map(|w| w.0.clone()).unwrap_or_default()),
            ("VIGENT_WORKTREE".into(), works_in.map(|w| w.1.display().to_string()).unwrap_or_default()),
            ("VIGENT_REPO".into(), self.root.as_deref().map(|r| r.display().to_string()).unwrap_or_default()),
        ];
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        env
    }

    /// The worktree an agent works in: its own, or a fork's original's (branch, path).
    pub fn works_in(&self, i: usize) -> Option<(&String, &PathBuf)> {
        let mut a = self.sessions.get(i)?;
        let mut hops = 0;
        while let Some(o) = a.fork_of {
            a = self.sessions.get(o)?;
            hops += 1;
            if hops > 64 {
                return None;
            }
        }
        a.branch.as_ref().map(|b| (b, &a.path))
    }

    /// agent_finished: tell your scripts an agent stopped (in the background; only a failure is shown).
    fn agent_finished_hook(&mut self, i: usize) {
        let Some(cmd) = self.config.hooks.agent_finished.clone() else { return };
        let state = match self.sessions[i].state {
            State::Error => "failed",
            State::Waiting => "needs-you",
            _ => "finished",
        };
        let env = self.hook_env(i, "agent_finished", &[("VIGENT_STATE", state)]);
        let cwd = self.works_in(i).map(|w| w.1.clone()).or_else(|| self.root.clone()).unwrap_or_else(|| self.cwd.clone());
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let r = run_hook(&cmd, &cwd, &env, AGENT_FINISHED_TIMEOUT);
            if r.ok {
                return;
            }
            let last = last_line(&r.output);
            let why = if !last.is_empty() {
                last
            } else if r.timed_out {
                "timed out".into()
            } else {
                format!("exit {}", r.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()))
            };
            let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| app.say(format!("agent_finished hook failed: {why}"), "WarningMsg"))));
        });
    }

    // -----------------------------------------------------------------
    // records
    // -----------------------------------------------------------------

    /// Save an agent's settings and totals, so they survive a restart (src/cli.ts app.persist).
    pub fn persist(&self, i: usize) {
        let a = &self.sessions[i];
        if !a.own_worktree() || a.made.is_none() {
            return;
        }
        let cli = a.engine != "pi";
        let (model, requested, usage) = if cli {
            (a.requested_model.clone().unwrap_or_default(), a.requested_model.clone(), Some((a.tokens, a.cost)))
        } else {
            (a.model.clone().unwrap_or_default(), None, None)
        };
        let effort = a.effort.clone();
        records::update(&a.path, |m| {
            m.model = model;
            if cli {
                m.requested_model = requested;
                m.usage = usage;
            }
            m.effort = effort;
        });
    }

    /// The CLI reported its conversation's id: saved at once, so a restart continues it.
    fn save_resume_id(&self, i: usize) {
        let a = &self.sessions[i];
        if !a.own_worktree() || a.made.is_none() {
            return;
        }
        let id = a.resume_id.clone();
        records::update(&a.path, |m| m.resume_id = id);
    }

    /// An engine's events for an agent: into its transcript, and its record when its conversation id changed.
    pub fn on_engine(&mut self, i: usize, evs: Vec<engines::Ev>) {
        let focused = i == self.focus;
        let Some(a) = self.sessions.get_mut(i) else { return };
        let before = a.resume_id.clone();
        a.apply(evs, focused);
        let changed = a.resume_id != before;
        let done = a.done_seen;
        if changed {
            self.save_resume_id(i);
        }
        if done {
            self.refresh_stat(i);
        }
    }

    // -----------------------------------------------------------------
    // reopening
    // -----------------------------------------------------------------

    /// Saved on pi (agents from before vigent recorded engines are too), and pi isn't here.
    fn stranded(&self, meta: &AgentMeta) -> bool {
        let on_pi = match meta.engine.as_deref() {
            None | Some("pi") => true,
            Some(e) => !self.config.is_engine_id(e),
        };
        on_pi && !engines::on_path("pi")
    }

    /// A pi agent can never answer without pi: the record that moves it to the engine you do have, if there is one.
    fn moved_off_pi(&self, meta: &AgentMeta) -> Option<AgentMeta> {
        let engine = self.new_agent_engine();
        if !self.stranded(meta) || engine == "pi" || !self.engines.get(engine).is_some_and(|e| e.installed) {
            return None;
        }
        // pi's model and thinking level mean nothing to another engine
        Some(AgentMeta {
            engine: Some(engine.to_string()),
            model: String::new(),
            requested_model: self.new_agent_settings(engine).0,
            effort: None,
            resume_id: None,
            detached: false,
            ..meta.clone()
        })
    }

    /// An agent from its record, with the engine it was started on (or, without pi, the one it moved to).
    pub fn reopen(&self, saved: &AgentMeta, branch: &str, path: &Path, backend: Option<String>) -> Session {
        let moved = self.moved_off_pi(saved);
        if let Some(m) = &moved {
            let _ = records::save(path, m);
        }
        let meta = moved.as_ref().unwrap_or(saved);
        let engine = meta.engine.clone().filter(|e| self.config.is_engine_id(e)).unwrap_or_else(|| "pi".into());
        let mut s = Session::new(0, &meta.name, &engine, path.to_path_buf());
        s.branch = Some(branch.to_string());
        s.base = meta.base.clone().unwrap_or_default();
        s.created_at = meta.created_at.clone();
        s.made = Some(match &backend {
            Some(b) => Made::Riftri(b.clone()),
            None => Made::Plain,
        });
        s.riftri = backend;
        s.effort = meta.effort.clone();
        if engine != "pi" {
            s.requested_model = meta.requested_model.clone();
            s.model = meta.requested_model.clone();
            s.resume_id = meta.resume_id.clone();
            // the CLI keeps the conversation; vigent keeps the running totals
            if let Some((tokens, cost)) = meta.usage {
                s.tokens = tokens;
                s.cost = cost;
            }
            if let Some(id) = &meta.resume_id {
                let name = engines::engine_name(&engine);
                let short: String = id.chars().take(8).collect();
                s.items.push(Item::Info(format!("continuing the {name} conversation {short}… (earlier messages live in {name}'s history)")));
            }
        } else {
            s.model = Some(meta.model.clone()).filter(|m| !m.is_empty());
            if engines::adapter("pi").is_none() && !engines::on_path("pi") {
                // pi would fail to start: say so now, as the TypeScript vigent does when it starts pi
                s.items.push(Item::Info(format!("error: pi isn't installed: {PI_INSTALL}")));
                s.items.push(Item::Info(PI_MISSING_HINT.into()));
            }
        }
        s
    }

    /// At startup: reopen the agents that were open when vigent last quit
    /// (riftri views are repaired first). Warnings go in `warnings`.
    pub fn restore(&mut self, warnings: &mut Vec<String>) {
        let Some(root) = self.root.clone() else { return };
        if !self.config.worktree.enabled {
            return;
        }
        self.refresh_storage();
        let r = records::reopenable(&root, &self.config.worktree);
        for (path, why) in &r.blocked {
            warnings.push(format!("couldn't reopen the agent in {}: {why}", path.display()));
        }
        // a stranded agent moves for good, so wait to learn which engine is signed in
        if r.agents.iter().any(|a| self.stranded(&a.meta)) {
            self.engines.infos = engines::detect_all();
        }
        for a in &r.agents {
            let s = self.reopen(&a.meta, &a.branch, &a.path, a.backend.clone());
            self.add_session(s, false);
        }
        let n = self.open().len();
        if n > 0 {
            self.focus = self.open()[0];
            self.say(format!("reopened {n} agent{} from last time", if n == 1 { "" } else { "s" }), "Comment");
        }
    }

    // -----------------------------------------------------------------
    // switching
    // -----------------------------------------------------------------

    /// Focus an agent by slot: it's read now (◆ goes), and the one before is <C-^>'s.
    pub fn focus_slot(&mut self, i: usize) {
        if i == self.focus || self.sessions.get(i).is_none_or(|s| s.closed) {
            return;
        }
        if self.focused().is_some() {
            self.agents.alt = self.focus;
        }
        self.focus = i;
        self.scroll = 0;
        self.sessions[i].unread = false;
        self.refresh_stat(i);
    }

    /// Focus reporting: the terminal window gained or lost focus.
    pub fn focus_changed(&mut self, focused: bool) {
        self.agents.terminal_focused = focused;
        if focused && let Some(i) = self.focused().map(|s| s.slot) {
            self.sessions[i].unread = false;
        }
    }

    // -----------------------------------------------------------------
    // watching: notifications, records, hooks
    // -----------------------------------------------------------------

    /// Shown on screen (Windows area: in any window of a split).
    pub fn on_screen(&self, i: usize) -> bool {
        i == self.focus
    }

    /// Every frame: agents that stopped running. If you're not looking, say so
    /// (bell, desktop notification, ◆); save their totals; run agent_finished.
    pub fn watch_states(&mut self) {
        for i in 0..self.sessions.len() {
            let (before, now) = (self.sessions[i].seen, self.sessions[i].state);
            if before == now || self.sessions[i].closed {
                self.sessions[i].seen = now;
                continue;
            }
            self.sessions[i].seen = now;
            if before == State::Running {
                // its usage totals, for after a restart
                self.persist(i);
                if matches!(now, State::Idle | State::Error | State::Waiting) {
                    self.agent_finished_hook(i);
                }
                if now != State::Paused {
                    self.notify_stopped(i);
                }
            }
            self.watch_race(i);
        }
        // an agent that's free again takes its next queued prompt (stopped with <C-c>, say)
        for i in self.open() {
            let a = &self.sessions[i];
            if matches!(a.state, State::Idle | State::Waiting) && !a.queue.is_empty() && a.child.is_none() {
                self.drain(i);
            }
        }
        if self.agents.last_stat.is_none_or(|t| t.elapsed() >= STAT_EVERY) {
            self.agents.last_stat = Some(Instant::now());
            for i in self.open() {
                self.refresh_stat(i);
            }
        }
    }

    fn notify_stopped(&mut self, i: usize) {
        let visible = self.on_screen(i) && self.agents.terminal_focused;
        if visible {
            return;
        }
        let a = &mut self.sessions[i];
        a.unread = true;
        let what = match a.state {
            State::Error => "failed",
            State::Waiting => "needs you",
            _ => "finished",
        };
        let (name, error) = (a.name.clone(), a.state == State::Error);
        if !self.on_screen(i) {
            let n = self.open().iter().position(|&j| j == i).map(|p| p + 1).unwrap_or(0);
            let jump = if (1..=9).contains(&n) { format!("{}{n} or ", self.keymap.leader) } else { String::new() };
            self.say(format!("'{name}' {what} · {jump}]s to open it"), if error { "ErrorMsg" } else { "ModeMsg" });
        }
        let bytes = alert_sequence(&format!("vigent: '{name}' {what}"), &self.config.ui.notify, &real_env);
        self.alert(bytes);
    }

    /// Write a notification to the terminal (or keep it, in tests).
    pub fn alert(&mut self, bytes: String) {
        match self.agents.alerts.as_mut() {
            Some(v) => v.push(bytes),
            None if !bytes.is_empty() => {
                let mut out = std::io::stdout();
                let _ = out.write_all(bytes.as_bytes());
                let _ = out.flush();
            }
            None => {}
        }
    }

    // -----------------------------------------------------------------
    // :kill, :attach, :worktrees
    // -----------------------------------------------------------------

    /// `:kill` stops the agent and keeps its worktree; `:kill!` also removes it (git's safe remove).
    pub fn kill_focused(&mut self, remove: bool) {
        let Some(i) = self.focused().map(|s| s.slot) else { return };
        let setting_up = self.agents.making.iter().any(|(j, _)| *j == i);
        let (name, own, branch, path, base) = {
            let a = &self.sessions[i];
            (a.name.clone(), a.own_worktree(), a.branch.clone(), a.path.clone(), a.base.clone())
        };
        self.forget_agent(i);
        let root = self.root.clone();
        let (Some(root), true, Some(branch)) = (root, own, branch) else {
            return self.say(format!("killed '{name}'"), "WarningMsg");
        };
        if setting_up {
            return self.say(format!("killed '{name}' · its worktree is removed as soon as it's made"), "WarningMsg");
        }
        if !remove {
            records::set_detached(&path, true); // not reopened at the next start; :attach brings it back
            return self.say(format!("killed '{name}' · kept {branch} (:attach {branch} reopens it, :worktree remove deletes it)"), "WarningMsg");
        }
        let r = worktree::remove(&root, &path, Some(&branch), Some(&base).filter(|b| !b.is_empty()).map(|b| b.as_str()), false);
        if r.removed {
            self.refresh_storage();
        }
        self.say(format!("killed '{name}' · {}", r.message), if r.removed { "WarningMsg" } else { "ErrorMsg" });
    }

    /// `:attach <branch>` reopens an agent in one of the worktrees :worktrees lists.
    pub fn attach(&mut self, arg: &str) {
        let Some(root) = self.root.clone() else { return self.say("not in a git repository", "ErrorMsg") };
        if arg.is_empty() {
            return self.say("usage: :attach <branch>  (see :worktrees)", "Comment");
        }
        let Some(w) = worktree::find(&root, arg, &self.config.worktree).filter(|w| w.branch.is_some()) else {
            return self.say(format!("no worktree '{arg}' (see :worktrees)"), "ErrorMsg");
        };
        let branch = w.branch.clone().unwrap_or_default();
        if let Some(owner) = self.open().into_iter().find(|&i| self.sessions[i].own_worktree() && self.sessions[i].path == w.path) {
            return self.focus_slot(owner);
        }
        let meta = records::load(&w.path).unwrap_or_else(|| AgentMeta {
            name: branch.rsplit('/').next().unwrap_or(&branch).replace('-', " "),
            model: self.config.model.clone().unwrap_or_else(|| "claude-sonnet-4-5".into()),
            created_at: records::iso_now(),
            ..Default::default()
        });
        let view = worktree::prepare_views(&root, std::slice::from_ref(&w.path)).remove(&w.path).unwrap_or_default();
        if !view.ready {
            return self.say(format!("can't reopen {branch}: {}", view.reason.unwrap_or_default()), "ErrorMsg");
        }
        let _ = records::save(&w.path, &AgentMeta { detached: false, ..meta.clone() }); // reopened at the next start again
        let s = self.reopen(&meta, &branch, &w.path, view.backend);
        let name = s.name.clone();
        self.add_session(s, true);
        self.say(format!("attached '{name}' to {branch}"), "ModeMsg");
    }

    /// `:worktrees` lists them; `:worktree remove[!] <branch>` deletes one.
    pub fn worktrees(&mut self, arg: &str) {
        let Some(root) = self.root.clone() else { return self.say("not in a git repository", "ErrorMsg") };
        let cfg = self.config.worktree.clone();
        let words: Vec<&str> = arg.split_whitespace().collect();
        if let [verb, target] = words[..]
            && matches!(verb, "remove" | "rm" | "remove!" | "rm!")
        {
            let Some(w) = worktree::find(&root, target, &cfg) else {
                return self.say(format!("no worktree '{target}' (see :worktrees)"), "ErrorMsg");
            };
            let shown = w.branch.clone().unwrap_or_else(|| w.path.display().to_string());
            if let Some(owner) = self.open().into_iter().find(|&i| self.sessions[i].own_worktree() && self.sessions[i].path == w.path) {
                let msg = format!("'{}' is working in {shown}; stop it first (:kill or :kill!)", self.sessions[owner].name);
                return self.say(msg, "ErrorMsg");
            }
            let base = records::load(&w.path).and_then(|m| m.base);
            let r = worktree::remove(&root, &w.path, w.branch.as_deref(), base.as_deref(), verb.ends_with('!'));
            if r.removed {
                self.refresh_storage();
            }
            return self.say(r.message, if r.removed { "WarningMsg" } else { "ErrorMsg" });
        }
        if !arg.is_empty() {
            return self.say("usage: :worktrees  |  :worktree remove[!] <branch>", "Comment");
        }
        let all = match worktree::list(&root, &cfg) {
            Ok(a) => a,
            Err(e) => return self.say(e, "ErrorMsg"),
        };
        if all.is_empty() {
            return self.say("no agent worktrees yet (:new <task> creates one)", "Comment");
        }
        let paths: Vec<PathBuf> = all.iter().map(|w| w.path.clone()).collect();
        let backends = worktree::riftri_backends(&root, &paths);
        let mut lines: Vec<(String, &'static str)> = vec![];
        for w in &all {
            let owner = self.open().into_iter().find(|&i| self.sessions[i].own_worktree() && self.sessions[i].path == w.path);
            let owner_name = owner.map(|i| self.sessions[i].name.clone()).unwrap_or_default();
            let branch = w.branch.clone().unwrap_or_else(|| format!("(detached {})", w.head));
            let storage = if backends.is_empty() {
                String::new()
            } else {
                format!("{:<16} ", backends.get(&w.path).map(|b| worktree::backend_name(b)).unwrap_or_else(|| "full copy".into()))
            };
            let who = crate::ui::text::fit(&owner_name, 20);
            let line = format!("{}{branch:<30} {who:<20} {storage}{}", if owner.is_some() { "● " } else { "  " }, short_path(&self.cwd, &w.path));
            lines.push((line, if owner.is_some() { "String" } else { "NormalFloat" }));
        }
        if let Some(st) = &self.agents.storage
            && let Some((_, logical, allocated)) = st.views
        {
            lines.push((String::new(), "Normal"));
            let b = worktree::backend_name(st.backend.as_deref().unwrap_or("unknown"));
            lines.push((format!("worktrees: {} of files in {} on disk ({b})", worktree::format_bytes(logical), worktree::format_bytes(allocated)), "Comment"));
        }
        lines.push((String::new(), "Normal"));
        lines.push(("● = an agent is working in it · :attach <branch> reopens one · :worktree remove <branch> deletes it".into(), "Comment"));
        self.float = Some(Float::new("Worktrees", lines));
    }

    // -----------------------------------------------------------------
    // the queue, pause, resume
    // -----------------------------------------------------------------

    /// `:queue <prompt>` sends it after the current run; `:queue` lists what's waiting.
    pub fn queue_cmd(&mut self, text: &str) {
        let Some(i) = self.focused().map(|s| s.slot) else { return self.say("no agent (:new <task> starts one)", "ErrorMsg") };
        let text = text.trim();
        if text.is_empty() {
            let a = &self.sessions[i];
            if a.queue.is_empty() {
                let msg = format!("nothing queued for '{}'", a.name);
                return self.say(msg, "Comment");
            }
            let lines = a.queue.iter().enumerate().map(|(n, q)| (format!("{:>2} {q}", n + 1), "NormalFloat")).collect();
            self.float = Some(Float::new(&format!("Queued for {}", a.name), lines));
            return;
        }
        let name = self.sessions[i].name.clone();
        match self.sessions[i].submit(text.to_string()) {
            crate::session::Submitted::Now(t) => {
                self.send(i, t);
                self.say(format!("sent to '{name}'"), "Comment");
            }
            crate::session::Submitted::Queued(n) => self.say(format!("queued for '{name}' ({n} waiting)"), "Comment"),
        }
    }

    /// `:pause`: stop the current run and hold what's queued.
    pub fn pause_focused(&mut self) {
        let Some(i) = self.focused().map(|s| s.slot) else { return };
        let a = &mut self.sessions[i];
        a.pause();
        let queued = if a.queue.is_empty() { String::new() } else { format!(" ({} queued)", a.queue.len()) };
        let msg = format!("paused '{}'{queued} · :resume to continue", a.name);
        self.say(msg, "WarningMsg");
    }

    /// `:resume`: the next queued prompt, or ask it to carry on.
    pub fn resume_focused(&mut self) {
        let Some(i) = self.focused().map(|s| s.slot) else { return };
        let a = &mut self.sessions[i];
        if a.state != State::Paused {
            let msg = format!("'{}' isn't paused", a.name);
            return self.say(msg, "Comment");
        }
        if let Some(next) = a.resume() {
            self.send(i, next);
        }
        self.say("", "Comment");
    }

    // -----------------------------------------------------------------
    // forks (a split on the same agent)
    // -----------------------------------------------------------------

    /// A split's new agent: a copy of the conversation that goes its own way
    /// (src/cli.ts forkSession). It runs in the same folder, because the
    /// conversation's paths point there, and holds no worktree of its own, so
    /// :kill! and :merge can't reach the original's. The Windows area adds it
    /// with add_session once the window is split.
    pub fn fork_session(&self, parent: usize) -> Result<Session, String> {
        let p = self.sessions.get(parent).ok_or("no agent to split (:new <task> starts one)")?;
        let base = format!("{} (fork)", p.name);
        let taken = |n: &str| self.sessions.iter().any(|s| !s.closed && s.name == n);
        let mut name = base.clone();
        let mut n = 2;
        while taken(&name) {
            name = format!("{} {n})", &base[..base.len() - 1]);
            n += 1;
        }
        let ename = engines::engine_name(&p.engine);
        let can = engines::adapter(&p.engine).is_some_and(|a| a.can_fork());
        if !can {
            return Err(format!("{ename} can't fork a conversation yet. :vsplit <agent> shows another agent beside this one."));
        }
        // forked where the original is now: what it's told after the split stays out of the fork
        let at = p.fork_point();
        if p.engine == "claude" && p.resume_id.is_some() && at.is_none() {
            return Err(format!(
                "couldn't find where '{}''s Claude Code conversation is up to, so it can't be forked. :vsplit <agent> shows another agent beside this one.",
                p.name
            ));
        }
        let mut f = Session::new(0, &name, &p.engine, p.path.clone());
        f.fork_of = Some(parent);
        f.branch = p.branch.clone();
        f.base = p.base.clone();
        f.made = p.made.clone();
        f.stat = p.stat;
        f.requested_model = p.requested_model.clone();
        f.model = p.model.clone().or_else(|| p.requested_model.clone());
        f.effort = p.effort.clone();
        f.resume_id = p.resume_id.clone();
        f.forking = p.resume_id.is_some();
        f.fork_at = at;
        f.items = p.items.clone();
        Ok(f)
    }

    // -----------------------------------------------------------------
    // y/n questions
    // -----------------------------------------------------------------

    /// Ask a y/n question on the message line; `y` runs `on_yes`, any other key is a no.
    pub fn ask(&mut self, question: String, on_yes: Box<dyn FnOnce(&mut App)>) {
        self.seq.reset();
        self.say(question.clone(), "Question");
        self.agents.confirm = Some(Confirm { question, on_yes });
    }

    /// The key that answers the question. True when there was one.
    pub fn answer(&mut self, k: &crossterm::event::KeyEvent) -> bool {
        let Some(c) = self.agents.confirm.take() else { return false };
        self.say("", "Comment");
        if matches!(k.code, crossterm::event::KeyCode::Char('y' | 'Y')) {
            (c.on_yes)(self);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::engines::Ev;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn the_bytes_a_bell_osc_9_and_tmux() {
        assert_eq!(alert_sequence("done", "bell", &env(&[])), "\x07");
        assert_eq!(alert_sequence("done", "auto", &env(&[("TERM_PROGRAM", "Apple_Terminal")])), "\x07");
        assert_eq!(alert_sequence("done", "auto", &env(&[("TERM_PROGRAM", "iTerm.app")])), "\x07\x1b]9;done\x07");
        assert_eq!(alert_sequence("done", "desktop", &env(&[])), "\x1b]9;done\x07");
        assert_eq!(alert_sequence("done", "off", &env(&[("TERM_PROGRAM", "ghostty")])), "");
        assert_eq!(alert_sequence("a\x1b]evil\x07b", "desktop", &env(&[])), "\x1b]9;a ]evil b\x07");
        assert_eq!(alert_sequence("done", "desktop", &env(&[("TMUX", "/tmp/tmux-0/default,1,0")])), "\x1bPtmux;\x1b\x1b]9;done\x07\x1b\\");
        assert!(shows_desktop_notifications(&env(&[("TERM", "xterm-kitty")])));
        assert!(!shows_desktop_notifications(&env(&[("TERM", "xterm-256color")])));
    }

    fn two() -> App {
        let mut a = app();
        a.agents.alerts = Some(vec![]);
        a.config.ui.notify = "bell".into();
        a.add_session(Session::new(0, "fix the race", "claude", "/nope".into()), true);
        a.add_session(Session::new(0, "add retries", "claude", "/nope".into()), false);
        a
    }

    #[test]
    fn an_agent_you_arent_looking_at_finishes() {
        let mut a = two();
        a.sessions[1].state = State::Running;
        a.watch_states();
        assert_eq!(a.agents.alerts.as_deref(), Some(&[][..]), "starting isn't news");
        a.on_engine(1, vec![Ev::Done { ok: true, error: None }]);
        a.watch_states();
        assert_eq!(a.agents.alerts.as_deref(), Some(&["\x07".to_string()][..]));
        assert!(a.sessions[1].unread);
        assert_eq!(a.message.0, "'add retries' finished · <Space>2 or ]s to open it");
        a.focus_agent(1);
        assert!(!a.sessions[1].unread);
        assert_eq!(a.agents.alt, 0);
    }

    #[test]
    fn failed_says_so_and_pausing_doesnt_notify() {
        let mut a = two();
        a.sessions[1].state = State::Running;
        a.watch_states();
        a.sessions[1].state = State::Error;
        a.watch_states();
        assert!(a.message.0.starts_with("'add retries' failed"));
        a.sessions[1].state = State::Running;
        a.watch_states();
        a.sessions[1].pause();
        a.watch_states();
        assert_eq!(a.agents.alerts.as_ref().unwrap().len(), 1, "you paused it: no news");
    }

    #[test]
    fn the_agent_on_screen_notifies_only_when_the_window_isnt_focused() {
        let mut a = two();
        a.sessions[0].state = State::Running;
        a.watch_states();
        a.sessions[0].state = State::Idle;
        a.watch_states();
        assert!(a.agents.alerts.as_ref().unwrap().is_empty(), "you watched it finish");
        a.focus_changed(false);
        a.sessions[0].state = State::Running;
        a.watch_states();
        a.sessions[0].state = State::Idle;
        a.watch_states();
        assert_eq!(a.agents.alerts.as_ref().unwrap().len(), 1);
        assert!(a.sessions[0].unread);
        a.focus_changed(true);
        assert!(!a.sessions[0].unread, "seeing it counts as reading it");
    }

    #[test]
    fn queue_pause_resume() {
        let mut a = two();
        crate::commands::exec(&mut a, "queue");
        assert_eq!(a.message.0, "nothing queued for 'fix the race'");
        a.sessions[0].state = State::Running;
        crate::commands::exec(&mut a, "queue then the docs");
        assert_eq!(a.message.0, "queued for 'fix the race' (1 waiting)");
        crate::commands::exec(&mut a, "pause");
        assert_eq!(a.message.0, "paused 'fix the race' (1 queued) · :resume to continue");
        crate::commands::exec(&mut a, "queue");
        assert_eq!(a.float.as_ref().map(|f| f.title.as_str()), Some("Queued for fix the race"));
        a.float = None;
        a.sessions[1].state = State::Idle;
        a.focus_agent(1);
        crate::commands::exec(&mut a, "resume");
        assert_eq!(a.message.0, "'add retries' isn't paused");
    }

    #[test]
    fn kill_closes_and_forks_are_named_apart() {
        let mut a = two();
        a.sessions[0].resume_id = Some("abc".into());
        a.sessions[0].last_message = Some("m-1".into());
        let f = a.fork_session(0).unwrap();
        assert_eq!(f.name, "fix the race (fork)");
        assert!(f.forking && f.fork_at.as_deref() == Some("m-1"));
        let i = a.add_session(f, true);
        assert!(!a.sessions[i].own_worktree());
        let g = a.fork_session(0).unwrap();
        assert_eq!(g.name, "fix the race (fork 2)");
        crate::commands::exec(&mut a, "kill");
        assert_eq!(a.message.0, "killed 'fix the race (fork)'");
        assert_eq!(a.open().len(), 2);
        // Claude Code without a point to fork at
        a.sessions[1].resume_id = Some("zzz".into());
        a.sessions[1].path = "/nowhere".into();
        assert!(a.fork_session(1).err().unwrap().contains("can't be forked"));
    }

    #[test]
    fn dd_asks_first() {
        let mut a = two();
        crate::actions::run(&mut a, "session.kill", None);
        assert_eq!(a.message.0, "Kill 'fix the race'? [y/N]");
        a.key(crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Char('n'), crossterm::event::KeyModifiers::NONE));
        assert_eq!(a.open().len(), 2);
        crate::actions::run(&mut a, "session.kill", None);
        a.key(crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Char('y'), crossterm::event::KeyModifiers::NONE));
        assert_eq!(a.open().len(), 1);
    }

    #[test]
    fn templates_fill_their_task_and_yours_replace_the_built_in_ones() {
        let mine = crate::config::Template { name: "fix".into(), prompt: "Fix: {task}!".into(), ..Default::default() };
        let extra = crate::config::Template { name: "docs".into(), prompt: "Write docs".into(), ..Default::default() };
        let all = all_templates(&[mine, extra]);
        let names: Vec<&str> = all.iter().map(|t| t.0.name.as_str()).collect();
        assert_eq!(names, ["fix", "test", "review", "explain", "docs"]);
        assert_eq!(fill_template(&all[0], " the cart "), "Fix: the cart!");
        assert!(fill_template(&all[2], "").contains("hard to follow.\n\nList"));
        assert!(fill_template(&all[2], "auth").contains("hard to follow. Focus on: auth.\n\nList"));
        assert_eq!(fill_template(&all[4], "the cli"), "Write docs\n\nthe cli");
        let mut a = app();
        crate::commands::exec(&mut a, "new -t fixx");
        assert_eq!(a.message.0, "no template 'fixx' (did you mean 'fix'?) · :templates lists them");
        crate::commands::exec(&mut a, "new -t fix");
        assert_eq!(a.message.0, "template 'fix' needs a task: :new -t fix <what>");
        assert_eq!(a.cmd, "new -t fix ");
    }

    /// A git repository in a temp folder, and an App in it whose messages the test reads.
    fn repo_app(name: &str) -> (App, std::sync::mpsc::Receiver<Msg>, PathBuf) {
        let base = std::env::temp_dir().join(format!("vigent-agents-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("shop");
        std::fs::create_dir_all(&repo).unwrap();
        let g = |args: &[&str]| {
            let ok = Command::new("git").args(args).current_dir(&repo).env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@e.com").env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@e.com").output().unwrap();
            assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
        };
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.js"), "1\n").unwrap();
        g(&["add", "a.js"]);
        g(&["commit", "-qm", "init"]);
        let mut config = crate::config::Config::default();
        config.worktree.backend = "git".into();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut a = App::new("0.0.0", repo.clone(), "default", config, crate::keys::Keymap::default(), tx);
        for e in &mut a.engines.infos {
            e.checking = false;
            if e.id == "claude" {
                (e.installed, e.connected) = (true, true);
            }
        }
        a.agents.alerts = Some(vec![]);
        (a, rx, base)
    }

    /// Handle what the threads send until `done` says so.
    fn pump(a: &mut App, rx: &std::sync::mpsc::Receiver<Msg>, done: impl Fn(&App) -> bool) {
        let until = Instant::now() + Duration::from_secs(20);
        while !done(a) {
            assert!(Instant::now() < until, "timed out: {}", a.message.0);
            if let Ok(m) = rx.recv_timeout(Duration::from_millis(50)) {
                a.on_msg(m);
            }
        }
    }

    #[test]
    fn an_agent_is_saved_killed_attached_and_reopened() {
        let (mut a, rx, base) = repo_app("life");
        crate::commands::exec(&mut a, "new perf cache warmup");
        assert_eq!(a.message.0, "'perf cache warmup' · Claude Code on perf/cache-warmup · making its worktree…");
        pump(&mut a, &rx, |a| a.sessions[0].made.is_some());
        let path = a.sessions[0].path.clone();
        assert_eq!(a.message.0, "'perf cache warmup' · Claude Code on perf/cache-warmup in ../shop-worktrees/perf-cache-warmup (from main)");
        let meta = records::load(&path).unwrap();
        assert_eq!((meta.name.as_str(), meta.engine.as_deref(), meta.base.as_deref()), ("perf cache warmup", Some("claude"), Some("main")));
        assert!(meta.created_at.ends_with('Z') && meta.created_at.len() == 24);
        // the conversation id is saved as soon as the CLI says it, the totals when a run ends
        a.sessions[0].state = State::Running;
        a.watch_states();
        a.on_engine(0, vec![Ev::Session("s-1".into()), Ev::Usage { tokens: 1200, cost: Some(0.5) }, Ev::Done { ok: true, error: None }]);
        a.watch_states();
        let meta = records::load(&path).unwrap();
        assert_eq!((meta.resume_id.as_deref(), meta.usage), (Some("s-1"), Some((1200, Some(0.5)))));

        crate::commands::exec(&mut a, "kill");
        assert_eq!(a.message.0, "killed 'perf cache warmup' · kept perf/cache-warmup (:attach perf/cache-warmup reopens it, :worktree remove deletes it)");
        assert!(records::load(&path).unwrap().detached);
        let root = a.root.clone().unwrap();
        assert!(records::restorable(&root, &a.config.worktree).is_empty());
        crate::commands::exec(&mut a, "worktree remove perf/cache-warmup");
        assert!(a.message.0.starts_with("removed ") || a.message.0.contains("has uncommitted"), "{}", a.message.0);
        // the record is gone with the worktree when it's removed; this one was, so make another
        crate::commands::exec(&mut a, "new docs readme");
        pump(&mut a, &rx, |a| a.sessions.last().unwrap().made.is_some());
        crate::commands::exec(&mut a, "kill");
        crate::commands::exec(&mut a, "attach docs/readme");
        assert_eq!(a.message.0, "attached 'docs readme' to docs/readme");
        assert!(!records::load(&a.focused().unwrap().path).unwrap().detached);
        let n = a.open().len();
        crate::commands::exec(&mut a, "attach docs/readme");
        assert_eq!(a.open().len(), n, "already open: just focus it");
        crate::commands::exec(&mut a, "attach nope");
        assert_eq!(a.message.0, "no worktree 'nope' (see :worktrees)");
        crate::commands::exec(&mut a, "worktree remove docs/readme");
        assert_eq!(a.message.0, "'docs readme' is working in docs/readme; stop it first (:kill or :kill!)");

        // a restart: the agent is back, and says which conversation it continues
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut b = App::new("0.0.0", root.clone(), "default", a.config.clone(), crate::keys::Keymap::default(), tx);
        let mut warnings = vec![];
        b.restore(&mut warnings);
        assert_eq!(b.message.0, "reopened 1 agent from last time");
        assert_eq!(b.sessions[0].name, "docs readme");
        crate::commands::exec(&mut b, "kill!");
        assert!(b.message.0.starts_with("killed 'docs readme' · removed "), "{}", b.message.0);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn paths_and_durations() {
        assert_eq!(short_path(Path::new("/w/shop"), Path::new("/w/shop-worktrees/feat-x")), "../shop-worktrees/feat-x");
        assert_eq!(short_path(Path::new("/w/shop/src/deep"), Path::new("/w/shop-worktrees/feat-x")), "/w/shop-worktrees/feat-x");
        assert_eq!(took(Duration::from_millis(3200)), "3.2s");
        assert_eq!(took(Duration::from_secs(65)), "1m 05s");
        assert_eq!(last_line("a\n b \n\n"), "b");
    }

    #[test]
    fn hooks_run_with_a_shell_and_their_output_is_kept() {
        let r = run_hook("echo one; echo two >&2; exit 3", Path::new("/"), &[("X".into(), "y".into())], Duration::from_secs(10));
        assert!(!r.ok);
        assert_eq!(r.code, Some(3));
        assert_eq!(r.output, "one\ntwo");
        let r = run_hook("echo $X", Path::new("/"), &[("X".into(), "y".into())], Duration::from_secs(10));
        assert!(r.ok && r.output == "y");
        let r = run_hook("sleep 5", Path::new("/"), &[], Duration::from_millis(100));
        assert!(r.timed_out && r.code.is_none());
    }
}
