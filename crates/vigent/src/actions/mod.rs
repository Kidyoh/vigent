//! What each key action does: handlers by the names keymaps use
//! (keys.rs ACTIONS lists every name with its description).
//!
//! EXTENSION POINT: to make an action work, add an [`Action`] to the `ACTIONS`
//! list in actions/<area>.rs (that file is the area's alone):
//!
//!   Action { name: "fold.toggle", run: fold_toggle },
//!   fn fold_toggle(app: &mut App, arg: Option<&str>) { ... }
//!
//! A name in keys::ACTIONS with no handler yet does nothing, so every default
//! key of the TypeScript vigent is bound from the start and lights up as its
//! area ports it.

pub mod config;
pub mod core;
pub mod engines;
pub mod review;
pub mod serve;
pub mod sessions;
pub mod windows;

use crate::app::App;

pub type Handler = fn(&mut App, Option<&str>);

pub struct Action {
    pub name: &'static str,
    pub run: Handler,
}

/// Every area's actions.
pub static TABLES: &[&[Action]] = &[core::ACTIONS, sessions::ACTIONS, engines::ACTIONS, review::ACTIONS, windows::ACTIONS, config::ACTIONS, serve::ACTIONS];

pub fn find(name: &str) -> Option<Handler> {
    TABLES.iter().flat_map(|t| t.iter()).find(|a| a.name == name).map(|a| a.run)
}

/// Run an action by name (from a key, a mapping, or :normal-style replays).
pub fn run(app: &mut App, name: &str, arg: Option<&str>) {
    match find(name) {
        Some(f) => f(app, arg),
        None if crate::keys::is_action(name) => {} // not ported yet: see PORTING.md
        None => app.say(format!("unknown action '{name}'"), "ErrorMsg"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_handler_is_a_known_action_and_only_once() {
        let mut seen = std::collections::HashSet::new();
        for a in super::TABLES.iter().flat_map(|t| t.iter()) {
            assert!(crate::keys::is_action(a.name), "'{}' isn't in keys::ACTIONS", a.name);
            assert!(seen.insert(a.name), "'{}' has two handlers", a.name);
        }
    }
}
