/**
 * Vigent theme engine.
 *
 * Themes are keyed by *Neovim highlight group names* (Normal, StatusLine,
 * Visual, Comment, DiffAdd, ...). The default theme reproduces Neovim's
 * built-in dark colorscheme (the NvimDark / NvimLight palette, nvim >= 0.10).
 *
 * Any vim/nvim colorscheme can be brought in:
 *   - `vigent theme import <colorscheme>` dumps highlight groups from a local
 *     nvim via `nvim --headless` into ~/.config/vigent/themes/<name>.json
 *   - or drop a JSON file mapping group -> {fg, bg, bold, ...} in that dir.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Attr {
	fg?: string; // #rrggbb
	bg?: string; // #rrggbb
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	reverse?: boolean;
}

export interface Theme {
	name: string;
	groups: Record<string, Attr>;
}

export const RESET = "\x1b[0m";

function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Build an SGR escape sequence for an attribute set. */
export function sgr(attr: Attr): string {
	const parts: string[] = [];
	if (attr.bold) parts.push("1");
	if (attr.italic) parts.push("3");
	if (attr.underline) parts.push("4");
	if (attr.reverse) parts.push("7");
	const fg = attr.fg ? hexToRgb(attr.fg) : null;
	if (fg) parts.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`);
	const bg = attr.bg ? hexToRgb(attr.bg) : null;
	if (bg) parts.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`);
	if (parts.length === 0) return "";
	return `\x1b[${parts.join(";")}m`;
}

/** Fallback chains, mirroring how vim links highlight groups. */
const LINKS: Record<string, string> = {
	NormalNC: "Normal",
	WinSeparator: "Normal",
	VertSplit: "WinSeparator",
	CursorLineNr: "LineNr",
	StatusLineNC: "StatusLine",
	TabLine: "StatusLineNC",
	TabLineSel: "StatusLine",
	Directory: "Identifier",
	Function: "Identifier",
	Title: "Normal",
	ModeMsg: "Normal",
	MsgArea: "Normal",
	Pmenu: "StatusLineNC",
	PmenuSel: "StatusLine",
	CurSearch: "Search",
	IncSearch: "Search",
	Added: "DiffAdd",
	Removed: "DiffDelete",
	Changed: "DiffChange",
	// Vigent-specific groups -> sensible vim fallbacks
	VigentModeNormal: "StatusLine",
	VigentModeInsert: "ModeMsg",
	VigentModeVisual: "Visual",
	VigentModeCommand: "Search",
	VigentAgent: "Normal",
	VigentUser: "Title",
	VigentTool: "Function",
	VigentToolOutput: "Comment",
	VigentSpinner: "WarningMsg",
};

export class Painter {
	private cache = new Map<string, string>();
	constructor(public theme: Theme) {}

	attr(group: string): Attr {
		const seen = new Set<string>();
		let g: string | undefined = group;
		while (g && !seen.has(g)) {
			seen.add(g);
			const a = this.theme.groups[g];
			if (a && Object.keys(a).length > 0) return a;
			g = LINKS[g];
		}
		return this.theme.groups.Normal ?? {};
	}

	/** SGR prefix for a group (cached). */
	s(group: string): string {
		let v = this.cache.get(group);
		if (v === undefined) {
			v = sgr(this.attr(group));
			this.cache.set(group, v);
		}
		return v;
	}

	/** Paint text with a group, resetting afterwards. */
	p(group: string, text: string): string {
		return this.s(group) + text + RESET;
	}

	setTheme(theme: Theme) {
		this.theme = theme;
		this.cache.clear();
	}
}

// ---------------------------------------------------------------------------
// Built-in: Neovim default dark colorscheme (NvimDark*/NvimLight* palette)
// ---------------------------------------------------------------------------
const c = {
	darkBlue: "#004c73",
	darkCyan: "#007373",
	darkGreen: "#005523",
	darkGrey1: "#07080d",
	darkGrey2: "#14161b",
	darkGrey3: "#2c2e33",
	darkGrey4: "#4f5258",
	darkMagenta: "#470045",
	darkRed: "#590008",
	darkYellow: "#6b5300",
	lightBlue: "#a6dbff",
	lightCyan: "#8cf8f7",
	lightGreen: "#b3f6c0",
	lightGrey1: "#eef1f8",
	lightGrey2: "#e0e2ea",
	lightGrey3: "#c4c6cd",
	lightGrey4: "#9b9ea4",
	lightMagenta: "#ffcaff",
	lightRed: "#ffc0b9",
	lightYellow: "#fce094",
};

