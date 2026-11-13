//! Your own ex commands (src/commands.ts) and `:!{cmd}` (App.runShell).
//!
//!   [commands]
//!   Test = "!npm test"                     a shell command, in the agent's worktree
//!   Review = "new -t review {args}"        an ex command; {args} is what follows the name
//!   Ship = ["!npm test", "merge", "pr"]    steps in turn; a shell step that fails stops the rest
//!
//! `:command Name {cmd}` defines one for this run (| separates steps),
//! `:command` lists them, `:delcommand Name` forgets one. Shell commands run
//! with a shell off the UI thread (src/hooks.ts runHook); their output goes in
//! the agent's transcript and the last line on the message line.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::app::App;
use crate::commands::Ex;
use crate::session::Item;

/// A user command's name: a capital letter, then letters and digits (vim's rule).
pub fn is_user_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && name.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A step as written: leading `:` dropped.
pub fn normalize_step(step: &str) -> String {
    step.trim().trim_start_matches(':').trim_start().to_string()
}

/// `{args}` (or `<args>`) in a step: what followed the command's name.
pub fn fill_args(step: &str, args: &str) -> String {
    step.replace("{args}", args).replace("<args>", args)
}

/// "3.2s", "1m 05s"
pub fn took(ms: u128) -> String {
    if ms < 60_000 {
        return format!("{:.1}s", ms as f64 / 1000.0);
    }
    let s = (ms as f64 / 1000.0).round() as u64;
    format!("{}m {:02}s", s / 60, s % 60)
}

/// The last non-empty line of a command's output.
pub fn last_line(output: &str) -> String {
    output.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or_default().to_string()
}

/// How a hook or shell command ended.
pub struct HookResult {
    pub ok: bool,
    pub code: Option<i32>,
    /// the end of what it printed (stdout and stderr together)
    pub output: String,
    pub ms: u128,
    pub timed_out: bool,
}

const KEEP: usize = 4000;

/// Run a command with a shell in `cwd` (blocking: call it off the UI thread). Never fails: a failure is a result.
pub fn run_hook(command: &str, cwd: &PathBuf, env: &[(String, String)], timeout: Duration) -> HookResult {
    let started = Instant::now();
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(format!("{{ {command}\n}} 2>&1"));
        c
    };
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return HookResult { ok: false, code: None, output: e.to_string(), ms: 0, timed_out: false },
    };
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = vec![];
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut buf);
        }
        buf
    });
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    let bytes = if timed_out { vec![] } else { reader.join().unwrap_or_default() };
    let text = String::from_utf8_lossy(&bytes).to_string();
    let chars: Vec<char> = text.chars().collect();
    let output: String = chars[chars.len().saturating_sub(KEEP)..].iter().collect::<String>().trim_end().to_string();
    let code = status.and_then(|s| s.code());
    HookResult { ok: code == Some(0) && !timed_out, code: if timed_out { None } else { code }, output, ms: started.elapsed().as_millis(), timed_out }
}

