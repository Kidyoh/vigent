/**
 * Import vim / nvim colorschemes as vigent themes.
 *
 *   vigent theme import                  the colorscheme your nvim/vim config uses
 *   vigent theme import tokyonight       a colorscheme by name (plugins load normally)
 *   vigent theme import ./molokai.vim    a colorscheme file (works without an editor)
 *
 * The editor runs headless with your normal config, loads the colorscheme,
 * and dumps every resolved highlight group. If that fails it retries without
 * your config, then with the other editor.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveVimColor } from "./color.js";
import { type Attr, themesDir } from "./theme.js";
import { parseHighlightCommand, parseVimColorscheme } from "./vimcolors.js";

export type Editor = "nvim" | "vim";

export interface ImportOptions {
	/** colorscheme name or path to a .vim/.lua file; omit for the current colorscheme */
	source?: string;
	/** name to save the theme under */
	as?: string;
	/** force one editor (default: nvim, then vim) */
	editor?: Editor;
	/** set 'background' before loading (for themes with dark and light variants) */
	background?: "dark" | "light";
	/** skip the user's config (faster, but plugin-managed themes won't load) */
	clean?: boolean;
	/** directory to write to (default: ~/.config/vigent/themes) */
	outDir?: string;
}

export interface ImportResult {
	name: string;
	file: string;
	groups: number;
	via: string;
}

interface Dump {
	name?: string;
	background?: string;
	groups?: Record<string, Record<string, unknown>>;
	text?: string;
}

const NVIM_DUMP = `
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
`;

const VIM_DUMP = `
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
`;

export function hasEditor(editor: Editor): boolean {
	const r = spawnSync(editor, ["--version"], { stdio: "ignore", timeout: 5000 });
	return r.status === 0;
}

function isPath(source: string): boolean {
	return /[/\\]/.test(source) || /\.(vim|lua)$/.test(source);
}

