//! Vim's normal mode for one line of text (the prompt or the command line),
//! the line being typed with its cursor, and history: a port of
//! src/line-edit.ts. No terminal or app state, so every command is a plain test.

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LineExit {
    /// back to typing
    Insert,
    /// back where it was opened from
    Back,
    /// send the line
    Submit,
}

#[derive(Default, Debug, PartialEq)]
pub struct LineResult {
    pub exit: Option<LineExit>,
    /// j / k: the next (1) or previous (-1) line from history
    pub history: Option<i32>,
    pub yanked: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Op {
    D,
    C,
    Y,
}

#[derive(Clone, PartialEq, Debug)]
enum Wait {
    Find(char),
    Replace,
    Object(bool),
    G,
    Register,
}

const MAX_COUNT: usize = 9999;

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn char_class(c: char, big: bool) -> u8 {
    if c.is_whitespace() {
        0
    } else if big || is_word(c) {
        1
    } else {
        2
    }
}

/// w: the start of the next word.
pub fn word_forward(chars: &[char], from: usize, big: bool) -> usize {
    let mut i = from;
    if i >= chars.len() {
        return chars.len();
    }
    let c = char_class(chars[i], big);
    if c != 0 {
        while i < chars.len() && char_class(chars[i], big) == c {
            i += 1;
        }
    }
    while i < chars.len() && char_class(chars[i], big) == 0 {
        i += 1;
    }
    i
}

/// b: the start of this word, or the one before.
pub fn word_back(chars: &[char], from: usize, big: bool) -> usize {
    if from == 0 {
        return 0;
    }
    let mut i = from - 1;
    while i > 0 && char_class(chars[i], big) == 0 {
        i -= 1;
    }
    if i == 0 {
        return 0;
    }
    let c = char_class(chars[i], big);
    while i > 0 && char_class(chars[i - 1], big) == c {
        i -= 1;
    }
    i
}

fn word_end(chars: &[char], from: usize, big: bool) -> usize {
    let mut i = from + 1;
    while i < chars.len() && char_class(chars[i], big) == 0 {
        i += 1;
    }
    if i >= chars.len() {
        return chars.len().saturating_sub(1);
    }
    let c = char_class(chars[i], big);
    while i + 1 < chars.len() && char_class(chars[i + 1], big) == c {
        i += 1;
    }
    i
}

fn word_end_back(chars: &[char], from: usize, big: bool) -> usize {
    if from == 0 {
        return 0;
    }
    let mut i = from as isize;
    let cls = |i: isize| char_class(chars.get(i as usize).copied().unwrap_or(' '), big);
    let c = cls(i);
    if c != 0 {
        while i >= 0 && cls(i) == c {
            i -= 1;
        }
    }
    while i >= 0 && cls(i) == 0 {
        i -= 1;
    }
    i.max(0) as usize
}

fn pair(c: char) -> Option<(char, char)> {
    Some(match c {
        '(' | ')' | 'b' => ('(', ')'),
        '[' | ']' => ('[', ']'),
        '{' | '}' | 'B' => ('{', '}'),
        '<' | '>' => ('<', '>'),
        _ => return None,
    })
}

#[derive(Clone)]
struct Snap {
    text: Vec<char>,
    pos: usize,
}

/// Vim's normal mode on one line (after <C-f>).
#[derive(Default)]
pub struct LineEditor {
    pub chars: Vec<char>,
    pub pos: usize,
    /// what p pastes; the last delete or yank
    pub register: String,
    undo: Vec<Snap>,
    redo: Vec<Snap>,
    count: usize,
    op_count: usize,
    op: Option<Op>,
    wait: Option<Wait>,
    typed: Vec<String>,
    last_change: Option<Vec<String>>,
    last_find: Option<(char, char)>,
    changed_now: bool,
    replaying: bool,
    change_open: bool,
}

impl LineEditor {
    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    /// Keys typed so far for a command that isn't finished (`d2`), for showcmd.
    pub fn pending_keys(&self) -> String {
        if self.pending() { self.typed.concat() } else { String::new() }
    }

