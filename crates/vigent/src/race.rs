//! `:race <task>`: the same task on several engines at once, each in its own
//! worktree, so you can compare what they did and keep the one you like
//! (src/race.ts, and App.execRace / startRace / watchRace / openRace /
//! pickRacer in src/app.ts). Races live on the Sessions area's state
//! (App::agents.races); a restart brings the racers back as plain agents.

use std::time::Instant;

use crate::agents::{NewAgent, alert_sequence, took};
use crate::app::App;
use crate::engines;
use crate::session::{Item, State};
use crate::ui::floats::Float;

/// One entrant: an engine, and a model for it when you asked for one (`claude:opus`).
#[derive(Clone, Debug, PartialEq)]
pub struct Racer {
    pub engine: String,
    pub model: Option<String>,
}

/// `:race`'s arguments.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RaceArgs {
    pub task: String,
    /// from `--engines`; with no `--models` either, every engine that's signed in races
    pub racers: Option<Vec<Racer>>,
    /// from `--models`: model ids, each racing on the engine whose list has it
    pub models: Option<Vec<String>>,
    pub template: Option<String>,
    pub error: Option<String>,
}

/// The value of the first of these flags (`--x v` or `--x=v`), and the words without it.
fn take_flag(words: &mut Vec<String>, names: &[&str]) -> Option<String> {
    for i in 0..words.len() {
        for n in names {
            if let Some(v) = words[i].strip_prefix(&format!("{n}=")) {
                let v = v.to_string();
                words.remove(i);
                return Some(v);
            }
            if words[i] == *n && i + 1 < words.len() {
                let v = words.remove(i + 1);
                words.remove(i);
                return Some(v);
            }
        }
    }
    None
}

/// `fix the flaky test --engines claude,codex:gpt-5.5 --models claude-opus-5-5 -t fix`.
/// An engine or a model can be there twice (`claude,claude`).
pub fn parse_race_args(arg: &str) -> RaceArgs {
    let mut words: Vec<String> = arg.split_whitespace().map(String::from).collect();
    let engines = take_flag(&mut words, &["--engines", "--engine", "-e"]);
    let models = take_flag(&mut words, &["--models", "--model", "-m"]);
    let template = take_flag(&mut words, &["--template", "-t"]);
    let mut out = RaceArgs { task: words.join(" "), template, ..Default::default() };
    if engines.is_none() && models.is_none() {
        return out;
    }
    let mut racers = vec![];
    for part in engines.as_deref().unwrap_or("").split(',').filter(|p| !p.is_empty()) {
        let (engine, model) = part.split_once(':').unwrap_or((part, ""));
        if engine.is_empty() {
            out.error = Some(format!("'{part}' names a model but no engine (write engine:model, or put it in --models)"));
            return out;
        }
        racers.push(Racer { engine: engine.into(), model: (!model.is_empty()).then(|| model.to_string()) });
    }
    let ids: Vec<String> = models.as_deref().unwrap_or("").split(',').filter(|m| !m.is_empty()).map(String::from).collect();
    if racers.len() + ids.len() < 2 {
        out.error = Some("a race needs at least two: --engines claude,codex or --models claude-opus-5-5,gpt-5.5 (the same one twice works too)".into());
        return out;
    }
    if engines.is_some() {
        out.racers = Some(racers);
    }
    if models.is_some() {
        out.models = Some(ids);
    }
    out
}

/// Engines that make their own models: a model one of them lists is theirs, even when an engine that routes to many lists it too.
const MAKERS: [&str; 4] = ["claude", "codex", "gemini", "cursor"];

