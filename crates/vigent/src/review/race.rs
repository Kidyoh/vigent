//! `:race <task>`: the same task on several engines at once, each in its own
//! worktree, so you can compare what they did and keep the one you like
//! (src/race.ts; the App half is in races.rs).

use std::collections::{HashMap, HashSet};

/// One entrant: an engine, and a model for it when you asked for one (`claude:opus`, or `--models claude-opus-5-5`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Racer {
    pub engine: String,
    pub model: Option<String>,
}

impl Racer {
    pub fn new(engine: &str, model: Option<&str>) -> Racer {
        Racer { engine: engine.into(), model: model.map(str::to_string) }
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct RaceArgs {
    pub task: String,
    /// from `--engines`; with no `--models` either, every engine that's signed in races
    pub racers: Option<Vec<Racer>>,
    /// from `--models`: model ids, each racing on the engine whose list has it
    pub models: Option<Vec<String>>,
    pub template: Option<String>,
    pub error: Option<String>,
}

/// The first `(?:^|\s)(?:flag)[= ](\S+)` in `s`: (start of the match, its end, the value).
fn find_flag<'a>(s: &'a str, flags: &[&str]) -> Option<(usize, usize, &'a str)> {
    let mut prev_ws = true;
    for (i, c) in s.char_indices() {
        if prev_ws {
            for f in flags {
                let Some(after) = s[i..].strip_prefix(f) else { continue };
                let Some(sep) = after.chars().next().filter(|&c| c == '=' || c == ' ') else { continue };
                let value_at = i + f.len() + sep.len_utf8();
                let value = &s[value_at..];
                let end = value.find(char::is_whitespace).unwrap_or(value.len());
                if end == 0 {
                    continue;
                }
                // the whitespace before the flag is part of the match, as `(?:^|\s)` makes it
                let start = s[..i].char_indices().last().map(|(j, _)| j).unwrap_or(i);
                return Some((start, value_at + end, &value[..end]));
            }
        }
        prev_ws = c.is_whitespace();
    }
    None
}

const ENGINES: &[&str] = &["--engines", "--engine", "-e"];
const MODELS: &[&str] = &["--models", "--model", "-m"];
const TEMPLATE: &[&str] = &["--template", "-t"];

/// `s` without its first match of the flag (String.replace with a regex, once).
fn without(s: &str, flags: &[&str]) -> String {
    match find_flag(s, flags) {
        Some((a, b, _)) => format!("{}{}", &s[..a], &s[b..]),
        None => s.to_string(),
    }
}

/// `fix the flaky test --engines claude,codex:gpt-5.5 --models claude-opus-5-5 -t fix`.
/// An engine or a model can be there twice (`claude,claude`, `--models gpt-5.5,gpt-5.5`).
pub fn parse_race_args(arg: &str) -> RaceArgs {
    let engines = find_flag(arg, ENGINES).map(|m| m.2);
    let models = find_flag(arg, MODELS).map(|m| m.2);
    let template = find_flag(arg, TEMPLATE).map(|m| m.2.to_string());
    let task = without(&without(&without(arg, ENGINES), MODELS), TEMPLATE).trim().to_string();
    let out = RaceArgs { task, template, ..Default::default() };
    if engines.is_none() && models.is_none() {
        return out;
    }
    let mut racers = vec![];
    for part in engines.unwrap_or("").split(',').filter(|p| !p.is_empty()) {
        let (engine, model) = part.split_once(':').unwrap_or((part, ""));
        if engine.is_empty() {
            return RaceArgs { error: Some(format!("'{part}' names a model but no engine (write engine:model, or put it in --models)")), ..out };
        }
        racers.push(Racer::new(engine, (!model.is_empty()).then_some(model)));
    }
    let ids: Vec<String> = models.unwrap_or("").split(',').filter(|m| !m.is_empty()).map(str::to_string).collect();
    if racers.len() + ids.len() < 2 {
        return RaceArgs {
            error: Some("a race needs at least two: --engines claude,codex or --models claude-opus-5-5,gpt-5.5 (the same one twice works too)".into()),
            ..out
        };
    }
    RaceArgs { racers: engines.map(|_| racers), models: models.map(|_| ids), ..out }
}

fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut dp: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = dp[0];
        dp[0] = i;
        for j in 1..=b.len() {
            let tmp = dp[j];
            dp[j] = (dp[j] + 1).min(dp[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = tmp;
        }
    }
    dp[b.len()]
}

/// " (did you mean 'x'?)" for the closest candidate within a few edits (src/suggest.ts).
pub fn did_you_mean<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> String {
    let mut best = None;
    let mut score = 2.max(name.chars().count() / 3) + 1;
    for c in candidates {
        let d = distance(&name.to_lowercase(), &c.to_lowercase());
        if d < score {
            best = Some(c);
            score = d;
        }
    }
    best.map(|c| format!(" (did you mean '{c}'?)")).unwrap_or_default()
}

/// Engines that make their own models: a model one of them lists is theirs, even when an engine that routes to many lists it too.
const MAKERS: &[&str] = &["claude", "codex", "gemini", "cursor"];

/// `--models` ids to racers. Each id runs on the engine whose model list has it
/// exactly (`known`: engine → the ids and aliases it takes). `engine:model` runs
/// one on the engine you name. An id no list has, one that's in more than one,
/// or one whose engine can't run it now (`blocked` says why) is refused: a race
/// never moves a model to another engine.
pub fn resolve_race_models(ids: &[String], known: &[(String, Vec<String>)], blocked: impl Fn(&str) -> Option<String>) -> Result<Vec<Racer>, String> {
    let mut racers = vec![];
    for id in ids {
        if let Some((engine, model)) = id.split_once(':') {
            if !engine.is_empty() && known.iter().any(|(e, _)| e == engine) {
                racers.push(Racer::new(engine, Some(model)));
                continue;
            }
        }
        let mut owners: Vec<&str> = known.iter().filter(|(_, list)| list.contains(id)).map(|(e, _)| e.as_str()).collect();
        if owners.len() > 1 && owners.iter().any(|e| MAKERS.contains(e)) {
            owners.retain(|e| MAKERS.contains(e));
        }
        if owners.is_empty() {
            let mut all: Vec<&str> = vec![];
            for (_, list) in known {
                for m in list {
                    if !all.contains(&m.as_str()) {
                        all.push(m);
                    }
                }
            }
            return Err(format!("no engine lists the model '{id}'{} · engine:model runs one that isn't listed", did_you_mean(id, all)));
        }
        if owners.len() > 1 {
            let which: Vec<String> = owners.iter().map(|e| format!("{e}:{id}")).collect();
            return Err(format!("'{id}' runs on {}: say which, as {}", owners.join(" and "), which.join(" or ")));
        }
        let on = owners[0];
        if let Some(why) = blocked(on) {
            return Err(format!("{id} runs on {why} · :checkhealth"));
        }
        racers.push(Racer::new(on, Some(id)));
    }
    Ok(racers)
}

/// What tells the racers apart in an agent's name (and so in its branch): the
/// model when it has one, else the engine, and a number when the same one runs more than once.
pub fn racer_labels(racers: &[Racer]) -> Vec<String> {
    let plain: Vec<&str> = racers.iter().map(|r| r.model.as_deref().unwrap_or(&r.engine)).collect();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    plain
        .iter()
        .map(|p| {
            if plain.iter().filter(|q| q == &p).count() < 2 {
                return p.to_string();
            }
            let n = seen.entry(p).or_default();
            *n += 1;
            format!("{p} {n}")
        })
        .collect()
}

/// What Tab offers after `:race … --engines` / `--models`: the last item of the comma list.
/// Returns (the line up to what's completed, the candidates).
pub fn complete_race_arg(arg: &str, engines: &[String], models: &[String]) -> Option<(String, Vec<String>)> {
    // (?:^|\s)(--engines?|-e|--models?|-m)([= ])((?:[^\s,]*,)*)([^\s,]*)$
    let value_flags = ["--engines", "--engine", "-e", "--models", "--model", "-m"];
    let tail_at = arg.char_indices().filter(|(_, c)| c.is_whitespace()).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0);
    let tail = &arg[tail_at..];
    let mut found: Option<(&str, &str)> = None; // (flag, value)
    // the separator is a space: "<flag> <value>" with the flag at the start or after whitespace
    if tail_at > 0 && arg[..tail_at].ends_with(' ') {
        let before = &arg[..tail_at - 1];
        for f in value_flags {
            if let Some(head) = before.strip_suffix(f) {
                if head.is_empty() || head.ends_with(char::is_whitespace) {
                    found = Some((f, tail));
                    break;
                }
            }
        }
    }
    if found.is_none() {
        for f in value_flags {
            if let Some(v) = tail.strip_prefix(f).and_then(|r| r.strip_prefix('=')) {
                found = Some((f, v));
                break;
            }
        }
    }
    if let Some((flag, value)) = found {
        let list = if flag.starts_with("--e") || flag == "-e" { engines } else { models };
        let needle = value.rsplit(',').next().unwrap_or("");
        let lower = needle.to_lowercase();
        let base = arg[..arg.len() - needle.len()].to_string();
        return Some((base, list.iter().filter(|x| x.to_lowercase().starts_with(&lower)).cloned().collect()));
    }
    if tail.starts_with('-') && tail.chars().all(|c| c == '-' || c.is_ascii_lowercase()) {
        let base = arg[..arg.len() - tail.len()].to_string();
        let items = ["--engines", "--models", "--template"].iter().filter(|f| f.starts_with(tail)).map(|f| f.to_string()).collect();
        return Some((base, items));
    }
    None
}

