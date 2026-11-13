//! Serve area: following agents from your phone (:serve), :usage / :cost.

use super::{Command, Ex};
use crate::app::App;

pub static COMMANDS: &[Command] = &[
    Command { name: "serve", aliases: &[], also: None, run: serve },
    Command { name: "cost", aliases: &["usage"], also: None, run: cost },
];

/// `:serve [local] [port]`, `:serve stop`
fn serve(app: &mut App, ex: &Ex) {
    crate::serve::exec(app, ex.arg);
}

/// `:cost` / `:usage`
fn cost(app: &mut App, _ex: &Ex) {
    crate::serve::open_usage(app);
}
