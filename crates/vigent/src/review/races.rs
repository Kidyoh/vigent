//! `:race` on the App: start racers, watch them finish, show them, keep one
//! (execRace, startRace, watchRace, openRace, pickRacer in src/app.ts).
//!
//! Racers are ordinary agents (App::start_agent), each in its own worktree;
//! every racer gets the prompt once the last worktree is ready, so their times
//! compare like for like ([`tick`]).

use super::float::{FLine, TextFloat};
use super::hooks::took;
use super::race::{Race, Racer, did_you_mean, parse_race_args, racer_labels, resolve_race_models};
use super::{now, plain_preview, screen, state_glyph, state_group, state_name};
use crate::app::{App, Msg};
use crate::commands::Ex;
use crate::config::Template;
use crate::session::{Item, State, Submitted};
use crate::ui::text::{fit, pad};

/// The built-in templates (src/templates.ts BUILTIN_TEMPLATES).
fn builtin_templates() -> Vec<Template> {
    let t = |name: &str, description: &str, prompt: &str| Template { name: name.into(), description: Some(description.into()), prompt: prompt.into(), ..Default::default() };
    vec![
        t(
            "fix",
            "reproduce a bug with a failing test, then fix it",
            "Find and fix this bug: {task}\n\nFirst reproduce it with a failing test. Then make the smallest change that makes the test pass, and run the whole test suite before you finish.",
        ),
        t(
            "test",
            "write tests in the project's own style",
            "Write tests for {task}. Cover the usual cases and the edge cases, follow the style of the tests already in the project, and run them. Don't change the code under test; if a test finds a bug, say so.",
        ),
        t(
            "review",
            "review this branch's work; changes nothing",
            "Review the work on this branch: compare it with the branch it started from using git. Look for bugs, missing tests and code that's hard to follow.{task}\n\nList what you find by file and line, most serious first. Don't change any files.",
        ),
        t("explain", "how something works and where it lives; changes nothing", "Explain {task}: how it works, where it lives in the code, and what would break if it changed. Don't change any files."),
    ]
}

/// Built-ins first, then yours (yours replace a built-in of the same name): (template, it's built in).
fn all_templates(app: &App) -> Vec<(Template, bool)> {
    let user = &app.config.templates;
    let mut out: Vec<(Template, bool)> = builtin_templates()
        .into_iter()
        .map(|b| match user.iter().find(|u| u.name == b.name) {
            Some(u) => (u.clone(), false),
            None => (b, true),
        })
        .collect();
    for u in user {
        if !out.iter().any(|(t, _)| t.name == u.name) {
            out.push((u.clone(), false));
        }
    }
    out
}

/// The prompt for a task (fillTemplate).
fn fill_template(t: &Template, builtin: bool, task: &str) -> String {
    let text = task.trim();
    if !t.prompt.contains("{task}") {
        return if text.is_empty() { t.prompt.clone() } else { format!("{}\n\n{text}", t.prompt) };
    }
    if t.name == "review" && builtin {
        return t.prompt.replacen("{task}", &if text.is_empty() { String::new() } else { format!(" Focus on: {text}.") }, 1);
    }
    t.prompt.replace("{task}", text)
}

/// The race an agent is in, without the racers you've killed since (the last race for None).
fn race_of(app: &mut App, slot: Option<usize>) -> Option<usize> {
    let closed: Vec<bool> = app.sessions.iter().map(|s| s.closed).collect();
    for r in &mut app.review.races {
        r.racers.retain(|&s| !closed.get(s).copied().unwrap_or(true));
    }
    app.review.races.retain(|r| !r.racers.is_empty());
    match slot {
        Some(s) => app.review.races.iter().position(|r| r.racers.contains(&s)),
        None => app.review.races.len().checked_sub(1),
    }
}

