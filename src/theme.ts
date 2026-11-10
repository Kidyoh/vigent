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
import { isLight, mix, nearest256, parseHex } from "./color.js";
import { parseStyle, type StyleSpec } from "./style.js";
import { fromPalette, type Palette } from "./palette.js";
import { didYouMean } from "./suggest.js";
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
	/** draw on the terminal's own background (like tokyonight's `transparent = true`) */
	transparent?: boolean;
	/** the palette it was built from, when it was */
	palette?: Palette;
	/** how it lays things out: sidebar, messages, icons (see style.ts) */
	style?: StyleSpec;
}

/**
 * Groups that paint a background behind text. A transparent theme drops their
 * background so the terminal's (and its blur or wallpaper) shows through;
 * selections, the cursorline, popup menus and mode badges keep theirs.
 */
export const TRANSPARENT_GROUPS = new Set([
	"Normal",
	"NormalNC",
	"NormalFloat",
	"FloatBorder",
	"FloatTitle",
	"MsgArea",
	"StatusLine",
	"StatusLineNC",
	"WinBar",
	"WinBarNC",
	"WinSeparator",
	"LineNr",
	"CursorLineNr",
	"SignColumn",
	"EndOfBuffer",
	"VigentSidebar",
	"NeoTreeNormal",
	"NvimTreeNormal",
]);

export const RESET = "\x1b[0m";

export type ColorMode = "truecolor" | "256";

