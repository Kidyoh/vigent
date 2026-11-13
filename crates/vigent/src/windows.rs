//! Windows area: splits (src/windows.ts), the sessions sidebar's focus,
//! search, VISUAL, folds, marks and jumps, the line editor (src/line-edit.ts),
//! completion, which-key, pickers and y/n questions. Its state lives here, on
//! App::windows; what keys do is actions/windows.rs, the commands
//! commands/windows.rs, the drawing ui/.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use crate::app::{App, Mode};
use crate::line_edit::{HistoryWalk, LineBuffer, LineEditor};
use crate::search::Hit;
use crate::ui::picker::Picker;

// ---------------------------------------------------------------------------
// The layout: a binary tree of side-by-side and stacked splits (src/windows.ts)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// "Row" is side by side (:vsplit), "Column" is stacked (:split).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Row,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Up,
    Down,
}

/// A window: the agent it shows (its slot in App::sessions) and how far up it's scrolled.
#[derive(Clone, Debug, PartialEq)]
pub struct Win {
    pub id: usize,
    pub session: Option<usize>,
    pub scroll: usize,
}

#[derive(Clone, Debug)]
pub enum Node {
    Win(usize),
    Split { dir: Dir, ratio: f64, a: Box<Node>, b: Box<Node> },
}

/// A window needs its winbar, a transcript line and the row under it, and room to wrap text.
pub const MIN_WIDTH: i32 = 24;
pub const MIN_HEIGHT: i32 = 4;

/// A node's place in the tree: false for `a`, true for `b`, from the root.
pub type Path = Vec<bool>;

fn min_width(n: &Node) -> i32 {
    match n {
        Node::Win(_) => MIN_WIDTH,
        Node::Split { dir: Dir::Row, a, b, .. } => min_width(a) + min_width(b) + 1,
        Node::Split { a, b, .. } => min_width(a).max(min_width(b)),
    }
}

fn min_height(n: &Node) -> i32 {
    match n {
        Node::Win(_) => MIN_HEIGHT,
        Node::Split { dir: Dir::Column, a, b, .. } => min_height(a) + min_height(b),
        Node::Split { a, b, .. } => min_height(a).max(min_height(b)),
    }
}

fn weight(n: &Node, d: Dir) -> f64 {
    match n {
        Node::Split { dir, a, b, .. } if *dir == d => weight(a, d) + weight(b, d),
        _ => 1.0,
    }
}

fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    v.min(hi).max(lo)
}

fn round(v: f64) -> i32 {
    // JavaScript's Math.round: halves go up
    (v + 0.5).floor() as i32
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub root: Node,
    pub wins: Vec<Win>,
    pub cur: usize,
    pub prev: Option<usize>,
    next_id: usize,
}

impl Default for Layout {
    fn default() -> Self {
        Layout { root: Node::Win(0), wins: vec![Win { id: 0, session: None, scroll: 0 }], cur: 0, prev: None, next_id: 1 }
    }
}

impl Layout {
    /// A layout around a tree, for placing it (no windows of its own).
    pub fn with_root(root: Node) -> Layout {
        Layout { root, wins: vec![], cur: usize::MAX, prev: None, next_id: 0 }
    }

    pub fn win(&self, id: usize) -> &Win {
        self.wins.iter().find(|w| w.id == id).expect("a window in the layout")
    }

    pub fn win_mut(&mut self, id: usize) -> &mut Win {
        self.wins.iter_mut().find(|w| w.id == id).expect("a window in the layout")
    }

    /// Every window id, left to right, top to bottom.
    pub fn all(&self) -> Vec<usize> {
        fn walk(n: &Node, out: &mut Vec<usize>) {
            match n {
                Node::Win(id) => out.push(*id),
                Node::Split { a, b, .. } => {
                    walk(a, out);
                    walk(b, out);
                }
            }
        }
        let mut out = vec![];
        walk(&self.root, &mut out);
        out
    }

