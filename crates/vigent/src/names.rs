//! Agent and branch names, the same rules as src/app.ts (agentNameFrom) and
//! src/worktree.ts (slugify, branchName).

/// The agent's name from its first prompt: up to five words, filler dropped.
///   "write a hello file" -> "write hello file"
pub fn agent_name_from(prompt: &str) -> String {
    let lowered: String = prompt
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '`' | '\'' | '"' | '“' | '”' | '‘' | '’'))
        .collect();
    let spaced: String = lowered
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '/' { c } else { ' ' })
        .collect();
    const FILLER: [&str; 9] = ["please", "pls", "can", "you", "could", "would", "the", "a", "an"];
    let words: Vec<&str> = spaced.split_whitespace().filter(|w| !FILLER.contains(w)).take(5).collect();
    if words.is_empty() { "agent".to_string() } else { words.join(" ") }
}

/// lowercase, ascii, hyphen-separated, at most `max` characters (cut on a word boundary)
pub fn slugify(text: &str, max: usize) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !slug.is_empty() {
                slug.push('-');
            }
            dash = false;
            slug.push(c);
        } else {
            dash = true;
        }
    }
    if slug.len() <= max {
        return slug;
    }
    let cut = &slug[..max + 1];
    let out = match cut.rfind('-') {
        Some(b) if b > 8 => &cut[..b],
        _ => &slug[..max],
    };
    out.trim_end_matches('-').to_string()
}

fn branch_type(word: &str) -> Option<&'static str> {
    Some(match word {
        "feat" | "feature" => "feat",
        "fix" | "bugfix" | "hotfix" | "bug" => "fix",
        "docs" | "doc" => "docs",
        "refactor" => "refactor",
        "test" | "tests" => "test",
        "chore" => "chore",
        "perf" => "perf",
        "ci" => "ci",
        "build" => "build",
        "style" => "style",
        _ => return None,
    })
}

/// A conventional branch name for an agent:
///   "fix flaky checkout test" -> fix/flaky-checkout-test
///   "auth-refactor"           -> refactor/auth
///   "add dark mode"           -> feat/add-dark-mode
///   "release/v2-notes"        -> release/v2-notes
pub fn branch_name(agent: &str) -> String {
    if agent.contains('/') {
        let parts: Vec<String> = agent.split('/').map(|p| slugify(p, 48)).filter(|p| !p.is_empty()).collect();
        if !parts.is_empty() {
            return parts.join("/");
        }
    }
    let slug = slugify(agent, 200);
    let mut words: Vec<&str> = slug.split('-').filter(|w| !w.is_empty()).collect();
    let mut kind = "feat";
    if words.len() > 1 {
        if let Some(t) = branch_type(words[0]) {
            kind = t;
            words.remove(0);
        } else if let Some(t) = branch_type(words[words.len() - 1]) {
            kind = t;
            words.pop();
        }
    }
    let name = slugify(&words.join("-"), 48);
    format!("{kind}/{}", if name.is_empty() { "agent" } else { &name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_typescript_rules() {
        assert_eq!(agent_name_from("write a hello file"), "write hello file");
        assert_eq!(agent_name_from("Can you please fix the flaky checkout test, thanks"), "fix flaky checkout test thanks");
        assert_eq!(agent_name_from("  ?? "), "agent");
        assert_eq!(branch_name("write hello file"), "feat/write-hello-file");
        assert_eq!(branch_name("fix flaky checkout test"), "fix/flaky-checkout-test");
        assert_eq!(branch_name("auth-refactor"), "refactor/auth");
        assert_eq!(branch_name("docs: readme flags"), "docs/readme-flags");
        assert_eq!(branch_name("release/v2-notes"), "release/v2-notes");
        assert_eq!(slugify("a very long name that goes on and on and on past the limit of the slug", 48).len() <= 48, true);
    }
}
