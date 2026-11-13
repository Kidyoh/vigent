//! The transcript as pane lines (src/app.ts buildPaneLines / renderItem):
//! each line's styled pieces and its plain text (for search and yank), the
//! item it renders, whether a message starts there (for { and }) and the code
//! block it belongs to (for ib and yib). And each window drawn from them
//! (renderWindow): its winbar, the VISUAL selection and the search matches.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ratatui::style::Style;

use super::icons::{Icons, icons, tool_glyph};
use super::markdown;
use super::text::{Seg, exact, segs_plain, segs_width, wrap_segs};
use crate::app::{App, Mode};
use crate::printable::printable;
use crate::search::occurrences;
use crate::session::{Item, State};
use crate::windows::Rect;

#[derive(Clone, Debug, Default)]
pub struct PaneLine {
    pub segs: Vec<Seg>,
    pub plain: String,
    /// the transcript item this line renders
    pub item: Option<usize>,
    /// a message's first line
    pub start: bool,
    /// fenced code in a reply, or unfolded tool output
    pub block: Option<usize>,
    /// a code block's language label (selected with the block, never copied)
    pub label: bool,
}

impl PaneLine {
    fn new(segs: Vec<Seg>) -> PaneLine {
        let plain = segs_plain(&segs);
        PaneLine { segs, plain, ..Default::default() }
    }
}

/// An empty row between the transcript's last line and the statusline.
pub const BOTTOM_PAD: i32 = 1;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

pub fn sidebar_width(app: &App, cols: u16) -> u16 {
    let w = app.config.ui.sidebar_width;
    if app.config.ui.sidebar && cols >= w + 40 { w } else { 0 }
}

/// Where the windows go: everything but the sidebar, the statusline and the command line.
pub fn pane_area(app: &App) -> Rect {
    let cols = app.windows.cols;
    let sb = sidebar_width(app, cols) as i32;
    Rect { x: 0, y: 0, w: cols as i32 - sb - i32::from(sb > 0), h: app.windows.rows as i32 - 2 }
}

/// The current window's place.
pub fn window_rect(app: &App) -> Rect {
    let area = pane_area(app);
    app.windows.layout.rect_of(app.windows.layout.cur, area).unwrap_or(area)
}

pub fn content_height(r: Rect) -> usize {
    (r.h - 1 - BOTTOM_PAD).max(1) as usize
}

pub fn pane_width(r: Rect) -> usize {
    (r.w - 2).max(20) as usize
}

/// The current window's transcript lines.
pub fn current(app: &App) -> Rc<Vec<PaneLine>> {
    let r = window_rect(app);
    build(app, app.focused().map(|s| s.slot), pane_width(r))
}

/// The lines on screen: from `start` to `end` (exclusive).
pub fn view_range(total: usize, h: usize, scroll: usize) -> (usize, usize) {
    let start = total.saturating_sub(h + scroll);
    (start, total.min(start + h))
}

// ---------------------------------------------------------------------------
// building
// ---------------------------------------------------------------------------

thread_local! {
    static CACHE: RefCell<HashMap<(Option<usize>, usize), (String, Rc<Vec<PaneLine>>)>> = RefCell::new(HashMap::new());
}

/// What a session's lines depend on, cheaply.
fn cache_key(app: &App, slot: Option<usize>, w: usize) -> String {
    let Some(s) = slot.and_then(|i| app.sessions.get(i)) else { return format!("empty:{w}") };
    let text: usize = s
        .items
        .iter()
        .map(|it| match it {
            Item::User(t) | Item::Text(t) | Item::Info(t) | Item::Error(t) => t.len(),
            Item::Tool { name, summary, .. } => name.len() + summary.len() + 1,
        })
        .sum();
    let folds: Vec<usize> = app.windows.open_folds.iter().filter(|(sl, _)| Some(*sl) == slot).map(|(_, i)| *i).collect();
    let outputs: usize = s.tool_output.values().map(|o| o.len()).sum();
    format!(
        "{}:{}:{}:{:?}:{}:{}:{}:{:?}:{:?}:{}:{}",
        s.items.len(),
        text,
        w,
        folds,
        app.theme.name,
        app.config.ui.icons,
        s.thinking,
        s.state,
        app.config.style.messages,
        outputs,
        s.engine
    )
}

/// A session's transcript as pane lines, `w` columns wide.
pub fn build(app: &App, slot: Option<usize>, w: usize) -> Rc<Vec<PaneLine>> {
    let key = cache_key(app, slot, w);
    if let Some(hit) = CACHE.with(|c| c.borrow().get(&(slot, w)).filter(|(k, _)| *k == key).map(|(_, v)| v.clone())) {
        return hit;
    }
    let lines = Rc::new(build_lines(app, slot, w));
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= 32 {
            c.clear();
        }
        c.insert((slot, w), (key, lines.clone()));
    });
    lines
}

