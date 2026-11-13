//! Vim-style keymaps, the same as src/keys.ts.
//!
//! Keys use vim notation: `j`, `gg`, `<C-d>`, `<S-Tab>`, `<M-x>`, `<CR>`,
//! `<Esc>`, `<Space>`, `<leader>`, `<F5>`. A mapping's right-hand side is one
//! of (or a list of):
//!
//!   "session.next"           an action (actions/: what each one does)
//!   ":colorscheme nord<CR>"  an ex command (without <CR>: opens the command line prefilled)
//!   "gg"                     other keys, replayed through the built-in keymap (like noremap)
//!   "<Nop>" or false         nothing: unbinds the key
//!
//! Like vim, a key that starts a longer mapping waits `timeoutlen` ms for the
//! rest ([`Sequencer`]); that is what makes `jk` = `<Esc>` in insert mode work.
//!
//! EXTENSION POINTS: a new action is a name + description in [`ACTIONS`]
//! (so mappings may name it) and a handler in actions/<area>.rs. A new default
//! key is a line in [`DEFAULT_KEYS`].

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum KeyMode {
    Normal,
    Insert,
    Visual,
    Command,
}

pub const KEY_MODES: [KeyMode; 4] = [KeyMode::Normal, KeyMode::Insert, KeyMode::Visual, KeyMode::Command];

impl KeyMode {
    pub fn name(self) -> &'static str {
        match self {
            KeyMode::Normal => "normal",
            KeyMode::Insert => "insert",
            KeyMode::Visual => "visual",
            KeyMode::Command => "command",
        }
    }
    pub fn from_name(s: &str) -> Option<KeyMode> {
        KEY_MODES.into_iter().find(|m| m.name() == s)
    }
}

/// vigent's default <leader>, as in most Neovim configs (vim's own default is "\\")
pub const DEFAULT_LEADER: &str = "<Space>";

#[derive(Clone, Debug, PartialEq)]
pub enum Rhs {
    Action { name: String, arg: Option<String> },
    Ex { cmd: String, execute: bool },
    Keys(Vec<String>),
    Nop,
}

#[derive(Clone, Debug)]
pub struct Binding {
    /// canonical key sequence, e.g. ["<Space>", "t"]
    pub keys: Vec<String>,
    pub rhs: Vec<Rhs>,
    /// the right-hand side as written, for listings
    pub rhs_text: String,
    pub user: bool,
}

