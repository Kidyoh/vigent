//! Config area actions: the colorscheme picker.

use super::Action;

pub static ACTIONS: &[Action] = &[Action { name: "theme.picker", run: |app, _| crate::looks::open_theme_picker(app) }];
