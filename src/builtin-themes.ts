/** Built-in themes. Hand-ported themes are explicit; the rest are built from a palette. */
import { fromPalette } from "./palette.js";
import type { Theme } from "./theme.js";

// ---------------------------------------------------------------------------
// Neovim's default dark colorscheme (NvimDark / NvimLight palette, nvim >= 0.10)
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
	background: "dark",
	groups: {
		Normal: { fg: c.lightGrey2, bg: c.darkGrey2 },
		NormalFloat: { fg: c.lightGrey2, bg: c.darkGrey1 },
		WinSeparator: { fg: c.darkGrey4, bg: c.darkGrey2 },
		StatusLine: { fg: c.darkGrey3, bg: c.lightGrey3 },
		StatusLineNC: { fg: c.lightGrey4, bg: c.darkGrey3 },
		CursorLine: { bg: c.darkGrey3 },
		Visual: { bg: c.darkGrey4 },
		LineNr: { fg: c.darkGrey4 },
		CursorLineNr: { fg: c.lightGrey2, bold: true },
		WinBar: { fg: c.lightGrey2, bold: true },
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
		VigentSidebar: { fg: c.lightGrey2, bg: c.darkGrey1 },
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
	bg0h: "#1d2021",
	bg0: "#282828",
	bg1: "#3c3836",
	bg2: "#504945",
	bg3: "#665c54",
	bg4: "#7c6f64",
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
	background: "dark",
	groups: {
		Normal: { fg: g.fg1, bg: g.bg0 },
		WinSeparator: { fg: g.bg3, bg: g.bg0 },
		StatusLine: { fg: g.bg0, bg: g.fg3 },
		StatusLineNC: { fg: g.fg3, bg: g.bg1 },
		CursorLine: { bg: g.bg1 },
		Visual: { bg: g.bg2 },
		LineNr: { fg: g.bg4 },
		CursorLineNr: { fg: g.yellow, bold: true },
		WinBar: { fg: g.fg1, bold: true },
		VigentSidebar: { fg: g.fg1, bg: g.bg0h },
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

// ---------------------------------------------------------------------------
// Palette themes: each palette expands to the full set of highlight groups
// ---------------------------------------------------------------------------
export const TOKYONIGHT = fromPalette("tokyonight", {
	bg: "#1a1b26", bg_dark: "#16161e", bg_alt: "#292e42", selection: "#283457",
	fg: "#c0caf5", muted: "#565f89", subtle: "#3b4261",
	red: "#f7768e", orange: "#ff9e64", yellow: "#e0af68", green: "#9ece6a",
	cyan: "#7dcfff", blue: "#7aa2f7", magenta: "#bb9af7", accent: "#ff9e64",
});

// ---------------------------------------------------------------------------
// tokyonight "moon": the colorscheme LazyVim starts with. `lazyvim` is the same
// palette drawn on the terminal's own background, LazyVim's transparent look.
// ---------------------------------------------------------------------------
const moon = {
	bg: "#222436", bg_dark: "#1e2030", bg_highlight: "#2f334d", visual: "#2d3f76", border: "#589ed7",
	fg: "#c8d3f5", fg_dark: "#828bb8", comment: "#636da6", gutter: "#3b4261", dark5: "#737aa2", black: "#1b1d2b",
	red: "#ff757f", orange: "#ff966c", yellow: "#ffc777", green: "#c3e88d", teal: "#4fd6be",
	cyan: "#86e1fc", blue: "#82aaff", blue0: "#3e68d7", blue1: "#65bcff", magenta: "#c099ff",
};
const moonBadge = (bg: string) => ({ fg: moon.black, bg, bold: true });

export const TOKYONIGHT_MOON: Theme = (() => {
	const t = fromPalette("tokyonight-moon", {
		bg: moon.bg, bg_dark: moon.bg_dark, bg_alt: moon.bg_highlight, selection: moon.visual,
		fg: moon.fg, muted: moon.comment, subtle: moon.gutter,
		red: moon.red, orange: moon.orange, yellow: moon.yellow, green: moon.green,
		cyan: moon.cyan, blue: moon.blue, magenta: moon.magenta, accent: moon.orange,
	});
	Object.assign(t.groups, {
		NormalFloat: { fg: moon.fg, bg: moon.bg_dark },
		FloatBorder: { fg: moon.border, bg: moon.bg_dark },
		FloatTitle: { fg: moon.border, bg: moon.bg_dark, bold: true },
		WinSeparator: { fg: moon.gutter, bold: true },
		StatusLine: { fg: moon.fg_dark, bg: moon.bg_dark },
		StatusLineNC: { fg: moon.gutter, bg: moon.bg_dark },
		CursorLineNr: { fg: moon.orange, bold: true },
		Keyword: { fg: moon.cyan, italic: true },
		Type: { fg: moon.blue1 },
		Special: { fg: moon.blue1 },
		Search: { fg: moon.fg, bg: moon.blue0 },
		CurSearch: { fg: moon.black, bg: moon.orange },
		DiffAdd: { bg: "#273849" },
		DiffDelete: { bg: "#3a273a" },
		DiffChange: { bg: "#252a3f" },
		Added: { fg: "#b8db87" },
		Removed: { fg: "#e26a75" },
		Changed: { fg: "#7ca1f2" },
		Pmenu: { fg: moon.fg, bg: moon.bg_dark },
		PmenuSel: { bg: "#363c58", bold: true },
		NeoTreeNormal: { fg: moon.fg, bg: moon.bg_dark },
		VigentSidebar: { link: "NeoTreeNormal" },
		VigentIndent: { fg: moon.gutter },
		VigentModeNormal: moonBadge(moon.blue),
		VigentModeInsert: moonBadge(moon.green),
		VigentModeVisual: moonBadge(moon.magenta),
		VigentModeCommand: moonBadge(moon.yellow),
		VigentUser: { fg: moon.blue, bold: true },
		VigentTool: { fg: moon.blue1 },
		VigentToolOutput: { fg: moon.dark5 },
		VigentSpinner: { fg: moon.orange },
	});
	return t;
})();

export const LAZYVIM: Theme = { ...TOKYONIGHT_MOON, name: "lazyvim", transparent: true };

export const CATPPUCCIN = fromPalette("catppuccin", {
	bg: "#1e1e2e", bg_dark: "#181825", bg_alt: "#313244", selection: "#45475a",
	fg: "#cdd6f4", muted: "#6c7086", subtle: "#585b70",
	red: "#f38ba8", orange: "#fab387", yellow: "#f9e2af", green: "#a6e3a1",
	cyan: "#94e2d5", blue: "#89b4fa", magenta: "#cba6f7", accent: "#b4befe",
});

export const CATPPUCCIN_LATTE = fromPalette("catppuccin-latte", {
	bg: "#eff1f5", bg_dark: "#e6e9ef", bg_alt: "#ccd0da", selection: "#bcc0cc",
	fg: "#4c4f69", muted: "#9ca0b0", subtle: "#acb0be",
	red: "#d20f39", orange: "#fe640b", yellow: "#df8e1d", green: "#40a02b",
	cyan: "#179299", blue: "#1e66f5", magenta: "#8839ef", accent: "#7287fd",
});

export const NORD = fromPalette("nord", {
	bg: "#2e3440", bg_dark: "#272c36", bg_alt: "#3b4252", selection: "#434c5e",
	fg: "#d8dee9", muted: "#616e88", subtle: "#4c566a",
	red: "#bf616a", orange: "#d08770", yellow: "#ebcb8b", green: "#a3be8c",
	cyan: "#88c0d0", blue: "#81a1c1", magenta: "#b48ead", accent: "#88c0d0",
});

export const ROSE_PINE = fromPalette("rose-pine", {
	bg: "#191724", bg_dark: "#1f1d2e", bg_alt: "#26233a", selection: "#403d52",
	fg: "#e0def4", muted: "#6e6a86", subtle: "#524f67",
	red: "#eb6f92", orange: "#ebbcba", yellow: "#f6c177", green: "#f6c177",
	cyan: "#9ccfd8", blue: "#ebbcba", magenta: "#c4a7e7", accent: "#f6c177",
});

export const KANAGAWA = fromPalette("kanagawa", {
	bg: "#1f1f28", bg_dark: "#16161d", bg_alt: "#2a2a37", selection: "#223249",
	fg: "#dcd7ba", muted: "#727169", subtle: "#54546d",
	red: "#e46876", orange: "#ffa066", yellow: "#e6c384", green: "#98bb6c",
	cyan: "#7fb4ca", blue: "#7e9cd8", magenta: "#957fb8", accent: "#ffa066",
});

export const BUILTIN_THEMES: Record<string, Theme> = {
	default: NVIM_DEFAULT,
	gruvbox: GRUVBOX,
	tokyonight: TOKYONIGHT,
	"tokyonight-moon": TOKYONIGHT_MOON,
	lazyvim: LAZYVIM,
	catppuccin: CATPPUCCIN,
	"catppuccin-latte": CATPPUCCIN_LATTE,
	nord: NORD,
	"rose-pine": ROSE_PINE,
	kanagawa: KANAGAWA,
};
