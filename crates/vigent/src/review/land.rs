//! Getting an agent's work out of its worktree: `:merge` and `:pr` (src/review.ts).
//!
//! Both first commit whatever the agent left uncommitted, with a conventional
//! message built from the branch (fix/flaky-checkout-test -> "fix: flaky
//! checkout test").
//!
//! :merge squash-merges the branch into the base branch in your checkout (one
//! commit, like GitHub's squash merge). It refuses unless your checkout is on
//! that base branch with no uncommitted changes, and a conflict is rolled back
//! so your checkout is left exactly as it was.
//!
//! :pr pushes the branch and opens a pull request with `gh`, or prints the
//! compare URL when gh isn't available.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// An agent's worktree, as landing needs it (src/worktree.ts WorktreeInfo).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Wt {
    pub branch: String,
    pub path: Option<PathBuf>,
    pub base: Option<String>,
}

/// git's failure, as one readable line (gitError).
pub fn git_error(out: &Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr);
    let text = if err.trim().is_empty() { String::from_utf8_lossy(&out.stdout).to_string() } else { err.to_string() };
    let text = text.trim();
    let first = text.lines().next().unwrap_or("");
    let first = first.strip_prefix("fatal: ").or_else(|| first.strip_prefix("error: ")).unwrap_or(first);
    if first.is_empty() { format!("git exited with {}", out.status) } else { first.to_string() }
}

/// git, its output trimmed; Err is git's reason.
pub fn git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let out = Command::new("git").args(args).current_dir(cwd).stdin(Stdio::null()).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { Err(git_error(&out)) }
}

/// "fix/flaky-checkout-test" -> "fix: flaky checkout test"; "agent/add-search" -> "add search".
pub fn commit_message(branch: &str) -> String {
    let mut parts: Vec<&str> = branch.split('/').collect();
    let last = parts.pop().unwrap_or(branch);
    // a trailing -2, -3 ... (a second agent on the same name) isn't part of the message
    let trimmed = match last.rfind('-') {
        Some(i) if i + 1 < last.len() && last[i + 1..].bytes().all(|b| b.is_ascii_digit()) => &last[..i],
        _ => last,
    };
    let name = trimmed.replace('-', " ");
    const CONVENTIONAL: [&str; 10] = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "ci", "build", "style"];
    match parts.pop() {
        Some(t) if CONVENTIONAL.contains(&t) => format!("{t}: {name}"),
        _ => name,
    }
}

/// Commit everything the agent left uncommitted: the new commit, or None if there was nothing.
pub fn commit_pending(wt: &Wt) -> Result<Option<String>, String> {
    let path = wt.path.as_deref().ok_or("no worktree")?;
    if git(&["status", "--porcelain"], path)?.is_empty() {
        return Ok(None);
    }
    git(&["add", "-A"], path)?;
    git(&["commit", "-q", "-m", &commit_message(&wt.branch)], path).map_err(|e| format!("commit failed: {e}"))?;
    git(&["rev-parse", "--short", "HEAD"], path).map(Some)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Landed {
    pub ok: bool,
    pub message: String,
    /// :merge's commit, :pr's URL
    pub detail: Option<String>,
}

fn no(message: impl Into<String>) -> Landed {
    Landed { ok: false, message: message.into(), detail: None }
}

/// Squash-merge (default) or merge the agent's branch into its base branch, in your checkout at `root`.
pub fn merge_worktree(root: &Path, wt: &Wt, squash: bool) -> Landed {
    if wt.path.is_none() {
        return no("this agent has no worktree");
    }
    let Some(base) = wt.base.as_deref().filter(|b| !b.is_empty()) else { return no("unknown base branch for this worktree") };
    let current = git(&["branch", "--show-current"], root).unwrap_or_default();
    if current != base {
        let on = if current.is_empty() { "a detached HEAD" } else { &current };
        return no(format!("your checkout is on '{on}'; switch it to '{base}' to merge"));
    }
    match git(&["status", "--porcelain", "--untracked-files=no"], root) {
        Ok(s) if s.is_empty() => {}
        Ok(_) => return no("your checkout has uncommitted changes; commit or stash them, then :merge again"),
        Err(e) => return no(e),
    }
    let pending = match commit_pending(wt) {
        Ok(p) => p,
        Err(e) => return no(e),
    };
    let range = format!("{base}..{}", wt.branch);
    match git(&["rev-list", "--count", &range], root) {
        Ok(n) if n == "0" => return no(format!("nothing to merge: {} has no changes on top of {base}", wt.branch)),
        Ok(_) => {}
        Err(e) => return no(e),
    }
    let message = commit_message(&wt.branch);
    if squash {
        if let Err(reason) = git(&["merge", "--squash", &wt.branch], root) {
            let _ = git(&["reset", "-q", "--merge"], root); // undo the half-applied squash
            return no(format!("merge conflict, nothing changed: {reason}"));
        }
        if git(&["diff", "--cached", "--name-only"], root).unwrap_or_default().is_empty() {
            let _ = git(&["reset", "-q", "--merge"], root);
            return no(format!("nothing to merge: {} is already in {base}", wt.branch));
        }
        let log = git(&["log", "--reverse", "--format=- %s", &range], root).unwrap_or_default();
        if let Err(e) = git(&["commit", "-q", "-m", &message, "-m", &log], root) {
            return no(e);
        }
    } else {
        let msg = format!("Merge branch '{}'", wt.branch);
        if let Err(reason) = git(&["merge", "--no-ff", "-q", "-m", &msg, &wt.branch], root) {
            let _ = git(&["merge", "--abort"], root);
            return no(format!("merge conflict, nothing changed: {reason}"));
        }
    }
    let commit = git(&["rev-parse", "--short", "HEAD"], root).unwrap_or_default();
    let how = if squash { "squash-merged" } else { "merged" };
    let first = if pending.is_some() { " (committed the agent's pending changes first)" } else { "" };
    Landed { ok: true, message: format!("{how} {} into {base} as {commit}{first}", wt.branch), detail: Some(commit) }
}

/// https://github.com/owner/repo from an https or ssh remote URL, or None for other hosts.
pub fn github_web_url(remote: &str) -> Option<String> {
    let r = remote.trim();
    let at = r.find("github.com")?;
    let rest = &r[at + "github.com".len()..];
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}"))
}