    /// Take the line as it is now; what happened to it since becomes one undo step.
    pub fn sync(&mut self, text: &str, pos: usize) {
        if text != self.text() {
            if !self.change_open {
                self.undo.push(Snap { text: self.chars.clone(), pos: self.pos });
            }
            self.redo.clear();
            self.chars = text.chars().collect();
        }
        self.change_open = false;
        self.pos = pos;
        self.clamp();
    }

    fn pending(&self) -> bool {
        self.wait.is_some() || self.op.is_some() || self.count > 0
    }

    fn clamp(&mut self) {
        self.pos = self.pos.min(self.chars.len().saturating_sub(1));
    }

    fn clear_pending(&mut self) {
        self.count = 0;
        self.op_count = 0;
        self.op = None;
        self.wait = None;
    }

    fn times(&self) -> usize {
        (self.op_count.max(1) * self.count.max(1)).min(MAX_COUNT)
    }

    /// One key, in vigent's notation ("w", "<Esc>", "<C-r>").
    pub fn feed(&mut self, token: &str) -> LineResult {
        self.typed.push(token.to_string());
        let key = match token {
            "<lt>" => "<",
            "<Space>" => " ",
            t => t,
        };
        let result = self.step(key);
        if !self.pending() {
            if self.changed_now && result.exit.is_none() && !self.replaying {
                self.last_change = Some(self.typed.clone());
            }
            self.typed.clear();
            self.changed_now = false;
        }
        if result.exit.is_none() {
            self.clamp();
        }
        result
    }

    fn step(&mut self, key: &str) -> LineResult {
        if let Some(w) = self.wait.take() {
            return self.after_wait(w, key);
        }
        if key == "<Esc>" || key == "<C-c>" {
            let busy = self.pending();
            self.clear_pending();
            return if busy { LineResult::default() } else { exit(LineExit::Back) };
        }
        let digit = key.len() == 1 && key.as_bytes()[0].is_ascii_digit();
        if digit && (key != "0" || self.count > 0) {
            self.count = (self.count * 10 + (key.as_bytes()[0] - b'0') as usize).min(MAX_COUNT);
            return LineResult::default();
        }
        if key == "\"" {
            self.wait = Some(Wait::Register);
            return LineResult::default();
        }
        if self.op.is_some() { self.operator_pending(key) } else { self.command(key) }
    }

    fn operator_pending(&mut self, key: &str) -> LineResult {
        let op = self.op.unwrap();
        let same = matches!((op, key), (Op::D, "d") | (Op::C, "c") | (Op::Y, "y"));
        if same {
            return self.apply(0, self.chars.len());
        }
        if key == "i" || key == "a" {
            self.wait = Some(Wait::Object(key == "a"));
            return LineResult::default();
        }
        if op == Op::C && (key == "w" || key == "W") && self.chars.get(self.pos).is_some_and(|&c| char_class(c, false) != 0) {
            return self.motion(if key == "w" { "e" } else { "E" });
        }
        self.motion(key)
    }

