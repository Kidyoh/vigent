//! :checkhealth: the engines (installed? signed in?) and the worktrees, like
//! nvim's :checkhealth. (Engines area: models and permissions per engine;
//! Config area: config warnings; Sessions area: riftri storage, src/riftri.ts.)

use crate::app::App;
use crate::ui::floats::Float;

pub fn open(app: &mut App) {
    let mut l: Vec<(String, &'static str)> = vec![
        ("vigent: agent engines".into(), "Title"),
        ("Each CLI runs as installed, with its own login; vigent never reads credentials.".into(), "Comment"),
        (String::new(), "Normal"),
    ];
    let default = app.new_agent_engine();
    for e in &app.engines.infos {
        let name = &e.name;
        if !e.ported() {
            l.push((format!("○ {name}"), "Normal"));
            if e.installed {
                l.push(("    installed; this Rust build runs Claude Code only so far (milestone 2 adds the rest)".into(), "Comment"));
            } else {
                l.push(("    not installed".into(), "Comment"));
                l.push((format!("    install: {}", e.install), "Comment"));
            }
        } else if e.checking {
            l.push((format!("… {name}  checking"), "Comment"));
        } else if !e.installed {
            l.push((format!("○ {name}"), "Normal"));
            l.push(("    not installed".into(), "Comment"));
            l.push((format!("    install: {}", e.install), "Comment"));
        } else {
            let v = e.version.clone().unwrap_or_default();
            let tag = if e.id == default { "  (default for :new)" } else { "" };
            l.push((format!("{} {name}  {v}{tag}", if e.connected { "●" } else { "◐" }), "Normal"));
            if e.connected {
                l.push((format!("    OK {}", e.detail), "ModeMsg"));
            } else {
                let how = e.connect.clone().unwrap_or_else(|| crate::engines::spec(&e.id).bin.to_string());
                l.push((format!("    WARNING not signed in: run  {how}  once to sign in"), "WarningMsg"));
            }
        }
        l.push((String::new(), "Normal"));
    }
    // the worktrees part (Sessions area): riftri, checked again now, and what agent worktrees cost on disk
    let storage = crate::worktree::riftri_health(app.root.as_deref(), &app.config.worktree);
    l.extend(crate::agents::storage_health_lines(&storage));
    app.agents.storage = Some(storage);
    app.float = Some(Float::new("checkhealth", l));
}
