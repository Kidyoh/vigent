//! What the CLI adapters share (the helpers at the end of src/cli-engines.ts):
//! a tool call's one-line summary, the text of a content array, a shell
//! command as people write it, the last lines of a CLI's stderr.

use serde_json::Value;

/// JavaScript's String(v): what TypeScript's `String(x)` makes of a JSON value.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The first `n` characters (UTF-16 units in TypeScript; characters here).
pub fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A tool call's input, short: its command, path, pattern... or the whole input (cli-engines.ts summarize).
pub fn summarize(args: &Value) -> String {
    if !truthy(args) {
        return String::new();
    }
    if let Value::String(s) = args {
        return take(s, 80);
    }
    let v = ["command", "file_path", "filePath", "path", "pattern", "url", "description"]
        .iter()
        .find_map(|k| args.get(*k).filter(|v| !v.is_null()))
        .map(js_string)
        .unwrap_or_else(|| args.to_string());
    take(&v, 80)
}

/// pi's summary of a tool call's arguments (session.ts summarizeArgs).
pub fn summarize_args(args: &Value) -> String {
    if !truthy(args) {
        return String::new();
    }
    if let Value::String(s) = args {
        return take(s, 80);
    }
    let v = ["command", "path", "file_path", "filePath"]
        .iter()
        .find_map(|k| args.get(*k).filter(|v| !v.is_null()))
        .map(js_string)
        .unwrap_or_else(|| args.to_string());
    take(&v, 80)
}

/// A message's content blocks (empty when it has none).
pub fn content_of(message: &Value) -> Vec<Value> {
    message.get("content").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The text of a tool result's content: a string, or its text blocks joined (cli-engines.ts textOf).
pub fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Array(parts) => parts
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// The text blocks of pi's content, joined (session.ts extractText).
pub fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(_) => text_of(content),
        _ => String::new(),
    }
}

/// Codex reports commands as `/bin/bash -lc "npm test"` (or an argv array); the command itself.
pub fn shell_command(cmd: &Value) -> String {
    let parts: Option<Vec<String>> = cmd.as_array().map(|a| a.iter().map(js_string).collect());
    if let Some(p) = &parts {
        let shell = |s: &str| {
            let base = s.rsplit('/').next().unwrap_or(s);
            matches!(base, "sh" | "bash" | "zsh")
        };
        if p.len() >= 3 && shell(&p[0]) && (p[1] == "-c" || p[1] == "-lc") {
            return p[2..].join(" ");
        }
    }
    let s = match &parts {
        Some(p) => p.join(" "),
        None if cmd.is_null() => String::new(),
        None => js_string(cmd),
    };
    // ^\S*/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$
    let Some(slash) = s.find(char::is_whitespace).map(|i| &s[..i]).filter(|p| p.contains('/')) else { return s };
    let base = slash.rsplit('/').next().unwrap_or("");
    if !matches!(base, "sh" | "bash" | "zsh") {
        return s;
    }
    let rest = s[slash.len()..].trim_start();
    let Some(rest) = rest.strip_prefix("-lc").or_else(|| rest.strip_prefix("-c")) else { return s };
    if !rest.starts_with(char::is_whitespace) {
        return s;
    }
    let rest = rest.trim_start();
    for q in ['\'', '"'] {
        if rest.len() >= 2 && rest.starts_with(q) && rest.ends_with(q) {
            return rest[1..rest.len() - 1].to_string();
        }
    }
    s
}

/// The last two lines of a CLI's stderr worth showing (cli-engines.ts lastLines).
pub fn last_lines(stderr: &str) -> Option<String> {
    let lines: Vec<String> = strip_ansi(stderr)
        .split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("Reading additional input from stdin") && !l.starts_with("Warning: no stdin data"))
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(lines[lines.len().saturating_sub(2)..].join(" · "))
}

/// Without `\x1b[...m` color codes.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' && it.peek() == Some(&'[') {
            let mut probe = it.clone();
            probe.next();
            let mut ok = false;
            let mut n = 0;
            for d in probe.by_ref() {
                n += 1;
                if d == 'm' {
                    ok = true;
                    break;
                }
                if !(d.is_ascii_digit() || d == ';') {
                    break;
                }
            }
            if ok {
                it.next();
                for _ in 0..n {
                    it.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// The first `1.2.3`-shaped version in a CLI's output (engines.ts firstVersion: /\d+\.\d+\.\d+[\w.-]*/).
pub fn first_version(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let digits = |mut i: usize| {
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        (i > start).then_some(i)
    };
    for start in 0..b.len() {
        if !b[start].is_ascii_digit() || (start > 0 && b[start - 1].is_ascii_digit()) {
            continue;
        }
        let Some(i) = digits(start) else { continue };
        if b.get(i) != Some(&b'.') {
            continue;
        }
        let Some(j) = digits(i + 1) else { continue };
        if b.get(j) != Some(&b'.') {
            continue;
        }
        let Some(mut k) = digits(j + 1) else { continue };
        while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'_' || b[k] == b'.' || b[k] == b'-') {
            k += 1;
        }
        return Some(s[start..k].to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summaries() {
        assert_eq!(summarize(&json!({"command": "npm test"})), "npm test");
        assert_eq!(summarize(&json!({"x": 1})), r#"{"x":1}"#);
        assert_eq!(summarize(&json!(null)), "");
        assert_eq!(shell_command(&json!(["/bin/bash", "-lc", "npm test"])), "npm test");
        assert_eq!(shell_command(&json!("/bin/zsh -lc 'npm test'")), "npm test");
        assert_eq!(shell_command(&json!("ls -la")), "ls -la");
        assert_eq!(last_lines("Reading additional input from stdin...\n\x1b[31mboom\x1b[0m\n\nreally\n").as_deref(), Some("boom · really"));
        assert_eq!(first_version("codex-cli 0.167.0").as_deref(), Some("0.167.0"));
        assert_eq!(first_version("2026.11.01-abc").as_deref(), Some("2026.11.01-abc"));
        assert_eq!(first_version("v2.1.319 (Claude Code)").as_deref(), Some("2.1.319"));
        assert_eq!(first_version("none"), None);
    }
}
