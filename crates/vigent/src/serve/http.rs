//! The HTTP server `:serve` runs (src/serve.ts startServer), on std's
//! TcpListener: one thread accepts, a thread answers each connection, and one
//! sends the agent list to the phones following (Server-Sent Events) when it
//! changes. Every response closes its connection, apart from the event stream.
//!
//! What it knows of vigent comes through a [`Host`] (the App answers on its UI
//! thread; tests pass their own).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// After this many wrong codes the server stops answering, until it's started again.
pub const MAX_FAILURES: u32 = 10;
/// The longest prompt (in UTF-16 units, as JavaScript counts a string's length).
pub const MAX_PROMPT: usize = 20_000;
/// no 0/o, 1/l/i: easy to type on a phone
const CODE_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
/// a streaming reply changes many times a second: the list goes out at most this often
const COALESCE: Duration = Duration::from_millis(120);
const BEAT: Duration = Duration::from_secs(15);
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:";

/// What the server needs from vigent. `None`: vigent didn't answer.
pub trait Host: Send + Sync + 'static {
    /// the page, in the colors of the theme vigent is using
    fn page(&self) -> Option<String>;
    /// the project's folder name, for the page title
    fn project(&self) -> Option<String>;
    /// every agent's summary (src/serve.ts agentSummary)
    fn agents(&self) -> Option<Vec<Value>>;
    /// one agent: `{ agent, items }`, or `Some(None)` when there's no such agent
    fn agent(&self, id: u64) -> Option<Option<Value>>;
    /// send (or queue) a prompt: how many wait now
    fn prompt(&self, id: u64, text: String) -> Option<Option<usize>>;
    /// stop it if it runs: its state now
    fn stop(&self, id: u64) -> Option<Option<String>>;
    /// start an agent on a task (as `i` + a prompt does with no agent) and send it the task: its id
    fn start(&self, text: String) -> Option<Option<u64>>;
    /// something worth a message line: a phone connected, a prompt arrived
    fn notify(&self, text: String);
}

/// A fresh access code, like "k3x9-q2m7": 8 characters from the alphabet, uniformly (randomInt).
pub fn new_access_code() -> String {
    let mut out = String::with_capacity(9);
    let mut bytes = random_bytes(64);
    let mut i = 0;
    while out.len() < 9 {
        if out.len() == 4 {
            out.push('-');
            continue;
        }
        if i >= bytes.len() {
            bytes = random_bytes(64);
            i = 0;
        }
        let b = bytes[i];
        i += 1;
        // 248 = 31 * 8: no symbol more likely than another
        if (b as usize) < CODE_ALPHABET.len() * 8 {
            out.push(CODE_ALPHABET[b as usize % CODE_ALPHABET.len()] as char);
        }
    }
    out
}

/// Bytes from the system's random source (/dev/urandom; elsewhere, std's randomly keyed hasher).
fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if cfg!(unix) && std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_ok() {
        return buf;
    }
    use std::hash::{BuildHasher, Hasher};
    for chunk in buf.chunks_mut(8) {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let v = h.finish().to_le_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
    buf
}