fn build_lines(app: &App, slot: Option<usize>, pane_w: usize) -> Vec<PaneLine> {
    let mut lines: Vec<PaneLine> = vec![];
    let Some(s) = slot.and_then(|i| app.sessions.get(i)) else { return lines };
    let t = &app.theme;
    let ic = icons(app);
    let messages = app.config.style.messages.clone().unwrap_or_else(|| "plain".into());
    let who = crate::engines::engine_name(&s.engine).to_string();
    let user_label = app.config.style.user_label.clone().unwrap_or_else(|| "You".into());
    let mut block = 0usize;
    let blank = || PaneLine::default();
    let last_text = s.items.iter().rposition(|i| matches!(i, Item::Text(_)));
    for (n, item) in s.items.iter().enumerate() {
        match item {
            Item::User(text) => {
                lines.push(blank());
                let text = printable(text);
                let paint = |l: &str| mention_segs(l, t);
                if messages == "labeled" {
                    let bar = if app.config.ui.icons == "ascii" { "| " } else { "▎ " };
                    let head = format!("{bar}{}{user_label}", ic.user.as_ref().map(|u| format!("{u} ")).unwrap_or_default());
                    let mut l = PaneLine::new(vec![Seg::new(head, t.hl("VigentUser"))]);
                    (l.item, l.start) = (Some(n), true);
                    lines.push(l);
                    for row in wrap_text(&text, pane_w.saturating_sub(2)) {
                        let mut segs = vec![Seg::new("  ", t.fg("Normal"))];
                        segs.extend(paint(&row));
                        let mut l = PaneLine::new(segs);
                        l.item = Some(n);
                        lines.push(l);
                    }
                    continue;
                }
                for (i, row) in wrap_text(&text, pane_w.saturating_sub(2)).into_iter().enumerate() {
                    let lead = if i == 0 { ic.prompt.clone() } else { " ".repeat(super::text::width(&ic.prompt)) };
                    let mut segs = vec![Seg::new(lead, t.hl("VigentUser"))];
                    segs.extend(paint(&row));
                    let mut l = PaneLine::new(segs);
                    (l.item, l.start) = (Some(n), i == 0);
                    lines.push(l);
                }
            }
            Item::Text(text) => {
                lines.push(blank());
                let streaming = s.state == State::Running && Some(n) == last_text && n + 1 == s.items.len();
                let text = format!("{}{}", printable(text), if streaming { format!(" {}", ic.cursor) } else { String::new() });
                let indent = if messages == "labeled" { "  " } else { "" };
                if messages == "labeled" {
                    let bar = if app.config.ui.icons == "ascii" { "| " } else { "▎ " };
                    let head = format!("{bar}{}{who}", ic.agent.as_ref().map(|u| format!("{u} ")).unwrap_or_default());
                    let mut l = PaneLine::new(vec![Seg::new(head, t.hl("Title"))]);
                    (l.item, l.start) = (Some(n), true);
                    lines.push(l);
                } else if messages == "bubbles" {
                    let mark = ic.agent.clone().unwrap_or_else(|| ic.open_agent.clone());
                    let mut l = PaneLine::new(vec![Seg::new(format!("{mark} "), t.hl("Special")), Seg::new(who.clone(), t.hl("Title"))]);
                    (l.item, l.start) = (Some(n), true);
                    lines.push(l);
                }
                let (md, blocks) = markdown::render(&text, pane_w - indent.len(), t, &ic.bullet, block, app.config.ui.icons == "ascii");
                for (i, ml) in md.into_iter().enumerate() {
                    let mut segs = vec![];
                    if !indent.is_empty() {
                        segs.push(Seg::new(indent, t.fg("Normal")));
                    }
                    segs.extend(ml.segs);
                    let mut l = PaneLine::new(segs);
                    l.item = Some(n);
                    l.start = messages == "plain" && i == 0;
                    l.block = ml.block;
                    l.label = ml.label;
                    lines.push(l);
                }
                block += blocks;
            }
            Item::Tool { id, name, summary } => {
                let one = |x: &str| printable(x).split_whitespace().collect::<Vec<_>>().join(" ");
                let (name1, summary1) = (one(name), one(summary));
                let open = app.windows.open_folds.contains(&(s.slot, n));
                let fold = if open { &ic.open } else { &ic.folded };
                let ind = if messages == "labeled" { " " } else { "" };
                let mut l = PaneLine::new(vec![
                    Seg::new(format!("{ind} {fold} "), t.hl("NonText")),
                    Seg::new(tool_glyph(app, name), t.hl("Special")),
                    Seg::new(name1, t.hl("VigentTool")),
                    Seg::new(format!(" {summary1}"), t.hl("Comment")),
                ]);
                l.item = Some(n);
                lines.push(l);
                let output = s.tool_output.get(id).map(|o| printable(o)).unwrap_or_default();
                if open && !output.is_empty() {
                    let b = block;
                    block += 1;
                    let out_lines: Vec<&str> = output.split('\n').collect();
                    for ol in out_lines.iter().take(12) {
                        for row in wrap_text(ol, pane_w.saturating_sub(4)) {
                            let mut l = PaneLine::new(vec![Seg::new("    ", t.fg("Normal")), Seg::new(row, t.hl("VigentToolOutput"))]);
                            (l.item, l.block) = (Some(n), Some(b));
                            lines.push(l);
                        }
                    }
                    if out_lines.len() > 12 {
                        let mut l = PaneLine::new(vec![Seg::new("    ", t.fg("Normal")), Seg::new(format!("… {} more lines", out_lines.len() - 12), t.hl("NonText"))]);
                        l.item = Some(n);
                        lines.push(l);
                    }
                }
            }
            Item::Info(text) | Item::Error(text) => {
                lines.push(blank());
                let group = if matches!(item, Item::Error(_)) { "ErrorMsg" } else { "Comment" };
                for (i, row) in wrap_text(&printable(text), pane_w).into_iter().enumerate() {
                    let mut l = PaneLine::new(vec![Seg::new(row, t.hl(group))]);
                    (l.item, l.start) = (Some(n), i == 0);
                    lines.push(l);
                }
            }
        }
    }
    if s.thinking {
        lines.push(blank());
        lines.push(PaneLine::new(vec![Seg::new("thinking…", t.hl("Comment"))]));
    }
    lines
}