/** Escape a path for use in a vim command line. */
function vimEscape(p: string): string {
	return p.replace(/[ \\|"%#]/g, "\\$&");
}

function loadCommand(source: string | undefined): string | undefined {
	if (!source) return undefined;
	if (isPath(source)) return `source ${vimEscape(path.resolve(source))}`;
	if (!/^[\w.\-+]+$/.test(source)) throw new Error(`invalid colorscheme name '${source}'`);
	return `colorscheme ${source}`;
}

function vimrcArgs(): string[] {
	const home = os.homedir();
	for (const f of [path.join(home, ".vimrc"), path.join(home, ".vim", "vimrc")]) {
		if (fs.existsSync(f)) return ["-u", f];
	}
	return ["-u", "NONE"];
}

function runEditor(editor: Editor, opts: ImportOptions, clean: boolean): Dump | undefined {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-import-"));
	const out = path.join(tmp, "dump.json");
	const script = path.join(tmp, editor === "nvim" ? "dump.lua" : "dump.vim");
	fs.writeFileSync(script, editor === "nvim" ? NVIM_DUMP : VIM_DUMP);

	const cmds: string[] = ["set termguicolors"];
	if (opts.background) cmds.push(`set background=${opts.background}`);
	const load = loadCommand(opts.source);
	if (load) cmds.push(load);
	cmds.push(editor === "nvim" ? `luafile ${vimEscape(script)}` : `source ${vimEscape(script)}`);
	cmds.push("qa!");

	const args =
		editor === "nvim"
			? ["--headless", ...(clean ? ["--clean"] : []), ...cmds.flatMap((c) => ["-c", c])]
			: [
					"-es", "-N", "-i", "NONE",
					...(clean ? ["-u", "NONE"] : vimrcArgs()),
					"-c", "silent! packloadall",
					...cmds.flatMap((c) => ["-c", c]),
				];

	try {
		spawnSync(editor, args, {
			env: { ...process.env, VIGENT_OUT: out },
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 60_000,
		});
		if (!fs.existsSync(out)) return undefined;
		return JSON.parse(fs.readFileSync(out, "utf8")) as Dump;
	} catch {
		return undefined;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/** The name a colorscheme file sets (g:colors_name), if it says. */
function declaredName(file: string): string | undefined {
	try {
		const text = fs.readFileSync(file, "utf8");
		return /colors_name\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1];
	} catch {
		return undefined;
	}
}

/** Did the editor actually switch to the requested colorscheme? (a failed load keeps the old one) */
function loadedRequested(dump: Dump, source: string | undefined): boolean {
	if (!dump.groups && !dump.text) return false;
	if (!source) return true;
	if (isPath(source)) {
		const expected = declaredName(source);
		return expected === undefined || dump.name === expected;
	}
	return dump.name === source;
}

function dumpToGroups(dump: Dump): Record<string, Attr> {
	const groups: Record<string, Attr> = {};
	if (dump.groups) {
		for (const [name, e] of Object.entries(dump.groups)) {
			const attr: Attr = {};
			const color = (v: unknown, cterm: boolean) =>
				v === undefined || v === "" ? undefined : resolveVimColor(String(v), cterm);
			attr.fg = color(e.fg, false) ?? color(e.ctermfg, true);
			attr.bg = color(e.bg, false) ?? color(e.ctermbg, true);
			if (e.bold) attr.bold = true;
			if (e.italic) attr.italic = true;
			if (e.underline || e.undercurl) attr.underline = true;
			if (e.reverse || e.inverse || e.standout) attr.reverse = true;
			if (attr.fg === undefined) delete attr.fg;
			if (attr.bg === undefined) delete attr.bg;
			if (Object.keys(attr).length > 0) groups[name] = attr;
		}
		return groups;
	}
	return parseHighlightListing(dump.text ?? "");
}

/** Parse the output of `:highlight` (used for editors without nvim_get_hl / hlget). */
export function parseHighlightListing(text: string): Record<string, Attr> {
	const groups: Record<string, Attr> = {};
	const entries = text.split("\n").reduce<string[]>((acc, line) => {
		if (/^\s/.test(line) && acc.length > 0) acc[acc.length - 1] += ` ${line.trim()}`;
		else if (line.trim()) acc.push(line.trim());
		return acc;
	}, []);
	for (const entry of entries) {
		const m = /^(\S+)\s+xxx\s+(.*)$/.exec(entry);
		if (!m) continue;
		const link = /links to (\S+)/.exec(m[2]);
		const own = m[2].replace(/links to \S+/, "").trim();
		const cmd = own ? parseHighlightCommand(`${m[1]} ${own}`) : undefined;
		if (cmd?.kind === "set" && Object.keys(cmd.attr).length > 0) groups[m[1]] = cmd.attr;
		else if (link) groups[m[1]] = { link: link[1] };
	}
	return groups;
}

export function importTheme(opts: ImportOptions = {}): ImportResult {
	const editors: Editor[] = opts.editor ? [opts.editor] : ["nvim", "vim"];
	const available = editors.filter(hasEditor);
	let dump: Dump | undefined;
	let via = "";

	for (const editor of available) {
		const modes = opts.clean ? [true] : opts.source ? [false, true] : [false];
		for (const clean of modes) {
			const d = runEditor(editor, opts, clean);
			if (d && loadedRequested(d, opts.source)) {
				dump = d;
				via = `${editor}${clean ? " --clean" : ""}`;
				break;
			}
		}
		if (dump) break;
	}

	let groups: Record<string, Attr>;
	let name: string;
	let background: string | undefined;

	if (dump) {
		groups = dumpToGroups(dump);
		name = opts.as ?? (dump.name || (opts.source ? path.basename(opts.source).replace(/\.(vim|lua)$/, "") : "current"));
		background = dump.background;
	} else if (opts.source && isPath(opts.source) && opts.source.endsWith(".vim") && fs.existsSync(opts.source)) {
		const parsed = parseVimColorscheme(fs.readFileSync(opts.source, "utf8"), opts.background);
		groups = parsed.groups;
		name = opts.as ?? parsed.name ?? path.basename(opts.source, ".vim");
		background = parsed.background;
		via = "static parse";
	} else if (available.length === 0) {
		throw new Error(
			"neither nvim nor vim was found on PATH. Install one, or import a .vim file directly: vigent theme import ./theme.vim",
		);
	} else if (opts.source) {
		throw new Error(`${available.join(" and ")} could not load colorscheme '${opts.source}'`);
	} else {
		throw new Error(`could not read the current colorscheme from ${available.join(" or ")}`);
	}

	if (!/^[\w.\-+]+$/.test(name)) name = name.replace(/[^\w.\-+]+/g, "-");
	const dir = opts.outDir ?? themesDir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.json`);
	fs.writeFileSync(file, `${JSON.stringify({ name, background, source: via, groups }, null, "\t")}\n`);
	return { name, file, groups: Object.keys(groups).length, via };
}
