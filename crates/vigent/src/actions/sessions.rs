//! Sessions area actions: switching agents, stopping a run
//! (still to port: session.alternate, session.new, session.kill (asks first),
//! session.pause, session.resume, session.tree).

use super::Action;
use crate::app::App;

pub static ACTIONS: &[Action] = &[
    Action { name: "session.next", run: next },
    Action { name: "session.tab", run: next },
    Action { name: "session.prev", run: prev },
    Action { name: "session.goto", run: goto },
    Action { name: "session.abort", run: abort },
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