export const NVIM_DEFAULT: Theme = {
	name: "default",
	groups: {
		Normal: { fg: c.lightGrey2, bg: c.darkGrey2 },
		NormalFloat: { fg: c.lightGrey2, bg: c.darkGrey1 },
		WinSeparator: { fg: c.darkGrey4, bg: c.darkGrey2 },
		StatusLine: { fg: c.darkGrey3, bg: c.lightGrey3 },
		StatusLineNC: { fg: c.lightGrey4, bg: c.darkGrey3 },
		CursorLine: { bg: c.darkGrey3 },
		Visual: { bg: c.darkGrey4 },
		LineNr: { fg: c.lightGrey4, bg: c.darkGrey2 },
		Comment: { fg: c.lightGrey4, italic: true },
		NonText: { fg: c.darkGrey4 },
		Title: { fg: c.lightGrey2, bold: true },
		Identifier: { fg: c.lightBlue },
		Function: { fg: c.lightCyan },
		String: { fg: c.lightGreen },
		Constant: { fg: c.lightMagenta },
		Keyword: { fg: c.lightGrey2, bold: true },
		Search: { fg: c.lightGrey1, bg: c.darkYellow },
		CurSearch: { fg: c.darkGrey1, bg: c.lightYellow },
		DiffAdd: { fg: c.lightGreen, bg: c.darkGreen },
		DiffDelete: { fg: c.lightRed, bg: c.darkRed },
		DiffChange: { fg: c.lightGrey2, bg: c.darkGrey4 },
		Added: { fg: c.lightGreen },
		Removed: { fg: c.lightRed },
		ErrorMsg: { fg: c.lightRed },
		WarningMsg: { fg: c.lightYellow },
		ModeMsg: { fg: c.lightGreen, bold: true },
		Pmenu: { fg: c.lightGrey2, bg: c.darkGrey3 },
		PmenuSel: { fg: c.darkGrey2, bg: c.lightGrey3 },
		// Vigent mode badges (vim-airline-style blocks)
		VigentModeNormal: { fg: c.darkGrey1, bg: c.lightBlue, bold: true },
		VigentModeInsert: { fg: c.darkGrey1, bg: c.lightGreen, bold: true },
		VigentModeVisual: { fg: c.darkGrey1, bg: c.lightMagenta, bold: true },
		VigentModeCommand: { fg: c.darkGrey1, bg: c.lightYellow, bold: true },
		VigentUser: { fg: c.lightBlue, bold: true },
		VigentTool: { fg: c.lightCyan },
		VigentToolOutput: { fg: c.lightGrey4 },
		VigentSpinner: { fg: c.lightYellow },
	},
};

// ---------------------------------------------------------------------------
// Built-in: gruvbox (dark, medium) — ported from morhetz/gruvbox
// ---------------------------------------------------------------------------
const g = {
	bg0: "#282828",
	bg1: "#3c3836",
	bg2: "#504945",
	bg3: "#665c54",
	fg0: "#fbf1c7",
	fg1: "#ebdbb2",
	fg3: "#bdae93",
	grey: "#928374",
	red: "#fb4934",
	green: "#b8bb26",
	yellow: "#fabd2f",
	blue: "#83a598",
	purple: "#d3869b",
	aqua: "#8ec07c",
	orange: "#fe8019",
	darkRed: "#421e1e",
	darkGreen: "#32361a",
};

export const GRUVBOX: Theme = {
	name: "gruvbox",
	groups: {
		Normal: { fg: g.fg1, bg: g.bg0 },
		WinSeparator: { fg: g.bg3, bg: g.bg0 },
		StatusLine: { fg: g.bg0, bg: g.fg3 },
		StatusLineNC: { fg: g.fg3, bg: g.bg1 },
		CursorLine: { bg: g.bg1 },
		Visual: { bg: g.bg2 },
		LineNr: { fg: g.bg3 },
		Comment: { fg: g.grey, italic: true },
		NonText: { fg: g.bg2 },
		Title: { fg: g.green, bold: true },
		Identifier: { fg: g.blue },
		Function: { fg: g.aqua },
		String: { fg: g.green },
		Constant: { fg: g.purple },
		Keyword: { fg: g.red },
		Search: { fg: g.bg0, bg: g.yellow },
		DiffAdd: { fg: g.green, bg: g.darkGreen },
		DiffDelete: { fg: g.red, bg: g.darkRed },
		Added: { fg: g.green },
		Removed: { fg: g.red },
		ErrorMsg: { fg: g.red, bold: true },
		WarningMsg: { fg: g.yellow },
		ModeMsg: { fg: g.fg1, bold: true },
		Pmenu: { fg: g.fg1, bg: g.bg1 },
		PmenuSel: { fg: g.bg0, bg: g.blue },
		VigentModeNormal: { fg: g.bg0, bg: g.blue, bold: true },
		VigentModeInsert: { fg: g.bg0, bg: g.green, bold: true },
		VigentModeVisual: { fg: g.bg0, bg: g.orange, bold: true },
		VigentModeCommand: { fg: g.bg0, bg: g.yellow, bold: true },
		VigentUser: { fg: g.yellow, bold: true },
		VigentTool: { fg: g.aqua },
		VigentToolOutput: { fg: g.grey },
		VigentSpinner: { fg: g.orange },
	},
};

export const BUILTIN_THEMES: Record<string, Theme> = {
	default: NVIM_DEFAULT,
	gruvbox: GRUVBOX,
};

export function themesDir(): string {
	return path.join(os.homedir(), ".config", "vigent", "themes");
}

export function loadTheme(name: string): Theme {
	const builtin = BUILTIN_THEMES[name];
	if (builtin) return builtin;
	const file = path.join(themesDir(), `${name}.json`);
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	const groups: Record<string, Attr> = raw.groups ?? raw;
	return { name, groups };
}

export function listThemes(): string[] {
	const names = new Set(Object.keys(BUILTIN_THEMES));
	try {
		for (const f of fs.readdirSync(themesDir())) {
			if (f.endsWith(".json")) names.add(f.slice(0, -5));
		}
	} catch {
		// no user themes dir yet
	}
	return [...names].sort();
}