/// Equal strings, in time that doesn't depend on where they differ (timingSafeEqual).
pub fn same(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    x.len() == y.len() && x.iter().zip(y).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

/// This machine's addresses a phone on the same network can reach (IPv4, up, not loopback).
pub fn lan_addresses() -> Vec<String> {
    #[cfg(unix)]
    {
        ifaddrs::ipv4()
    }
    #[cfg(not(unix))]
    {
        // the address the default route leaves from (no packet is sent)
        std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").and_then(|_| s.local_addr()))
            .ok()
            .filter(|a| !a.ip().is_loopback() && !a.ip().is_unspecified())
            .map(|a| vec![a.ip().to_string()])
            .unwrap_or_default()
    }
}

#[cfg(unix)]
mod ifaddrs {
    //! getifaddrs(3), declared here: the fields read are laid out the same on Linux and the BSDs.
    use std::ffi::c_void;

    #[repr(C)]
    struct IfAddrs {
        next: *mut IfAddrs,
        name: *mut i8,
        flags: u32,
        addr: *mut u8,
        netmask: *mut c_void,
        ifu: *mut c_void,
        data: *mut c_void,
    }

    unsafe extern "C" {
        fn getifaddrs(out: *mut *mut IfAddrs) -> i32;
        fn freeifaddrs(list: *mut IfAddrs);
    }

    const AF_INET: u8 = 2;
    const IFF_UP: u32 = 0x1;
    const IFF_LOOPBACK: u32 = 0x8;
    const IFF_RUNNING: u32 = 0x40;

    pub fn ipv4() -> Vec<String> {
        let mut out = vec![];
        let mut list: *mut IfAddrs = std::ptr::null_mut();
        // SAFETY: getifaddrs fills a list we only read, then free with freeifaddrs
        unsafe {
            if getifaddrs(&mut list) != 0 {
                return out;
            }
            let mut p = list;
            while !p.is_null() {
                let e = &*p;
                p = e.next;
                // libuv (os.networkInterfaces) lists only interfaces that are up and running
                if e.addr.is_null() || e.flags & (IFF_UP | IFF_RUNNING) != IFF_UP | IFF_RUNNING || e.flags & IFF_LOOPBACK != 0 {
                    continue;
                }
                // sockaddr: a u16 family (Linux), or a length byte and a family byte (BSD)
                let family = if cfg!(any(target_os = "linux", target_os = "android")) { *e.addr } else { *e.addr.add(1) };
                if family != AF_INET {
                    continue;
                }
                let a = std::slice::from_raw_parts(e.addr.add(4), 4);
                out.push(format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3]));
            }
            freeifaddrs(list);
        }
        out
    }
}

/// A running server (src/serve.ts ServeHandle).
pub struct Server {
    pub port: u16,
    /// "0.0.0.0" (reachable from your phone) or "127.0.0.1" (this machine only)
    pub host: String,
    pub code: String,
    /// where to open it: this machine's network addresses first
    pub urls: Vec<String>,
    shared: Arc<Shared>,
    accept: Option<JoinHandle<()>>,
}

struct Shared {
    code: String,
    host: Box<dyn Host>,
    stopped: AtomicBool,
    /// (wrong codes so far, locked)
    auth: Mutex<(u32, bool)>,
    /// the phones following: their event streams
    streams: Mutex<Vec<(u64, TcpStream)>>,
    next_stream: AtomicU64,
    ever_connected: AtomicBool,
    /// send the list at the next chance even if it didn't change (a phone just connected)
    kick: AtomicBool,
}

impl Server {
    /// Start listening on `bind`:`port` (0: any free port). `code`: a fixed access code (tests).
    pub fn start(host: Box<dyn Host>, port: u16, bind: &str, code: Option<String>) -> std::io::Result<Server> {
        let listener = TcpListener::bind((bind, port))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let code = code.unwrap_or_else(new_access_code);
        let shared = Arc::new(Shared {
            code: code.clone(),
            host,
            stopped: AtomicBool::new(false),
            auth: Mutex::new((0, false)),
            streams: Mutex::new(vec![]),
            next_stream: AtomicU64::new(0),
            ever_connected: AtomicBool::new(false),
            kick: AtomicBool::new(false),
        });
        let s = Arc::clone(&shared);
        let accept = std::thread::spawn(move || {
            while !s.stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((conn, _)) => {
                        let s = Arc::clone(&s);
                        std::thread::spawn(move || handle(&s, conn));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(20)),
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
            // the listener goes with this thread: the port is closed once close() returns
        });
        let s = Arc::clone(&shared);
        std::thread::spawn(move || broadcaster(&s));
        let local = bind == "127.0.0.1" || bind == "localhost";
        let mut urls: Vec<String> = if local { vec![] } else { lan_addresses().into_iter().map(|a| format!("http://{a}:{port}/")).collect() };
        urls.push(format!("http://127.0.0.1:{port}/"));
        Ok(Server { port, host: bind.to_string(), code, urls, shared, accept: Some(accept) })
    }

