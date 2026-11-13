//! Serve area: following your agents from your phone (src/serve.ts,
//! src/serve-page.ts: `:serve`, `vigent --serve`), `:cost` / `:usage`, and
//! demo mode (src/demo.ts). The server is std's TcpListener (no async
//! runtime): see serve/http.rs. Its state lives here, on App::serve.
//!
//! The server's threads reach the App through [`AppHost`]: each call runs on
//! the UI thread (`Msg::Run`) and sends its answer back.

pub mod demo;
pub mod http;
pub mod page;

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::app::{App, Msg};
use crate::session::{self, Item, State, Submitted};
use crate::ui::floats::Float;

/// Where `:serve` listens unless you give a port.
pub const DEFAULT_PORT: u16 = 8377;

/// The Serve area's state on the App.
#[derive(Default)]
pub struct Serve {
    /// the `:serve` server, while it runs
    pub server: Option<http::Server>,
    /// per agent slot: (what it looked like last, its version), so the page knows when to reload it
    versions: HashMap<usize, (u64, u64)>,
    /// demo mode: scripted agents, no network (--demo, or nothing can run agents)
    pub demo: bool,
    /// per demo agent: the script playing now (a newer one, or a stop, ends the older)
    pub(crate) plays: HashMap<usize, std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

/// The statusline's mark while `:serve` runs (src/app.ts ICONS.serve).
pub fn icon(app: &App) -> &'static str {
    match app.config.ui.icons.as_str() {
        "nerd" => "\u{f10b} ",
        "ascii" => "~ ",
        _ => "⇄ ",
    }
}

/// The statusline's right side, with the serve mark when it runs: the parts
/// given (an agent's model, usage, agents), else "serving" with no agent open.
pub fn statusline_right(app: &App, parts: Option<String>) -> Option<String> {
    let serve = if app.serve.server.is_some() { icon(app) } else { "" };
    match parts {
        Some(p) => Some(format!("{serve}{p}")),
        None => app.serve.server.is_some().then(|| format!(" {serve}serving ")),
    }
}

/// `--serve [--local]`: follow from your phone from the start (same as :serve).
pub fn startup(app: &mut App, serve: bool, local: bool) {
    if serve {
        exec(app, if local { "local" } else { "" });
    }
}

/// `:serve [local] [port]` starts it (or shows where it is), `:serve stop` stops it.
pub fn exec(app: &mut App, arg: &str) {
    let words: Vec<&str> = arg.split_whitespace().collect();
    if words.first() == Some(&"stop") {
        let Some(mut sv) = app.serve.server.take() else {
            return app.say(":serve isn't running", "Comment");
        };
        sv.close();
        return app.say(":serve stopped", "Comment");
    }
    if app.serve.server.is_some() {
        return open_info(app);
    }
    let asked = words.iter().find(|w| w.bytes().all(|b| b.is_ascii_digit()));
    // Number("0012") is 12; a port past 65535 is refused as node refuses it
    let port: u128 = asked.map(|w| w.trim_start_matches('0').parse().unwrap_or(if w.trim_start_matches('0').is_empty() { 0 } else { u128::MAX })).unwrap_or(DEFAULT_PORT as u128);
    let local = words.contains(&"local");
    if port > 65535 {
        return app.say(format!(":serve couldn't start: options.port should be >= 0 and < 65536. Received type number ({port})."), "ErrorMsg");
    }
    let host = AppHost { tx: app.tx.clone() };
    match http::Server::start(Box::new(host), port as u16, if local { "127.0.0.1" } else { "0.0.0.0" }, None) {
        Ok(sv) => app.serve.server = Some(sv),
        Err(e) => {
            let why = if e.kind() == std::io::ErrorKind::AddrInUse { format!("port {port} is taken (:serve {})", port + 1) } else { e.to_string() };
            return app.say(format!(":serve couldn't start: {why}"), "ErrorMsg");
        }
    }
    open_info(app);
}

