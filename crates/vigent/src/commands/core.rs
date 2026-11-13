//! Core commands: quitting and :help. (:q closes a split first.)

use super::{Command, Ex};
use crate::app::App;
use crate::session::State;

pub static COMMANDS: &[Command] = &[
    Command { name: "q", aliases: &["quit", "x", "wq", "qa", "qall", "xa", "wqa"], also: None, run: quit },
    Command { name: "help", aliases: &["h"], also: None, run: help },
];

/// :q / :qa: quit, unless an agent is running (:q! quits anyway).
fn quit(app: &mut App, ex: &Ex) {
    // :q closes a split first (:qa quits from any)
    let all = matches!(ex.name.trim_end_matches('!'), "qa" | "qall" | "xa" | "wqa");
    if !all && app.windows.layout.count() > 1 {
        return crate::actions::windows::close_window(app);
    }
    if !ex.bang {
        let running = app.sessions.iter().filter(|s| !s.closed && s.state == State::Running).count();
        if running > 0 {
            let are = if running == 1 { " is" } else { "s are" };
            return app.say(format!("E37: {running} agent{are} still running (add ! to quit anyway)"), "ErrorMsg");
        }
    }
    app.quit = true;
}

fn help(app: &mut App, _ex: &Ex) {
    crate::help::open(app);
}
