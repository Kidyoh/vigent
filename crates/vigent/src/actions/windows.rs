//! Windows area actions and key handling (src/app.ts handleInput, runAction):
//! splits and window keys, the sidebar's focus, scrolling, search, VISUAL,
//! folds, marks and jumps, yanking, counts, the line editor (cursor, words,
//! history, <C-f> NORMAL mode, completion), the @ file picker, y/n questions,
//! which-key and the start screen's one-key actions.

use crossterm::event::KeyEvent;
use std::time::Instant;

use super::Action;
use crate::app::{App, Mode};
use crate::keys::{self, Rhs};
use crate::line_edit::{LineBuffer, LineEditor, LineExit, remember};
use crate::search::{Hit, find_hits, next_hit};
use crate::session::{Item, State};
use crate::ui::pane::{self, PaneLine};
use crate::ui::picker::{self, Choice, Outcome, Picker, Place};
use crate::windows::{Confirm, Dir, SearchFrom, Side, Wild};

pub static ACTIONS: &[Action] = &[
    Action { name: "mode.normal", run: mode_normal },
    Action { name: "mode.insert_start", run: |a, _| insert_at(a, "home") },
    Action { name: "mode.append_end", run: |a, _| insert_at(a, "end") },
    Action { name: "mode.search", run: |a, _| start_search(a, false) },
    Action { name: "mode.search_back", run: |a, _| start_search(a, true) },
    Action { name: "mode.visual", run: mode_visual },
    Action { name: "cursor.down", run: |a, _| move_cursor(a, 1) },
    Action { name: "cursor.up", run: |a, _| move_cursor(a, -1) },
    Action { name: "cursor.half_down", run: |a, _| move_cursor(a, half(a)) },
    Action { name: "cursor.half_up", run: |a, _| move_cursor(a, -half(a)) },
    Action { name: "cursor.page_down", run: |a, _| move_cursor(a, page(a)) },
    Action { name: "cursor.page_up", run: |a, _| move_cursor(a, -page(a)) },
    Action { name: "cursor.screen_top", run: |a, _| screen_cursor(a, 0) },
    Action { name: "cursor.screen_middle", run: |a, _| screen_cursor(a, 1) },
    Action { name: "cursor.screen_bottom", run: |a, _| screen_cursor(a, 2) },
    Action { name: "cursor.top", run: |a, _| move_cursor(a, -(i32::MAX as isize)) },
    Action { name: "cursor.bottom", run: |a, _| move_cursor(a, i32::MAX as isize) },
    Action { name: "visual.swap", run: visual_swap },
    Action { name: "visual.inner_block", run: visual_inner_block },
    Action { name: "visual.reselect", run: visual_reselect },
    Action { name: "visual.yank", run: visual_yank },
    Action { name: "view.center", run: |a, _| view_place(a, "center") },
    Action { name: "view.top", run: |a, _| view_place(a, "top") },
    Action { name: "view.bottom", run: |a, _| view_place(a, "bottom") },
    Action { name: "jump.back", run: |a, _| jump_by(a, -1) },
    Action { name: "jump.forward", run: |a, _| jump_by(a, 1) },
    Action { name: "app.position", run: app_position },
    Action { name: "message.next", run: |a, _| jump_message(a, 1) },
    Action { name: "message.prev", run: |a, _| jump_message(a, -1) },
    Action { name: "yank.reply", run: yank_reply },
    Action { name: "yank.block", run: yank_block },
    Action { name: "scroll.down", run: |a, _| scroll_by(a, -1) },
    Action { name: "scroll.up", run: |a, _| scroll_by(a, 1) },
    Action { name: "scroll.half_down", run: |a, _| scroll_by(a, -half(a)) },
    Action { name: "scroll.half_up", run: |a, _| scroll_by(a, half(a)) },
    Action { name: "scroll.page_down", run: |a, _| scroll_by(a, -page(a)) },
    Action { name: "scroll.page_up", run: |a, _| scroll_by(a, page(a)) },
    Action { name: "scroll.top", run: scroll_top_action },
    Action { name: "scroll.bottom", run: scroll_bottom_action },
    Action { name: "session.alternate", run: |a, _| {
        let alt = a.windows.alt;
        focus_session(a, alt);
    } },
    Action { name: "sidebar.focus", run: |a, _| toggle_sidebar_focus(a) },
    Action { name: "window.down", run: |a, _| go_window(a, Side::Down) },
    Action { name: "window.up", run: |a, _| go_window(a, Side::Up) },
    Action { name: "window.next", run: |a, _| cycle_window(a, 1) },
    Action { name: "window.prev", run: |a, _| cycle_window(a, -1) },
    Action { name: "window.last", run: |a, _| {
        if let Some(p) = a.windows.layout.prev {
            enter_window(a, p);
        }
    } },
    Action { name: "window.top", run: |a, _| {
        let w = a.windows.layout.all()[0];
        enter_window(a, w);
    } },
    Action { name: "window.bottom", run: |a, _| {
        let w = *a.windows.layout.all().last().unwrap();
        enter_window(a, w);
    } },
    Action { name: "window.vsplit", run: |a, _| split_window(a, Dir::Row, "") },
    Action { name: "window.split", run: |a, _| split_window(a, Dir::Column, "") },
    Action { name: "window.close", run: |a, _| close_window(a) },
    Action { name: "window.quit", run: |a, _| crate::commands::exec(a, "q") },
    Action { name: "window.only", run: |a, _| a.windows.layout.only() },
    Action { name: "window.equal", run: |a, _| a.windows.layout.equalize() },
    Action { name: "window.wider", run: |a, _| resize(a, Dir::Row, 1) },
    Action { name: "window.narrower", run: |a, _| resize(a, Dir::Row, -1) },
    Action { name: "window.taller", run: |a, _| resize(a, Dir::Column, 1) },
    Action { name: "window.shorter", run: |a, _| resize(a, Dir::Column, -1) },
    Action { name: "window.max_width", run: |a, _| a.windows.layout.maximize(Dir::Row) },
    Action { name: "window.max_height", run: |a, _| a.windows.layout.maximize(Dir::Column) },
    Action { name: "window.exchange", run: |a, _| exchange_window(a) },
    Action { name: "window.rotate", run: |a, _| a.windows.layout.rotate() },
    Action { name: "window.left", run: |a, _| window_side(a, true) },
    Action { name: "window.right", run: |a, _| window_side(a, false) },
    Action { name: "fold.toggle", run: fold_toggle },
    Action { name: "fold.open_all", run: |a, _| set_all_folds(a, false) },
    Action { name: "fold.close_all", run: |a, _| set_all_folds(a, true) },
    Action { name: "search.next", run: |a, _| goto_match(a, 1) },
    Action { name: "search.prev", run: |a, _| goto_match(a, -1) },
    Action { name: "search.clear", run: |a, _| clear_search(a) },
    Action { name: "edit.submit", run: |a, _| submit(a) },
    Action { name: "edit.backspace", run: backspace },
    Action { name: "edit.delete_word", run: |a, _| edit_line(a, |b| b.delete_word_back()) },
    Action { name: "edit.clear", run: |a, _| edit_line(a, |b| b.delete_to_start()) },
    Action { name: "edit.delete", run: |a, _| edit_line(a, |b| b.delete_forward()) },
    Action { name: "edit.left", run: |a, _| edit_line(a, |b| b.move_to("left")) },
    Action { name: "edit.right", run: |a, _| edit_line(a, |b| b.move_to("right")) },
    Action { name: "edit.home", run: |a, _| edit_line(a, |b| b.move_to("home")) },
    Action { name: "edit.end", run: |a, _| edit_line(a, |b| b.move_to("end")) },
    Action { name: "edit.word_left", run: |a, _| edit_line(a, |b| b.move_to("word_left")) },
    Action { name: "edit.word_right", run: |a, _| edit_line(a, |b| b.move_to("word_right")) },
    Action { name: "edit.history_prev", run: |a, _| history_step(a, -1) },
    Action { name: "edit.history_next", run: |a, _| history_step(a, 1) },
    Action { name: "edit.paste", run: |a, _| {
        let reg = a.windows.line_register.clone();
        edit_line(a, |b| b.insert(&reg));
    } },
    Action { name: "edit.normal", run: edit_normal },
    Action { name: "edit.complete", run: |a, _| complete(a, 1) },
    Action { name: "edit.complete_prev", run: |a, _| complete(a, -1) },
    Action { name: "app.dashboard", run: |a, _| open_dashboard(a) },
    Action { name: "app.redraw", run: |a, _| a.windows.redraw = true },
];

/// What a count repeats (5j, 3]s, 2n).
const REPEATABLE: &[&str] = &[
    "scroll.down", "scroll.up", "scroll.half_down", "scroll.half_up", "scroll.page_down", "scroll.page_up", "cursor.down", "cursor.up", "cursor.half_down", "cursor.half_up", "cursor.page_down",
    "cursor.page_up", "session.next", "session.prev", "message.next", "message.prev", "search.next", "search.prev", "window.wider", "window.narrower", "window.taller", "window.shorter",
];