/// `--models` ids to racers: each runs on the engine whose list has it
/// exactly; `engine:model` runs one on the engine you name. An id no list
/// has, one in more than one list, or one whose engine isn't signed in is
/// refused: a race never moves a model to another engine.
pub fn resolve_race_models(ids: &[String], known: &[(String, Vec<String>)], blocked: &dyn Fn(&str) -> Option<String>) -> Result<Vec<Racer>, String> {
    let mut racers = vec![];
    for id in ids {
        if let Some((e, m)) = id.split_once(':')
            && !e.is_empty()
            && known.iter().any(|(k, _)| k == e)
        {
            racers.push(Racer { engine: e.into(), model: Some(m.into()) });
            continue;
        }
        let mut owners: Vec<&str> = known.iter().filter(|(_, l)| l.contains(id)).map(|(e, _)| e.as_str()).collect();
        if owners.len() > 1 && owners.iter().any(|e| MAKERS.contains(e)) {
            owners.retain(|e| MAKERS.contains(e));
        }
        match owners[..] {
            [] => {
                let mut all: Vec<&str> = known.iter().flat_map(|(_, l)| l.iter().map(String::as_str)).collect();
                all.dedup();
                return Err(format!("no engine lists the model '{id}'{} · engine:model runs one that isn't listed", crate::keys::did_you_mean(id, &all)));
            }
            [on] => {
                if let Some(why) = blocked(on) {
                    return Err(format!("{id} runs on {why} · :checkhealth"));
                }
                racers.push(Racer { engine: on.into(), model: Some(id.clone()) });
            }
            _ => {
                let say: Vec<String> = owners.iter().map(|e| format!("{e}:{id}")).collect();
                return Err(format!("'{id}' runs on {}: say which, as {}", owners.join(" and "), say.join(" or ")));
            }
        }
    }
    Ok(racers)
}

/// What tells the racers apart: the model when it has one, else the engine, and a number when the same one runs twice.
pub fn racer_labels(racers: &[Racer]) -> Vec<String> {
    let plain: Vec<&str> = racers.iter().map(|r| r.model.as_deref().unwrap_or(&r.engine)).collect();
    let mut seen: Vec<(&str, usize)> = vec![];
    plain
        .iter()
        .map(|p| {
            if plain.iter().filter(|q| q == &p).count() < 2 {
                return p.to_string();
            }
            let n = match seen.iter_mut().find(|(q, _)| q == p) {
                Some(e) => {
                    e.1 += 1;
                    e.1
                }
                None => {
                    seen.push((p, 1));
                    1
                }
            };
            format!("{p} {n}")
        })
        .collect()
}

/// A race: its racers by slot, with their labels.
pub struct Race {
    pub task: String,
    pub started: Instant,
    pub racers: Vec<usize>,
    pub labels: Vec<(usize, String)>,
    /// the racers that have started on the task
    pub ran: Vec<usize>,
    /// when each racer first stopped running
    pub finished: Vec<(usize, Instant)>,
    /// you've been told that every racer is done
    pub announced: bool,
    /// racers whose worktrees are still being made: everyone starts when the last one is there
    pub waiting: Vec<usize>,
    /// the prompt every racer gets, until it's sent
    pub prompt: Option<String>,
}

impl Race {
    pub fn label(&self, i: usize) -> String {
        self.labels.iter().find(|(j, _)| *j == i).map(|(_, l)| l.clone()).unwrap_or_default()
    }
    fn finished_at(&self, i: usize) -> Option<Instant> {
        self.finished.iter().find(|(j, _)| *j == i).map(|(_, t)| *t)
    }
    /// Every racer has stopped at least once (finished, failed or needs you).
    pub fn over(&self) -> bool {
        !self.racers.is_empty() && self.racers.iter().all(|&i| self.finished_at(i).is_some())
    }
    /// The racers, first to finish first; the ones still running last, in the order they started.
    pub fn order(&self) -> Vec<usize> {
        let mut v = self.racers.clone();
        v.sort_by_key(|&i| self.finished_at(i).map(|t| (0, Some(t))).unwrap_or((1, None)));
        v
    }
}