    fn command(&mut self, key: &str) -> LineResult {
        let n = self.times();
        let len = self.chars.len();
        match key {
            "d" | "c" | "y" => {
                self.op = Some(match key {
                    "d" => Op::D,
                    "c" => Op::C,
                    _ => Op::Y,
                });
                self.op_count = self.count;
                self.count = 0;
                LineResult::default()
            }
            "x" | "<Del>" => {
                self.op = Some(Op::D);
                self.apply(self.pos, len.min(self.pos + n))
            }
            "X" => {
                self.op = Some(Op::D);
                self.apply(self.pos.saturating_sub(n), self.pos)
            }
            "s" => {
                self.op = Some(Op::C);
                self.apply(self.pos, len.min(self.pos + n))
            }
            "S" => {
                self.op = Some(Op::C);
                self.apply(0, len)
            }
            "D" => {
                self.op = Some(Op::D);
                self.apply(self.pos, len)
            }
            "C" => {
                self.op = Some(Op::C);
                self.apply(self.pos, len)
            }
            "Y" => {
                self.op = Some(Op::Y);
                self.apply(self.pos, len)
            }
            "r" => {
                self.wait = Some(Wait::Replace);
                LineResult::default()
            }
            "~" => self.toggle_case(n),
            "p" | "P" => self.put(key == "p", n),
            "J" => self.join(),
            "u" => self.history(true),
            "<C-r>" => self.history(false),
            "." => self.repeat(),
            "i" => {
                self.clear_pending();
                exit(LineExit::Insert)
            }
            "a" => {
                self.clear_pending();
                self.pos = len.min(self.pos + 1);
                exit(LineExit::Insert)
            }
            "I" => {
                self.clear_pending();
                self.pos = self.first_non_blank();
                exit(LineExit::Insert)
            }
            "A" => {
                self.clear_pending();
                self.pos = len;
                exit(LineExit::Insert)
            }
            "<CR>" => {
                self.clear_pending();
                exit(LineExit::Submit)
            }
            "j" | "<Down>" | "<C-n>" => {
                self.clear_pending();
                LineResult { history: Some(1), ..Default::default() }
            }
            "k" | "<Up>" | "<C-p>" => {
                self.clear_pending();
                LineResult { history: Some(-1), ..Default::default() }
            }
            _ => self.motion(key),
        }
    }

    fn first_non_blank(&self) -> usize {
        self.chars.iter().position(|c| !c.is_whitespace()).unwrap_or(0)
    }

    fn repeat_word(&self, step: impl Fn(usize) -> usize, n: usize) -> usize {
        let mut at = self.pos;
        for _ in 0..n {
            at = step(at);
        }
        at
    }

    fn motion(&mut self, key: &str) -> LineResult {
        let n = self.times();
        let last = self.chars.len().saturating_sub(1);
        let big = key.chars().count() == 1 && key == key.to_uppercase() && key != key.to_lowercase();
        let chars = self.chars.clone();
        match key {
            "h" | "<Left>" | "<BS>" => self.go(self.pos.saturating_sub(n), false),
            "l" | "<Right>" | " " => self.go(self.chars.len().min(self.pos + n), false),
            "0" | "<Home>" => self.go(0, false),
            "^" => self.go(self.first_non_blank(), false),
            "$" | "<End>" | "G" => self.go(last, true),
            "|" => self.go(last.min(n - 1), false),
            "w" | "W" => {
                let to = self.repeat_word(|at| word_forward(&chars, at, big), n);
                self.go(to, false)
            }
            "b" | "B" => {
                let to = self.repeat_word(|at| word_back(&chars, at, big), n);
                self.go(to, false)
            }
            "e" | "E" => {
                let to = self.repeat_word(|at| word_end(&chars, at, big), n);
                self.go(to, true)
            }
            "f" | "F" | "t" | "T" => {
                self.wait = Some(Wait::Find(key.chars().next().unwrap()));
                LineResult::default()
            }
            ";" | "," => {
                let Some((cmd, ch)) = self.last_find else { return self.cancel() };
                let flipped = if cmd.is_lowercase() { cmd.to_ascii_uppercase() } else { cmd.to_ascii_lowercase() };
                self.find(if key == ";" { cmd } else { flipped }, ch, n, true)
            }
            "g" => {
                self.wait = Some(Wait::G);
                LineResult::default()
            }
            _ => self.cancel(),
        }
    }

    fn cancel(&mut self) -> LineResult {
        self.clear_pending();
        LineResult::default()
    }

    fn find(&mut self, cmd: char, ch: char, n: usize, again: bool) -> LineResult {
        let forward = cmd == 'f' || cmd == 't';
        let till = cmd == 't' || cmd == 'T';
        let step: isize = if forward { 1 } else { -1 };
        let len = self.chars.len() as isize;
        let mut i = self.pos as isize;
        if again && till {
            i += step;
        }
        for _ in 0..n {
            i += step;
            while i >= 0 && i < len && self.chars[i as usize] != ch {
                i += step;
            }
            if i < 0 || i >= len {
                return self.cancel();
            }
        }
        let to = if till { i - step } else { i };
        self.go(to.max(0) as usize, forward)
    }