/// :wincmd {key}: what <C-w>{key} does.
pub fn wincmd(key: &str) -> Option<&'static str> {
    Some(match key {
        "h" => "window.left",
        "j" => "window.down",
        "k" => "window.up",
        "l" => "window.right",
        "w" => "window.next",
        "W" => "window.prev",
        "p" => "window.last",
        "t" => "window.top",
        "b" => "window.bottom",
        "v" => "window.vsplit",
        "s" => "window.split",
        "c" => "window.close",
        "q" => "window.quit",
        "o" => "window.only",
        "=" => "window.equal",
        ">" => "window.wider",
        "<" => "window.narrower",
        "+" => "window.taller",
        "-" => "window.shorter",
        "|" => "window.max_width",
        "_" => "window.max_height",
        "x" => "window.exchange",
        "r" => "window.rotate",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/// Every key goes here first (App::key). False: the App handles it (a float).
pub fn key(app: &mut App, k: &KeyEvent) -> bool {
    if app.windows.picker.is_some() {
        if let Some(t) = keys::token_from_event(k) {
            picker_key(app, &t);
        }
        return true;
    }
    if app.float.is_some() {
        return false;
    }
    if let Some(c) = app.windows.confirm.take() {
        app.message = (String::new(), "Comment");
        let yes = matches!(keys::token_from_event(k).as_deref(), Some("y" | "Y"));
        if yes {
            (c.on_yes)(app);
        } else if let Some(no) = c.on_no {
            no(app);
        }
        return true;
    }
    let Some(token) = keys::token_from_event(k) else { return true };
    if dashboard_key(app, &token) {
        return true;
    }
    if app.windows.sidebar_focused && sidebar_key(app, &token) {
        return true;
    }
    if app.windows.line_normal(app.mode) {
        line_key(app, &token);
        after_key(app);
        return true;
    }
    if mark_key(app, &token) || count_digit(app, &token) {
        return true;
    }
    if app.mode == Mode::Normal && app.seq.pending.is_empty() {
        app.message = (String::new(), "Comment");
    }
    for t in split_escape(app, token) {
        app.feed(t);
    }
    after_key(app);
    true
}

/// After keys: the search as typed (incsearch), and when the which-key hint is due.
fn after_key(app: &mut App) {
    if app.mode == Mode::Search && app.cmd != app.windows.search_preview {
        preview_search(app);
    }
    note_pending(app);
}

/// Keys waiting for more: when the which-key panel shows.
fn note_pending(app: &mut App) {
    let w = &mut app.windows;
    if app.seq.pending.is_empty() {
        w.hint_at = None;
        w.holding = false;
        return;
    }
    if w.hint_at.is_none() && !w.holding {
        let r = app.keymap.lookup(app.mode.keys(), &app.seq.pending, false);
        if r.exact.is_none() && r.prefix {
            let delay = 300u64.min(app.config.ui.timeoutlen.saturating_sub(50));
            w.hint_at = Some(Instant::now() + std::time::Duration::from_millis(delay));
        }
    }
}

/// Every frame (App::tick): the which-key panel, once its delay is over, holds the keys however long.
pub fn tick(app: &mut App) {
    if let Some(at) = app.windows.hint_at
        && Instant::now() >= at
    {
        app.windows.hint_at = None;
        if !app.seq.pending.is_empty() && app.config.ui.whichkey {
            app.windows.holding = true;
        }
    }
    if app.windows.holding {
        if app.seq.pending.is_empty() {
            app.windows.holding = false;
        } else {
            app.seq.hold();
        }
    }
    if !app.windows.commands_loaded {
        app.windows.commands_loaded = true;
        app.windows.commands = app.config.commands.clone();
    }
}

/// The which-key panel is up.
pub fn which_key_waiting(app: &App) -> bool {
    app.windows.holding && !app.seq.pending.is_empty()
}

/// Esc quickly followed by a key arrives as one Alt-key (<M-j>): when nothing is mapped to it, it's Esc and then the key.
fn split_escape(app: &App, key: String) -> Vec<String> {
    let Some(inner) = key.strip_prefix("<M-").and_then(|k| k.strip_suffix('>')) else { return vec![key] };
    let mut probe = app.seq.pending.clone();
    probe.push(key.clone());
    let r = app.keymap.lookup(app.mode.keys(), &probe, false);
    if r.exact.is_some() || r.prefix {
        return vec![key];
    }
    let mut out = vec!["<Esc>".to_string()];
    let rest = inner.strip_prefix("S-").map(|c| c.to_uppercase()).unwrap_or_else(|| inner.to_string());
    if rest.chars().count() == 1 {
        out.push(if rest == " " { "<Space>".into() } else { rest });
    } else {
        out.push(format!("<{rest}>"));
    }
    out
}

/// The start screen's one-key actions, while no agent is open (src/app.ts dashboardKey).
pub fn dashboard_key(app: &mut App, token: &str) -> bool {
    if !app.open().is_empty() || app.mode != Mode::Normal || !app.seq.pending.is_empty() {
        return false;
    }
    match token {
        "n" => {
            app.mode = Mode::Command;
            app.cmd = "new ".into();
        }
        "t" => crate::actions::run(app, "theme.picker", None),
        "s" => crate::commands::exec(app, "settings"),
        "m" => crate::commands::exec(app, "model"),
        "e" => crate::commands::exec(app, "effort"),
        "E" => crate::commands::exec(app, "engine"),
        "c" => crate::commands::exec(app, "checkhealth"),
        "T" => crate::commands::exec(app, "templates"),
        "?" => crate::help::open(app),
        "q" => crate::commands::exec(app, "q"),
        _ => return false,
    }
    true
}

/// A digit that starts or extends a count. A mapping of your own on that digit wins.
fn count_digit(app: &mut App, key: &str) -> bool {
    if !matches!(app.mode, Mode::Normal | Mode::Visual) || !app.seq.pending.is_empty() || key.len() != 1 || !key.as_bytes()[0].is_ascii_digit() {
        return false;
    }
    if key == "0" && app.windows.pending_count == 0 {
        return false;
    }
    let r = app.keymap.lookup(app.mode.keys(), &[key.to_string()], false);
    if r.exact.is_some() || r.prefix {
        return false;
    }
    let w = &mut app.windows;
    w.pending_count = (w.pending_count * 10 + (key.as_bytes()[0] - b'0') as usize).min(9999);
    let n = w.pending_count;
    app.say(n.to_string(), "Comment");
    true
}

/// A built-in action with a count (App::run_binding): how vim reads one.
pub fn run_counted(app: &mut App, name: &str, arg: Option<&str>, count: usize) {
    match name {
        "scroll.top" | "scroll.bottom" => {
            if app.mode == Mode::Normal {
                record_jump(app, None);
            }
            return scroll_to_line(app, count - 1);
        }
        "cursor.top" | "cursor.bottom" => {
            let total = pane::current(app).len();
            app.windows.visual.1 = (count - 1).min(total.saturating_sub(1));
            let c = app.windows.visual.1;
            return reveal_line(app, c);
        }
        "session.tab" => {
            let n = app.open().len();
            return app.focus_agent(count.min(n).saturating_sub(1));
        }
        "window.next" => {
            let wins = app.windows.layout.all();
            let w = wins[count.min(wins.len()) - 1];
            return enter_window(app, w);
        }
        _ => {}
    }
    let times = if REPEATABLE.contains(&name) { count } else { 1 };
    for _ in 0..times {
        crate::actions::run(app, name, arg);
    }
}

/// The count typed before a binding, taken (0: none).
pub fn take_count(app: &mut App) -> usize {
    std::mem::take(&mut app.windows.pending_count)
}

/// Is this binding a single built-in action (for counts)?
pub fn single_action(rhs: &[Rhs]) -> Option<(String, Option<String>)> {
    match rhs {
        [Rhs::Action { name, arg }] => Some((name.clone(), arg.clone())),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// typing: the prompt and the : / line, with a cursor
// ---------------------------------------------------------------------------

/// The line being typed in this mode: the prompt (true) or the : / line (false), or none.
fn active(app: &App) -> Option<bool> {
    match app.mode {
        Mode::Insert => Some(true),
        Mode::Command | Mode::Search => Some(false),
        _ => None,
    }
}

/// Change the active line through its buffer.
pub fn edit_line(app: &mut App, f: impl FnOnce(&mut LineBuffer)) {
    let Some(input) = active(app) else { return };
    with_line(app, input, f);
}

fn with_line(app: &mut App, input: bool, f: impl FnOnce(&mut LineBuffer)) {
    let (cursor, text) = if input { (&mut app.windows.input_cursor, &mut app.input) } else { (&mut app.windows.cmd_cursor, &mut app.cmd) };
    let mut b = cursor.buffer(text);
    f(&mut b);
    *text = cursor.store(&b);
}

/// Text typed (unmapped keys, App::type_text): in at the cursor; `@` at a word's start in a prompt opens the file picker.
pub fn type_text(app: &mut App, text: &str) {
    if app.mode == Mode::Insert && text == "@" {
        let before = LineBuffer::new(&app.input, crate::ui::statusline::cursor_pos(app, true)).parts().0;
        if before.is_empty() || before.ends_with(char::is_whitespace) {
            with_line(app, true, |b| b.insert("@"));
            open_attach(app);
            return;
        }
    }
    edit_line(app, |b| b.insert(text));
}

/// Bracketed paste: text, never mappings; newlines become spaces.
pub fn paste(app: &mut App, text: &str) {
    let t = text.replace("\r\n", " ").replace('\n', " ");
    edit_line(app, |b| b.insert(&t));
    if app.mode == Mode::Search {
        preview_search(app);
    }
}

fn mode_normal(app: &mut App, _: Option<&str>) {
    if app.mode == Mode::Visual
        && let Some(s) = app.focused().map(|s| s.slot)
    {
        let v = app.windows.visual;
        app.windows.last_visual.insert(s, v);
    }
    if app.mode == Mode::Search {
        cancel_search(app);
    }
    if matches!(app.mode, Mode::Command | Mode::Search) {
        app.cmd.clear();
    }
    app.mode = Mode::Normal;
}

fn insert_at(app: &mut App, to: &str) {
    if app.focused().is_none()
        && let Some(why) = app.cant_start()
    {
        return app.say(why, "ErrorMsg");
    }
    app.mode = Mode::Insert;
    with_line(app, true, |b| b.move_to(to));
}

fn backspace(app: &mut App, _: Option<&str>) {
    if app.mode == Mode::Insert {
        with_line(app, true, |b| {
            b.backspace();
        });
    } else if app.cmd.is_empty() {
        if app.mode == Mode::Search {
            cancel_search(app);
        }
        app.mode = Mode::Normal; // vim: backspace on an empty command line leaves it
    } else {
        with_line(app, false, |b| {
            b.backspace();
        });
    }
}

/// <C-f>: edit the line in vim's NORMAL mode.
fn edit_normal(app: &mut App, _: Option<&str>) {
    let Some(input) = active(app) else { return };
    let pos = crate::ui::statusline::cursor_pos(app, input);
    let text = if input { app.input.clone() } else { app.cmd.clone() };
    let ed = if input { &mut app.windows.input_editor } else { &mut app.windows.cmd_editor };
    // vim: leaving INSERT steps back onto the last character typed
    ed.sync(&text, pos.saturating_sub(1));
    let p = ed.pos;
    with_line(app, input, |b| b.pos = p);
    app.windows.line_normal_in = Some(app.mode);
}

/// One key in the line's NORMAL mode (after <C-f>).
fn line_key(app: &mut App, key: &str) {
    let Some(input) = active(app) else { return };
    let reg = app.windows.line_register.clone();
    let ed = if input { &mut app.windows.input_editor } else { &mut app.windows.cmd_editor };
    ed.register = reg;
    let r = ed.feed(key);
    let (text, pos, reg) = (ed.text(), ed.pos, ed.register.clone());
    app.windows.line_register = reg;
    with_line(app, input, |b| {
        b.chars = text.chars().collect();
        b.pos = pos.min(b.chars.len());
    });
    if let Some(dir) = r.history {
        history_step(app, dir);
        let text = if input { app.input.clone() } else { app.cmd.clone() };
        let ed = if input { &mut app.windows.input_editor } else { &mut app.windows.cmd_editor };
        ed.sync(&text, text.chars().count().saturating_sub(1));
        let p = ed.pos;
        with_line(app, input, |b| b.pos = p);
    }
    if r.exit.is_some() {
        app.windows.line_normal_in = None;
    }
    if r.exit == Some(LineExit::Submit) {
        submit(app);
    }
}

/// <Up> / <Down>: an earlier line, from this agent's prompts or this run's commands or searches.
fn history_step(app: &mut App, dir: i32) {
    let Some(input) = active(app) else { return };
    let current = if input { app.input.clone() } else { app.cmd.clone() };
    let next = match app.mode {
        Mode::Insert => {
            // a prompt waiting in the queue is the newest one sent
            let entries: Vec<String> = app
                .focused()
                .map(|s| s.items.iter().filter_map(|i| if let Item::User(t) = i { Some(t.clone()) } else { None }).chain(s.queue.iter().cloned()).collect())
                .unwrap_or_default();
            app.windows.walk_prompt.step(&entries, &current, dir)
        }
        Mode::Search => {
            let e = app.windows.search_history.clone();
            app.windows.walk_search.step(&e, &current, dir)
        }
        _ => {
            let e = app.windows.cmd_history.clone();
            app.windows.walk_command.step(&e, &current, dir)
        }
    };
    if let Some(n) = next {
        with_line(app, input, |b| b.set(&n));
    }
}

/// Enter: send the prompt, run the command, or search.
pub fn submit(app: &mut App) {
    app.windows.line_normal_in = None;
    match app.mode {
        Mode::Insert => {
            app.windows.input_editor = LineEditor::default();
            app.submit();
        }
        Mode::Command => {
            let cmd = std::mem::take(&mut app.cmd);
            app.windows.cmd_editor = LineEditor::default();
            app.windows.wild = None;
            app.mode = Mode::Normal;
            remember(&mut app.windows.cmd_history, &cmd);
            crate::commands::exec(app, &cmd);
        }
        Mode::Search => {
            let query = std::mem::take(&mut app.cmd);
            app.windows.cmd_editor = LineEditor::default();
            app.mode = Mode::Normal;
            remember(&mut app.windows.search_history, &query);
            if let Some(from) = app.windows.search_from.clone() {
                let total = pane::current(app).len();
                let h = pane::content_height(pane::window_rect(app));
                record_jump(app, Some(total.saturating_sub(h + from.scroll)));
            }
            run_search(app, &query);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

fn sources(app: &App) -> crate::completion::Sources {
    let ready: Vec<String> = app.engines.infos.iter().filter(|e| e.connected).map(|e| e.id.clone()).collect();
    crate::completion::Sources {
        agents: app.open().iter().map(|&i| app.sessions[i].name.clone()).collect(),
        themes: crate::theme::names().into_iter().map(String::from).collect(),
        engines: if ready.is_empty() { crate::engines::KNOWN.iter().map(|e| e.id.to_string()).collect() } else { ready },
        models: vec![],
    }
}

/// <Tab> / <S-Tab> on the command line: complete what's before the cursor, then go through what fits.
fn complete(app: &mut App, dir: i32) {
    if app.mode != Mode::Command {
        return;
    }
    let reuse = app.windows.wild.as_ref().is_some_and(|w| w.shown == app.cmd);
    if !reuse {
        let b = LineBuffer::new(&app.cmd, crate::ui::statusline::cursor_pos(app, false));
        let (before, under, rest) = b.parts();
        let after = if b.pos < b.chars.len() { format!("{under}{rest}") } else { String::new() };
        let (base, items) = crate::completion::complete_command_line(&before, &sources(app));
        if items.is_empty() {
            app.windows.wild = None;
            return;
        }
        let idx = if dir > 0 { 0 } else { items.len() - 1 };
        app.windows.wild = Some(Wild { base, items, idx, typed: before, after, shown: String::new() });
    } else if let Some(w) = app.windows.wild.as_mut() {
        // past the last one is what was typed, as in vim
        let stops = w.items.len() as isize + 1;
        w.idx = ((w.idx as isize + dir as isize).rem_euclid(stops)) as usize;
    }
    let w = app.windows.wild.clone().unwrap();
    let text = if w.idx < w.items.len() { format!("{}{}", w.base, w.items[w.idx]) } else { w.typed.clone() };
    let n = text.chars().count();
    with_line(app, false, |b| {
        b.set(&format!("{text}{}", w.after));
        b.pos = n;
    });
    let shown = app.cmd.clone();
    if let Some(wl) = app.windows.wild.as_mut() {
        wl.shown = shown;
    }
}

/// What fits the command line as it's typed, before any <Tab>: every match, and the rest of the first one.
pub fn completion_as_typed(app: &App) -> Option<(Vec<String>, String)> {
    if app.mode != Mode::Command || app.windows.line_normal(app.mode) || app.cmd.trim().is_empty() || crate::ui::statusline::cursor_pos(app, false) < app.cmd.chars().count() {
        return None;
    }
    if app.windows.wild.as_ref().is_some_and(|w| w.shown == app.cmd) {
        return None;
    }
    let (base, items) = crate::completion::complete_command_line(&app.cmd, &sources(app));
    let typed = &app.cmd[base.len().min(app.cmd.len())..];
    let rest = match items.first() {
        Some(f) if f.to_lowercase().starts_with(&typed.to_lowercase()) => f.chars().skip(typed.chars().count()).collect(),
        _ => String::new(),
    };
    if items.is_empty() { None } else { Some((items, rest)) }
}

// ---------------------------------------------------------------------------
// the @ file picker, pickers and questions
// ---------------------------------------------------------------------------

/// A picker on screen; Enter (or Esc) calls `done`.
pub fn open_picker(app: &mut App, p: Picker) {
    app.seq.reset();
    app.windows.picker = Some(p);
}

fn picker_key(app: &mut App, token: &str) {
    let Some(p) = app.windows.picker.as_mut() else { return };
    match picker::feed(p, token) {
        Outcome::Stay => {}
        Outcome::Done(v) => {
            let mut p = app.windows.picker.take().unwrap();
            if let Some(done) = p.done.take() {
                done(app, v);
            }
        }
        Outcome::BackOut => {
            let mut p = app.windows.picker.take().unwrap();
            if let Some(b) = p.back_out.take() {
                b(app);
            }
        }
    }
}

/// Ask a y/n question on the command line, like vim's confirm prompts.
pub fn ask(app: &mut App, question: &str, on_yes: Box<dyn FnOnce(&mut App)>, on_no: Option<Box<dyn FnOnce(&mut App)>>) {
    app.seq.reset();
    // a newer question replaces an unanswered one: that one is a no
    if let Some(old) = app.windows.confirm.take()
        && let Some(no) = old.on_no
    {
        no(app);
    }
    app.windows.confirm = Some(Confirm { question: question.into(), on_yes, on_no });
}

/// Where `@` attaches files from: the agent's folder, else the repository, else here.
pub fn attach_dir(app: &App) -> std::path::PathBuf {
    match app.focused() {
        Some(s) => s.path.clone(),
        None => app.root.clone().unwrap_or_else(|| app.cwd.clone()),
    }
}

/// `@` in a prompt: pick a file. Enter writes `@path `, Esc keeps a plain `@`, Backspace takes the `@` back.
pub fn open_attach(app: &mut App) {
    let dir = attach_dir(app);
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let take_back = |app: &mut App| {
        let before = LineBuffer::new(&app.input, crate::ui::statusline::cursor_pos(app, true)).parts().0;
        if before.ends_with('@') {
            with_line(app, true, |b| {
                b.backspace();
            });
        }
    };
    let mut p = Picker::new(
        &format!("Attach a file · {name}"),
        None,
        None,
        false,
        Box::new(move |app, v| {
            if let Some(v) = v {
                take_back(app);
                with_line(app, true, |b| b.insert(&format!("@{v} ")));
            }
        }),
    );
    p.searching = true;
    p.rows = 8;
    p.back_out = Some(Box::new(take_back));
    let col = if app.config.ui.sidebar_position == "right" { 0 } else { pane::sidebar_width(app, app.windows.cols) } + 2;
    p.place = Place::BottomLeft { col, offset_y: -2, width: 64.min(app.windows.cols.saturating_sub(2)) };
    open_picker(app, p);
    let tx = app.tx.clone();
    std::thread::spawn(move || {
        let files: Vec<Choice> = crate::attach::list_files(&dir).into_iter().filter(|f| crate::attach::mentionable(f)).map(Choice::new).collect();
        let _ = tx.send(crate::app::Msg::Run(Box::new(move |app: &mut App| {
            if let Some(p) = app.windows.picker.as_mut()
                && p.items.is_none()
            {
                p.set_items(files);
            }
        })));
    });
}

// ---------------------------------------------------------------------------
// the sidebar's focus
// ---------------------------------------------------------------------------

/// <leader>e, like neo-tree: the cursor into the SESSIONS sidebar, or back.
pub fn toggle_sidebar_focus(app: &mut App) {
    if app.windows.sidebar_focused {
        return leave_sidebar(app);
    }
    if app.open().is_empty() {
        return app.say("no agents yet (i or :new starts one)", "Comment");
    }
    if pane::sidebar_width(app, app.windows.cols) == 0 {
        return open_dashboard(app);
    }
    app.mode = Mode::Normal;
    app.windows.sidebar_focused = true;
    app.windows.sidebar_pending.clear();
    sidebar_hint(app);
}

fn leave_sidebar(app: &mut App) {
    app.windows.sidebar_focused = false;
    app.windows.sidebar_pending.clear();
    app.message = (String::new(), "Comment");
}

fn sidebar_hint(app: &mut App) {
    let open = app.open();
    let at = open.iter().position(|&i| i == app.focus);
    let who = match (at, app.focused()) {
        (Some(n), Some(s)) => format!("{} {} · ", n + 1, s.name),
        _ => String::new(),
    };
    app.say(format!("-- SESSIONS -- {who}j/k move · Enter open · a new · dd kill · Esc back"), "ModeMsg");
}

/// A key while the sidebar has the cursor. Keys it doesn't use go back to the transcript and run there.
fn sidebar_key(app: &mut App, key: &str) -> bool {
    let n = app.open().len();
    let pending = std::mem::take(&mut app.windows.sidebar_pending);
    let at = app.open().iter().position(|&i| i == app.focus).unwrap_or(0) as isize;
    let go = |app: &mut App, i: isize| {
        if n == 0 {
            return;
        }
        app.focus_agent(i.clamp(0, n as isize - 1) as usize);
        sidebar_hint(app);
    };
    let leader = app.keymap.leader.clone();
    let leader_key = keys::parse_keys(&leader, "\\").ok().and_then(|k| k.into_iter().next()).unwrap_or_default();
    if pending == leader_key && key == "e" {
        leave_sidebar(app);
        return true;
    }
    let right = app.config.ui.sidebar_position == "right";
    if pending == "<C-w>" {
        if key == (if right { "h" } else { "l" }) || key == "w" || key == "p" || key == "<C-w>" {
            leave_sidebar(app);
        }
        return true;
    }
    if key == "<C-w>" {
        app.windows.sidebar_pending = key.into();
        return true;
    }
    let back = if right { key == "<C-h>" || key == "<BS>" } else { key == "<C-l>" };
    if back {
        leave_sidebar(app);
        return true;
    }
    if key == "<C-h>" || key == "<BS>" || key == "<C-l>" {
        return true;
    }
    if key == "d" {
        if pending == "d" {
            crate::actions::run(app, "session.kill", None);
        } else {
            app.windows.sidebar_pending = "d".into();
        }
        return true;
    }
    if key == "a" {
        leave_sidebar(app);
        app.mode = Mode::Command;
        app.cmd = "new ".into();
        return true;
    }
    match key {
        "j" | "<Down>" => {
            go(app, at + 1);
            return true;
        }
        "k" | "<Up>" => {
            go(app, at - 1);
            return true;
        }
        "G" => {
            go(app, n as isize - 1);
            return true;
        }
        "g" => {
            if pending == "g" {
                go(app, 0);
            } else {
                app.windows.sidebar_pending = "g".into();
            }
            return true;
        }
        "<CR>" | "l" | "o" | "<Esc>" | "q" => {
            leave_sidebar(app);
            return true;
        }
        _ => {}
    }
    if key.len() == 1 && ('1'..='9').contains(&key.chars().next().unwrap()) {
        go(app, key.parse::<isize>().unwrap() - 1);
        return true;
    }
    if key == leader_key {
        app.windows.sidebar_pending = key.into();
        return true;
    }
    // anything else works as usual, back in the transcript
    leave_sidebar(app);
    if pending == leader_key && !pending.is_empty() {
        app.feed(pending);
    }
    false
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

/// The current window's state is App::focus and App::scroll; write it back before it stops being current.
fn save_window(app: &mut App) {
    let cur = app.windows.layout.cur;
    let (s, sc) = (app.focused().map(|s| s.slot), app.scroll);
    let w = app.windows.layout.win_mut(cur);
    w.session = s;
    w.scroll = sc;
}

fn load_window(app: &mut App) {
    let cur = app.windows.layout.cur;
    let w = app.windows.layout.win(cur).clone();
    if let Some(s) = w.session.filter(|&i| app.sessions.get(i).is_some_and(|s| !s.closed)) {
        app.focus = s;
        if app.sessions[s].state == State::Waiting {
            app.sessions[s].state = State::Idle;
        }
    }
    app.scroll = w.scroll;
    clear_search(app);
}

pub fn enter_window(app: &mut App, id: usize) {
    if id == app.windows.layout.cur {
        return;
    }
    save_window(app);
    app.windows.layout.prev = Some(app.windows.layout.cur);
    app.windows.layout.cur = id;
    load_window(app);
}

fn go_window(app: &mut App, side: Side) {
    let area = pane::pane_area(app);
    if let Some(w) = app.windows.layout.neighbour(side, area) {
        enter_window(app, w);
    }
}

/// <C-w>w goes around every window, and the sidebar counts as one.
fn cycle_window(app: &mut App, step: isize) {
    let wins = app.windows.layout.all();
    if app.windows.sidebar_focused {
        return leave_sidebar(app);
    }
    if wins.len() == 1 {
        return toggle_sidebar_focus(app);
    }
    let i = wins.iter().position(|&w| w == app.windows.layout.cur).unwrap_or(0) as isize + step;
    if (i < 0 || i >= wins.len() as isize) && pane::sidebar_width(app, app.windows.cols) > 0 {
        return toggle_sidebar_focus(app);
    }
    let w = wins[i.rem_euclid(wins.len() as isize) as usize];
    enter_window(app, w);
}

/// <C-h> / <C-l>: the window beside, else toward the sidebar (focus it) or away from it (come back).
fn window_side(app: &mut App, left: bool) {
    let side = if app.windows.sidebar_focused { None } else { app.windows.layout.neighbour(if left { Side::Left } else { Side::Right }, pane::pane_area(app)) };
    if let Some(w) = side {
        return enter_window(app, w);
    }
    let to_sidebar = left == (app.config.ui.sidebar_position != "right");
    if to_sidebar {
        if !app.windows.sidebar_focused {
            toggle_sidebar_focus(app);
        }
        return;
    }
    if app.windows.sidebar_focused {
        return leave_sidebar(app);
    }
    if !left {
        app.windows.redraw = true;
    }
}

/// The agent a :split or :b argument names: its number, part of its name, or # for the alternate one.
pub fn agent_named(app: &mut App, arg: &str) -> Option<usize> {
    let open = app.open();
    if arg == "#" {
        return open.get(app.windows.alt).copied();
    }
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_digit()) {
        let n: usize = arg.parse().unwrap_or(0);
        let found = n.checked_sub(1).and_then(|i| open.get(i)).copied();
        if found.is_none() {
            app.say(format!("E86: Agent {arg} does not exist"), "ErrorMsg");
        }
        return found;
    }
    let found: Vec<usize> = open.iter().copied().filter(|&i| app.sessions[i].name.to_lowercase().contains(&arg.to_lowercase())).collect();
    if found.len() == 1 && !arg.is_empty() {
        return Some(found[0]);
    }
    let msg = if arg.is_empty() {
        "E471: Argument required".to_string()
    } else if !found.is_empty() {
        format!("E93: More than one match for {arg}")
    } else {
        format!("E94: No matching agent for {arg}")
    };
    app.say(msg, "ErrorMsg");
    None
}

/// Focus an agent by its place among the open ones (src/app.ts focusSession): an agent on screen in another window means going to that window.
pub fn focus_session(app: &mut App, n: usize) {
    app.focus_agent(n);
}

/// Called by App::focus_agent before it moves: true when the agent is shown in another window (that window is entered instead).
pub fn before_focus(app: &mut App, slot: usize) -> bool {
    if slot == app.focus {
        return false;
    }
    let cur = app.windows.layout.cur;
    let shown = app.windows.layout.all().into_iter().find(|&w| w != cur && app.windows.layout.win(w).session == Some(slot));
    if let Some(w) = shown {
        enter_window(app, w);
        return true;
    }
    if let Some(at) = app.open().iter().position(|&i| i == app.focus) {
        app.windows.alt = at;
    }
    clear_search(app);
    false
}

/// :split / :vsplit / <C-w>s / <C-w>v: another window, on another agent, or a fork of this one.
pub fn split_window(app: &mut App, dir: Dir, arg: &str) {
    let Some(parent) = app.focused().map(|s| s.slot) else {
        return app.say("no agent to split (:new <task> starts one)", "ErrorMsg");
    };
    let target = if arg.is_empty() { Some(parent) } else { agent_named(app, arg) };
    let Some(target) = target else { return };
    let cur = app.windows.layout.cur;
    let shown = app.windows.layout.all().into_iter().find(|&w| w != cur && app.windows.layout.win(w).session == Some(target));
    if let Some(w) = shown {
        return enter_window(app, w);
    }
    let mut fork = None;
    if target == parent {
        let p = &app.sessions[parent];
        if p.state == State::Running {
            let msg = format!("'{}' is still answering: split once it's done, or :vsplit <agent> to show another one", p.name);
            return app.say(msg, "WarningMsg");
        }
        match (app.windows.fork)(app, parent) {
            Ok(i) => fork = Some(i),
            Err(e) => return app.say(e, "ErrorMsg"),
        }
    }
    save_window(app);
    let area = pane::pane_area(app);
    if !app.windows.layout.split(dir, area) {
        if let Some(f) = fork {
            app.sessions[f].closed = true;
        }
        return app.say("E36: Not enough room", "ErrorMsg");
    }
    match fork {
        Some(f) => {
            app.focus = f;
            app.scroll = 0;
        }
        None => {
            if let Some(n) = app.open().iter().position(|&i| i == target) {
                app.focus_agent(n);
            }
        }
    }
}

pub fn close_window(app: &mut App) {
    let cur = app.windows.layout.cur;
    if !app.windows.layout.close(cur) {
        return app.say("E444: Cannot close last window", "ErrorMsg");
    }
    load_window(app);
}

/// <C-w>x: the two windows of a split trade what they show.
fn exchange_window(app: &mut App) {
    let Some(other) = app.windows.layout.sibling() else {
        let msg = if app.windows.layout.count() > 1 { "E443: Cannot exchange with a split window" } else { "E11: There is no window to exchange with" };
        return app.say(msg, "ErrorMsg");
    };
    save_window(app);
    let cur = app.windows.layout.cur;
    let (a, b) = (app.windows.layout.win(cur).clone(), app.windows.layout.win(other).clone());
    {
        let w = app.windows.layout.win_mut(cur);
        w.session = b.session;
        w.scroll = b.scroll;
    }
    let w = app.windows.layout.win_mut(other);
    w.session = a.session;
    w.scroll = a.scroll;
    load_window(app);
}

fn resize(app: &mut App, d: Dir, delta: i32) {
    let area = pane::pane_area(app);
    app.windows.layout.resize(d, delta, area);
}

/// After an agent is closed (:kill): the windows showing it close (the last one stays).
pub fn dropped(app: &mut App, slot: usize) {
    let cur = app.windows.layout.cur;
    for w in app.windows.layout.all() {
        if w != cur && app.windows.layout.win(w).session == Some(slot) {
            app.windows.layout.close(w);
        }
    }
    let cur = app.windows.layout.cur;
    if app.windows.layout.count() > 1 && app.windows.layout.close(cur) {
        load_window(app);
    }
}

pub fn exec_wincmd(app: &mut App, arg: &str) {
    match wincmd(arg) {
        Some(a) => crate::actions::run(app, a, None),
        None => app.say(if arg.is_empty() { "E471: Argument required".to_string() } else { format!("E474: Invalid argument: {arg}") }, "ErrorMsg"),
    }
}

// ---------------------------------------------------------------------------
// scrolling, VISUAL, marks and jumps
// ---------------------------------------------------------------------------

fn height(app: &App) -> usize {
    pane::content_height(pane::window_rect(app))
}

fn half(app: &App) -> isize {
    (height(app) / 2) as isize
}

fn page(app: &App) -> isize {
    (height(app) as isize - 2).max(1)
}

fn total(app: &App) -> usize {
    pane::current(app).len()
}

pub fn scroll_by(app: &mut App, delta: isize) {
    let max = total(app).saturating_sub(height(app));
    app.scroll = (app.scroll as isize + delta).clamp(0, max as isize) as usize;
}

fn scroll_top(app: &mut App) {
    app.scroll = total(app).saturating_sub(height(app));
}

fn scroll_top_action(app: &mut App, _: Option<&str>) {
    if app.mode == Mode::Normal {
        record_jump(app, None);
    }
    scroll_top(app);
}

fn scroll_bottom_action(app: &mut App, _: Option<&str>) {
    if app.mode == Mode::Normal {
        record_jump(app, None);
    }
    app.scroll = 0;
}

fn view(app: &App) -> (usize, usize) {
    pane::view_range(total(app), height(app), app.scroll)
}

fn scroll_to_line(app: &mut App, line: usize) {
    let (t, h) = (total(app) as isize, height(app) as isize);
    let desired = t - line as isize - h / 2;
    app.scroll = (desired - 1).clamp(0, (t - h).max(0)) as usize;
}

fn reveal_line(app: &mut App, idx: usize) {
    let (t, h) = (total(app), height(app));
    let (start, end) = view(app);
    if idx < start {
        app.scroll = t.saturating_sub(h + idx);
    } else if idx >= end {
        app.scroll = t.saturating_sub(idx + 1);
    }
}

fn move_cursor(app: &mut App, delta: isize) {
    let t = total(app) as isize;
    let c = (app.windows.visual.1 as isize).saturating_add(delta).clamp(0, (t - 1).max(0)) as usize;
    app.windows.visual.1 = c;
    reveal_line(app, c);
}

fn screen_cursor(app: &mut App, which: u8) {
    let (start, end) = view(app);
    app.windows.visual.1 = match which {
        0 => start,
        2 => end.saturating_sub(1),
        _ => start + (end.saturating_sub(start + 1)) / 2,
    };
}

fn mode_visual(app: &mut App, _: Option<&str>) {
    let t = total(app);
    if t == 0 {
        return;
    }
    let bottom = view(app).1.saturating_sub(1);
    app.windows.visual = (bottom, bottom);
    app.mode = Mode::Visual;
}

fn visual_swap(app: &mut App, _: Option<&str>) {
    let (a, c) = app.windows.visual;
    app.windows.visual = (c, a);
    reveal_line(app, a);
}

fn visual_inner_block(app: &mut App, _: Option<&str>) {
    let lines = pane::current(app);
    let Some(block) = lines.get(app.windows.visual.1).and_then(|l| l.block) else {
        return app.say("no code block under the cursor", "WarningMsg");
    };
    let idx: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.block == Some(block) && !l.label).map(|(i, _)| i).collect();
    if let (Some(&a), Some(&b)) = (idx.first(), idx.last()) {
        app.windows.visual = (a, b);
    }
}

fn visual_reselect(app: &mut App, _: Option<&str>) {
    let Some(last) = app.focused().and_then(|s| app.windows.last_visual.get(&s.slot)).copied() else { return };
    let t = total(app);
    if t == 0 {
        return;
    }
    app.windows.visual = (last.0.min(t - 1), last.1.min(t - 1));
    app.mode = Mode::Visual;
    let c = app.windows.visual.1;
    reveal_line(app, c);
}

fn visual_yank(app: &mut App, _: Option<&str>) {
    if let Some(s) = app.focused().map(|s| s.slot) {
        let v = app.windows.visual;
        app.windows.last_visual.insert(s, v);
    }
    let lines = pane::current(app);
    let (a, b) = (app.windows.visual.0.min(app.windows.visual.1), app.windows.visual.0.max(app.windows.visual.1));
    let text = lines[a.min(lines.len())..(b + 1).min(lines.len())].iter().map(|l| l.plain.as_str()).collect::<Vec<_>>().join("\n");
    yank(app, &text, b - a + 1);
    app.mode = Mode::Normal;
}

fn view_place(app: &mut App, where_: &str) {
    let line = if app.mode == Mode::Visual {
        Some(app.windows.visual.1)
    } else if !app.windows.search_query.is_empty() {
        app.windows.cur_hit.map(|h| h.line)
    } else {
        None
    };
    let Some(line) = line else {
        return app.say("zz, zt and zb move the VISUAL cursor's line or the search match; there's neither", "WarningMsg");
    };
    place_line(app, line, where_);
}

/// zz / zt / zb: the line in the middle, at the top or at the bottom of the window.
fn place_line(app: &mut App, idx: usize, where_: &str) {
    let (t, h) = (total(app) as isize, height(app) as isize);
    let i = idx as isize;
    let start = match where_ {
        "top" => i,
        "bottom" => i + 1 - h,
        _ => i - (h - 1) / 2,
    };
    app.scroll = (t - h - start).clamp(0, (t - h).max(0)) as usize;
}

/// Where you are: the VISUAL cursor, else the top line of the window.
fn here_line(app: &App) -> usize {
    if app.mode == Mode::Visual { app.windows.visual.1 } else { view(app).0 }
}

fn go_line(app: &mut App, line: usize) {
    let t = total(app);
    let at = line.min(t.saturating_sub(1));
    if app.mode == Mode::Visual {
        app.windows.visual.1 = at;
        reveal_line(app, at);
    } else {
        place_line(app, at, "top");
    }
}

/// m{a-z} sets a mark, '{a-z} and `{a-z} go to one, '' and `` go back to before the last jump.
fn mark_key(app: &mut App, key: &str) -> bool {
    if !matches!(app.mode, Mode::Normal | Mode::Visual) {
        return false;
    }
    if let Some(kind) = app.windows.pending_mark.take() {
        if kind == 'm' { set_mark(app, key) } else { goto_mark(app, key) }
        return true;
    }
    if !app.seq.pending.is_empty() || !matches!(key, "m" | "'" | "`") {
        return false;
    }
    let r = app.keymap.lookup(app.mode.keys(), &[key.to_string()], false);
    if r.exact.is_some() || r.prefix {
        return false;
    }
    app.windows.pending_mark = key.chars().next();
    app.windows.pending_count = 0;
    true
}

fn set_mark(app: &mut App, key: &str) {
    let Some(s) = app.focused().map(|s| s.slot) else { return };
    let Some(c) = key.chars().next().filter(|c| c.is_ascii_alphabetic() && key.len() == 1) else { return };
    let line = here_line(app);
    let marks = app.windows.marks.entry(s).or_default();
    marks.retain(|(m, _)| *m != c);
    marks.push((c, line));
}

fn goto_mark(app: &mut App, key: &str) {
    let Some(s) = app.focused().map(|s| s.slot) else { return };
    if key == "'" || key == "`" {
        let back = app.windows.jumps.get(&s).and_then(|(list, at)| at.checked_sub(1).and_then(|i| list.get(i))).copied();
        let Some(back) = back else { return };
        record_jump(app, None);
        return go_line(app, back);
    }
    let Some(c) = key.chars().next().filter(|c| c.is_ascii_alphabetic() && key.len() == 1) else { return };
    let line = app.windows.marks.get(&s).and_then(|m| m.iter().find(|(x, _)| *x == c)).map(|(_, l)| *l);
    let Some(line) = line else {
        return app.say("E20: Mark not set", "ErrorMsg");
    };
    record_jump(app, None);
    go_line(app, line);
}

/// Remember where you are before a jump, for <C-o> and ''.
pub fn record_jump(app: &mut App, line: Option<usize>) {
    let Some(s) = app.focused().map(|s| s.slot) else { return };
    let line = line.unwrap_or_else(|| here_line(app));
    let (list, at) = app.windows.jumps.entry(s).or_insert((vec![], 0));
    list.truncate(*at);
    list.retain(|&l| l != line);
    list.push(line);
    if list.len() > 100 {
        list.remove(0);
    }
    *at = list.len();
}

fn jump_by(app: &mut App, dir: isize) {
    let Some(s) = app.focused().map(|s| s.slot) else { return };
    let here = here_line(app);
    let Some((list, at)) = app.windows.jumps.get_mut(&s) else { return };
    if dir < 0 {
        if *at == 0 {
            return;
        }
        // the first <C-o> keeps where you are, so <Tab> can come back to it
        if *at == list.len() {
            list.push(here);
        }
        *at -= 1;
    } else {
        if *at + 1 >= list.len() {
            return;
        }
        *at += 1;
    }
    let target = list[*at];
    if *at == list.len() - 1 {
        list.pop();
        *at = list.len();
    }
    go_line(app, target);
}

fn app_position(app: &mut App, _: Option<&str>) {
    let Some(name) = app.focused().map(|s| s.name.clone()) else { return };
    let t = total(app);
    let (_, end) = view(app);
    let pct = if t > 0 { ((end as f64 / t as f64) * 100.0).round() as usize } else { 100 };
    app.say(format!("\"{name}\" {t} line{} --{pct}%--", if t == 1 { "" } else { "s" }), "Normal");
}

/// `{` / `}`: the previous / next message at the top of the pane.
fn jump_message(app: &mut App, dir: isize) {
    if app.mode == Mode::Normal {
        record_jump(app, None);
    }
    let lines = pane::current(app);
    let (start, _) = view(app);
    let starts: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.start).map(|(i, _)| i).collect();
    let target = if dir > 0 { starts.iter().copied().find(|&i| i > start) } else { starts.iter().rev().copied().find(|&i| i < start) };
    let Some(target) = target else {
        if dir > 0 {
            app.scroll = 0;
        } else {
            scroll_top(app);
        }
        return;
    };
    let (t, h) = (lines.len() as isize, height(app) as isize);
    app.scroll = (t - h - target as isize).clamp(0, (t - h).max(0)) as usize;
}

// ---------------------------------------------------------------------------
// yanking
// ---------------------------------------------------------------------------

/// The OSC 52 sequence that asks the terminal to set its clipboard (wrapped for tmux).
pub fn osc52(text: &str) -> String {
    let seq = format!("\x1b]52;c;{}\x07", base64(text.as_bytes()));
    if std::env::var_os("TMUX").is_some() { format!("\x1bPtmux;{}\x1b\\", seq.replace('\x1b', "\x1b\x1b")) } else { seq }
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Copy text: OSC 52 always, and a local clipboard tool when there's one. Returns how.
pub fn copy_to_clipboard(text: &str) -> String {
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = out.write_all(osc52(text).as_bytes());
    let _ = out.flush();
    let tools: &[(&str, &[&str])] = &[("pbcopy", &[]), ("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["--clipboard", "--input"]), ("clip.exe", &[])];
    for (cmd, args) in tools {
        if *cmd == "wl-copy" && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            continue;
        }
        if (*cmd == "xclip" || *cmd == "xsel") && std::env::var_os("DISPLAY").is_none() {
            continue;
        }
        let found = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()));
        if !found {
            continue;
        }
        if let Ok(mut child) = std::process::Command::new(cmd).args(*args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return cmd.to_string();
        }
    }
    "terminal".into()
}

fn yank(app: &mut App, text: &str, count: usize) {
    let how = (app.windows.clipboard)(text);
    app.say(format!("{count} line{} yanked{}", if count == 1 { "" } else { "s" }, if how == "terminal" { String::new() } else { format!(" ({how})") }), "Normal");
}

fn yank_reply(app: &mut App, _: Option<&str>) {
    let reply = app.focused().and_then(|s| s.items.iter().rev().find_map(|i| if let Item::Text(t) = i { (!t.is_empty()).then(|| t.clone()) } else { None }));
    match reply {
        Some(t) => {
            let n = t.split('\n').count();
            yank(app, &t, n);
        }
        None => app.say("no reply to yank yet", "WarningMsg"),
    }
}

fn yank_block(app: &mut App, _: Option<&str>) {
    let lines = pane::current(app);
    let (start, end) = view(app);
    let mut block = None;
    for i in (0..end).rev() {
        if block.is_some() {
            break;
        }
        if lines[i].block.is_some() && i + 1 >= start {
            block = lines[i].block;
        }
    }
    if block.is_none() {
        block = lines.iter().rev().find_map(|l| l.block);
    }
    let Some(block) = block else {
        return app.say("no code block to yank", "WarningMsg");
    };
    let code: Vec<String> = lines
        .iter()
        .filter(|l| l.block == Some(block) && !l.label)
        .map(|l| {
            let lead = l.plain.chars().take_while(|&c| c == ' ').count();
            if lead >= 2 { l.plain.chars().skip(lead.min(4)).collect() } else { l.plain.clone() }
        })
        .collect();
    let n = code.len();
    yank(app, &code.join("\n"), n);
}

// ---------------------------------------------------------------------------
// folds
// ---------------------------------------------------------------------------

fn tool_items(app: &App) -> Vec<(usize, usize)> {
    let Some(s) = app.focused() else { return vec![] };
    s.items.iter().enumerate().filter(|(_, i)| matches!(i, Item::Tool { .. })).map(|(n, _)| (s.slot, n)).collect()
}

/// za: open every tool call's output when any is folded, else fold them all (src/session.ts toggleFolds).
fn fold_toggle(app: &mut App, _: Option<&str>) {
    let tools = tool_items(app);
    if tools.is_empty() {
        return;
    }
    let any_folded = tools.iter().any(|k| !app.windows.open_folds.contains(k));
    set_folds(app, &tools, !any_folded);
}

fn set_all_folds(app: &mut App, folded: bool) {
    let tools = tool_items(app);
    set_folds(app, &tools, folded);
}

fn set_folds(app: &mut App, tools: &[(usize, usize)], folded: bool) {
    for k in tools {
        if folded {
            app.windows.open_folds.remove(k);
        } else {
            app.windows.open_folds.insert(*k);
        }
    }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/// Esc or :noh: the matches stop being highlighted (n still finds them... once searched again).
pub fn clear_search(app: &mut App) {
    app.windows.search_query.clear();
    app.windows.cur_hit = None;
}

/// `/` or `?`: from the top of the view down, or from its bottom up. The view comes back on Esc.
fn start_search(app: &mut App, backward: bool) {
    app.mode = Mode::Search;
    app.windows.search_backward = backward;
    app.cmd.clear();
    app.windows.search_preview.clear();
    let (start, end) = view(app);
    let w = &mut app.windows;
    w.search_from = Some(SearchFrom { scroll: app.scroll, hit: w.cur_hit, query: w.search_query.clone(), at: Hit { line: start, n: -1 }, back: Hit { line: end.saturating_sub(1), n: i64::MAX } });
}

fn hits(app: &App, term: &str) -> Vec<Hit> {
    let lines = pane::current(app);
    find_hits(term, lines.iter().map(|l: &PaneLine| l.plain.as_str()))
}

/// While typing after / or ?: the first match shows and they're all highlighted (incsearch).
fn preview_search(app: &mut App) {
    let query = app.cmd.clone();
    app.windows.search_preview = query.clone();
    let Some(from) = app.windows.search_from.clone() else { return };
    app.scroll = from.scroll;
    let back = app.windows.search_backward;
    let found = if query.is_empty() { None } else { next_hit(&hits(app, &query), if back { from.back } else { from.at }, if back { -1 } else { 1 }) };
    app.windows.cur_hit = found.map(|f| f.0);
    if let Some((h, _, _)) = found {
        scroll_to_line(app, h.line);
    }
}

/// Esc while typing a search: the view and the last search come back.
fn cancel_search(app: &mut App) {
    let Some(from) = app.windows.search_from.take() else { return };
    app.scroll = from.scroll;
    app.windows.cur_hit = from.hit;
    app.windows.search_query = from.query;
}

/// Enter after / or ?: go to the match and keep the search for n / N.
fn run_search(app: &mut App, query: &str) {
    let from = app.windows.search_from.take();
    if query.is_empty() {
        // an empty search repeats the last one, as in vim
        if let Some(f) = &from {
            app.scroll = f.scroll;
        }
        if app.windows.search_query.is_empty() {
            return;
        }
        app.windows.cur_hit = from.and_then(|f| f.hit);
        return goto_match(app, 1);
    }
    app.windows.search_query = query.to_string();
    let hs = hits(app, query);
    let back = app.windows.search_backward;
    let start = if back { from.as_ref().map(|f| f.back).unwrap_or(Hit { line: usize::MAX, n: 0 }) } else { from.as_ref().map(|f| f.at).unwrap_or(Hit { line: 0, n: -1 }) };
    match next_hit(&hs, start, if back { -1 } else { 1 }) {
        Some(found) => show_hit(app, found, hs.len(), false),
        None => {
            if let Some(f) = from {
                app.scroll = f.scroll;
            }
            app.windows.cur_hit = None;
            app.say(format!("E486: Pattern not found: {query}"), "ErrorMsg");
        }
    }
}

/// n (1) / N (-1): the next match the way the last search went, or the other way.
fn goto_match(app: &mut App, dir: i32) {
    if app.windows.search_query.is_empty() {
        return app.say("E35: No previous regular expression", "ErrorMsg");
    }
    if app.mode == Mode::Normal {
        record_jump(app, None);
    }
    let q = app.windows.search_query.clone();
    let hs = hits(app, &q);
    let back = app.windows.search_backward;
    let step = if back { -dir } else { dir };
    let (start, end) = view(app);
    let from = app.windows.cur_hit.unwrap_or(if step > 0 { Hit { line: start, n: -1 } } else { Hit { line: end.saturating_sub(1), n: i64::MAX } });
    match next_hit(&hs, from, step) {
        Some(found) => show_hit(app, found, hs.len(), step != if back { -1 } else { 1 }),
        None => app.say(format!("E486: Pattern not found: {q}"), "ErrorMsg"),
    }
}

/// Scroll to a match and say where it is: /term [3/7], and when the search wrapped.
fn show_hit(app: &mut App, (hit, nth, wrapped): (Hit, usize, bool), total: usize, reversed: bool) {
    app.windows.cur_hit = Some(hit);
    scroll_to_line(app, hit.line);
    let up = app.windows.search_backward != reversed;
    let wrap = if wrapped {
        if up { "  search hit TOP, continuing at BOTTOM" } else { "  search hit BOTTOM, continuing at TOP" }
    } else {
        ""
    };
    let msg = format!("{}{}  [{nth}/{total}]{wrap}", if up { "?" } else { "/" }, app.windows.search_query);
    app.say(msg, if wrapped { "WarningMsg" } else { "Search" });
}

// ---------------------------------------------------------------------------
// :dash / :ls
// ---------------------------------------------------------------------------

/// One line of a message for previews: markdown markers and code fences dropped.
fn plain_preview(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .filter(|l| {
            let t = l.trim();
            !((t.starts_with("```") || t.starts_with("~~~")) && t.trim_start_matches(['`', '~']).chars().all(|c| c.is_alphanumeric() || "_+-".contains(c)))
        })
        .map(|l| {
            let t = l.trim_start();
            let t = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")).unwrap_or(l);
            t.replace("**", "").replace("__", "").replace('`', "")
        })
        .collect();
    lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// :dash: every agent at a glance; Enter goes to one.
pub fn open_dashboard(app: &mut App) {
    let open = app.open();
    if open.is_empty() {
        return app.say("no agents yet (:new <task> starts one)", "Comment");
    }
    let ic = crate::ui::icons::icons(app);
    let mut lines: Vec<crate::ui::floats::FloatLine> = vec![];
    let mut rows = vec![];
    let group = |st: State| match st {
        State::Running => "String",
        State::Waiting => "WarningMsg",
        State::Error => "ErrorMsg",
        _ => "Comment",
    };
    let spin = crate::ui::spinner(app);
    let mut running = 0;
    let (mut tokens, mut cost) = (0u64, 0f64);
    for (n, &i) in open.iter().enumerate() {
        let s = &app.sessions[i];
        if s.state == State::Running {
            running += 1;
        }
        tokens += s.tokens;
        cost += s.cost;
        let (glyph, state) = match s.state {
            State::Running => (spin.to_string(), "running"),
            State::Waiting => (ic.waiting.clone(), "waiting"),
            State::Idle => (ic.idle.clone(), "idle"),
            State::Paused => (ic.paused.clone(), "paused"),
            State::Error => (ic.error.clone(), "error"),
        };
        let last = s.items.iter().rev().find_map(|x| match x {
            Item::Text(t) | Item::User(t) => Some(t.clone()),
            _ => None,
        });
        rows.push(lines.len());
        let mut row: crate::ui::floats::FloatLine = vec![
            ("LineNr", format!("{:>2} ", n + 1)),
            (group(s.state), format!("{glyph} ")),
            ("Title", format!("{:<27}", crate::ui::text::fit(&s.name, 26))),
            (group(s.state), format!("{state:<8}")),
            ("Comment", format!(" {}", crate::ui::text::fit(&s.branch.as_ref().map(|b| format!("{}{b}", ic.worktree)).unwrap_or_else(|| s.model.clone().unwrap_or_default()), 34))),
        ];
        if s.branch.is_some() && (s.stat.0 > 0 || s.stat.1 > 0) {
            row.push(("Added", format!(" +{}", s.stat.0)));
            row.push(("Removed", format!(" {}{}", ic.minus, s.stat.1)));
        }
        if s.tokens > 0 {
            row.push(("Comment", format!("  {}", s.usage())));
        }
        if !s.queue.is_empty() {
            row.push(("Comment", format!("  {}{}", ic.queued, s.queue.len())));
        }
        if s.state == State::Waiting {
            row.push(("WarningMsg", format!("  {} new", ic.unread)));
        }
        lines.push(row);
        lines.push(vec![("NormalFloat", "      ".into()), ("Comment", last.map(|t| crate::ui::text::fit(&plain_preview(&t), 90)).unwrap_or_else(|| "(no messages yet)".into()))]);
    }
    lines.push(vec![]);
    let total = if cost > 0.0 { format!("{} · ${cost:.2}", tokens_text(tokens)) } else { tokens_text(tokens) };
    lines.push(vec![("Comment", format!("{} agents · {running} running · ", open.len())), ("NormalFloat", format!("{total} in all")), ("Comment", " · j/k move · Enter open · :cost for more".into())]);
    let w = 110.min(app.windows.cols.saturating_sub(4));
    let mut f = crate::ui::floats::Float::rich("Dashboard", lines, w);
    let at = open.iter().position(|&i| i == app.focus).unwrap_or(0);
    f.selected = at;
    f.selectable = rows.clone();
    f.on_select = Some(Box::new(move |app, line| {
        if let Some(n) = rows.iter().position(|&r| r == line) {
            app.focus_agent(n);
        }
    }));
    app.seq.reset();
    app.float = Some(f);
}

fn tokens_text(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M tok", n as f64 / 1e6)
    } else if n >= 1000 {
        format!("{:.1}k tok", n as f64 / 1e3)
    } else {
        format!("{n} tok")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::app;
    use crate::session::Session;
    use crossterm::event::{KeyCode, KeyModifiers};

    fn press(a: &mut App, keys: &str) {
        for c in keys.chars() {
            let code = match c {
                '\r' => KeyCode::Enter,
                '\x1b' => KeyCode::Esc,
                '\x7f' => KeyCode::Backspace,
                '\t' => KeyCode::Tab,
                c => KeyCode::Char(c),
            };
            a.key(KeyEvent::new(code, KeyModifiers::NONE));
        }
    }

    fn ctrl(a: &mut App, c: char) {
        a.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL));
    }

    fn special(a: &mut App, code: KeyCode) {
        a.key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    fn agents(names: &[&str], lines: usize) -> App {
        let mut a = app();
        a.windows.cols = 140;
        a.windows.rows = 40;
        a.windows.clipboard = |_| "terminal".into();
        for (i, n) in names.iter().enumerate() {
            let mut s = Session::new(i, n, "claude", "/nope".into());
            for k in 1..=lines {
                s.items.push(Item::Info(format!("{n} line {k}")));
            }
            a.sessions.push(s);
        }
        a.focus = 0;
        a
    }

    #[test]
    fn the_prompt_has_a_cursor() {
        let mut a = agents(&["alpha"], 3);
        press(&mut a, "ifix bug");
        special(&mut a, KeyCode::Left);
        special(&mut a, KeyCode::Left);
        special(&mut a, KeyCode::Left);
        press(&mut a, "the ");
        assert_eq!(a.input, "fix the bug");
        special(&mut a, KeyCode::Home);
        special(&mut a, KeyCode::Delete);
        assert_eq!(a.input, "ix the bug");
        special(&mut a, KeyCode::End);
        ctrl(&mut a, 'w');
        assert_eq!(a.input, "ix the ");
        // <C-f>: NORMAL mode on the line
        ctrl(&mut a, 'f');
        press(&mut a, "0dwA!");
        assert_eq!(a.input, "the !");
        assert_eq!(a.mode, Mode::Insert);
    }

    #[test]
    fn command_history_completion_and_wildmenu() {
        let mut a = agents(&["cart total", "docs pass"], 3);
        press(&mut a, ":colo nord\r");
        assert_eq!(a.theme.name, "nord");
        press(&mut a, ":co");
        special(&mut a, KeyCode::Up);
        assert_eq!(a.cmd, "colo nord");
        press(&mut a, "\x1b:vs");
        assert_eq!(completion_as_typed(&a).unwrap().1, "plit");
        press(&mut a, "\t");
        assert_eq!(a.cmd, "vsplit");
        press(&mut a, " tot\t");
        assert_eq!(a.cmd, "vsplit cart total");
        press(&mut a, "\x1b");
        assert_eq!(a.mode, Mode::Normal);
    }

    #[test]
    fn search_n_and_highlight() {
        let mut a = agents(&["alpha"], 30);
        press(&mut a, "/line 1\r");
        assert!(a.message.0.starts_with("/line 1  ["), "{}", a.message.0);
        let first = a.windows.cur_hit.unwrap();
        press(&mut a, "n");
        assert!(a.windows.cur_hit.unwrap().line > first.line);
        press(&mut a, "N");
        assert_eq!(a.windows.cur_hit.unwrap(), first);
        press(&mut a, "/zzz\r");
        assert_eq!(a.message.0, "E486: Pattern not found: zzz");
        crate::commands::exec(&mut a, "noh");
        assert_eq!(a.windows.search_query, "");
        press(&mut a, "n");
        assert_eq!(a.message.0, "E35: No previous regular expression");
    }

    #[test]
    fn visual_yank_and_counts() {
        let mut a = agents(&["alpha"], 5);
        thread_local!(static LAST: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) });
        a.windows.clipboard = |t| {
            LAST.with(|l| *l.borrow_mut() = t.to_string());
            "terminal".into()
        };
        press(&mut a, "Vkky");
        assert_eq!(a.mode, Mode::Normal);
        assert_eq!(a.message.0, "3 lines yanked");
        LAST.with(|l| assert_eq!(*l.borrow(), "alpha line 4\n\nalpha line 5"));
        press(&mut a, "3k");
        assert_eq!(a.scroll, 0, "nothing to scroll: it all fits");
    }

    #[test]
    fn splits_and_window_keys() {
        let mut a = agents(&["alpha", "beta", "gamma"], 3);
        crate::commands::exec(&mut a, "vsplit 2");
        assert_eq!(a.windows.layout.count(), 2);
        assert_eq!(a.focused().unwrap().name, "beta");
        ctrl(&mut a, 'w');
        press(&mut a, "h");
        assert_eq!(a.focused().unwrap().name, "alpha");
        crate::commands::exec(&mut a, "vsplit beta");
        assert_eq!(a.focused().unwrap().name, "beta", "an agent on screen: its window");
        assert_eq!(a.windows.layout.count(), 2);
        crate::commands::exec(&mut a, "q");
        assert_eq!(a.windows.layout.count(), 1);
        assert!(!a.quit, ":q closes a split first");
        crate::commands::exec(&mut a, "close");
        assert_eq!(a.message.0, "E444: Cannot close last window");
        crate::commands::exec(&mut a, "wincmd z");
        assert_eq!(a.message.0, "E474: Invalid argument: z");
        let rows = crate::ui::rows(&a);
        assert_eq!(rows.len(), 40);
        assert!(rows.iter().all(|r| crate::ui::text::segs_width(r) == 140));
    }

    #[test]
    fn marks_and_jumps() {
        let mut a = agents(&["alpha"], 60);
        press(&mut a, "gg");
        press(&mut a, "ma");
        press(&mut a, "G");
        press(&mut a, "'a");
        assert!(a.scroll > 0);
        press(&mut a, "'b");
        assert_eq!(a.message.0, "E20: Mark not set");
    }

    #[test]
    fn sidebar_focus_and_confirm() {
        let mut a = agents(&["alpha", "beta"], 2);
        press(&mut a, " e");
        assert!(a.windows.sidebar_focused);
        press(&mut a, "j");
        assert_eq!(a.focused().unwrap().name, "beta");
        press(&mut a, "\r");
        assert!(!a.windows.sidebar_focused);
        ask(&mut a, "Kill it? [y/N]", Box::new(|a| a.say("yes", "Comment")), None);
        press(&mut a, "y");
        assert_eq!(a.message.0, "yes");
    }

    #[test]
    fn attach_picker_inserts_the_path() {
        let mut a = agents(&["alpha"], 1);
        press(&mut a, "iwhy is ");
        press(&mut a, "@");
        assert!(a.windows.picker.is_some());
        a.windows.picker.as_mut().unwrap().set_items(vec![Choice::new("README.md"), Choice::new("src/cart.js")]);
        press(&mut a, "cart\r");
        assert_eq!(a.input, "why is @src/cart.js ");
        press(&mut a, "@");
        press(&mut a, "\x7f");
        assert_eq!(a.input, "why is @src/cart.js ", "Backspace takes the @ back");
    }
}