/// Where to open it and the access code (src/app.ts openServeInfo).
pub fn open_info(app: &mut App) {
    let Some(sv) = &app.serve.server else { return };
    let mut lines: Vec<(String, &'static str)> = vec![("On your phone, open".into(), "Comment")];
    let shown = if sv.urls.len() > 1 { &sv.urls[..sv.urls.len() - 1] } else { &sv.urls[..] };
    lines.extend(shown.iter().map(|u| (format!("  {u}"), "Title")));
    lines.push(("and type the access code".into(), "Comment"));
    lines.push((format!("  {}", sv.code), "String"));
    lines.push((String::new(), "Normal"));
    lines.push(("Or open it with the code in the link:".into(), "Comment"));
    lines.push((format!("  {}#{}", sv.urls[0], sv.code), "NormalFloat"));
    lines.push((String::new(), "Normal"));
    if sv.host == "127.0.0.1" {
        lines.push(("This machine only (:serve local). :serve stop, then :serve, for your phone.".into(), "WarningMsg"));
    } else {
        lines.push(("Same Wi-Fi as this machine, or a VPN like Tailscale. Plain HTTP: not on public Wi-Fi.".into(), "Comment"));
    }
    lines.push(("The page lists your agents, follows a reply as it streams, and sends prompts.".into(), "Comment"));
    lines.push((":serve shows this again · :serve stop ends it (and the code)".into(), "Comment"));
    app.float = Some(Float::new("Follow from your phone", lines));
}

// ---------------------------------------------------------------------
// what the page sees
// ---------------------------------------------------------------------

/// The id the page knows an agent by (src/session.ts ids start at 1).
pub fn agent_id(slot: usize) -> u64 {
    slot as u64 + 1
}

fn slot_of(app: &App, id: u64) -> Option<usize> {
    let slot = usize::try_from(id.checked_sub(1)?).ok()?;
    app.sessions.get(slot).filter(|s| !s.closed).map(|_| slot)
}

pub fn state_name(s: State) -> &'static str {
    match s {
        State::Idle => "idle",
        State::Running => "running",
        State::Waiting => "waiting",
        State::Paused => "paused",
        State::Error => "error",
    }
}

/// A reply as one plain line for the agent list: no markdown marks, no code fences (src/serve.ts preview).
pub fn preview(text: &str) -> String {
    // ```lang\n -> " "
    let mut s = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("```") {
        s.push_str(&rest[..i]);
        s.push(' ');
        let after = &rest[i + 3..];
        let end = after.find('\n').map(|j| j + 1).unwrap_or(after.len());
        rest = &after[end..];
    }
    s.push_str(rest);
    // **, __ and ` go
    let s = s.replace("**", "").replace("__", "").replace('`', "");
    // a heading's #s at the start of a line
    let s: Vec<&str> = s
        .split('\n')
        .map(|l| {
            let hashes = l.len() - l.trim_start_matches('#').len();
            if hashes > 0 && l[hashes..].starts_with(' ') { &l[hashes + 1..] } else { l }
        })
        .collect();
    let s = s.join("\n");
    let one: Vec<&str> = s.split(|c: char| c.is_whitespace()).filter(|w| !w.is_empty()).collect();
    let line = one.join(" ");
    // JavaScript's slice(0, 160) counts UTF-16 units
    let mut out = String::new();
    let mut units = 0;
    for c in line.chars() {
        units += c.len_utf16();
        if units > 160 {
            break;
        }
        out.push(c);
    }
    out
}

/// At most `max` UTF-16 units, then "\n…" (src/serve.ts itemJson).
fn clip(text: &str, max: usize) -> String {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return format!("{}\n…", &text[..i]);
        }
    }
    text.to_string()
}

/// The model an agent shows on the page ("" when it's the CLI's own default).
fn model_of(s: &session::Session) -> String {
    s.requested_model.clone().or_else(|| s.model.clone()).unwrap_or_default()
}

