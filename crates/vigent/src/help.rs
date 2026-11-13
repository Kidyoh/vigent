//! :help: every active key, generated from the keymap so it shows your
//! mappings, then the commands (src/app.ts openHelp, describeRhs, EX_HELP).

use crate::app::App;
use crate::keys::{self, KEY_MODES, KeyMode, Rhs};
use crate::ui::floats::Float;
use crate::ui::text::width;

/// Every ex command :help lists, with what it does.
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

/// What a right-hand side does, for :help.
pub fn describe_rhs(rhs: &[Rhs]) -> String {
    rhs.iter()
        .map(|r| match r {
            Rhs::Action { name, arg } => {
                let d = keys::ACTIONS.iter().find(|(n, _)| n == name).map(|(_, d)| *d).unwrap_or(name.as_str()).to_string();
                match arg {
                    Some(a) => format!("{d} ({a})"),
                    None => d,
                }
            }
            Rhs::Ex { cmd, execute } => format!(":{}{}", cmd.trim_end(), if *execute { "" } else { " …" }),
            Rhs::Keys(k) => format!("same as {}", k.concat()),
            Rhs::Nop => "disabled".into(),
        })
        .collect::<Vec<_>>()
        .join(", then ")
}

/// A key's job for :settings: an ex command with what :help says about it, else describe_rhs.
pub fn rhs_label(rhs: &[Rhs]) -> String {
    if let [Rhs::Ex { cmd, execute }] = rhs {
        let word = cmd.split_whitespace().next().unwrap_or_default();
        let help = EX_HELP.iter().find(|(c, _)| *c == format!(":{word}") || c.starts_with(&format!(":{word} ")));
        let shown = format!(":{}{}", cmd.trim_end(), if *execute { "" } else { " …" });
        return match help {
            Some((_, d)) => format!("{} ({shown})", d.split(" (").next().unwrap_or(d)),
            None => shown,
        };
    }
    describe_rhs(rhs)
}

pub fn open(app: &mut App) {
    let mut lines: Vec<(String, &'static str)> = vec![];
    let label = |m: KeyMode| match m {
        KeyMode::Normal => "NORMAL",
        KeyMode::Insert => "INSERT",
        KeyMode::Visual => "VISUAL",
        KeyMode::Command => "COMMAND LINE",
    };
    for mode in KEY_MODES {
        if !lines.is_empty() {
            lines.push((String::new(), "Normal"));
        }
        lines.push((label(mode).into(), "Title"));
        // (group key, keys with whether yours, description, any yours)
        let mut groups: Vec<(String, Vec<(String, bool)>, String, bool)> = vec![];
        for b in app.keymap.bindings(mode) {
            let goto = matches!(b.rhs.as_slice(), [Rhs::Action { name, .. }] if name == "session.goto");
            let key = if goto { "session.goto".to_string() } else { b.rhs_text.clone() };
            let desc = if goto { "jump to session N".to_string() } else { describe_rhs(&b.rhs) };
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => {
                    g.1.push((b.keys.concat(), b.user));
                    g.3 |= b.user;
                }
                None => groups.push((key, vec![(b.keys.concat(), b.user)], desc, b.user)),
            }
        }
        // your mappings first
        groups.sort_by_key(|g| !g.3);
        for (_, keys, desc, user) in groups {
            let texts: Vec<&str> = keys.iter().map(|(k, _)| k.as_str()).collect();
            let keys_text = if keys.len() > 4 && texts.iter().all(|t| t.ends_with(|c: char| c.is_ascii_digit())) {
                format!("{}-{}", texts[0], texts[texts.len() - 1].chars().last().unwrap_or('9'))
            } else {
                texts.join(" ")
            };
            let pad = " ".repeat(17usize.saturating_sub(width(&keys_text)).max(1));
            lines.push((format!("{}{keys_text}{pad}{desc}", if user { "* " } else { "  " }), if user { "String" } else { "Normal" }));
        }
    }
    lines.push((String::new(), "Normal"));
    lines.push(("COMMANDS".into(), "Title"));
    for (c, d) in EX_HELP {
        lines.push((format!("  {c:<29}{d}"), "Normal"));
    }
    lines.push((String::new(), "Normal"));
    let leader = if app.keymap.leader == " " { "<Space>".to_string() } else { app.keymap.leader.clone() };
    lines.push((format!("* = your mapping · leader = {leader}"), "Comment"));
    app.float = Some(Float::new("Keys", lines));
}

#[cfg(test)]
mod tests {
    #[test]
    fn help_lists_every_binding_and_command() {
        let mut a = crate::app::tests::app();
        a.keymap.set(crate::keys::KeyMode::Normal, "Q", &crate::keys::RhsValue::Str(":qa<CR>".into())).unwrap();
        super::open(&mut a);
        let f = a.float.as_ref().unwrap();
        assert_eq!(f.title, "Keys");
        assert!(f.lines.iter().any(|(l, g)| l.starts_with("* Q") && *g == "String"));
        assert!(f.lines.iter().any(|(l, _)| l.contains(":permissions allow <rule>")));
        assert_eq!(super::rhs_label(&crate::keys::parse_rhs(&crate::keys::RhsValue::Str(":new ".into()), " ").unwrap()), "start an agent in its own worktree (:new …)");
    }
}
