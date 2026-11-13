//! Session templates (src/templates.ts): a prompt you start agents with often,
//! with the engine, model and effort it should run on.
//!
//!   [templates.fix]
//!   prompt = "Find and fix this bug: {task}. Reproduce it with a failing test first."
//!   engine = "claude"
//!   effort = "high"
//!
//! `:new -t fix the cart total is off` (or `:template fix ...`) starts an agent
//! and sends the prompt, with `{task}` replaced by what you typed. A few are
//! built in; a template in config.toml with the same name replaces the
//! built-in one. `:templates` (and T on the start screen) picks one.

use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use crate::app::{App, Mode};
use crate::config::Template;
use crate::settings::truncate;
use crate::ui::text::width;

fn builtin(name: &str, description: &str, prompt: &str) -> Template {
    Template { name: name.into(), description: Some(description.into()), prompt: prompt.into(), ..Default::default() }
}

/// The built-in templates: fix, test, review, explain.
pub fn builtins() -> Vec<Template> {
    vec![
        builtin("fix", "reproduce a bug with a failing test, then fix it", "Find and fix this bug: {task}\n\nFirst reproduce it with a failing test. Then make the smallest change that makes the test pass, and run the whole test suite before you finish."),
        builtin("test", "write tests in the project's own style", "Write tests for {task}. Cover the usual cases and the edge cases, follow the style of the tests already in the project, and run them. Don't change the code under test; if a test finds a bug, say so."),
        builtin(
            "review",
            "review this branch's work; changes nothing",
            "Review the work on this branch: compare it with the branch it started from using git. Look for bugs, missing tests and code that's hard to follow.{task}\n\nList what you find by file and line, most serious first. Don't change any files.",
        ),
        builtin("explain", "how something works and where it lives; changes nothing", "Explain {task}: how it works, where it lives in the code, and what would break if it changed. Don't change any files."),
    ]
}

/// A template and whether it's a built-in one.
pub type Entry = (Template, bool);

/// Built-ins first, then yours (yours replace a built-in of the same name), in config order.
pub fn all(user: &[Template]) -> Vec<Entry> {
    let b = builtins();
    let mut out: Vec<Entry> = b.iter().map(|t| user.iter().find(|u| u.name == t.name).map(|u| (u.clone(), false)).unwrap_or((t.clone(), true))).collect();
    for u in user {
        if !b.iter().any(|t| t.name == u.name) {
            out.push((u.clone(), false));
        }
    }
    out
}

/// Whether the prompt has a place for the task.
pub fn needs_task(t: &Template) -> bool {
    t.prompt.contains("{task}")
}

/// The prompt for a task: `{task}` takes it; a template without one gets it
/// added after. The built-in review's `{task}` is an optional focus.
pub fn fill(t: &Template, is_builtin: bool, task: &str) -> String {
    let text = task.trim();
    if !needs_task(t) {
        return if text.is_empty() { t.prompt.clone() } else { format!("{}\n\n{text}", t.prompt) };
    }
    if t.name == "review" && is_builtin {
        return t.prompt.replacen("{task}", &if text.is_empty() { String::new() } else { format!(" Focus on: {text}.") }, 1);
    }
    t.prompt.replace("{task}", text)
}

/// Options `:new` passes along: --model, --engine, and `:new!` (no worktree).
#[derive(Default, Clone)]
pub struct StartOpts {
    pub worktree: Option<bool>,
    pub model: Option<String>,
    pub engine: Option<String>,
}

