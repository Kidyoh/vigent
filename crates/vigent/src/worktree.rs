//! A worktree per agent (src/worktree.ts, src/riftri.ts), made by riftri
//! (linked in: copy-on-write, so agents share unchanged files), or by plain
//! `git worktree` when riftri can't on this volume or is turned off. Same
//! layout and rules as the TypeScript vigent: [worktree] dir (default
//! ../{repo}-worktrees), branch ({type}/{name}), base and backend.
//!
//! Removing is always the safe path: git (or riftri) refuses a worktree with
//! uncommitted changes, and an unmerged branch is kept, unless forced.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use crate::config::WorktreeConfig;

pub const RIFTRI_INSTALL: &str = "npm install -g riftri  (or: curl -fsSL https://riftri.dev/install.sh | bash)";

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

fn git_ok(args: &[&str], cwd: &Path) -> bool {
    git(args, cwd).is_ok()
}

/// A failed git command, readable: its first line without "fatal: " (src/worktree.ts gitError).
pub fn git_error(stderr: &str) -> String {
    let first = stderr.trim().lines().next().unwrap_or("").to_string();
    first.strip_prefix("fatal: ").or_else(|| first.strip_prefix("error: ")).map(str::to_string).unwrap_or(first)
}

/// The repository `dir` is in, if any.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(&["rev-parse", "--show-toplevel"], dir).ok().map(PathBuf::from)
}

/// The branch checked out (or the commit, when HEAD is detached).
pub fn current_branch(root: &Path) -> String {
    git(&["symbolic-ref", "--short", "-q", "HEAD"], root)
        .or_else(|_| git(&["rev-parse", "--short", "HEAD"], root))
        .unwrap_or_else(|_| "HEAD".into())
}

/// Where agent worktrees go: [worktree] dir, `{repo}` the repository's folder name, relative to the repository.
pub fn worktrees_dir(root: &Path, cfg: &WorktreeConfig) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    normalize(&root.join(cfg.dir.replace("{repo}", &name)))
}