    /// Phones (browsers) following right now.
    pub fn clients(&self) -> usize {
        self.shared.streams.lock().map(|v| v.len()).unwrap_or(0)
    }

    /// The agent list changed: send it now rather than when it's next looked at.
    pub fn sync(&self) {
        self.shared.kick.store(true, Ordering::Relaxed);
    }

    /// Stop: the event streams end, the port closes.
    pub fn close(&mut self) {
        self.shared.stopped.store(true, Ordering::Relaxed);
        if let Ok(mut v) = self.shared.streams.lock() {
            for (_, s) in v.drain(..) {
                let _ = (&s).write_all(b"0\r\n\r\n");
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        if let Some(h) = self.accept.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}

/// The agent list to every phone following: when it changes (at most every
/// 120 ms), when one connects, and a heartbeat every 15 s.
fn broadcaster(s: &Shared) {
    let mut last = String::new();
    let mut beat = Instant::now();
    while !s.stopped.load(Ordering::Relaxed) {
        std::thread::sleep(COALESCE);
        if s.streams.lock().map(|v| v.is_empty()).unwrap_or(true) {
            last.clear();
            continue;
        }
        let kick = s.kick.swap(false, Ordering::Relaxed);
        if let Some(agents) = s.host.agents() {
            let data = json!({ "agents": agents }).to_string();
            if kick || data != last {
                write_all_streams(s, format!("event: agents\ndata: {data}\n\n").as_bytes());
                last = data;
            }
        }
        if beat.elapsed() >= BEAT {
            beat = Instant::now();
            write_all_streams(s, b": beat\n\n");
        }
    }
}

/// One chunk to every stream; a phone that's gone is dropped.
fn write_all_streams(s: &Shared, data: &[u8]) {
    let Ok(mut v) = s.streams.lock() else { return };
    v.retain(|(_, st)| write_chunk(st, data).is_ok());
}

fn write_chunk(mut st: &TcpStream, data: &[u8]) -> std::io::Result<()> {
    let mut buf = format!("{:x}\r\n", data.len()).into_bytes();
    buf.extend_from_slice(data);
    buf.extend_from_slice(b"\r\n");
    st.write_all(&buf)
}

/// A request, as the routes need it.
pub struct Request {
    pub method: String,
    pub path: String,
    query: String,
    /// the Bearer token of the authorization header
    pub bearer: Option<String>,
    content_length: Option<usize>,
}

impl Request {
    /// A query parameter, decoded (URLSearchParams.get).
    pub fn param(&self, name: &str) -> Option<String> {
        self.query.split('&').filter(|p| !p.is_empty()).find_map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k) == name).then(|| decode(v))
        })
    }
}