/// `:new -t <name> <task>`: start an agent from a template and send it the prompt.
pub fn start(app: &mut App, name: &str, task: &str, opts: StartOpts) -> Option<usize> {
    let list = all(&app.config.templates);
    let Some((t, is_builtin)) = list.iter().find(|(t, _)| t.name == name).cloned() else {
        let names: Vec<&str> = list.iter().map(|(t, _)| t.name.as_str()).collect();
        app.say(format!("no template '{name}'{} · :templates lists them", crate::suggest::did_you_mean(name, names)), "ErrorMsg");
        return None;
    };
    if needs_task(&t) && task.is_empty() && !(is_builtin && t.name == "review") {
        app.say(format!("template '{}' needs a task: :new -t {} <what>", t.name, t.name), "ErrorMsg");
        app.mode = Mode::Command;
        app.cmd = format!("new -t {} ", t.name);
        return None;
    }
    let engine = opts.engine.clone().or(t.engine.clone());
    let model = opts.model.clone().or_else(|| if engine == t.engine || t.engine.is_none() { t.model.clone() } else { None });
    let effort = if opts.engine.is_none() || opts.engine == t.engine { t.effort.clone() } else { None };
    let agent_name = if task.is_empty() { t.name.clone() } else { crate::names::agent_name_from(task) };
    let i = app.start_agent(&agent_name)?;
    {
        let s = &mut app.sessions[i];
        if let Some(e) = engine {
            s.engine = e;
        }
        if model.is_some() {
            s.requested_model = model.clone();
            s.model = model;
        }
        if effort.is_some() {
            s.effort = effort;
        }
    }
    let prompt = fill(&t, is_builtin, task);
    match app.sessions[i].submit(prompt) {
        crate::session::Submitted::Now(text) => app.send(i, text),
        crate::session::Submitted::Queued(_) => {}
    }
    let (msg, group) = app.message.clone();
    app.say(format!("{msg} · template {}", t.name), group);
    Some(i)
}

/// `:templates` / `:template` / `:tpl [name task]`
pub fn exec(app: &mut App, arg: &str) {
    if arg.is_empty() {
        return open(app);
    }
    let (name, task) = arg.split_once(char::is_whitespace).map(|(n, t)| (n, t.trim())).unwrap_or((arg, ""));
    start(app, name, task, StartOpts::default());
}

/// The template picker (a choice list: j/k, Enter, q).
pub struct Picker {
    rows: Vec<(String, String)>,
    index: usize,
}

pub fn open(app: &mut App) {
    app.seq.reset();
    let rows = all(&app.config.templates)
        .into_iter()
        .map(|(t, is_builtin)| {
            let how: Vec<String> = [t.engine.as_deref().map(crate::engines::engine_name), t.model.clone(), t.effort.clone()].into_iter().flatten().filter(|s| !s.is_empty()).collect();
            let what = t.description.clone().unwrap_or_else(|| t.prompt.lines().next().unwrap_or_default().to_string());
            let how = if how.is_empty() { String::new() } else { format!(" ({})", how.join(" · ")) };
            let yours = if is_builtin { "" } else { " · yours" };
            (t.name, format!("{what}{how}{yours}"))
        })
        .collect();
    app.cfg.templates = Some(Picker { rows, index: 0 });
}

fn choose(app: &mut App, name: &str) {
    let list = all(&app.config.templates);
    let found = list.iter().find(|(t, _)| t.name == name).cloned();
    if let Some((t, _)) = &found
        && !needs_task(t)
    {
        start(app, name, "", StartOpts::default());
        return;
    }
    app.mode = Mode::Command;
    app.cmd = format!("new -t {name} ");
    let review = found.is_some_and(|(t, b)| b && t.name == "review");
    app.say(if review { "what to focus on (optional), then Enter" } else { "what it's for, then Enter" }, "Comment");
}

pub fn key(app: &mut App, k: KeyEvent) {
    let Some(token) = crate::keys::token_from_event(&k) else { return };
    feed(app, &token);
}

pub fn feed(app: &mut App, key: &str) {
    let Some(mut p) = app.cfg.templates.take() else { return };
    let n = p.rows.len().max(1);
    match key {
        "q" | "<Esc>" | "<C-c>" => return,
        "j" | "<Down>" | "<Tab>" | "<C-n>" => p.index = (p.index + 1) % n,
        "k" | "<Up>" | "<S-Tab>" | "<C-p>" => p.index = (p.index + n - 1) % n,
        "g" => p.index = 0,
        "G" => p.index = n - 1,
        "<CR>" => {
            if let Some((name, _)) = p.rows.get(p.index).cloned() {
                choose(app, &name);
            }
            return;
        }
        _ => {}
    }
    app.cfg.templates = Some(p);
}