/// `a/b/../c` -> `a/c`, without touching the disk (path.resolve).
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// Can riftri make worktrees here? It's linked in, but `RIFTRI_BINARY` naming
/// a file that isn't there turns it off, as it does for the TypeScript vigent.
pub fn riftri_available() -> bool {
    match std::env::var_os("RIFTRI_BINARY") {
        Some(p) if !p.is_empty() => Path::new(&p).exists(),
        _ => true,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Planned {
    pub branch: String,
    pub path: PathBuf,
    pub base: String,
}

/// Folders picked by plan() whose worktree isn't made yet, so two new agents never pick the same one.
static PLANNED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
/// Worktrees are made one at a time per repository: git and riftri both write the repository's own records.
static MAKING: Mutex<()> = Mutex::new(());

/// A free branch and folder for an agent: fix/x, then fix/x-2, ... Nothing is made yet (make() does).
pub fn plan(root: &Path, agent: &str, cfg: &WorktreeConfig) -> Result<Planned, String> {
    let base = cfg.base.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| current_branch(root));
    let wanted = crate::names::branch_name_with(agent, &cfg.branch);
    if !git_ok(&["check-ref-format", "--branch", &wanted], root) {
        return Err(format!("'{wanted}' is not a valid branch name (check [worktree] branch)"));
    }
    let dir = worktrees_dir(root, cfg);
    let exists = |b: &str| git_ok(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{b}")], root);
    let mut planned = PLANNED.lock().unwrap_or_else(|e| e.into_inner());
    let mut branch = wanted.clone();
    let mut path = dir.join(wanted.replace('/', "-"));
    let mut n = 2;
    while planned.contains(&path) || exists(&branch) || path.exists() {
        branch = format!("{wanted}-{n}");
        path = dir.join(branch.replace('/', "-"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    exclude_if_inside(root, &dir);
    planned.push(path.clone());
    Ok(Planned { branch, path, base })
}

/// A planned folder that won't be made after all (or was): free its name.
pub fn unplan(path: &Path) {
    PLANNED.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| p != path);
}

/// A worktrees folder inside the repository goes in .git/info/exclude, so `git status` stays clean.
fn exclude_if_inside(root: &Path, dir: &Path) {
    let Ok(rel) = dir.strip_prefix(root) else { return };
    if rel.as_os_str().is_empty() {
        return;
    }
    let Ok(file) = git(&["rev-parse", "--git-path", "info/exclude"], root) else { return };
    let file = root.join(file);
    let entry = format!("/{}/", rel.to_string_lossy().replace('\\', "/"));
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    if current.lines().any(|l| l == entry) {
        return;
    }
    if let Some(d) = file.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let sep = if !current.is_empty() && !current.ends_with('\n') { "\n" } else { "" };
    let _ = std::fs::write(&file, format!("{current}{sep}{entry}\n"));
}

/// How a worktree was made.
#[derive(Clone, Debug, PartialEq)]
pub enum Made {
    /// by riftri, on this copy-on-write backend (its id: reflink, overlay-fs, apfs-clone, ...)
    Riftri(String),
    /// by git: riftri declined, and this is why (`riftriSkipped`)
    Git(String),
    /// by git: riftri is off ([worktree] backend = "git") or not available
    Plain,
}

/// riftri's id for a backend ("overlay-fs").
pub fn backend_id(kind: impl serde::Serialize) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "riftri".into())
}

/// What vigent calls a riftri backend (src/riftri.ts backendName).
pub fn backend_name(id: &str) -> String {
    match id {
        "reflink" => "Btrfs/XFS reflinks",
        "apfs-clone" | "apfs" => "APFS clones",
        "refs-block-clone" | "refs" => "ReFS block clones",
        "overlay-fs" => "OverlayFS",
        "riftri" => "copy-on-write",
        other => other,
    }
    .to_string()
}

/// Make the planned worktree. Blocking: run it off the UI thread.
pub fn make(root: &Path, p: &Planned, cfg: &WorktreeConfig) -> Result<Made, String> {
    let _turn = MAKING.lock().unwrap_or_else(|e| e.into_inner());
    let r = make_now(root, p, cfg);
    unplan(&p.path);
    r
}

fn make_now(root: &Path, p: &Planned, cfg: &WorktreeConfig) -> Result<Made, String> {
    let mut made = Made::Plain;
    if cfg.backend != "git" {
        if !riftri_available() {
            if cfg.backend == "riftri" {
                return Err(format!("[worktree] backend is \"riftri\", but riftri isn't installed: {RIFTRI_INSTALL}"));
            }
        } else {
            let request = riftri_core::AddWorktreeRequest {
                repository: root.to_path_buf(),
                destination: p.path.clone(),
                revision: p.base.clone().into(),
                mode: riftri_core::WorktreeMode::NewBranch(p.branch.clone().into()),
                state_dir: None,
                sparse_directories: vec![],
            };
            match riftri_core::add_worktree(request) {
                Ok(r) => return Ok(Made::Riftri(backend_id(r.backend))),
                Err(e) => {
                    // riftri changes nothing when it declines; plain git is the safe fallback
                    if p.path.exists() || cfg.backend == "riftri" {
                        return Err(format!("riftri worktree add failed: {e}"));
                    }
                    made = Made::Git(e.to_string());
                }
            }
        }
    }
    let path = p.path.to_string_lossy();
    git(&["worktree", "add", "-b", &p.branch, &path, &p.base], root).map_err(|e| format!("git worktree add failed: {}", git_error(&e)))?;
    Ok(made)
}

/// A worktree vigent manages: one inside the worktrees folder (src/worktree.ts ListedWorktree).
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub path: PathBuf,
    pub branch: Option<String>,
    /// the commit it's on, short
    pub head: String,
}

/// The agent worktrees of this repository, as git lists them.
pub fn list(root: &Path, cfg: &WorktreeConfig) -> Result<Vec<Listed>, String> {
    let dir = worktrees_dir(root, cfg);
    let out = git(&["worktree", "list", "--porcelain"], root)?;
    let mut all = vec![];
    let mut cur: Option<Listed> = None;
    let flush = |cur: &mut Option<Listed>, all: &mut Vec<Listed>| {
        if let Some(w) = cur.take()
            && w.path != dir
            && w.path.starts_with(&dir)
        {
            all.push(w);
        }
    };
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut cur, &mut all);
            cur = Some(Listed { path: PathBuf::from(p), branch: None, head: String::new() });
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(c) = cur.as_mut() {
                c.head = h.chars().take(7).collect();
            }
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(c) = cur.as_mut() {
                c.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
    }
    flush(&mut cur, &mut all);
    Ok(all)
}

