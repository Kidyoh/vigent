//! Claude Code's permission denials (src/cli-engines.ts blocked,
//! describeDenial, allowRules, commandPrograms, interactiveNote) and the
//! argument helpers of src/permissions.ts. [engines.claude] allow becomes
//! --allowedTools; what's still refused is said in the transcript, with the
//! rule that would allow it.

use serde_json::Value;

use super::Denial;
use super::common::{js_string, summarize};

/// The value after `flag` (`--permission-mode plan`, or `--permission-mode=plan`).
pub fn flag_value(args: &[String], flag: &str) -> Option<String> {
    if let Some(i) = args.iter().position(|a| a == flag)
        && i + 1 < args.len()
    {
        return Some(args[i + 1].clone());
    }
    let eq = format!("{flag}=");
    args.iter().find_map(|a| a.strip_prefix(&eq).map(str::to_string))
}

/// Claude Code's tools that wait for you to answer: refused in -p whatever the rules, so never asked about.
const INTERACTIVE_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

/// What a refused AskUserQuestion wanted to know, or that a plan is ready.
pub fn interactive_note(engine: &str, d: &Denial) -> String {
    if d.name == "ExitPlanMode" {
        return format!("{engine} has a plan ready and wants to start on it: set Mode to something other than plan in :permissions, then tell it to go ahead");
    }
    let asked: Vec<String> = d.input["questions"]
        .as_array()
        .map(|qs| {
            qs.iter()
                .map(|q| {
                    let opts: Vec<String> = q["options"].as_array().map(|o| o.iter().filter_map(|o| o["label"].as_str().filter(|l| !l.is_empty()).map(str::to_string)).collect()).unwrap_or_default();
                    let question = if q["question"].is_null() { String::new() } else { js_string(&q["question"]).trim().to_string() };
                    format!("{question}{}", if opts.is_empty() { String::new() } else { format!(" ({})", opts.join(" / ")) })
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let what = if asked.is_empty() { " something".to_string() } else { format!(": {}", asked.join(" · ")) };
    format!("{engine} wanted to ask you{what} · answer with i")
}

/// A refused tool call, short: the command for Bash, the tool name and its target otherwise.
pub fn describe_denial(d: &Denial) -> String {
    if d.name == "Bash"
        && let Some(c) = d.input["command"].as_str()
    {
        return c.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
    }
    let s = summarize(&d.input);
    if s.is_empty() { d.name.clone() } else { format!("{} {s}", d.name).chars().take(80).collect() }
}

const SHELL_KEYWORDS: [&str; 23] = ["for", "in", "do", "done", "while", "until", "if", "then", "elif", "else", "fi", "case", "esac", "select", "function", "time", "!", "{", "}", "[[", "]]", "[", "]"];

/// Quoted text is an argument, never a command boundary: each quoted string becomes " _ ".
fn blank_quotes(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '\'' => match c[i + 1..].iter().position(|&x| x == '\'') {
                Some(j) => {
                    out.push_str(" _ ");
                    i += j + 2;
                }
                None => {
                    out.push('\'');
                    i += 1;
                }
            },
            '"' => {
                let mut j = i + 1;
                let mut closed = None;
                while j < c.len() {
                    if c[j] == '\\' && j + 1 < c.len() {
                        j += 2;
                        continue;
                    }
                    if c[j] == '\\' {
                        break;
                    }
                    if c[j] == '"' {
                        closed = Some(j);
                        break;
                    }
                    j += 1;
                }
                match closed {
                    Some(j) => {
                        out.push_str(" _ ");
                        i = j + 1;
                    }
                    None => {
                        out.push('"');
                        i += 1;
                    }
                }
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// Redirections (2>&1, &>, >>, <) aren't command boundaries either.
fn blank_redirections(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        // \d*>&\d*  |  \d*>>?
        let mut j = i;
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        if j < c.len() && c[j] == '>' {
            let mut k = j + 1;
            if k < c.len() && c[k] == '&' {
                k += 1;
                while k < c.len() && c[k].is_ascii_digit() {
                    k += 1;
                }
            } else if k < c.len() && c[k] == '>' {
                k += 1;
            }
            out.push(' ');
            i = k;
            continue;
        }
        if c[i] == '&' && i + 1 < c.len() && c[i + 1] == '>' {
            let k = if i + 2 < c.len() && c[i + 2] == '>' { i + 3 } else { i + 2 };
            out.push(' ');
            i = k;
            continue;
        }
        if c[i] == '<' {
            let k = if i + 1 < c.len() && c[i + 1] == '<' { i + 2 } else { i + 1 };
            out.push(' ');
            i = k;
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// The programs a shell command runs: each command of a pipeline, list, loop
/// body or `$(...)`, without shell keywords and `VAR=value` prefixes.
pub fn command_programs(command: &str) -> Vec<String> {
    let text = blank_redirections(&blank_quotes(command));
    // split on $( ` && || ; | & \n ( )
    let mut segments = vec![];
    let mut cur = String::new();
    let c: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < c.len() {
        let two: String = c[i..(i + 2).min(c.len())].iter().collect();
        if two == "$(" || two == "&&" || two == "||" {
            segments.push(std::mem::take(&mut cur));
            i += 2;
            continue;
        }
        if matches!(c[i], '`' | ';' | '|' | '&' | '\n' | '(' | ')') {
            segments.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        cur.push(c[i]);
        i += 1;
    }
    segments.push(cur);
    let mut out: Vec<String> = vec![];
    for seg in segments {
        let words: Vec<&str> = seg.split_whitespace().collect();
        // `for x in a b` and `case $x in` name no program
        if matches!(words.first(), Some(&"for" | &"select" | &"case")) {
            continue;
        }
        // `if [ -f a ]`, `while [[ … ]]`: a test, not a program
        let head = words.iter().find(|w| !["if", "elif", "while", "until", "!"].contains(w));
        if matches!(head, Some(&"[" | &"[[" | &"test")) {
            continue;
        }
        let is_assign = |w: &str| {
            let Some((name, _)) = w.split_once('=') else { return false };
            name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        };
        let Some(prog) = words.iter().find(|w| !SHELL_KEYWORDS.contains(w) && !is_assign(w)) else { continue };
        let m: String = prog.chars().take_while(|c| !c.is_whitespace() && !";&|()<>`$'\"{}".contains(*c)).collect();
        if !m.is_empty() && !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

/// The Claude Code permission rules that allow a refused call: `Bash(gh:*)`
/// for each program a command runs, the tool's name otherwise.
pub fn allow_rules(d: &Denial) -> Vec<String> {
    if d.name == "Bash"
        && let Some(c) = d.input["command"].as_str()
    {
        let progs = command_programs(c);
        return if progs.is_empty() { vec!["Bash".into()] } else { progs.iter().map(|p| format!("Bash({p}:*)")).collect() };
    }
    vec![d.name.clone()]
}

/// What to ask when [engines.claude] ask is on: allow these rules once, always, or not.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    /// what was refused, short
    pub what: String,
    /// the rules not allowed yet (what allowing adds)
    pub missing: Vec<String>,
    /// every rule that would allow what was refused (the retry names them)
    pub rules: Vec<String>,
}

/// What the transcript says when the CLI refused some tools, and what to ask
/// when `ask` is on (TS CliSession.blocked). `relative` shortens paths inside the agent's folder.
pub fn blocked(engine: &str, engine_name: &str, all: &[Denial], allowed: &[String], permission_mode: &str, ask: bool, relative: &dyn Fn(&str) -> String) -> (Vec<String>, Option<Ask>) {
    let mut notes = blocked_notes(engine, engine_name, all, allowed, permission_mode, relative);
    let asking = ask && engine == "claude" && notes.last().is_some_and(|n| n.starts_with("to allow it: "));
    if !asking {
        return (notes, None);
    }
    notes.pop();
    let denied: Vec<&Denial> = all.iter().filter(|d| !INTERACTIVE_TOOLS.contains(&d.name.as_str())).collect();
    let mut what: Vec<String> = vec![];
    let mut rules: Vec<String> = vec![];
    for d in &denied {
        let w = describe_denial(d);
        if !what.contains(&w) {
            what.push(w);
        }
        for r in allow_rules(d) {
            if !rules.contains(&r) {
                rules.push(r);
            }
        }
    }
    let missing = rules.iter().filter(|r| !allowed.contains(r)).cloned().collect();
    (notes, Some(Ask { what: what.join(" · "), missing, rules }))
}

/// What the transcript says when the CLI refused some tools (TS CliSession.blocked, not asking).
pub fn blocked_notes(engine: &str, engine_name: &str, all: &[Denial], allowed: &[String], permission_mode: &str, relative: &dyn Fn(&str) -> String) -> Vec<String> {
    let mut notes = vec![];
    let denied: Vec<&Denial> = all
        .iter()
        .filter(|d| {
            if !INTERACTIVE_TOOLS.contains(&d.name.as_str()) {
                return true;
            }
            notes.push(interactive_note(engine_name, d));
            false
        })
        .collect();
    if denied.is_empty() {
        return notes;
    }
    let mut what: Vec<String> = vec![];
    let mut rules: Vec<String> = vec![];
    for d in &denied {
        let w = relative(&describe_denial(d));
        if !what.contains(&w) {
            what.push(w);
        }
        for r in allow_rules(d) {
            if !rules.contains(&r) {
                rules.push(r);
            }
        }
    }
    notes.push(format!("blocked by {engine_name}'s permissions: {}", what.join(" · ")));
    if engine != "claude" {
        return notes;
    }
    if permission_mode == "bypassPermissions" {
        notes.push(format!(
            "{engine_name} refused this even with bypassPermissions: it asks before a few things whatever the mode (writing in .git or .claude, for one), and it can't ask here. Do that part yourself, or ask the agent for another way."
        ));
        return notes;
    }
    let missing: Vec<&String> = rules.iter().filter(|r| !allowed.contains(r)).collect();
    if missing.is_empty() {
        notes.push(format!(
            "{} {} allowed, and {engine_name} still refused: it asks before some commands whatever the rules say. In :permissions, set Mode to bypassPermissions (anything, in its worktree), then ask it to try again.",
            rules.join(" "),
            if rules.len() == 1 { "is" } else { "are" }
        ));
        return notes;
    }
    let missing: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
    notes.push(format!(
        "to allow it: :permissions allow {}, then ask it to try again (it's saved, and applies from its next prompt; or turn on asking in :permissions)",
        missing.join(" ")
    ));
    notes
}

/// A JSON value as a Denial's input (for tests and callers building one).
pub fn denial(name: &str, input: Value) -> Denial {
    Denial { name: name.into(), input }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_rule_for_every_program_a_command_runs() {
        let cases: [(&str, &[&str]); 9] = [
            ("gh run list --limit 200 --json databaseId,headSha | jq -r '.[] | select(.x)'", &["gh", "jq"]),
            ("for id in 42727 409956; do gh run view $id --log-failed | grep -n \"ETIMEDOUT\"; done", &["gh", "grep"]),
            ("echo \"--- per job; still text\"; gh api \"repos/{owner}/{repo}/actions/jobs/129\"", &["echo", "gh"]),
            ("GH_PAGER= gh pr checks 12", &["gh"]),
            ("cd crates && cargo test -p riftri-git 2>&1 | tail -20", &["cd", "cargo", "tail"]),
            ("x=$(git rev-parse HEAD) && echo $x", &["git", "echo"]),
            ("if [ -f a ]; then rm a; fi", &["rm"]),
            ("while [[ -n $x ]]; do sleep 1; done", &["sleep"]),
            ("npm test > out.log 2>&1 &", &["npm"]),
        ];
        for (cmd, progs) in cases {
            assert_eq!(command_programs(cmd), progs, "{cmd}");
        }
        assert_eq!(allow_rules(&denial("Bash", json!({"command": "for id in 1 2; do gh run view $id | jq .x; done"}))), ["Bash(gh:*)", "Bash(jq:*)"]);
        assert_eq!(describe_denial(&denial("Bash", json!({"command": "gh  pr\nview 12"}))), "gh pr view 12");
        assert_eq!(describe_denial(&denial("WebFetch", json!({"url": "https://x.dev"}))), "WebFetch https://x.dev");
    }

    #[test]
    fn what_a_refusal_says() {
        let id = |s: &str| s.to_string();
        let d = [denial("Bash", json!({"command": "gh pr view 12"}))];
        let n = blocked_notes("claude", "Claude Code", &d, &[], "acceptEdits", &id);
        assert_eq!(n[0], "blocked by Claude Code's permissions: gh pr view 12");
        assert!(n[1].starts_with("to allow it: :permissions allow Bash(gh:*), then"));
        let n = blocked_notes("claude", "Claude Code", &d, &["Bash(gh:*)".into()], "acceptEdits", &id);
        assert!(n[1].starts_with("Bash(gh:*) is allowed, and Claude Code still refused"));
        let q = [denial("AskUserQuestion", json!({"questions": [{"question": "Which?", "options": [{"label": "A"}, {"label": "B"}]}]}))];
        assert_eq!(blocked_notes("claude", "Claude Code", &q, &[], "default", &id), ["Claude Code wanted to ask you: Which? (A / B) · answer with i"]);
        let (n, ask) = blocked("claude", "Claude Code", &d, &[], "acceptEdits", true, &id);
        assert_eq!(n, ["blocked by Claude Code's permissions: gh pr view 12"]);
        assert_eq!(ask, Some(Ask { what: "gh pr view 12".into(), missing: vec!["Bash(gh:*)".into()], rules: vec!["Bash(gh:*)".into()] }));
        assert_eq!(blocked("codex", "Codex", &d, &[], "", true, &id).1, None, "only Claude Code is asked about");
        assert_eq!(flag_value(&["--permission-mode".into(), "plan".into()], "--permission-mode").as_deref(), Some("plan"));
        assert_eq!(flag_value(&["--permission-mode=plan".into()], "--permission-mode").as_deref(), Some("plan"));
    }
}