/// A race: racers by their slot in App::sessions, times in ms on the race clock.
#[derive(Clone, Debug, Default)]
pub struct Race {
    pub id: usize,
    pub task: String,
    /// the prompt every racer gets, once the last worktree is ready
    pub prompt: String,
    /// the racers have been sent the prompt
    pub started: bool,
    pub started_at: u64,
    pub racers: Vec<usize>,
    /// what tells each racer apart (racer_labels)
    pub labels: HashMap<usize, String>,
    /// the racers that have started on the task
    pub ran: HashSet<usize>,
    /// when each racer first stopped running
    pub finished_at: HashMap<usize, u64>,
    /// you've been told that every racer is done
    pub announced: bool,
}

impl Race {
    /// Every racer has stopped at least once (finished, failed or needs you).
    pub fn over(&self) -> bool {
        !self.racers.is_empty() && self.racers.iter().all(|s| self.finished_at.contains_key(s))
    }

    /// The racers, first to finish first; the ones still running last, in the order they started.
    pub fn order(&self) -> Vec<usize> {
        let mut v = self.racers.clone();
        v.sort_by_key(|s| self.finished_at.get(s).copied().unwrap_or(u64::MAX));
        v
    }

    pub fn label(&self, slot: usize) -> String {
        self.labels.get(&slot).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn racers(list: &[(&str, Option<&str>)]) -> Vec<Racer> {
        list.iter().map(|(e, m)| Racer::new(e, *m)).collect()
    }

    #[test]
    fn race_arguments() {
        assert_eq!(parse_race_args("fix the flaky test"), RaceArgs { task: "fix the flaky test".into(), ..Default::default() });
        let a = parse_race_args("fix it --engines claude,codex");
        assert_eq!((a.task.as_str(), a.racers), ("fix it", Some(racers(&[("claude", None), ("codex", None)]))));
        let a = parse_race_args("-e claude:opus,claude:sonnet tidy the readme -t fix");
        assert_eq!(a.task, "tidy the readme");
        assert_eq!(a.template.as_deref(), Some("fix"));
        assert_eq!(a.racers, Some(racers(&[("claude", Some("opus")), ("claude", Some("sonnet"))])));
        assert_eq!(parse_race_args("x --engines=opencode:anthropic/claude:1,pi").racers, Some(racers(&[("opencode", Some("anthropic/claude:1")), ("pi", None)])));
        assert!(parse_race_args("x --engines claude").error.unwrap().contains("at least two"));
        assert!(parse_race_args("x --engines :opus,codex").error.unwrap().contains("no engine"));
        let a = parse_race_args("fix it --models claude-opus-5-5,gpt-5.5");
        assert_eq!((a.task.as_str(), a.racers, a.models), ("fix it", None, Some(vec!["claude-opus-5-5".to_string(), "gpt-5.5".into()])));
        let a = parse_race_args("-m=gpt-5.5 fix it -e opencode");
        assert_eq!((a.task.as_str(), a.racers, a.models), ("fix it", Some(racers(&[("opencode", None)])), Some(vec!["gpt-5.5".to_string()])), "one of each is two racers");
        assert!(parse_race_args("x --models gpt-5.5").error.unwrap().contains("at least two"));
    }

    #[test]
    fn models_run_on_the_engine_whose_list_has_them() {
        let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let known = vec![
            ("claude".to_string(), v(&["claude-opus-5-5", "claude-sonnet-5-5", "opus"])),
            ("codex".into(), v(&["gpt-5.5", "gpt-5.5-codex"])),
            ("gemini".into(), v(&["pro", "flash"])),
            ("opencode".into(), v(&["anthropic/claude-opus-5-5", "openai/gpt-5.5"])),
            ("pi".into(), v(&["anthropic/claude-opus-5-5", "gpt-5.5"])),
        ];
        let blocked = |e: &str| (e == "gemini").then(|| "Gemini CLI, which isn't signed in".to_string());
        let resolve = |ids: &[&str]| resolve_race_models(&v(ids), &known, blocked);
        assert_eq!(
            resolve(&["claude-opus-5-5", "gpt-5.5", "opus"]).unwrap(),
            racers(&[("claude", Some("claude-opus-5-5")), ("codex", Some("gpt-5.5")), ("claude", Some("opus"))]),
            "gpt-5.5 is Codex's own, though pi lists it too"
        );
        assert_eq!(
            resolve(&["opencode:anthropic/claude-opus-5-5", "codex:gpt-6-preview"]).unwrap(),
            racers(&[("opencode", Some("anthropic/claude-opus-5-5")), ("codex", Some("gpt-6-preview"))])
        );
        assert_eq!(resolve(&["flash", "gpt-5.5"]).unwrap_err(), "flash runs on Gemini CLI, which isn't signed in · :checkhealth");
        let e = resolve(&["claude-opus-5.5"]).unwrap_err();
        assert!(e.starts_with("no engine lists the model 'claude-opus-5.5' (did you mean 'claude-opus-5-5'?) · engine:model"), "{e}");
        assert!(resolve(&["anthropic/claude-opus-5-5"])
            .unwrap_err()
            .contains("runs on opencode and pi: say which, as opencode:anthropic/claude-opus-5-5 or pi:anthropic/claude-opus-5-5"));
    }

    #[test]
    fn tab_completes_the_last_item_of_engines_and_models() {
        let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (e, m) = (v(&["claude", "codex", "opencode"]), v(&["claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.5"]));
        assert_eq!(complete_race_arg("fix it --engines c", &e, &m), Some(("fix it --engines ".into(), v(&["claude", "codex"]))));
        assert_eq!(complete_race_arg("fix it --engines claude,o", &e, &m), Some(("fix it --engines claude,".into(), v(&["opencode"]))));
        assert_eq!(complete_race_arg("fix it -m=claude-opus-5-5,claude-s", &e, &m), Some(("fix it -m=claude-opus-5-5,".into(), v(&["claude-sonnet-5-5"]))));
        assert_eq!(complete_race_arg("fix it --mo", &e, &m), Some(("fix it ".into(), v(&["--models"]))));
        assert_eq!(complete_race_arg("fix it", &e, &m), None, "the task itself isn't completed");
        assert_eq!(complete_race_arg("x --models ", &e, &m).unwrap().1, m);
    }

    #[test]
    fn racers_are_told_apart() {
        let label = |l: &[&str]| racer_labels(&l.iter().map(|p| match p.split_once(':') { Some((e, m)) => Racer::new(e, Some(m)), None => Racer::new(p, None) }).collect::<Vec<_>>());
        assert_eq!(label(&["claude", "codex"]), ["claude", "codex"]);
        assert_eq!(label(&["claude:claude-opus-5-5", "codex"]), ["claude-opus-5-5", "codex"]);
        assert_eq!(label(&["claude:opus", "claude:sonnet", "codex:gpt-5.5"]), ["opus", "sonnet", "gpt-5.5"]);
        assert_eq!(label(&["claude", "claude", "codex"]), ["claude 1", "claude 2", "codex"]);
        assert_eq!(label(&["claude:gpt-5.5", "codex:gpt-5.5", "claude"]), ["gpt-5.5 1", "gpt-5.5 2", "claude"]);
    }

    #[test]
    fn a_race_is_over_when_every_racer_stopped() {
        let mut r = Race { racers: vec![3, 4], ..Default::default() };
        assert!(!r.over());
        r.finished_at.insert(4, 10);
        assert_eq!(r.order(), [4, 3]);
        r.finished_at.insert(3, 20);
        assert!(r.over());
        assert_eq!(r.order(), [4, 3]);
    }
}