/// Find an agent worktree by branch, folder name, path, or the branch an agent of that name would get.
pub fn find(root: &Path, query: &str, cfg: &WorktreeConfig) -> Option<Listed> {
    let all = list(root, cfg).ok()?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let abs = normalize(&cwd.join(query));
    let by_name = crate::names::branch_name_with(query, &cfg.branch);
    all.iter()
        .find(|w| w.branch.as_deref() == Some(query))
        .or_else(|| all.iter().find(|w| w.path.file_name().is_some_and(|n| n == query)))
        .or_else(|| all.iter().find(|w| w.path == abs))
        .or_else(|| all.iter().find(|w| w.branch.as_deref() == Some(by_name.as_str())))
        .cloned()
}

/// riftri's state for this repository, if it has made worktrees here (src/riftri.ts riftriStateDir).
pub fn riftri_state_dir(root: &Path) -> Option<PathBuf> {
    let common = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"], root).ok()?;
    let dir = PathBuf::from(common).join("riftri");
    dir.exists().then_some(dir)
}

/// Does riftri manage this worktree? Err: riftri couldn't say, so don't touch it with plain git.
pub fn riftri_ownership(root: &Path, path: &Path) -> Result<Option<String>, String> {
    if riftri_state_dir(root).is_none() {
        return Ok(None);
    }
    if !riftri_available() {
        return Err(format!("this repository has riftri worktrees, but riftri isn't installed: {RIFTRI_INSTALL}"));
    }
    let r = riftri_core::inspect_managed_worktrees(root, &[path.to_path_buf()]).map_err(|e| e.to_string())?;
    Ok(r.into_iter().next().filter(|w| w.state_directory.is_some()).map(|w| w.backend.map(backend_id).unwrap_or_else(|| "riftri".into())))
}

pub fn is_riftri(root: &Path, path: &Path) -> bool {
    matches!(riftri_ownership(root, path), Ok(Some(_)))
}

/// Which of these worktrees riftri manages, and on which backend (src/riftri.ts riftriBackends).
pub fn riftri_backends(root: &Path, paths: &[PathBuf]) -> HashMap<PathBuf, String> {
    let mut out = HashMap::new();
    if paths.is_empty() || riftri_state_dir(root).is_none() || !riftri_available() {
        return out;
    }
    if let Ok(r) = riftri_core::inspect_managed_worktrees(root, paths) {
        for (w, p) in r.into_iter().zip(paths) {
            if w.state_directory.is_some() {
                out.insert(p.clone(), w.backend.map(backend_id).unwrap_or_else(|| "riftri".into()));
            }
        }
    }
    out
}

/// Whether a worktree can be used now (src/riftri.ts ViewReadiness).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Readiness {
    pub ready: bool,
    pub backend: Option<String>,
    pub reason: Option<String>,
}