    fn after_wait(&mut self, w: Wait, key: &str) -> LineResult {
        let ch = if key == "<Space>" { " " } else { key };
        let one = ch.chars().count() == 1;
        if !one && w != Wait::G {
            return self.cancel();
        }
        let c = ch.chars().next().unwrap_or(' ');
        match w {
            Wait::Register => LineResult::default(),
            Wait::Find(cmd) => {
                self.last_find = Some((cmd, c));
                let n = self.times();
                self.find(cmd, c, n, false)
            }
            Wait::Replace => {
                let n = self.times();
                self.replace(c, n)
            }
            Wait::Object(around) => match self.text_object(c, around) {
                Some((a, b)) => self.apply(a, b),
                None => self.cancel(),
            },
            Wait::G => {
                if key == "e" || key == "E" {
                    let chars = self.chars.clone();
                    let big = key == "E";
                    let to = self.repeat_word(|at| word_end_back(&chars, at, big), self.times());
                    return self.go(to, true);
                }
                if key == "g" {
                    return self.go(0, false);
                }
                self.cancel()
            }
        }
    }

    fn go(&mut self, to: usize, inclusive: bool) -> LineResult {
        if self.op.is_none() {
            self.pos = to;
            self.clear_pending();
            return LineResult::default();
        }
        let inc = usize::from(inclusive);
        if to < self.pos { self.apply(to, self.pos + inc) } else { self.apply(self.pos, to + inc) }
    }

    fn snapshot(&mut self) {
        self.undo.push(Snap { text: self.chars.clone(), pos: self.pos });
        self.redo.clear();
        self.changed_now = true;
    }

    fn apply(&mut self, a: usize, b: usize) -> LineResult {
        let op = self.op;
        let b = b.min(self.chars.len());
        let a = a.min(b);
        let taken: String = self.chars[a..b].iter().collect();
        self.clear_pending();
        if op == Some(Op::Y) {
            self.register = taken.clone();
            self.pos = a;
            return LineResult { yanked: Some(taken), ..Default::default() };
        }
        if !taken.is_empty() {
            self.snapshot();
            self.register = taken;
            self.chars.drain(a..b);
        }
        self.pos = a;
        if op != Some(Op::C) {
            return LineResult::default();
        }
        self.change_open = true;
        exit(LineExit::Insert)
    }

    fn replace(&mut self, ch: char, n: usize) -> LineResult {
        if self.pos + n > self.chars.len() {
            return self.cancel();
        }
        self.snapshot();
        for i in 0..n {
            self.chars[self.pos + i] = ch;
        }
        self.pos += n - 1;
        self.clear_pending();
        LineResult::default()
    }

    fn toggle_case(&mut self, n: usize) -> LineResult {
        self.snapshot();
        let end = self.chars.len().min(self.pos + n);
        for i in self.pos..end {
            let c = self.chars[i];
            let lower: String = c.to_lowercase().collect();
            let flipped: String = if c.to_string() == lower { c.to_uppercase().collect() } else { lower };
            if flipped.chars().count() == 1 {
                self.chars[i] = flipped.chars().next().unwrap();
            }
        }
        self.pos = end;
        self.clear_pending();
        LineResult::default()
    }

    fn put(&mut self, after: bool, n: usize) -> LineResult {
        let pasted: Vec<char> = self.register.repeat(n).chars().collect();
        self.clear_pending();
        if pasted.is_empty() {
            return LineResult::default();
        }
        self.snapshot();
        let at = if after && !self.chars.is_empty() { self.pos + 1 } else { self.pos };
        let at = at.min(self.chars.len());
        let k = pasted.len();
        self.chars.splice(at..at, pasted);
        self.pos = at + k - 1;
        LineResult::default()
    }

    fn join(&mut self) -> LineResult {
        self.clear_pending();
        let Some(i) = self.chars.iter().skip(self.pos).position(|&c| c == '\n').map(|i| i + self.pos) else { return LineResult::default() };
        self.snapshot();
        self.chars[i] = ' ';
        self.pos = i;
        LineResult::default()
    }

