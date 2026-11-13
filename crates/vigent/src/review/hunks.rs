//! `:review`'s diff, file by file and hunk by hunk (src/hunks.ts), and the
//! diff text itself (diffText in src/worktree.ts).
//!
//! The diff is the agent's whole change, fork point → working tree (commits,
//! uncommitted edits and new files). Dropping a hunk reverse-applies just that
//! hunk to the worktree (`git apply -R`), so `:merge` / `:pr`, which commit
//! what's in the worktree, no longer carry it. Undo applies it again.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, PartialEq)]
pub struct Hunk {
    /// the `@@ -a,b +c,d @@` line
    pub header: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileDiff {
    pub path: String,
    /// `diff --git` through `+++`
    pub header: Vec<String>,
    pub hunks: Vec<Hunk>,
    pub binary: bool,
}

/// Split `git diff` output into files and hunks.
pub fn parse_diff(text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = vec![];
    let mut in_hunk = false;
    for line in text.strip_suffix('\n').unwrap_or(text).split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // "a/<path> b/<path>": the b side, split at the last " b/" the way the regex's greedy (.*) does
            let path = rest.strip_prefix("a/").and_then(|r| r.rfind(" b/").map(|i| r[i + 3..].to_string())).unwrap_or_else(|| rest.to_string());
            files.push(FileDiff { path, header: vec![line.to_string()], hunks: vec![], binary: false });
            in_hunk = false;
            continue;
        }
        let Some(file) = files.last_mut() else { continue };
        if line.starts_with("@@") {
            file.hunks.push(Hunk { header: line.to_string(), lines: vec![] });
            in_hunk = true;
            continue;
        }
        if in_hunk {
            // "… N more lines" from a truncated diff is not part of any hunk
            if line.is_empty() || line.starts_with([' ', '+', '-', '\\']) {
                file.hunks.last_mut().unwrap().lines.push(line.to_string());
            }
            continue;
        }
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.binary = true;
        }
        file.header.push(line.to_string());
    }
    files
}

/// A patch with one file's header and just these of its hunks.
pub fn patch_for(file: &FileDiff, hunks: &[Hunk]) -> String {
    let mut out: Vec<&str> = file.header.iter().map(String::as_str).collect();
    for h in hunks {
        out.push(&h.header);
        out.extend(h.lines.iter().map(String::as_str));
    }
    format!("{}\n", out.join("\n"))
}

