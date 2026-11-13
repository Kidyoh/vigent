//! Agents survive a restart (src/agents.ts): each agent's name, model, engine
//! and the id of its CLI's conversation are saved inside git's own record of
//! its worktree (.git/worktrees/<name>/vigent/agent.json), not in your files.
//! Removing the worktree (git worktree remove, :kill!) deletes the record with it.
//!
//! STUB for the Sessions area (Restore): the record's format and where it
//! lives are here and match the TypeScript vigent's, so either one reopens
//! the other's agents. Still to wire: save on every change (App::persist),
//! reopen at startup (src/agents.ts reopenableAgents, with riftri's views made
//! ready first), :kill marks `detached`, :attach clears it.

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
}

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
            usage: v.get("usage").and_then(|u| Some((u.get("tokens")?.as_u64()?, u.get("cost").and_then(Value::as_f64)))),
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