/** Build an SGR escape sequence for an attribute set (24-bit color, or the nearest of 256). */
export function sgr(attr: Attr, mode: ColorMode = "truecolor"): string {
	const parts: string[] = [];
	if (attr.bold) parts.push("1");
	if (attr.italic) parts.push("3");
	if (attr.underline) parts.push("4");
	if (attr.reverse) parts.push("7");
	const fg = parseHex(attr.fg);
	if (fg) parts.push(mode === "256" ? `38;5;${nearest256(attr.fg!)}` : `38;2;${fg[0]};${fg[1]};${fg[2]}`);
	else if (attr.fg === "NONE") parts.push("39"); // the terminal's own color, replacing whatever came before
	const bg = parseHex(attr.bg);
	if (bg) parts.push(mode === "256" ? `48;5;${nearest256(attr.bg!)}` : `48;2;${bg[0]};${bg[1]};${bg[2]}`);
	else if (attr.bg === "NONE") parts.push("49"); // transparent: the terminal's own background
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
	/** `@path` in a prompt */
	VigentMention: "Directory",
	VigentTool: "Function",
	VigentToolOutput: "Comment",
	VigentSpinner: "WarningMsg",
	VigentCode: "String",
	Question: "MoreMsg",
	MoreMsg: "String",
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
	/** 24-bit color, or the nearest of 256 for terminals without it (vim's 'termguicolors') */
	colorMode: ColorMode = "truecolor";
	/** `:set transparent` / `notransparent`; "auto" follows the theme */
	transparency: boolean | "auto" = "auto";

	setTransparency(t: boolean | "auto") {
		if (t === this.transparency) return;
		this.transparency = t;
		this.flush();
	}

	/** Is the terminal's background showing through right now? */
	get transparent(): boolean {
		return this.transparency === "auto" ? Boolean(this.theme.transparent) : this.transparency;
	}

	setColorMode(mode: ColorMode) {
		if (mode === this.colorMode) return;
		this.colorMode = mode;
		this.flush();
	}

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
			// transparent: background groups, and anything painted on Normal's background, use the terminal's
			if (this.transparent && a.bg !== undefined && a.bg !== "NONE") {
				const normalBg = this.normal().bg;
				if (TRANSPARENT_GROUPS.has(group) || (normalBg && a.bg.toLowerCase() === normalBg.toLowerCase())) {
					a = { ...a, bg: "NONE" };
				}
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
			v = sgr(this.attr(group), this.colorMode);
			this.sgrCache.set(group, v);
		}
		return v;
	}

	/** SGR prefix for a group drawn on an explicit background (cached). */
	on(group: string, bg: string | undefined, extra?: Attr): string {
		const key = `${group}|${bg ?? ""}|${extra ? JSON.stringify(extra) : ""}`;
		let v = this.sgrCache.get(key);
		if (v === undefined) {
			v = sgr({ ...this.attr(group), ...extra, bg }, this.colorMode);
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
const SPEC_KEYS = ["name", "background", "extends", "transparent", "palette", "groups", "highlights", "style"];

/** A theme file: extend another theme, define a palette, and/or set groups. */
export interface ThemeSpec {
	name?: string;
	background?: "dark" | "light";
	extends?: string;
	/** use the terminal's background (sidebar, floats and statusline too) */
	transparent?: boolean;
	palette?: Partial<Palette>;
	groups?: Record<string, unknown>;
	highlights?: Record<string, unknown>;
	/** layout: sidebar = "cards", messages = "bubbles", [style.icons] ... (see style.ts) */
	style?: unknown;
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
	let transparent = typeof spec.transparent === "boolean" ? spec.transparent : undefined;
	let palette: Palette | undefined;
	let style: StyleSpec | undefined;

	if (spec.extends) {
		if (seen.has(spec.extends)) throw new Error(`theme '${name}' extends itself through '${spec.extends}'`);
		const base = loadTheme(spec.extends, new Set([...seen, name]));
		groups = { ...base.groups };
		background ??= base.background;
		transparent ??= base.transparent;
		palette = base.palette;
		style = base.style;
	}
	if (spec.style !== undefined) {
		// a theme file's style mistakes are left out; the rest of the style still counts
		const own = parseStyle(spec.style, `theme '${name}'`, []);
		style = { ...style, ...own, ...(style?.icons || own.icons ? { icons: { ...style?.icons, ...own.icons } } : {}) };
	}
	if (spec.palette) {
		const missing = (["bg", "fg", "red", "yellow", "green", "cyan", "blue", "magenta"] as const).filter(
			(k) => !spec.palette?.[k],
		);
		if (missing.length > 0) throw new Error(`theme '${name}': palette is missing ${missing.join(", ")}`);
		const t = fromPalette(name, spec.palette as Palette);
		groups = { ...groups, ...t.groups };
		background ??= t.background;
		palette = t.palette;
	}
	groups = { ...groups, ...normalizeGroups(spec.groups), ...normalizeGroups(spec.highlights) };
	// groups set after the palette may have changed its colors; only keep it when they didn't
	const exactPalette = palette && !spec.groups && !spec.highlights ? palette : undefined;
	return {
		name,
		background,
		groups,
		...(transparent ? { transparent } : {}),
		...(exactPalette ? { palette: exactPalette } : {}),
		...(style && Object.keys(style).length ? { style } : {}),
	};
}

/** Load a built-in theme, a theme file from ~/.config/vigent/themes, or a path. */
export function loadTheme(nameOrPath: string, seen = new Set<string>()): Theme {
	const builtin = BUILTIN_THEMES[nameOrPath];
	if (builtin) return builtin;
	const file = findThemeFile(nameOrPath);
	if (!file) throw new Error(`E185: Cannot find color scheme '${nameOrPath}'${didYouMean(nameOrPath, listThemes())}`);
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

/** The palette a theme's colors come from, read back from its groups (for `vigent theme new`). */
export function extractPalette(theme: Theme): Palette {
	if (theme.palette) return { ...theme.palette };
	const p = new Painter({ ...theme, transparent: false });
	const fg = (...groups: string[]) => {
		for (const g of groups) {
			const c = p.attr(g).fg;
			if (parseHex(c)) return c!;
		}
		return p.attr("Normal").fg ?? "#c0c0c0";
	};
	const bg = (fallback: string, ...groups: string[]) => {
		for (const g of groups) {
			const c = p.attr(g).bg;
			if (parseHex(c)) return c!;
		}
		return fallback;
	};
	const base = bg("#1a1b26", "Normal");
	return {
		bg: base,
		fg: fg("Normal"),
		red: fg("ErrorMsg", "DiagnosticError", "Removed"),
		yellow: fg("WarningMsg", "Type"),
		green: fg("String", "Added"),
		cyan: fg("Special", "Function"),
		blue: fg("Function", "Directory", "Title"),
		magenta: fg("Statement", "Keyword", "Identifier"),
		bg_dark: bg(base, "VigentSidebar", "NormalFloat"),
		bg_alt: bg(base, "CursorLine", "StatusLine"),
		selection: bg(base, "Visual"),
		muted: fg("Comment"),
		subtle: fg("LineNr", "NonText"),
		orange: fg("Constant", "WarningMsg"),
		accent: fg("CursorLineNr", "Title"),
	};
}

/** A theme file (TOML) for `:theme save`: what's on screen, as small as it can be. */
export function themeFileFor(name: string, painter: Painter, builtinBase: boolean): string {
	const lines = [`# ${name}: saved from vigent with :theme save. Edit freely; reload with :colorscheme ${name}`, `name = "${name}"`];
	const groups: Record<string, Attr> = builtinBase ? { ...painter.overrides } : { ...painter.theme.groups, ...painter.overrides };
	if (builtinBase) lines.push(`extends = "${painter.theme.name}"`);
	else if (painter.theme.background) lines.push(`background = "${painter.theme.background}"`);
	if (painter.transparent !== Boolean(builtinBase && painter.theme.transparent) || (!builtinBase && painter.transparent)) {
		lines.push(`transparent = ${painter.transparent}`);
	}
	lines.push("", "[groups]");
	for (const [group, attr] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`${/^[A-Za-z0-9_-]+$/.test(group) ? group : JSON.stringify(group)} = ${tomlAttr(attr)}`);
	}
	return `${lines.join("\n")}\n`;
}

function tomlAttr(a: Attr): string {
	if (a.link) return JSON.stringify(a.link);
	const parts: string[] = [];
	for (const k of ["fg", "bg"] as const) if (a[k]) parts.push(`${k} = ${JSON.stringify(a[k])}`);
	for (const k of ["bold", "italic", "underline", "reverse"] as const) if (a[k] !== undefined) parts.push(`${k} = ${a[k]}`);
	return `{ ${parts.join(", ")} }`;
}

export { BUILTIN_THEMES };