/// A mapping's right-hand side as config.toml (or :nmap) gives it.
#[derive(Clone, Debug, PartialEq)]
pub enum RhsValue {
    Str(String),
    Bool(bool),
    List(Vec<RhsValue>),
    Other,
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// Every action a key can be mapped to, with what :help says about it.
pub const ACTIONS: &[(&str, &str)] = &[
    ("mode.normal", "back to NORMAL mode"),
    ("mode.insert", "write a prompt to the focused agent (INSERT)"),
    ("mode.insert_start", "write the prompt from its start"),
    ("mode.append_end", "write the prompt from its end"),
    ("mode.command", "open the : command line"),
    ("mode.search", "search the transcript"),
    ("mode.search_back", "search the transcript backward"),
    ("mode.visual", "select transcript lines (VISUAL)"),
    ("cursor.down", "move the VISUAL cursor down"),
    ("cursor.up", "move the VISUAL cursor up"),
    ("cursor.half_down", "move the VISUAL cursor down half a page"),
    ("cursor.half_up", "move the VISUAL cursor up half a page"),
    ("cursor.page_down", "move the VISUAL cursor down a page"),
    ("cursor.page_up", "move the VISUAL cursor up a page"),
    ("cursor.screen_top", "move the VISUAL cursor to the top of the window"),
    ("cursor.screen_middle", "move the VISUAL cursor to the middle of the window"),
    ("cursor.screen_bottom", "move the VISUAL cursor to the bottom of the window"),
    ("cursor.top", "move the VISUAL cursor to the top"),
    ("cursor.bottom", "move the VISUAL cursor to the bottom"),
    ("visual.yank", "copy the selection to the clipboard"),
    ("visual.inner_block", "select the code block under the cursor"),
    ("visual.swap", "jump to the other end of the selection"),
    ("visual.reselect", "select the last VISUAL selection again"),
    ("view.center", "the cursor line or search match to the middle (zz)"),
    ("view.top", "the cursor line or search match to the top (zt)"),
    ("view.bottom", "the cursor line or search match to the bottom (zb)"),
    ("jump.back", "back to where you were before a jump"),
    ("jump.forward", "forward again after <C-o> (<Tab> is <C-i>)"),
    ("app.position", "the agent's name and where you are in it (<C-g>)"),
    ("message.next", "jump to the next message"),
    ("message.prev", "jump to the previous message"),
    ("yank.reply", "copy the agent's last reply"),
    ("yank.block", "copy the nearest code block"),
    ("scroll.down", "scroll down one line"),
    ("scroll.up", "scroll up one line"),
    ("scroll.half_down", "scroll down half a page"),
    ("scroll.half_up", "scroll up half a page"),
    ("scroll.page_down", "scroll down a page"),
    ("scroll.page_up", "scroll up a page"),
    ("scroll.top", "jump to the top of the transcript"),
    ("scroll.bottom", "jump to the bottom of the transcript"),
    ("session.next", "next session"),
    ("session.prev", "previous session"),
    ("session.alternate", "last focused session"),
    ("session.tab", "next session, or session N with a count (3gt)"),
    ("session.goto", "session N (session.goto 3)"),
    ("session.new", "spawn a new agent"),
    ("session.kill", "kill the focused agent (asks first)"),
    ("session.abort", "stop the focused agent's current run"),
    ("session.pause", "pause the agent and hold its queued prompts"),
    ("session.resume", "resume a paused agent"),
    ("session.tree", "the conversation tree: go back to an earlier point"),
    ("sidebar.focus", "sessions sidebar: j/k pick an agent, Enter or Esc back"),
    ("window.vsplit", "split the window side by side (<C-w>v, :vsplit)"),
    ("window.split", "split the window, one above the other (<C-w>s, :split)"),
    ("window.close", "close this window (<C-w>c, :close)"),
    ("window.quit", "close this window, or quit if it's the last one (<C-w>q, :q)"),
    ("window.only", "close every other window (<C-w>o, :only)"),
    ("window.down", "the window below"),
    ("window.up", "the window above"),
    ("window.next", "the next window, the sidebar counts as one (<C-w>w)"),
    ("window.prev", "the previous window (<C-w>W)"),
    ("window.last", "the window you were in last (<C-w>p)"),
    ("window.top", "the first window (<C-w>t)"),
    ("window.bottom", "the last window (<C-w>b)"),
    ("window.equal", "make all windows the same size (<C-w>=)"),
    ("window.wider", "one column wider (<C-w>>)"),
    ("window.narrower", "one column narrower (<C-w><)"),
    ("window.taller", "one row taller (<C-w>+)"),
    ("window.shorter", "one row shorter (<C-w>-)"),
    ("window.max_width", "as wide as it can be (<C-w>|)"),
    ("window.max_height", "as tall as it can be (<C-w>_)"),
    ("window.exchange", "swap what this window and the one next to it show (<C-w>x)"),
    ("window.rotate", "swap the two halves of this split (<C-w>r)"),
    ("window.left", "the window to the left (like <C-w>h): the sessions sidebar, or the transcript when the sidebar is on the right"),
    ("window.right", "the window to the right (like <C-w>l): back to the transcript, or the sidebar when it's on the right; with nowhere to go, redraw"),
    ("fold.toggle", "fold / unfold tool output"),
    ("fold.open_all", "unfold all tool output"),
    ("fold.close_all", "fold all tool output"),
    ("search.next", "next search match"),
    ("search.prev", "previous search match"),
    ("search.clear", "clear search highlighting"),
    ("edit.submit", "send the prompt / run the command line"),
    ("edit.backspace", "delete the character before the cursor"),
    ("edit.delete_word", "delete the word before the cursor"),
    ("edit.clear", "delete everything before the cursor"),
    ("edit.delete", "delete the character under the cursor"),
    ("edit.left", "cursor one character left"),
    ("edit.right", "cursor one character right"),
    ("edit.home", "cursor to the start of the line"),
    ("edit.end", "cursor to the end of the line"),
    ("edit.word_left", "cursor one word left"),
    ("edit.word_right", "cursor one word right"),
    ("edit.history_prev", "the older line from history that starts with what's typed"),
    ("edit.history_next", "the newer line from history that starts with what's typed"),
    ("edit.paste", "insert what was last deleted or yanked in the line's NORMAL mode"),
    ("edit.normal", "edit the line in NORMAL mode: motions, operators, text objects, undo"),
    ("edit.complete", "complete the command, agent or theme; again for the next one"),
    ("edit.complete_prev", "the previous completion"),
    ("theme.picker", "pick a colorscheme"),
    ("app.help", "show all keys"),
    ("app.dashboard", "all agents at a glance"),
    ("app.redraw", "redraw the screen"),
    ("app.quit", "quit vigent (asks if agents are running)"),
    ("app.quit_force", "quit even if agents are running"),
    ("app.quit_hint", "explain how to quit"),
    ("noop", "do nothing"),
];

pub fn is_action(name: &str) -> bool {
    ACTIONS.iter().any(|(n, _)| *n == name)
}

/// The built-in keymap, in the same notation users write (src/keys.ts DEFAULT_KEYS).
pub fn default_keys(mode: KeyMode) -> Vec<(String, String)> {
    let pairs: &[(&str, &str)] = match mode {
        KeyMode::Normal => NORMAL_KEYS,
        KeyMode::Visual => VISUAL_KEYS,
        KeyMode::Insert => INSERT_KEYS,
        KeyMode::Command => COMMAND_KEYS,
    };
    let mut out: Vec<(String, String)> = pairs.iter().map(|(l, r)| (l.to_string(), r.to_string())).collect();
    if mode == KeyMode::Normal {
        // <leader>1..9: session.goto N (after gT/<C-^>, as in src/keys.ts)
        let at = out.iter().position(|(l, _)| l == "<C-^>").map(|i| i + 1).unwrap_or(out.len());
        for n in (1..=9).rev() {
            out.insert(at, (format!("<leader>{n}"), format!("session.goto {n}")));
        }
    }
    out
}

const NORMAL_KEYS: &[(&str, &str)] = &[
    ("i", "mode.insert"),
    ("a", "mode.insert"),
    ("o", "mode.insert"),
    (":", "mode.command"),
    ("/", "mode.search"),
    ("?", "mode.search_back"),
    ("v", "mode.visual"),
    ("V", "mode.visual"),
    ("j", "scroll.down"),
    ("<Down>", "scroll.down"),
    ("k", "scroll.up"),
    ("<Up>", "scroll.up"),
    ("<C-e>", "scroll.down"),
    ("<C-y>", "scroll.up"),
    ("<C-n>", "scroll.down"),
    ("<C-p>", "scroll.up"),
    ("<C-d>", "scroll.half_down"),
    ("<C-u>", "scroll.half_up"),
    ("<C-f>", "scroll.page_down"),
    ("<PageDown>", "scroll.page_down"),
    ("<C-b>", "scroll.page_up"),
    ("<PageUp>", "scroll.page_up"),
    ("gg", "scroll.top"),
    ("G", "scroll.bottom"),
    ("]s", "session.next"),
    ("[s", "session.prev"),
    ("gt", "session.tab"),
    ("gT", "session.prev"),
    ("<C-^>", "session.alternate"),
    ("za", "fold.toggle"),
    ("zR", "fold.open_all"),
    ("zM", "fold.close_all"),
    ("zr", "fold.open_all"),
    ("zm", "fold.close_all"),
    ("n", "search.next"),
    ("N", "search.prev"),
    ("{", "message.prev"),
    ("}", "message.next"),
    ("yy", "yank.reply"),
    ("yib", "yank.block"),
    ("dd", "session.kill"),
    ("<Esc>", "search.clear"),
    ("<C-c>", "session.abort"),
    ("<C-l>", "window.right"),
    ("<C-h>", "window.left"),
    // most terminals send <C-h> as Backspace (0x08): in NORMAL it means the same
    ("<BS>", "window.left"),
    ("<C-j>", "window.down"),
    ("<C-k>", "window.up"),
    ("<C-w>h", "window.left"),
    ("<C-w><C-h>", "window.left"),
    ("<C-w>l", "window.right"),
    ("<C-w><C-l>", "window.right"),
    ("<C-w>j", "window.down"),
    ("<C-w><C-j>", "window.down"),
    ("<C-w>k", "window.up"),
    ("<C-w><C-k>", "window.up"),
    ("<C-w>w", "window.next"),
    ("<C-w><C-w>", "window.next"),
    ("<C-w>W", "window.prev"),
    ("<C-w>p", "window.last"),
    ("<C-w><C-p>", "window.last"),
    ("<C-w>t", "window.top"),
    ("<C-w>b", "window.bottom"),
    ("<C-w>v", "window.vsplit"),
    ("<C-w><C-v>", "window.vsplit"),
    ("<C-w>s", "window.split"),
    ("<C-w>S", "window.split"),
    ("<C-w><C-s>", "window.split"),
    ("<C-w>c", "window.close"),
    ("<C-w>q", "window.quit"),
    ("<C-w><C-q>", "window.quit"),
    ("<C-w>o", "window.only"),
    ("<C-w><C-o>", "window.only"),
    ("<C-w>=", "window.equal"),
    ("<C-w>>", "window.wider"),
    ("<C-w><lt>", "window.narrower"),
    ("<C-w>+", "window.taller"),
    ("<C-w>-", "window.shorter"),
    ("<C-w>|", "window.max_width"),
    ("<C-w>_", "window.max_height"),
    ("<C-w>x", "window.exchange"),
    ("<C-w><C-x>", "window.exchange"),
    ("<C-w>r", "window.rotate"),
    ("<C-w><C-r>", "window.rotate"),
    ("<leader>|", "window.vsplit"),
    ("<leader>-", "window.split"),
    ("<leader>n", ":new "),
    ("<leader>d", ":diff<CR>"),
    ("<leader>m", ":merge<CR>"),
    ("<leader>p", ":pr<CR>"),
    ("<leader>q", ":queue "),
    ("<leader>t", "theme.picker"),
    ("<leader>D", ":dash<CR>"),
    ("<leader>u", "session.tree"),
    ("<leader>s", ":settings<CR>"),
    ("<leader>r", ":review<CR>"),
    ("<leader>T", ":templates<CR>"),
    ("<leader>M", ":model<CR>"),
    ("<leader>e", "sidebar.focus"),
    ("<leader>R", ":effort<CR>"),
    ("<leader>E", ":engine<CR>"),
    ("I", "mode.insert_start"),
    ("A", "mode.append_end"),
    ("zz", "view.center"),
    ("zt", "view.top"),
    ("zb", "view.bottom"),
    ("gv", "visual.reselect"),
    ("<C-o>", "jump.back"),
    ("<Tab>", "jump.forward"),
    ("<C-g>", "app.position"),
    ("ZZ", "app.quit"),
    ("ZQ", "app.quit_force"),
    ("q", "app.quit_hint"),
];

const VISUAL_KEYS: &[(&str, &str)] = &[
    ("j", "cursor.down"),
    ("<Down>", "cursor.down"),
    ("k", "cursor.up"),
    ("<Up>", "cursor.up"),
    ("<C-d>", "cursor.half_down"),
    ("<C-u>", "cursor.half_up"),
    ("<C-f>", "cursor.page_down"),
    ("<PageDown>", "cursor.page_down"),
    ("<C-b>", "cursor.page_up"),
    ("<PageUp>", "cursor.page_up"),
    ("H", "cursor.screen_top"),
    ("M", "cursor.screen_middle"),
    ("L", "cursor.screen_bottom"),
    ("gg", "cursor.top"),
    ("G", "cursor.bottom"),
    ("y", "visual.yank"),
    ("ib", "visual.inner_block"),
    ("o", "visual.swap"),
    ("zz", "view.center"),
    ("zt", "view.top"),
    ("zb", "view.bottom"),
    ("<Esc>", "mode.normal"),
    ("<C-c>", "mode.normal"),
    ("v", "mode.normal"),
    ("V", "mode.normal"),
];

const INSERT_KEYS: &[(&str, &str)] = &[
    ("<Esc>", "mode.normal"),
    ("<C-c>", "mode.normal"),
    ("<CR>", "edit.submit"),
    ("<BS>", "edit.backspace"),
    ("<C-h>", "edit.backspace"),
    ("<C-w>", "edit.delete_word"),
    ("<C-u>", "edit.clear"),
    ("<Del>", "edit.delete"),
    ("<Left>", "edit.left"),
    ("<Right>", "edit.right"),
    ("<Home>", "edit.home"),
    ("<End>", "edit.end"),
    ("<C-Left>", "edit.word_left"),
    ("<S-Left>", "edit.word_left"),
    ("<C-Right>", "edit.word_right"),
    ("<S-Right>", "edit.word_right"),
    ("<Up>", "edit.history_prev"),
    ("<Down>", "edit.history_next"),
    ("<C-r>\"", "edit.paste"),
    ("<C-f>", "edit.normal"),
];

const COMMAND_KEYS: &[(&str, &str)] = &[
    ("<Esc>", "mode.normal"),
    ("<C-c>", "mode.normal"),
    ("<CR>", "edit.submit"),
    ("<BS>", "edit.backspace"),
    ("<C-h>", "edit.backspace"),
    ("<C-w>", "edit.delete_word"),
    ("<C-u>", "edit.clear"),
    ("<Del>", "edit.delete"),
    ("<Left>", "edit.left"),
    ("<Right>", "edit.right"),
    ("<Home>", "edit.home"),
    ("<End>", "edit.end"),
    ("<C-Left>", "edit.word_left"),
    ("<S-Left>", "edit.word_left"),
    ("<C-Right>", "edit.word_right"),
    ("<S-Right>", "edit.word_right"),
    ("<Up>", "edit.history_prev"),
    ("<Down>", "edit.history_next"),
    ("<C-r>\"", "edit.paste"),
    ("<C-f>", "edit.normal"),
    ("<C-b>", "edit.home"),
    ("<C-e>", "edit.end"),
    ("<C-p>", "edit.history_prev"),
    ("<C-n>", "edit.history_next"),
    ("<Tab>", "edit.complete"),
    ("<S-Tab>", "edit.complete_prev"),
];

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

fn named(lower: &str) -> Option<String> {
    let n = match lower {
        "space" => "Space",
        "tab" => "Tab",
        "cr" | "enter" | "return" => "CR",
        "esc" | "escape" => "Esc",
        "bs" | "backspace" => "BS",
        "del" | "delete" => "Del",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "insert" => "Insert",
        f if f.len() >= 2 && f.starts_with('f') && f[1..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n)) => return Some(format!("F{}", &f[1..])),
        _ => return None,
    };
    Some(n.to_string())
}