    pub fn count(&self) -> usize {
        self.all().len()
    }

    /// Whether every window fits. When they don't, only the current one is drawn.
    pub fn fits(&self, area: Rect) -> bool {
        min_width(&self.root) <= area.w && min_height(&self.root) <= area.h
    }

    /// Every node's place on screen, by path.
    pub fn rects(&self, area: Rect) -> Vec<(Path, Rect)> {
        if !self.fits(area) {
            return vec![(self.path_of(self.cur).unwrap_or_default(), area)];
        }
        fn place(n: &Node, r: Rect, path: Path, out: &mut Vec<(Path, Rect)>) {
            out.push((path.clone(), r));
            let Node::Split { dir, ratio, a, b } = n else { return };
            let (mut pa, mut pb) = (path.clone(), path);
            pa.push(false);
            pb.push(true);
            if *dir == Dir::Row {
                let inner = r.w - 1;
                let wa = clamp(round(inner as f64 * ratio), min_width(a), inner - min_width(b));
                place(a, Rect { w: wa, ..r }, pa, out);
                place(b, Rect { x: r.x + wa + 1, w: inner - wa, ..r }, pb, out);
            } else {
                let ha = clamp(round(r.h as f64 * ratio), min_height(a), r.h - min_height(b));
                place(a, Rect { h: ha, ..r }, pa, out);
                place(b, Rect { y: r.y + ha, h: r.h - ha, ..r }, pb, out);
            }
        }
        let mut out = vec![];
        place(&self.root, area, vec![], &mut out);
        out
    }

    /// A window's place on screen (the whole area when only the current one is drawn).
    pub fn rect_of(&self, id: usize, area: Rect) -> Option<Rect> {
        let path = self.path_of(id)?;
        self.rects(area).into_iter().find(|(p, _)| *p == path).map(|(_, r)| r)
    }

    pub fn path_of(&self, id: usize) -> Option<Path> {
        fn find(n: &Node, id: usize, path: &mut Path) -> bool {
            match n {
                Node::Win(w) => *w == id,
                Node::Split { a, b, .. } => {
                    path.push(false);
                    if find(a, id, path) {
                        return true;
                    }
                    path.pop();
                    path.push(true);
                    if find(b, id, path) {
                        return true;
                    }
                    path.pop();
                    false
                }
            }
        }
        let mut p = vec![];
        find(&self.root, id, &mut p).then_some(p)
    }

    fn node_mut(&mut self, path: &[bool]) -> &mut Node {
        let mut n = &mut self.root;
        for &side in path {
            n = match n {
                Node::Split { a, b, .. } => {
                    if side {
                        b
                    } else {
                        a
                    }
                }
                Node::Win(_) => break,
            };
        }
        n
    }

    fn node(&self, path: &[bool]) -> &Node {
        let mut n = &self.root;
        for &side in path {
            n = match n {
                Node::Split { a, b, .. } => {
                    if side {
                        b
                    } else {
                        a
                    }
                }
                Node::Win(_) => break,
            };
        }
        n
    }

    /// Split the current window; the new one shows the same thing and becomes current. False when there's no room.
    pub fn split(&mut self, dir: Dir, area: Rect) -> bool {
        let Some(r) = self.rect_of(self.cur, area) else { return false };
        if !self.fits(area) {
            return false;
        }
        if if dir == Dir::Row { r.w < MIN_WIDTH * 2 + 1 } else { r.h < MIN_HEIGHT * 2 } {
            return false;
        }
        let cur = self.win(self.cur).clone();
        let id = self.next_id;
        self.next_id += 1;
        self.wins.push(Win { id, session: cur.session, scroll: cur.scroll });
        let path = self.path_of(self.cur).unwrap_or_default();
        let node = self.node_mut(&path);
        let old = std::mem::replace(node, Node::Win(id));
        *node = Node::Split { dir, ratio: 0.5, a: Box::new(old), b: Box::new(Node::Win(id)) };
        self.prev = Some(self.cur);
        self.cur = id;
        self.equalize();
        true
    }

