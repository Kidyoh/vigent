//! Review area actions. Most of its keys are mappings to :diff, :merge, :pr,
//! :review and :dash; `app.dashboard` is the action behind :dash.

use super::Action;
use crate::app::App;

pub static ACTIONS: &[Action] = &[Action { name: "app.dashboard", run: dashboard }];

fn dashboard(app: &mut App, _: Option<&str>) {
    crate::review::views::open_dashboard(app);
}
