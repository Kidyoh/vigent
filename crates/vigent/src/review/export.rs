//! `:w`: write the focused agent's transcript as Markdown (src/export.ts, execWrite in src/app.ts).

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::app::App;
use crate::session::{Item, Session};

/// "2026-11-13 09:05" (UTC, as `toISOString` gives it) for seconds since the epoch.
pub fn iso_minute(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil from days (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, rem % 3600 / 60)
}

pub fn transcript_markdown(s: &Session, now_secs: u64) -> String {
    let mut out: Vec<String> = vec![format!("# {}", s.name), String::new()];
    let model = s.model.clone().or_else(|| s.requested_model.clone()).unwrap_or_else(|| "default".into());
    let mut meta = vec![format!("model: {model}")];
    if let Some(b) = &s.branch {
        meta.push(format!("branch: `{b}`"));
        if s.made.is_some() {
            meta.push(format!("changes: +{} −{}", s.stat.0, s.stat.1));
        }
    }
    meta.push(format!("exported: {}", iso_minute(now_secs)));
    out.push(meta.join(" · "));
    out.push(String::new());
    for item in &s.items {
        match item {
            Item::User(t) => out.extend(["## You".into(), String::new(), t.clone(), String::new()]),
            Item::Text(t) => out.extend(["## Agent".into(), String::new(), t.clone(), String::new()]),
            Item::Tool { name, summary, .. } => out.extend([
                format!("<details><summary><code>{name}</code> {summary}</summary>"),
                String::new(),
                "```".into(),
                String::new(),
                "```".into(),
                String::new(),
                "</details>".into(),
                String::new(),
            ]),
            Item::Info(t) | Item::Error(t) => out.extend([format!("> {t}"), String::new()]),
        }
    }
    format!("{}\n", out.join("\n").trim_end())
}

/// "fix-the-cart" from an agent's name ("transcript" when nothing's left).
pub fn slugify_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() { "transcript".into() } else { out.to_string() }
}

/// `path.resolve(cwd, p)`, without touching the disk.
fn resolve(cwd: &Path, p: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for c in cwd.join(p).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// A path as the message line shows it: relative to `cwd`, unless that climbs more than one folder.
pub fn short_path(cwd: &Path, p: &Path) -> String {
    let (a, b): (Vec<_>, Vec<_>) = (cwd.components().collect(), p.components().collect());
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let ups = a.len() - common;
    if ups >= 2 || common == 0 {
        return p.display().to_string();
    }
    let mut rel = PathBuf::new();
    for _ in 0..ups {
        rel.push("..");
    }
    for c in &b[common..] {
        rel.push(c);
    }
    let rel = rel.display().to_string();
    if rel.is_empty() { p.display().to_string() } else { rel }
}

/// `:w [file]` / `:w! [file]`
pub fn write(app: &mut App, arg: &str, force: bool) {
    let Some(s) = app.focused() else { return app.say("E32: No agent to write", "ErrorMsg") };
    let cwd = std::env::current_dir().unwrap_or_else(|_| app.cwd.clone());
    let name = if arg.is_empty() { format!("{}.md", slugify_name(&s.name)) } else { arg.to_string() };
    let file = resolve(&cwd, &name);
    let short = short_path(&cwd, &file);
    if file.exists() && !force {
        return app.say(format!("E13: File exists (add ! to override): {short}"), "ErrorMsg");
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let md = transcript_markdown(s, now);
    if let Err(e) = std::fs::write(&file, &md) {
        return app.say(format!("E212: Can't open file for writing: {e}"), "ErrorMsg");
    }
    let lines = md.matches('\n').count();
    app.say(format!("\"{short}\" {lines}L, {}B written", md.len()), "Normal");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transcript_as_markdown() {
        let mut s = Session::new(0, "fix the cart", "claude", "/x".into());
        s.model = Some("claude-fable-5".into());
        s.branch = Some("fix/cart".into());
        s.items = vec![
            Item::User("fix it".into()),
            Item::Tool { id: "1".into(), name: "Edit".into(), summary: "cart.js".into() },
            Item::Text("Done.".into()),
            Item::Info("worktree ready (4.2s)".into()),
        ];
        let md = transcript_markdown(&s, 1_794_560_700);
        assert_eq!(
            md,
            "# fix the cart\n\nmodel: claude-fable-5 · branch: `fix/cart` · exported: 2026-11-13 09:05\n\n## You\n\nfix it\n\n<details><summary><code>Edit</code> cart.js</summary>\n\n```\n\n```\n\n</details>\n\n## Agent\n\nDone.\n\n> worktree ready (4.2s)\n"
        );
    }

    #[test]
    fn names_dates_and_paths() {
        assert_eq!(slugify_name("Fix the cart, now!"), "fix-the-cart-now");
        assert_eq!(slugify_name("!!!"), "transcript");
        assert_eq!(iso_minute(0), "1970-01-01 00:00");
        assert_eq!(iso_minute(951_782_400), "2000-02-29 00:00");
        let cwd = Path::new("/home/me/shop");
        assert_eq!(short_path(cwd, Path::new("/home/me/shop/fix.md")), "fix.md");
        assert_eq!(short_path(cwd, Path::new("/home/me/x.md")), "../x.md");
        assert_eq!(short_path(cwd, Path::new("/tmp/x.md")), "/tmp/x.md");
        assert_eq!(resolve(cwd, "../a/./b.md"), PathBuf::from("/home/me/a/b.md"));
    }
}
