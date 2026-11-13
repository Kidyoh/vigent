//! Serve area: following agents from your phone (:serve). (:cost / :usage
//! are the Review area's, review/views.rs.)

use super::{Command, Ex};
use crate::app::App;

pub static COMMANDS: &[Command] = &[
    Command { name: "serve", aliases: &[], also: None, run: serve },
];

/// `:serve [local] [port]`, `:serve stop`
fn serve(app: &mut App, ex: &Ex) {
    crate::serve::exec(app, ex.arg);
}
