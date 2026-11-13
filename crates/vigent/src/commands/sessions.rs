//! Sessions area: agents and their lives (:new, :kill, :queue, :pause,
//! :resume, :attach, :worktrees, :race, :templates, :tree, ...).

use super::{Command, Ex};
use crate::app::App;

pub static COMMANDS: &[Command] = &[
    Command { name: "new", aliases: &[], also: None, run: new },
    Command { name: "kill", aliases: &["bdelete", "bd"], also: None, run: kill },
];

/// :new <task>: another agent, in its own worktree, with the task as its first prompt.
fn new(app: &mut App, ex: &Ex) {
    if ex.bang {
        // Sessions area: :new! starts an agent in your checkout (no worktree), as src/app.ts does
        return app.say("E477: No ! allowed", "ErrorMsg");
    }
    if ex.arg.is_empty() {
        return app.say("usage: :new <task>", "ErrorMsg");
    }
    let name = crate::names::agent_name_from(ex.arg);
    if let Some(i) = app.start_agent(&name) {
        app.sessions[i].queue.push_back(ex.arg.to_string());
        app.drain(i);
    }
}

/// :kill: stop the focused agent and close it; :kill! also removes its worktree.
fn kill(app: &mut App, ex: &Ex) {
    app.kill_focused(ex.bang);
}
