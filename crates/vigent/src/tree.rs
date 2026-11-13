//! `:tree`: an agent's conversation as a tree (pi keeps every branch). The
//! same flattening as src/tree.ts: a straight run of messages stays at one
//! level, and only where the conversation branched do the alternatives get
//! ├─ / └─ guides. Tool results fold into the reply that called them;
//! bookkeeping entries (model changes, labels...) are skipped.
//!
//! Pi's session tree comes in as JSON nodes: `{ entry: { id, parentId, type,
//! ... }, children: [...], label? }`. The pi session (Engines area) hands its
//! nodes to [`flatten`]; `:tree` (commands/sessions.rs) shows the rows.

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    User,
    Agent,
    Tool,
    Summary,
    Note,
}

/// One row of the tree's list.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: String,
    /// tree guides drawn before the row, e.g. "│  ├─ "
    pub guide: String,
    pub kind: Kind,
    pub text: String,
    /// on the branch the agent is on now
    pub on_path: bool,
    /// where the conversation currently ends
    pub current: bool,
    pub label: Option<String>,
}

/// (tee, last, pipe, blank)
pub type Glyphs = (&'static str, &'static str, &'static str, &'static str);
pub const UNICODE: Glyphs = ("├─ ", "└─ ", "│  ", "   ");
pub const ASCII: Glyphs = ("|- ", "`- ", "|  ", "   ");

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

