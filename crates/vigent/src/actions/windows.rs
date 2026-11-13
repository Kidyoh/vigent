//! Windows area actions: scrolling the transcript (still to port: window.*,
//! sidebar.focus, cursor.*, visual.*, view.*, jump.*, fold.*, search.*,
//! message.*, yank.*, mode.search, mode.visual, app.dashboard, app.redraw,
//! app.position, the edit.* motions and history, edit.complete).

use super::Action;
use crate::app::App;

pub static ACTIONS: &[Action] = &[
    Action { name: "scroll.down", run: |app, _| app.scroll_by(-1) },
    Action { name: "scroll.up", run: |app, _| app.scroll_by(1) },
    Action { name: "scroll.half_down", run: |app, _| app.scroll_by(-half(app)) },
    Action { name: "scroll.half_up", run: |app, _| app.scroll_by(half(app)) },
    Action { name: "scroll.page_down", run: |app, _| app.scroll_by(-page(app)) },
    Action { name: "scroll.page_up", run: |app, _| app.scroll_by(page(app)) },
    Action { name: "scroll.top", run: |app, _| app.scroll = usize::MAX / 2 },
    Action { name: "scroll.bottom", run: |app, _| app.scroll = 0 },
];

fn half(app: &App) -> isize {
    (app.page / 2).max(1) as isize
}

fn page(app: &App) -> isize {
    app.page.saturating_sub(2).max(1) as isize
}