/// What changes the page shows: when it's different, the agent's version goes up.
fn fingerprint(s: &session::Session) -> u64 {
    let mut h = DefaultHasher::new();
    (state_name(s.state), &s.name, s.tokens, s.cost.map(f64::to_bits), s.queue.len(), s.stat, model_of(s), &s.effort, &s.branch, s.streaming_at()).hash(&mut h);
    for it in &s.items {
        match it {
            Item::User(t) => (0, t).hash(&mut h),
            Item::Text(t) => (1, t).hash(&mut h),
            Item::Tool { name, summary, .. } => (2, name, summary).hash(&mut h),
            Item::Info(t) => (3, t).hash(&mut h),
            Item::Error(t) => (4, t).hash(&mut h),
        }
    }
    h.finish()
}

/// The agent's version: bumped whenever what the page shows of it changed (src/session.ts version).
fn version(app: &mut App, slot: usize) -> u64 {
    let f = fingerprint(&app.sessions[slot]);
    let e = app.serve.versions.entry(slot).or_insert((f, 0));
    if e.0 != f {
        *e = (f, e.1 + 1);
    }
    e.1
}

/// One agent in the list (src/serve.ts agentSummary).
pub fn summary(app: &mut App, slot: usize) -> Value {
    let version = version(app, slot);
    let s = &app.sessions[slot];
    let mut o = Map::new();
    o.insert("id".into(), json!(agent_id(slot)));
    o.insert("name".into(), json!(s.name));
    o.insert("engine".into(), json!(s.engine));
    o.insert("engineName".into(), json!(crate::engines::engine_name(&s.engine)));
    o.insert("model".into(), json!(model_of(s)));
    if let Some(e) = &s.effort {
        o.insert("effort".into(), json!(e));
    }
    o.insert("state".into(), json!(state_name(s.state)));
    if let Some(b) = &s.branch {
        o.insert("branch".into(), json!(b));
    }
    o.insert("added".into(), json!(s.stat.0));
    o.insert("removed".into(), json!(s.stat.1));
    o.insert("tokens".into(), json!(s.tokens));
    if let Some(c) = s.cost {
        o.insert("cost".into(), json!(c));
    }
    o.insert("queued".into(), json!(s.queue.len()));
    o.insert("unread".into(), json!(s.unread));
    o.insert("version".into(), json!(version));
    let last = s.items.iter().rev().find_map(|i| match i {
        Item::Text(t) => Some(("agent", t)),
        Item::User(t) => Some(("user", t)),
        _ => None,
    });
    if let Some((kind, text)) = last {
        o.insert("last".into(), json!({ "kind": kind, "text": preview(text) }));
    }
    Value::Object(o)
}

/// Every open agent, in order.
pub fn summaries(app: &mut App) -> Vec<Value> {
    app.open().into_iter().map(|i| summary(app, i)).collect()
}

/// A transcript line for the page (src/serve.ts itemJson).
pub fn item_json(it: &Item, streaming: bool) -> Value {
    let mut o = Map::new();
    let (kind, text) = match it {
        Item::User(t) => ("user", t.as_str()),
        Item::Text(t) => ("agent", t.as_str()),
        Item::Tool { .. } => ("tool", ""),
        Item::Info(t) | Item::Error(t) => ("info", t.as_str()),
    };
    o.insert("kind".into(), json!(kind));
    o.insert("text".into(), json!(clip(text, 50_000)));
    if streaming {
        o.insert("streaming".into(), json!(true));
    }
    if let Item::Tool { name, summary, .. } = it {
        o.insert("tool".into(), json!({ "name": name, "summary": summary, "output": "" }));
    }
    Value::Object(o)
}

/// `{ agent, items }` for one agent's page.
pub fn agent_page(app: &mut App, slot: usize) -> Value {
    let agent = summary(app, slot);
    let s = &app.sessions[slot];
    let at = s.streaming_at();
    let items: Vec<Value> = s.items.iter().enumerate().map(|(i, it)| item_json(it, at == Some(i))).collect();
    json!({ "agent": agent, "items": items })
}