    fn history(&mut self, undo: bool) -> LineResult {
        self.clear_pending();
        let state = if undo { self.undo.pop() } else { self.redo.pop() };
        let Some(state) = state else { return LineResult::default() };
        let now = Snap { text: self.chars.clone(), pos: self.pos };
        if undo { self.redo.push(now) } else { self.undo.push(now) }
        self.chars = state.text;
        self.pos = state.pos;
        LineResult::default()
    }

    fn repeat(&mut self) -> LineResult {
        self.clear_pending();
        let Some(keys) = self.last_change.clone() else { return LineResult::default() };
        self.typed.clear();
        self.replaying = true;
        for k in &keys {
            self.feed(k);
        }
        self.replaying = false;
        self.typed.clear();
        self.changed_now = false;
        LineResult::default()
    }

    fn text_object(&self, ch: char, around: bool) -> Option<(usize, usize)> {
        match ch {
            'w' | 'W' => self.word_object(ch == 'W', around),
            '"' | '\'' | '`' => self.quote_object(ch, around),
            _ => pair(ch).and_then(|(o, c)| self.pair_object(o, c, around)),
        }
    }

    fn word_object(&self, big: bool, around: bool) -> Option<(usize, usize)> {
        let c = &self.chars;
        if c.is_empty() {
            return None;
        }
        let pos = self.pos.min(c.len() - 1);
        let cls = char_class(c[pos], big);
        let (mut a, mut b) = (pos, pos + 1);
        while a > 0 && char_class(c[a - 1], big) == cls {
            a -= 1;
        }
        while b < c.len() && char_class(c[b], big) == cls {
            b += 1;
        }
        if !around {
            return Some((a, b));
        }
        if cls == 0 {
            if b < c.len() {
                let w = char_class(c[b], big);
                while b < c.len() && char_class(c[b], big) == w {
                    b += 1;
                }
            }
            return Some((a, b));
        }
        let end = b;
        while b < c.len() && c[b].is_whitespace() {
            b += 1;
        }
        if b == end {
            while a > 0 && c[a - 1].is_whitespace() {
                a -= 1;
            }
        }
        Some((a, b))
    }

    fn quote_object(&self, q: char, around: bool) -> Option<(usize, usize)> {
        let at: Vec<usize> = self.chars.iter().enumerate().filter(|(_, c)| **c == q).map(|(i, _)| i).collect();
        let mut i = 0;
        while i + 1 < at.len() {
            let (open, close) = (at[i], at[i + 1]);
            i += 2;
            if self.pos > close {
                continue;
            }
            if !around {
                return Some((open + 1, close));
            }
            let mut end = close + 1;
            while end < self.chars.len() && self.chars[end].is_whitespace() {
                end += 1;
            }
            return Some((open, end));
        }
        None
    }