/// `:race` shows the race, `:race pick` keeps the focused racer, `:race <task>` starts one; `:race! pick` doesn't ask.
pub fn exec(app: &mut App, ex: &Ex) {
    let arg = ex.arg;
    if ex.bang {
        return if arg == "pick" { pick(app, true) } else { app.say("only  :race! pick  takes a !", "ErrorMsg") };
    }
    if arg.is_empty() {
        return open_race(app);
    }
    if arg == "pick" {
        return pick(app, false);
    }
    let parsed = parse_race_args(arg);
    if let Some(e) = parsed.error {
        return app.say(e, "ErrorMsg");
    }
    let mut prompt = parsed.task.clone();
    if let Some(name) = &parsed.template {
        let all = all_templates(app);
        let Some((t, builtin)) = all.iter().find(|(t, _)| &t.name == name) else {
            let hint = did_you_mean(name, all.iter().map(|(t, _)| t.name.as_str()));
            return app.say(format!("no template '{name}'{hint} · :templates lists them"), "ErrorMsg");
        };
        if t.prompt.contains("{task}") && parsed.task.is_empty() {
            return app.say(format!("template '{}' needs a task: :race <what> -t {}", t.name, t.name), "ErrorMsg");
        }
        prompt = fill_template(t, *builtin, &parsed.task);
    }
    if prompt.is_empty() {
        return app.say("usage: :race <task> [--engines claude,codex] [--models claude-opus-5-5,gpt-5.5]  ·  :race shows it  ·  :race pick keeps one", "Comment");
    }
    let task = if !parsed.task.is_empty() { parsed.task.clone() } else { parsed.template.clone().unwrap_or_else(|| "race".into()) };
    let Some(models) = parsed.models else {
        start(app, &task, &prompt, parsed.racers);
        return;
    };
    // which engine runs a model comes from the engines' own lists, which take a moment the first time
    let asked = parsed.racers.unwrap_or_default();
    with_model_index(app, move |app, index| {
        let infos = app.engines.infos.clone();
        let r = resolve_race_models(&models, &index, |engine| {
            let info = infos.iter().find(|e| e.id == engine)?;
            if info.connected || info.checking {
                return None;
            }
            Some(format!("{}, which isn't {}", info.name, if info.installed { "signed in" } else { "installed" }))
        });
        match r {
            Err(e) => app.say(e, "ErrorMsg"),
            Ok(more) => {
                let mut all = asked;
                all.extend(more);
                start(app, &task, &prompt, Some(all));
            }
        }
    });
}

/// Claude Code's model aliases (src/choices.ts CLAUDE_MODELS), which `--models` takes too.
const CLAUDE_ALIASES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];

/// Each engine's model ids, loaded once off the UI thread, then `then`.
fn with_model_index(app: &mut App, then: impl FnOnce(&mut App, Vec<(String, Vec<String>)>) + Send + 'static) {
    if let Some(index) = app.review.models.clone() {
        return then(app, index);
    }
    let installed: Vec<(String, bool)> = app.engines.infos.iter().map(|e| (e.id.clone(), e.installed || e.checking)).collect();
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        let index: Vec<(String, Vec<String>)> = crate::engines::KNOWN
            .iter()
            .map(|s| {
                // an engine that isn't installed can't list its models; Claude Code's and Gemini CLI's lists are fixed
                let skip = installed.iter().any(|(id, ok)| id == s.id && !ok) && s.id != "claude" && s.id != "gemini";
                let mut list: Vec<String> = if skip {
                    vec![]
                } else {
                    crate::engines::adapter(s.id).map(|a| a.models().into_iter().map(|c| c.id).filter(|v| v != "default").collect()).unwrap_or_default()
                };
                if s.id == "claude" {
                    list.extend(CLAUDE_ALIASES.iter().map(|a| a.to_string()));
                }
                (s.id.to_string(), list)
            })
            .collect();
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| {
            app.review.models = Some(index.clone());
            then(app, index);
        })));
    });
}

/// What Tab offers after `:race … --models`: exact ids from the engines that are signed in, never aliases.
pub fn completion_models(app: &App) -> Vec<String> {
    let Some(index) = &app.review.models else { return vec![] };
    let mut out: Vec<String> = vec![];
    for (id, list) in index {
        if !app.engines.get(id).is_some_and(|e| e.connected) {
            continue;
        }
        for m in list {
            if !(id == "claude" && CLAUDE_ALIASES.contains(&m.as_str())) && !out.contains(m) {
                out.push(m.clone());
            }
        }
    }
    out
}

/// What Tab completes in `:race … --engines` / `--models` (for the Windows area's completion).
pub fn complete(app: &App, arg: &str) -> Option<(String, Vec<String>)> {
    let engines: Vec<String> = app.engines.infos.iter().filter(|e| e.connected).map(|e| e.id.clone()).collect();
    super::race::complete_race_arg(arg, &engines, &completion_models(app))
}