impl App {
    /// The race an agent is in (without the racers you've killed since), or the last race.
    fn race_of(&mut self, slot: Option<usize>) -> Option<usize> {
        let open = self.open();
        for r in &mut self.agents.races {
            r.racers.retain(|i| open.contains(i));
        }
        self.agents.races.retain(|r| !r.racers.is_empty());
        match slot {
            Some(s) => self.agents.races.iter().position(|r| r.racers.contains(&s)),
            None => self.agents.races.len().checked_sub(1),
        }
    }

    /// `:race` shows the race, `:race pick` keeps the focused racer, `:race <task>` starts one.
    pub fn race_cmd(&mut self, arg: &str, bang: bool) {
        if bang {
            return if arg == "pick" { self.pick_racer(true) } else { self.say("only  :race! pick  takes a !", "ErrorMsg") };
        }
        if arg.is_empty() {
            return self.open_race();
        }
        if arg == "pick" {
            return self.pick_racer(false);
        }
        let parsed = parse_race_args(arg);
        if let Some(e) = parsed.error {
            return self.say(e, "ErrorMsg");
        }
        let mut prompt = parsed.task.clone();
        if let Some(name) = &parsed.template {
            let all = crate::agents::all_templates(&self.config.templates);
            let Some(t) = all.iter().find(|t| &t.0.name == name) else {
                let names: Vec<&str> = all.iter().map(|t| t.0.name.as_str()).collect();
                return self.say(format!("no template '{name}'{} · :templates lists them", crate::keys::did_you_mean(name, &names)), "ErrorMsg");
            };
            if t.0.prompt.contains("{task}") && parsed.task.is_empty() {
                return self.say(format!("template '{}' needs a task: :race <what> -t {}", t.0.name, t.0.name), "ErrorMsg");
            }
            prompt = crate::agents::fill_template(t, &parsed.task);
        }
        if prompt.is_empty() {
            return self.say("usage: :race <task> [--engines claude,codex] [--models claude-opus-5-5,gpt-5.5]  ·  :race shows it  ·  :race pick keeps one", "Comment");
        }
        let task = if !parsed.task.is_empty() { parsed.task.clone() } else { parsed.template.clone().unwrap_or_else(|| "race".into()) };
        let Some(models) = parsed.models else {
            self.start_race(&task, &prompt, parsed.racers);
            return;
        };
        // which engine runs a model comes from the engines' own lists (engines::choices), off the UI thread
        let infos = self.engines.infos.clone();
        let env = self.engines.env.clone();
        let tx = self.tx.clone();
        let asked = parsed.racers.unwrap_or_default();
        std::thread::spawn(move || {
            let known: Vec<(String, Vec<String>)> = engines::all_ids()
                .into_iter()
                .map(|e| {
                    // an engine that isn't installed can't list its models; Claude Code's and Gemini CLI's lists are fixed
                    let missing = infos.iter().find(|i| i.id == e).is_some_and(|i| !i.installed) && e != "claude" && e != "gemini";
                    let list = if missing { vec![] } else { engines::choices::model_choices(e, &env).into_iter().map(|c| c.value).filter(|v| v != "default").collect() };
                    (e.to_string(), list)
                })
                .collect();
            let blocked = |e: &str| -> Option<String> {
                let info = infos.iter().find(|i| i.id == e)?;
                if info.connected || info.checking {
                    return None;
                }
                Some(format!("{}, which isn't {}", info.name, if info.installed { "signed in" } else { "installed" }))
            };
            let r = resolve_race_models(&models, &known, &blocked);
            let _ = tx.send(crate::app::Msg::Run(Box::new(move |app: &mut App| match r {
                Err(e) => app.say(e, "ErrorMsg"),
                Ok(more) => {
                    let mut all = asked;
                    all.extend(more);
                    app.start_race(&task, &prompt, Some(all));
                }
            })));
        });
    }