/// One line: code blocks become [code], whitespace collapses.
fn one_line(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("```") {
        match rest[start + 3..].find("```") {
            Some(end) => {
                out.push_str(&rest[..start]);
                out.push_str("[code]");
                rest = &rest[start + 3 + end + 3..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn id(n: &Value) -> &str {
    n["entry"]["id"].as_str().unwrap_or("")
}

fn children(n: &Value) -> &[Value] {
    n["children"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// What an entry shows as, or None to skip it.
fn describe(entry: &Value) -> Option<(Kind, String)> {
    match entry["type"].as_str()? {
        "message" => {
            let m = &entry["message"];
            match m["role"].as_str()? {
                "user" => {
                    let t = one_line(&text_of(&m["content"]));
                    Some((Kind::User, if t.is_empty() { "(empty prompt)".into() } else { t }))
                }
                "assistant" => {
                    let t = one_line(&text_of(&m["content"]));
                    if !t.is_empty() {
                        return Some((Kind::Agent, t));
                    }
                    let calls: Vec<String> = m["content"]
                        .as_array()
                        .map(|a| a.iter().filter(|b| b["type"] == "toolCall").collect::<Vec<_>>())
                        .unwrap_or_default()
                        .into_iter()
                        .map(|c| {
                            let a = &c["arguments"];
                            let arg = ["command", "path", "file_path"].iter().find_map(|k| a[*k].as_str()).unwrap_or("");
                            let name = c["name"].as_str().unwrap_or("");
                            if arg.is_empty() { name.to_string() } else { format!("{name} {}", arg.chars().take(40).collect::<String>()) }
                        })
                        .collect();
                    (!calls.is_empty()).then(|| (Kind::Tool, calls.join(", ")))
                }
                // tool results belong to the call above them
                _ => None,
            }
        }
        "branch_summary" => Some((Kind::Summary, format!("summary of another branch: {}", one_line(entry["summary"].as_str().unwrap_or(""))))),
        "compaction" => Some((Kind::Note, "earlier messages compacted".into())),
        _ => None,
    }
}

fn find<'a>(nodes: &'a [Value], want: &str) -> Option<&'a Value> {
    nodes.iter().find_map(|n| if id(n) == want { Some(n) } else { find(children(n), want) })
}

/// Flatten pi's session tree into list rows.
pub fn flatten(roots: &[Value], leaf: Option<&str>, g: Glyphs) -> Vec<Row> {
    // the current branch: walk up from the leaf
    let mut parents: Vec<(String, Option<String>)> = vec![];
    fn index(nodes: &[Value], out: &mut Vec<(String, Option<String>)>) {
        for n in nodes {
            out.push((id(n).to_string(), n["entry"]["parentId"].as_str().map(String::from)));
            index(children(n), out);
        }
    }
    index(roots, &mut parents);
    let parent = |i: &str| parents.iter().find(|(k, _)| k == i).and_then(|(_, p)| p.clone());
    let mut on_path = vec![];
    let mut at = leaf.map(String::from);
    while let Some(i) = at {
        at = parent(&i);
        on_path.push(i);
    }
    // the current position: the nearest shown entry at or above the leaf
    let current = on_path.iter().find(|i| find(roots, i).is_some_and(|n| describe(&n["entry"]).is_some())).cloned();
    // skipped entries hand their children to the nearest shown ancestor
    fn visible(nodes: &[Value]) -> Vec<&Value> {
        nodes.iter().flat_map(|n| if describe(&n["entry"]).is_some() { vec![n] } else { visible(children(n)) }).collect()
    }
    let mut rows = vec![];
    let emit = |rows: &mut Vec<Row>, n: &Value, guide: String| {
        let (kind, text) = describe(&n["entry"]).unwrap_or((Kind::Note, String::new()));
        rows.push(Row {
            id: id(n).into(),
            guide,
            kind,
            text,
            on_path: on_path.iter().any(|p| p == id(n)),
            current: current.as_deref() == Some(id(n)),
            label: n["label"].as_str().map(String::from),
        });
    };
    fn walk(nodes: Vec<&Value>, prefix: &str, g: Glyphs, rows: &mut Vec<Row>, emit: &dyn Fn(&mut Vec<Row>, &Value, String)) {
        if nodes.len() == 1 {
            emit(rows, nodes[0], prefix.to_string());
            walk(visible(children(nodes[0])), prefix, g, rows, emit);
            return;
        }
        let count = nodes.len();
        for (i, n) in nodes.into_iter().enumerate() {
            let last = i + 1 == count;
            emit(rows, n, format!("{prefix}{}", if last { g.1 } else { g.0 }));
            walk(visible(children(n)), &format!("{prefix}{}", if last { g.3 } else { g.2 }), g, rows, emit);
        }
    }
    walk(visible(roots), "", g, &mut rows, &emit);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(id: &str, parent: Option<&str>, role: &str, content: Value) -> Value {
        json!({ "entry": { "id": id, "parentId": parent, "type": "message", "message": { "role": role, "content": content } }, "children": [] })
    }

    /// Nodes listed parent first, linked into a tree.
    fn link(nodes: Vec<Value>) -> Vec<Value> {
        fn attach(into: &mut Vec<Value>, n: Value) -> Result<(), Value> {
            let p = n["entry"]["parentId"].as_str().map(String::from);
            let Some(p) = p else {
                into.push(n);
                return Ok(());
            };
            let mut n = Some(n);
            fn go(nodes: &mut [Value], p: &str, n: &mut Option<Value>) {
                for x in nodes.iter_mut() {
                    if n.is_none() {
                        return;
                    }
                    if x["entry"]["id"] == p {
                        x["children"].as_array_mut().unwrap().push(n.take().unwrap());
                        return;
                    }
                    go(x["children"].as_array_mut().unwrap(), p, n);
                }
            }
            go(into, &p, &mut n);
            n.map_or(Ok(()), Err)
        }
        let mut roots = vec![];
        for n in nodes {
            attach(&mut roots, n).unwrap();
        }
        roots
    }

    #[test]
    fn straight_runs_stay_flat_and_branches_get_guides() {
        let roots = link(vec![
            msg("u1", None, "user", json!("fix the race")),
            msg("a1", Some("u1"), "assistant", json!([{ "type": "toolCall", "id": "t", "name": "bash", "arguments": { "command": "npm test" } }])),
            msg("r1", Some("a1"), "toolResult", json!([{ "type": "text", "text": "1 failing" }])),
            msg("a2", Some("r1"), "assistant", json!([{ "type": "text", "text": "Found it:\n```js\nawait x\n```" }])),
            msg("u2", Some("a2"), "user", json!("add a retry")),
            msg("a3", Some("u2"), "assistant", json!([{ "type": "text", "text": "Added a retry." }])),
            msg("u3", Some("a2"), "user", json!("use waitFor instead")),
            msg("a4", Some("u3"), "assistant", json!([{ "type": "text", "text": "Switched to waitFor." }])),
            json!({ "entry": { "id": "m1", "parentId": "a4", "type": "model_change" }, "children": [] }),
        ]);
        let shown: Vec<String> = flatten(&roots, Some("m1"), UNICODE)
            .iter()
            .map(|r| {
                let kind = format!("{:?}", r.kind).to_lowercase();
                format!("{}{kind}:{}{}{}", r.guide, r.text, if r.current { " *" } else { "" }, if r.on_path { "" } else { " (off)" })
            })
            .collect();
        assert_eq!(
            shown,
            [
                "user:fix the race",
                "tool:bash npm test",
                "agent:Found it: [code]",
                "├─ user:add a retry (off)",
                "│  agent:Added a retry. (off)",
                "└─ user:use waitFor instead",
                "   agent:Switched to waitFor. *",
            ]
        );
        let guides: Vec<String> = flatten(&roots, Some("a3"), ASCII).into_iter().map(|r| r.guide).collect();
        assert_eq!(guides, ["", "", "", "|- ", "|  ", "`- ", "   "]);
        assert_eq!(flatten(&roots, Some("a3"), UNICODE).iter().find(|r| r.current).map(|r| r.id.as_str()), Some("a3"));
        assert!(flatten(&[], None, UNICODE).is_empty());
    }
}
