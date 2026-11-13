//! :help: every active key, generated from the keymap so it shows your
//! mappings (src/app.ts openHelp), then the commands (EX_HELP).

use crate::app::App;
use crate::keys::{KEY_MODES, KeyMode, Rhs};
use crate::ui::floats::{Float, FloatLine};
use crate::ui::text::width;
use crate::ui::whichkey::describe;

/// Every command :help lists, and what it does.
pub const EX_HELP: &[(&str, &str)] = &[
    (":new [task]", "start an agent in its own worktree"),
    (":new -t <template> <task>", "start one from a template and send it (:templates picks)"),
    (":race <task> [--engines a,b] [--models x,y]", "the same task on every signed-in engine, or the ones and models you name, a worktree each"),
    (":race  /  :race pick", "compare the racers / keep the one you're on, remove the rest"),
    (":kill  /  :kill!", "stop the agent (keep / remove its worktree)"),
    (":new! [name]", "agent in this checkout, no worktree"),
    (":diff  /  :diff split", "the agent's changes, unified / side by side (s switches)"),
    (":review", "keep or drop the agent's changes hunk by hunk"),
    (":merge [--no-squash]", "squash-merge the agent's branch into yours"),
    (":pr", "push the branch and open a pull request"),
    (":queue <prompt>", "send after the current run (:queue lists)"),
    (":pause  /  :resume", "hold the agent and its queue / continue"),
    (":dash", "all agents at a glance"),
    (":cost", "tokens and money each agent has used, and the total"),
    (":pi", "a pi agent's extensions, commands, skills and prompt templates"),
    (":serve  /  :serve stop", "follow and prompt your agents from your phone (local: this machine only)"),
    (":trust", "let this project's .vigent.toml run its hooks and engine arguments"),
    (":tree", "the conversation's branches; go back and branch"),
    (":marks  /  :jumps", "this agent's marks (m{a-z}, '{a-z}) and jump list (<C-o>, <Tab>)"),
    (":history", "the commands and searches you ran this time"),
    (":new [task] --engine claude", "run the agent with Claude Code, codex, opencode or pi"),
    (":checkhealth", "which engines are installed and signed in"),
    (":model [name]", "pick the agent's model (no agent: for new agents)"),
    (":effort [level]", "pick its reasoning effort: low … max (pi: thinking level)"),
    (":engine [name]", "pick the engine new agents run on: auto, or any engine :checkhealth lists"),
    (":settings", "theme, look, engine, worktrees and keys in one place (w saves)"),
    (":w [file]", "save the transcript as Markdown"),
    (":worktrees", "list agent worktrees"),
    (":attach <branch>", "reopen an agent in a kept worktree"),
    (":worktree remove <branch>", "delete a worktree (safe; ! forces)"),
    (":colorscheme [name]", "switch theme (no name: picker)"),
    (":theme save <name>", "save the theme on screen, :hi changes included"),
    (":set transparent", "use the terminal's background (notransparent, transparent&)"),
    (":hi Group guifg=.. guibg=..", "change a highlight group"),
    (":hi link A B  /  :hi clear", "link groups / undo :hi"),
    (":set option / nooption", "change options (:set lists them)"),
    (":map lhs rhs", "map keys (:nmap :imap :cmap, :unmap)"),
    (":map", "list your mappings"),
    (":let mapleader = \",\"", "change the leader key"),
    (":model id", "switch the focused agent's model"),
    (":q  /  :q!", "close the split, or quit (asks if agents are running) / quit anyway"),
    (":qa  /  :qa!", "quit from any split"),
    (":vsplit [agent]  /  :split [agent]", "show an agent beside or below (its number or name)"),
    (":close  /  :only  /  :wincmd <key>", "close this split / close the others / any <C-w> key"),
    (":bn  :bp  :b <agent>  :ls  :bd", "agents as buffers: next, previous, go to, list, kill"),
    (":!{cmd}", "run a shell command in the agent's worktree; its output goes in the transcript"),
    (":command [Name] [cmd]", "your own commands: list them, show one, or define one (| separates steps)"),
    (":delcommand Name", "forget one of your commands"),
    (":permissions", "what each agent may do without asking: modes, allowed commands, sandbox, network (w saves)"),
    (":permissions allow <rule>", "let Claude Code run something without asking, e.g. Bash(cargo:*) (remove <rule> takes it away)"),
];

pub fn open(app: &mut App) {
    app.seq.reset();
    let mut lines: Vec<FloatLine> = vec![];
    for mode in KEY_MODES {
        if !lines.is_empty() {
            lines.push(vec![]);
        }
        let label = match mode {
            KeyMode::Normal => "NORMAL",
            KeyMode::Insert => "INSERT",
            KeyMode::Visual => "VISUAL",
            KeyMode::Command => "COMMAND LINE",
        };
        lines.push(vec![("Title", label.to_string())]);
        // (group key, keys with whether they're yours, description, yours)
        let mut groups: Vec<(String, Vec<(String, bool)>, String, bool)> = vec![];
        for b in app.keymap.bindings(mode) {
            let goto = matches!(b.rhs.as_slice(), [Rhs::Action { name, .. }] if name == "session.goto");
            let key = if goto { "session.goto".to_string() } else { b.rhs_text.clone() };
            let desc = if goto { "jump to session N".to_string() } else { describe(&b.rhs) };
            let text = b.keys.concat();
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => {
                    g.1.push((text, b.user));
                    g.3 |= b.user;
                }
                None => groups.push((key, vec![(text, b.user)], desc, b.user)),
            }
        }
        // your mappings first
        groups.sort_by_key(|g| !g.3);
        for (_, keys, desc, user) in groups {
            let texts: Vec<&String> = keys.iter().map(|(t, _)| t).collect();
            let digits = texts.iter().all(|t| t.chars().last().is_some_and(|c| c.is_ascii_digit()));
            let key_segs: Vec<(&'static str, String)> = if keys.len() > 4 && digits {
                vec![("Identifier", format!("{}-{}", texts[0], texts[texts.len() - 1].chars().last().unwrap()))]
            } else {
                keys.iter().enumerate().map(|(i, (t, u))| (if *u { "String" } else { "Identifier" }, format!("{}{t}", if i > 0 { " " } else { "" }))).collect()
            };
            let w: usize = key_segs.iter().map(|(_, t)| width(t)).sum();
            let mut row: FloatLine = vec![(if user { "String" } else { "Comment" }, if user { "* " } else { "  " }.to_string())];
            row.extend(key_segs);
            row.push(("NormalFloat", format!("{}{desc}", " ".repeat(1.max(17usize.saturating_sub(w))))));
            lines.push(row);
        }
    }
    lines.push(vec![]);
    lines.push(vec![("Title", "COMMANDS".to_string())]);
    for (c, d) in EX_HELP {
        lines.push(vec![("Comment", "  ".to_string()), ("Identifier", format!("{c:<29}")), ("NormalFloat", d.to_string())]);
    }
    lines.push(vec![]);
    let leader = if app.keymap.leader == " " { "<Space>".to_string() } else { app.keymap.leader.clone() };
    lines.push(vec![("Comment", format!("* = your mapping · leader = {leader}"))]);
    app.float = Some(Float::rich("Keys", lines, 76));
}