    /// Start one agent per racer on the same prompt, each in its own worktree.
    pub fn start_race(&mut self, task: &str, prompt: &str, asked: Option<Vec<Racer>>) -> bool {
        let racers = asked.unwrap_or_else(|| self.engines.infos.iter().filter(|e| e.connected).map(|e| Racer { engine: e.id.clone(), model: None }).collect());
        if racers.len() < 2 {
            let msg = match racers.first() {
                Some(r) => format!(
                    "only {} is signed in: race it against itself with --engines {},{}, or connect another (:checkhealth)",
                    engines::engine_name(&r.engine),
                    r.engine,
                    r.engine
                ),
                None => self.no_engine_ready(),
            };
            self.say(msg, "ErrorMsg");
            return false;
        }
        if let Some(r) = racers.iter().find(|r| !self.config.is_engine_id(&r.engine)) {
            let mut ids: Vec<&str> = engines::KNOWN.iter().map(|s| s.id).collect();
            ids.extend(self.config.custom_engines.iter().map(|e| e.id.as_str()));
            let msg = format!("unknown engine '{}'{} · :checkhealth lists them", r.engine, crate::keys::did_you_mean(&r.engine, &ids));
            self.say(msg, "ErrorMsg");
            return false;
        }
        // racers sharing a folder would overwrite each other's work, so each needs its own worktree
        if self.root.is_none() || !self.config.worktree.enabled {
            let why = if self.root.is_some() { "worktrees are off here ([worktree] enabled = false in your config)" } else { "this folder isn't a git repo" };
            self.say(format!("a race needs a worktree for each racer, and {why}"), "ErrorMsg");
            return false;
        }
        let labels = racer_labels(&racers);
        let base = crate::names::agent_name_from(task);
        let mut race = Race { task: task.into(), started: Instant::now(), racers: vec![], labels: vec![], ran: vec![], finished: vec![], announced: false, waiting: vec![], prompt: Some(prompt.into()) };
        let mut failed = vec![];
        for (r, label) in racers.iter().zip(&labels) {
            // a model id like anthropic/claude-opus-5-5 keeps its slash in the race, not in the agent's name and branch
            let name = format!("{base} {}", label.replace('/', " "));
            let Some(i) = self.start_agent(&name, NewAgent { engine: Some(r.engine.clone()), model: r.model.clone(), ..Default::default() }) else {
                failed.push(format!("{label}: {}", self.message.0));
                continue;
            };
            if !self.sessions[i].own_worktree() {
                self.forget_agent(i);
                failed.push(format!("{label}: it got no worktree of its own"));
                continue;
            }
            race.labels.push((i, label.clone()));
            race.racers.push(i);
            if self.sessions[i].held() {
                race.waiting.push(i);
            }
        }
        let Some(&first) = race.racers.first() else { return false }; // start_agent said why
        let names: Vec<String> = race.racers.iter().map(|&i| race.label(i)).collect();
        let n = race.racers.len();
        self.agents.races.push(race);
        let ri = self.agents.races.len() - 1;
        if self.agents.races[ri].waiting.is_empty() {
            self.race_go(ri);
        }
        self.focus_slot(first);
        let names = names.join(", ");
        if n < 2 {
            self.say(format!("only {names} could start, so it runs alone · {}", failed.join(" · ")), "WarningMsg");
        } else {
            let not = if failed.is_empty() { String::new() } else { format!(" · not started: {}", failed.join(" · ")) };
            self.say(format!("race: {names} on '{base}'{not} · :race compares them"), if failed.is_empty() { "ModeMsg" } else { "WarningMsg" });
        }
        true
    }

    /// Every racer starts at once, when the last worktree is there, so the times compare like for like.
    fn race_go(&mut self, ri: usize) {
        let Some(prompt) = self.agents.races[ri].prompt.take() else { return };
        self.agents.races[ri].started = Instant::now();
        for i in self.agents.races[ri].racers.clone() {
            if self.sessions[i].closed {
                continue;
            }
            if let crate::session::Submitted::Now(p) = self.sessions[i].submit(prompt.clone()) {
                self.send(i, p);
            }
        }
    }

