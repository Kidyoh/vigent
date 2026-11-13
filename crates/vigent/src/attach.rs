//! `@path` in a prompt attaches a file from the agent's folder (src/attach.ts):
//! the files to pick from, and which names can follow `@`.

use std::path::Path;
use std::process::Command;

/// The files an agent can be pointed at: tracked and new ones, without what .gitignore hides.
pub fn list_files(cwd: &Path) -> Vec<String> {
    let git = |args: &[&str]| -> Option<Vec<String>> {
        let out = Command::new("git").args(args).current_dir(cwd).output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
    };
    let Some(listed) = git(&["ls-files", "--cached", "--others", "--exclude-standard", "-z"]) else { return walk(cwd) };
    let deleted: std::collections::HashSet<String> = git(&["ls-files", "--deleted", "-z"]).unwrap_or_default().into_iter().collect();
    let mut seen = std::collections::HashSet::new();
    let files: Vec<String> = listed.into_iter().filter(|f| !deleted.contains(f) && seen.insert(f.clone())).collect();
    sort_by_depth_then_name(files)
}

/// Not a git repository: a shallow walk, skipping the usual heavy folders.
fn walk(cwd: &Path) -> Vec<String> {
    const SKIP: &[&str] = &["node_modules", ".git", "dist", "build", "target", ".next", ".venv", "venv"];
    fn visit(root: &Path, dir: &str, depth: usize, out: &mut Vec<String>) {
        if out.len() >= 5000 || depth > 6 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let rel = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP.contains(&name.as_str()) && !name.starts_with('.') {
                    visit(root, &rel, depth + 1, out);
                }
            } else if ft.is_file() {
                out.push(rel);
            }
        }
    }
    let mut out = vec![];
    visit(cwd, "", 0, &mut out);
    sort_by_depth_then_name(out)
}

/// Shallow paths first, then by name.
fn sort_by_depth_then_name(mut files: Vec<String>) -> Vec<String> {
    files.sort_by(|a, b| a.matches('/').count().cmp(&b.matches('/').count()).then_with(|| collate(a, b)));
    files
}

/// Close to Intl.Collator's order: case-insensitive first, then lowercase before uppercase.
fn collate(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

fn path_char(c: char) -> bool {
    c.is_alphanumeric() || "_./@+-".contains(c)
}

/// Whether `@file` reads back as this file (names with spaces can't).
pub fn mentionable(file: &str) -> bool {
    let Some(last) = file.chars().last() else { return false };
    file.chars().all(path_char) && last != '.' && last != '@'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_can_follow_an_at() {
        assert!(mentionable("src/cart.js"));
        assert!(!mentionable("my file.txt"));
        assert!(!mentionable("a."));
        assert_eq!(sort_by_depth_then_name(vec!["src/b.js".into(), "README.md".into(), "a.js".into()]), vec!["a.js", "README.md", "src/b.js"]);
        let dir = std::env::temp_dir().join(format!("vigent-attach-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/cart.js"), "x").unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/x.js"), "x").unwrap();
        assert_eq!(walk(&dir), vec!["src/cart.js"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