/// A canonical token from modifiers (C, M, S, D) and a base key ("Space", "x", "F5").
pub fn token(mods: &[char], base: &str) -> String {
    let mut mods: Vec<char> = mods.to_vec();
    let has = |m: &Vec<char>, c: char| m.contains(&c);
    let mut key = base.to_string();
    let one = key.chars().count() == 1;
    if one && has(&mods, 'S') && !has(&mods, 'C') && !has(&mods, 'M') && !has(&mods, 'D') {
        mods.retain(|&c| c != 'S');
        key = key.to_uppercase();
    }
    if one && has(&mods, 'M') && !has(&mods, 'C') && key != key.to_lowercase() {
        // Alt keeps case apart, as <M-S-g>, so Esc-then-G stays G
        if !has(&mods, 'S') {
            mods.push('S');
        }
        key = key.to_lowercase();
    }
    if one && (has(&mods, 'C') || has(&mods, 'M')) {
        key = key.to_lowercase();
    }
    if mods.is_empty() {
        if key == "<" {
            return "<lt>".into();
        }
        return if key.chars().count() == 1 { key } else { format!("<{key}>") };
    }
    let order: String = ['C', 'M', 'S', 'D'].iter().filter(|m| mods.contains(m)).map(|m| format!("{m}-")).collect();
    format!("<{order}{}>", if key == "<" { "lt" } else { &key })
}

