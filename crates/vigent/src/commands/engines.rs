//! Engines area: what runs agents (:checkhealth, :model, :engine, :effort,
//! :permissions, :pi).

use super::{Command, Ex};
use crate::app::App;

pub static COMMANDS: &[Command] = &[Command { name: "checkhealth", aliases: &["che", "engines", "health"], also: None, run: checkhealth }];

fn checkhealth(app: &mut App, _ex: &Ex) {
    crate::health::open(app);
}