/// A prompt from the phone: sent now, or queued. How many wait now.
pub fn prompt(app: &mut App, slot: usize, text: String) -> usize {
    let waiting = match app.sessions[slot].submit(text) {
        Submitted::Now(t) => {
            app.send(slot, t);
            0
        }
        Submitted::Queued(n) => n,
    };
    let name = app.sessions[slot].name.clone();
    let queued = if waiting > 0 { format!(" (queued, {waiting} waiting)") } else { String::new() };
    app.say(format!("'{name}' got a prompt from your phone{queued}"), "ModeMsg");
    waiting
}

/// Stop from the phone: only a running agent stops.
pub fn stop(app: &mut App, slot: usize) -> &'static str {
    if app.sessions[slot].state == State::Running {
        crate::serve::demo::stop(app, slot);
        app.sessions[slot].abort();
    }
    state_name(app.sessions[slot].state)
}

/// A new agent from the phone, sent its task (as `i` + a prompt does with no agent open).
pub fn start(app: &mut App, text: String) -> Option<usize> {
    let name = crate::names::agent_name_from(&text);
    let slot = app.start_agent(&name, Default::default())?;
    if let Submitted::Now(t) = app.sessions[slot].submit(text) {
        app.send(slot, t);
    }
    let name = app.sessions[slot].name.clone();
    app.say(format!("'{name}' started from your phone"), "ModeMsg");
    Some(slot)
}

/// The folder name the page's title shows.
pub fn project(app: &App) -> String {
    let dir = app.root.clone().unwrap_or_else(|| app.cwd.clone());
    dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string_lossy().into_owned())
}

/// The server's way into the App: each call runs on the UI thread.
pub struct AppHost {
    pub tx: Sender<Msg>,
}

impl AppHost {
    fn call<R: Send + 'static>(&self, f: impl FnOnce(&mut App) -> R + Send + 'static) -> Option<R> {
        let (rtx, rrx) = channel();
        self.tx.send(Msg::Run(Box::new(move |app| {
            let _ = rtx.send(f(app));
        })))
        .ok()?;
        rrx.recv_timeout(Duration::from_secs(10)).ok()
    }
}