/// `:!cmd`: a shell command in the focused agent's worktree (else the repository).
/// `label` names it on the message line; `then` runs after it passed (a user command's next steps).
pub fn run_shell(app: &mut App, command: &str, label: Option<String>, then: Option<Box<dyn FnOnce(&mut App) + Send>>) {
    if command.trim().is_empty() {
        return app.say("E471: Argument required: :!{command}", "ErrorMsg");
    }
    let label = label.unwrap_or_else(|| format!(":!{command}"));
    let focused = app.focused().map(|s| s.slot);
    let s = app.focused();
    let worktree = s.filter(|s| s.branch.is_some()).map(|s| s.path.clone());
    let cwd = worktree.clone().or_else(|| app.root.clone()).unwrap_or_else(|| app.cwd.clone());
    let env = vec![
        ("VIGENT_AGENT".to_string(), s.map(|s| s.name.clone()).unwrap_or_default()),
        ("VIGENT_ENGINE".to_string(), s.map(|s| s.engine.clone()).unwrap_or_default()),
        ("VIGENT_BRANCH".to_string(), s.and_then(|s| s.branch.clone()).unwrap_or_default()),
        ("VIGENT_WORKTREE".to_string(), worktree.map(|p| p.display().to_string()).unwrap_or_default()),
        ("VIGENT_REPO".to_string(), app.root.as_ref().map(|p| p.display().to_string()).unwrap_or_default()),
    ];
    app.say(format!("{label} …"), "Comment");
    let (tx, command) = (app.tx.clone(), command.to_string());
    std::thread::spawn(move || {
        let r = run_hook(&command, &cwd, &env, Duration::from_secs(15 * 60));
        let _ = tx.send(crate::app::Msg::Run(Box::new(move |app: &mut App| {
            let how = if r.ok {
                format!("done in {}", took(r.ms))
            } else if r.timed_out {
                format!("timed out after {}", took(r.ms))
            } else {
                format!("failed (exit {}) after {}", r.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()), took(r.ms))
            };
            // the output goes in the agent's transcript, where you can read and search it
            if let Some(s) = focused.and_then(|i| app.sessions.get_mut(i)) {
                let out = if r.output.is_empty() { String::new() } else { format!("\n{}", r.output) };
                s.items.push(Item::Info(format!("$ {command}  ({how}){out}")));
            }
            let last = last_line(&r.output);
            let tail = if last.is_empty() { String::new() } else { format!(" · {last}") };
            app.say(format!("{label}: {how}{tail}"), if r.ok { "Comment" } else { "ErrorMsg" });
            if r.ok
                && let Some(next) = then
            {
                next(app);
            }
        })));
    });
}

fn find(app: &App, name: &str) -> Option<Vec<String>> {
    app.config.commands.iter().find(|(n, _)| n == name).map(|(_, s)| s.clone())
}

/// One of your commands, by the name typed (`:Test args`).
pub fn run_user(app: &mut App, ex: &Ex) {
    let name = ex.name.trim_end_matches('!');
    let Some(steps) = find(app, name) else { return app.say(format!("E492: Not an editor command: {}", ex.name), "ErrorMsg") };
    if app.cfg.command_depth >= 10 {
        return app.say(format!("E169: :{name} is too recursive"), "ErrorMsg");
    }
    let steps: Vec<String> = steps.iter().map(|s| fill_args(s, ex.arg)).collect();
    app.cfg.command_depth += 1;
    run_steps(app, name.to_string(), steps);
    app.cfg.command_depth -= 1;
}

/// Each step in turn: ex commands now, a shell step off the thread (the rest wait for it to pass).
fn run_steps(app: &mut App, name: String, mut steps: Vec<String>) {
    while !steps.is_empty() {
        let step = steps.remove(0);
        if let Some(shell) = step.strip_prefix('!') {
            let rest = steps;
            let n = name.clone();
            let then: Option<Box<dyn FnOnce(&mut App) + Send>> = if rest.is_empty() { None } else { Some(Box::new(move |app: &mut App| run_steps(app, n, rest))) };
            return run_shell(app, shell.trim(), Some(format!(":{name}")), then);
        }
        crate::commands::exec(app, &step);
    }
}

