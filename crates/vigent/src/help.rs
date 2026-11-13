//! :help: the keys and commands. (Config area: list every binding from the
//! keymap, yours included, as src/app.ts openHelp does.)

use crate::app::App;
use crate::ui::floats::Float;

pub fn open(app: &mut App) {
    let keys = [
        ("i", "type a prompt; Enter sends it (the first one starts an agent)"),
        ("Esc", "back to NORMAL"),
        ("j / k", "scroll the transcript"),
        ("Ctrl-d / Ctrl-u", "half a page down / up"),
        ("gg / G", "top / bottom (G follows it again)"),
        ("]s / [s", "next / previous agent"),
        ("Space 1-9", "agent by number"),
        (":new <task>", "another agent, in its own worktree"),
        (":kill  :kill!", "close the agent (! also removes its worktree)"),
        (":theme <name>", "change colors (vigent theme list)"),
        (":checkhealth", "engines and worktrees"),
        (":q  :q!", "quit (! even with agents running)"),
    ];
    let mut lines: Vec<(String, &'static str)> = vec![("vigent keys".into(), "Title"), (String::new(), "Normal")];
    lines.extend(keys.iter().map(|(k, d)| (format!("{k:<18}{d}"), "Normal")));
    lines.push((String::new(), "Normal"));
    lines.push(("This Rust build runs Claude Code; the other engines come in milestone 2 (#168).".into(), "Comment"));
    app.float = Some(Float::new("keys", lines));
}
