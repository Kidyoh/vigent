//! Core actions: modes, the prompt and command lines, help, quitting.
//! (Windows area: a real line editor, src/line-edit.ts, for the edit.* motions.)

use super::Action;
use crate::app::{App, Mode};

pub static ACTIONS: &[Action] = &[
    Action { name: "mode.normal", run: mode_normal },
    Action { name: "mode.insert", run: mode_insert },
    Action { name: "mode.insert_start", run: mode_insert },
    Action { name: "mode.append_end", run: mode_insert },
    Action { name: "mode.command", run: mode_command },
    Action { name: "edit.submit", run: submit },
    Action { name: "edit.backspace", run: backspace },
    Action { name: "edit.delete_word", run: delete_word },
    Action { name: "edit.clear", run: clear },
    Action { name: "app.help", run: help },
    Action { name: "app.quit", run: quit },
    Action { name: "app.quit_force", run: quit_force },
    Action { name: "app.quit_hint", run: quit_hint },
    Action { name: "noop", run: noop },
];

fn mode_normal(app: &mut App, _: Option<&str>) {
    if app.mode == Mode::Command {
        app.cmd.clear();
    }
    app.mode = Mode::Normal;
}

/// INSERT: a prompt for the focused agent, or (with none) the task for a new one
/// (if no agent can start, Enter says why, as in TypeScript).
fn mode_insert(app: &mut App, _: Option<&str>) {
    app.mode = Mode::Insert;
}

fn mode_command(app: &mut App, _: Option<&str>) {
    app.mode = Mode::Command;
    app.cmd.clear();
}

fn submit(app: &mut App, _: Option<&str>) {
    match app.mode {
        Mode::Insert => app.submit(),
        Mode::Command => {
            app.mode = Mode::Normal;
            let cmd = std::mem::take(&mut app.cmd);
            crate::commands::exec(app, cmd.trim());
        }
        _ => {}
    }
}

fn line(app: &mut App) -> Option<&mut String> {
    match app.mode {
        Mode::Insert => Some(&mut app.input),
        Mode::Command => Some(&mut app.cmd),
        _ => None,
    }
}

fn backspace(app: &mut App, _: Option<&str>) {
    if app.mode == Mode::Command && app.cmd.is_empty() {
        app.mode = Mode::Normal; // vim: backspace on an empty command line leaves it
        return;
    }
    if let Some(l) = line(app) {
        l.pop();
    }
}

fn delete_word(app: &mut App, _: Option<&str>) {
    if let Some(l) = line(app) {
        let t = l.trim_end().len();
        let cut = l[..t].rfind(' ').map(|i| i + 1).unwrap_or(0);
        l.truncate(cut);
    }
}

fn clear(app: &mut App, _: Option<&str>) {
    if let Some(l) = line(app) {
        l.clear();
    }
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