/// The inside of <...>; None if it isn't a key name (then `<` is literal).
fn parse_bracket(inner: &str) -> Option<String> {
    let lower = inner.to_lowercase();
    match lower.as_str() {
        "lt" => return Some("<lt>".into()),
        "bar" => return Some("|".into()),
        "bslash" => return Some("\\".into()),
        _ => {}
    }
    // leading modifiers: C- M- A- S- D-
    let mut mods = vec![];
    let mut rest = inner;
    loop {
        let b = rest.as_bytes();
        if b.len() > 2 && b[1] == b'-' && matches!(b[0].to_ascii_lowercase(), b'c' | b'm' | b'a' | b's' | b'd') {
            let m = b[0].to_ascii_uppercase() as char;
            mods.push(if m == 'A' { 'M' } else { m });
            rest = &rest[2..];
        } else {
            break;
        }
    }
    if let Some(n) = named(&rest.to_lowercase()) {
        return Some(token(&mods, &n));
    }
    if rest.eq_ignore_ascii_case("lt") {
        return Some(token(&mods, "<"));
    }
    if !mods.is_empty() && rest.chars().count() == 1 {
        return Some(token(&mods, rest));
    }
    None
}

/// Vim key notation as canonical tokens. `<leader>` expands to `leader`.
pub fn parse_keys(notation: &str, leader: &str) -> Result<Vec<String>, String> {
    let chars: Vec<char> = notation.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '<' {
            if let Some(close) = chars[i + 1..].iter().position(|&c| c == '>').map(|p| p + i + 1)
                && close > i + 1 {
                    let inner: String = chars[i + 1..close].iter().collect();
                    if inner.eq_ignore_ascii_case("leader") {
                        out.extend(parse_keys(leader, "\\")?);
                        i = close + 1;
                        continue;
                    }
                    if let Some(t) = parse_bracket(&inner) {
                        out.push(t);
                        i = close + 1;
                        continue;
                    }
                }
            out.push("<lt>".into());
            i += 1;
            continue;
        }
        out.push(if ch == ' ' { "<Space>".into() } else { ch.to_string() });
        i += 1;
    }
    if out.is_empty() {
        return Err("empty key sequence".into());
    }
    Ok(out)
}

