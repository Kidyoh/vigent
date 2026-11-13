//! A small TOML reader (TOML 1.0, plus 1.1's newlines in inline tables) for
//! config.toml, .vigent.toml and theme files: text in, [`Val`] out, tables in
//! the order they're written. A parser crate costs ~170 KB of the binary;
//! this is a few hundred lines. Edits that keep comments are line-based, as
//! in src/config-edit.ts, so nothing here needs to write TOML back.

/// A TOML value (tables keep their order).
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Arr(Vec<Val>),
    Table(Vec<(String, Val)>),
    /// a date or time, as written: no vigent key takes one
    Other(String),
}

impl Val {
    pub fn as_str(&self) -> Option<&str> {
        if let Val::Str(s) = self { Some(s) } else { None }
    }
    pub fn as_table(&self) -> Option<&[(String, Val)]> {
        if let Val::Table(t) = self { Some(t) } else { None }
    }
    /// a list of strings (None if it's anything else)
    pub fn strings(&self) -> Option<Vec<String>> {
        let Val::Arr(a) = self else { return None };
        a.iter().map(|v| v.as_str().map(str::to_string)).collect()
    }
    /// a non-empty list of strings
    pub fn some_strings(&self) -> Option<Vec<String>> {
        self.strings().filter(|v| !v.is_empty())
    }
    pub fn get(&self, key: &str) -> Option<&Val> {
        self.as_table()?.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

type Table = Vec<(String, Val)>;

/// Parse a document. The error names the line: "line 3: expected a value".
pub fn parse(text: &str) -> Result<Table, String> {
    let mut p = P { s: text.as_bytes(), i: 0 };
    let mut root: Table = vec![];
    // the table that `key = value` lines go into
    let mut current: Vec<String> = vec![];
    let mut defined: Vec<Vec<String>> = vec![];
    loop {
        p.skip_ws_comments_newlines();
        let Some(c) = p.peek() else { break };
        if c == b'[' {
            let array = p.s.get(p.i + 1) == Some(&b'[');
            p.i += if array { 2 } else { 1 };
            p.skip_ws();
            let path = p.key()?;
            p.skip_ws();
            p.expect(b']')?;
            if array {
                p.expect(b']')?;
            }
            p.end_of_line()?;
            let (parent, last) = path.split_at(path.len() - 1);
            let t = table_at(&mut root, parent, p.line())?;
            if array {
                match find(t, &last[0]) {
                    Some(Val::Arr(a)) => a.push(Val::Table(vec![])),
                    Some(_) => return Err(p.err(&format!("'{}' is already a value", last[0]))),
                    None => t.push((last[0].clone(), Val::Arr(vec![Val::Table(vec![])]))),
                }
            } else {
                if defined.contains(&path) {
                    return Err(p.err(&format!("table [{}] is defined twice", path.join("."))));
                }
                defined.push(path.clone());
                match find(t, &last[0]) {
                    Some(Val::Table(_)) => {}
                    Some(_) => return Err(p.err(&format!("'{}' is already a value", last[0]))),
                    None => t.push((last[0].clone(), Val::Table(vec![]))),
                }
            }
            current = path;
            continue;
        }
        let path = p.key()?;
        p.skip_ws();
        p.expect(b'=')?;
        p.skip_ws();
        let v = p.value()?;
        p.end_of_line()?;
        let line = p.line();
        let t = table_at(&mut root, &current, line)?;
        insert(t, &path, v).map_err(|e| format!("line {line}: {e}"))?;
    }
    Ok(root)
}

fn find<'a>(t: &'a mut Table, key: &str) -> Option<&'a mut Val> {
    t.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// The table at `path` under `root`, made as needed (through the last of an array of tables).
fn table_at<'a>(root: &'a mut Table, path: &[String], line: usize) -> Result<&'a mut Table, String> {
    let mut t = root;
    for k in path {
        if find(t, k).is_none() {
            t.push((k.clone(), Val::Table(vec![])));
        }
        t = match find(t, k) {
            Some(Val::Table(inner)) => inner,
            Some(Val::Arr(a)) => match a.last_mut() {
                Some(Val::Table(inner)) => inner,
                _ => return Err(format!("line {line}: '{k}' is not a table")),
            },
            _ => return Err(format!("line {line}: '{k}' is not a table")),
        };
    }
    Ok(t)
}

