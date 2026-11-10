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

// ---------------------------------------------------------------------------
// More popular colorschemes, from their published palettes
// ---------------------------------------------------------------------------

export const CATPPUCCIN_FRAPPE = fromPalette("catppuccin-frappe", {
	bg: "#303446", bg_dark: "#292c3c", bg_alt: "#414559", selection: "#51576d",
	fg: "#c6d0f5", muted: "#737994", subtle: "#626880",
	red: "#e78284", orange: "#ef9f76", yellow: "#e5c890", green: "#a6d189",
	cyan: "#81c8be", blue: "#8caaee", magenta: "#ca9ee6", accent: "#babbf1",
});

export const CATPPUCCIN_MACCHIATO = fromPalette("catppuccin-macchiato", {
	bg: "#24273a", bg_dark: "#1e2030", bg_alt: "#363a4f", selection: "#494d64",
	fg: "#cad3f5", muted: "#6e738d", subtle: "#5b6078",
	red: "#ed8796", orange: "#f5a97f", yellow: "#eed49f", green: "#a6da95",
	cyan: "#8bd5ca", blue: "#8aadf4", magenta: "#c6a0f6", accent: "#b7bdf8",
});

export const TOKYONIGHT_STORM = fromPalette("tokyonight-storm", {
	bg: "#24283b", bg_dark: "#1f2335", bg_alt: "#292e42", selection: "#2e3c64",
	fg: "#c0caf5", muted: "#565f89", subtle: "#3b4261",
	red: "#f7768e", orange: "#ff9e64", yellow: "#e0af68", green: "#9ece6a",
	cyan: "#7dcfff", blue: "#7aa2f7", magenta: "#bb9af7", accent: "#ff9e64",
});

export const ROSE_PINE_MOON = fromPalette("rose-pine-moon", {
	bg: "#232136", bg_dark: "#2a273f", bg_alt: "#393552", selection: "#44415a",
	fg: "#e0def4", muted: "#6e6a86", subtle: "#56526e",
	red: "#eb6f92", orange: "#ea9a97", yellow: "#f6c177", green: "#3e8fb0",
	cyan: "#9ccfd8", blue: "#3e8fb0", magenta: "#c4a7e7", accent: "#f6c177",
});

export const ROSE_PINE_DAWN = fromPalette("rose-pine-dawn", {
	bg: "#faf4ed", bg_dark: "#fffaf3", bg_alt: "#f2e9e1", selection: "#dfdad9",
	fg: "#575279", muted: "#9893a5", subtle: "#cecacd",
	red: "#b4637a", orange: "#d7827e", yellow: "#ea9d34", green: "#286983",
	cyan: "#56949f", blue: "#286983", magenta: "#907aa9", accent: "#ea9d34",
});

export const DRACULA = fromPalette("dracula", {
	bg: "#282a36", bg_dark: "#21222c", bg_alt: "#44475a", selection: "#44475a",
	fg: "#f8f8f2", muted: "#6272a4", subtle: "#4d5066",
	red: "#ff5555", orange: "#ffb86c", yellow: "#f1fa8c", green: "#50fa7b",
	cyan: "#8be9fd", blue: "#bd93f9", magenta: "#ff79c6", accent: "#ff79c6",
});

export const ONEDARK = fromPalette("onedark", {
	bg: "#282c34", bg_dark: "#21252b", bg_alt: "#2c313c", selection: "#3e4452",
	fg: "#abb2bf", muted: "#5c6370", subtle: "#4b5263",
	red: "#e06c75", orange: "#d19a66", yellow: "#e5c07b", green: "#98c379",
	cyan: "#56b6c2", blue: "#61afef", magenta: "#c678dd", accent: "#e5c07b",
});

export const EVERFOREST = fromPalette("everforest", {
	bg: "#2d353b", bg_dark: "#232a2e", bg_alt: "#343f44", selection: "#543a48",
	fg: "#d3c6aa", muted: "#859289", subtle: "#4f585e",
	red: "#e67e80", orange: "#e69875", yellow: "#dbbc7f", green: "#a7c080",
	cyan: "#83c092", blue: "#7fbbb3", magenta: "#d699b6", accent: "#a7c080",
});

export const NIGHTFOX = fromPalette("nightfox", {
	bg: "#192330", bg_dark: "#131a24", bg_alt: "#29394f", selection: "#2b3b51",
	fg: "#cdcecf", muted: "#738091", subtle: "#39506d",
	red: "#c94f6d", orange: "#f4a261", yellow: "#dbc074", green: "#81b29a",
	cyan: "#63cdcf", blue: "#719cd6", magenta: "#9d79d6", accent: "#f4a261",
});

export const SOLARIZED_DARK = fromPalette("solarized-dark", {
	bg: "#002b36", bg_dark: "#00212b", bg_alt: "#073642", selection: "#0b4a5a",
	fg: "#93a1a1", muted: "#586e75", subtle: "#2c4f58",
	red: "#dc322f", orange: "#cb4b16", yellow: "#b58900", green: "#859900",
	cyan: "#2aa198", blue: "#268bd2", magenta: "#d33682", accent: "#b58900",
});

