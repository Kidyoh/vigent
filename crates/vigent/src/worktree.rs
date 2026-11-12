//! A worktree per agent, made by riftri (linked in: copy-on-write, so agents
//! share unchanged files), or by plain `git worktree` when riftri can't on this
//! volume. Same layout as the TypeScript vigent: ../<repo>-worktrees/<branch>.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub fn git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The repository `dir` is in, if any.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(&["rev-parse", "--show-toplevel"], dir).ok().map(PathBuf::from)
}

pub fn current_branch(root: &Path) -> String {
    git(&["rev-parse", "--abbrev-ref", "HEAD"], root).unwrap_or_else(|_| "HEAD".into())
}

pub fn worktrees_dir(root: &Path) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    root.parent().unwrap_or(root).join(format!("{name}-worktrees"))
}

#[derive(Clone, Debug)]
pub struct Planned {
    pub branch: String,
    pub path: PathBuf,
    pub base: String,
}

/// A free branch and folder for an agent: fix/x, then fix/x-2, ...
pub fn plan(root: &Path, agent: &str, taken: &[PathBuf]) -> Result<Planned, String> {
    let wanted = crate::names::branch_name(agent);
    git(&["check-ref-format", "--branch", &wanted], root).map_err(|_| format!("'{wanted}' is not a valid branch name"))?;
    let dir = worktrees_dir(root);
    let exists = |b: &str| git(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{b}")], root).is_ok();
    let mut branch = wanted.clone();
    let mut path = dir.join(wanted.replace('/', "-"));
    let mut n = 2;
    while taken.contains(&path) || exists(&branch) || path.exists() {
        branch = format!("{wanted}-{n}");
        path = dir.join(branch.replace('/', "-"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    Ok(Planned { branch, path, base: current_branch(root) })
}

/// How a worktree was made.
#[derive(Clone, Debug)]
pub enum Made {
    /// by riftri, on this copy-on-write backend
    Riftri(String),
    /// by git: riftri couldn't, and this is why
    Git(String),
}

/// Make the planned worktree. Blocking: run it off the UI thread.
pub fn make(root: &Path, p: &Planned) -> Result<Made, String> {
    let request = riftri_core::AddWorktreeRequest {
        repository: root.to_path_buf(),
        destination: p.path.clone(),
        revision: p.base.clone().into(),
        mode: riftri_core::WorktreeMode::NewBranch(p.branch.clone().into()),
        state_dir: None,
        sparse_directories: vec![],
    };
    match riftri_core::add_worktree(request) {
        Ok(r) => Ok(Made::Riftri(r.backend.display_name().to_string())),
        Err(e) => {
            // riftri changes nothing when it fails; plain git is the safe fallback
            if p.path.exists() {
                return Err(format!("riftri: {e}"));
            }
            let why = e.to_string();
            let path = p.path.to_string_lossy();
            git(&["worktree", "add", "-q", "-b", &p.branch, &path, &p.base], root).map_err(|g| format!("riftri: {why}; git: {g}"))?;
            Ok(Made::Git(why))
        }
    }
}

/// An agent worktree of this repository: (branch, path).
pub fn list(root: &Path) -> Vec<(String, PathBuf)> {
    let dir = worktrees_dir(root);
    let Ok(out) = git(&["worktree", "list", "--porcelain"], root) else { return vec![] };
    let mut all = vec![];
    let mut path: Option<PathBuf> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(PathBuf::from(p));
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = path.take() {
                if p.starts_with(&dir) {
                    all.push((b.to_string(), p));
                }
            }
        }
    }
    all
}

pub fn is_riftri(root: &Path, path: &Path) -> bool {
    riftri_core::is_managed_worktree(root, path).unwrap_or(false)
}

/// Remove an agent's worktree its own way (riftri's removal is journaled). The branch is kept.
pub fn remove(root: &Path, path: &Path, force: bool) -> Result<String, String> {
    if is_riftri(root, path) {
        let request = riftri_core::RemoveWorktreeRequest { repository: root.to_path_buf(), destination: path.to_path_buf(), state_dir: None };
        let r = if force { riftri_core::force_remove_worktree(request) } else { riftri_core::remove_worktree(request) };
        r.map_err(|e| e.to_string())?;
        if let Ok(state) = riftri_core::default_state_directory(root) {
            let _ = riftri_core::garbage_collect(&state, true); // free the shared base once no agent uses it
        }
    } else {
        let p = path.to_string_lossy();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&p);
        git(&args, root)?;
    }
    Ok(format!("removed {} (its branch is kept)", path.display()))
}

/// Lines added and removed by the agent, against where it started: its commits,
/// its uncommitted edits and its new files.
pub fn diff_stat(path: &Path, base: &str) -> (usize, usize) {
    let (mut added, mut removed) = (0, 0);
    if let Ok(out) = git(&["diff", "--numstat", base], path) {
        for line in out.lines() {
            let mut cols = line.split('\t');
            added += cols.next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
            removed += cols.next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
        }
    }
    if let Ok(out) = git(&["ls-files", "--others", "--exclude-standard", "-z"], path) {
        for f in out.split('\0').filter(|f| !f.is_empty()) {
            if let Ok(bytes) = std::fs::read(path.join(f)) {
                if !bytes.contains(&0) {
                    let n = bytes.iter().filter(|&&b| b == b'\n').count();
                    added += if n == 0 && !bytes.is_empty() { 1 } else { n };
                }
            }
        }
    }
    (added, removed)
}
