//! An agent's text made safe to draw inside a window (src/printable.ts):
//! a terminal acts on control characters instead of showing them, so tabs
//! become two spaces, a lone `\r` keeps what came after it (what a progress
//! bar ends up showing), and every escape sequence and control character is
//! dropped. (The TypeScript keeps colors and links in the string; here text
//! is styled by spans, so they go too.) And `one_row`: a screen row as the
//! terminal must get it (src/app.ts oneRow).

/// Text with no escape sequences or control characters but newlines.
pub fn printable(text: &str) -> String {
    if !text.chars().any(is_control) {
        return text.to_string();
    }
    let text = text.replace("\r\n", "\n");
    let stripped = strip_escapes(&text);
    let mut out = String::with_capacity(stripped.len());
    for (i, line) in stripped.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let line = match line.rfind('\r') {
            Some(at) => &line[at + 1..],
            None => line,
        };
        for c in line.chars() {
            match c {
                '\t' => out.push_str("  "),
                c if is_control(c) => {}
                c => out.push(c),
            }
        }
    }
    out
}

fn is_control(c: char) -> bool {
    let n = c as u32;
    (n <= 0x1f && c != '\n') || (0x7f..=0x9f).contains(&n)
}

/// CSI, OSC, DCS/SOS/PM/APC strings and two-byte escapes, removed.
pub fn strip_escapes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\x1b' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        match chars.get(i) {
            Some('[') => {
                i += 1;
                while i < chars.len() && ('0'..='?').contains(&chars[i]) {
                    i += 1;
                }
                while i < chars.len() && (' '..='/').contains(&chars[i]) {
                    i += 1;
                }
                if i < chars.len() && ('@'..='~').contains(&chars[i]) {
                    i += 1;
                }
            }
            Some(']') => {
                i += 1;
                while i < chars.len() && chars[i] != '\x07' && chars[i] != '\x1b' {
                    i += 1;
                }
                if chars.get(i) == Some(&'\x07') {
                    i += 1;
                } else if chars.get(i) == Some(&'\x1b') && chars.get(i + 1) == Some(&'\\') {
                    i += 2;
                }
            }
            Some('P' | 'X' | '^' | '_') => {
                i += 1;
                while i < chars.len() && chars[i] != '\x1b' {
                    i += 1;
                }
                if chars.get(i + 1) == Some(&'\\') {
                    i += 2;
                }
            }
            _ => {
                while i < chars.len() && (' '..='/').contains(&chars[i]) {
                    i += 1;
                }
                if i < chars.len() && ('0'..='~').contains(&chars[i]) {
                    i += 1;
                }
            }
        }
    }
    out
}

/// One row: newlines, carriage returns and tabs become spaces; other cursor movers go.
pub fn one_row(line: &str) -> String {
    if !line.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
        return line.to_string();
    }
    let line = line.replace("\r\n", " ");
    line.chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if ((c as u32) < 0x20 && c != '\x1b' && c != '\x07') || c == '\x7f' => None,
            c => Some(c),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_go_text_stays() {
        assert_eq!(printable("plain"), "plain");
        assert_eq!(printable("a\tb"), "a  b");
        assert_eq!(printable("progress 10%\rprogress 100%\nnext"), "progress 100%\nnext");
        assert_eq!(printable("\x1b[31mred\x1b[0m\r\n\x1b]8;;http://x\x07link\x1b]8;;\x07"), "red\nlink");
        assert_eq!(printable("a\x1b[2Kb\x07c"), "abc");
        assert_eq!(one_row("cat <<EOF\nmulti\tx\r"), "cat <<EOF multi x ");
    }
}