/// Plain text wrapped to `w` columns, line by line.
fn wrap_text(text: &str, w: usize) -> Vec<String> {
    text.split('\n').flat_map(|l| wrap_segs(&[Seg::new(l, Style::default())], w).into_iter().map(|row| segs_plain(&row))).collect()
}

/// A prompt's text: `@path` mentions in VigentMention, the rest in Keyword.
fn mention_segs(line: &str, t: &crate::theme::Theme) -> Vec<Seg> {
    let mut out = vec![];
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut cur = String::new();
    let path_char = |c: char| c.is_alphanumeric() || "_./@+-".contains(c);
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || chars[i - 1].is_whitespace()) {
            let mut e = i + 1;
            while e < chars.len() && path_char(chars[e]) {
                e += 1;
            }
            // not ending in . or @
            while e > i + 1 && matches!(chars[e - 1], '.' | '@') {
                e -= 1;
            }
            if e > i + 1 {
                if !cur.is_empty() {
                    out.push(Seg::new(std::mem::take(&mut cur), t.hl("Keyword")));
                }
                out.push(Seg::new(chars[i..e].iter().collect::<String>(), t.hl("VigentMention")));
                i = e;
                continue;
            }
        }
        cur.push(chars[i]);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(Seg::new(cur, t.hl("Keyword")));
    }
    out
}

// ---------------------------------------------------------------------------
// drawing one window
// ---------------------------------------------------------------------------

/// Paint the search term's matches in a line's pieces: Search, and the current one in `cur`.
fn paint_matches(segs: &[Seg], plain: &str, term: &str, on: Style, current: i64, cur: Style) -> Vec<Seg> {
    let starts = occurrences(term, plain);
    if starts.is_empty() {
        return segs.to_vec();
    }
    let len = term.chars().count();
    let mut out = vec![];
    let mut p = 0usize;
    for s in segs {
        let mut piece = String::new();
        let mut piece_style: Option<Style> = None;
        for c in s.text.chars() {
            let k = starts.iter().position(|&st| p >= st && p < st + len);
            let style = match k {
                Some(k) if k as i64 == current => cur,
                Some(_) => on,
                None => s.style,
            };
            if piece_style.is_some_and(|ps| ps != style) {
                out.push(Seg { text: std::mem::take(&mut piece), style: piece_style.unwrap(), link: s.link.clone() });
            }
            piece_style = Some(style);
            piece.push(c);
            p += 1;
        }
        if let Some(ps) = piece_style {
            out.push(Seg { text: piece, style: ps, link: s.link.clone() });
        }
    }
    out
}

