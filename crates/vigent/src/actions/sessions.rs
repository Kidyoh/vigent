//! Sessions area actions: switching agents, starting, stopping, pausing,
//! killing (asks first), the conversation tree.

use super::Action;
use crate::app::App;

pub static ACTIONS: &[Action] = &[
    Action { name: "session.next", run: next },
    Action { name: "session.tab", run: next },
    Action { name: "session.prev", run: prev },
    Action { name: "session.goto", run: goto },
    Action { name: "session.alternate", run: alternate },
    Action { name: "session.new", run: |app, _| crate::commands::exec(app, "new") },
    Action { name: "session.kill", run: kill },
    Action { name: "session.pause", run: |app, _| crate::commands::exec(app, "pause") },
    Action { name: "session.resume", run: |app, _| crate::commands::exec(app, "resume") },
    Action { name: "session.abort", run: abort },
    Action { name: "session.tree", run: |app, _| crate::commands::exec(app, "tree") },
];

fn next(app: &mut App, _: Option<&str>) {
    app.switch(1);
}

fn prev(app: &mut App, _: Option<&str>) {
    app.switch(-1);
}

fn goto(app: &mut App, arg: Option<&str>) {
    match arg.and_then(|a| a.parse::<usize>().ok()).filter(|&n| n >= 1) {
        Some(n) => app.focus_agent(n - 1),
        None => app.say(format!("session.goto needs a number, got '{}'", arg.unwrap_or("")), "ErrorMsg"),
    }
}

/// <C-^>: the agent you were on before.
fn alternate(app: &mut App, _: Option<&str>) {
    let alt = app.agents.alt;
    app.focus_slot(alt);
}

/// dd: kill the focused agent, once you've said yes.
fn kill(app: &mut App, _: Option<&str>) {
    let Some(a) = app.focused() else { return };
    let keep = if a.own_worktree() { " (its worktree is kept)" } else { "" };
    let question = format!("Kill '{}'{keep}? [y/N]", a.name);
    app.ask(question, Box::new(|app: &mut App| crate::commands::exec(app, "kill")));
}

/// <C-c>: stop the focused agent's current run.
fn abort(app: &mut App, _: Option<&str>) {
    let Some(i) = app.focused().map(|s| s.slot) else { return };
    let s = &mut app.sessions[i];
    if s.state == crate::session::State::Running {
        s.abort();
        let msg = format!("stopped '{}'", s.name);
        app.say(msg, "WarningMsg");
    }
}
