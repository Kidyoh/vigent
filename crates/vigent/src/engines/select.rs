//! Which engine, model and effort agents run with (src/app.ts startAgent,
//! modelTarget, chooseModel, chooseOtherEngine, allModelChoices, chooseEffort,
//! openEnginePicker, engineNote, chooseEngine, openModelPicker,
//! openEffortPicker, noEngineReady; and cli.ts newSession's model rules).

use super::choices::{self, Choice, model_label};
use super::picker::{self, Picker};
use super::{Launch, all_ids, default_engine, engine_name, intern, is_engine_id};
use crate::app::{App, Msg};
use crate::session::Session;

/// What a new agent asks for; None: what :engine, :model and :effort (or config) set.
#[derive(Debug, Clone, Default)]
pub struct StartOpts {
    pub engine: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// "no engine is signed in: run claude auth login or codex login, or for pi export ANTHROPIC_API_KEY=… · :checkhealth"
pub fn no_engine_ready(app: &App) -> String {
    let e = &app.engines.infos;
    let logins: Vec<&str> = e.iter().filter(|x| x.id != "pi" && x.installed).filter_map(|x| x.connect.as_deref()).collect();
    let pi = e.iter().find(|x| x.id == "pi").and_then(|x| x.connect.as_deref());
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

/// The engine a new agent runs on, or why it can't start (TS startAgent's checks).
pub fn engine_for_new(app: &App, opts: &StartOpts) -> Result<&'static str, String> {
    let engine = match &opts.engine {
        Some(e) => intern(e).ok_or_else(|| format!("unknown engine '{e}': pi, claude, codex or opencode"))?,
        None => app.new_agent_engine(),
    };
    if let Some(info) = app.engines.get(engine) {
        if !info.installed {
            return Err(format!("{} isn't installed: {} · :checkhealth", info.name, info.install.clone().unwrap_or_default()));
        }
        // auto lands on an engine that isn't ready only when none is; an agent started there could never answer
        if opts.engine.is_none() && app.engines.preferred == "auto" && !info.connected && !info.checking {
            return Err(no_engine_ready(app));
        }
    }
    Ok(engine)
}

/// Why a new agent can't start (on `engine`, or the default one), if it can't.
pub fn cant_start(app: &App, engine: Option<&str>) -> Option<String> {
    engine_for_new(app, &StartOpts { engine: engine.map(str::to_string), ..Default::default() }).err()
}

/// A new agent's model and effort: what was asked, else what :model / :effort / config set for its engine.
pub fn configure_new(app: &App, s: &mut Session, opts: &StartOpts) {
    let model = opts.model.clone().or_else(|| app.engines.new_model.get(&s.engine).cloned());
    s.requested_model = model.filter(|m| m != "default");
    s.effort = opts.effort.clone().or_else(|| app.engines.new_effort.get(&s.engine).cloned());
}

/// How an agent's CLI runs now: [engines.<id>] args and allow (read at each prompt: :permissions changes them), and detection's dropEnv.
pub fn launch(app: &App, engine: &str) -> Launch {
    let o = app.config.engine_options(engine);
    Launch {
        bin: super::bin(engine),
        extra_args: o.and_then(|o| o.args.clone()),
        allow: o.and_then(|o| o.allow.clone()).unwrap_or_default(),
        ask: o.and_then(|o| o.ask).unwrap_or(false),
        drop_env: app.engines.get(engine).map(|e| e.drop_env.clone()).unwrap_or_default(),
    }
}

/// Who `:model` / `:effort` change: the focused agent, or new agents on the default engine.
pub struct Target {
    pub session: Option<usize>,
    pub engine: String,
    pub label: String,
}

pub fn target(app: &App) -> Target {
    match app.focused() {
        Some(s) => Target { session: Some(s.slot), engine: s.engine.clone(), label: format!("'{}' ({})", s.name, engine_name(&s.engine)) },
        None => {
            let e = app.new_agent_engine();
            Target { session: None, engine: e.into(), label: format!("new {} agents", engine_name(e)) }
        }
    }
}

/// Save an agent's model and effort with its record, so they survive a restart (cli.ts app.persist).
pub fn persist(app: &App, i: usize) {
    let s = &app.sessions[i];
    if s.made.is_none() {
        return;
    }
    let Some(mut meta) = crate::records::load(&s.path) else { return };
    if s.engine == "pi" {
        meta.model = super::shown_model(s);
    } else {
        meta.model = s.requested_model.clone().unwrap_or_default();
        meta.requested_model = s.requested_model.clone();
        meta.usage = Some((s.tokens, (s.cost > 0.0).then_some(s.cost)));
    }
    meta.effort = s.effort.clone();
    let _ = crate::records::save(&s.path, &meta);
}

/// `:model <name>` (TS chooseModel).
pub fn choose_model(app: &mut App, model: &str, t: &Target) {
    // a model of another engine (codex:gpt-5.5, from the picker or typed)
    let mut model = model.to_string();
    if let Some((e, rest)) = model.split_once(':')
        && ["pi", "claude", "codex", "opencode"].contains(&e)
        && !rest.is_empty()
    {
        if e != t.engine {
            return choose_other_engine(app, e, rest, t);
        }
        model = rest.to_string();
    }
    let value = (model != "default").then(|| model.clone());
    let name = value.as_deref().map(model_label).unwrap_or_else(|| "default".into());
    let Some(i) = t.session else {
        match &value {
            Some(v) => app.engines.new_model.insert(t.engine.clone(), v.clone()),
            None => app.engines.new_model.remove(&t.engine),
        };
        return app.say(format!("model for new agents: {name}"), "ModeMsg");
    };
    let done = move |app: &mut App, r: Result<(), String>| match r {
        Ok(()) => {
            persist(app, i);
            let msg = format!("model for '{}': {name} (from the next prompt)", app.sessions[i].name);
            app.say(msg, "ModeMsg");
        }
        Err(e) => app.say(e, "ErrorMsg"),
    };
    if app.sessions[i].engine == "pi" {
        super::pi::set_model(app, i, value, Box::new(done));
    } else {
        app.sessions[i].requested_model = value;
        done(app, Ok(()));
    }
}

/// A model from another engine's list: new agents run on that engine with it.
/// An open agent stays where it is, since its conversation lives in its engine.
fn choose_other_engine(app: &mut App, engine: &str, model: &str, t: &Target) {
    let Some(id) = intern(engine) else { return };
    app.engines.preferred = id;
    if model == "default" {
        app.engines.new_model.remove(id);
    } else {
        app.engines.new_model.insert(id.into(), model.into());
    }
    let name = if model == "default" { "the default model".to_string() } else { model_label(model) };
    let stays = t.session.map(|i| format!("'{}' keeps its model (its conversation can't move) · ", app.sessions[i].name)).unwrap_or_default();
    app.say(format!("{stays}new agents use {name} · :new <task> starts one"), "ModeMsg");
}

/// What :model lists: the target engine's models first, then those of every other
/// engine that's ready, in one plain list (TS allModelChoices). Blocking.
pub fn all_model_choices(engine: &str, ready: &[String], env: &super::Env) -> Vec<Choice> {
    let others: Vec<&str> = ["claude", "codex", "opencode", "pi"].into_iter().filter(|e| *e != engine && ready.iter().any(|r| r == e)).collect();
    let mut out = vec![];
    for (k, e) in std::iter::once(engine).chain(others.iter().copied()).enumerate() {
        for c in choices::model_choices(e, env) {
            if k > 0 && c.value == "default" {
                continue;
            }
            let value = if k == 0 { c.value.clone() } else { format!("{e}:{}", c.value) };
            let note = (c.value != "default").then(|| c.value.clone());
            out.push(Choice { value, label: c.label.clone(), note });
        }
    }
    out
}

/// `:model`: pick from what the engines offer, or type any name (TS openModelPicker).
pub fn open_model_picker(app: &mut App) {
    let t = target(app);
    let current = match t.session {
        Some(i) => {
            let s = &app.sessions[i];
            if s.engine == "pi" { s.requested_model.clone().or_else(|| s.model.clone()).unwrap_or_else(|| "default".into()) } else { s.requested_model.clone().unwrap_or_else(|| "default".into()) }
        }
        None => app.engines.new_model.get(&t.engine).cloned().unwrap_or_else(|| "default".into()),
    };
    let title = match t.session {
        Some(i) => format!("Model · '{}'", app.sessions[i].name),
        None => "Model · new agents".into(),
    };
    let (engine, ready, env) = (t.engine.clone(), app.engines.infos.iter().filter(|e| e.connected).map(|e| e.id.clone()).collect::<Vec<_>>(), app.engines.env.clone());
    let p = Picker::new(&title, None, &current, true, Some(12), Box::new(move |app, v| {
        if let Some(v) = v {
            choose_model(app, &v, &t);
        }
    }));
    load_into(app, p, move || all_model_choices(&engine, &ready, &env));
}

/// Open `p` and fill it from `load`, run on a thread.
fn load_into(app: &mut App, p: Picker, load: impl FnOnce() -> Vec<Choice> + Send + 'static) {
    let (id, tx) = (p.id, app.tx.clone());
    picker::open(app, p);
    std::thread::spawn(move || {
        let list = load();
        let _ = tx.send(Msg::Run(Box::new(move |app| picker::fill(app, id, list))));
    });
}

/// `:effort <level>` (TS chooseEffort).
pub fn choose_effort(app: &mut App, level: &str, t: &Target) {
    let mut allowed = vec!["default"];
    allowed.extend(super::efforts(&t.engine));
    // Codex's levels differ per model and version; Codex itself says if one doesn't fit
    let codex_word = t.engine == "codex" && !level.is_empty() && level.bytes().all(|b| b.is_ascii_lowercase());
    if !allowed.contains(&level) && !codex_word {
        return app.say(format!("{} takes: {}", engine_name(&t.engine), allowed.join(", ")), "ErrorMsg");
    }
    let value = (level != "default").then(|| level.to_string());
    let Some(i) = t.session else {
        match &value {
            Some(v) => app.engines.new_effort.insert(t.engine.clone(), v.clone()),
            None => app.engines.new_effort.remove(&t.engine),
        };
        return app.say(format!("effort for {}: {level}", t.label), "ModeMsg");
    };
    let msg = format!("effort for {}: {level} (from the next prompt)", t.label);
    let done = move |app: &mut App, r: Result<(), String>| match r {
        Ok(()) => {
            persist(app, i);
            app.say(msg, "ModeMsg");
        }
        Err(e) => app.say(e, "ErrorMsg"),
    };
    if app.sessions[i].engine == "pi" {
        super::pi::set_effort(app, i, value, Box::new(done));
    } else {
        app.sessions[i].effort = value;
        done(app, Ok(()));
    }
}

/// `:effort`: the reasoning effort / thinking levels the engine accepts (TS openEffortPicker).
pub fn open_effort_picker(app: &mut App) {
    let t = target(app);
    let (current, model) = match t.session {
        Some(i) => {
            let s = &app.sessions[i];
            (s.effort.clone(), s.requested_model.clone().or_else(|| if s.engine == "pi" { s.model.clone() } else { None }))
        }
        None => (app.engines.new_effort.get(&t.engine).cloned(), app.engines.new_model.get(&t.engine).cloned()),
    };
    let current = current.unwrap_or_else(|| "default".into());
    let (engine, env) = (t.engine.clone(), app.engines.env.clone());
    let title = format!("Effort · {}", t.label);
    let p = Picker::new(&title, None, &current, false, None, Box::new(move |app, v| {
        if let Some(v) = v {
            choose_effort(app, &v, &t);
        }
    }));
    load_into(app, p, move || choices::effort_choices_for(&engine, model.as_deref(), &env));
}

/// "Claude Code · ready", "Codex · not signed in: codex login", "pick for me (now Claude Code)" (TS engineNote).
pub fn engine_note(app: &App, id: &str) -> String {
    if id == "auto" {
        return format!("pick for me (now {})", engine_name(default_engine(&app.engines.infos)));
    }
    let Some(e) = app.engines.get(id) else { return engine_name(id) };
    let status = if e.connected {
        "ready".to_string()
    } else if !e.installed {
        "not installed".into()
    } else if let Some(c) = &e.connect {
        format!("not signed in: {c}")
    } else {
        "not signed in".into()
    };
    format!("{} · {status}", engine_name(id))
}

/// `:engine`: which engine new agents run on, with what's ready on this machine.
pub fn open_engine_picker(app: &mut App) {
    let mut items = vec![Choice::new("auto", None, Some(&engine_note(app, "auto")))];
    items.extend(all_ids().into_iter().map(|id| Choice::new(id, None, Some(&engine_note(app, id)))));
    let current = app.engines.preferred.to_string();
    let p = Picker::new("Engine for new agents", Some(items), &current, false, None, Box::new(|app, v| {
        if let Some(v) = v {
            choose_engine(app, &v);
        }
    }));
    picker::open(app, p);
}

/// `:engine <name>`: new agents run on it. Agents already open keep theirs (their conversation lives there).
pub fn choose_engine(app: &mut App, value: &str) {
    if value != "auto" && !is_engine_id(value) {
        return app.say(format!("engines: auto, {}", all_ids().join(", ")), "ErrorMsg");
    }
    app.engines.preferred = if value == "auto" { "auto" } else { intern(value).unwrap_or("auto") };
    let now = app.new_agent_engine();
    let warn = match app.engines.get(now) {
        Some(e) if !e.connected => {
            let how = if e.installed { format!("not signed in{}", e.connect.as_ref().map(|c| format!(": run {c}")).unwrap_or_default()) } else { "not installed".into() };
            format!(" ({how})")
        }
        _ => String::new(),
    };
    let open = match app.focused() {
        Some(s) if s.engine != now => format!(" · '{}' stays on {}; :new <task> starts one on {}", s.name, engine_name(&s.engine), engine_name(now)),
        _ => String::new(),
    };
    let auto = if value == "auto" { " (auto)" } else { "" };
    let group = if warn.is_empty() { "ModeMsg" } else { "WarningMsg" };
    app.say(format!("new agents run on {}{auto}{warn}{open} · :settings, w keeps it", engine_name(now)), group);
}

/// Claude Code refused agent `i` some tools ([engines.claude] ask = true): allow them for
/// one retry, always ([engines.claude] allow, for this session), or leave them blocked (TS askToAllow).
pub fn ask_to_allow(app: &mut App, i: usize) {
    let Some(ask) = app.sessions[i].ask.clone() else { return };
    let list = ask.missing.join(", ");
    let items = vec![
        Choice::new("allow once", None, Some(&format!("{list}, for this retry"))),
        Choice::new("always allow", None, Some(&format!("{list}, saved to [engines.claude] allow"))),
        Choice::new("no", None, Some("leave it blocked")),
    ];
    let title = format!("'{}' was blocked · {}", app.sessions[i].name, ask.what);
    let p = Picker::new(&title, Some(items), "", false, Some(3), Box::new(move |app, v| {
        let s = &mut app.sessions[i];
        // aborted, or a new prompt was sent meanwhile
        if s.ask.take().is_none() || s.state != crate::session::State::Waiting {
            return;
        }
        let choice = v.as_deref().filter(|v| *v != "no");
        let Some(choice) = choice else {
            s.items.push(crate::session::Item::Info("left blocked".into()));
            s.state = crate::session::State::Idle;
            return app.drain(i);
        };
        let always = choice == "always allow";
        if always {
            // kept for this session; writing it to config.toml waits for the Config area's
            // line-by-line editor (src/config-edit.ts setTomlValue)
            let mut o = app.config.engine_options("claude").cloned().unwrap_or_default();
            let mut allow = o.allow.unwrap_or_default();
            for r in &ask.missing {
                if !allow.contains(r) {
                    allow.push(r.clone());
                }
            }
            o.allow = Some(allow);
            match app.config.engines.iter_mut().find(|(k, _)| k == "claude") {
                Some(slot) => slot.1 = o,
                None => app.config.engines.push(("claude".into(), o)),
            }
        }
        let how = if always { "always allowed" } else { "allowed once" };
        app.sessions[i].items.push(crate::session::Item::Info(format!("{how}: {} · retrying", ask.missing.join(", "))));
        // the retry runs with the rules allowed; it isn't a prompt of yours, so it stays out of the transcript
        let text = format!("You now have permission to use {}. Retry what was blocked, then carry on with the task.", ask.rules.join(", "));
        let mut l = launch(app, "claude");
        for r in &ask.missing {
            if !l.allow.contains(r) {
                l.allow.push(r.clone());
            }
        }
        let tx = app.tx.clone();
        let s = &mut app.sessions[i];
        s.send(text.clone(), &l, tx);
        if let Some(j) = s.items.iter().rposition(|x| *x == crate::session::Item::User(text.clone())) {
            s.items.remove(j);
        }
    }));
    picker::open(app, p);
}

/// Model and effort for new agents at startup: [engines.<id>] model/effort, `model` (pi's), and --model
/// (pi's, or the --engine CLI's) (cli.ts: newAgentModel, piModel, requested).
pub fn startup(app: &mut App, model_arg: Option<&str>, engine_arg: Option<&str>) {
    let cfg = app.config.clone();
    for (id, o) in &cfg.engines {
        if let Some(m) = &o.model {
            app.engines.new_model.insert(id.clone(), m.clone());
        }
        if let Some(e) = &o.effort {
            app.engines.new_effort.insert(id.clone(), e.clone());
        }
    }
    let pi = match (model_arg, engine_arg) {
        (Some(m), None | Some("pi")) => Some(m.to_string()),
        _ => cfg.engine_options("pi").and_then(|o| o.model.clone()).or(cfg.model.clone()),
    };
    if let Some(m) = pi {
        app.engines.new_model.insert("pi".into(), m);
    }
    if let (Some(m), Some(e)) = (model_arg, engine_arg)
        && e != "pi"
        && cfg.engine_options(e).and_then(|o| o.model.as_ref()).is_none()
    {
        app.engines.new_model.insert(e.into(), m.into());
    }
    // engine: --engine, else config's (auto lets default_engine() pick)
    let chosen = engine_arg.map(str::to_string).or_else(|| cfg.engine.clone().filter(|e| e != "auto"));
    app.engines.preferred = chosen.as_deref().and_then(intern).unwrap_or("auto");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::engines::EngineInfo;

    fn info(id: &str, installed: bool, connected: bool, connect: Option<&str>) -> EngineInfo {
        EngineInfo { id: id.into(), name: engine_name(id), installed, connected, connect: connect.map(str::to_string), ..Default::default() }
    }

    #[test]
    fn engine_picks_for_new_agents_and_leaves_open_ones_alone() {
        let mut a = app();
        a.engines.infos = vec![info("pi", true, true, None), info("claude", true, true, None), info("codex", true, false, Some("codex login")), info("opencode", false, false, None)];
        assert_eq!(engine_note(&a, "auto"), "pick for me (now Claude Code)");
        assert_eq!(engine_note(&a, "claude"), "Claude Code · ready");
        assert_eq!(engine_note(&a, "codex"), "Codex · not signed in: codex login");
        assert_eq!(engine_note(&a, "opencode"), "OpenCode · not installed");
        choose_engine(&mut a, "claude");
        assert_eq!(a.engines.preferred, "claude");
        assert!(a.message.0.starts_with("new agents run on Claude Code"));
        let mut s = Session::new(0, "old", "pi", "/nope".into());
        s.engine = "pi".into();
        a.sessions.push(s);
        a.focus = 0;
        choose_engine(&mut a, "codex");
        assert!(a.message.0.contains("new agents run on Codex (not signed in: run codex login)"));
        assert!(a.message.0.contains("'old' stays on pi; :new <task> starts one on Codex"));
        choose_engine(&mut a, "gpt");
        assert!(a.message.0.starts_with("engines: auto, pi, claude, codex, opencode"));
        assert_eq!(a.engines.preferred, "codex");
    }

    #[test]
    fn model_and_effort_with_no_agent_set_them_for_new_agents() {
        let mut a = app();
        a.engines.preferred = "codex";
        let t = target(&a);
        choose_model(&mut a, "gpt-5-codex", &t);
        choose_effort(&mut a, "xhigh", &t);
        assert_eq!(a.message.0, "effort for new Codex agents: xhigh");
        let mut s = Session::new(0, "x", "codex", "/nope".into());
        configure_new(&a, &mut s, &StartOpts::default());
        assert_eq!((s.requested_model.as_deref(), s.effort.as_deref()), (Some("gpt-5-codex"), Some("xhigh")));
    }

    #[test]
    fn model_and_effort_for_the_focused_agent() {
        let mut a = app();
        a.sessions.push(Session::new(0, "racer", "claude", "/nope".into()));
        a.focus = 0;
        let t = target(&a);
        choose_model(&mut a, "claude-opus-5-5", &t);
        assert_eq!(a.message.0, "model for 'racer': Claude Opus 5.5 (from the next prompt)");
        choose_effort(&mut a, "high", &t);
        assert_eq!(super::super::model_text(&a.sessions[0]), "Claude Code · claude-opus-5-5 · high");
        choose_effort(&mut a, "off", &t);
        assert_eq!(a.message.0, "Claude Code takes: default, low, medium, high, xhigh, max");
        choose_effort(&mut a, "default", &t);
        assert_eq!(a.sessions[0].effort, None);
        // a GPT model from a Claude agent: new agents run on Codex with it
        choose_model(&mut a, "codex:gpt-5.5-codex", &t);
        assert_eq!(a.sessions[0].requested_model.as_deref(), Some("claude-opus-5-5"), "the Claude agent keeps its model");
        assert_eq!((a.engines.preferred, a.engines.new_model.get("codex").map(String::as_str)), ("codex", Some("gpt-5.5-codex")));
        assert_eq!(a.message.0, "'racer' keeps its model (its conversation can't move) · new agents use GPT-5.5 Codex · :new <task> starts one");
        choose_model(&mut a, "claude:claude-haiku-5-5", &t);
        assert_eq!(a.sessions[0].requested_model.as_deref(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn a_first_prompt_that_cant_start_says_why() {
        let mut a = app();
        a.engines.infos = vec![EngineInfo { install: Some("npm install -g @anthropic-ai/claude-code".into()), ..info("claude", false, false, None) }];
        a.engines.preferred = "claude";
        assert_eq!(cant_start(&a, None).unwrap(), "Claude Code isn't installed: npm install -g @anthropic-ai/claude-code · :checkhealth");
        a.engines.preferred = "auto";
        a.engines.infos = vec![
            info("pi", true, false, Some("export ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY)")),
            info("claude", true, false, Some("claude auth login")),
            info("codex", true, false, Some("codex login")),
            info("opencode", false, false, None),
        ];
        assert_eq!(cant_start(&a, None).unwrap(), "no engine is signed in: run claude auth login or codex login, or for pi export ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY) · :checkhealth");
        assert_eq!(cant_start(&a, Some("claude")), None, "an engine you picked yourself still starts");
    }

    #[test]
    fn a_refused_tool_is_asked_about_when_ask_is_on() {
        let mut a = app();
        let mut s = Session::new(0, "pr", "claude", "/nope".into());
        s.launch.ask = true;
        s.state = crate::session::State::Running;
        s.apply(vec![super::super::Ev::Denied(vec![super::super::permissions::denial("Bash", serde_json::json!({"command": "gh pr view 12"}))])], true);
        assert!(s.ask.is_some());
        a.sessions.push(s);
        a.focus = 0;
        ask_to_allow(&mut a, 0);
        let p = a.engines.picker.as_ref().unwrap();
        assert_eq!(p.title, "'pr' was blocked · gh pr view 12");
        let rows: String = p.render(100, "unicode").iter().flat_map(|r| r.iter().map(|(s, _)| s.clone())).collect();
        assert!(rows.contains("allow once") && rows.contains("always allow") && rows.contains("saved to [engines.claude] allow"));
        // no: left blocked
        a.sessions[0].state = crate::session::State::Waiting;
        crate::engines::picker::key(&mut a, crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Char('q'), crossterm::event::KeyModifiers::NONE));
        assert_eq!(a.sessions[0].items.last(), Some(&crate::session::Item::Info("left blocked".into())));
    }

    #[test]
    fn all_models_in_one_list() {
        let env = crate::engines::detect::tests::env(&[("PATH", "")]);
        let l = all_model_choices("claude", &["claude".into(), "codex".into()], &env);
        assert_eq!(l[0].value, "default");
        assert_eq!(l[0].note, None);
        assert_eq!(l.iter().filter(|c| c.value.contains("default")).count(), 1, "one Default");
        assert_eq!(l.len(), 5, "no Codex models without Codex installed");
    }
}
