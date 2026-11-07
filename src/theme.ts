/**
 * Vigent theme engine.
 *
 * Themes are keyed by Neovim highlight group names (Normal, StatusLine,
 * Visual, Comment, DiffAdd, ...), so any vim/nvim colorscheme maps on
 * directly. A group is resolved in this order:
 *
 *   1. user overrides (config [highlights] and live `:hi`) and the theme's
 *      own definition, following `link`s
 *   2. colors derived from the theme for vigent's own groups the theme does
 *      not define (mode badges, sidebar background)
 *   3. vim-style fallback links, ending at Normal
 *
 * A group with no foreground uses Normal's foreground, like nvim.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { BUILTIN_THEMES } from "./builtin-themes.js";
import { isLight, mix, parseHex } from "./color.js";
import { fromPalette, type Palette } from "./palette.js";
import { parseHighlightCommand, parseVimColorscheme } from "./vimcolors.js";

export interface Attr {
	/** "#rrggbb", or "NONE" for the terminal's own color (transparent) */
	fg?: string;
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	reverse?: boolean;
	/** follow another group instead, like `:hi link` */
	link?: string;
}

export interface Theme {
	name: string;
	background?: "dark" | "light";
	groups: Record<string, Attr>;
}

export const RESET = "\x1b[0m";

/** Build an SGR escape sequence for an attribute set. */
export function sgr(attr: Attr): string {
	const parts: string[] = [];
	if (attr.bold) parts.push("1");
	if (attr.italic) parts.push("3");
	if (attr.underline) parts.push("4");
	if (attr.reverse) parts.push("7");
	const fg = parseHex(attr.fg);
	if (fg) parts.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`);
	const bg = parseHex(attr.bg);
	if (bg) parts.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`);
	return parts.length === 0 ? "" : `\x1b[${parts.join(";")}m`;
}

/** Fallback links, mirroring how nvim links its default groups. */
const LINKS: Record<string, string> = {
	NormalNC: "Normal",
	NormalFloat: "Pmenu",
	FloatBorder: "NormalFloat",
	FloatTitle: "Title",
	WinSeparator: "VertSplit",
	VertSplit: "NonText",
	EndOfBuffer: "NonText",
	CursorLineNr: "LineNr",
	LineNr: "NonText",
	StatusLineNC: "StatusLine",
	WinBar: "Title",
	TabLine: "StatusLineNC",
	TabLineSel: "StatusLine",
	Directory: "Identifier",
	Function: "Identifier",
	Keyword: "Statement",
	Title: "Normal",
	MsgArea: "Normal",
	PmenuSel: "Visual",
	CurSearch: "Search",
	IncSearch: "Search",
	Added: "DiffAdd",
	Removed: "DiffDelete",
	Changed: "DiffChange",
	// tree plugins: imported themes keep their sidebar colors
	NeoTreeNormal: "NvimTreeNormal",
	NeoTreeIndentMarker: "NvimTreeIndentMarker",
	NvimTreeIndentMarker: "NonText",
	// vigent groups
	VigentSidebar: "NeoTreeNormal",
	VigentIndent: "NeoTreeIndentMarker",
	VigentUser: "Title",
	VigentTool: "Function",
	VigentToolOutput: "Comment",
	VigentSpinner: "WarningMsg",
};

function hasStyle(a: Attr | undefined): a is Attr {
	if (!a) return false;
	return Object.entries(a).some(([k, v]) => k !== "link" && v !== undefined);
}

/** Colors computed from the theme when it does not define a group itself. */
const DERIVED: Record<string, (p: Painter) => Attr | undefined> = {
	VigentModeNormal: (p) => p.badge(["Function", "Directory", "Identifier"]),
	VigentModeInsert: (p) => p.badge(["String", "MoreMsg", "Added"]),
	VigentModeVisual: (p) => p.badge(["Statement", "Constant", "Special"]),
	VigentModeCommand: (p) => p.badge(["WarningMsg", "Type", "Todo"]),
	// last link in the sidebar chain: shade Normal's background
	NvimTreeNormal: (p) => {
		const n = p.normal();
		if (!parseHex(n.bg)) return undefined;
		return { fg: n.fg, bg: mix(n.bg!, "#000000", isLight(n.bg) ? 0.05 : 0.22) };
	},
};

export class Painter {
	private sgrCache = new Map<string, string>();
	private attrCache = new Map<string, Attr>();
	overrides: Record<string, Attr>;
	/** bumped whenever colors change, so renderers can drop cached output */
	generation = 0;

