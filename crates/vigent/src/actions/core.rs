//! Core actions: modes, the prompt and command lines, help, quitting.
//! (The line editor, Enter, Esc and the edit.* keys are the Windows area's: actions/windows.rs.)

use super::Action;
use crate::app::{App, Mode};

pub static ACTIONS: &[Action] = &[
    Action { name: "mode.insert", run: mode_insert },
    Action { name: "mode.command", run: mode_command },
    Action { name: "app.help", run: help },
    Action { name: "app.quit", run: quit },
    Action { name: "app.quit_force", run: quit_force },
    Action { name: "app.quit_hint", run: quit_hint },
    Action { name: "noop", run: noop },
];

/// INSERT: a prompt for the focused agent, or (with none) the task for a new one.
fn mode_insert(app: &mut App, _: Option<&str>) {
    app.mode = Mode::Insert;
}

fn mode_command(app: &mut App, _: Option<&str>) {
    app.mode = Mode::Command;
    app.cmd.clear();
}

fn help(app: &mut App, _: Option<&str>) {
    crate::help::open(app);
}

fn quit(app: &mut App, _: Option<&str>) {
    crate::commands::exec(app, "q");
}

fn quit_force(app: &mut App, _: Option<&str>) {
    crate::commands::exec(app, "q!");
}

fn quit_hint(app: &mut App, _: Option<&str>) {
    app.say("Type  :q  and press <Enter> to exit vigent", "Comment");
}

fn noop(_: &mut App, _: Option<&str>) {}