    /// Close a window. The last one can't be closed.
    pub fn close(&mut self, id: usize) -> bool {
        let Some(path) = self.path_of(id) else { return false };
        let Some((&last, parent)) = path.split_last() else { return false };
        let parent_node = self.node_mut(parent);
        let Node::Split { a, b, .. } = parent_node else { return false };
        let sibling = if last { (**a).clone() } else { (**b).clone() };
        *parent_node = sibling;
        self.wins.retain(|w| w.id != id);
        if self.prev == Some(id) {
            self.prev = None;
        }
        if self.cur == id {
            let all = self.all();
            self.cur = match self.prev {
                Some(p) if all.contains(&p) => p,
                _ => {
                    let sib = self.node(parent);
                    let mut first = vec![];
                    fn walk(n: &Node, out: &mut Vec<usize>) {
                        match n {
                            Node::Win(id) => out.push(*id),
                            Node::Split { a, b, .. } => {
                                walk(a, out);
                                walk(b, out);
                            }
                        }
                    }
                    walk(sib, &mut first);
                    first[0]
                }
            };
            self.prev = None;
        }
        self.equalize();
        true
    }

    pub fn only(&mut self) {
        self.root = Node::Win(self.cur);
        let cur = self.cur;
        self.wins.retain(|w| w.id == cur);
        self.prev = None;
    }

    pub fn equalize(&mut self) {
        fn eq(n: &mut Node) {
            if let Node::Split { dir, ratio, a, b } = n {
                let wa = weight(a, *dir);
                *ratio = wa / (wa + weight(b, *dir));
                eq(a);
                eq(b);
            }
        }
        eq(&mut self.root);
    }

    /// The splits around the current window in a direction, nearest first, with whether it's in `a`.
    fn ancestors(&self, d: Dir) -> Vec<(Path, bool)> {
        let path = self.path_of(self.cur).unwrap_or_default();
        let mut out = vec![];
        for depth in (0..path.len()).rev() {
            let p = &path[..depth];
            if let Node::Split { dir, .. } = self.node(p)
                && *dir == d
            {
                out.push((p.to_vec(), !path[depth]));
            }
        }
        out
    }

    /// Grow (or shrink) the current window.
    pub fn resize(&mut self, d: Dir, delta: i32, area: Rect) {
        let Some((near, in_a)) = self.ancestors(d).into_iter().next() else { return };
        let rects = self.rects(area);
        let get = |p: &Path| rects.iter().find(|(q, _)| q == p).map(|(_, r)| *r);
        let mut pa = near.clone();
        pa.push(false);
        let (Some(whole), Some(a)) = (get(&near), get(&pa)) else { return };
        let size = if d == Dir::Row { a.w } else { a.h };
        let room = if d == Dir::Row { whole.w - 1 } else { whole.h };
        if let Node::Split { ratio, .. } = self.node_mut(&near) {
            *ratio = ((size + if in_a { delta } else { -delta }) as f64 / room as f64).clamp(0.0, 1.0);
        }
    }

    /// Give the current window all the room it can have in one direction.
    pub fn maximize(&mut self, d: Dir) {
        for (p, in_a) in self.ancestors(d) {
            if let Node::Split { ratio, .. } = self.node_mut(&p) {
                *ratio = if in_a { 1.0 } else { 0.0 };
            }
        }
    }