	constructor(
		public theme: Theme,
		overrides: Record<string, Attr> = {},
	) {
		this.overrides = { ...overrides };
	}

	/** Theme definition with user overrides merged on top. */
	private explicit(group: string): Attr | undefined {
		const o = this.overrides[group];
		const t = this.theme.groups[group];
		if (!o) return t;
		if (o.link) return { link: o.link };
		const base = t && !t.link ? t : {};
		return { ...base, ...o };
	}

	normal(): Attr {
		const n = this.explicit("Normal");
		return n && !n.link ? n : {};
	}

	/** Resolve a group without filling in Normal's foreground. */
	private resolve(group: string): Attr {
		const seen = new Set<string>();
		let g: string | undefined = group;
		while (g && !seen.has(g)) {
			seen.add(g);
			const e = this.explicit(g);
			if (e?.link) {
				g = e.link;
				continue;
			}
			if (hasStyle(e)) return e;
			const derived = DERIVED[g]?.(this);
			if (derived) return derived;
			g = LINKS[g];
		}
		return this.normal();
	}

	attr(group: string): Attr {
		let a = this.attrCache.get(group);
		if (!a) {
			const { link: _link, ...r } = this.resolve(group);
			a = r;
			if (group !== "Normal" && a.fg === undefined && !a.reverse) {
				const fg = this.normal().fg;
				if (fg) a = { ...a, fg };
			}
			this.attrCache.set(group, a);
		}
		return a;
	}

	/** A mode badge colored from the first candidate group with a usable foreground. */
	badge(candidates: string[]): Attr | undefined {
		const n = this.normal();
		for (const c of candidates) {
			const color = this.resolve(c).fg;
			if (!parseHex(color) || color === n.fg) continue;
			const text = parseHex(n.bg) ? n.bg : isLight(color) ? "#111111" : "#eeeeee";
			return { fg: text, bg: color, bold: true };
		}
		const s = this.resolve("StatusLine");
		return hasStyle(s) ? { ...s, bold: true } : undefined;
	}

	/** SGR prefix for a group (cached). */
	s(group: string): string {
		let v = this.sgrCache.get(group);
		if (v === undefined) {
			v = sgr(this.attr(group));
			this.sgrCache.set(group, v);
		}
		return v;
	}

	/** SGR prefix for a group drawn on an explicit background (cached). */
	on(group: string, bg: string | undefined, extra?: Attr): string {
		const key = `${group}|${bg ?? ""}|${extra ? JSON.stringify(extra) : ""}`;
		let v = this.sgrCache.get(key);
		if (v === undefined) {
			v = sgr({ ...this.attr(group), ...extra, bg });
			this.sgrCache.set(key, v);
		}
		return v;
	}

	/** Paint text with a group, resetting afterwards. */
	p(group: string, text: string): string {
		return this.s(group) + text + RESET;
	}

	setTheme(theme: Theme) {
		this.theme = theme;
		this.flush();
	}

	setOverrides(overrides: Record<string, Attr>) {
		this.overrides = { ...overrides };
		this.flush();
	}

	/** `:hi Group ...`: merge into the group, like vim. */
	highlight(group: string, attr: Attr) {
		const current = this.overrides[group];
		this.overrides[group] = current && !current.link ? { ...current, ...attr } : { ...attr };
		this.flush();
	}

	/** `:hi link From To` */
	link(from: string, to: string) {
		this.overrides[from] = { link: to };
		this.flush();
	}

	/** `:hi clear [Group]`: drop overrides, back to the theme's colors. */
	clear(group?: string) {
		if (group) delete this.overrides[group];
		else this.overrides = {};
		this.flush();
	}

	private flush() {
		this.sgrCache.clear();
		this.attrCache.clear();
		this.generation++;
	}
}

// ---------------------------------------------------------------------------
// Loading themes from files
// ---------------------------------------------------------------------------

export function configDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return path.join(xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config"), "vigent");
}

export function themesDir(): string {
	return path.join(configDir(), "themes");
}

const THEME_EXTS = [".toml", ".json", ".vim"];
const SPEC_KEYS = ["name", "background", "extends", "palette", "groups", "highlights"];

/** A theme file: extend another theme, define a palette, and/or set groups. */
export interface ThemeSpec {
	name?: string;
	background?: "dark" | "light";
	extends?: string;
	palette?: Partial<Palette>;
	groups?: Record<string, unknown>;
	highlights?: Record<string, unknown>;
}