/// Before reopening agents: inspect their worktrees, repair views whose
/// OverlayFS mount went away (a reboot), and inspect again; only the second
/// inspection counts (src/riftri.ts prepareViews).
pub fn prepare_views(root: &Path, paths: &[PathBuf]) -> HashMap<PathBuf, Readiness> {
    let mut out: HashMap<PathBuf, Readiness> = paths.iter().map(|p| (p.clone(), Readiness { ready: true, ..Default::default() })).collect();
    if paths.is_empty() || riftri_state_dir(root).is_none() || !riftri_available() {
        return out;
    }
    let fail = |out: &mut HashMap<PathBuf, Readiness>, why: String| {
        for p in paths {
            out.insert(p.clone(), Readiness { ready: false, backend: None, reason: Some(why.clone()) });
        }
    };
    let mut report = match riftri_core::inspect_managed_worktrees(root, paths) {
        Ok(r) => r,
        Err(e) => {
            fail(&mut out, e.to_string());
            return out;
        }
    };
    let mut repair: Vec<PathBuf> = vec![];
    for w in &report {
        if w.mount_status == Some(riftri_core::WorktreeMountStatus::RecoveryRequired)
            && let Some(d) = &w.state_directory
            && !repair.contains(d)
        {
            repair.push(d.clone());
        }
    }
    if !repair.is_empty() {
        for d in &repair {
            let _ = riftri_core::recover_incomplete_operations(d);
        }
        report = match riftri_core::inspect_managed_worktrees(root, paths) {
            Ok(r) => r,
            Err(e) => {
                fail(&mut out, e.to_string());
                return out;
            }
        };
    }
    for (w, p) in report.into_iter().zip(paths) {
        let status = w.mount_status.map(backend_id);
        let ready = status.is_none() || status.as_deref() == Some("active");
        let reason = (!ready).then(|| {
            let dir = w.state_directory.as_deref().map(|d| d.display().to_string()).unwrap_or_default();
            format!("riftri reports its mount as {}; run: riftri repair --state-dir '{dir}'", status.clone().unwrap_or_default())
        });
        out.insert(p.clone(), Readiness { ready, backend: w.backend.map(backend_id), reason });
    }
    out
}

/// Reclaim riftri storage no worktree uses any more. The bytes freed.
pub fn riftri_gc(root: &Path) -> Result<u64, String> {
    let state = riftri_core::default_state_directory(root).map_err(|e| e.to_string())?;
    riftri_core::garbage_collect(&state, true).map(|r| r.removed_allocated_bytes).map_err(|e| e.to_string())
}

/// 16211491 -> "15.5 MB" (src/riftri.ts formatBytes)
pub fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v >= 100.0 || i == 0 { format!("{} {}", v.round(), UNITS[i]) } else { format!("{v:.1} {}", UNITS[i]) }
}

/// What remove() did (src/worktree.ts RemoveResult).
#[derive(Debug, PartialEq)]
pub struct Removed {
    pub removed: bool,
    pub branch_deleted: bool,
    pub message: String,
}

/// Remove a worktree its own way (riftri's removal is journaled), then delete
/// its branch if it's merged. Without `force` a worktree with uncommitted
/// changes stays, and so does an unmerged branch.
pub fn remove(root: &Path, path: &Path, branch: Option<&str>, base: Option<&str>, force: bool) -> Removed {
    let fail = |message: String| Removed { removed: false, branch_deleted: false, message };
    let dirty = format!("{} has uncommitted changes; use force to remove it anyway", path.display());
    match riftri_ownership(root, path) {
        Err(e) => return fail(e),
        Ok(Some(_)) => {
            let request = riftri_core::RemoveWorktreeRequest { repository: root.to_path_buf(), destination: path.to_path_buf(), state_dir: None };
            let r = if force { riftri_core::force_remove_worktree(request) } else { riftri_core::remove_worktree(request) };
            if let Err(e) = r {
                let m = e.to_string();
                let lower = m.to_lowercase();
                let is_dirty = ["has changes", "uncommitted", "dirty"].iter().any(|w| lower.contains(w));
                return fail(if is_dirty { dirty } else { format!("removing the worktree failed: {m}") });
            }
            let _ = riftri_gc(root); // free the shared base once no agent uses it
        }
        Ok(None) => {
            let p = path.to_string_lossy();
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.push(&p);
            if let Err(e) = git(&args, root) {
                let reason = git_error(&e);
                let is_dirty = reason.contains("modified or untracked") || reason.contains("contains modified");
                return fail(if is_dirty { dirty } else { reason });
            }
        }
    }
    let Some(branch) = branch else {
        return Removed { removed: true, branch_deleted: false, message: format!("removed {}", path.display()) };
    };
    let merged = force || is_squash_merged(root, branch, base);
    match git(&["branch", if merged { "-D" } else { "-d" }, branch], root) {
        Ok(_) => Removed { removed: true, branch_deleted: true, message: format!("removed {} and branch {branch}", path.display()) },
        Err(_) => Removed { removed: true, branch_deleted: false, message: format!("removed {}; kept branch {branch} (it has commits that aren't merged)", path.display()) },
    }
}