/// `a.b.c = v` into a table.
fn insert(t: &mut Table, path: &[String], v: Val) -> Result<(), String> {
    let (last, parents) = path.split_last().expect("a key");
    let mut t = t;
    for k in parents {
        if find(t, k).is_none() {
            t.push((k.clone(), Val::Table(vec![])));
        }
        t = match find(t, k) {
            Some(Val::Table(inner)) => inner,
            _ => return Err(format!("'{k}' is not a table")),
        };
    }
    if find(t, last).is_some() {
        return Err(format!("duplicate key '{last}'"));
    }
    t.push((last.clone(), v));
    Ok(())
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn line(&self) -> usize {
        1 + self.s[..self.i.min(self.s.len())].iter().filter(|&&b| b == b'\n').count()
    }
    fn err(&self, msg: &str) -> String {
        format!("line {}: {msg}", self.line())
    }
    fn expect(&mut self, c: u8) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(self.err(&format!("expected '{}'", c as char)))
        }
    }
    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.i += 1;
        }
    }
    fn skip_comment(&mut self) {
        if self.peek() == Some(b'#') {
            while !matches!(self.peek(), None | Some(b'\n')) {
                self.i += 1;
            }
        }
    }
    fn skip_ws_comments_newlines(&mut self) {
        loop {
            self.skip_ws();
            self.skip_comment();
            match self.peek() {
                Some(b'\n' | b'\r') => self.i += 1,
                _ => return,
            }
        }
    }
    fn end_of_line(&mut self) -> Result<(), String> {
        self.skip_ws();
        self.skip_comment();
        match self.peek() {
            None | Some(b'\n') => Ok(()),
            Some(b'\r') if self.s.get(self.i + 1) == Some(&b'\n') => Ok(()),
            _ => Err(self.err("expected the end of the line")),
        }
    }

    /// A key, dotted or not: a.b, "quoted".c, 'literal'
    fn key(&mut self) -> Result<Vec<String>, String> {
        let mut parts = vec![];
        loop {
            self.skip_ws();
            let part = match self.peek() {
                Some(b'"') => self.basic_string()?,
                Some(b'\'') => self.literal_string()?,
                _ => {
                    let start = self.i;
                    while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
                        self.i += 1;
                    }
                    if start == self.i {
                        return Err(self.err("expected a key"));
                    }
                    String::from_utf8_lossy(&self.s[start..self.i]).into_owned()
                }
            };
            parts.push(part);
            self.skip_ws();
            if self.peek() == Some(b'.') {
                self.i += 1;
            } else {
                return Ok(parts);
            }
        }
    }

    fn value(&mut self) -> Result<Val, String> {
        match self.peek() {
            Some(b'"') => Ok(Val::Str(if self.s[self.i..].starts_with(b"\"\"\"") { self.multiline_basic()? } else { self.basic_string()? })),
            Some(b'\'') => Ok(Val::Str(if self.s[self.i..].starts_with(b"'''") { self.multiline_literal()? } else { self.literal_string()? })),
            Some(b'[') => self.array(),
            Some(b'{') => self.inline_table(),
            Some(b't') if self.s[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(Val::Bool(true))
            }
            Some(b'f') if self.s[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(Val::Bool(false))
            }
            Some(c) if c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'i' | b'n') => self.number_or_date(),
            _ => Err(self.err("expected a value")),
        }
    }

    fn escape(&mut self, out: &mut Vec<u8>) -> Result<(), String> {
        let c = self.peek().ok_or_else(|| self.err("unfinished string"))?;
        self.i += 1;
        let simple = match c {
            b'b' => Some(b'\x08'),
            b't' => Some(b'\t'),
            b'n' => Some(b'\n'),
            b'f' => Some(b'\x0c'),
            b'r' => Some(b'\r'),
            b'e' => Some(b'\x1b'),
            b'"' => Some(b'"'),
            b'\\' => Some(b'\\'),
            _ => None,
        };
        if let Some(b) = simple {
            out.push(b);
            return Ok(());
        }
        let n = match c {
            b'x' => 2,
            b'u' => 4,
            b'U' => 8,
            _ => return Err(self.err(&format!("unknown escape '\\{}'", c as char))),
        };
        let hex = self.s.get(self.i..self.i + n).ok_or_else(|| self.err("unfinished escape"))?;
        let code = u32::from_str_radix(std::str::from_utf8(hex).unwrap_or("x"), 16).map_err(|_| self.err("bad escape"))?;
        let ch = char::from_u32(code).ok_or_else(|| self.err("bad escape"))?;
        self.i += n;
        out.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
        Ok(())
    }

    fn basic_string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = vec![];
        loop {
            match self.peek() {
                None | Some(b'\n') => return Err(self.err("unfinished string")),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(String::from_utf8_lossy(&out).into_owned());
                }
                Some(b'\\') => {
                    self.i += 1;
                    self.escape(&mut out)?;
                }
                Some(c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }

    fn literal_string(&mut self) -> Result<String, String> {
        self.i += 1;
        let start = self.i;
        loop {
            match self.peek() {
                None | Some(b'\n') => return Err(self.err("unfinished string")),
                Some(b'\'') => {
                    let s = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                    self.i += 1;
                    return Ok(s);
                }
                _ => self.i += 1,
            }
        }
    }

    fn skip_first_newline(&mut self) {
        if self.s[self.i..].starts_with(b"\r\n") {
            self.i += 2;
        } else if self.peek() == Some(b'\n') {
            self.i += 1;
        }
    }

    fn multiline_basic(&mut self) -> Result<String, String> {
        self.i += 3;
        self.skip_first_newline();
        let mut out = vec![];
        loop {
            if self.s[self.i..].starts_with(b"\"\"\"") {
                // up to two quotes may end the content: """a""""" is a""
                let mut n = 3;
                while self.s.get(self.i + n) == Some(&b'"') && n < 5 {
                    n += 1;
                }
                out.extend(std::iter::repeat_n(b'"', n - 3));
                self.i += n;
                return Ok(String::from_utf8_lossy(&out).into_owned());
            }
            match self.peek() {
                None => return Err(self.err("unfinished string")),
                Some(b'\\') => {
                    self.i += 1;
                    // a line-ending backslash: drop it and the whitespace after it
                    let mut j = self.i;
                    while matches!(self.s.get(j), Some(b' ' | b'\t')) {
                        j += 1;
                    }
                    if matches!(self.s.get(j), Some(b'\n' | b'\r')) {
                        self.i = j;
                        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                            self.i += 1;
                        }
                    } else {
                        self.escape(&mut out)?;
                    }
                }
                Some(c) => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }

    fn multiline_literal(&mut self) -> Result<String, String> {
        self.i += 3;
        self.skip_first_newline();
        let start = self.i;
        loop {
            if self.s[self.i..].starts_with(b"'''") {
                let mut n = 3;
                while self.s.get(self.i + n) == Some(&b'\'') && n < 5 {
                    n += 1;
                }
                let s = String::from_utf8_lossy(&self.s[start..self.i + n - 3]).into_owned();
                self.i += n;
                return Ok(s);
            }
            if self.peek().is_none() {
                return Err(self.err("unfinished string"));
            }
            self.i += 1;
        }
    }

    fn number_or_date(&mut self) -> Result<Val, String> {
        let start = self.i;
        while let Some(c) = self.peek() {
            let date_space = c == b' ' && self.i - start == 10 && self.s.get(self.i + 1).is_some_and(u8::is_ascii_digit) && self.s[start..self.i].contains(&b'-');
            if c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.' | b'_' | b':') || date_space {
                self.i += 1;
            } else {
                break;
            }
        }
        let raw = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("");
        let body = raw.trim_start_matches(['+', '-']);
        let neg = raw.starts_with('-');
        // a date or a time: 1979-05-27, 07:32:00, 1979-05-27T07:32:00Z
        if (raw.len() >= 8 && raw.as_bytes().get(4) == Some(&b'-') && !raw.starts_with(['+', '-'])) || raw.contains(':') {
            return Ok(Val::Other(raw.to_string()));
        }
        let bad = || self.err(&format!("'{raw}' is not a value"));
        match body {
            "inf" => return Ok(Val::Float(if neg { f64::NEG_INFINITY } else { f64::INFINITY })),
            "nan" => return Ok(Val::Float(f64::NAN)),
            _ => {}
        }
        if body.contains("__") || body.starts_with('_') || body.ends_with('_') {
            return Err(bad());
        }
        let clean = body.replace('_', "");
        for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
            if let Some(digits) = clean.strip_prefix(prefix) {
                if raw.starts_with(['+', '-']) {
                    return Err(bad());
                }
                return i64::from_str_radix(digits, radix).map(Val::Int).map_err(|_| bad());
            }
        }
        let sign = if neg { "-" } else { "" };
        if clean.contains(['.', 'e', 'E']) {
            return format!("{sign}{clean}").parse::<f64>().map(Val::Float).map_err(|_| bad());
        }
        if clean.len() > 1 && clean.starts_with('0') {
            return Err(bad());
        }
        format!("{sign}{clean}").parse::<i64>().map(Val::Int).map_err(|_| bad())
    }

    fn array(&mut self) -> Result<Val, String> {
        self.i += 1;
        let mut out = vec![];
        loop {
            self.skip_ws_comments_newlines();
            if self.peek() == Some(b']') {
                self.i += 1;
                return Ok(Val::Arr(out));
            }
            out.push(self.value()?);
            self.skip_ws_comments_newlines();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {}
                _ => return Err(self.err("expected ',' or ']' in a list")),
            }
        }
    }

    fn inline_table(&mut self) -> Result<Val, String> {
        self.i += 1;
        let mut t: Table = vec![];
        loop {
            self.skip_ws_comments_newlines();
            if self.peek() == Some(b'}') {
                self.i += 1;
                return Ok(Val::Table(t));
            }
            let path = self.key()?;
            self.skip_ws();
            self.expect(b'=')?;
            self.skip_ws();
            let v = self.value()?;
            insert(&mut t, &path, v).map_err(|e| self.err(&e))?;
            self.skip_ws_comments_newlines();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {}
                _ => return Err(self.err("expected ',' or '}' in an inline table")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(t: &'a Table, path: &str) -> &'a Val {
        let mut v: Option<&Val> = None;
        for k in path.split('.') {
            let table: &[(String, Val)] = match v {
                None => t,
                Some(x) => x.as_table().unwrap(),
            };
            v = Some(&table.iter().find(|(n, _)| n == k).unwrap_or_else(|| panic!("no {k} in {path}")).1);
        }
        v.unwrap()
    }

    #[test]
    fn reads_what_config_files_hold() {
        let t = parse(
            r#"
# vigent
theme = "tokyo\tnight" # a comment
leader = '<Space>'
n = 1_000
neg = -3
hex = 0xff
f = 6.5e-1
yes = true
when = 1979-05-27 07:32:00Z
multi = """
one \
   two"""
lit = '''C:\path'''
a.b = "dotted"

[ui]
sidebar_width = 40
list = [
  "a", # one
  'b',
]

[engines.claude]
args = ["--permission-mode", "acceptEdits"]

[keys.normal]
"<leader>n" = ":new "
"q" = false

[highlights]
Normal = { bg = "NONE", bold = true }

[[pick]]
x = 1
[[pick]]
x = 2
"#,
        )
        .unwrap();
        assert_eq!(get(&t, "theme"), &Val::Str("tokyo\tnight".into()));
        assert_eq!(get(&t, "leader"), &Val::Str("<Space>".into()));
        assert_eq!(get(&t, "n"), &Val::Int(1000));
        assert_eq!(get(&t, "neg"), &Val::Int(-3));
        assert_eq!(get(&t, "hex"), &Val::Int(255));
        assert_eq!(get(&t, "f"), &Val::Float(0.65));
        assert_eq!(get(&t, "yes"), &Val::Bool(true));
        assert!(matches!(get(&t, "when"), Val::Other(_)));
        assert_eq!(get(&t, "multi"), &Val::Str("one two".into()));
        assert_eq!(get(&t, "lit"), &Val::Str("C:\\path".into()));
        assert_eq!(get(&t, "a.b"), &Val::Str("dotted".into()));
        assert_eq!(get(&t, "ui.sidebar_width"), &Val::Int(40));
        assert_eq!(get(&t, "ui.list").strings().unwrap(), ["a", "b"]);
        assert_eq!(get(&t, "engines.claude.args").strings().unwrap(), ["--permission-mode", "acceptEdits"]);
        assert_eq!(get(&t, "keys.normal.<leader>n"), &Val::Str(":new ".into()));
        assert_eq!(get(&t, "keys.normal.q"), &Val::Bool(false));
        assert_eq!(get(&t, "highlights.Normal.bold"), &Val::Bool(true));
        let Val::Arr(picks) = get(&t, "pick") else { panic!() };
        assert_eq!(picks.len(), 2);
        // the order they're written in
        let keys: Vec<&str> = t.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(&keys[..3], ["theme", "leader", "n"]);
    }

    #[test]
    fn mistakes_name_their_line() {
        assert_eq!(parse("theme = \n").unwrap_err(), "line 1: expected a value");
        assert!(parse("a = 1\na = 2\n").unwrap_err().contains("line 2: duplicate key 'a'"));
        assert!(parse("[ui]\nx = 1\n[ui]\n").unwrap_err().contains("defined twice"));
        assert!(parse("s = \"open\n").unwrap_err().contains("unfinished string"));
        assert!(parse("x = 1 2\n").is_err());
        assert!(parse("x = 01\n").is_err());
    }
}