impl http::Host for AppHost {
    fn page(&self) -> Option<String> {
        self.call(|app| page::render(&project(app), &page::Palette::of(&app.theme)))
    }
    fn project(&self) -> Option<String> {
        self.call(|app| project(app))
    }
    fn agents(&self) -> Option<Vec<Value>> {
        self.call(summaries)
    }
    fn agent(&self, id: u64) -> Option<Option<Value>> {
        self.call(move |app| slot_of(app, id).map(|i| agent_page(app, i)))
    }
    fn prompt(&self, id: u64, text: String) -> Option<Option<usize>> {
        self.call(move |app| slot_of(app, id).map(|i| prompt(app, i, text)))
    }
    fn stop(&self, id: u64) -> Option<Option<String>> {
        self.call(move |app| slot_of(app, id).map(|i| stop(app, i).to_string()))
    }
    fn start(&self, text: String) -> Option<Option<u64>> {
        self.call(move |app| start(app, text).map(agent_id))
    }
    fn notify(&self, text: String) {
        let _ = self.tx.send(Msg::Run(Box::new(move |app| app.say(text, "ModeMsg"))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Session;

    #[test]
    fn previews_are_one_plain_line() {
        assert_eq!(preview("Found it: two writers race on `cart.total`.\n\n```js\nawait lock(cart);\n```"), "Found it: two writers race on cart.total. await lock(cart);");
        assert_eq!(preview("## Done\n**all** good __now__"), "Done all good now");
        assert_eq!(preview(&"x".repeat(300)).len(), 160);
        assert_eq!(clip("abcdef", 3), "abc\n…");
        assert_eq!(clip("abc", 3), "abc");
    }

    fn shop() -> App {
        let mut app = crate::app::tests::app();
        let mut a = Session::new(0, "fix the race", "claude", "/nope".into());
        a.requested_model = Some("claude-fable-5".into());
        a.branch = Some("fix/the-race".into());
        a.stat = (12, 3);
        a.tokens = 74_810;
        a.cost = Some(0.5);
        a.items.push(Item::User("the checkout test is flaky".into()));
        a.items.push(Item::Text("Found it: two writers race on `cart.total`.\n\n```js\nawait lock(cart);\n```".into()));
        a.items.push(Item::Tool { id: "t1".into(), name: "bash".into(), summary: "npm test".into() });
        app.add_session(a, true);
        app
    }

    #[test]
    fn the_agent_list_says_what_the_page_shows() {
        let mut app = shop();
        let got = summaries(&mut app);
        assert_eq!(
            got[0],
            json!({
                "id": 1, "name": "fix the race", "engine": "claude", "engineName": "Claude Code", "model": "claude-fable-5",
                "state": "idle", "branch": "fix/the-race", "added": 12, "removed": 3, "tokens": 74810, "cost": 0.5,
                "queued": 0, "unread": false, "version": 0,
                "last": { "kind": "agent", "text": "Found it: two writers race on cart.total. await lock(cart);" },
            })
        );
        // a change bumps the version; looking again doesn't
        app.sessions[0].items.push(Item::Text("more".into()));
        assert_eq!(summaries(&mut app)[0]["version"], 1);
        assert_eq!(summaries(&mut app)[0]["version"], 1);
        let page = agent_page(&mut app, 0);
        let kinds: Vec<&str> = page["items"].as_array().unwrap().iter().map(|i| i["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["user", "agent", "tool", "agent"]);
        assert_eq!(page["items"][2]["tool"]["summary"], "npm test");
        assert_eq!(slot_of(&app, 1), Some(0));
        assert_eq!(slot_of(&app, 999), None);
        assert_eq!(slot_of(&app, 0), None);
    }

    #[test]
    fn prompts_and_stops_from_the_phone() {
        let mut app = shop();
        app.sessions[0].state = State::Running;
        assert_eq!(prompt(&mut app, 0, "and the docs".into()), 1, "running: it waits its turn");
        assert_eq!(app.message.0, "'fix the race' got a prompt from your phone (queued, 1 waiting)");
        assert_eq!(stop(&mut app, 0), "idle");
        app.sessions[0].state = State::Paused;
        assert_eq!(stop(&mut app, 0), "paused", "only a running agent stops");
    }

    #[test]
    fn serve_local_shows_where_to_open_it_and_marks_the_statusline() {
        let mut app = shop();
        exec(&mut app, "local 0");
        let sv = app.serve.server.as_ref().expect("serving");
        let (port, code) = (sv.port, sv.code.clone());
        let f = app.float.as_ref().unwrap();
        assert_eq!(f.title, "Follow from your phone");
        // a float line is segments (Windows area): their text, joined
        let text: Vec<String> = f.lines.iter().map(|l| l.iter().map(|(_, t)| t.as_str()).collect()).collect();
        assert!(text.contains(&format!("  http://127.0.0.1:{port}/")));
        assert!(text.contains(&format!("  {code}")));
        assert!(text.contains(&format!("  http://127.0.0.1:{port}/#{code}")));
        assert!(text.iter().any(|l| l.starts_with("This machine only")));
        assert_eq!(statusline_right(&app, Some("m  0/1 ".into())).as_deref(), Some("⇄ m  0/1 "));
        // :serve again shows it again; :serve stop ends it
        app.float = None;
        exec(&mut app, "");
        assert!(app.float.is_some());
        exec(&mut app, "stop");
        assert!(app.serve.server.is_none());
        assert_eq!(app.message.0, ":serve stopped");
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "the port is closed");
        exec(&mut app, "stop");
        assert_eq!(app.message.0, ":serve isn't running");
        assert_eq!(statusline_right(&app, None), None);
        exec(&mut app, "99999");
        assert_eq!(app.message.0, ":serve couldn't start: options.port should be >= 0 and < 65536. Received type number (99999).");
    }

    #[test]
    fn a_taken_port_says_which_to_try() {
        let mut app = shop();
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        exec(&mut app, &format!("local {port}"));
        assert_eq!(app.message.0, format!(":serve couldn't start: port {port} is taken (:serve {})", port as u32 + 1));
    }
}