/**
 * Normalize user-written group values. Each value may be:
 *   { fg = "#..", bg = "NONE", bold = true }   table / object
 *   { link = "Visual" }                         link
 *   "guifg=#.. guibg=#.. gui=bold"              vim :hi syntax
 *   "Visual"                                    shorthand for a link
 */
export function normalizeGroups(input: Record<string, unknown> | undefined): Record<string, Attr> {
	const out: Record<string, Attr> = {};
	if (!input) return out;
	for (const [group, value] of Object.entries(input)) {
		if (typeof value === "string") {
			if (/=/.test(value) || /^(bold|italic|underline|reverse|NONE)\b/i.test(value)) {
				const cmd = parseHighlightCommand(`${group} ${value}`);
				if (cmd?.kind === "set") out[group] = cmd.attr;
			} else {
				out[group] = { link: value };
			}
			continue;
		}
		if (value && typeof value === "object") {
			const v = value as Record<string, unknown>;
			const attr: Attr = {};
			for (const key of ["fg", "bg", "link"] as const) {
				if (typeof v[key] === "string") attr[key] = v[key] as string;
			}
			for (const key of ["bold", "italic", "underline", "reverse"] as const) {
				if (typeof v[key] === "boolean") attr[key] = v[key] as boolean;
			}
			out[group] = attr;
		}
	}
	return out;
}

function readSpec(file: string): ThemeSpec {
	const text = fs.readFileSync(file, "utf8");
	if (file.endsWith(".vim")) {
		const parsed = parseVimColorscheme(text);
		return { name: parsed.name, background: parsed.background, groups: parsed.groups as Record<string, unknown> };
	}
	const raw = (file.endsWith(".toml") ? parseToml(text) : JSON.parse(text)) as Record<string, unknown>;
	if (!Object.keys(raw).some((k) => SPEC_KEYS.includes(k))) return { groups: raw };
	return raw as ThemeSpec;
}

function findThemeFile(name: string): string | undefined {
	if (/[/\\]/.test(name) || THEME_EXTS.some((e) => name.endsWith(e))) {
		const p = path.resolve(name.replace(/^~(?=\/)/, os.homedir()));
		return fs.existsSync(p) ? p : undefined;
	}
	for (const ext of THEME_EXTS) {
		const p = path.join(themesDir(), name + ext);
		if (fs.existsSync(p)) return p;
	}
	return undefined;
}

export function buildTheme(spec: ThemeSpec, fallbackName: string, seen = new Set<string>()): Theme {
	const name = spec.name ?? fallbackName;
	let groups: Record<string, Attr> = {};
	let background = spec.background;

	if (spec.extends) {
		if (seen.has(spec.extends)) throw new Error(`theme '${name}' extends itself through '${spec.extends}'`);
		const base = loadTheme(spec.extends, new Set([...seen, name]));
		groups = { ...base.groups };
		background ??= base.background;
	}
	if (spec.palette) {
		const missing = (["bg", "fg", "red", "yellow", "green", "cyan", "blue", "magenta"] as const).filter(
			(k) => !spec.palette?.[k],
		);
		if (missing.length > 0) throw new Error(`theme '${name}': palette is missing ${missing.join(", ")}`);
		const t = fromPalette(name, spec.palette as Palette);
		groups = { ...groups, ...t.groups };
		background ??= t.background;
	}
	groups = { ...groups, ...normalizeGroups(spec.groups), ...normalizeGroups(spec.highlights) };
	return { name, background, groups };
}

/** Load a built-in theme, a theme file from ~/.config/vigent/themes, or a path. */
export function loadTheme(nameOrPath: string, seen = new Set<string>()): Theme {
	const builtin = BUILTIN_THEMES[nameOrPath];
	if (builtin) return builtin;
	const file = findThemeFile(nameOrPath);
	if (!file) throw new Error(`E185: Cannot find color scheme '${nameOrPath}'`);
	const fallbackName = path.basename(file).replace(/\.(toml|json|vim)$/, "");
	return buildTheme(readSpec(file), fallbackName, seen);
}

export function listThemes(): string[] {
	const names = new Set(Object.keys(BUILTIN_THEMES));
	try {
		for (const f of fs.readdirSync(themesDir())) {
			const ext = THEME_EXTS.find((e) => f.endsWith(e));
			if (ext) names.add(f.slice(0, -ext.length));
		}
	} catch {
		// no user themes dir yet
	}
	return [...names].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
}

export { BUILTIN_THEMES };