    /// The window next to the current one on a side.
    pub fn neighbour(&self, side: Side, area: Rect) -> Option<usize> {
        if !self.fits(area) {
            return None;
        }
        let r = self.rect_of(self.cur, area)?;
        let across = |o: &Rect| match side {
            Side::Left | Side::Right => o.y < r.y + r.h && r.y < o.y + o.h,
            _ => o.x < r.x + r.w && r.x < o.x + o.w,
        };
        let touches = |o: &Rect| match side {
            Side::Left => o.x + o.w + 1 == r.x,
            Side::Right => r.x + r.w + 1 == o.x,
            Side::Up => o.y + o.h == r.y,
            Side::Down => r.y + r.h == o.y,
        };
        let found: Vec<usize> = self.all().into_iter().filter(|&w| w != self.cur && self.rect_of(w, area).is_some_and(|o| touches(&o) && across(&o))).collect();
        found.iter().find(|&&w| Some(w) == self.prev).or(found.first()).copied()
    }

    /// The window sharing the current one's split, when it's a single window.
    pub fn sibling(&self) -> Option<usize> {
        let path = self.path_of(self.cur)?;
        let (&last, parent) = path.split_last()?;
        let mut p = parent.to_vec();
        p.push(!last);
        match self.node(&p) {
            Node::Win(id) => Some(*id),
            _ => None,
        }
    }

    /// Swap the two halves of the current window's split.
    pub fn rotate(&mut self) {
        let Some(path) = self.path_of(self.cur) else { return };
        let Some((_, parent)) = path.split_last() else { return };
        if let Node::Split { ratio, a, b, .. } = self.node_mut(parent) {
            std::mem::swap(a, b);
            *ratio = 1.0 - *ratio;
        }
    }
}

// ---------------------------------------------------------------------------
// The area's state on the App
// ---------------------------------------------------------------------------

/// A y/n question on the command line (dd, ...), like vim's confirm prompts.
pub struct Confirm {
    pub question: String,
    pub on_yes: Box<dyn FnOnce(&mut App)>,
    pub on_no: Option<Box<dyn FnOnce(&mut App)>>,
}

/// Where the view was when / or ? started, to go back on Esc.
#[derive(Clone)]
pub struct SearchFrom {
    pub scroll: usize,
    pub hit: Option<Hit>,
    pub query: String,
    pub at: Hit,
    pub back: Hit,
}

/// <Tab> on the command line: what's offered, which one is in, what was typed.
#[derive(Clone)]
pub struct Wild {
    pub base: String,
    pub items: Vec<String>,
    pub idx: usize,
    pub typed: String,
    pub after: String,
    pub shown: String,
}

/// A line's cursor. The text itself is App::input / App::cmd; when the text
/// changes behind the cursor's back, the cursor goes to the end, as setting
/// a LineBuffer's text does in TypeScript.
#[derive(Default, Clone)]
pub struct Cursor {
    pub pos: usize,
    pub seen: String,
}

impl Cursor {
    pub fn buffer(&mut self, text: &str) -> LineBuffer {
        if self.seen != text {
            self.pos = text.chars().count();
            self.seen = text.to_string();
        }
        LineBuffer::new(text, self.pos)
    }
    pub fn store(&mut self, b: &LineBuffer) -> String {
        let t = b.text();
        self.pos = b.pos;
        self.seen = t.clone();
        t
    }
}

