//! "Did you mean ...?" for typos in action and theme names (src/suggest.ts).

fn distance(a: &[char], b: &[char]) -> usize {
    let mut dp: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = dp[0];
        dp[0] = i;
        for j in 1..=b.len() {
            let tmp = dp[j];
            dp[j] = (dp[j] + 1).min(dp[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = tmp;
        }
    }
    dp[b.len()]
}

/// The closest candidate within a few edits.
pub fn closest<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let mut best = None;
    let mut score = 2.max(name.chars().count() / 3) + 1;
    for c in candidates {
        let d = distance(&n, &c.to_lowercase().chars().collect::<Vec<_>>());
        if d < score {
            best = Some(c);
            score = d;
        }
    }
    best
}

pub fn did_you_mean<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> String {
    closest(name, candidates).map(|c| format!(" (did you mean '{c}'?)")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn close_names() {
        assert_eq!(super::did_you_mean("gruvbx", ["gruvbox", "nord"]), " (did you mean 'gruvbox'?)");
        assert_eq!(super::did_you_mean("zzzzzz", ["gruvbox", "nord"]), "");
    }
}