    /// A racer's worktree is there (or couldn't be made): the race starts once every one is.
    pub fn race_worktree_settled(&mut self, i: usize) {
        let Some(ri) = self.agents.races.iter().position(|r| r.waiting.contains(&i)) else { return };
        let open = self.open();
        let r = &mut self.agents.races[ri];
        r.waiting.retain(|&j| j != i && open.contains(&j));
        r.racers.retain(|j| open.contains(j));
        if r.waiting.is_empty() {
            if r.racers.is_empty() {
                self.agents.races.remove(ri);
            } else {
                self.race_go(ri);
            }
        }
    }

    /// A racer's state changed: note when it stopped, and say so once every racer has.
    pub fn watch_race(&mut self, i: usize) {
        let state = self.sessions[i].state;
        if state == State::Paused {
            return;
        }
        let Some(ri) = self.agents.races.iter().position(|r| r.racers.contains(&i)) else { return };
        let r = &mut self.agents.races[ri];
        if r.finished_at(i).is_some() {
            return;
        }
        if state == State::Running {
            if !r.ran.contains(&i) {
                r.ran.push(i);
            }
            return;
        }
        // a racer that hasn't started on its prompt yet hasn't finished; one that couldn't start has
        if !r.ran.contains(&i) && state != State::Error {
            return;
        }
        r.finished.push((i, Instant::now()));
        if r.announced || !r.over() {
            return;
        }
        r.announced = true;
        let results: Vec<String> = r
            .order()
            .iter()
            .map(|&x| {
                let s = &self.sessions[x];
                let changes = if s.state == State::Error {
                    " failed".to_string()
                } else if s.stat.0 > 0 || s.stat.1 > 0 {
                    format!(" +{} −{}", s.stat.0, s.stat.1)
                } else {
                    String::new()
                };
                let t = r.finished_at(x).map(|f| f.duration_since(r.started)).unwrap_or_default();
                format!("{} {}{changes}", r.label(x), took(t))
            })
            .collect();
        let focus = self.focus;
        let unseen = !self.agents.terminal_focused || r.racers.iter().any(|&x| x != focus);
        self.say(format!("race over: {} · :race compares them", results.join(" · ")), "ModeMsg");
        if unseen {
            let bytes = alert_sequence("vigent: the race is over", &self.config.ui.notify, &|k| std::env::var(k).ok());
            self.alert(bytes);
        }
    }

