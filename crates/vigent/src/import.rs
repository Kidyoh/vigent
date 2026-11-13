//! Import vim / nvim colorschemes as vigent themes (src/import.ts).
//!
//!   vigent theme import                  the colorscheme your nvim/vim config uses
//!   vigent theme import tokyonight       a colorscheme by name (plugins load normally)
//!   vigent theme import ./molokai.vim    a colorscheme file (works without an editor)
//!
//! The editor runs headless with your normal config, loads the colorscheme,
//! and dumps every resolved highlight group. If that fails it retries without
//! your config, then with the other editor.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::color::resolve_vim_color;
use crate::theme::Attr;
use crate::vimcolors::{HiCommand, parse_highlight_command, parse_vim_colorscheme};

#[derive(Default, Clone)]
pub struct ImportOptions {
    /// colorscheme name or path to a .vim/.lua file; None for the current colorscheme
    pub source: Option<String>,
    /// name to save the theme under
    pub as_name: Option<String>,
    /// "nvim" or "vim" (default: nvim, then vim)
    pub editor: Option<String>,
    /// set 'background' first
    pub background: Option<String>,
    /// skip the user's config
    pub clean: bool,
    /// where to write (default: ~/.config/vigent/themes)
    pub out_dir: Option<PathBuf>,
}

pub struct ImportResult {
    pub name: String,
    pub file: PathBuf,
    pub groups: usize,
    pub via: String,
}

const NVIM_DUMP: &str = r##"
local result = { name = vim.g.colors_name, background = vim.o.background }
local ok, groups = pcall(function()
  local out = {}
  for name, hl in pairs(vim.api.nvim_get_hl(0, {})) do
    local r = hl
    if hl.link then r = vim.api.nvim_get_hl(0, { name = name, link = false }) end
    local e = {}
    if r.fg then e.fg = string.format("#%06x", r.fg) elseif r.ctermfg then e.ctermfg = r.ctermfg end
    if r.bg then e.bg = string.format("#%06x", r.bg) elseif r.ctermbg then e.ctermbg = r.ctermbg end
    for _, k in ipairs({ "bold", "italic", "underline", "undercurl", "reverse", "standout" }) do
      if r[k] then e[k] = true end
    end
    if next(e) ~= nil then out[name] = e end
  end
  return out
end)
if ok then result.groups = groups else result.text = vim.fn.execute("highlight") end
local encode = (vim.json and vim.json.encode) or vim.fn.json_encode
local f = assert(io.open(os.getenv("VIGENT_OUT"), "w"))
f:write(encode(result))
f:close()
"##;

const VIM_DUMP: &str = r##"
let s:out = {'name': get(g:, 'colors_name', ''), 'background': &background}
if exists('*hlget')
  let s:groups = {}
  for s:h in hlget()
    let s:r = get(hlget(s:h.name, v:true), 0, {})
    let s:e = {}
    for [s:key, s:dst] in [['guifg', 'fg'], ['guibg', 'bg']]
      if has_key(s:r, s:key)
        let s:c = s:r[s:key]
        if s:c !~ '^#' && exists('v:colornames')
          let s:c = get(v:colornames, tolower(s:c), s:c)
        endif
        let s:e[s:dst] = s:c
      endif
    endfor
    if !has_key(s:e, 'fg') && has_key(s:r, 'ctermfg') | let s:e.ctermfg = s:r.ctermfg | endif
    if !has_key(s:e, 'bg') && has_key(s:r, 'ctermbg') | let s:e.ctermbg = s:r.ctermbg | endif
    let s:attrs = get(s:r, 'gui', get(s:r, 'cterm', {}))
    for s:k in ['bold', 'italic', 'underline', 'undercurl', 'reverse', 'inverse', 'standout']
      if get(s:attrs, s:k, v:false) | let s:e[s:k] = v:true | endif
    endfor
    if !empty(s:e) | let s:groups[s:h.name] = s:e | endif
  endfor
  let s:out.groups = s:groups
else
  let s:out.text = execute('highlight')
endif
call writefile([json_encode(s:out)], $VIGENT_OUT)
"##;

