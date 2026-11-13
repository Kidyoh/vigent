//! Review area: landing an agent's work (:diff, :review / :hunks, :merge, :pr,
//! :w), comparing agents (:dash, :cost). The work is in review/. (:race is
//! the Sessions area's, commands/sessions.rs.)

use super::{Command, Ex};
use crate::app::App;
use crate::review::{export, views};

pub static COMMANDS: &[Command] = &[
    Command { name: "diff", aliases: &[], also: None, run: diff },
    Command { name: "review", aliases: &["hunks"], also: None, run: review },
    Command { name: "merge", aliases: &[], also: None, run: merge },
    Command { name: "pr", aliases: &[], also: None, run: pr },
    Command { name: "write", aliases: &["w"], also: None, run: write },
    Command { name: "dash", aliases: &["dashboard"], also: None, run: dash },
    Command { name: "cost", aliases: &["usage"], also: None, run: cost },
];

/// `:diff` (unified) / `:diff split|vert|vertical|side` (side by side).
fn diff(app: &mut App, ex: &Ex) {
    views::open_diff(app, matches!(ex.arg, "split" | "vert" | "vertical" | "side"));
}

fn review(app: &mut App, _: &Ex) {
    views::open_review(app);
}

fn merge(app: &mut App, ex: &Ex) {
    views::merge(app, ex.arg);
}

fn pr(app: &mut App, _: &Ex) {
    views::pr(app);
}

/// `:w [file]` writes the transcript as Markdown; `:w!` overwrites.
fn write(app: &mut App, ex: &Ex) {
    export::write(app, ex.arg, ex.bang);
}

fn dash(app: &mut App, _: &Ex) {
    views::open_dashboard(app);
}

fn cost(app: &mut App, _: &Ex) {
    views::open_usage(app);
}
