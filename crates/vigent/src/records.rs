//! Agents survive a restart (src/agents.ts): each agent's name, model, engine
//! and the id of its CLI's conversation are saved inside git's own record of
//! its worktree (.git/worktrees/<name>/vigent/agent.json), not in your files.
//! Removing the worktree (git worktree remove, :kill!) deletes the record with it.
//!
//! The record's format and where it lives match the TypeScript vigent's, so
//! either one reopens the other's agents; keys this build doesn't know are
//! kept as they are. Saved when the worktree is made, when the CLI reports
//! its conversation id, and when a run ends (agents.rs); :kill marks it
//! `detached` (not reopened at startup), :attach clears that.

use crate::config::WorktreeConfig;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// One agent's record (src/agents.ts AgentMeta). Field names are the JSON's.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentMeta {
    pub name: String,
    pub model: String,
    pub base: Option<String>,
    /// ISO 8601: agents reopen in the order they were made
    pub created_at: String,
    /// stopped with :kill: kept on disk, not reopened at startup (:attach brings it back)
    pub detached: bool,
    /// what runs the agent; None = pi
    pub engine: Option<String>,
    /// a CLI engine's conversation id, to continue it
    pub resume_id: Option<String>,
    /// the model asked for (CLI engines; None = the CLI's own default)
    pub requested_model: Option<String>,
    pub effort: Option<String>,
    /// what a CLI agent has used so far
    pub usage: Option<(u64, Option<f64>)>,
    /// keys this build doesn't know (another vigent's), written back as they were
    pub extra: Map<String, Value>,
}

const KNOWN_KEYS: [&str; 10] = ["name", "model", "base", "createdAt", "detached", "engine", "resumeId", "requestedModel", "effort", "usage"];

impl AgentMeta {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), self.name.clone().into());
        m.insert("model".into(), self.model.clone().into());
        if let Some(b) = &self.base {
            m.insert("base".into(), b.clone().into());
        }
        m.insert("createdAt".into(), self.created_at.clone().into());
        if self.detached {
            m.insert("detached".into(), true.into());
        }
        for (k, v) in [("engine", &self.engine), ("resumeId", &self.resume_id), ("requestedModel", &self.requested_model), ("effort", &self.effort)] {
            if let Some(v) = v {
                m.insert(k.into(), v.clone().into());
            }
        }
        if let Some((tokens, cost)) = self.usage {
            let mut u = Map::new();
            u.insert("tokens".into(), tokens.into());
            if let Some(c) = cost {
                u.insert("cost".into(), c.into());
            }
            m.insert("usage".into(), Value::Object(u));
        }
        for (k, v) in &self.extra {
            m.entry(k.clone()).or_insert_with(|| v.clone());
        }
        Value::Object(m)
    }

    pub fn from_json(v: &Value) -> Option<AgentMeta> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(AgentMeta {
            name: s("name")?,
            model: s("model")?,
            base: s("base"),
            created_at: s("createdAt").unwrap_or_default(),
            detached: v.get("detached").and_then(Value::as_bool).unwrap_or(false),
            engine: s("engine"),
            resume_id: s("resumeId"),
            requested_model: s("requestedModel"),
            effort: s("effort"),
            usage: v.get("usage").and_then(|u| Some((u.get("tokens")?.as_f64()? as u64, u.get("cost").and_then(Value::as_f64)))),
            extra: v.as_object().map(|o| o.iter().filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default(),
        })
    }
}

/// vigent's folder in git's per-worktree admin dir.
pub fn agent_state_dir(worktree: &Path) -> Option<PathBuf> {
    crate::worktree::git(&["rev-parse", "--absolute-git-dir"], worktree).ok().map(|d| PathBuf::from(d).join("vigent"))
}

pub fn save(worktree: &Path, meta: &AgentMeta) -> std::io::Result<()> {
    let dir = agent_state_dir(worktree).ok_or_else(|| std::io::Error::other("not a git worktree"))?;
    std::fs::create_dir_all(&dir)?;
    // tab-indented with a final newline, as JSON.stringify(meta, null, "\t") writes it
    let mut out = vec![];
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b"\t"));
    serde::Serialize::serialize(&meta.to_json(), &mut ser).map_err(std::io::Error::other)?;
    out.push(b'\n');
    std::fs::write(dir.join("agent.json"), out)
}