fn run_quiet(program: &str, args: &[String], env: Option<(&str, &Path)>, timeout: Duration) -> Option<bool> {
    let mut c = Command::new(program);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some((k, v)) = env {
        c.env(k, v);
    }
    let mut child = c.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return Some(s.success()),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Some(false);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

pub fn has_editor(editor: &str) -> bool {
    run_quiet(editor, &["--version".into()], None, Duration::from_secs(5)) == Some(true)
}

fn is_path(source: &str) -> bool {
    source.contains('/') || source.contains('\\') || source.ends_with(".vim") || source.ends_with(".lua")
}

/// Escape a path for a vim command line.
fn vim_escape(p: &str) -> String {
    let mut out = String::new();
    for c in p.chars() {
        if " \\|\"%#".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || "_.-+".contains(c))
}

fn load_command(source: Option<&str>) -> Result<Option<String>, String> {
    let Some(source) = source else { return Ok(None) };
    if is_path(source) {
        let abs = std::path::absolute(source).unwrap_or_else(|_| source.into());
        return Ok(Some(format!("source {}", vim_escape(&abs.to_string_lossy()))));
    }
    if !name_ok(source) {
        return Err(format!("invalid colorscheme name '{source}'"));
    }
    Ok(Some(format!("colorscheme {source}")))
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn vimrc_args() -> Vec<String> {
    for f in [home().join(".vimrc"), home().join(".vim").join("vimrc")] {
        if f.exists() {
            return vec!["-u".into(), f.to_string_lossy().to_string()];
        }
    }
    vec!["-u".into(), "NONE".into()]
}

fn run_editor(editor: &str, opts: &ImportOptions, clean: bool) -> Result<Option<serde_json::Value>, String> {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("vigent-import-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let out = tmp.join("dump.json");
    let script = tmp.join(if editor == "nvim" { "dump.lua" } else { "dump.vim" });
    let _ = std::fs::write(&script, if editor == "nvim" { NVIM_DUMP } else { VIM_DUMP });
    let script_s = vim_escape(&script.to_string_lossy());
    let mut cmds = vec!["set termguicolors".to_string()];
    if let Some(b) = &opts.background {
        cmds.push(format!("set background={b}"));
    }
    if let Some(l) = load_command(opts.source.as_deref())? {
        cmds.push(l);
    }
    cmds.push(if editor == "nvim" { format!("luafile {script_s}") } else { format!("source {script_s}") });
    cmds.push("qa!".into());
    let mut args: Vec<String> = vec![];
    if editor == "nvim" {
        args.push("--headless".into());
        if clean {
            args.push("--clean".into());
        }
    } else {
        args.extend(["-es", "-N", "-i", "NONE"].map(String::from));
        if clean {
            args.extend(["-u", "NONE"].map(String::from));
        } else {
            args.extend(vimrc_args());
        }
        args.extend(["-c", "silent! packloadall"].map(String::from));
    }
    for c in cmds {
        args.push("-c".into());
        args.push(c);
    }
    run_quiet(editor, &args, Some(("VIGENT_OUT", &out)), Duration::from_secs(60));
    let dump = std::fs::read_to_string(&out).ok().and_then(|t| serde_json::from_str(&t).ok());
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(dump)
}

/// The name a colorscheme file sets (g:colors_name), if it says.
fn declared_name(file: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let at = text.find("colors_name")? + "colors_name".len();
    let rest = text[at..].trim_start().strip_prefix('=')?.trim_start();
    let inner = rest.strip_prefix(['\'', '"'])?;
    let end = inner.find(['\'', '"'])?;
    Some(inner[..end].to_string())
}

fn dump_name(d: &serde_json::Value) -> Option<String> {
    d.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from)
}

/// Did the editor switch to the colorscheme asked for? (a failed load keeps the old one)
fn loaded_requested(d: &serde_json::Value, source: Option<&str>) -> bool {
    if d.get("groups").is_none() && d.get("text").is_none() {
        return false;
    }
    let Some(source) = source else { return true };
    if is_path(source) {
        return match declared_name(source) {
            None => true,
            Some(expected) => dump_name(d).as_deref() == Some(expected.as_str()),
        };
    }
    dump_name(d).as_deref() == Some(source)
}

fn dump_to_groups(d: &serde_json::Value) -> Vec<(String, Attr)> {
    let Some(groups) = d.get("groups").and_then(|g| g.as_object()) else {
        return parse_highlight_listing(d.get("text").and_then(|t| t.as_str()).unwrap_or_default());
    };
    let mut out = vec![];
    for (name, e) in groups {
        let color = |k: &str, cterm: bool| -> Option<String> {
            let v = e.get(k)?;
            let s = match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if s.is_empty() { None } else { resolve_vim_color(&s, cterm) }
        };
        let flag = |k: &str| e.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        let a = Attr {
            fg: color("fg", false).or_else(|| color("ctermfg", true)),
            bg: color("bg", false).or_else(|| color("ctermbg", true)),
            bold: flag("bold").then_some(true),
            italic: flag("italic").then_some(true),
            underline: (flag("underline") || flag("undercurl")).then_some(true),
            reverse: (flag("reverse") || flag("inverse") || flag("standout")).then_some(true),
            link: None,
        };
        if a.has_style() {
            out.push((name.clone(), a));
        }
    }
    out
}

/// The output of `:highlight` (editors without nvim_get_hl / hlget).
pub fn parse_highlight_listing(text: &str) -> Vec<(String, Attr)> {
    let mut entries: Vec<String> = vec![];
    for line in text.split('\n') {
        if line.starts_with(char::is_whitespace) && !entries.is_empty() {
            let last = entries.last_mut().unwrap();
            last.push(' ');
            last.push_str(line.trim());
        } else if !line.trim().is_empty() {
            entries.push(line.trim().to_string());
        }
    }
    let mut out = vec![];
    for e in entries {
        let Some((name, after)) = e.split_once(char::is_whitespace) else { continue };
        let Some(rest) = after.trim_start().strip_prefix("xxx") else { continue };
        let rest = rest.trim();
        let link = rest.find("links to ").map(|i| rest[i + 9..].split_whitespace().next().unwrap_or_default().to_string());
        let own = match rest.find("links to ") {
            Some(i) => {
                let after = rest[i + 9..].trim_start();
                let after = after.split_once(char::is_whitespace).map(|(_, r)| r).unwrap_or("");
                format!("{} {after}", &rest[..i]).trim().to_string()
            }
            None => rest.to_string(),
        };
        let cmd = if own.is_empty() { None } else { parse_highlight_command(&format!("{name} {own}")) };
        match (cmd, link) {
            (Some(HiCommand::Set { attr, .. }), _) if attr.has_style() => out.push((name.to_string(), attr)),
            (_, Some(l)) => out.push((name.to_string(), Attr { link: Some(l), ..Default::default() })),
            _ => {}
        }
    }
    out
}

fn json_attr(a: &Attr) -> String {
    let mut parts = vec![];
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    if let Some(l) = &a.link {
        parts.push(format!("\"link\": {}", q(l)));
    }
    if let Some(v) = &a.fg {
        parts.push(format!("\"fg\": {}", q(v)));
    }
    if let Some(v) = &a.bg {
        parts.push(format!("\"bg\": {}", q(v)));
    }
    for (k, v) in [("bold", a.bold), ("italic", a.italic), ("underline", a.underline), ("reverse", a.reverse)] {
        if let Some(v) = v {
            parts.push(format!("\"{k}\": {v}"));
        }
    }
    format!("{{\n\t\t\t{}\n\t\t}}", parts.join(",\n\t\t\t"))
}

pub fn import_theme(opts: &ImportOptions) -> Result<ImportResult, String> {
    let editors: Vec<String> = match &opts.editor {
        Some(e) => vec![e.clone()],
        None => vec!["nvim".into(), "vim".into()],
    };
    let available: Vec<String> = editors.into_iter().filter(|e| has_editor(e)).collect();
    let mut dump = None;
    let mut via = String::new();
    'outer: for editor in &available {
        let modes: Vec<bool> = if opts.clean {
            vec![true]
        } else if opts.source.is_some() {
            vec![false, true]
        } else {
            vec![false]
        };
        for clean in modes {
            if let Some(d) = run_editor(editor, opts, clean)?
                && loaded_requested(&d, opts.source.as_deref())
            {
                dump = Some(d);
                via = format!("{editor}{}", if clean { " --clean" } else { "" });
                break 'outer;
            }
        }
    }
    let base_name = |s: &str, exts: &[&str]| {
        let b = Path::new(s).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        exts.iter().find_map(|e| b.strip_suffix(e)).map(String::from).unwrap_or(b)
    };
    let (groups, mut name, background) = if let Some(d) = &dump {
        let name = opts.as_name.clone().or_else(|| dump_name(d)).unwrap_or_else(|| opts.source.as_deref().map(|s| base_name(s, &[".vim", ".lua"])).unwrap_or_else(|| "current".into()));
        (dump_to_groups(d), name, d.get("background").and_then(|b| b.as_str()).map(String::from))
    } else if let Some(src) = opts.source.as_deref().filter(|s| is_path(s) && s.ends_with(".vim") && Path::new(s).exists()) {
        let text = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
        let p = parse_vim_colorscheme(&text, opts.background.as_deref());
        via = "static parse".into();
        (p.groups, opts.as_name.clone().or(p.name).unwrap_or_else(|| base_name(src, &[".vim"])), Some(p.background))
    } else if available.is_empty() {
        return Err("neither nvim nor vim was found on PATH. Install one, or import a .vim file directly: vigent theme import ./theme.vim".into());
    } else if let Some(src) = &opts.source {
        return Err(format!("{} could not load colorscheme '{src}'", available.join(" and ")));
    } else {
        return Err(format!("could not read the current colorscheme from {}", available.join(" or ")));
    };
    if !name_ok(&name) {
        let mut cleaned = String::new();
        let mut dash = false;
        for c in name.chars() {
            if c.is_alphanumeric() || "_.-+".contains(c) {
                cleaned.push(c);
                dash = false;
            } else if !dash {
                cleaned.push('-');
                dash = true;
            }
        }
        name = cleaned;
    }
    let dir = opts.out_dir.clone().unwrap_or_else(crate::theme::themes_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{name}.json"));
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut text = format!("{{\n\t\"name\": {}", q(&name));
    if let Some(b) = &background {
        text += &format!(",\n\t\"background\": {}", q(b));
    }
    text += &format!(",\n\t\"source\": {}", q(&via));
    if let Some(c) = dump.as_ref().and_then(dump_name) {
        text += &format!(",\n\t\"colorscheme\": {}", q(&c));
    }
    let body: Vec<String> = groups.iter().map(|(g, a)| format!("\t\t{}: {}", q(g), json_attr(a))).collect();
    text += &if body.is_empty() { ",\n\t\"groups\": {}\n}\n".to_string() } else { format!(",\n\t\"groups\": {{\n{}\n\t}}\n}}\n", body.join(",\n")) };
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    Ok(ImportResult { name, file, groups: groups.len(), via })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listings_and_static_files() {
        let g = parse_highlight_listing("Normal         xxx guifg=#c0c0c0 guibg=#101010\nComment        xxx ctermfg=8\n                   gui=italic\nTitle          xxx links to Comment\nCleared        xxx cleared\n");
        assert_eq!(g.len(), 3);
        assert_eq!(g[1].1.italic, Some(true));
        assert_eq!(g[2].1.link.as_deref(), Some("Comment"));
        let dir = std::env::temp_dir().join(format!("vigent-import-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("mine.vim");
        std::fs::write(&src, "let g:colors_name = 'mine'\nhi Normal guifg=#ffffff guibg=#000000\nhi link Title Normal\n").unwrap();
        // no editor on this PATH: the file is read statically
        let r = import_theme(&ImportOptions { source: Some(src.to_string_lossy().to_string()), editor: Some("no-such-editor-xyz".into()), out_dir: Some(dir.clone()), ..Default::default() }).unwrap();
        assert_eq!((r.name.as_str(), r.groups, r.via.as_str()), ("mine", 2, "static parse"));
        let t = crate::theme::load_def(&r.file.to_string_lossy()).unwrap();
        assert_eq!(t.group("Normal").unwrap().bg.as_deref(), Some("#000000"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
