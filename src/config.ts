/**
 * ~/.config/vigent/config.toml
 *
 *   theme = "tokyonight"
 *
 *   [ui]
 *   sidebar = true
 *   sidebar_width = 30
 *   number = true
 *   tilde = true
 *   icons = "unicode"        # or "ascii"
 *
 *   [highlights]             # applied on top of whichever theme is active
 *   Normal = { bg = "NONE" } # transparent background
 *   CursorLine = "guibg=#2a2f3a"
 *   VigentSidebar = { link = "NormalFloat" }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { type Attr, configDir, normalizeGroups } from "./theme.js";

export interface UiOptions {
	sidebar: boolean;
	sidebar_width: number;
	number: boolean;
	tilde: boolean;
	icons: "unicode" | "ascii";
}

export interface Config {
	theme?: string;
	model?: string;
	ui: UiOptions;
	highlights: Record<string, Attr>;
}

export const DEFAULT_UI: UiOptions = {
	sidebar: true,
	sidebar_width: 30,
	number: true,
	tilde: true,
	icons: "unicode",
};

export function configPath(): string {
	return path.join(configDir(), "config.toml");
}

/** Load the config file. Problems become warnings so a typo never stops vigent from starting. */
export function loadConfig(file = configPath()): { config: Config; warnings: string[] } {
	const config: Config = { ui: { ...DEFAULT_UI }, highlights: {} };
	const warnings: string[] = [];
	if (!fs.existsSync(file)) return { config, warnings };

	let raw: Record<string, unknown>;
	try {
		raw = parseToml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (err) {
		warnings.push(`${path.basename(file)}: ${(err as Error).message.split("\n")[0]}`);
		return { config, warnings };
	}

	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "theme":
			case "colorscheme":
			case "model":
				if (typeof value === "string") config[key === "colorscheme" ? "theme" : key] = value;
				else warnings.push(`config: '${key}' should be a string`);
				break;
			case "ui":
				if (value && typeof value === "object") {
					for (const [opt, v] of Object.entries(value)) {
						const msg = setOption(config.ui, opt, v);
						if (msg) warnings.push(`config [ui]: ${msg}`);
					}
				}
				break;
			case "highlights":
				config.highlights = normalizeGroups(value as Record<string, unknown>);
				break;
			default:
				warnings.push(`config: unknown key '${key}'`);
		}
	}
	return { config, warnings };
}

const ALIASES: Record<string, keyof UiOptions> = {
	sidebar: "sidebar",
	sb: "sidebar",
	sidebar_width: "sidebar_width",
	sidebarwidth: "sidebar_width",
	sbw: "sidebar_width",
	number: "number",
	nu: "number",
	tilde: "tilde",
	icons: "icons",
};

/** Set one option from a config value. Returns an error message, or undefined on success. */
export function setOption(ui: UiOptions, name: string, value: unknown): string | undefined {
	const key = ALIASES[name];
	if (!key) return `unknown option '${name}'`;
	switch (key) {
		case "sidebar":
		case "number":
		case "tilde":
			if (typeof value !== "boolean") return `'${name}' should be true or false`;
			ui[key] = value;
			return;
		case "sidebar_width": {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 16 || n > 80) return `'${name}' should be a number from 16 to 80`;
			ui.sidebar_width = n;
			return;
		}
		case "icons":
			if (value !== "unicode" && value !== "ascii") return `'${name}' should be "unicode" or "ascii"`;
			ui.icons = value;
			return;
	}
}

/**
 * Apply a vim-style `:set` argument: `number`, `nonumber`, `number!`,
 * `invnumber`, `sidebar_width=40`, `number?`. Returns the message to show.
 */
export function applySetCommand(ui: UiOptions, arg: string): { message: string; error?: boolean } {
	const show = (k: keyof UiOptions) => {
		const v = ui[k];
		return typeof v === "boolean" ? (v ? `  ${k}` : `no${k}`) : `  ${k}=${v}`;
	};
	if (!arg.trim()) {
		return { message: (Object.keys(ui) as (keyof UiOptions)[]).map(show).join("  ") };
	}
	const parts = arg.trim().split(/\s+/);
	const shown: string[] = [];
	for (const part of parts) {
		let m: RegExpExecArray | null;
		if ((m = /^([\w]+)\?$/.exec(part))) {
			const key = ALIASES[m[1]];
			if (!key) return { message: `E518: Unknown option: ${m[1]}`, error: true };
			shown.push(show(key));
			continue;
		}
		if ((m = /^([\w]+)=(.*)$/.exec(part))) {
			const err = setOption(ui, m[1], m[2]);
			if (err) return { message: `E518: ${err}`, error: true };
			continue;
		}
		if ((m = /^([\w]+)!$/.exec(part)) || (m = /^inv([\w]+)$/.exec(part))) {
			const key = ALIASES[m[1]];
			if (!key || typeof ui[key] !== "boolean") return { message: `E518: Unknown option: ${part}`, error: true };
			(ui as unknown as Record<string, boolean>)[key] = !ui[key];
			continue;
		}
		const m2 = /^no([\w]+)$/.exec(part);
		const off = Boolean(m2 && ALIASES[m2[1]]);
		const key = ALIASES[off ? m2![1] : part];
		if (!key) return { message: `E518: Unknown option: ${part}`, error: true };
		if (typeof ui[key] !== "boolean") {
			shown.push(show(key));
			continue;
		}
		(ui as unknown as Record<string, boolean>)[key] = !off;
	}
	return { message: shown.join("  ") };
}

export const CONFIG_TEMPLATE = `# vigent config — https://github.com/farming-labs/vigent/blob/main/docs/themes.md

# Built-in: default, gruvbox, tokyonight, catppuccin, catppuccin-latte, nord, rose-pine, kanagawa.
# Or any theme in ~/.config/vigent/themes (see: vigent theme import / vigent theme new).
theme = "default"

[ui]
sidebar = true
sidebar_width = 30
number = true        # session numbers in the sidebar
tilde = true         # ~ on empty sidebar rows
icons = "unicode"    # "ascii" for terminals/fonts without box-drawing glyphs

# Override any highlight group, on top of whichever theme is active.
# Values: a table, a vim :hi string, or the name of a group to link to.
[highlights]
# Normal = { bg = "NONE" }                # use the terminal's background
# CursorLine = "guibg=#2a2f3a"
# VigentSidebar = "NormalFloat"
# VigentModeNormal = { fg = "#1a1b26", bg = "#7aa2f7", bold = true }
`;