pub fn load(worktree: &Path) -> Option<AgentMeta> {
    let text = std::fs::read_to_string(agent_state_dir(worktree)?.join("agent.json")).ok()?;
    AgentMeta::from_json(&serde_json::from_str(&text).ok()?)
}

/// Where pi keeps this agent's conversation.
pub fn session_dir(worktree: &Path) -> Option<PathBuf> {
    agent_state_dir(worktree).map(|d| d.join("sessions"))
}

/// Mark an agent stopped (:kill) or running again (:attach).
pub fn set_detached(worktree: &Path, detached: bool) {
    if let Some(mut meta) = load(worktree) {
        meta.detached = detached;
        let _ = save(worktree, &meta);
    }
}

/// Change a saved record, if there is one (a fork, or an agent outside any worktree, has none).
pub fn update(worktree: &Path, f: impl FnOnce(&mut AgentMeta)) {
    if let Some(mut meta) = load(worktree) {
        f(&mut meta);
        let _ = save(worktree, &meta);
    }
}

/// An agent to reopen: its record and its worktree.
#[derive(Clone, Debug, PartialEq)]
pub struct Restorable {
    pub meta: AgentMeta,
    pub branch: String,
    pub path: PathBuf,
    /// riftri's backend, when riftri made it
    pub backend: Option<String>,
}

/// Agents to reopen at startup: vigent worktrees with a saved, non-detached
/// agent, oldest first (src/agents.ts restorableAgents).
pub fn restorable(root: &Path, cfg: &WorktreeConfig) -> Vec<Restorable> {
    let mut out = vec![];
    for w in crate::worktree::list(root, cfg).unwrap_or_default() {
        let Some(branch) = w.branch else { continue };
        if !w.path.exists() {
            continue;
        }
        let Some(meta) = load(&w.path).filter(|m| !m.detached) else { continue };
        out.push(Restorable { meta, branch, path: w.path, backend: None });
    }
    out.sort_by(|a, b| a.meta.created_at.cmp(&b.meta.created_at));
    out
}

/// What reopenable() found: the agents, and riftri views that can't be used yet (with why).
#[derive(Debug, Default)]
pub struct Reopen {
    pub agents: Vec<Restorable>,
    pub blocked: Vec<(PathBuf, String)>,
}

/// Agents to reopen at startup, with riftri's views made ready first: an
/// OverlayFS view loses its mount when the machine restarts, and its record
/// (kept through the worktree's .git) can't be read until riftri repaired it
/// (src/agents.ts reopenableAgents).
pub fn reopenable(root: &Path, cfg: &WorktreeConfig) -> Reopen {
    let listed: Vec<_> = crate::worktree::list(root, cfg).unwrap_or_default().into_iter().filter(|w| w.branch.is_some()).collect();
    let paths: Vec<PathBuf> = listed.iter().map(|w| w.path.clone()).collect();
    let views = crate::worktree::prepare_views(root, &paths);
    let mut r = Reopen::default();
    for w in listed {
        let view = views.get(&w.path);
        if let Some(v) = view.filter(|v| !v.ready) {
            r.blocked.push((w.path.clone(), v.reason.clone().unwrap_or_else(|| "not ready".into())));
            continue;
        }
        if !w.path.exists() {
            continue;
        }
        let Some(meta) = load(&w.path).filter(|m| !m.detached) else { continue };
        r.agents.push(Restorable { meta, branch: w.branch.unwrap_or_default(), path: w.path, backend: view.and_then(|v| v.backend.clone()) });
    }
    r.agents.sort_by(|a, b| a.meta.created_at.cmp(&b.meta.created_at));
    r
}

/// Now, as JavaScript's `new Date().toISOString()` writes it: 2026-01-02T03:04:05.678Z.
pub fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    iso(d.as_secs() as i64, d.subsec_millis())
}

/// Seconds since 1970 (UTC) as ISO 8601 with milliseconds.
pub fn iso(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // days to a civil date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_reads_what_the_typescript_vigent_writes() {
        let ts = r#"{"name":"fix cart","model":"","createdAt":"2026-01-02T03:04:05.000Z","engine":"claude","resumeId":"abc","usage":{"tokens":1200,"cost":0.5}}"#;
        let m = AgentMeta::from_json(&serde_json::from_str(ts).unwrap()).unwrap();
        assert_eq!(m.engine.as_deref(), Some("claude"));
        assert_eq!(m.usage, Some((1200, Some(0.5))));
        assert_eq!(AgentMeta::from_json(&m.to_json()).unwrap(), m);
    }
}
