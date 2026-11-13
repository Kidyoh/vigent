//! Edit config.toml in place for `:settings` and `:permissions`: change one
//! value and keep everything else (comments, order, other keys) as the user
//! wrote it (src/config-edit.ts).

/// A TOML string value (JSON's quoting is TOML's basic string).
pub fn toml_str(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// A TOML key: bare when it can be, quoted otherwise (`"<leader>n"`).
pub fn toml_key(k: &str) -> String {
    if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { k.to_string() } else { toml_str(k) }
}

/// `[section]` on this line (with an optional comment after it): the section's name.
fn header(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = t.strip_prefix('[')?;
    let close = rest.find(']')?;
    let name = &rest[..close];
    if name.is_empty() || name.contains('[') {
        return None;
    }
    let after = rest[close + 1..].trim_start();
    if after.is_empty() || after.starts_with('#') { Some(name) } else { None }
}

/// `key =` (or `# key =`) starts this line.
fn is_key_line(line: &str, key: &str) -> bool {
    let mut t = line.trim_start();
    if let Some(r) = t.strip_prefix('#') {
        t = r.trim_start();
    }
    t.strip_prefix(key).is_some_and(|r| r.trim_start().starts_with('='))
}

fn commented(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

/// Set `key = value` in `[section]` (or at the top level when section is
/// None). A commented-out line for the same key (`# key = …`) is replaced in
/// place, so the setting stays where the template documents it.
pub fn set_toml_value(text: &str, section: Option<&str>, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = if text.is_empty() { vec![] } else { text.strip_suffix('\n').unwrap_or(text).split('\n').map(str::to_string).collect() };
    let k = toml_key(key);
    let line = format!("{k} = {value}");
    let mut start = 0;
    let mut end = lines.iter().position(|l| header(l).is_some()).unwrap_or(lines.len());
    if let Some(section) = section {
        let Some(at) = lines.iter().position(|l| header(l).map(str::trim) == Some(section)) else {
            // a new section at the end
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(format!("[{section}]"));
            lines.push(line);
            return format!("{}\n", lines.join("\n"));
        };
        start = at + 1;
        end = (start..lines.len()).find(|&i| header(&lines[i]).is_some()).unwrap_or(lines.len());
    }
    let live = (start..end).find(|&i| is_key_line(&lines[i], &k) && !commented(&lines[i]));
    let off = (start..end).find(|&i| is_key_line(&lines[i], &k) && commented(&lines[i]));
    match live.or(off) {
        Some(at) => lines[at] = line,
        None => {
            // after the last non-blank line of the section
            let mut insert = end;
            while insert > start && lines[insert - 1].trim().is_empty() {
                insert -= 1;
            }
            lines.insert(insert, line);
        }
    }
    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_keep_the_rest() {
        let text = "# mine\ntheme = \"nord\"\n\n[ui]\n# number = true\nsidebar = true\n\n[keys.normal]\nx = \"y\"\n";
        let t = set_toml_value(text, Some("ui"), "number", "false");
        assert_eq!(t, "# mine\ntheme = \"nord\"\n\n[ui]\nnumber = false\nsidebar = true\n\n[keys.normal]\nx = \"y\"\n");
        let t = set_toml_value(&t, None, "theme", "\"gruvbox\"");
        assert!(t.contains("theme = \"gruvbox\"\n"));
        let t = set_toml_value(&t, Some("ui"), "icons", "\"nerd\"");
        assert!(t.contains("sidebar = true\nicons = \"nerd\"\n\n[keys.normal]"), "{t}");
        let t = set_toml_value(&t, Some("engines.claude"), "allow", "[\"Bash(gh:*)\"]");
        assert!(t.ends_with("x = \"y\"\n\n[engines.claude]\nallow = [\"Bash(gh:*)\"]\n"), "{t}");
        let t = set_toml_value(&t, Some("keys.normal"), "<leader>n", "\":new \"");
        assert!(t.contains("\"<leader>n\" = \":new \""), "{t}");
        assert_eq!(set_toml_value("", None, "theme", "\"x\""), "theme = \"x\"\n");
    }
}