/// A key press as a canonical token, or None if it isn't a key vigent reads.
pub fn token_from_event(k: &KeyEvent) -> Option<String> {
    let mut mods = vec![];
    if k.modifiers.contains(KeyModifiers::CONTROL) {
        mods.push('C');
    }
    if k.modifiers.contains(KeyModifiers::ALT) {
        mods.push('M');
    }
    if k.modifiers.contains(KeyModifiers::SHIFT) {
        mods.push('S');
    }
    if k.modifiers.contains(KeyModifiers::SUPER) {
        mods.push('D');
    }
    let base: String = match k.code {
        KeyCode::Char(' ') if mods.is_empty() || mods == ['S'] => return Some("<Space>".into()),
        KeyCode::Char(' ') => "Space".into(),
        // <C-6> is how many terminals report <C-^>
        KeyCode::Char('6' | '^') if mods == ['C'] || mods == ['C', 'S'] => return Some("<C-^>".into()),
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "CR".into(),
        KeyCode::Esc => "Esc".into(),
        KeyCode::Backspace => "BS".into(),
        KeyCode::Delete => "Del".into(),
        KeyCode::Tab => "Tab".into(),
        KeyCode::BackTab => {
            if !mods.contains(&'S') {
                mods.push('S');
            }
            "Tab".into()
        }
        KeyCode::Up => "Up".into(),
        KeyCode::Down => "Down".into(),
        KeyCode::Left => "Left".into(),
        KeyCode::Right => "Right".into(),
        KeyCode::Home => "Home".into(),
        KeyCode::End => "End".into(),
        KeyCode::PageUp => "PageUp".into(),
        KeyCode::PageDown => "PageDown".into(),
        KeyCode::Insert => "Insert".into(),
        KeyCode::F(n) => format!("F{n}"),
        _ => return None,
    };
    // a shifted character is already the character
    if base.chars().count() == 1 && mods.len() == 1 && mods[0] == 'S' && !base.chars().next().unwrap().is_ascii_lowercase() {
        mods.clear();
    }
    Some(token(&mods, &base))
}

