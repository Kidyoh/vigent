//! `theme = "nvim"` (or `"vim"`): vigent uses the colorscheme your editor
//! uses, with your config and plugins (src/follow.ts).
//!
//! The editor's colors are kept as the theme file `nvim.json` (`vim.json`).
//! At start vigent shows that copy at once and imports again in the
//! background (a child `vigent theme import`): when you've changed your
//! editor's colorscheme since, the new one replaces it while vigent runs. The
//! first time there's no copy yet, so vigent imports before it opens.

use std::path::PathBuf;

use crate::app::{App, Msg};
use crate::theme::{self, ThemeDef};

pub fn is_follow(theme: &str) -> bool {
    theme == "nvim" || theme == "vim"
}

/// The theme file that holds the editor's colors.
pub fn follow_file(editor: &str) -> PathBuf {
    theme::themes_dir().join(format!("{editor}.json"))
}

/// The colorscheme the copy came from (e.g. "astrodark"), if it says.
pub fn followed_colorscheme(editor: &str) -> Option<String> {
    let t = std::fs::read_to_string(follow_file(editor)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&t).ok()?;
    v.get("colorscheme").and_then(|c| c.as_str()).filter(|c| !c.is_empty()).map(String::from)
}

/// The editor's theme: the copy from last time, or (the first time) an import now.
pub fn follow_theme(editor: &str) -> Result<ThemeDef, String> {
    let file = follow_file(editor);
    if !file.exists() {
        crate::import::import_theme(&crate::import::ImportOptions { editor: Some(editor.into()), as_name: Some(editor.into()), ..Default::default() })?;
    }
    theme::load_def(&file.to_string_lossy())
}

/// The copy's colors, keys in a fixed order (the editor lists its groups in any order).
fn read(file: &PathBuf) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    // serde_json's maps keep their keys sorted
    Some(v.to_string())
}

/// While vigent runs: import the editor's colorscheme again (a child process) and switch when it changed.
pub fn refresh_in_background(app: &App, theme_name: &str) {
    if !is_follow(theme_name) {
        return;
    }
    let editor = theme_name.to_string();
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        let file = follow_file(&editor);
        let before = read(&file);
        let Ok(me) = std::env::current_exe() else { return };
        let ok = std::process::Command::new(me)
            .args(["theme", "import", &format!("--{editor}"), "--as", &editor])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        let after = read(&file);
        if !ok || after.is_none() || after == before {
            return;
        }
        let Ok(def) = theme::load_def(&file.to_string_lossy()) else { return };
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| {
            app.theme.set_def(def);
            let which = followed_colorscheme(&editor).unwrap_or_else(|| editor.clone());
            app.say(format!("colorscheme from {editor}: {which}"), "Comment");
        })));
    });
}
