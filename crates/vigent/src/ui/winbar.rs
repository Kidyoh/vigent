//! The winbar over the transcript: the agent, its engine and model.
//! (Windows area: [winbar] left/right parts, one per window.)

use ratatui::text::Line;

use crate::app::App;

pub fn line(app: &App, width: usize) -> Line<'static> {
    crate::layout::winbar(app, width)
}
