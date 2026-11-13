//! The Review area's commands on the App: `:diff`, `:review`, `:merge`, `:pr`,
//! `:dash` and `:cost` (openDiff, openReview, execMerge, execPr, openDashboard,
//! openUsage in src/app.ts). git runs off the UI thread where it can take a
//! while (diffs, pushes); merges run in place, as in TypeScript.

use super::diffview::{split_view, unified_view};
use super::float::{Alt, FLine, TextFloat};
use super::hooks::{Landing, before_landing};
use super::hunk_review::HunkReview;
use super::hunks::{diff_text, parse_diff};
use super::usage::{format_cost, format_tokens, format_usage, total_usage};
use super::{Win, plain_preview, screen, state_glyph, state_group, state_name, worktree_of};
use crate::app::{App, Msg};
use crate::session::{Item, State};
use crate::ui::text::{fit, pad};

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// The focused agent's slot and worktree, or the message saying why there's none ("… has no worktree to <what>").
fn focused_worktree(app: &mut App, what: &str) -> Option<(usize, super::land::Wt)> {
    let Some(s) = app.focused() else {
        app.say("no agent", "ErrorMsg");
        return None;
    };
    match worktree_of(s).filter(|w| w.path.is_some()) {
        Some(wt) => Some((app.focus, wt)),
        None => {
            let msg = format!("'{}' has no worktree to {what}", s.name);
            app.say(msg, "ErrorMsg");
            None
        }
    }
}

/// `:diff` (unified) / `:diff split`: what the focused agent changed since its worktree was made.
pub fn open_diff(app: &mut App, split: bool) {
    let Some((_, wt)) = focused_worktree(app, "diff") else { return };
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        let path = wt.path.clone().unwrap_or_default();
        let r = diff_text(&path, wt.base.as_deref().unwrap_or(""), Some(4000));
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| show_diff(app, &wt, r, split))));
    });
}

fn show_diff(app: &mut App, wt: &super::land::Wt, r: Result<String, String>, split: bool) {
    let text = match r {
        Ok(t) => t,
        Err(e) => return app.say(format!("git diff failed: {}", e.lines().next().unwrap_or("")), "ErrorMsg"),
    };
    if text.trim().is_empty() {
        return app.say(format!("no changes on {} yet", wt.branch), "Comment");
    }
    let width = screen().0.saturating_sub(4);
    let unified = unified_view(&text);
    let side = split_view(&text, width.saturating_sub(3) as usize);
    let n = unified.jumps.len();
    let base = wt.base.as_deref().unwrap_or("base");
    let title = |layout: &str| format!("{} vs {base} · {} · ]c [c jump · s {layout}", wt.branch, plural(n, "hunk"));
    let views = [(title("side by side"), unified.lines, unified.jumps), (title("unified"), side.lines, side.jumps)];
    let [a, b] = views;
    let (first, second) = if split { (b, a) } else { (a, b) };
    let f = TextFloat::new(first.0, first.1, width).with_jumps(first.2, Some(Alt { title: second.0, lines: second.1, jumps: second.2 }));
    super::open(app, f);
}

/// `:review` / `:hunks`: keep or drop the focused agent's changes hunk by hunk.
pub fn open_review(app: &mut App) {
    let Some((slot, wt)) = focused_worktree(app, "review") else { return };
    if app.sessions[slot].state == State::Running {
        let msg = format!("'{}' is still working; review it when it's done (or :pause it)", app.sessions[slot].name);
        return app.say(msg, "WarningMsg");
    }
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        let path = wt.path.clone().unwrap_or_default();
        let r = diff_text(&path, wt.base.as_deref().unwrap_or(""), None).map(|t| parse_diff(&t));
        let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| match r {
            Err(e) => app.say(format!("git diff failed: {}", e.lines().next().unwrap_or("")), "ErrorMsg"),
            Ok(files) if files.is_empty() => app.say(format!("no changes on {} yet", wt.branch), "Comment"),
            Ok(files) => {
                let title = format!("Review {} vs {}", wt.branch, wt.base.as_deref().unwrap_or("base"));
                app.seq.pending.clear();
                app.review.win = Some(Win::Hunks(HunkReview::new(title, files), wt));
            }
        })));
    });
}

