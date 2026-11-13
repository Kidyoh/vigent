//! One turn of an agent CLI: the process, in the agent's worktree, with its
//! output lines read on threads and sent back to the UI thread as messages.
//! Every engine runs through here; an engine only says how (its Adapter).

use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

use super::{Adapter, Ev, RunOpts};
use crate::app::Msg;

/// Start one turn for the agent in `slot`. Its events, its stderr's last lines,
/// then the end of its output come back as Msg::Engine / Msg::Stderr / Msg::StreamEnd.
#[allow(clippy::too_many_arguments)]
pub fn spawn(adapter: &dyn Adapter, bin: &str, slot: usize, cwd: &Path, prompt: &str, opts: &RunOpts, drop_env: &[String], tx: Sender<Msg>) -> std::io::Result<Child> {
    let mut cmd = Command::new(bin);
    cmd.args(adapter.args(prompt, opts)).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for k in drop_env {
        cmd.env_remove(k);
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_tx = tx.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        let last: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let tail = last[last.len().saturating_sub(3)..].join("\n");
        let _ = err_tx.send(Msg::Stderr(slot, tail));
    });
    let mut parse = adapter.parser();
    let raw = adapter.raw();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let evs = if raw {
                vec![Ev::TextDelta(format!("{line}\n"))]
            } else {
                match serde_json::from_str::<Value>(&line) {
                    Ok(v) => parse(&v),
                    Err(_) => vec![],
                }
            };
            if !evs.is_empty() && tx.send(Msg::Engine(slot, evs)).is_err() {
                return;
            }
        }
        let _ = tx.send(Msg::StreamEnd(slot));
    });
    Ok(child)
}
