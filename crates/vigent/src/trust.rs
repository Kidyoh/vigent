//! Which projects' .vigent.toml may run commands (src/trust.ts).
//!
//! A project config can set the theme, templates, keys and worktree layout
//! freely. The parts that run programs (hooks, engine arguments, custom
//! engine commands, shell commands under [commands], Claude Code permission
//! rules) only count once you trust that file, like direnv's `allow`:
//! `:trust` in vigent, or `vigent trust` in the project. Trust is for the file
//! as it is now (its sha256, in $XDG_STATE_HOME/vigent/trusted.json); if it
//! changes, vigent asks again.

use std::path::{Path, PathBuf};

use crate::app::App;
use crate::config::{self, LoadOptions, PROJECT_CONFIG};

fn state_file() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".local").join("state"));
    base.join("vigent").join("trusted.json")
}

/// sha256 of the text, as lowercase hex (node's createHash("sha256").digest("hex")).
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

fn read() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(state_file()).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn key(file: &Path) -> String {
    std::path::absolute(file).unwrap_or_else(|_| file.to_path_buf()).to_string_lossy().to_string()
}

/// Whether this file, with exactly this content, is trusted.
pub fn is_trusted(file: &Path, content: &str) -> bool {
    read().get(&key(file)).and_then(|v| v.as_str()) == Some(sha256_hex(content.as_bytes()).as_str())
}

/// Trust this file as it is now.
pub fn trust_file(file: &Path, content: &str) -> std::io::Result<()> {
    let mut all = read();
    all.insert(key(file), serde_json::Value::String(sha256_hex(content.as_bytes())));
    let f = state_file();
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(all)).unwrap_or_default();
    std::fs::write(f, format!("{text}\n"))
}

/// The project's .vigent.toml (at the repository root), if there's a repository.
pub fn project_file(root: Option<&Path>) -> Option<PathBuf> {
    root.map(|r| r.join(PROJECT_CONFIG))
}

/// `:trust`: trust the project's .vigent.toml as it is now and use what it runs from now on.
/// Returns the message to show (src/trust.ts executeProjectTrust).
pub fn execute_project_trust(app: &mut App) -> String {
    let Some(file) = project_file(app.root.as_deref()).filter(|f| f.exists()) else {
        return format!("no {PROJECT_CONFIG} in this project");
    };
    let content = match std::fs::read_to_string(&file) {
        Ok(c) => c,
        Err(e) => return format!("can't read {PROJECT_CONFIG}: {e}"),
    };
    // only a file that doesn't parse is refused; other warnings never stopped a file from being trusted
    if let Err(e) = config::parse_toml(&content) {
        return format!("can't trust {PROJECT_CONFIG}: {e}");
    }
    let gated = config::load_str(&content, PROJECT_CONFIG, LoadOptions { base: None, trusted: false, label: PROJECT_CONFIG }).gated;
    if let Err(e) = trust_file(&file, &content) {
        return format!("can't trust {PROJECT_CONFIG}: {e}");
    }
    let base = std::mem::take(&mut app.config);
    app.config = config::load_str(&content, PROJECT_CONFIG, LoadOptions { base: Some(base), trusted: true, label: PROJECT_CONFIG }).config;
    crate::permissions::reload(app);
    if gated.is_empty() { format!("trusted {PROJECT_CONFIG}") } else { format!("trusted {PROJECT_CONFIG}: {} now run", gated.join(", ")) }
}

/// `vigent trust`, in the project.
pub fn command(_args: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_default();
    let root = crate::worktree::repo_root(&cwd);
    let file = project_file(root.as_deref());
    let Some(file) = file.filter(|f| f.exists()) else {
        let where_ = match &root {
            Some(r) => format!(" (looked in {})", r.display()),
            None => " (not in a git repository)".into(),
        };
        eprintln!("vigent: no {PROJECT_CONFIG} here{where_}");
        return 1;
    };
    let content = std::fs::read_to_string(&file).unwrap_or_default();
    let gated = config::load_str(&content, PROJECT_CONFIG, LoadOptions { base: None, trusted: false, label: PROJECT_CONFIG }).gated;
    if let Err(e) = trust_file(&file, &content) {
        eprintln!("vigent: {e}");
        return 1;
    }
    if gated.is_empty() {
        println!("trusted {}", file.display());
    } else {
        println!("trusted {}: {} will run", file.display(), gated.join(", "));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_node() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let long = "a".repeat(200);
        assert_eq!(sha256_hex(long.as_bytes()), "c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
    }
}
