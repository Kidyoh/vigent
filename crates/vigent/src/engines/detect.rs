//! Is an engine installed, and signed in? Only the CLIs' version and status
//! commands run (src/engines.ts): vigent never reads their credentials.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::EngineInfo;

/// An environment: what a CLI runs with (tests pass their own).
pub type Env = BTreeMap<String, String>;

pub fn process_env() -> Env {
    std::env::vars().collect()
}

/// Is this command on PATH (and executable)? A quick check, without running it.
pub fn on_path(bin: &str, env: &Env) -> bool {
    if bin.contains('/') {
        return executable(Path::new(bin));
    }
    let path = env.get("PATH").map(String::as_str).unwrap_or("");
    std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty()).any(|d| {
        if cfg!(windows) {
            [".exe", ".cmd", ".bat", ""].iter().any(|ext| d.join(format!("{bin}{ext}")).is_file())
        } else {
            executable(&d.join(bin))
        }
    })
}

#[cfg(unix)]
fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(p: &Path) -> bool {
    p.is_file()
}

/// What a command printed, and how it ended.
#[derive(Debug, Default)]
pub struct RunResult {
    pub ok: bool,
    /// None: it couldn't start (not installed)
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run a command with a timeout and exactly `env`; never fails.
pub fn run(cmd: &str, args: &[&str], timeout_ms: u64, env: &Env) -> RunResult {
    // PATH lookup follows the env given, as execFile does
    let program = if cmd.contains('/') { Some(PathBuf::from(cmd)) } else { which(cmd, env) };
    let Some(program) = program else { return RunResult::default() };
    let mut c = Command::new(program);
    c.args(args).env_clear().envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let Ok(mut child) = c.spawn() else { return RunResult::default() };
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let o = std::thread::spawn(move || {
        let mut s = vec![];
        let _ = out.read_to_end(&mut s);
        String::from_utf8_lossy(&s).into_owned()
    });
    let e = std::thread::spawn(move || {
        let mut s = vec![];
        let _ = err.read_to_end(&mut s);
        String::from_utf8_lossy(&s).into_owned()
    });
    let until = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = o.join().unwrap_or_default();
    let stderr = e.join().unwrap_or_default();
    match status {
        Some(s) => RunResult { ok: s.success(), code: Some(s.code().unwrap_or(1)), stdout, stderr },
        None => RunResult { ok: false, code: Some(1), stdout, stderr },
    }
}

/// The file `bin` runs, found on env's PATH.
pub fn which(bin: &str, env: &Env) -> Option<PathBuf> {
    let path = env.get("PATH")?;
    std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(bin)).find(|f| executable(f))
}

pub fn home(env: &Env) -> PathBuf {
    env.get("HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_default()
}

/// pi's config folder: $PI_CODING_AGENT_DIR, else ~/.pi/agent
pub fn pi_agent_dir(env: &Env) -> PathBuf {
    match env.get("PI_CODING_AGENT_DIR").filter(|d| !d.is_empty()) {
        Some(d) => match d.strip_prefix("~/") {
            Some(rest) => home(env).join(rest),
            None => PathBuf::from(d),
        },
        None => home(env).join(".pi").join("agent"),
    }
}

const PI_KEYS: [&str; 8] = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"];

/// pi can run: installed, with an API key in the environment, a saved pi login or providers of its own.
pub fn detect_pi(env: &Env) -> EngineInfo {
    let base = EngineInfo { id: "pi".into(), name: "pi".into(), install: Some(super::PI_INSTALL.into()), ..Default::default() };
    if !on_path("pi", env) {
        return EngineInfo { detail: "not installed".into(), ..base };
    }
    let keys: Vec<&str> = PI_KEYS.iter().copied().filter(|k| env.get(*k).is_some_and(|v| !v.is_empty())).collect();
    let has = |file: &str, ok: &dyn Fn(&serde_json::Value) -> bool| {
        std::fs::read_to_string(pi_agent_dir(env).join(file)).ok().and_then(|t| serde_json::from_str(&t).ok()).is_some_and(|v| ok(&v))
    };
    // a saved login (pi's /login), or providers of your own in models.json (Ollama, a proxy...)
    let stored = has("auth.json", &|v| v.as_object().is_some_and(|o| !o.is_empty()));
    let custom = has("models.json", &|v| v.get("providers").and_then(|p| p.as_object()).is_some_and(|o| !o.is_empty()));
    let connected = !keys.is_empty() || stored || custom;
    EngineInfo {
        installed: true,
        connected,
        detail: if connected {
            format!("using {}", if !keys.is_empty() { keys.join(", ") } else if stored { "pi's saved login".into() } else { "your models.json providers".into() })
        } else {
            "no API key found".into()
        },
        connect: (!connected).then(|| "export ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY), or pi's /login".into()),
        ..base
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fake CLI in `dir`: a shell script.
    pub fn fake_bin(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let f = dir.join(name);
        std::fs::write(&f, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        f
    }

    pub fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vigent-rs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn pi_with_a_key_or_its_own_providers() {
        let dir = tmp("pi-detect");
        let bin = dir.join("bin");
        fake_bin(&bin, "pi", "");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let p = bin.to_str().unwrap();
        let h = home.to_str().unwrap();
        let pi = detect_pi(&env(&[("PATH", p), ("HOME", h), ("GEMINI_API_KEY", "x")]));
        assert_eq!((pi.installed, pi.connected, pi.detail.as_str()), (true, true, "using GEMINI_API_KEY"));
        let no = detect_pi(&env(&[("PATH", p), ("HOME", h)]));
        assert_eq!((no.installed, no.connected), (true, false));
        assert!(no.connect.unwrap().contains("ANTHROPIC_API_KEY") );
        let agent = home.join(".pi").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(agent.join("models.json"), r#"{"providers":{"fake":{}}}"#).unwrap();
        assert_eq!(detect_pi(&env(&[("PATH", p), ("HOME", h)])).detail, "using your models.json providers");
        let gone = detect_pi(&env(&[("PATH", ""), ("HOME", h)]));
        assert_eq!((gone.installed, gone.detail.as_str(), gone.install.as_deref()), (false, "not installed", Some(super::super::PI_INSTALL)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_command_that_hangs_times_out() {
        let dir = tmp("timeout");
        fake_bin(&dir, "slow", "sleep 5");
        let t = Instant::now();
        let r = run("slow", &[], 200, &env(&[("PATH", dir.to_str().unwrap())]));
        assert!(!r.ok && r.code.is_some() && t.elapsed() < Duration::from_secs(3));
        assert_eq!(run("nope-not-here", &[], 200, &env(&[("PATH", "")])).code, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
