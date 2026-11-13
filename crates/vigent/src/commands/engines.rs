//! Engines area: what runs agents (:checkhealth, :model, :engine, :effort, :pi).

use super::{Command, Ex};
use crate::app::App;
use crate::engines::select;

pub static COMMANDS: &[Command] = &[
    Command { name: "checkhealth", aliases: &["che", "engines", "health"], also: None, run: checkhealth },
    Command { name: "model", aliases: &["mo"], also: None, run: model },
    Command { name: "engine", aliases: &["eng"], also: None, run: engine },
    Command { name: "effort", aliases: &["think"], also: None, run: effort },
    Command { name: "pi", aliases: &["extensions"], also: None, run: pi },
];

fn checkhealth(app: &mut App, _ex: &Ex) {
    crate::health::open(app);
}

/// `:model [name]`: the picker, or that model for the focused agent (or new agents).
fn model(app: &mut App, ex: &Ex) {
    if ex.arg.is_empty() {
        return select::open_model_picker(app);
    }
    let t = select::target(app);
    select::choose_model(app, ex.arg, &t);
}

/// `:engine [id]`: the engine new agents run on.
fn engine(app: &mut App, ex: &Ex) {
    if ex.arg.is_empty() {
        return select::open_engine_picker(app);
    }
    select::choose_engine(app, ex.arg);
}

/// `:effort [level]`: reasoning effort (pi: thinking level) for the focused agent (or new agents).
fn effort(app: &mut App, ex: &Ex) {
    if ex.arg.is_empty() {
        return select::open_effort_picker(app);
    }
    let t = select::target(app);
    select::choose_effort(app, ex.arg, &t);
}

/// `:pi`: what pi loaded for the focused agent (TS openPiResources).
fn pi(app: &mut App, _ex: &Ex) {
    let Some(s) = app.focused() else { return app.say("no agent yet", "Comment") };
    if s.engine != "pi" {
        let msg = format!(":pi lists a pi agent's extensions; '{}' runs on {}", s.name, crate::engines::engine_name(&s.engine));
        return app.say(msg, "Comment");
    }
    let Some(p) = s.pi.as_ref() else {
        let msg = format!("'{}' is still starting", s.name);
        return app.say(msg, "Comment");
    };
    let home = std::env::var("HOME").unwrap_or_default();
    let short = |p: &str| if !home.is_empty() && p.starts_with(&home) { format!("~{}", &p[home.len()..]) } else { p.to_string() };
    let field = |c: &serde_json::Value, k: &str| c[k].as_str().unwrap_or("").to_string();
    let path_of = |c: &serde_json::Value| c["sourceInfo"]["path"].as_str().or(c["path"].as_str()).unwrap_or("").to_string();
    let of = |src: &str| p.commands.iter().filter(|c| c["source"] == src).collect::<Vec<_>>();
    let mut exts: Vec<String> = vec![];
    for c in of("extension") {
        let pth = path_of(c);
        if !pth.is_empty() && !exts.contains(&pth) && !p.extension_errors.iter().any(|(k, _)| *k == pth) {
            exts.push(pth);
        }
    }
    let mut l: Vec<(String, &'static str)> = vec![];
    let section = |l: &mut Vec<(String, &'static str)>, title: &str, n: usize| {
        if !l.is_empty() {
            l.push((String::new(), "Normal"));
        }
        l.push((format!("{title}  {n}"), "Title"));
    };
    let item = |name: String, note: String| {
        let note = note.split_whitespace().collect::<Vec<_>>().join(" ");
        let note = if note.is_empty() { String::new() } else { format!(" {}", crate::ui::text::fit(&note, 60)) };
        (format!("  {name:<24}{note}"), "Identifier")
    };
    section(&mut l, "Extensions", exts.len() + p.extension_errors.len());
    if exts.is_empty() && p.extension_errors.is_empty() {
        l.push(("  none (~/.pi/agent/extensions/ or .pi/extensions/)".into(), "Comment"));
    }
    for e in &exts {
        l.push((format!("  {}", short(e)), "NormalFloat"));
    }
    for (e, why) in &p.extension_errors {
        l.push((format!("  {}  {why}", short(e)), "ErrorMsg"));
    }
    let cmds = of("extension");
    section(&mut l, "Commands", cmds.len());
    l.extend(cmds.iter().map(|c| item(format!("/{}", field(c, "name")), field(c, "description"))));
    let skills = of("skill");
    section(&mut l, "Skills", skills.len());
    l.extend(skills.iter().map(|c| item(format!("/skill:{}", field(c, "name").trim_start_matches("skill:")), field(c, "description"))));
    let prompts = of("prompt");
    section(&mut l, "Prompt templates", prompts.len());
    l.extend(prompts.iter().map(|c| item(format!("/{}", field(c, "name")), field(c, "description"))));
    let files = context_files(&s.path, &crate::engines::detect::pi_agent_dir(&app.engines.env));
    section(&mut l, "Context files", files.len());
    l.extend(files.iter().map(|f| (format!("  {}", short(&f.to_string_lossy())), "NormalFloat")));
    l.push((String::new(), "Normal"));
    l.push(("pi loads these itself, as in pi".into(), "Comment"));
    let title = format!("pi · {}", s.name);
    app.float = Some(crate::ui::floats::Float::new(&title, l));
}

/// The AGENTS.md (or CLAUDE.md) files pi reads: its own folder's, then each folder from / down to the agent's.
pub fn context_files(cwd: &std::path::Path, agent_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let pick = |d: &std::path::Path| ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].iter().map(|f| d.join(f)).find(|f| f.exists());
    let mut out = vec![];
    if let Some(g) = pick(agent_dir) {
        out.push(g);
    }
    let mut chain = vec![];
    let start = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    for d in start.ancestors() {
        if let Some(f) = pick(d)
            && !out.contains(&f)
        {
            chain.insert(0, f);
        }
    }
    out.extend(chain);
    out
}