/// The first https://…/pull/N in some text.
fn pull_url(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|w| {
        let start = w.find("https://")?;
        let w = &w[start..];
        let at = w.find("/pull/")?;
        let digits: String = w[at + 6..].chars().take_while(|c| c.is_ascii_digit()).collect();
        (!digits.is_empty()).then(|| format!("{}{digits}", &w[..at + 6]))
    })
}

/// A command's stdout and stderr, or None when it couldn't start or ran out of time.
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    Some(format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// Push the agent's branch and open a pull request (with gh when it's available).
pub fn open_pull_request(root: &Path, wt: &Wt, remote: &str, use_gh: bool) -> Landed {
    let Some(path) = wt.path.as_deref() else { return no("this agent has no worktree") };
    let Ok(remote_url) = git(&["remote", "get-url", remote], root) else { return no(format!("no '{remote}' remote to push to")) };
    if let Err(e) = commit_pending(wt) {
        return no(e);
    }
    if let Err(e) = git(&["push", "-q", "-u", remote, &wt.branch], path) {
        return no(format!("git push failed: {e}"));
    }
    let base = wt.base.as_deref().filter(|b| !b.is_empty()).unwrap_or("main");
    if use_gh {
        let title = commit_message(&wt.branch);
        let mut gh = Command::new("gh");
        gh.args(["pr", "create", "--base", base, "--head", &wt.branch, "--title", &title, "--fill"]).current_dir(path);
        if let Some(url) = run_with_timeout(&mut gh, Duration::from_secs(60)).as_deref().and_then(pull_url) {
            return Landed { ok: true, message: format!("pull request: {url}"), detail: Some(url) };
        }
    }
    if let Some(web) = github_web_url(&remote_url) {
        let url = format!("{web}/compare/{base}...{}?expand=1", wt.branch);
        return Landed { ok: true, message: format!("pushed {}; open the pull request at {url}", wt.branch), detail: Some(url) };
    }
    Landed { ok: true, message: format!("pushed {} to {remote}", wt.branch), detail: None }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::fs;

    /// A scratch folder, removed when dropped.
    pub struct Tmp(pub PathBuf);
    impl Tmp {
        pub fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("vigent-rs-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()).replace(['(', ')'], ""));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Tmp(p.canonicalize().unwrap())
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub fn sh(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository on main with an identity of its own (commit_pending runs plain git).
    pub fn repo(dir: &Path) -> PathBuf {
        let repo = dir.join("shop");
        fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.name", "Test"]);
        sh(&repo, &["config", "user.email", "test@example.com"]);
        sh(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join("cart.js"), "one\ntwo\nthree\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        repo
    }

    /// A plain git worktree for a branch, as vigent lays them out.
    pub fn worktree(repo: &Path, branch: &str) -> Wt {
        let path = repo.parent().unwrap().join("shop-worktrees").join(branch.replace('/', "-"));
        sh(repo, &["worktree", "add", "-q", "-b", branch, path.to_str().unwrap(), "main"]);
        Wt { branch: branch.into(), path: Some(path), base: Some("main".into()) }
    }

    #[test]
    fn commit_messages_come_from_the_branch_name() {
        assert_eq!(commit_message("fix/flaky-checkout-test"), "fix: flaky checkout test");
        assert_eq!(commit_message("docs/refresh-readme-2"), "docs: refresh readme");
        assert_eq!(commit_message("agent/add-search"), "add search");
        assert_eq!(commit_message("kinfe/feat/dark-mode"), "feat: dark mode");
    }

    #[test]
    fn merge_squashes_into_the_base_committing_pending_work_first() {
        let t = Tmp::new("merge");
        let repo = repo(&t.0);
        let wt = worktree(&repo, "fix/cart-badge");
        let p = wt.path.clone().unwrap();
        fs::write(p.join("cart.js"), "one\nTWO\nthree\n").unwrap();
        sh(&p, &["commit", "-q", "-am", "uppercase two"]);
        fs::write(p.join("badge.js"), "export const badge = 1;\n").unwrap();
        let before = sh(&repo, &["rev-parse", "HEAD"]);
        let r = merge_worktree(&repo, &wt, true);
        assert!(r.ok, "{}", r.message);
        assert!(r.message.starts_with("squash-merged fix/cart-badge into main as "), "{}", r.message);
        assert!(r.message.ends_with(" (committed the agent's pending changes first)"));
        assert_eq!(sh(&repo, &["rev-list", "--count", &format!("{before}..HEAD")]), "1");
        assert_eq!(sh(&repo, &["log", "-1", "--format=%s"]), "fix: cart badge");
        assert!(sh(&repo, &["log", "-1", "--format=%b"]).contains("- uppercase two\n- fix: cart badge"));
        assert_eq!(fs::read_to_string(repo.join("cart.js")).unwrap(), "one\nTWO\nthree\n");
        assert!(repo.join("badge.js").exists());
        assert_eq!(sh(&repo, &["status", "--porcelain"]), "");
        assert!(merge_worktree(&repo, &wt, true).message.contains("nothing to merge"));
    }

    #[test]
    fn merge_refuses_a_checkout_that_isnt_ready_and_rolls_back_conflicts() {
        let t = Tmp::new("refuse");
        let repo = repo(&t.0);
        let wt = worktree(&repo, "feat/totals");
        fs::write(wt.path.as_ref().unwrap().join("totals.js"), "1\n").unwrap();
        fs::write(repo.join("cart.js"), "local edit\n").unwrap();
        assert!(merge_worktree(&repo, &wt, true).message.contains("your checkout has uncommitted changes"));
        sh(&repo, &["checkout", "-q", "--", "cart.js"]);
        sh(&repo, &["checkout", "-q", "-b", "elsewhere"]);
        assert!(merge_worktree(&repo, &wt, true).message.contains("your checkout is on 'elsewhere'; switch it to 'main'"));
        sh(&repo, &["checkout", "-q", "main"]);
        assert!(!merge_worktree(&repo, &Wt { branch: "x".into(), ..Default::default() }, true).ok);

        // a conflict leaves your checkout exactly as it was
        let wt = worktree(&repo, "fix/line-three");
        fs::write(wt.path.as_ref().unwrap().join("cart.js"), "one\nTWO\nagent three\n").unwrap();
        fs::write(repo.join("cart.js"), "one\nTWO\nyour three\n").unwrap();
        sh(&repo, &["commit", "-q", "-am", "your change"]);
        let head = sh(&repo, &["rev-parse", "HEAD"]);
        let r = merge_worktree(&repo, &wt, true);
        assert!(!r.ok);
        assert!(r.message.contains("merge conflict, nothing changed"), "{}", r.message);
        assert_eq!(sh(&repo, &["rev-parse", "HEAD"]), head);
        assert_eq!(sh(&repo, &["status", "--porcelain"]), "");
        assert_eq!(fs::read_to_string(repo.join("cart.js")).unwrap(), "one\nTWO\nyour three\n");

        // --no-squash makes a merge commit
        let wt = worktree(&repo, "docs/readme");
        fs::write(wt.path.as_ref().unwrap().join("README.md"), "# shop\n").unwrap();
        let r = merge_worktree(&repo, &wt, false);
        assert!(r.ok, "{}", r.message);
        assert_eq!(sh(&repo, &["log", "-1", "--format=%s"]), "Merge branch 'docs/readme'");
        assert_eq!(sh(&repo, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
    }

    #[test]
    fn pr_pushes_the_branch_and_gives_the_compare_url_without_gh() {
        let t = Tmp::new("pr");
        let repo = repo(&t.0);
        let bare = t.0.join("origin.git");
        sh(&t.0, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        sh(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let wt = worktree(&repo, "feat/search-box");
        fs::write(wt.path.as_ref().unwrap().join("search.js"), "find()\n").unwrap();
        let r = open_pull_request(&repo, &wt, "origin", false);
        assert!(r.ok, "{}", r.message);
        assert!(sh(&repo, &["ls-remote", "--heads", "origin"]).contains("refs/heads/feat/search-box"));
        assert!(r.message.contains("pushed feat/search-box"));
        assert_eq!(github_web_url("git@github.com:farming-labs/vigent.git").as_deref(), Some("https://github.com/farming-labs/vigent"));
        assert_eq!(github_web_url("https://github.com/farming-labs/vigent").as_deref(), Some("https://github.com/farming-labs/vigent"));
        assert_eq!(github_web_url("https://gitlab.com/a/b.git"), None);
        assert!(open_pull_request(&repo, &wt, "nope", false).message.contains("no 'nope' remote"));
        assert_eq!(pull_url("Creating pull request\nhttps://github.com/a/b/pull/12\n").as_deref(), Some("https://github.com/a/b/pull/12"));
    }
}