/// `:command` lists yours, `:command Name` shows one, `:command[!] Name {cmd}` defines one (for this run).
pub fn exec_command(app: &mut App, arg: &str, bang: bool) {
    let arg = arg.trim();
    if arg.is_empty() {
        let mut names: Vec<&(String, Vec<String>)> = app.config.commands.iter().collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        if names.is_empty() {
            return app.say("no commands of your own yet: :command Name {cmd}, or [commands] in config.toml", "Comment");
        }
        let text = names.iter().map(|(n, s)| format!("{n} = {}", s.join(" | "))).collect::<Vec<_>>().join("   ");
        return app.say(text, "Normal");
    }
    let (name, rhs) = match arg.split_once(char::is_whitespace) {
        Some((n, r)) => (n, Some(r.trim_start())),
        None => (arg, None),
    };
    if !is_user_name(name) {
        return app.say(format!("E183: User defined commands must start with an uppercase letter: {name}"), "ErrorMsg");
    }
    let Some(rhs) = rhs.filter(|r| !r.is_empty()) else {
        return match find(app, name) {
            Some(c) => app.say(format!("{name} = {}", c.join(" | ")), "Normal"),
            None => app.say(format!("E184: No such user-defined command: {name}"), "ErrorMsg"),
        };
    };
    if find(app, name).is_some() && !bang {
        return app.say(format!("E174: Command already exists: add ! to replace it: {name}"), "ErrorMsg");
    }
    // like vim, | separates commands (a shell step keeps the rest of the line)
    let parts: Vec<&str> = rhs.split('|').collect();
    let shell = parts.iter().position(|p| normalize_step(p).starts_with('!'));
    let mut steps: Vec<String> = match shell {
        Some(i) => {
            let mut v: Vec<String> = parts[..i].iter().map(|s| s.to_string()).collect();
            v.push(parts[i..].join("|"));
            v
        }
        None => parts.iter().map(|s| s.to_string()).collect(),
    };
    steps = steps.iter().map(|s| normalize_step(s)).filter(|s| !s.is_empty()).collect();
    let text = steps.join(" | ");
    app.config.commands.retain(|(n, _)| n != name);
    app.config.commands.push((name.to_string(), steps));
    app.say(format!(":{name} = {text}"), "Comment");
}

/// `:delcommand Name`
pub fn delete(app: &mut App, arg: &str) {
    if find(app, arg).is_none() {
        return app.say(format!("E184: No such user-defined command: {arg}"), "ErrorMsg");
    }
    app.config.commands.retain(|(n, _)| n != arg);
    app.say(format!("deleted :{arg}"), "Comment");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::exec;

    #[test]
    fn define_list_show_and_forget() {
        let mut a = crate::app::tests::app();
        exec(&mut a, "command");
        assert!(a.message.0.starts_with("no commands of your own yet"));
        exec(&mut a, "command Hi colorscheme nord | set nonumber");
        assert_eq!(a.message.0, ":Hi = colorscheme nord | set nonumber");
        exec(&mut a, "command Hi x");
        assert_eq!(a.message.0, "E174: Command already exists: add ! to replace it: Hi");
        exec(&mut a, "command lower x");
        assert!(a.message.0.starts_with("E183"));
        exec(&mut a, "Hi");
        assert_eq!(a.theme.name, "nord");
        assert!(!a.config.ui.number);
        exec(&mut a, "command! Loop Loop");
        exec(&mut a, "Loop");
        assert_eq!(a.message.0, "E169: :Loop is too recursive");
        exec(&mut a, "command T !echo a | b");
        assert_eq!(a.config.commands.last().unwrap().1, ["!echo a | b"]);
        exec(&mut a, "delcommand Hi");
        assert_eq!(a.message.0, "deleted :Hi");
        exec(&mut a, "Hi");
        assert_eq!(a.message.0, "E492: Not an editor command: Hi");
        exec(&mut a, "!");
        assert!(a.message.0.starts_with("E471"));
    }

    #[test]
    fn hooks_run_with_a_shell() {
        let r = run_hook("echo \"hi $VIGENT_AGENT\"; echo oops >&2", &std::env::temp_dir(), &[("VIGENT_AGENT".into(), "fix race".into())], Duration::from_secs(10));
        assert!(r.ok);
        assert_eq!(r.output, "hi fix race\noops");
        let bad = run_hook("echo failing test; exit 3", &std::env::temp_dir(), &[], Duration::from_secs(10));
        assert_eq!((bad.ok, bad.code), (false, Some(3)));
        let slow = run_hook("sleep 5", &std::env::temp_dir(), &[], Duration::from_millis(100));
        assert!(!slow.ok && slow.timed_out);
        assert_eq!(took(3200), "3.2s");
        assert_eq!(took(65_000), "1m 05s");
    }
}
