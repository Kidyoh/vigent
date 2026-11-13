//! The winbar over the transcript: the agent, its engine and model.
//! (Windows area: [winbar] left/right parts, one per window.)

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use crate::app::App;

pub fn line(app: &App) -> Line<'static> {
    let t = &app.theme;
    match app.focused() {
        Some(a) => {
            let model = a.model.as_deref().map(|m| format!(" · {m}")).unwrap_or_default();
            let engine = crate::engines::engine_name(&a.engine);
            Line::from(vec![
                Span::styled("▸ ", t.fg("NonText")),
                Span::styled(a.name.clone(), t.fg("WinBar").add_modifier(Modifier::BOLD)),
                Span::styled(format!("  {engine}{model}"), t.fg("Comment").add_modifier(Modifier::ITALIC)),
            ])
        }
        None => Line::from(vec![Span::styled("▸ ", t.fg("NonText")), Span::styled("[no agent]", t.fg("Comment"))]),
    }
}