/// Window state on the App (add fields here, not to App).
pub struct Windows {
    pub layout: Layout,
    pub input_cursor: Cursor,
    pub cmd_cursor: Cursor,
    /// <C-f>: the mode whose line is edited in NORMAL mode, while it's still that mode
    pub line_normal_in: Option<Mode>,
    pub input_editor: LineEditor,
    pub cmd_editor: LineEditor,
    /// what the line's NORMAL mode last deleted or yanked; <C-r>" puts it in
    pub line_register: String,
    pub cmd_history: Vec<String>,
    pub search_history: Vec<String>,
    pub walk_prompt: HistoryWalk,
    pub walk_command: HistoryWalk,
    pub walk_search: HistoryWalk,
    pub wild: Option<Wild>,
    /// each agent's marks and jump list, as lines from the top of its transcript (by slot)
    pub marks: HashMap<usize, Vec<(char, usize)>>,
    pub jumps: HashMap<usize, (Vec<usize>, usize)>,
    pub last_visual: HashMap<usize, (usize, usize)>,
    /// m, ' or ` typed: the next key names the mark
    pub pending_mark: Option<char>,
    /// digits typed so far in NORMAL or VISUAL (5j); 0 when none
    pub pending_count: usize,
    pub search_query: String,
    pub cur_hit: Option<Hit>,
    pub search_from: Option<SearchFrom>,
    pub search_preview: String,
    pub search_backward: bool,
    /// VISUAL selection, as line indices into the transcript pane
    pub visual: (usize, usize),
    pub confirm: Option<Confirm>,
    pub picker: Option<Picker>,
    /// <leader>e: the cursor is in the SESSIONS sidebar
    pub sidebar_focused: bool,
    pub sidebar_pending: String,
    /// tool calls opened (folds are closed by default): (slot, item index)
    pub open_folds: HashSet<(usize, usize)>,
    /// [commands] and :command: your own ex commands
    pub commands: Vec<(String, Vec<String>)>,
    pub command_depth: usize,
    pub commands_loaded: bool,
    /// focus reporting: the terminal window has focus
    pub terminal_focused: bool,
    /// the alternate agent (<C-^>, :b #)
    pub alt: usize,
    /// the screen's size, from the last draw
    pub cols: u16,
    pub rows: u16,
    pub started: Option<Instant>,
    /// <C-l> with nowhere to go: draw the whole screen again
    pub redraw: bool,
    /// when the which-key panel is due, and that it's up (the keys then wait however long)
    pub hint_at: Option<Instant>,
    pub holding: bool,
    /// the hyperlinks on screen, from the last draw
    pub links: Vec<crate::ui::LinkSpot>,
    /// a split on the same agent forks it (replaced in tests)
    pub fork: fn(&mut App, usize) -> Result<usize, String>,
    /// copies text to the system clipboard; returns how (replaced in tests)
    pub clipboard: fn(&str) -> String,
}

impl Default for Windows {
    fn default() -> Self {
        Windows {
            layout: Layout::default(),
            input_cursor: Cursor::default(),
            cmd_cursor: Cursor::default(),
            line_normal_in: None,
            input_editor: LineEditor::default(),
            cmd_editor: LineEditor::default(),
            line_register: String::new(),
            cmd_history: vec![],
            search_history: vec![],
            walk_prompt: HistoryWalk::default(),
            walk_command: HistoryWalk::default(),
            walk_search: HistoryWalk::default(),
            wild: None,
            marks: HashMap::new(),
            jumps: HashMap::new(),
            last_visual: HashMap::new(),
            pending_mark: None,
            pending_count: 0,
            search_query: String::new(),
            cur_hit: None,
            search_from: None,
            search_preview: String::new(),
            search_backward: false,
            visual: (0, 0),
            confirm: None,
            picker: None,
            sidebar_focused: false,
            sidebar_pending: String::new(),
            open_folds: HashSet::new(),
            commands: vec![],
            command_depth: 0,
            commands_loaded: false,
            terminal_focused: true,
            alt: 0,
            cols: 120,
            rows: 32,
            started: None,
            redraw: false,
            hint_at: None,
            holding: false,
            links: vec![],
            fork: fork_session,
            clipboard: crate::actions::windows::copy_to_clipboard,
        }
    }
}

impl Windows {
    /// <C-f> was pressed and the line is still the one being typed.
    pub fn line_normal(&self, mode: Mode) -> bool {
        self.line_normal_in == Some(mode)
    }
}