/// %xx and + decoded, as URLSearchParams does.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let hex = |c: u8| (c as char).to_digit(16);
                match (hex(b[i + 1]), hex(b[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What a route answers.
pub enum Reply {
    Json(u16, Value),
    Html(String),
    /// the event stream: the connection stays open
    Events,
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        423 => "Locked",
        503 => "Service Unavailable",
        _ => "",
    }
}

fn err(status: u16, text: &str) -> Reply {
    Reply::Json(status, json!({ "error": text }))
}

/// One connection: read the request, answer, close (the event stream stays until the phone goes).
fn handle(s: &Arc<Shared>, conn: TcpStream) {
    let _ = conn.set_nonblocking(false);
    let _ = conn.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = conn.set_write_timeout(Some(Duration::from_secs(10)));
    let Ok(read_half) = conn.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let Some(req) = read_head(&mut reader) else { return };
    let reply = route(s, &req, &mut || read_body(&mut reader, req.content_length));
    let mut out = &conn;
    match reply {
        Reply::Events => {
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: keep-alive\r\ntransfer-encoding: chunked\r\n\r\n";
            if out.write_all(head.as_bytes()).is_err() || write_chunk(&conn, b": vigent\n\n").is_err() {
                return;
            }
            let id = s.next_stream.fetch_add(1, Ordering::Relaxed);
            match (s.streams.lock(), conn.try_clone()) {
                (Ok(mut v), Ok(c)) if !s.stopped.load(Ordering::Relaxed) => v.push((id, c)),
                _ => return,
            }
            if !s.ever_connected.swap(true, Ordering::Relaxed) {
                s.host.notify("a phone is following (:serve)".into());
            }
            s.kick.store(true, Ordering::Relaxed);
            // until the phone goes (or the server stops): then it's no longer following
            let _ = conn.set_read_timeout(None);
            let mut buf = [0u8; 512];
            while matches!(reader.get_mut().read(&mut buf), Ok(n) if n > 0) {}
            if let Ok(mut v) = s.streams.lock() {
                v.retain(|(i, _)| *i != id);
            }
            return;
        }
        Reply::Html(page) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\ncontent-security-policy: {CSP}\r\nreferrer-policy: no-referrer\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                page.len()
            );
            let _ = out.write_all(head.as_bytes()).and_then(|_| out.write_all(page.as_bytes()));
        }
        Reply::Json(status, body) => {
            let body = body.to_string();
            let head = format!(
                "HTTP/1.1 {status} {}\r\ncontent-type: application/json; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reason(status),
                body.len()
            );
            let _ = out.write_all(head.as_bytes()).and_then(|_| out.write_all(body.as_bytes()));
        }
    }
    // a graceful close: what the client still sends (a body nobody read) mustn't turn it into a reset
    let _ = out.flush();
    let _ = conn.shutdown(Shutdown::Write);
    let _ = conn.set_read_timeout(Some(Duration::from_millis(500)));
    let mut sink = [0u8; 4096];
    let mut left = 1 << 20;
    while left > 0 {
        match reader.read(&mut sink) {
            Ok(n) if n > 0 => left -= n.min(left),
            _ => break,
        }
    }
}

/// The request line and headers.
fn read_head(r: &mut impl BufRead) -> Option<Request> {
    let mut line = String::new();
    // a stray empty line before the request is allowed
    while line.trim().is_empty() {
        line.clear();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (mut bearer, mut content_length, mut size) = (None, None, 0);
    loop {
        let mut h = String::new();
        let n = r.read_line(&mut h).ok()?;
        size += n;
        if n == 0 || size > 64 * 1024 {
            return None;
        }
        let h = h.trim_end_matches(['\r', '\n']);
        if h.is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "authorization" => bearer = v.strip_prefix("Bearer ").filter(|t| !t.is_empty()).map(str::to_string),
            "content-length" => content_length = v.parse().ok(),
            _ => {}
        }
    }
    // origin-form, or absolute-form (http://host/path)
    let target = match target.find("://") {
        Some(i) => target[i + 3..].find('/').map(|j| target[i + 3 + j..].to_string()).unwrap_or_else(|| "/".into()),
        None => target,
    };
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.split('#').next().unwrap_or("").to_string()),
        None => (target.split('#').next().unwrap_or("").to_string(), String::new()),
    };
    Some(Request { method, path, query, bearer, content_length })
}

/// The body, as JSON ("{}" when empty), as src/serve.ts readBody.
fn read_body(r: &mut impl Read, len: Option<usize>) -> Result<Value, String> {
    let len = len.unwrap_or(0);
    if len > MAX_PROMPT * 4 {
        return Err("too large".into());
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|_| "not JSON".to_string())
}

