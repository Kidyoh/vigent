//! Sessions area: agents and their lives (:new, :kill, :queue, :pause,
//! :resume, :attach, :worktrees, :tree). What they do is in agents.rs.
//! (Still to port: :race, :templates.)

use super::{Command, Ex};
use crate::agents::NewAgent;
use crate::app::App;

pub static COMMANDS: &[Command] = &[
    Command { name: "new", aliases: &[], also: None, run: new },
    Command { name: "kill", aliases: &["bdelete", "bd"], also: None, run: kill },
    Command { name: "queue", aliases: &[], also: None, run: queue },
    Command { name: "pause", aliases: &[], also: None, run: |app, _| app.pause_focused() },
    Command { name: "resume", aliases: &[], also: None, run: |app, _| app.resume_focused() },
    Command { name: "attach", aliases: &[], also: None, run: |app, ex| app.attach(ex.arg) },
    Command { name: "worktrees", aliases: &["worktree", "wt"], also: None, run: worktrees },
    Command { name: "tree", aliases: &[], also: None, run: tree },
];

/// :new's arguments (src/app.ts exec "new"): the name, and --model, --engine / -e, --template / -t.
#[derive(Debug, Default, PartialEq)]
pub struct NewArgs {
    pub name: String,
    pub model: Option<String>,
    pub engine: Option<String>,
    pub template: Option<String>,
}

pub fn parse_new(arg: &str) -> NewArgs {
    let mut a = NewArgs::default();
    let mut rest: Vec<&str> = vec![];
    let words: Vec<&str> = arg.split_whitespace().collect();
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        let flag = |names: &[&str]| -> Option<Option<String>> {
            for n in names {
                if let Some(v) = w.strip_prefix(&format!("{n}=")) {
                    return Some(Some(v.to_string()));
                }
                if w == *n {
                    return Some(words.get(i + 1).map(|s| s.to_string()));
                }
            }
            None
        };
        let took_next = |v: &Option<String>| !w.contains('=') && v.is_some();
        if a.model.is_none()
            && let Some(v) = flag(&["--model"])
            && v.is_some()
        {
            i += if took_next(&v) { 2 } else { 1 };
            a.model = v;
            continue;
        }
        if a.engine.is_none()
            && let Some(v) = flag(&["--engine", "-e"])
            && v.is_some()
        {
            i += if took_next(&v) { 2 } else { 1 };
            a.engine = v;
            continue;
        }
        if a.template.is_none()
            && let Some(v) = flag(&["--template", "-t"])
            && v.is_some()
        {
            i += if took_next(&v) { 2 } else { 1 };
            a.template = v;
            continue;
        }
        rest.push(w);
        i += 1;
    }
    a.name = rest.join(" ");
    a
}

/// `:new <name>`: another agent, in its own worktree; `:new!` one in your checkout.
fn new(app: &mut App, ex: &Ex) {
    let a = parse_new(ex.arg);
    if let Some(t) = a.template {
        // Sessions area, still to port: templates (src/templates.ts, App.startFromTemplate)
        return app.say(format!("no template '{t}' in this build yet"), "ErrorMsg");
    }
    let name = if a.name.is_empty() { format!("agent-{}", app.open().len() + 1) } else { a.name };
    app.start_agent(&name, NewAgent { worktree: Some(!ex.bang), model: a.model, engine: a.engine, effort: None });
}

/// :kill: stop the focused agent and close it; :kill! also removes its worktree.
fn kill(app: &mut App, ex: &Ex) {
    app.kill_focused(ex.bang);
}

/// :queue <prompt> sends it after the current run; :queue lists what's waiting.
fn queue(app: &mut App, ex: &Ex) {
    app.queue_cmd(ex.raw);
}

/// :worktrees; :worktree remove[!] <branch>.
fn worktrees(app: &mut App, ex: &Ex) {
    // `:worktree remove! x` forces; `:worktree! ...` isn't a command
    if ex.bang {
        return app.say(format!("E492: Not an editor command: {}", ex.name), "ErrorMsg");
    }
    app.worktrees(ex.arg);
}

/// :tree, the conversation's branches: kept by pi agents only (Engines area: pi), so CLI agents say so.
fn tree(app: &mut App, _: &Ex) {
    let Some(a) = app.focused() else { return app.say("no agent (:new <task> starts one)", "ErrorMsg") };
    let msg = format!("'{}' has no conversation tree (demo agents don't keep one)", a.name);
    app.say(msg, "Comment");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_reads_its_flags_anywhere() {
        let a = parse_new("perf cache --engine codex --model=o3 warmup -t fix");
        assert_eq!(a, NewArgs { name: "perf cache warmup".into(), model: Some("o3".into()), engine: Some("codex".into()), template: Some("fix".into()) });
        assert_eq!(parse_new("").name, "");
        assert_eq!(parse_new("x -e=claude").engine.as_deref(), Some("claude"));
    }
}