/// The focused agent can land its work: (slot, worktree, repository), or the message saying why not.
fn landable(app: &mut App, what: &str) -> Option<(usize, super::land::Wt, std::path::PathBuf)> {
    let root = app.root.clone();
    let found = match (app.focused(), &root) {
        (Some(s), Some(_)) => worktree_of(s).filter(|w| w.path.is_some()),
        _ => None,
    };
    let Some(s) = app.focused() else {
        app.say("no agent", "ErrorMsg");
        return None;
    };
    let Some(wt) = found else {
        let msg = format!("'{}' has no worktree to {what}", s.name);
        app.say(msg, "ErrorMsg");
        return None;
    };
    if s.state == State::Running {
        let msg = format!("'{}' is still running; wait for it or :pause it first", s.name);
        app.say(msg, "ErrorMsg");
        return None;
    }
    Some((app.focus, wt, root.unwrap()))
}

/// `:merge [--no-squash]`: squash-merge (or merge) the agent's branch into its base, in your checkout.
pub fn merge(app: &mut App, arg: &str) {
    let Some((slot, wt, root)) = landable(app, "merge") else { return };
    let squash = !arg.split_whitespace().any(|w| w.starts_with("--no-squash") && w[11..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_'));
    before_landing(app, slot, Landing::Merge, move |app| {
        let r = super::land::merge_worktree(&root, &wt, squash);
        if r.ok {
            app.say(format!("{} · :kill! cleans up the worktree", r.message), "ModeMsg");
        } else {
            app.say(r.message, "ErrorMsg");
        }
        if slot < app.sessions.len() {
            app.refresh_stat(slot);
        }
    });
}

/// `:pr`: push the agent's branch and open a pull request.
pub fn pr(app: &mut App) {
    let Some((slot, wt, root)) = landable(app, "open a PR from") else { return };
    before_landing(app, slot, Landing::Pr, move |app| {
        app.say(format!("pushing {}…", wt.branch), "Comment");
        let tx = app.tx.clone();
        std::thread::spawn(move || {
            let r = super::land::open_pull_request(&root, &wt, "origin", true);
            let _ = tx.send(Msg::Run(Box::new(move |app: &mut App| app.say(r.message, if r.ok { "ModeMsg" } else { "ErrorMsg" }))));
        });
    });
}

/// `:dash`: every agent at a glance; Enter jumps to one.
pub fn open_dashboard(app: &mut App) {
    let open = app.open();
    if open.is_empty() {
        return app.say("no agents yet (:new <task> starts one)", "Comment");
    }
    let mut lines: Vec<FLine> = vec![];
    let mut rows = vec![];
    for (n, &i) in open.iter().enumerate() {
        let s = &app.sessions[i];
        let g = state_group(s.state);
        let last = s.items.iter().rev().find_map(|x| match x {
            Item::Text(t) | Item::User(t) => Some(t.as_str()),
            _ => None,
        });
        let wt = worktree_of(s);
        let place = match &wt {
            Some(w) => format!("⎇ {}", w.branch),
            None => s.model.clone().or_else(|| s.requested_model.clone()).unwrap_or_else(|| "default".into()),
        };
        rows.push(lines.len());
        let mut line: FLine = vec![
            (format!("{:>2} ", n + 1), "LineNr"),
            (format!("{} ", state_glyph(app, s.state)), g),
            (pad(&fit(&s.name, 26), 27), "Title"),
            (pad(state_name(s.state), 8), g),
            (format!(" {}", fit(&place, 34)), "Comment"),
        ];
        let (added, removed) = s.stat;
        if wt.is_some() && (added > 0 || removed > 0) {
            line.push((format!(" +{added}"), "Added"));
            line.push((format!(" −{removed}"), "Removed"));
        } else {
            line.push((String::new(), "Comment"));
        }
        line.push((if s.tokens > 0 { format!("  {}", super::usage::of(s)) } else { String::new() }, "Comment"));
        line.push((if s.queue.is_empty() { String::new() } else { format!("  ⧗{}", s.queue.len()) }, "Comment"));
        let unread = s.state == State::Waiting || (s.state == State::Error && i != app.focus);
        line.push((if unread { "  ◆ new".into() } else { String::new() }, if s.state == State::Error { "ErrorMsg" } else { "WarningMsg" }));
        lines.push(line);
        let preview = last.map(|t| fit(&plain_preview(t), 90)).unwrap_or_else(|| "(no messages yet)".into());
        lines.push(vec![("      ".into(), "NormalFloat"), (preview, "Comment")]);
    }
    let running = open.iter().filter(|&&i| app.sessions[i].state == State::Running).count();
    lines.push(vec![]);
    let (tokens, cost, _) = total_usage(open.iter().map(|&i| &app.sessions[i]));
    lines.push(vec![
        (format!("{} agents · {running} running · ", open.len()), "Comment"),
        (format!("{} in all", format_usage(tokens, cost)), "NormalFloat"),
        (" · j/k move · Enter open · :cost for more".into(), "Comment"),
    ]);
    let initial = open.iter().position(|&i| i == app.focus).map(|n| rows[n]);
    let width = 110.min(screen().0.saturating_sub(4));
    super::open(app, TextFloat::new("Dashboard", lines, width).select_rows(rows, open, initial));
}

/// `:cost` / `:usage`: what each agent has used (tokens, and money where the engine reports it) and the total.
pub fn open_usage(app: &mut App) {
    let open = app.open();
    if open.is_empty() {
        return app.say("no agents yet (:new <task> starts one)", "Comment");
    }
    let cell = |s: &str, w: usize| pad(&fit(s, w - 1), w);
    let tok = |n: u64| format_tokens(n).trim_end_matches(" tok").to_string();
    let mut lines: Vec<FLine> = vec![vec![(format!("{}{}{:>11}{:>10}", cell("agent", 30), cell("engine", 13), "tokens", "cost"), "Comment")]];
    let mut rows = vec![];
    for &i in &open {
        let s = &app.sessions[i];
        let cost = s.cost;
        rows.push(lines.len());
        lines.push(vec![
            (cell(&s.name, 30), "Title"),
            (cell(&crate::engines::engine_name(&s.engine), 13), "Comment"),
            (format!("{:>11}", tok(s.tokens)), "NormalFloat"),
            (format!("{:>10}", cost.map(format_cost).unwrap_or_else(|| "—".into())), if cost.is_none() { "Comment" } else { "String" }),
        ]);
    }
    let (tokens, cost, unpriced) = total_usage(open.iter().map(|&i| &app.sessions[i]));
    lines.push(vec![("─".repeat(64), "FloatBorder")]);
    lines.push(vec![
        (cell("all agents", 43), "Title"),
        (format!("{:>11}", tok(tokens)), "NormalFloat"),
        (format!("{:>10}", cost.map(format_cost).unwrap_or_else(|| "—".into())), "String"),
    ]);
    lines.push(vec![]);
    lines.push(vec![("Costs are as each engine reports them. Claude Code prices its".into(), "Comment")]);
    lines.push(vec![("tokens at API rates, even on a subscription.".into(), "Comment")]);
    if unpriced > 0 {
        lines.push(vec![("Codex reports no price (—); its tokens are counted.".into(), "Comment")]);
    }
    let initial = open.iter().position(|&i| i == app.focus).map(|n| rows[n]);
    let width = 72.min(screen().0.saturating_sub(4));
    super::open(app, TextFloat::new("Usage", lines, width).select_rows(rows, open, initial));
}

#[cfg(test)]
mod tests {
    use super::super::Win;
    use super::super::tests::{app, ex, press, settle};
    use crate::review::hunks::tests::setup;
    use crate::review::land::tests::{Tmp, sh};
    use crate::session::{Session, State};
    use std::fs;

    fn text(a: &mut crate::app::App, w: usize) -> String {
        match a.review.win.as_mut() {
            Some(Win::Text(f)) => f.render_plain(w).join("\n"),
            Some(Win::Hunks(h, _)) => h.render_plain(w).join("\n"),
            None => String::new(),
        }
    }

    fn squeeze(s: &str) -> String {
        s.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn dash_and_cost_show_what_each_agent_used_and_the_total() {
        let (mut a, _rx) = app();
        let mut s = Session::new(0, "fix the race", "claude", "/x".into());
        (s.tokens, s.cost, s.model) = (74_810, Some(0.503154), Some("claude-fable-5".into()));
        a.sessions.push(s);
        let mut s = Session::new(1, "add retries", "codex", "/x".into());
        s.tokens = 21_300;
        a.sessions.push(s);
        let s = Session::new(2, "rename the flag", "opencode", "/x".into());
        a.sessions.push(s);
        a.focus = 0;

        ex(&mut a, "dash");
        let screen = text(&mut a, 110);
        assert!(screen.lines().any(|l| l.contains("fix the race") && l.contains("74.8k tok · $0.50")), "{screen}");
        assert!(screen.lines().any(|l| l.contains("add retries") && l.contains("21.3k tok") && !l.contains("21.3k tok ·")));
        assert!(screen.contains("3 agents · 0 running · 96.1k tok · $0.50 in all"), "{screen}");
        press(&mut a, "q");

        ex(&mut a, "cost");
        let screen = text(&mut a, 72);
        assert!(screen.contains("Usage"));
        let flat = squeeze(&screen);
        assert!(flat.contains("agent engine tokens cost"), "{screen}");
        assert!(flat.contains("fix the race Claude Code 74.8k $0.50"), "{screen}");
        assert!(flat.contains("add retries Codex 21.3k —"));
        assert!(flat.contains("rename the flag OpenCode 0 —"));
        assert!(flat.contains("all agents 96.1k $0.50"));
        assert!(screen.contains("Codex reports no price (—); its tokens are counted."));
        // Enter jumps to the agent, like :dash
        press(&mut a, "j\r");
        assert_eq!(a.focus, 1);
        assert!(a.review.win.is_none());
    }

    #[test]
    fn review_drops_a_hunk_and_a_new_file_and_undoes() {
        let t = Tmp::new("review");
        let (repo, wt, cart) = setup(&t.0);
        let (mut a, rx) = app();
        a.root = Some(repo.clone());
        let mut s = Session::new(0, "fix cart", "claude", wt.clone());
        (s.branch, s.base) = (Some("fix/cart".into()), "main".into());
        a.sessions.push(s);
        a.focus = 0;
        press(&mut a, " r"); // <leader>r
        settle(&mut a, &rx, |a| a.review.win.is_some());
        let screen = text(&mut a, 110);
        assert!(screen.contains("Review fix/cart vs main · 3 hunks left"), "{screen}");
        assert!(screen.contains("cart.js  2 hunks"));
        assert!(screen.contains("notes.md  1 hunk"));
        assert!(screen.contains("▌ @@ -1,6 +1,6 @@"), "the first hunk is selected");
        assert!(screen.contains("+line three"));

        press(&mut a, "jx"); // the uncommitted change
        settle(&mut a, &rx, |a| matches!(&a.review.win, Some(Win::Hunks(h, _)) if !h.busy));
        let screen = text(&mut a, 110);
        assert!(screen.contains("2 hunks left") && screen.contains("1 dropped"), "{screen}");
        assert!(screen.contains("dropped hunk 2 of cart.js · u undoes"));
        assert!(fs::read_to_string(&cart).unwrap().contains("\nline 25\n"));

        press(&mut a, "JX"); // to notes.md
        settle(&mut a, &rx, |a| matches!(&a.review.win, Some(Win::Hunks(h, _)) if h.message.contains("dropped notes.md")));
        assert!(!wt.join("notes.md").exists());
        press(&mut a, "u");
        settle(&mut a, &rx, |a| matches!(&a.review.win, Some(Win::Hunks(h, _)) if h.message.contains("restored notes.md")));
        assert!(wt.join("notes.md").exists());

        // what :merge takes: what's left in the worktree
        crate::review::land::commit_pending(&crate::review::land::Wt { branch: "fix/cart".into(), path: Some(wt.clone()), base: Some("main".into()) }).unwrap();
        let merged = sh(&repo, &["diff", "main", "fix/cart"]);
        assert!(merged.contains("+line three") && merged.contains("notes.md"));
        assert!(!merged.contains("twenty-five"), "the dropped hunk isn't in the branch");

        press(&mut a, "q");
        assert!(a.review.win.is_none());
        a.sessions[0].state = State::Running;
        ex(&mut a, "review");
        assert!(a.message.0.contains("still working; review it when it's done"));
    }

    #[test]
    fn diff_opens_unified_or_split() {
        let t = Tmp::new("diff");
        let (repo, wt, _) = setup(&t.0);
        let (mut a, rx) = app();
        a.root = Some(repo);
        let mut s = Session::new(0, "fix cart", "claude", wt);
        (s.branch, s.base) = (Some("fix/cart".into()), "main".into());
        a.sessions.push(s);
        press(&mut a, " d"); // <leader>d
        settle(&mut a, &rx, |a| a.review.win.is_some());
        let screen = text(&mut a, 100);
        assert!(screen.contains("fix/cart vs main · 3 hunks · ]c [c jump · s side by side"), "{screen}");
        assert!(screen.contains("+line three"));
        press(&mut a, "s");
        let screen = text(&mut a, 100);
        assert!(screen.contains("s unified") && screen.contains("cart.js"), "{screen}");
        press(&mut a, "q");
        ex(&mut a, "diff split");
        settle(&mut a, &rx, |a| a.review.win.is_some());
        assert!(text(&mut a, 100).contains("s unified"));
    }

    #[test]
    fn merge_and_pr_say_why_they_cant() {
        let (mut a, _rx) = app();
        ex(&mut a, "merge");
        assert_eq!(a.message.0, "no agent");
        a.sessions.push(Session::new(0, "here", "claude", "/x".into()));
        ex(&mut a, "merge");
        assert_eq!(a.message.0, "'here' has no worktree to merge");
        ex(&mut a, "pr");
        assert_eq!(a.message.0, "'here' has no worktree to open a PR from");
        ex(&mut a, "diff");
        assert_eq!(a.message.0, "'here' has no worktree to diff");
        ex(&mut a, "dash");
        assert!(a.review.win.is_some());
    }
}