fn git_apply(cwd: &Path, patch: &str, reverse: bool) -> Result<(), String> {
    let mut args = vec!["apply"];
    if reverse {
        args.push("-R");
    }
    args.extend(["--whitespace=nowarn", "--recount", "-"]);
    let mut child = Command::new("git")
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(patch.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let first = err.trim().lines().next().unwrap_or("").to_string();
    let first = first.strip_prefix("error: ").map(str::to_string).unwrap_or(first);
    Err(if first.is_empty() { format!("git apply exited with {}", out.status) } else { first })
}

/// Take a change out of the agent's worktree.
pub fn drop_patch(worktree: &Path, patch: &str) -> Result<(), String> {
    git_apply(worktree, patch, true)
}

/// Put a dropped change back.
pub fn restore_patch(worktree: &Path, patch: &str) -> Result<(), String> {
    git_apply(worktree, patch, false)
}

/// git's stdout, untrimmed; `git diff --no-index` exits 1 when files differ, and its stdout is still the diff.
fn git_out(args: &[&str], cwd: &Path) -> Result<String, String> {
    let out = Command::new("git").args(args).current_dir(cwd).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if out.status.success() || out.status.code() == Some(1) && !out.stdout.is_empty() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The commit the worktree branched from, so later commits on the base don't show as changes.
pub fn fork_point(path: &Path, base: &str) -> String {
    if base.is_empty() {
        return "HEAD".into();
    }
    match git_out(&["merge-base", base, "HEAD"], path) {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => base.to_string(),
    }
}

fn untracked(path: &Path) -> Result<Vec<String>, String> {
    Ok(git_out(&["ls-files", "--others", "--exclude-standard", "-z"], path)?.split('\0').filter(|f| !f.is_empty()).map(str::to_string).collect())
}

/// Unified diff of everything the agent changed, new files included (at most `max_lines` lines).
pub fn diff_text(path: &Path, base: &str, max_lines: Option<usize>) -> Result<String, String> {
    let from = fork_point(path, base);
    let mut text = git_out(&["diff", "--no-color", &from], path)?;
    for file in untracked(path)? {
        text += &git_out(&["diff", "--no-color", "--no-index", "--", "/dev/null", &file], path)?;
    }
    if let Some(max) = max_lines {
        let lines: Vec<&str> = text.split('\n').collect();
        if lines.len() > max {
            return Ok(format!("{}\n… {} more lines", lines[..max].join("\n"), lines.len() - max));
        }
    }
    Ok(text)
}

/// Files changed, lines added, lines removed since the fork point (diffStat).
pub fn diff_stat(path: &Path, base: &str) -> (usize, usize, usize) {
    let from = fork_point(path, base);
    let (mut files, mut added, mut removed) = (0, 0, 0);
    for line in git_out(&["diff", "--numstat", &from], path).unwrap_or_default().lines() {
        let mut cols = line.split('\t');
        let (Some(a), Some(r), Some(_)) = (cols.next(), cols.next(), cols.next()) else { continue };
        files += 1;
        added += a.parse::<usize>().unwrap_or(0);
        removed += r.parse::<usize>().unwrap_or(0);
    }
    for f in untracked(path).unwrap_or_default() {
        files += 1;
        if let Ok(bytes) = std::fs::read(path.join(&f)) {
            if !bytes.contains(&0) && !bytes.is_empty() {
                let n = bytes.iter().filter(|&&b| b == b'\n').count();
                added += if bytes.last() == Some(&b'\n') { n } else { n + 1 };
            }
        }
    }
    (files, added, removed)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::review::land::tests::{Tmp, sh};
    use std::fs;
    use std::path::PathBuf;

    /// A repo, and an agent's worktree with: a committed change, an uncommitted one in the same file, and a new file.
    pub fn setup(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.name", "T"]);
        sh(&repo, &["config", "user.email", "t@e.com"]);
        sh(&repo, &["config", "commit.gpgsign", "false"]);
        let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        fs::write(repo.join("cart.js"), body).unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-qm", "base"]);
        let wt = dir.join("repo-wt");
        sh(&repo, &["worktree", "add", "-q", "-b", "fix/cart", wt.to_str().unwrap(), "main"]);
        let cart = wt.join("cart.js");
        fs::write(&cart, fs::read_to_string(&cart).unwrap().replace("line 3\n", "line three\n")).unwrap();
        sh(&wt, &["commit", "-qam", "agent: committed change"]);
        fs::write(&cart, fs::read_to_string(&cart).unwrap().replace("line 25\n", "line twenty-five\n")).unwrap();
        fs::write(wt.join("notes.md"), "# notes\nkeep?\n").unwrap();
        (repo, wt, cart)
    }

    #[test]
    fn parse_a_diff_and_drop_and_restore_one_hunk() {
        let t = Tmp::new("hunks");
        let (_repo, wt, cart) = setup(&t.0);
        let text = git_out(&["diff", "--no-color", "main"], &wt).unwrap();
        let files = parse_diff(&text);
        assert_eq!(files.iter().map(|f| (f.path.as_str(), f.hunks.len())).collect::<Vec<_>>(), [("cart.js", 2)]);
        assert!(files[0].hunks[0].header.starts_with("@@ -1,6 +1,6 @@"));
        let second = patch_for(&files[0], &files[0].hunks[1..2]);
        assert!(second.starts_with("diff --git a/cart.js b/cart.js\n"));
        assert!(!second.contains("line three"), "only that hunk");

        drop_patch(&wt, &second).unwrap();
        let now = fs::read_to_string(&cart).unwrap();
        assert!(now.contains("\nline 25\n") && now.contains("\nline three\n"), "the other hunk stays");
        restore_patch(&wt, &second).unwrap();
        assert!(fs::read_to_string(&cart).unwrap().contains("\nline twenty-five\n"));
        let again = restore_patch(&wt, &second).unwrap_err();
        assert!(again.contains("patch failed") || again.contains("patch does not apply") || again.contains("already exists"), "{again}");

        let bin = "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n";
        let f = parse_diff(bin);
        assert_eq!((f[0].path.as_str(), f[0].binary, f[0].hunks.len()), ("x.png", true, 0));

        // the whole change: commits, uncommitted edits, and the new file
        let all = parse_diff(&diff_text(&wt, "main", None).unwrap());
        assert_eq!(all.iter().map(|f| (f.path.as_str(), f.hunks.len())).collect::<Vec<_>>(), [("cart.js", 2), ("notes.md", 1)]);
        assert_eq!(diff_stat(&wt, "main"), (2, 4, 2));
        let cut = diff_text(&wt, "main", Some(5)).unwrap();
        assert!(cut.lines().last().unwrap().ends_with("more lines"));
        assert!(parse_diff(&cut)[0].hunks.iter().all(|h| h.lines.iter().all(|l| !l.contains("more lines"))));
    }
}