/// The text a token types in INSERT / command-line mode, if any.
pub fn token_text(t: &str) -> Option<String> {
    match t {
        "<Space>" => Some(" ".into()),
        "<lt>" => Some("<".into()),
        _ if t.chars().count() == 1 => Some(t.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Right-hand sides
// ---------------------------------------------------------------------------

/// The closest name, for "did you mean" (src/suggest.ts).
pub fn did_you_mean(word: &str, names: &[&str]) -> String {
    fn dist(a: &str, b: &str) -> usize {
        let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
        let mut prev: Vec<usize> = (0..=b.len()).collect();
        for i in 1..=a.len() {
            let mut cur = vec![i; b.len() + 1];
            for j in 1..=b.len() {
                cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
            }
            prev = cur;
        }
        prev[b.len()]
    }
    let best = names.iter().map(|n| (dist(word, n), *n)).min();
    match best {
        Some((d, n)) if d <= 3.max(word.len() / 3) => format!(" (did you mean '{n}'?)"),
        _ => String::new(),
    }
}

/// A mapping's right-hand side. Errors are readable messages.
pub fn parse_rhs(value: &RhsValue, leader: &str) -> Result<Vec<Rhs>, String> {
    match value {
        RhsValue::Bool(false) => return Ok(vec![Rhs::Nop]),
        RhsValue::List(items) if items.is_empty() => return Ok(vec![Rhs::Nop]),
        RhsValue::List(items) => {
            let mut out = vec![];
            for v in items {
                out.extend(parse_rhs(v, leader)?);
            }
            return Ok(out);
        }
        RhsValue::Str(s) if s.is_empty() || s.trim().eq_ignore_ascii_case("<nop>") => return Ok(vec![Rhs::Nop]),
        RhsValue::Str(_) => {}
        _ => return Err("should be an action, an ex command, keys, or false".into()),
    }
    let RhsValue::Str(value) = value else { unreachable!() };
    let v = value.trim();
    let lower = v.to_lowercase();
    // ":cmd<CR>" runs it; ":cmd " (no <CR>) opens the command line with that text, trailing space kept
    if v.starts_with(':') || lower.starts_with("<cmd>") {
        let start = value.trim_start();
        let body = if let Some(b) = start.strip_prefix(':') { b } else { &start[5..] };
        let bl = body.to_lowercase();
        let (cmd, cr) = ["<cr>", "<enter>", "<return>"].iter().find_map(|e| bl.ends_with(e).then(|| (&body[..body.len() - e.len()], true))).unwrap_or((body, false));
        let execute = cr || lower.starts_with("<cmd>");
        let cmd = if execute { cmd.trim().to_string() } else { cmd.trim_start().to_string() };
        return Ok(vec![Rhs::Ex { cmd, execute }]);
    }
    // an action: name.name [arg]
    let mut parts = v.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("");
    let arg = parts.next().map(str::trim).filter(|a| !a.is_empty() && !a.contains(char::is_whitespace));
    let looks = !name.is_empty() && name.split('.').count() <= 2 && name.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '.') && !name.starts_with('.') && !name.ends_with('.');
    if looks && (parts.next().is_none() || arg.is_some()) && (name.contains('.') || name == "noop") {
        if !is_action(name) {
            let names: Vec<&str> = ACTIONS.iter().map(|(n, _)| *n).collect();
            return Err(format!("unknown action '{name}'{}", did_you_mean(name, &names)));
        }
        return Ok(vec![Rhs::Action { name: name.into(), arg: arg.map(str::to_string) }]);
    }
    Ok(vec![Rhs::Keys(parse_keys(v, leader)?)])
}

fn rhs_text(value: &RhsValue) -> String {
    match value {
        RhsValue::Bool(false) => "<Nop>".into(),
        RhsValue::Bool(true) => "true".into(),
        RhsValue::List(items) => items.iter().map(rhs_text).collect::<Vec<_>>().join(", "),
        RhsValue::Str(s) => s.clone(),
        RhsValue::Other => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Keymap
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct ModeMap {
    map: HashMap<String, Binding>,
    /// insertion order, for listings
    order: Vec<String>,
    prefixes: HashSet<String>,
}

impl ModeMap {
    fn insert(&mut self, b: Binding) {
        let k = b.keys.concat();
        if !self.map.contains_key(&k) {
            self.order.push(k.clone());
        }
        self.map.insert(k, b);
    }
    fn recompute(&mut self) {
        self.prefixes.clear();
        for b in self.map.values() {
            for i in 1..b.keys.len() {
                self.prefixes.insert(b.keys[..i].concat());
            }
        }
    }
}

pub struct Lookup {
    pub exact: Option<Binding>,
    /// a longer mapping starts with these keys
    pub prefix: bool,
}

#[derive(Clone)]
pub struct Keymap {
    pub leader: String,
    maps: HashMap<KeyMode, ModeMap>,
    defaults: HashMap<KeyMode, ModeMap>,
}

impl Default for Keymap {
    fn default() -> Self {
        Keymap::new(DEFAULT_LEADER)
    }
}

impl Keymap {
    pub fn new(leader: &str) -> Keymap {
        let mut defaults = HashMap::new();
        for mode in KEY_MODES {
            let mut m = ModeMap::default();
            for (lhs, rhs) in default_keys(mode) {
                let keys = parse_keys(&lhs, leader).expect("built-in key notation");
                let parsed = parse_rhs(&RhsValue::Str(rhs.clone()), leader).expect("built-in right-hand side");
                m.insert(Binding { keys, rhs: parsed, rhs_text: rhs, user: false });
            }
            m.recompute();
            defaults.insert(mode, m);
        }
        Keymap { leader: leader.into(), maps: defaults.clone(), defaults }
    }

    /// Add or replace a mapping (:nmap, [keys]).
    pub fn set(&mut self, mode: KeyMode, lhs: &str, rhs: &RhsValue) -> Result<Binding, String> {
        let keys = parse_keys(lhs, &self.leader)?;
        let b = Binding { keys, rhs: parse_rhs(rhs, &self.leader)?, rhs_text: rhs_text(rhs), user: true };
        let m = self.maps.get_mut(&mode).expect("every mode");
        m.insert(b.clone());
        m.recompute();
        Ok(b)
    }

    /// Remove a mapping (built-in or yours). False if nothing was mapped.
    pub fn unset(&mut self, mode: KeyMode, lhs: &str) -> bool {
        let Ok(keys) = parse_keys(lhs, &self.leader) else { return false };
        let k = keys.concat();
        let m = self.maps.get_mut(&mode).expect("every mode");
        let removed = m.map.remove(&k).is_some();
        m.order.retain(|o| *o != k);
        m.recompute();
        removed
    }

    pub fn lookup(&self, mode: KeyMode, keys: &[String], builtin_only: bool) -> Lookup {
        let m = if builtin_only { &self.defaults[&mode] } else { &self.maps[&mode] };
        let k = keys.concat();
        Lookup { exact: m.map.get(&k).cloned(), prefix: m.prefixes.contains(&k) }
    }

    /// Every active binding for a mode, in a stable order.
    pub fn bindings(&self, mode: KeyMode) -> Vec<&Binding> {
        let m = &self.maps[&mode];
        m.order.iter().filter_map(|k| m.map.get(k)).collect()
    }
}

/// A keymap from config: `leader` plus [keys.normal], [keys.insert], ... (src/keys.ts buildKeymap).
pub fn build_keymap(leader: Option<&str>, keys: &[(KeyMode, String, RhsValue)]) -> (Keymap, Vec<String>) {
    let mut warnings = vec![];
    let mut notation = DEFAULT_LEADER.to_string();
    if let Some(l) = leader {
        match parse_keys(l, DEFAULT_LEADER) {
            Ok(_) => notation = l.to_string(),
            Err(_) => warnings.push(format!("config: leader '{l}' is not a key")),
        }
    }
    let mut keymap = Keymap::new(&notation);
    for (mode, lhs, rhs) in keys {
        if let Err(e) = keymap.set(*mode, lhs, rhs) {
            warnings.push(format!("config [keys.{}] \"{lhs}\": {e}", mode.name()));
        }
    }
    (keymap, warnings)
}

// ---------------------------------------------------------------------------
// Sequencer: key presses into bindings, with vim's timeout
// ---------------------------------------------------------------------------

/// What to do after a key: run a binding (None: the keys matched nothing, so
/// they type themselves or do nothing), then feed some keys again.
#[derive(Debug, Default)]
pub struct Step {
    pub run: Vec<(Option<Binding>, Vec<String>)>,
    pub refeed: Vec<String>,
}

#[derive(Default)]
pub struct Sequencer {
    pub pending: Vec<String>,
    deadline: Option<Instant>,
}

impl Sequencer {
    pub fn feed(&mut self, keymap: &Keymap, mode: KeyMode, key: String, timeoutlen: Duration) -> Step {
        self.deadline = None;
        // Esc while waiting on a prefix: drop it, like which-key
        if key == "<Esc>" && !self.pending.is_empty() && keymap.lookup(mode, &self.pending, false).exact.is_none() {
            self.pending.clear();
            return Step::default();
        }
        self.pending.push(key);
        let r = keymap.lookup(mode, &self.pending, false);
        if r.prefix {
            self.deadline = Some(Instant::now() + timeoutlen);
            return Step::default();
        }
        let keys = std::mem::take(&mut self.pending);
        match r.exact {
            Some(b) => Step { run: vec![(Some(b), keys)], refeed: vec![] },
            None => resolve_unmatched(keymap, mode, keys),
        }
    }

    /// Called often (each frame): when the wait runs out, use the shorter mapping (or the keys themselves).
    pub fn tick(&mut self, keymap: &Keymap, mode: KeyMode) -> Step {
        match self.deadline {
            Some(d) if Instant::now() >= d => {}
            _ => return Step::default(),
        }
        self.deadline = None;
        let keys = std::mem::take(&mut self.pending);
        match keymap.lookup(mode, &keys, false).exact {
            Some(b) => Step { run: vec![(Some(b), keys)], refeed: vec![] },
            None => resolve_unmatched(keymap, mode, keys),
        }
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.deadline = None;
    }

    /// A which-key hint is showing: wait for the next key, however long.
    pub fn hold(&mut self) {
        self.deadline = None;
    }
}

/// The keys matched nothing; the first of them may still be a shorter mapping
/// (`g` mapped, then `gx` typed): run the longest that matches and feed the rest.
fn resolve_unmatched(keymap: &Keymap, mode: KeyMode, keys: Vec<String>) -> Step {
    if keys.len() == 1 {
        return Step { run: vec![(None, keys)], refeed: vec![] };
    }
    for n in (1..keys.len()).rev() {
        if let Some(b) = keymap.lookup(mode, &keys[..n], false).exact {
            return Step { run: vec![(Some(b), keys[..n].to_vec())], refeed: keys[n..].to_vec() };
        }
    }
    Step { run: vec![(None, vec![keys[0].clone()])], refeed: keys[1..].to_vec() }
}

/// One step of replaying keys through the built-in keymap only (non-recursive,
/// like noremap), for mappings whose right-hand side is other keys: the
/// longest built-in mapping at the start of `keys` (None: the first key alone),
/// and how many keys it took. The caller reads the mode again before each step.
pub fn replay_next(keymap: &Keymap, mode: KeyMode, keys: &[String]) -> (Option<Binding>, usize) {
    for n in (1..=keys.len()).rev() {
        if let Some(b) = keymap.lookup(mode, &keys[..n], true).exact {
            return (Some(b), n);
        }
    }
    (None, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(s: &str) -> Vec<String> {
        parse_keys(s, DEFAULT_LEADER).unwrap()
    }

    #[test]
    fn notation_is_canonical() {
        assert_eq!(keys("gg"), ["g", "g"]);
        assert_eq!(keys("<c-D>"), ["<C-d>"]);
        assert_eq!(keys("<leader>t"), ["<Space>", "t"]);
        assert_eq!(keys("<S-tab>"), ["<S-Tab>"]);
        assert_eq!(keys("<S-x>"), ["X"]);
        assert_eq!(keys("<M-G>"), ["<M-S-g>"]);
        assert_eq!(keys("<C-w><lt>"), ["<C-w>", "<lt>"]);
        assert_eq!(keys("a<b"), ["a", "<lt>", "b"]);
        assert_eq!(keys("<Enter>"), ["<CR>"]);
        assert_eq!(parse_keys("<leader>x", ",").unwrap(), [",", "x"]);
        assert!(parse_keys("", DEFAULT_LEADER).is_err());
    }

    #[test]
    fn right_hand_sides() {
        let s = |v: &str| parse_rhs(&RhsValue::Str(v.into()), DEFAULT_LEADER);
        assert_eq!(s(":new ").unwrap(), [Rhs::Ex { cmd: "new ".into(), execute: false }]);
        assert_eq!(s(":kill<CR>").unwrap(), [Rhs::Ex { cmd: "kill".into(), execute: true }]);
        assert_eq!(s("session.goto 3").unwrap(), [Rhs::Action { name: "session.goto".into(), arg: Some("3".into()) }]);
        assert_eq!(s("gg").unwrap(), [Rhs::Keys(vec!["g".into(), "g".into()])]);
        assert!(s("session.nxt").unwrap_err().contains("did you mean 'session.next'"));
        assert_eq!(parse_rhs(&RhsValue::Bool(false), DEFAULT_LEADER).unwrap(), [Rhs::Nop]);
    }

    #[test]
    fn prefixes_wait_and_time_out() {
        let km = Keymap::default();
        let mut seq = Sequencer::default();
        let t = Duration::from_millis(0);
        assert!(seq.feed(&km, KeyMode::Normal, "g".into(), Duration::from_secs(5)).run.is_empty());
        let step = seq.feed(&km, KeyMode::Normal, "g".into(), t);
        assert!(matches!(&step.run[0].0, Some(b) if b.rhs == [Rhs::Action { name: "scroll.top".into(), arg: None }]));
        // ]x: ] waits, then neither matches: ] does nothing, x is fed again
        seq.feed(&km, KeyMode::Normal, "]".into(), t);
        let step = seq.feed(&km, KeyMode::Normal, "x".into(), t);
        assert!(step.run[0].0.is_none() && step.refeed == ["x"]);
        // a lone prefix, after timeoutlen
        seq.feed(&km, KeyMode::Normal, "<Space>".into(), t);
        let step = seq.tick(&km, KeyMode::Normal);
        assert_eq!(step.run.len(), 1);
        assert!(step.run[0].0.is_none());
    }

    #[test]
    fn user_mappings_and_leader() {
        let (km, warnings) = build_keymap(Some(","), &[(KeyMode::Normal, "<leader>x".into(), RhsValue::Str(":kill<CR>".into())), (KeyMode::Insert, "jk".into(), RhsValue::Str("<Esc>".into())), (KeyMode::Normal, "Q".into(), RhsValue::Str("bogus.action".into()))]);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(km.lookup(KeyMode::Normal, &[",".into(), "x".into()], false).exact.is_some());
        assert!(km.lookup(KeyMode::Insert, &["j".into()], false).prefix);
        assert!(km.lookup(KeyMode::Normal, &[",".into(), "1".into()], false).exact.is_some(), "<leader>1 follows the leader");
    }

    #[test]
    fn key_events_become_tokens() {
        let k = |code, m| token_from_event(&KeyEvent::new(code, m)).unwrap();
        assert_eq!(k(KeyCode::Char('d'), KeyModifiers::CONTROL), "<C-d>");
        assert_eq!(k(KeyCode::Char('G'), KeyModifiers::SHIFT), "G");
        assert_eq!(k(KeyCode::Char(' '), KeyModifiers::NONE), "<Space>");
        assert_eq!(k(KeyCode::BackTab, KeyModifiers::SHIFT), "<S-Tab>");
        assert_eq!(k(KeyCode::Enter, KeyModifiers::NONE), "<CR>");
        assert_eq!(k(KeyCode::Char('<'), KeyModifiers::NONE), "<lt>");
        assert_eq!(k(KeyCode::Char(':'), KeyModifiers::SHIFT), ":");
    }
}