    fn pair_object(&self, open: char, close: char, around: bool) -> Option<(usize, usize)> {
        let c = &self.chars;
        let mut depth = 0i32;
        let mut a = self.pos as isize;
        if c.get(self.pos) != Some(&open) {
            if c.get(self.pos) == Some(&close) {
                a -= 1;
            }
            while a >= 0 {
                let ch = c[a as usize];
                if ch == close {
                    depth += 1;
                } else if ch == open {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                a -= 1;
            }
            if a < 0 {
                return None;
            }
        }
        let a = a as usize;
        depth = 0;
        let mut b = a + 1;
        while b < c.len() {
            if c[b] == open {
                depth += 1;
            } else if c[b] == close {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            b += 1;
        }
        if b >= c.len() {
            return None;
        }
        Some(if around { (a, b + 1) } else { (a + 1, b) })
    }
}

fn exit(e: LineExit) -> LineResult {
    LineResult { exit: Some(e), ..Default::default() }
}

/// The prompt or the command line while typing: its text and where the cursor is, in characters.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct LineBuffer {
    pub chars: Vec<char>,
    pub pos: usize,
}

impl LineBuffer {
    pub fn new(text: &str, pos: usize) -> LineBuffer {
        let chars: Vec<char> = text.chars().collect();
        let pos = pos.min(chars.len());
        LineBuffer { chars, pos }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    /// Replace the text; the cursor goes to the end.
    pub fn set(&mut self, value: &str) {
        self.chars = value.chars().collect();
        self.pos = self.chars.len();
    }

    /// The text before the cursor, the character under it (a space past the end), and the rest.
    pub fn parts(&self) -> (String, String, String) {
        let before = self.chars[..self.pos].iter().collect();
        let under = self.chars.get(self.pos).map(|c| c.to_string()).unwrap_or_else(|| " ".into());
        let rest = self.chars.get(self.pos + 1..).map(|r| r.iter().collect()).unwrap_or_default();
        (before, under, rest)
    }

    pub fn insert(&mut self, text: &str) {
        let add: Vec<char> = text.chars().collect();
        let n = add.len();
        self.chars.splice(self.pos..self.pos, add);
        self.pos += n;
    }

    /// <BS>: false when there's nothing before the cursor.
    pub fn backspace(&mut self) -> bool {
        if self.pos == 0 {
            return false;
        }
        self.pos -= 1;
        self.chars.remove(self.pos);
        true
    }

    /// <Del>
    pub fn delete_forward(&mut self) {
        if self.pos < self.chars.len() {
            self.chars.remove(self.pos);
        }
    }

    /// <C-w>: the word before the cursor, and the blanks after it.
    pub fn delete_word_back(&mut self) {
        let mut n = self.pos;
        while n > 0 && self.chars[n - 1].is_whitespace() {
            n -= 1;
        }
        while n > 0 && !self.chars[n - 1].is_whitespace() {
            n -= 1;
        }
        self.chars.drain(n..self.pos);
        self.pos = n;
    }

    /// <C-u>: everything before the cursor.
    pub fn delete_to_start(&mut self) {
        self.chars.drain(..self.pos);
        self.pos = 0;
    }

    pub fn move_to(&mut self, to: &str) {
        let len = self.chars.len();
        self.pos = match to {
            "left" => self.pos.saturating_sub(1),
            "right" => len.min(self.pos + 1),
            "home" => 0,
            "end" => len,
            "word_left" => word_back(&self.chars, self.pos, true),
            _ => word_forward(&self.chars, self.pos, true),
        };
    }
}

/// <Up> and <Down> through earlier lines, like vim's command-line history:
/// only the ones that start with what was typed, and back to what was typed
/// past the newest.
#[derive(Default)]
pub struct HistoryWalk {
    at: isize,
    prefix: String,
    draft: String,
    shown: String,
    started: bool,
}

impl HistoryWalk {
    /// The line `dir` steps away (-1 older, 1 newer), or None. `entries` are oldest first.
    pub fn step(&mut self, entries: &[String], current: &str, dir: i32) -> Option<String> {
        if !self.started {
            self.at = -1;
            self.started = true;
        }
        if self.at >= 0 && current != self.shown {
            self.at = -1;
        }
        if self.at < 0 {
            if dir > 0 {
                return None;
            }
            self.draft = current.to_string();
            self.prefix = current.to_string();
            self.at = entries.len() as isize;
        }
        let mut i = self.at + dir as isize;
        while i >= 0 && (i as usize) < entries.len() {
            let e = &entries[i as usize];
            if e.starts_with(&self.prefix) && e != current {
                self.at = i;
                self.shown = e.clone();
                return Some(e.clone());
            }
            i += dir as isize;
        }
        if dir < 0 {
            return None;
        }
        self.at = -1;
        Some(self.draft.clone())
    }
}

/// Add a line to a history: the newest last, an earlier copy dropped, at most 200 kept.
pub fn remember(history: &mut Vec<String>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    history.retain(|h| h != line);
    history.push(line.to_string());
    if history.len() > 200 {
        let extra = history.len() - 200;
        history.drain(..extra);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed(text: &str, pos: usize) -> LineEditor {
        let mut e = LineEditor::default();
        e.sync(text, pos);
        e
    }

    fn keys(e: &mut LineEditor, ks: &[&str]) -> LineResult {
        let mut last = LineResult::default();
        for k in ks {
            last = e.feed(k);
        }
        last
    }

    #[test]
    fn motions_and_operators() {
        let mut e = ed("fix the flaky test", 0);
        keys(&mut e, &["w"]);
        assert_eq!(e.pos, 4);
        keys(&mut e, &["d", "w"]);
        assert_eq!(e.text(), "fix flaky test");
        keys(&mut e, &["u"]);
        assert_eq!(e.text(), "fix the flaky test");
        keys(&mut e, &["<C-r>"]);
        assert_eq!(e.text(), "fix flaky test");
        keys(&mut e, &["$"]);
        assert_eq!(e.pos, 13);
        keys(&mut e, &["0", "c", "w"]);
        assert_eq!(e.text(), " flaky test");
        let mut e = ed("call(a, b)", 6);
        let r = keys(&mut e, &["d", "i", "("]);
        assert_eq!(e.text(), "call()");
        assert_eq!(r.exit, None);
        assert_eq!(e.register, "a, b");
        let mut e = ed("say \"hi there\" now", 6);
        keys(&mut e, &["c", "i", "\""]);
        assert_eq!(e.text(), "say \"\" now");
        let mut e = ed("abc abc", 0);
        keys(&mut e, &["x", "."]);
        assert_eq!(e.text(), "c abc");
        let mut e = ed("a-b c", 0);
        keys(&mut e, &["f", "c"]);
        assert_eq!(e.pos, 4);
        keys(&mut e, &["2", "h"]);
        assert_eq!(e.pos, 2);
        let mut e = ed("hello", 0);
        keys(&mut e, &["y", "w", "P"]);
        assert_eq!(e.text(), "hellohello");
    }

    #[test]
    fn exits_and_history() {
        let mut e = ed("x", 0);
        assert_eq!(keys(&mut e, &["A"]).exit, Some(LineExit::Insert));
        assert_eq!(e.pos, 1);
        assert_eq!(keys(&mut e, &["<CR>"]).exit, Some(LineExit::Submit));
        assert_eq!(keys(&mut e, &["d", "<Esc>"]).exit, None);
        assert_eq!(keys(&mut e, &["<Esc>"]).exit, Some(LineExit::Back));
        assert_eq!(keys(&mut e, &["k"]).history, Some(-1));
        let mut empty = ed("", 0);
        for k in ["x", "d", "w", "p", "~", "J", "r", "a", "e", "b"] {
            empty.feed(k);
        }
    }

    #[test]
    fn line_buffer() {
        let mut l = LineBuffer::new("fix it", 6);
        l.move_to("word_left");
        assert_eq!(l.pos, 4);
        l.insert("all of ");
        assert_eq!(l.text(), "fix all of it");
        l.delete_word_back();
        assert_eq!(l.text(), "fix all it");
        l.move_to("home");
        l.delete_forward();
        assert_eq!(l.parts(), ("".into(), "i".into(), "x all it".into()));
        l.move_to("end");
        assert_eq!(l.parts().1, " ");
        l.move_to("left");
        l.delete_to_start();
        assert_eq!(l.text(), "t");
    }

    #[test]
    fn history_walks_by_prefix() {
        let h: Vec<String> = ["new a", "theme x", "new b"].iter().map(|s| s.to_string()).collect();
        let mut w = HistoryWalk::default();
        assert_eq!(w.step(&h, "new", -1).as_deref(), Some("new b"));
        assert_eq!(w.step(&h, "new b", -1).as_deref(), Some("new a"));
        assert_eq!(w.step(&h, "new a", -1), None);
        assert_eq!(w.step(&h, "new a", 1).as_deref(), Some("new b"));
        assert_eq!(w.step(&h, "new b", 1).as_deref(), Some("new"));
        let mut hist = vec!["a".to_string(), "b".to_string()];
        remember(&mut hist, "a");
        assert_eq!(hist, vec!["b", "a"]);
    }
}
