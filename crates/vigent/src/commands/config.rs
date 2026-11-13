//! Config area: colors, options, mappings and your own commands
//! (:colorscheme, :hi, :set, :nmap, :unmap, :command, :let, :settings, :trust).

use super::{Command, Ex};
use crate::app::App;

pub static COMMANDS: &[Command] = &[Command { name: "theme", aliases: &["colorscheme", "colo"], also: None, run: theme }];

/// :colorscheme <name> (Config area: with no name, the theme picker; :theme save).
fn theme(app: &mut App, ex: &Ex) {
    if ex.arg.is_empty() {
        let msg = format!("{} (:theme <name>; vigent theme list)", app.theme.name);
        return app.say(msg, "Comment");
    }
    match crate::theme::load(ex.arg) {
        Some(t) => {
            app.theme = t;
            app.say(format!("colorscheme {}", ex.arg), "Comment");
        }
        None => app.say(format!("E185: Cannot find color scheme '{}'", ex.arg), "ErrorMsg"),
    }
}