    /// `:race`: the racers side by side, first to finish first.
    pub fn open_race(&mut self) {
        let focused = self.focused().map(|s| s.slot);
        let Some(ri) = self.race_of(focused).or_else(|| self.race_of(None)) else {
            return self.say("no race yet (:race <task> runs it on every engine you're signed in to)", "Comment");
        };
        let r = &self.agents.races[ri];
        let cell = |t: &str, w: usize| format!("{:<w$}", crate::ui::text::fit(t, w - 1));
        let mut lines: Vec<(String, &'static str)> = vec![(format!("task  {}", crate::ui::text::fit(&r.task.replace('\n', " "), 96)), "NormalFloat"), (String::new(), "Normal")];
        lines.push((format!("   {}{}{}{}usage", cell("racer", 26), cell("state", 10), cell("time", 10), cell("changes", 22)), "Comment"));
        for (n, &i) in r.order().iter().enumerate() {
            let s = &self.sessions[i];
            let done = r.finished_at(i);
            let glyph = match s.state {
                State::Running => "●",
                State::Waiting => "◐",
                State::Idle => "○",
                State::Paused => "‖",
                State::Error => "✗",
            };
            let state = if done.is_none() && s.state != State::Running {
                "starting"
            } else {
                match s.state {
                    State::Idle => "done",
                    State::Running => "running",
                    State::Waiting => "waiting",
                    State::Paused => "paused",
                    State::Error => "error",
                }
            };
            let time = took(done.unwrap_or_else(Instant::now).duration_since(r.started));
            let changes = if s.stat.0 > 0 || s.stat.1 > 0 { format!("+{} −{}", s.stat.0, s.stat.1) } else { "no changes".into() };
            let usage = if s.tokens > 0 { crate::session::format_usage(s.tokens, s.cost) } else { String::new() };
            let num = if done.is_none() { " ".to_string() } else { (n + 1).to_string() };
            let group = match s.state {
                State::Running => "String",
                State::Waiting => "WarningMsg",
                State::Error => "ErrorMsg",
                _ => "NormalFloat",
            };
            lines.push((format!("{num} {glyph} {}{}{}{}{usage}", cell(&r.label(i), 25), cell(state, 10), cell(&time, 10), cell(&changes, 22)), group));
            let last = s.items.iter().rev().find_map(|it| match it {
                Item::Text(t) => Some(t.replace('\n', " ")),
                _ => None,
            });
            lines.push((format!("     {}", last.map(|t| crate::ui::text::fit(&t, 96)).unwrap_or_else(|| "(no reply yet)".into())), "Comment"));
        }
        lines.push((String::new(), "Normal"));
        let running = r.racers.iter().filter(|&&i| r.finished_at(i).is_none()).count();
        let head = if running > 0 { format!("{running} of {} still running · ", r.racers.len()) } else { format!("{} racers, all done · ", r.racers.len()) };
        lines.push((format!("{head}then :diff, :review · :race pick keeps the one you're on"), "Comment"));
        let title = format!("Race · {}", crate::ui::text::fit(&crate::names::agent_name_from(&r.task), 40));
        self.float = Some(Float::new(&title, lines));
    }

    /// `:race pick`: keep the focused racer; the others go, with their worktrees and branches.
    pub fn pick_racer(&mut self, sure: bool) {
        let winner = self.focused().map(|s| s.slot);
        let race = self.race_of(winner);
        let (Some(winner), Some(ri)) = (winner, race) else {
            let msg = if self.race_of(None).is_some() {
                "this agent isn't in a race: open the racer to keep (:race lists them), then :race pick"
            } else {
                "no race to pick from (:race <task> starts one)"
            };
            return self.say(msg, "ErrorMsg");
        };
        let racers = self.agents.races[ri].racers.clone();
        // a loser's forks work in its worktree, so they go with it
        let losers: Vec<usize> = self
            .open()
            .into_iter()
            .filter(|&i| i != winner && (racers.contains(&i) || self.sessions[i].fork_of.is_some_and(|o| o != winner && racers.contains(&o))))
            .collect();
        let name = self.sessions[winner].name.clone();
        if losers.is_empty() {
            self.agents.races.remove(ri);
            return self.say(format!("'{name}' is the only racer left · :merge or :pr lands it"), "Comment");
        }
        let n = losers.len();
        let others = if n == 1 { "racer".to_string() } else { format!("{n} racers") };
        let drop = move |app: &mut App| {
            let mut kept = vec![];
            for &i in &losers {
                let setting_up = app.sessions[i].held() && app.sessions[i].made.is_none();
                let (own, path, branch, base) = {
                    let s = &app.sessions[i];
                    (s.own_worktree(), s.path.clone(), s.branch.clone(), s.base.clone())
                };
                app.forget_agent(i);
                let Some(root) = app.root.clone() else { continue };
                if !own || setting_up {
                    continue; // one still being made is removed once it is
                }
                // you said yes to losing their changes, so uncommitted work doesn't stop the removal
                let r = crate::worktree::remove(&root, &path, branch.as_deref(), Some(base.as_str()).filter(|b| !b.is_empty()), true);
                if !r.removed {
                    kept.push(format!("{}: {}", branch.unwrap_or_default(), r.message));
                }
            }
            app.agents.races.retain(|r| !r.racers.contains(&winner));
            app.focus_slot(winner);
            let name = app.sessions[winner].name.clone();
            if kept.is_empty() {
                app.say(format!("kept '{name}' · removed the other {others} · :merge or :pr lands it"), "WarningMsg");
            } else {
                app.say(format!("kept '{name}' · couldn't remove {}", kept.join(" · ")), "ErrorMsg");
            }
        };
        if sure {
            return drop(self);
        }
        let others = if n == 1 { "racer".to_string() } else { format!("{n} racers") };
        self.ask(format!("keep '{name}' and remove the other {others}, with their worktrees and changes? (y/n)"), Box::new(drop));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(e: &str, m: Option<&str>) -> Racer {
        Racer { engine: e.into(), model: m.map(String::from) }
    }

    #[test]
    fn race_arguments() {
        let a = parse_race_args("fix the flaky test --engines claude,codex:gpt-5.5 -t fix");
        assert_eq!(a.task, "fix the flaky test");
        assert_eq!(a.racers, Some(vec![r("claude", None), r("codex", Some("gpt-5.5"))]));
        assert_eq!(a.template.as_deref(), Some("fix"));
        assert!(parse_race_args("x --engines claude").error.unwrap().starts_with("a race needs at least two"));
        assert!(parse_race_args("x --engines :opus,claude").error.unwrap().contains("names a model but no engine"));
        let m = parse_race_args("x --models a,b");
        assert_eq!((m.racers, m.models), (None, Some(vec!["a".to_string(), "b".to_string()])));
        assert_eq!(parse_race_args("just a task"), RaceArgs { task: "just a task".into(), ..Default::default() });
    }

    #[test]
    fn models_run_on_the_engine_that_lists_them() {
        let known = vec![("claude".to_string(), vec!["claude-opus-5-5".to_string()]), ("codex".to_string(), vec!["gpt-5.5".to_string()]), ("opencode".to_string(), vec!["gpt-5.5".to_string(), "kimi".to_string()])];
        let ok = resolve_race_models(&["claude-opus-5-5".into(), "gpt-5.5".into(), "opencode:kimi".into()], &known, &|_| None).unwrap();
        assert_eq!(ok, vec![r("claude", Some("claude-opus-5-5")), r("codex", Some("gpt-5.5")), r("opencode", Some("kimi"))]);
        assert!(resolve_race_models(&["nope".into()], &known, &|_| None).unwrap_err().starts_with("no engine lists the model 'nope'"));
        let blocked = resolve_race_models(&["gpt-5.5".into()], &known, &|_| Some("Codex, which isn't signed in".into()));
        assert_eq!(blocked.unwrap_err(), "gpt-5.5 runs on Codex, which isn't signed in · :checkhealth");
    }

    #[test]
    fn racers_are_told_apart() {
        assert_eq!(racer_labels(&[r("claude", Some("opus")), r("codex", None)]), ["opus", "codex"]);
        assert_eq!(racer_labels(&[r("claude", None), r("claude", None), r("codex", None)]), ["claude 1", "claude 2", "codex"]);
    }

    #[test]
    fn a_race_needs_two_engines_and_worktrees() {
        let mut a = crate::app::tests::app();
        crate::commands::exec(&mut a, "race fix it");
        assert_eq!(a.message.0, "only Claude Code is signed in: race it against itself with --engines claude,claude, or connect another (:checkhealth)");
        crate::commands::exec(&mut a, "race fix it --engines claude,nope");
        assert!(a.message.0.starts_with("unknown engine 'nope'"));
        crate::commands::exec(&mut a, "race fix it --engines claude,claude");
        assert_eq!(a.message.0, "a race needs a worktree for each racer, and this folder isn't a git repo");
        crate::commands::exec(&mut a, "race");
        assert_eq!(a.message.0, "no race yet (:race <task> runs it on every engine you're signed in to)");
        crate::commands::exec(&mut a, "race! go");
        assert_eq!(a.message.0, "only  :race! pick  takes a !");
    }
}