/// A split's new agent: a copy of the conversation that goes its own way
/// (src/cli.ts forkSession). It runs in the same folder, because the
/// conversation's paths point there, and holds no worktree of its own, so
/// :kill! and :merge can't reach the original's. Its slot.
pub fn fork_session(app: &mut App, slot: usize) -> Result<usize, String> {
    let s = &app.sessions[slot];
    let engine_name = crate::engines::engine_name(&s.engine);
    let can = crate::engines::adapter(&s.engine).is_some_and(|a| a.can_fork());
    if !can {
        return Err(format!("{engine_name} can't fork a conversation yet. :vsplit <agent> shows another agent beside this one."));
    }
    if s.engine == "claude" && s.resume_id.is_some() && s.last_message.is_none() {
        return Err(format!("couldn't find where '{}''s Claude Code conversation is up to, so it can't be forked. :vsplit <agent> shows another agent beside this one.", s.name));
    }
    let taken: Vec<String> = app.sessions.iter().filter(|x| !x.closed).map(|x| x.name.clone()).collect();
    let base = format!("{} (fork)", s.name);
    let mut name = base.clone();
    let mut n = 2;
    while taken.contains(&name) {
        name = format!("{} {n})", &base[..base.len() - 1]);
        n += 1;
    }
    let index = app.sessions.len();
    let mut f = crate::session::Session::new(index, &name, &s.engine.clone(), s.path.clone());
    f.items = s.items.clone();
    f.tool_output = s.tool_output.clone();
    f.requested_model = s.requested_model.clone();
    f.model = s.model.clone();
    f.effort = s.effort.clone();
    f.resume_id = s.resume_id.clone();
    f.base = s.base.clone();
    if s.resume_id.is_some() {
        f.fork_at = Some(s.last_message.clone());
    }
    app.sessions.push(f);
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 120, h: 30 };

    fn ids(l: &Layout) -> Vec<Rect> {
        l.all().into_iter().map(|w| l.rect_of(w, AREA).unwrap()).collect()
    }

    #[test]
    fn splits_share_the_room_with_a_separator_and_three_are_equal() {
        let mut l = Layout::default();
        assert!(l.split(Dir::Row, AREA));
        assert_eq!(ids(&l), vec![Rect { x: 0, y: 0, w: 60, h: 30 }, Rect { x: 61, y: 0, w: 59, h: 30 }]);
        assert!(l.split(Dir::Row, AREA));
        let r = ids(&l);
        assert_eq!(r.len(), 3);
        assert!(r.iter().all(|x| (x.w - 39).abs() <= 1), "{r:?}");
        assert_eq!(l.count(), 3);
    }

    #[test]
    fn no_room_no_split_and_closing_gives_it_back() {
        let mut l = Layout::default();
        assert!(!l.split(Dir::Row, Rect { x: 0, y: 0, w: 40, h: 30 }));
        assert!(l.split(Dir::Column, AREA));
        let (first, second) = (l.all()[0], l.all()[1]);
        assert_eq!(l.cur, second);
        assert_eq!(l.neighbour(Side::Up, AREA), Some(first));
        assert!(l.close(second));
        assert_eq!(l.cur, first);
        assert!(!l.close(first), "the last one stays");
        assert_eq!(l.rect_of(first, AREA), Some(AREA));
    }

    #[test]
    fn neighbours_resize_maximize_rotate() {
        let mut l = Layout::default();
        l.split(Dir::Row, AREA);
        let (left, right) = (l.all()[0], l.all()[1]);
        l.split(Dir::Column, AREA);
        let below = l.cur;
        assert_eq!(l.neighbour(Side::Left, AREA), Some(left));
        assert_eq!(l.neighbour(Side::Up, AREA), Some(right));
        l.cur = left;
        l.resize(Dir::Row, 5, AREA);
        assert_eq!(l.rect_of(left, AREA).unwrap().w, 65);
        l.maximize(Dir::Row);
        assert_eq!(l.rect_of(left, AREA).unwrap().w, 120 - 1 - MIN_WIDTH);
        assert_eq!(l.sibling(), None);
        l.cur = below;
        assert_eq!(l.sibling(), Some(right));
        l.rotate();
        assert_eq!(l.all(), vec![left, below, right]);
    }
}
