//! One turn of an agent CLI: the process, in the agent's worktree, with its
//! output lines read on threads and sent back to the UI thread as messages.
//! Every CLI engine runs through here; an engine only says how (its Adapter).

use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

use super::{Adapter, Ev, RunOpts};
use crate::app::Msg;

/// Start one turn for the agent in `slot`. Its events come back as
/// Msg::Engine; once its output has ended, the last of its stderr as
/// Msg::Stderr and then Msg::StreamEnd (so the exit is read with all of both).
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
    let err = std::thread::spawn(move || {
        let mut s = vec![];
        let _ = stderr.read_to_end(&mut s);
        let s = String::from_utf8_lossy(&s).into_owned();
        // the last 4000 characters are enough to say why it failed
        let skip = s.chars().count().saturating_sub(4000);
        s.chars().skip(skip).collect::<String>()
    });
    let mut parse = adapter.parser();
    let raw = adapter.raw();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = vec![];
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf).into_owned();
            let ended = line.ends_with('\n');
            let line = line.strip_suffix('\n').unwrap_or(&line).to_string();
            let evs = if raw {
                // a plain-text CLI: what it prints is the reply
                let text = line.strip_suffix('\r').unwrap_or(&line);
                vec![Ev::TextDelta(if ended { format!("{text}\n") } else { text.to_string() })]
            } else {
                let t = line.trim();
                if !t.starts_with('{') {
                    continue;
                }
                match serde_json::from_str::<Value>(t) {
                    Ok(v) => parse(&v),
                    Err(_) => vec![], // not an event (a stray log line)
                }
            };
            if !evs.is_empty() && tx.send(Msg::Engine(slot, evs)).is_err() {
                return;
            }
        }
        let tail = err.join().unwrap_or_default();
        let _ = tx.send(Msg::Stderr(slot, tail));
        let _ = tx.send(Msg::StreamEnd(slot));
    });
    Ok(child)
}