pub fn draw(f: &mut Frame, app: &App, area: Rect) {
    let Some(p) = &app.cfg.templates else { return };
    let t = &app.theme;
    let ascii = app.config.ui.icons == "ascii";
    let (tl, tr, bl, br, hz, vt) = if ascii { ("+", "+", "+", "+", "-", "|") } else { ("╭", "╮", "╰", "╯", "─", "│") };
    let w = 96.min(area.width.saturating_sub(4)).max(20) as usize;
    let inner = w - 2;
    let bg = t.hl("NormalFloat").bg;
    let on = |g: &str, b| Style { bg: b, ..t.hl(g) };
    let border = on("FloatBorder", bg);
    let sel_bg = t.hl("PmenuSel").bg.or(t.hl("Visual").bg);
    let title = " Start an agent from a template ";
    let mut lines = vec![Line::from(vec![Span::styled(format!("{tl}{hz}"), border), Span::styled(title, on("FloatTitle", bg)), Span::styled(format!("{}{tr}", hz.repeat(inner.saturating_sub(1 + width(title)))), border)])];
    let name_w = p.rows.iter().map(|(n, _)| width(n)).max().unwrap_or(4).min(20);
    for (i, (name, note)) in p.rows.iter().enumerate() {
        let selected = i == p.index;
        let rbg = if selected { sel_bg } else { bg };
        let group = if selected { "PmenuSel" } else { "NormalFloat" };
        let left = format!(" {name}{} ", " ".repeat(name_w.saturating_sub(width(name))));
        let note = truncate(note, inner.saturating_sub(width(&left) + 1), "…");
        let used = width(&left) + width(&note);
        lines.push(Line::from(vec![
            Span::styled(vt.to_string(), border),
            Span::styled(left, on(group, rbg)),
            Span::styled(note, on("Comment", rbg)),
            Span::styled(" ".repeat(inner.saturating_sub(used)), on("NormalFloat", rbg)),
            Span::styled(vt.to_string(), border),
        ]));
    }
    let keys = " j/k move · Enter pick · q close ";
    lines.push(Line::from(vec![Span::styled(format!("{bl}{}", hz.repeat(inner.saturating_sub(width(keys) + 1))), border), Span::styled(keys, on("Comment", bg)), Span::styled(format!("{hz}{br}"), border)]));
    let h = (lines.len() as u16).min(area.height);
    let r = Rect::new(area.x + (area.width.saturating_sub(w as u16)) / 2, area.y + (area.height - h) / 2, w as u16, h);
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines), r);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filling_and_layering() {
        let user = vec![Template { name: "fix".into(), prompt: "my fix: {task}".into(), ..Default::default() }, Template { name: "migrate".into(), prompt: "migrate".into(), ..Default::default() }];
        let a = all(&user);
        let names: Vec<&str> = a.iter().map(|(t, _)| t.name.as_str()).collect();
        assert_eq!(names, ["fix", "test", "review", "explain", "migrate"]);
        assert!(!a[0].1, "yours replaces the built-in");
        assert_eq!(fill(&a[0].0, false, " the cart "), "my fix: the cart");
        assert_eq!(fill(&a[4].0, false, "users"), "migrate\n\nusers");
        assert_eq!(fill(&a[4].0, false, ""), "migrate");
        assert!(fill(&a[2].0, true, "").contains("hard to follow.\n\nList"));
        assert!(fill(&a[2].0, true, "auth").contains("hard to follow. Focus on: auth.\n\nList"));
    }

    #[test]
    fn a_template_without_a_task_asks_for_one() {
        let mut a = crate::app::tests::app();
        start(&mut a, "fix", "", StartOpts::default());
        assert_eq!(a.message.0, "template 'fix' needs a task: :new -t fix <what>");
        assert_eq!((a.mode, a.cmd.as_str()), (Mode::Command, "new -t fix "));
        start(&mut a, "fx", "x", StartOpts::default());
        assert!(a.message.0.starts_with("no template 'fx' (did you mean 'fix'?)"), "{}", a.message.0);
        open(&mut a);
        feed(&mut a, "j");
        feed(&mut a, "<CR>");
        assert_eq!(a.cmd, "new -t test ");
    }
}
