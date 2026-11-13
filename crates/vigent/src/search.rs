//! Transcript search, like Neovim's with 'incsearch', 'hlsearch' and
//! 'smartcase' (src/search.ts): where a term occurs, in order, wrapping.

/// smartcase: case-insensitive unless the term has a capital letter
fn fold(term: &str, text: &str) -> String {
    if term.chars().any(|c| c.is_ascii_uppercase()) { text.to_string() } else { text.to_lowercase() }
}

/// Where `term` starts in `text` (char indices), every time, not overlapping.
pub fn occurrences(term: &str, text: &str) -> Vec<usize> {
    if term.is_empty() {
        return vec![];
    }
    let needle: Vec<char> = fold(term, term).chars().collect();
    let hay: Vec<char> = fold(term, text).chars().collect();
    let mut out = vec![];
    let mut at = 0;
    while at + needle.len() <= hay.len() {
        if hay[at..at + needle.len()] == needle[..] {
            out.push(at);
            at += needle.len();
        } else {
            at += 1;
        }
    }
    out
}

/// One match: the `n`th occurrence on pane line `line`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub line: usize,
    pub n: i64,
}

pub fn find_hits<'a>(term: &str, lines: impl Iterator<Item = &'a str>) -> Vec<Hit> {
    let mut out = vec![];
    for (line, plain) in lines.enumerate() {
        for n in 0..occurrences(term, plain).len() {
            out.push(Hit { line, n: n as i64 });
        }
    }
    out
}

fn before(a: &Hit, b: &Hit) -> bool {
    a.line < b.line || (a.line == b.line && a.n < b.n)
}

/// The next match after `from` (before it when dir is -1), wrapping like
/// 'wrapscan'. `nth` counts from 1.
pub fn next_hit(hits: &[Hit], from: Hit, dir: i32) -> Option<(Hit, usize, bool)> {
    if hits.is_empty() {
        return None;
    }
    let found = if dir > 0 { hits.iter().position(|h| before(&from, h)) } else { hits.iter().rposition(|h| before(h, &from)) };
    let wrapped = found.is_none();
    let i = found.unwrap_or(if dir > 0 { 0 } else { hits.len() - 1 });
    Some((hits[i], i + 1, wrapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smartcase_order_and_wrapscan() {
        assert_eq!(occurrences("ab", "Ab ab AB"), vec![0, 3, 6]);
        assert_eq!(occurrences("Ab", "Ab ab AB"), vec![0]);
        assert_eq!(occurrences("aa", "aaaa"), vec![0, 2]);
        let lines = ["foo", "bar foo foo", "x"];
        let hits = find_hits("foo", lines.iter().copied());
        assert_eq!(hits.len(), 3);
        assert_eq!(next_hit(&hits, Hit { line: 0, n: 0 }, 1), Some((Hit { line: 1, n: 0 }, 2, false)));
        assert_eq!(next_hit(&hits, Hit { line: 1, n: 1 }, 1), Some((Hit { line: 0, n: 0 }, 1, true)));
        assert_eq!(next_hit(&hits, Hit { line: 0, n: 0 }, -1), Some((Hit { line: 1, n: 1 }, 3, true)));
    }
}
