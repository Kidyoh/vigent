//! The winbar over the transcript: the agent, its engine and model.
//! (Windows area: [winbar] left/right parts, one per window.)

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use crate::app::App;

pub fn line(app: &App) -> Line<'static> {
    let t = &app.theme;
    match app.focused() {
        Some(a) => {
            // the engine (when the model isn't its name), the model and the effort (TS winbar "model")
            let model = crate::engines::model_text(a);
            Line::from(vec![
                Span::styled("▸ ", t.fg("NonText")),
                Span::styled(a.name.clone(), t.fg("WinBar").add_modifier(Modifier::BOLD)),
                Span::styled(format!("  {model}"), t.fg("Comment").add_modifier(Modifier::ITALIC)),
            ])
        }
        None => Line::from(vec![Span::styled("▸ ", t.fg("NonText")), Span::styled("[no agent]", t.fg("Comment"))]),
    }
}
