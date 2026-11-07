/**
 * Build a full theme from a small color palette.
 *
 * Only bg, fg and the six accent colors are required; everything else is
 * derived. This is the easiest way to write a custom theme:
 *
 *   [palette]
 *   bg = "#0b0e14"
 *   fg = "#bfbdb6"
 *   red = "#f07178"  ...
 */
import { isLight, mix } from "./color.js";
import type { Attr, Theme } from "./theme.js";

export interface Palette {
	bg: string;
	fg: string;
	red: string;
	yellow: string;
	green: string;
	cyan: string;
	blue: string;
	magenta: string;
	/** sidebar / float background (default: bg shaded) */
	bg_dark?: string;
	/** cursorline, statusline, popup background (default: bg nudged toward fg) */
	bg_alt?: string;
	/** visual selection (default: bg mixed with blue) */
	selection?: string;
	/** comments, secondary text (default: halfway between bg and fg) */
	muted?: string;
	/** line numbers, separators, ~ rows (default: a quarter of the way to fg) */
	subtle?: string;
	orange?: string;
	/** current line number, highlights (default: yellow) */
	accent?: string;
}

export const PALETTE_KEYS: (keyof Palette)[] = [
	"bg", "fg", "red", "yellow", "green", "cyan", "blue", "magenta",
	"bg_dark", "bg_alt", "selection", "muted", "subtle", "orange", "accent",
];

export function fromPalette(name: string, p: Palette): Theme {
	const light = isLight(p.bg);
	const bgDark = p.bg_dark ?? mix(p.bg, "#000000", light ? 0.05 : 0.22);
	const bgAlt = p.bg_alt ?? mix(p.bg, p.fg, 0.08);
	const selection = p.selection ?? mix(p.bg, p.blue, 0.28);
	const muted = p.muted ?? mix(p.bg, p.fg, 0.45);
	const subtle = p.subtle ?? mix(p.bg, p.fg, 0.25);
	const orange = p.orange ?? p.yellow;
	const accent = p.accent ?? p.yellow;
	const badge = (bg: string): Attr => ({ fg: p.bg, bg, bold: true });

	return {
		name,
		background: light ? "light" : "dark",
		groups: {
			Normal: { fg: p.fg, bg: p.bg },
			NormalFloat: { fg: p.fg, bg: bgDark },
			FloatBorder: { fg: subtle, bg: bgDark },
			FloatTitle: { fg: p.blue, bg: bgDark, bold: true },
			WinSeparator: { fg: subtle },
			StatusLine: { fg: p.fg, bg: bgAlt },
			StatusLineNC: { fg: muted, bg: bgDark },
			WinBar: { fg: p.fg, bold: true },
			CursorLine: { bg: bgAlt },
			CursorLineNr: { fg: accent, bold: true },
			LineNr: { fg: subtle },
			Visual: { bg: selection },
			Comment: { fg: muted, italic: true },
			NonText: { fg: subtle },
			Title: { fg: p.blue, bold: true },
			Directory: { fg: p.blue },
			Identifier: { fg: p.magenta },
			Function: { fg: p.blue },
			String: { fg: p.green },
			Constant: { fg: orange },
			Keyword: { fg: p.magenta },
			Statement: { fg: p.magenta },
			Type: { fg: p.yellow },
			Special: { fg: p.cyan },
			Search: { fg: p.bg, bg: p.yellow },
			CurSearch: { fg: p.bg, bg: orange },
			DiffAdd: { bg: mix(p.bg, p.green, 0.2) },
			DiffDelete: { bg: mix(p.bg, p.red, 0.2) },
			DiffChange: { bg: mix(p.bg, p.blue, 0.15) },
			Added: { fg: p.green },
			Removed: { fg: p.red },
			Changed: { fg: p.blue },
			ErrorMsg: { fg: p.red },
			WarningMsg: { fg: p.yellow },
			ModeMsg: { fg: p.fg, bold: true },
			MoreMsg: { fg: p.green },
			Pmenu: { fg: p.fg, bg: bgAlt },
			PmenuSel: { bg: selection, bold: true },
			VigentSidebar: { fg: p.fg, bg: bgDark },
			VigentIndent: { fg: subtle },
			VigentModeNormal: badge(p.blue),
			VigentModeInsert: badge(p.green),
			VigentModeVisual: badge(p.magenta),
			VigentModeCommand: badge(p.yellow),
			VigentUser: { fg: p.blue, bold: true },
			VigentTool: { fg: p.cyan },
			VigentToolOutput: { fg: muted },
			VigentSpinner: { fg: orange },
		},
	};
}