export const SOLARIZED_LIGHT = fromPalette("solarized-light", {
	bg: "#fdf6e3", bg_dark: "#f5efdc", bg_alt: "#eee8d5", selection: "#e4ddc8",
	fg: "#586e75", muted: "#93a1a1", subtle: "#c9c3b0",
	red: "#dc322f", orange: "#cb4b16", yellow: "#b58900", green: "#859900",
	cyan: "#2aa198", blue: "#268bd2", magenta: "#d33682", accent: "#cb4b16",
});

export const GITHUB_DARK = fromPalette("github-dark", {
	bg: "#0d1117", bg_dark: "#010409", bg_alt: "#161b22", selection: "#1c3a5e",
	fg: "#e6edf3", muted: "#7d8590", subtle: "#30363d",
	red: "#ff7b72", orange: "#ffa657", yellow: "#d29922", green: "#3fb950",
	cyan: "#a5d6ff", blue: "#58a6ff", magenta: "#d2a8ff", accent: "#58a6ff",
});

export const GITHUB_LIGHT = fromPalette("github-light", {
	bg: "#ffffff", bg_dark: "#f6f8fa", bg_alt: "#eaeef2", selection: "#cce5ff",
	fg: "#1f2328", muted: "#656d76", subtle: "#d0d7de",
	red: "#cf222e", orange: "#bc4c00", yellow: "#9a6700", green: "#1a7f37",
	cyan: "#0a3069", blue: "#0969da", magenta: "#8250df", accent: "#0969da",
});

export const MONOKAI_PRO = fromPalette("monokai-pro", {
	bg: "#2d2a2e", bg_dark: "#221f22", bg_alt: "#403e41", selection: "#5b595c",
	fg: "#fcfcfa", muted: "#727072", subtle: "#5b595c",
	red: "#ff6188", orange: "#fc9867", yellow: "#ffd866", green: "#a9dc76",
	cyan: "#78dce8", blue: "#78dce8", magenta: "#ab9df2", accent: "#ffd866",
});

export const AYU_MIRAGE = fromPalette("ayu-mirage", {
	bg: "#1f2430", bg_dark: "#1a1f29", bg_alt: "#242936", selection: "#33415e",
	fg: "#cccac2", muted: "#6c7380", subtle: "#3b4252",
	red: "#f28779", orange: "#ffa659", yellow: "#ffcc66", green: "#d5ff80",
	cyan: "#95e6cb", blue: "#73d0ff", magenta: "#dfbfff", accent: "#ffcc66",
});

// Themes with a style of their own: colors, and how vigent lays things out (see style.ts).

/** neon: synthwave colors, a card per agent, your prompts in chat bubbles */
export const NEON: Theme = {
	...fromPalette("neon", {
		bg: "#140b26", fg: "#ece0ff", red: "#ff5c8a", yellow: "#ffd166", green: "#4dffb8",
		cyan: "#2de2e6", blue: "#7aa2ff", magenta: "#ff4fd8", bg_dark: "#0e0720", muted: "#8a76b3",
	}),
	style: {
		sidebar: "cards",
		messages: "bubbles",
		tool_icons: "unicode",
		icons: { prompt: "» ", open_agent: "◆", worktree: "⑂ ", bullet: "▸", unread: "✦", idle: "◇", waiting: "◈", ok: "◆", warn: "◈", off: "◇", queued: "⋯" },
	},
};

/** zen: quiet greens and greys, one row per agent, a header over each message */
export const ZEN: Theme = {
	...fromPalette("zen", {
		bg: "#1b1d1c", fg: "#c9cdc5", red: "#c4746e", yellow: "#c9b98c", green: "#8fa37e",
		cyan: "#8ea9a6", blue: "#8ba1b2", magenta: "#a593a8", muted: "#6d736e",
	}),
	style: {
		sidebar: "compact",
		messages: "labeled",
		tool_icons: "unicode",
		user_label: "you",
		icons: { prompt: "› ", bullet: "·", worktree: "↳ ", folded: "›", open: "⌄", open_agent: "›", idle: "·", waiting: "◌", ok: "•", warn: "◌", off: "·", unread: "•" },
	},
};

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
	"catppuccin-frappe": CATPPUCCIN_FRAPPE,
	"catppuccin-macchiato": CATPPUCCIN_MACCHIATO,
	"tokyonight-storm": TOKYONIGHT_STORM,
	"rose-pine-moon": ROSE_PINE_MOON,
	"rose-pine-dawn": ROSE_PINE_DAWN,
	dracula: DRACULA,
	onedark: ONEDARK,
	everforest: EVERFOREST,
	nightfox: NIGHTFOX,
	"solarized-dark": SOLARIZED_DARK,
	"solarized-light": SOLARIZED_LIGHT,
	"github-dark": GITHUB_DARK,
	"github-light": GITHUB_LIGHT,
	"monokai-pro": MONOKAI_PRO,
	"ayu-mirage": AYU_MIRAGE,
	neon: NEON,
	zen: ZEN,
};