/// A squash merge makes a new commit, so git doesn't see the branch as merged:
/// it is, when every file it changed has the same content on base.
pub fn is_squash_merged(root: &Path, branch: &str, base: Option<&str>) -> bool {
    let Some(base) = base else { return false };
    let Ok(fork) = git(&["merge-base", base, branch], root) else { return false };
    let Ok(files) = git(&["diff", "--name-only", &fork, branch], root) else { return false };
    let files: Vec<&str> = files.lines().filter(|l| !l.is_empty()).collect();
    if files.is_empty() {
        return false;
    }
    let mut args = vec!["diff", "--quiet", base, branch, "--"];
    args.extend(files);
    git_ok(&args, root)
}

/// The commit the worktree branched from, so later commits on the base don't count as changes.
fn fork_point(path: &Path, base: &str) -> String {
    if base.is_empty() {
        return "HEAD".into();
    }
    git(&["merge-base", base, "HEAD"], path).unwrap_or_else(|_| base.to_string())
}

/// Lines added and removed by the agent since it started: its commits, its
/// uncommitted edits and its new files.
pub fn diff_stat(path: &Path, base: &str) -> (usize, usize) {
    let (mut added, mut removed) = (0, 0);
    let from = fork_point(path, base);
    if let Ok(out) = git(&["diff", "--numstat", &from], path) {
        for line in out.lines() {
            let mut cols = line.split('\t');
            added += cols.next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
            removed += cols.next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
        }
    }
    if let Ok(out) = git(&["ls-files", "--others", "--exclude-standard", "-z"], path) {
        for f in out.split('\0').filter(|f| !f.is_empty()) {
            if let Ok(bytes) = std::fs::read(path.join(f)) {
                added += line_count(&bytes);
            }
        }
    }
    (added, removed)
}

/// Lines in a new file as git diff counts them (a last line without a newline counts); 0 for a binary file.
pub fn line_count(bytes: &[u8]) -> usize {
    if bytes.contains(&0) {
        return 0;
    }
    let n = bytes.iter().filter(|&&b| b == b'\n').count();
    match bytes.last() {
        None | Some(b'\n') => n,
        _ => n + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_backends_read_like_the_typescript() {
        assert_eq!(format_bytes(16211491), "15.5 MB");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(150 * 1024), "150 KB");
        assert_eq!(backend_name("overlay-fs"), "OverlayFS");
        assert_eq!(backend_id(riftri_core::WorktreeMountStatus::RecoveryRequired), "recovery-required");
        assert_eq!(line_count(b"a\nb"), 2);
        assert_eq!(line_count(b"a\n"), 1);
        assert_eq!(line_count(b""), 0);
        assert_eq!(git_error("fatal: 'x' is already checked out\nmore"), "'x' is already checked out");
        assert_eq!(normalize(Path::new("/a/shop/../shop-worktrees")), PathBuf::from("/a/shop-worktrees"));
    }

    #[test]
    fn worktrees_live_beside_the_repository() {
        let cfg = WorktreeConfig::default();
        assert_eq!(worktrees_dir(Path::new("/w/shop"), &cfg), PathBuf::from("/w/shop-worktrees"));
        let inside = WorktreeConfig { dir: ".worktrees".into(), ..WorktreeConfig::default() };
        assert_eq!(worktrees_dir(Path::new("/w/shop"), &inside), PathBuf::from("/w/shop/.worktrees"));
    }
}