/// Why nothing can race: no engine is signed in (noEngineReady).
fn no_engine_ready(app: &App) -> String {
    let logins: Vec<String> = app.engines.infos.iter().filter(|e| e.id != "pi" && e.installed).filter_map(|e| e.connect.clone()).collect();
    let pi = app.engines.get("pi").and_then(|e| e.connect.clone());
    let ways: Vec<String> = [if logins.is_empty() { String::new() } else { format!("run {}", logins.join(" or ")) }, pi.map(|p| format!("for pi {p}")).unwrap_or_default()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let ways = ways.join(", or ");
    format!("no engine is signed in{} · :checkhealth", if ways.is_empty() { String::new() } else { format!(": {ways}") })
}

/// Start one agent per racer on the same prompt, each in its own worktree. Returns the race's index.
pub fn start(app: &mut App, task: &str, prompt: &str, asked: Option<Vec<Racer>>) -> Option<usize> {
    let racers: Vec<Racer> = asked.unwrap_or_else(|| app.engines.infos.iter().filter(|e| e.connected).map(|e| Racer::new(&e.id, None)).collect());
    if racers.len() < 2 {
        let msg = match racers.first() {
            Some(r) => {
                let e = &r.engine;
                format!("only {} is signed in: race it against itself with --engines {e},{e}, or connect another (:checkhealth)", crate::engines::engine_name(e))
            }
            None => no_engine_ready(app),
        };
        app.say(msg, "ErrorMsg");
        return None;
    }
    for r in &racers {
        if !app.config.is_engine_id(&r.engine) {
            let mut ids: Vec<&str> = crate::engines::KNOWN.iter().map(|s| s.id).collect();
            ids.extend(app.config.custom_engines.iter().map(|e| e.id.as_str()));
            let hint = did_you_mean(&r.engine, ids);
            app.say(format!("unknown engine '{}'{hint} · :checkhealth lists them", r.engine), "ErrorMsg");
            return None;
        }
    }
    // racers sharing a folder would overwrite each other's work, so each needs its own worktree
    if app.root.is_none() || !app.config.worktree.enabled {
        let why = if app.root.is_some() { "worktrees are off here ([worktree] enabled = false in your config)" } else { "this folder isn't a git repo" };
        app.say(format!("a race needs a worktree for each racer, and {why}"), "ErrorMsg");
        return None;
    }
    let labels = racer_labels(&racers);
    let base = crate::names::agent_name_from(task);
    let mut race = Race { id: app.review.next_race, task: task.into(), prompt: prompt.into(), started_at: now(app), ..Default::default() };
    app.review.next_race += 1;
    let mut failed: Vec<String> = vec![];
    for (r, label) in racers.iter().zip(&labels) {
        if let Some(info) = app.engines.get(&r.engine).filter(|e| !e.installed && !e.checking) {
            failed.push(format!("{label}: {} isn't installed: {} · :checkhealth", info.name, info.install));
            continue;
        }
        // a model id like anthropic/claude-opus-5-5 keeps its slash in the race, not in the agent's name and branch
        let name = format!("{base} {}", label.replace('/', " "));
        let Some(slot) = app.start_agent(&name) else {
            failed.push(format!("{label}: {}", app.message.0));
            continue;
        };
        let s = &mut app.sessions[slot];
        s.engine = r.engine.clone();
        if r.model.is_some() {
            s.requested_model = r.model.clone();
        }
        if s.branch.is_none() {
            s.closed = true;
            failed.push(format!("{label}: it got no worktree of its own"));
            continue;
        }
        race.labels.insert(slot, label.clone());
        race.racers.push(slot);
    }
    if race.racers.is_empty() {
        if !failed.is_empty() {
            app.say(format!("not started: {}", failed.join(" · ")), "ErrorMsg");
        }
        return None;
    }
    let first = race.racers[0];
    let names: Vec<String> = race.racers.iter().map(|s| race.label(*s)).collect();
    app.review.races.push(race);
    app.focus = first;
    app.scroll = 0;
    let names = names.join(", ");
    if app.review.races.last().unwrap().racers.len() < 2 {
        app.say(format!("only {names} could start, so it runs alone · {}", failed.join(" · ")), "WarningMsg");
    } else {
        let not = if failed.is_empty() { String::new() } else { format!(" · not started: {}", failed.join(" · ")) };
        app.say(format!("race: {names} on '{base}'{not} · :race compares them"), if failed.is_empty() { "ModeMsg" } else { "WarningMsg" });
    }
    tick(app);
    Some(app.review.races.len() - 1)
}

/// Every frame: racers whose worktree couldn't be made leave their race; a race
/// whose worktrees are all ready sends every racer the prompt.
pub fn tick(app: &mut App) {
    for ri in 0..app.review.races.len() {
        if app.review.races[ri].started {
            continue;
        }
        // an agent whose worktree can't be made is taken out, and the race goes on without it
        let racers = app.review.races[ri].racers.clone();
        for slot in racers {
            let s = &app.sessions[slot];
            if s.closed || !(s.branch.is_some() && s.made.is_none() && !s.held() && s.state == State::Error) {
                continue;
            }
            let why = s
                .items
                .iter()
                .rev()
                .find_map(|i| match i {
                    Item::Error(e) => Some(e.strip_prefix("couldn't make its worktree: ").unwrap_or(e).to_string()),
                    _ => None,
                })
                .unwrap_or_default();
            let name = s.name.clone();
            app.sessions[slot].closed = true;
            app.review.races[ri].racers.retain(|&x| x != slot);
            if app.focus == slot {
                app.focus = app.review.races[ri].racers.first().copied().unwrap_or(app.sessions.len());
            }
            app.say(format!("'{name}' couldn't start: {why}"), "ErrorMsg");
        }
        let race = &app.review.races[ri];
        let ready = race.racers.iter().all(|&slot| {
            let s = &app.sessions[slot];
            s.closed || (!s.held() && (s.branch.is_none() || s.made.is_some()))
        });
        if race.racers.is_empty() || !ready {
            continue;
        }
        // every racer starts when the last worktree is made, so the times compare like for like
        let (prompt, racers) = (race.prompt.clone(), race.racers.clone());
        app.review.races[ri].started = true;
        app.review.races[ri].started_at = now(app);
        for slot in racers {
            if app.sessions[slot].closed {
                continue;
            }
            if let Submitted::Now(text) = app.sessions[slot].submit(prompt.clone()) {
                send(app, slot, text);
            }
        }
    }
    app.review.races.retain(|r| !r.racers.is_empty());
}

/// A prompt to a racer (tests record it instead of running a CLI).
fn send(app: &mut App, slot: usize, text: String) {
    #[cfg(test)]
    if let Some(log) = app.review.fake_send.as_mut() {
        log.push((slot, text.clone()));
        let s = &mut app.sessions[slot];
        s.items.push(Item::User(text));
        s.state = State::Running;
        return;
    }
    app.send(slot, text);
}

/// Ring the bell: a race ended while you looked elsewhere.
fn alert(app: &mut App) {
    app.review.alerts += 1;
    #[cfg(not(test))]
    {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(b"\x07");
        let _ = out.flush();
    }
}

/// A racer's state changed: note when it stopped, and say so once every racer has.
pub fn watch_racer(app: &mut App, slot: usize) {
    let st = app.sessions[slot].state;
    if app.review.races.is_empty() || st == State::Paused {
        return;
    }
    let t = now(app);
    let Some(ri) = app.review.races.iter().position(|r| r.racers.contains(&slot)) else { return };
    let race = &mut app.review.races[ri];
    if race.finished_at.contains_key(&slot) {
        return;
    }
    if st == State::Running {
        race.ran.insert(slot);
        return;
    }
    // a racer that hasn't started on its prompt yet hasn't finished; one that couldn't start has
    if !race.ran.contains(&slot) && st != State::Error {
        return;
    }
    race.finished_at.insert(slot, t);
    if race.announced || !race.over() {
        return;
    }
    race.announced = true;
    let race = race.clone();
    let results: Vec<String> = race
        .order()
        .iter()
        .map(|&x| {
            let s = &app.sessions[x];
            let (a, r) = s.stat;
            let changes = if s.state == State::Error {
                " failed".to_string()
            } else if a > 0 || r > 0 {
                format!(" +{a} −{r}")
            } else {
                String::new()
            };
            let at = race.finished_at.get(&x).copied().unwrap_or(race.started_at);
            format!("{} {}{changes}", race.label(x), took(at.saturating_sub(race.started_at)))
        })
        .collect();
    app.say(format!("race over: {} · :race compares them", results.join(" · ")), "ModeMsg");
    if race.racers.iter().any(|&x| x != app.focus) {
        alert(app);
    }
}

/// `:race`: the racers side by side, first to finish first; Enter opens one.
pub fn open_race(app: &mut App) {
    let focused = app.focused().map(|_| app.focus);
    let Some(ri) = race_of(app, focused).or_else(|| race_of(app, None)) else {
        return app.say("no race yet (:race <task> runs it on every engine you're signed in to)", "Comment");
    };
    let race = app.review.races[ri].clone();
    let t = now(app);
    let cell = |s: &str, w: usize| pad(&fit(s, w - 1), w);
    let mut lines: Vec<FLine> = vec![
        vec![("task  ".into(), "Comment"), (fit(&plain_preview(&race.task), 96), "NormalFloat")],
        vec![],
        vec![(format!("   {}{}{}{}usage", cell("racer", 26), cell("state", 10), cell("time", 10), cell("changes", 22)), "Comment")],
    ];
    let mut rows = vec![];
    let order = race.order();
    for (i, &slot) in order.iter().enumerate() {
        let s = &app.sessions[slot];
        let done = race.finished_at.get(&slot).copied();
        let (files, added, removed) = if s.made.is_some() && s.path.is_dir() { super::hunks::diff_stat(&s.path, &s.base) } else { (0, 0, s.stat.1) };
        let (added, removed) = if s.made.is_some() { (added, removed) } else { (s.stat.0, s.stat.1) };
        let changed = added > 0 || removed > 0 || files > 0;
        let g = state_group(s.state);
        let word = if done.is_none() && s.state != State::Running {
            "starting"
        } else if s.state == State::Idle {
            "done"
        } else {
            state_name(s.state)
        };
        let since = if race.started { done.unwrap_or(t).saturating_sub(race.started_at) } else { 0 };
        let last = s.items.iter().rev().find_map(|x| match x {
            Item::Text(t) => Some(t.as_str()),
            _ => None,
        });
        rows.push(lines.len());
        let mut line: FLine = vec![
            (format!("{} ", if done.is_none() { " ".to_string() } else { (i + 1).to_string() }), "LineNr"),
            (state_glyph(app, s.state).to_string(), g),
            (format!(" {}", cell(&race.label(slot), 25)), "Title"),
            (cell(word, 10), g),
            (cell(&took(since), 10), if done.is_none() { "Comment" } else { "NormalFloat" }),
        ];
        if changed {
            let head = format!("+{added} −{removed} ");
            line.push((format!("+{added} "), "Added"));
            line.push((format!("−{removed} "), "Removed"));
            line.push((cell(&plural(files, "file"), 1.max(22usize.saturating_sub(head.chars().count()))), "Comment"));
        } else {
            line.push((cell("no changes", 22), "Comment"));
        }
        line.push((if s.tokens > 0 { super::usage::of(s) } else { String::new() }, "Comment"));
        lines.push(line);
        let preview = last.map(|t| fit(&plain_preview(t), 96)).unwrap_or_else(|| "(no reply yet)".into());
        lines.push(vec![("     ".into(), "NormalFloat"), (preview, "Comment")]);
    }
    lines.push(vec![]);
    let running = race.racers.iter().filter(|s| !race.finished_at.contains_key(s)).count();
    let n = race.racers.len();
    lines.push(vec![
        (if running > 0 { format!("{running} of {n} still running · ") } else { format!("{n} racers, all done · ") }, "Comment"),
        ("j/k move · Enter open · then :diff, :review · ".into(), "Comment"),
        (":race pick".into(), "Special"),
        (" keeps the one you're on".into(), "Comment"),
    ]);
    let at = focused.and_then(|f| order.iter().position(|&s| s == f)).unwrap_or(0);
    let initial = rows.get(at).copied();
    let title = format!("Race · {}", fit(&crate::names::agent_name_from(&race.task), 40));
    let width = 112.min(screen().0.saturating_sub(4));
    super::open(app, TextFloat::new(title, lines, width).select_rows(rows, order, initial));
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// `:race pick`: keep the focused racer; the others go, with their worktrees and branches.
pub fn pick(app: &mut App, sure: bool) {
    let winner = app.focused().map(|_| app.focus);
    let ri = race_of(app, winner);
    let (Some(winner), Some(ri)) = (winner, ri) else {
        let msg = if race_of(app, None).is_some() {
            "this agent isn't in a race: open the racer to keep (:race lists them), then :race pick"
        } else {
            "no race to pick from (:race <task> starts one)"
        };
        return app.say(msg, "ErrorMsg");
    };
    let race_id = app.review.races[ri].id;
    let losers: Vec<usize> = app.review.races[ri].racers.iter().copied().filter(|&s| s != winner).collect();
    let name = app.sessions[winner].name.clone();
    if losers.is_empty() {
        app.review.races.retain(|r| r.id != race_id);
        return app.say(format!("'{name}' is the only racer left · :merge or :pr lands it"), "Comment");
    }
    let n = losers.len();
    let others = if n == 1 { "racer".to_string() } else { format!("{n} racers") };
    let drop = move |app: &mut App| {
        let mut kept: Vec<String> = vec![];
        for &slot in &losers {
            let s = &mut app.sessions[slot];
            s.abort();
            s.kill_child();
            s.closed = true;
            s.queue.clear();
            let (branch, path, made) = (s.branch.clone(), s.path.clone(), s.made.is_some());
            let (Some(root), Some(branch)) = (app.root.clone(), branch) else { continue };
            if !made {
                continue; // one still being made has nothing in it yet
            }
            // you said yes to losing their changes, so uncommitted work doesn't stop the removal
            match crate::worktree::remove(&root, &path, true) {
                Ok(_) => {
                    let _ = super::land::git(&["branch", "-D", &branch], &root);
                }
                Err(e) => kept.push(format!("{branch}: {e}")),
            }
        }
        app.review.races.retain(|r| r.id != race_id);
        app.focus = winner;
        app.scroll = 0;
        if kept.is_empty() {
            app.say(format!("kept '{name}' · removed the other {others} · :merge or :pr lands it"), "WarningMsg");
        } else {
            app.say(format!("kept '{name}' · couldn't remove {}", kept.join(" · ")), "ErrorMsg");
        }
    };
    if sure {
        return drop(app);
    }
    let question = format!("keep '{}' and remove the other {}, with their worktrees and changes? (y/n)", app.sessions[winner].name, if n == 1 { "racer".to_string() } else { format!("{n} racers") });
    super::ask(app, question, drop);
}


#[cfg(test)]
mod tests {
    use super::super::Win;
    use super::super::tests::{app, ex, press, settle};
    use crate::app::{App, Msg};
    use crate::review::land::tests::{Tmp, repo, sh};
    use crate::session::{Item, State};
    use std::fs;
    use std::sync::mpsc::Receiver;

    fn racing() -> (App, Receiver<Msg>, Tmp) {
        let t = Tmp::new("race");
        let r = repo(&t.0);
        let (mut a, rx) = app();
        a.root = Some(r);
        a.review.clock = Some(1_000);
        a.review.fake_send = Some(vec![]);
        (a, rx, t)
    }

    /// Wait for every racer's worktree, then look (the race starts).
    fn ready(a: &mut App, rx: &Receiver<Msg>) {
        settle(a, rx, |a| a.sessions.iter().all(|s| s.branch.is_none() || s.made.is_some() || s.state == State::Error));
        crate::review::watch(a);
    }

    /// Remove every worktree the test made (riftri's are mounts).
    fn cleanup(a: &mut App) {
        let root = a.root.clone().unwrap();
        for s in &a.sessions {
            if s.made.is_some() && s.path.exists() {
                let _ = crate::worktree::remove(&root, &s.path, true);
            }
        }
    }

    fn sent(a: &App) -> Vec<(usize, String)> {
        a.review.fake_send.clone().unwrap()
    }

    #[test]
    fn race_starts_an_agent_per_signed_in_engine_and_ends_with_a_ranking() {
        let (mut a, rx, _t) = racing();
        crate::review::watch(&mut a);
        ex(&mut a, "race fix the flaky checkout test");
        let names: Vec<(&str, &str)> = a.sessions.iter().map(|s| (s.name.as_str(), s.engine.as_str())).collect();
        assert_eq!(names, [("fix flaky checkout test claude", "claude"), ("fix flaky checkout test codex", "codex")], "only signed-in engines race");
        assert_eq!(a.message.0, "race: claude, codex on 'fix flaky checkout test' · :race compares them");
        assert_eq!(a.focus, 0, "you watch the first racer");
        assert!(sent(&a).is_empty(), "nobody starts before every worktree is made");

        a.review.clock = Some(5_000);
        ready(&mut a, &rx);
        assert_eq!(a.review.races[0].started_at, 5_000, "the clock starts when they do");
        assert_eq!(sent(&a), [(0, "fix the flaky checkout test".to_string()), (1, "fix the flaky checkout test".to_string())]);
        crate::review::watch(&mut a);
        a.review.clock = Some(5_000 + 41_200);
        a.sessions[1].items.push(Item::Text("Fixed it by awaiting the mock.".into()));
        a.sessions[1].state = State::Idle;
        crate::review::watch(&mut a);
        assert!(!a.message.0.contains("race over"), "claude still runs");
        a.review.clock = Some(5_000 + 65_000);
        a.sessions[0].state = State::Error;
        crate::review::watch(&mut a);
        assert_eq!(a.message.0, "race over: codex 41.2s · claude 1m 05s failed · :race compares them");
        assert_eq!(a.review.alerts, 1, "codex wasn't on screen");

        // :race shows them, first to finish first
        ex(&mut a, "race");
        let Some(Win::Text(f)) = a.review.win.as_mut() else { panic!("no window") };
        let text = f.render_plain(110).join("\n");
        assert!(text.contains("Race · fix flaky checkout test"), "{text}");
        assert!(text.contains("task  fix the flaky checkout test"));
        let rows: Vec<&str> = text.lines().filter(|l| (l.contains("codex") || l.contains("claude")) && !l.contains("task")).collect();
        assert!(rows[0].contains("1 ") && rows[0].contains("codex") && rows[0].contains("done") && rows[0].contains("41.2s") && rows[0].contains("no changes"), "{rows:?}");
        assert!(rows[1].contains("claude") && rows[1].contains("error"), "{rows:?}");
        assert!(text.contains("Fixed it by awaiting the mock."));
        assert!(text.contains("2 racers, all done"));
        assert!(text.contains(":race pick keeps the one you're on"));
        press(&mut a, "j\r");
        assert_eq!(a.focus, 0, "j moves to claude, Enter opens it");
        a.message.0.clear();
        a.sessions[0].state = State::Running;
        crate::review::watch(&mut a);
        a.sessions[0].state = State::Idle;
        crate::review::watch(&mut a);
        assert!(!a.message.0.contains("race over"), "a follow-up doesn't end the race again");
        cleanup(&mut a);
    }

    #[test]
    fn race_says_what_it_cant_do() {
        let (mut a, _rx, _t) = racing();
        for e in &mut a.engines.infos {
            if e.id == "codex" {
                e.connected = false;
            }
        }
        ex(&mut a, "race fix it");
        assert!(a.message.0.starts_with("only Claude Code is signed in") && a.message.0.contains("--engines claude,claude"), "{}", a.message.0);
        ex(&mut a, "race fix it --engines claude,codx");
        assert!(a.message.0.contains("unknown engine 'codx' (did you mean 'codex'?)"), "{}", a.message.0);
        ex(&mut a, "race fix it -t nope");
        assert!(a.message.0.contains("no template 'nope'"));
        ex(&mut a, "race --engines claude,codex");
        assert!(a.message.0.starts_with("usage: :race <task>"));
        ex(&mut a, "race");
        assert!(a.message.0.starts_with("no race yet"));
        ex(&mut a, "race pick");
        assert!(a.message.0.starts_with("no race to pick from"));
        ex(&mut a, "race! now");
        assert_eq!(a.message.0, "only  :race! pick  takes a !");
        assert!(a.sessions.is_empty());
        a.config.worktree.enabled = false;
        ex(&mut a, "race fix it --engines claude,claude");
        assert!(a.message.0.starts_with("a race needs a worktree for each racer, and worktrees are off here ([worktree] enabled = false"));
        a.root = None;
        ex(&mut a, "race fix it --engines claude,claude");
        assert!(a.message.0.ends_with("this folder isn't a git repo"));
        assert!(a.sessions.is_empty());
    }

    #[test]
    fn engines_with_models_the_same_twice_and_a_template() {
        let (mut a, rx, _t) = racing();
        ex(&mut a, "race the cart total is off by one --engines claude:opus,claude:sonnet,claude -t fix");
        let got: Vec<(&str, Option<&str>)> = a.sessions.iter().map(|s| (s.name.as_str(), s.requested_model.as_deref())).collect();
        assert_eq!(got, [("cart total is off by opus", Some("opus")), ("cart total is off by sonnet", Some("sonnet")), ("cart total is off by claude", None)]);
        ready(&mut a, &rx);
        let s = sent(&a);
        assert_eq!(s.len(), 3);
        assert!(s[0].1.contains("failing test") && s[0].1.contains("the cart total is off by one"), "{}", s[0].1);
        assert!(s.iter().all(|x| x.1 == s[0].1));
        cleanup(&mut a);
    }

    #[test]
    fn a_racer_whose_worktree_cant_be_made_leaves_the_race() {
        let (mut a, rx, _t) = racing();
        ex(&mut a, "race fix it");
        a.on_msg(Msg::WorktreeMade(1, Err("git worktree add failed: disk full".into())));
        crate::review::watch(&mut a);
        assert_eq!(a.open(), [0]);
        assert_eq!(a.message.0, "'fix it codex' couldn't start: git worktree add failed: disk full");
        assert_eq!(a.review.races[0].racers, [0]);
        settle(&mut a, &rx, |a| a.sessions.iter().all(|s| s.made.is_some()));
        crate::review::watch(&mut a);
        assert_eq!(sent(&a), [(0, "fix it".to_string())], "the race goes on without it");
        cleanup(&mut a);
    }

    #[test]
    fn pick_keeps_the_racer_youre_on_and_removes_the_rest_with_their_worktrees() {
        let (mut a, rx, _t) = racing();
        let root = a.root.clone().unwrap();
        ex(&mut a, "race fix it --engines claude,codex,claude");
        ready(&mut a, &rx);
        let (first, codex, second) = (a.sessions[0].path.clone(), a.sessions[1].path.clone(), a.sessions[2].path.clone());
        fs::write(codex.join("cart.js"), "codex's fix\n").unwrap();
        fs::write(first.join("cart.js"), "an uncommitted try\n").unwrap();
        crate::review::focus_slot(&mut a, 1);
        ex(&mut a, "race pick");
        assert_eq!(a.message.0, "keep 'fix it codex' and remove the other 2 racers, with their worktrees and changes? (y/n)");
        press(&mut a, "n");
        assert_eq!(a.open().len(), 3, "no: nothing changes");
        ex(&mut a, "race pick");
        press(&mut a, "y");
        assert_eq!(a.open(), [1]);
        assert_eq!(a.focus, 1);
        assert_eq!(a.message.0, "kept 'fix it codex' · removed the other 2 racers · :merge or :pr lands it");
        assert!(a.review.races.is_empty());
        assert!(!first.exists() && !second.exists(), "the losers' worktrees are gone");
        assert_eq!(fs::read_to_string(codex.join("cart.js")).unwrap(), "codex's fix\n", "the winner's work is untouched");
        let mut branches: Vec<String> = sh(&root, &["branch", "--format=%(refname:short)"]).lines().map(str::to_string).collect();
        branches.sort();
        assert_eq!(branches, ["fix/it-codex", "main"]);
        cleanup(&mut a);
    }

    #[test]
    fn pick_only_works_from_a_racer_and_a_killed_racer_leaves() {
        let (mut a, rx, _t) = racing();
        a.sessions.push(crate::session::Session::new(0, "bystander", "claude", "/x".into()));
        ex(&mut a, "race fix it");
        ready(&mut a, &rx);
        a.focus = 0;
        ex(&mut a, "race pick");
        assert!(a.message.0.contains("this agent isn't in a race"));
        a.sessions[2].closed = true; // :kill
        a.focus = 1;
        ex(&mut a, "race pick");
        assert_eq!(a.message.0, "'fix it claude' is the only racer left · :merge or :pr lands it");
        assert!(a.review.races.is_empty());
        cleanup(&mut a);
    }
}