/// The prompt in a body: `text`, trimmed, if it's a string.
fn body_text(body: &Value) -> Result<String, String> {
    if body.is_null() {
        // what JavaScript says reading `null.text`
        return Err("Cannot read properties of null (reading 'text')".into());
    }
    Ok(body.get("text").and_then(Value::as_str).map(|t| t.trim().to_string()).unwrap_or_default())
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Whether the request carries the access code: in the header, or (reads only) in the URL.
fn authorized(s: &Shared, req: &Request, header_only: bool) -> bool {
    let Ok(mut auth) = s.auth.lock() else { return false };
    if auth.1 {
        return false;
    }
    let given = req.bearer.clone().or_else(|| if header_only { None } else { req.param("code") });
    if let Some(g) = &given
        && !g.is_empty()
        && same(&g.trim().to_lowercase(), &s.code)
    {
        return true;
    }
    if given.is_some() {
        auth.0 += 1;
        if auth.0 >= MAX_FAILURES {
            auth.1 = true;
            drop(auth);
            s.host.notify(format!(":serve stopped answering after {MAX_FAILURES} wrong access codes (:serve stop, then :serve, for a new one)"));
        }
    }
    false
}

fn locked(s: &Shared) -> bool {
    s.auth.lock().map(|a| a.1).unwrap_or(true)
}

const NO_ANSWER: &str = "vigent isn't answering";

/// What a request gets (src/serve.ts's request handler).
fn route(s: &Shared, req: &Request, body: &mut dyn FnMut() -> Result<Value, String>) -> Reply {
    let (method, path) = (req.method.as_str(), req.path.as_str());
    if method == "GET" && (path == "/" || path == "/index.html") {
        return match s.host.page() {
            Some(p) => Reply::Html(p),
            None => err(503, NO_ANSWER),
        };
    }
    if !path.starts_with("/api/") {
        return err(404, "not found");
    }
    // reads may carry the code in the URL (EventSource can't set headers); changes need the header
    let writes = method != "GET";
    if !authorized(s, req, writes) {
        return if locked(s) { err(423, "locked: start :serve again in vigent") } else { err(401, "wrong access code") };
    }
    match (method, path) {
        ("GET", "/api/state") => {
            return match (s.host.project(), s.host.agents()) {
                (Some(project), Some(agents)) => Reply::Json(200, json!({ "project": project, "agents": agents })),
                _ => err(503, NO_ANSWER),
            };
        }
        ("GET", "/api/events") => return Reply::Events,
        ("POST", "/api/agents") => {
            let text = match body().and_then(|b| body_text(&b)) {
                Ok(t) => t,
                Err(e) => return err(400, &e),
            };
            if text.is_empty() || js_len(&text) > MAX_PROMPT {
                return err(400, "a task, up to 20000 characters");
            }
            return match s.host.start(text) {
                None => err(503, NO_ANSWER),
                Some(None) => err(409, "couldn't start an agent (see vigent)"),
                Some(Some(id)) => {
                    s.kick.store(true, Ordering::Relaxed);
                    Reply::Json(200, json!({ "id": id }))
                }
            };
        }
        _ => {}
    }
    // /api/agents/<id>, /api/agents/<id>/prompt, /api/agents/<id>/stop
    let rest = path.strip_prefix("/api/agents/").unwrap_or("");
    let (digits, action) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let id = (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) && matches!(action, "" | "/prompt" | "/stop")).then(|| digits.parse::<u64>().unwrap_or(u64::MAX));
    let Some(id) = id else { return err(404, "no such agent") };
    let Some(found) = s.host.agent(id) else { return err(503, NO_ANSWER) };
    let Some(one) = found else { return err(404, "no such agent") };
    match (method, action) {
        ("GET", "") => Reply::Json(200, one),
        ("POST", "/prompt") => {
            let text = match body().and_then(|b| body_text(&b)) {
                Ok(t) => t,
                Err(e) => return err(400, &e),
            };
            if text.is_empty() || js_len(&text) > MAX_PROMPT {
                return err(400, "a prompt, up to 20000 characters");
            }
            match s.host.prompt(id, text) {
                None => err(503, NO_ANSWER),
                Some(None) => err(404, "no such agent"),
                Some(Some(waiting)) => Reply::Json(200, json!({ "queued": waiting })),
            }
        }
        ("POST", "/stop") => match s.host.stop(id) {
            None => err(503, NO_ANSWER),
            Some(None) => err(404, "no such agent"),
            Some(Some(state)) => Reply::Json(200, json!({ "state": state })),
        },
        _ => err(405, "not allowed"),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn access_codes_are_short_easy_to_type_and_new_each_time() {
        let codes: std::collections::HashSet<String> = (0..50).map(|_| new_access_code()).collect();
        assert_eq!(codes.len(), 50);
        for c in &codes {
            let b = c.as_bytes();
            assert_eq!(b.len(), 9, "{c}");
            assert_eq!(b[4], b'-');
            for (i, ch) in c.chars().enumerate() {
                if i != 4 {
                    assert!(CODE_ALPHABET.contains(&(ch as u8)), "no 0/o/1/l/i: {c}");
                }
            }
        }
    }

    #[test]
    fn comparing_codes() {
        assert!(same("abcd-2345", "abcd-2345"));
        assert!(!same("abcd-2345", "abcd-2346"));
        assert!(!same("abcd", "abcd-2345"));
    }

    /// A fake agent: (id, name, state, sent, aborted, queued).
    type FakeAgent = (u64, String, String, Vec<String>, u32, usize);

    /// A host of fake agents, as the TypeScript test's (one that's sent a prompt runs).
    #[derive(Default)]
    pub struct Fake {
        agents: Mutex<Vec<FakeAgent>>,
        notes: Mutex<Vec<String>>,
    }

    fn fake_summary(a: &FakeAgent) -> Value {
        json!({ "id": a.0, "name": a.1, "state": a.2, "queued": a.5 })
    }

    impl Host for Arc<Fake> {
        fn page(&self) -> Option<String> {
            Some(super::super::page::render("shop", &super::super::page::Palette::of(&crate::theme::load("lazyvim").unwrap())))
        }
        fn project(&self) -> Option<String> {
            Some("shop".into())
        }
        fn agents(&self) -> Option<Vec<Value>> {
            Some(self.agents.lock().unwrap().iter().map(fake_summary).collect())
        }
        fn agent(&self, id: u64) -> Option<Option<Value>> {
            let v = self.agents.lock().unwrap();
            Some(v.iter().find(|a| a.0 == id).map(|a| json!({ "agent": fake_summary(a), "items": [{ "kind": "user", "text": "hi" }] })))
        }
        fn prompt(&self, id: u64, text: String) -> Option<Option<usize>> {
            let mut v = self.agents.lock().unwrap();
            let Some(a) = v.iter_mut().find(|a| a.0 == id) else { return Some(None) };
            let name = a.1.clone();
            let waiting = if a.2 == "running" {
                a.5 += 1;
                a.5
            } else {
                a.3.push(text);
                a.2 = "running".into();
                0
            };
            drop(v);
            let queued = if waiting > 0 { format!(" (queued, {waiting} waiting)") } else { String::new() };
            self.notify(format!("'{name}' got a prompt from your phone{queued}"));
            Some(Some(waiting))
        }
        fn stop(&self, id: u64) -> Option<Option<String>> {
            let mut v = self.agents.lock().unwrap();
            let Some(a) = v.iter_mut().find(|a| a.0 == id) else { return Some(None) };
            if a.2 == "running" {
                a.4 += 1;
                a.2 = "idle".into();
            }
            Some(Some(a.2.clone()))
        }
        fn start(&self, text: String) -> Option<Option<u64>> {
            let mut v = self.agents.lock().unwrap();
            let id = v.len() as u64 + 1;
            v.push((id, text.clone(), "running".into(), vec![text], 0, 0));
            Some(Some(id))
        }
        fn notify(&self, text: String) {
            self.notes.lock().unwrap().push(text);
        }
    }

    const CODE: &str = "abcd-2345";

    /// One request: (status, lowercased headers, body).
    fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> (u16, Vec<(String, String)>, String) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nhost: 127.0.0.1\r\n");
        for (k, v) in headers {
            req += &format!("{k}: {v}\r\n");
        }
        if let Some(b) = body {
            req += &format!("content-type: application/json\r\ncontent-length: {}\r\n", b.len());
        }
        req += "\r\n";
        req += body.unwrap_or("");
        c.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        let (head, body) = out.split_once("\r\n\r\n").unwrap();
        let mut lines = head.lines();
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines.filter_map(|l| l.split_once(": ")).map(|(k, v)| (k.to_ascii_lowercase(), v.to_string())).collect();
        (status, headers, body.to_string())
    }

    fn header<'a>(h: &'a [(String, String)], name: &str) -> &'a str {
        h.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()).unwrap_or("")
    }

    fn fake() -> Arc<Fake> {
        let f = Arc::new(Fake::default());
        f.agents.lock().unwrap().push((1, "fix the race".into(), "idle".into(), vec![], 0, 0));
        f
    }

    #[test]
    fn the_api_the_code_guards_everything_changes_need_it_in_a_header_and_10_wrong_codes_lock_it() {
        let f = fake();
        let mut sv = Server::start(Box::new(Arc::clone(&f)), 0, "127.0.0.1", Some(CODE.into())).unwrap();
        let port = sv.port;
        assert_eq!(sv.urls, [format!("http://127.0.0.1:{port}/")], "local: this machine only");
        let auth = [("authorization", "Bearer abcd-2345")];
        let json_of = |b: &str| serde_json::from_str::<Value>(b).unwrap();

        // the page itself is public, and locked down
        let (st, h, html) = request(port, "GET", "/", &[], None);
        assert_eq!(st, 200);
        assert!(header(&h, "content-security-policy").starts_with("default-src 'none'"));
        assert!(header(&h, "content-security-policy").contains("connect-src 'self'"));
        assert_eq!(header(&h, "referrer-policy"), "no-referrer");
        assert!(html.contains("<title>vigent · shop</title>"));
        assert_eq!(request(port, "GET", "/nope", &[], None).0, 404);

        assert_eq!(request(port, "GET", "/api/state", &[], None).0, 401);
        assert_eq!(request(port, "GET", "/api/state", &[("authorization", "Bearer wrong-code")], None).0, 401);
        let (st, h, body) = request(port, "GET", "/api/state", &auth, None);
        assert_eq!((st, header(&h, "content-type"), header(&h, "cache-control")), (200, "application/json; charset=utf-8", "no-store"));
        let state = json_of(&body);
        assert_eq!(state["project"], "shop");
        assert_eq!(state["agents"][0]["name"], "fix the race");
        assert_eq!(request(port, "GET", &format!("/api/state?code={CODE}"), &[], None).0, 200, "reads may carry it in the URL (EventSource)");
        assert_eq!(request(port, "GET", "/api/state?code=ABCD-2345", &[], None).0, 200, "typed on a phone keyboard");

        let one = json_of(&request(port, "GET", "/api/agents/1", &auth, None).2);
        assert_eq!(one["items"][0]["kind"], "user");
        assert_eq!(request(port, "GET", "/api/agents/999", &auth, None).0, 404);
        assert_eq!(request(port, "GET", "/api/agents/x1", &auth, None).0, 404);
        assert_eq!(request(port, "DELETE", "/api/agents/1", &auth, None).0, 405);

        // prompts and stops: header only, so another page can't send them from your browser
        assert_eq!(request(port, "POST", &format!("/api/agents/1/prompt?code={CODE}"), &[], Some(r#"{"text":"x"}"#)).0, 401);
        assert_eq!(json_of(&request(port, "POST", "/api/agents/1/prompt", &auth, Some(r#"{"text":"  also check the refunds  "}"#)).2), json!({ "queued": 0 }));
        assert_eq!(f.agents.lock().unwrap()[0].3, ["also check the refunds"]);
        assert!(f.notes.lock().unwrap().last().unwrap().contains("'fix the race' got a prompt from your phone"));
        assert_eq!(json_of(&request(port, "POST", "/api/agents/1/prompt", &auth, Some(r#"{"text":"and the docs"}"#)).2), json!({ "queued": 1 }), "running: it waits its turn");
        let (st, _, body) = request(port, "POST", "/api/agents/1/prompt", &auth, Some(r#"{"text":""}"#));
        assert_eq!((st, json_of(&body)), (400, json!({ "error": "a prompt, up to 20000 characters" })));
        let (st, _, body) = request(port, "POST", "/api/agents/1/prompt", &auth, Some("{nope"));
        assert_eq!((st, json_of(&body)), (400, json!({ "error": "not JSON" })));
        let long = format!(r#"{{"text":"{}"}}"#, "x".repeat(20_001));
        assert_eq!(request(port, "POST", "/api/agents/1/prompt", &auth, Some(&long)).0, 400);
        let huge = format!(r#"{{"text":"{}"}}"#, "x".repeat(90_000));
        let (st, _, body) = request(port, "POST", "/api/agents/1/prompt", &auth, Some(&huge));
        assert_eq!((st, json_of(&body)), (400, json!({ "error": "too large" })));
        assert_eq!(json_of(&request(port, "POST", "/api/agents/1/stop", &auth, Some("{}")).2), json!({ "state": "idle" }));
        assert_eq!(f.agents.lock().unwrap()[0].4, 1);

        let started = json_of(&request(port, "POST", "/api/agents", &auth, Some(r#"{"text":"add retries to checkout"}"#)).2);
        assert_eq!(started, json!({ "id": 2 }));
        assert_eq!(f.agents.lock().unwrap()[1].3, ["add retries to checkout"]);
        let (st, _, body) = request(port, "POST", "/api/agents", &auth, Some(r#"{"text":" "}"#));
        assert_eq!((st, json_of(&body)), (400, json!({ "error": "a task, up to 20000 characters" })));

        // 10 wrong codes: locked, even for the right one, until :serve starts again (1 wrong so far)
        for i in 0..9 {
            request(port, "GET", "/api/state", &[("authorization", &format!("Bearer nope-{i}"))], None);
        }
        let (st, _, body) = request(port, "GET", "/api/state", &auth, None);
        assert_eq!((st, json_of(&body)), (423, json!({ "error": "locked: start :serve again in vigent" })));
        assert!(f.notes.lock().unwrap().last().unwrap().contains("stopped answering after 10 wrong access codes"));
        sv.close();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "closed");
    }

    #[test]
    fn live_updates_the_event_stream_sends_the_agent_list_when_anything_changes() {
        let f = fake();
        let mut sv = Server::start(Box::new(Arc::clone(&f)), 0, "127.0.0.1", Some(CODE.into())).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", sv.port)).unwrap();
        c.write_all(format!("GET /api/events?code={CODE} HTTP/1.1\r\nhost: x\r\n\r\n").as_bytes()).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut seen = String::new();
        let mut buf = [0u8; 4096];
        let mut next_agents = |seen: &mut String| -> Value {
            loop {
                if let Some(i) = seen.find("event: agents\ndata: ") {
                    let rest = &seen[i + 20..];
                    if let Some(j) = rest.find("\n\n") {
                        let v: Value = serde_json::from_str(&rest[..j]).unwrap();
                        *seen = rest[j..].to_string();
                        return v["agents"].clone();
                    }
                }
                let n = c.read(&mut buf).unwrap();
                assert!(n > 0, "stream ended");
                seen.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        };
        assert_eq!(next_agents(&mut seen)[0]["state"], "idle");
        let t = Instant::now();
        while sv.clients() != 1 && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(sv.clients(), 1);
        assert_eq!(f.notes.lock().unwrap().as_slice(), ["a phone is following (:serve)"]);
        f.agents.lock().unwrap()[0].2 = "running".into();
        assert_eq!(next_agents(&mut seen)[0]["state"], "running");
        sv.close();
        assert_eq!(sv.clients(), 0);
    }

    #[test]
    fn query_parameters_decode() {
        let r = Request { method: "GET".into(), path: "/api/state".into(), query: "a=1&code=abcd%2D2345&x=a+b".into(), bearer: None, content_length: None };
        assert_eq!(r.param("code").as_deref(), Some("abcd-2345"));
        assert_eq!(r.param("x").as_deref(), Some("a b"));
        assert_eq!(r.param("nope"), None);
        assert_eq!(decode("100%"), "100%");
    }
}
