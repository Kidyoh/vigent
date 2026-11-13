//! :checkhealth: the engines (installed? signed in? how to connect the rest)
//! and the worktrees, like nvim's :checkhealth (src/app.ts openHealth).
//! (Sessions area: riftri storage, src/riftri.ts riftriHealth.)

use crate::app::{App, Msg};
use crate::ui::floats::Float;

/// Check the engines again, then show what's ready.
pub fn open(app: &mut App) {
    app.say("checking engines…", "Comment");
    let (tx, env) = (app.tx.clone(), app.engines.env.clone());
    std::thread::spawn(move || {
        let infos = crate::engines::detect_all(&env, 8000);
        let _ = tx.send(Msg::Run(Box::new(move |app| {
            app.engines.infos = infos;
            if app.message.0 == "checking engines…" {
                app.say("", "Normal");
            }
            show(app);
        })));
    });
}

/// The engines part, as lines (TS openHealth).
pub fn engine_lines(app: &App) -> Vec<(String, &'static str)> {
    let mut l: Vec<(String, &'static str)> = vec![
        ("vigent: agent engines".into(), "Title"),
        ("Each CLI runs as installed, with its own login; vigent never reads credentials.".into(), "Comment"),
    ];
    let def = app.new_agent_engine();
    for e in &app.engines.infos {
        l.push((String::new(), "Normal"));
        let glyph = if e.connected { "●" } else if e.installed { "◐" } else { "○" };
        let group = if e.connected { "String" } else if e.installed { "WarningMsg" } else { "Comment" };
        let version = e.version.as_ref().map(|v| format!("  {v}")).unwrap_or_default();
        let tag = if e.id == def { "  (default for :new)" } else { "" };
        l.push((format!("{glyph} {}{version}{tag}", e.name), "Title"));
        let status = if e.connected { "OK " } else if e.installed { "WARNING " } else { "" };
        l.push((format!("    {status}{}", e.detail), if e.connected { "NormalFloat" } else { group }));
        match (&e.install, &e.connect) {
            (Some(install), _) if !e.installed => l.push((format!("    install: {install}"), "Comment")),
            (_, Some(connect)) if !e.connected => l.push((format!("    connect: {connect}"), "Comment")),
            _ => {}
        }
        if e.connected {
            l.push((format!("    use: :new <task> --engine {}", e.id), "Comment"));
        }
    }
    l.push((String::new(), "Normal"));
    l.push(("Connect in another terminal, then :checkhealth again.".into(), "Comment"));
    l
}

/// Show :checkhealth with what's known now.
pub fn show(app: &mut App) {
    let mut l = engine_lines(app);
    // the worktrees part (Sessions area): riftri, checked again now, and what agent worktrees cost on disk
    let storage = crate::worktree::riftri_health(app.root.as_deref(), &app.config.worktree);
    l.extend(crate::agents::storage_health_lines(&storage));
    app.agents.storage = Some(storage);
    app.float = Some(Float::new("checkhealth", l));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::EngineInfo;

    #[test]
    fn engines_say_how_to_connect() {
        let mut a = crate::app::tests::app();
        a.engines.infos = vec![
            EngineInfo { id: "claude".into(), name: "Claude Code".into(), installed: true, connected: true, version: Some("2.1.3".into()), detail: "signed in (Claude account)".into(), ..Default::default() },
            EngineInfo { id: "codex".into(), name: "Codex".into(), installed: true, detail: "not signed in".into(), connect: Some("codex login".into()), ..Default::default() },
            EngineInfo { id: "gemini".into(), name: "Gemini CLI".into(), detail: "not installed".into(), install: Some("npm install -g @google/gemini-cli".into()), ..Default::default() },
        ];
        let text: Vec<String> = engine_lines(&a).into_iter().map(|(s, _)| s).collect();
        let text = text.join("\n");
        assert!(text.contains("● Claude Code  2.1.3  (default for :new)\n    OK signed in (Claude account)\n    use: :new <task> --engine claude"), "{text}");
        assert!(text.contains("◐ Codex\n    WARNING not signed in\n    connect: codex login"));
        assert!(text.contains("○ Gemini CLI\n    not installed\n    install: npm install -g @google/gemini-cli"));
        assert!(text.ends_with("Connect in another terminal, then :checkhealth again."));
    }
}