/// One window: its winbar, then its transcript (or the start screen), each row exactly `r.w` wide.
pub fn draw_window(app: &App, win_session: Option<usize>, scroll: usize, r: Rect, current: bool) -> Vec<Vec<Seg>> {
    let t = &app.theme;
    let pane_h = content_height(r);
    let pane_w = pane_width(r);
    let normal = t.normal();
    let intro = app.open().is_empty();
    let single = app.windows.layout.count() == 1;
    let mut out: Vec<Vec<Seg>> = vec![];
    out.push(exact(super::winbar::segs(app, win_session, pane_w + 2, current || single), r.w as usize, normal));
    let (view, start): (Vec<PaneLine>, usize) = if intro {
        (super::dashboard::lines(app, pane_w, pane_h).into_iter().take(pane_h).collect(), 0)
    } else {
        let lines = build(app, win_session, pane_w);
        let (start, end) = view_range(lines.len(), pane_h, scroll);
        (lines[start..end].to_vec(), start)
    };
    let w = &app.windows;
    let (sel_a, sel_b) = (w.visual.0.min(w.visual.1), w.visual.0.max(w.visual.1));
    let term = if intro || !current {
        String::new()
    } else if app.mode == Mode::Search {
        app.cmd.clone()
    } else {
        w.search_query.clone()
    };
    let visual_bg = t.hl("Visual").bg;
    for row in 1..r.h as usize {
        let vi = row as isize - 1 - (pane_h as isize - view.len() as isize);
        let line = if vi >= 0 { view.get(vi as usize) } else { None };
        let idx = start as isize + vi;
        let mut fill = normal;
        let mut segs: Vec<Seg> = line.map(|l| l.segs.clone()).unwrap_or_default();
        if let Some(l) = line {
            if current && app.mode == Mode::Visual && idx >= sel_a as isize && idx <= sel_b as isize {
                if let Some(bg) = visual_bg {
                    fill = normal.bg(bg);
                    for s in &mut segs {
                        if s.style.bg.is_none() || s.style.bg == normal.bg {
                            s.style = s.style.bg(bg);
                        }
                    }
                }
            } else if !term.is_empty() {
                let hit = w.cur_hit.filter(|h| h.line as isize == idx).map(|h| h.n).unwrap_or(-1);
                let cur = t.hl(if app.mode == Mode::Search { "IncSearch" } else { "CurSearch" });
                segs = paint_matches(&segs, &l.plain, &term, t.hl("Search"), hit, cur);
            }
        }
        let mut full = vec![Seg::new(" ", fill)];
        full.extend(segs);
        out.push(exact(full, r.w as usize, fill));
    }
    out.truncate(r.h.max(0) as usize);
    out
}

/// Every window's rows, side by side or stacked (or only the current one when they don't fit).
pub fn draw_panes(app: &App, area: Rect, sep: &Seg) -> Vec<Vec<Seg>> {
    let layout = &app.windows.layout;
    let cur = layout.cur;
    let session_of = |id: usize| if id == cur { app.focused().map(|s| s.slot) } else { layout.win(id).session.filter(|&i| app.sessions.get(i).is_some_and(|s| !s.closed)) };
    let scroll_of = |id: usize| if id == cur { app.scroll } else { layout.win(id).scroll };
    if layout.count() == 1 || !layout.fits(area) {
        return draw_window(app, session_of(cur), scroll_of(cur), area, true);
    }
    fn node(app: &App, n: &crate::windows::Node, r: Rect, sep: &Seg, f: &dyn Fn(usize) -> (Option<usize>, usize)) -> Vec<Vec<Seg>> {
        match n {
            crate::windows::Node::Win(id) => {
                let (s, sc) = f(*id);
                draw_window(app, s, sc, r, *id == app.windows.layout.cur)
            }
            crate::windows::Node::Split { dir, ratio, a, b } => {
                // the same arithmetic as Layout::rects
                let (ra, rb) = split_rects(*dir, *ratio, a, b, r);
                let la = node(app, a, ra, sep, f);
                let lb = node(app, b, rb, sep, f);
                if *dir == crate::windows::Dir::Column {
                    la.into_iter().chain(lb).collect()
                } else {
                    la.into_iter()
                        .zip(lb)
                        .map(|(mut x, y)| {
                            x.push(sep.clone());
                            x.extend(y);
                            x
                        })
                        .collect()
                }
            }
        }
    }
    let f = |id: usize| (session_of(id), scroll_of(id));
    node(app, &layout.root, area, sep, &f)
}

fn split_rects(dir: crate::windows::Dir, ratio: f64, a: &crate::windows::Node, b: &crate::windows::Node, r: Rect) -> (Rect, Rect) {
    // reuse Layout's own placement for exactly the same numbers
    let tmp = crate::windows::Layout::with_root(crate::windows::Node::Split { dir, ratio, a: Box::new(a.clone()), b: Box::new(b.clone()) });
    let rects = tmp.rects(r);
    let get = |side: bool| rects.iter().find(|(p, _)| p.len() == 1 && p[0] == side).map(|(_, x)| *x).unwrap_or(r);
    (get(false), get(true))
}

/// Width of a row of pieces (for tests).
pub fn row_width(row: &[Seg]) -> usize {
    segs_width(row)
}

pub fn icon_set(app: &App) -> Icons {
    icons(app)
}
