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
import { EFFORTS } from "./choices.js";
import { type EngineId, isEngineId } from "./engines.js";
import { WORKTREE_BACKENDS, type WorktreeBackend } from "./riftri.js";
import { KEY_MODES, type KeyMode } from "./keys.js";
import { type Attr, configDir, normalizeGroups } from "./theme.js";
import { DEFAULT_WORKTREE, type WorktreeConfig } from "./worktree.js";

export interface UiOptions {
	sidebar: boolean;
	sidebar_width: number;
	number: boolean;
	tilde: boolean;
	icons: "unicode" | "ascii";
	/** ms to wait for the rest of a multi-key mapping, like vim's 'timeoutlen' */
	timeoutlen: number;
	/** 24-bit color (vim's 'termguicolors'); off maps colors to the nearest of 256 */
	termguicolors: boolean;
	/** use the terminal's background: true, false, or "auto" (what the theme says) */
	transparent: boolean | "auto";
	/** after <leader> (or any key that starts mappings), show what can follow, like which-key.nvim */
	whichkey: boolean;
}

/** [engines.claude] / [engines.codex] / [engines.opencode] */
export interface EngineOptions {
	/** replaces vigent's default extra arguments for that CLI */
	args?: string[];
	/** model for new agents on that engine (default: the CLI's own) */
	model?: string;
	/** reasoning effort for new agents on that engine (pi: thinking level) */
	effort?: string;
}

export interface Config {
	theme?: string;
	model?: string;
	/** engine for new agents: pi, claude, codex, opencode, or auto (default) */
	engine?: EngineId | "auto";
	engines: Partial<Record<EngineId, EngineOptions>>;
	leader?: string;
	ui: UiOptions;
	highlights: Record<string, Attr>;
	/** raw mappings per mode; validated when the keymap is built */
	keys: Partial<Record<KeyMode, Record<string, unknown>>>;
	worktree: WorktreeConfig;
}

export const DEFAULT_UI: UiOptions = {
	sidebar: true,
	sidebar_width: 30,
	number: true,
	tilde: true,
	icons: "unicode",
	timeoutlen: 1000,
	// macOS Terminal.app can't show 24-bit color
	termguicolors: process.env.TERM_PROGRAM !== "Apple_Terminal",
	transparent: "auto",
	whichkey: true,
};

export function configPath(): string {
	return path.join(configDir(), "config.toml");
}

/** Load the config file. Problems become warnings so a typo never stops vigent from starting. */
export function loadConfig(file = configPath()): { config: Config; warnings: string[] } {
	const config: Config = { ui: { ...DEFAULT_UI }, highlights: {}, keys: {}, worktree: { ...DEFAULT_WORKTREE }, engines: {} };
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
			case "leader":
			case "mapleader":
				if (typeof value === "string") {
					const field = key === "colorscheme" ? "theme" : key === "mapleader" ? "leader" : key;
					config[field as "theme" | "model" | "leader"] = value;
				} else warnings.push(`config: '${key}' should be a string`);
				break;
			case "engine":
				if (typeof value === "string" && (value === "auto" || isEngineId(value))) config.engine = value;
				else warnings.push("config: 'engine' should be \"auto\", \"pi\", \"claude\", \"codex\" or \"opencode\"");
				break;
			case "engines":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push("config: [engines] should be a table");
					break;
				}
				for (const [id, opts] of Object.entries(value)) {
					if (!isEngineId(id)) {
						warnings.push(`config: unknown engine [engines.${id}] (pi, claude, codex or opencode)`);
						continue;
					}
					if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
						warnings.push(`config: [engines.${id}] should be a table`);
						continue;
					}
					const e: EngineOptions = {};
					for (const [k, v] of Object.entries(opts)) {
						if (k === "args" && Array.isArray(v) && v.every((a) => typeof a === "string")) e.args = v;
						else if (k === "model" && typeof v === "string") e.model = v;
						else if (k === "effort" && typeof v === "string" && (EFFORTS[id as EngineId] as string[]).includes(v)) e.effort = v;
						else if (k === "effort") warnings.push(`config [engines.${id}]: 'effort' should be one of ${EFFORTS[id as EngineId].join(", ")}`);
						else warnings.push(`config [engines.${id}]: ${k === "args" ? "'args' should be a list of strings" : k === "model" ? "'model' should be a string" : `unknown option '${k}'`}`);
					}
					config.engines[id as EngineId] = e;
				}
				break;
			case "keys":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push("config: [keys] should be a table");
					break;
				}
				for (const [k, v] of Object.entries(value)) {
					if ((KEY_MODES as string[]).includes(k) && v && typeof v === "object" && !Array.isArray(v)) {
						config.keys[k as KeyMode] = { ...config.keys[k as KeyMode], ...(v as Record<string, unknown>) };
					} else if ((KEY_MODES as string[]).includes(k)) {
						warnings.push(`config: [keys.${k}] should be a table`);
					} else {
						// keys directly under [keys] are normal-mode mappings
						config.keys.normal = { ...config.keys.normal, [k]: v };
					}
				}
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
			case "worktree":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push("config: [worktree] should be a table");
					break;
				}
				for (const [opt, v] of Object.entries(value)) {
					const msg = setWorktreeOption(config.worktree, opt, v);
					if (msg) warnings.push(`config [worktree]: ${msg}`);
				}
				break;
			default:
				warnings.push(`config: unknown key '${key}'`);
		}
	}
	return { config, warnings };
}

function setWorktreeOption(wt: WorktreeConfig, name: string, value: unknown): string | undefined {
	switch (name) {
		case "enabled":
			if (typeof value !== "boolean") return "'enabled' should be true or false";
			wt.enabled = value;
			return;
		case "dir":
		case "base":
			if (typeof value !== "string") return `'${name}' should be a string`;
			if (name === "dir" && !value.trim()) return "'dir' can't be empty";
			wt[name] = value;
			return;
		case "backend":
			if (typeof value !== "string" || !(WORKTREE_BACKENDS as string[]).includes(value)) return "'backend' should be \"auto\", \"riftri\" or \"git\"";
			wt.backend = value as WorktreeBackend;
			return;
		case "branch":
			if (typeof value !== "string") return "'branch' should be a string";
			if (!value.includes("{name}")) return "'branch' should contain {name}, e.g. \"{type}/{name}\" or \"agent/{name}\"";
			wt.branch = value;
			return;
		default:
			return `unknown option '${name}'`;
	}
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
	timeoutlen: "timeoutlen",
	tm: "timeoutlen",
	termguicolors: "termguicolors",
	tgc: "termguicolors",
	transparent: "transparent",
	transp: "transparent",
	whichkey: "whichkey",
	wk: "whichkey",
};

/** Set one option from a config value. Returns an error message, or undefined on success. */
export function setOption(ui: UiOptions, name: string, value: unknown): string | undefined {
	const key = ALIASES[name];
	if (!key) return `unknown option '${name}'`;
	switch (key) {
		case "sidebar":
		case "number":
		case "tilde":
		case "termguicolors":
		case "whichkey":
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
		case "transparent":
			if (value === true || value === false || value === "auto") ui.transparent = value;
			else if (value === "true" || value === "false") ui.transparent = value === "true";
			else return `'${name}' should be true, false or "auto" (follow the theme)`;
			return;
		case "timeoutlen": {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 0 || n > 10000) return `'${name}' should be milliseconds from 0 to 10000`;
			ui.timeoutlen = n;
			return;
		}
	}
}

/**
 * Apply a vim-style `:set` argument: `number`, `nonumber`, `number!`,
 * `invnumber`, `sidebar_width=40`, `number?`. Returns the message to show.
 */
export function applySetCommand(
	ui: UiOptions,
	arg: string,
	/** what's on screen now, for toggling an option that follows the theme */
	now: { transparent?: boolean } = {},
): { message: string; error?: boolean } {
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
			if (key === "transparent") {
				// following the theme: flip what's on screen
				ui.transparent = !(ui.transparent === "auto" ? Boolean(now.transparent) : ui.transparent);
				continue;
			}
			if (!key || typeof ui[key] !== "boolean") return { message: `E518: Unknown option: ${part}`, error: true };
			(ui as unknown as Record<string, boolean>)[key] = !ui[key];
			continue;
		}
		if ((m = /^([\w]+)&$/.exec(part))) {
			// vim's :set option& : back to the default
			const key = ALIASES[m[1]];
			if (!key) return { message: `E518: Unknown option: ${m[1]}`, error: true };
			(ui as unknown as Record<string, unknown>)[key] = DEFAULT_UI[key];
			continue;
		}
		const m2 = /^no([\w]+)$/.exec(part);
		const off = Boolean(m2 && ALIASES[m2[1]]);
		const key = ALIASES[off ? m2![1] : part];
		if (!key) return { message: `E518: Unknown option: ${part}`, error: true };
		if (typeof ui[key] !== "boolean" && key !== "transparent") {
			shown.push(show(key));
			continue;
		}
		(ui as unknown as Record<string, boolean>)[key] = !off;
	}
	return { message: shown.join("  ") };
}

export const CONFIG_TEMPLATE = `# vigent config: ~/.config/vigent/config.toml
# Reference: https://github.com/farming-labs/vigent/blob/main/docs/config.md
# Check it any time with:  vigent config check

# --- Theme -----------------------------------------------------------------
# Built-in: default, lazyvim (transparent), tokyonight, tokyonight-moon, gruvbox,
# catppuccin, catppuccin-latte, nord, rose-pine, kanagawa. Or any theme in ~/.config/vigent/themes, e.g. one made
# with  vigent theme import  (your nvim/vim colorscheme) or  vigent theme new.
# "nvim" (or "vim") follows your editor: the colorscheme your config and plugins
# set (AstroNvim, LazyVim, NvChad...), updated each time vigent starts.
theme = "default"

# Model used for new pi agents.
# model = "claude-sonnet-4-5"

# --- Engines ---------------------------------------------------------------
# What runs new agents: "pi" (built in), or a coding-agent CLI you already
# have installed and signed in: "claude" (Claude Code), "codex", "opencode".
# "auto" picks pi if it has an API key, else the first signed-in CLI.
# Per agent: :new fix the race --engine codex.   Status: :checkhealth
engine = "auto"

# Each CLI runs as it is, with its own login. Extra arguments and a model:
# [engines.claude]
# args = ["--permission-mode", "acceptEdits"]   # the default
# model = "sonnet"
# [engines.codex]
# args = ["-c", 'sandbox_mode="workspace-write"']  # the default
# [engines.opencode]
# model = "anthropic/claude-sonnet-4-5"

# --- Leader ----------------------------------------------------------------
# What <leader> means in [keys]. Vim's default is "\\".
leader = "<Space>"

# --- Options (also live: :set nonumber, :set sidebar_width=40, ...) --------
[ui]
sidebar = true
sidebar_width = 30
number = true          # session numbers in the sidebar
tilde = true           # ~ on empty sidebar rows
icons = "unicode"      # "ascii" for fonts without box-drawing characters
timeoutlen = 1000      # ms to wait for the rest of a multi-key mapping
# termguicolors = false  # for terminals without 24-bit color: use the nearest of 256
# transparent = true    # use the terminal's background with any theme ("auto": the theme decides)
whichkey = true          # after <leader>, show what each next key does (like which-key.nvim)

# --- Colors (also live: :hi Group guifg=#... guibg=#...) -------------------
# Applied on top of whichever theme is active. A value is a table, a vim
# :hi string, or the name of a group to link to.
[highlights]
# Normal = { bg = "NONE" }                 # use the terminal's background
# CursorLine = "guibg=#2a2f3a"
# Comment = "gui=NONE"                      # no italic comments
# VigentModeNormal = { fg = "#1a1b26", bg = "#7aa2f7", bold = true }

# --- Worktrees --------------------------------------------------------------
# Each agent gets its own git worktree and branch, so agents never touch your
# checkout or each other. ":new fix flaky checkout test" creates the branch
# fix/flaky-checkout-test in ../<repo>-worktrees/fix-flaky-checkout-test.
[worktree]
enabled = true
dir = "../{repo}-worktrees"     # relative to the repo root
branch = "{type}/{name}"        # {type} = feat, fix, docs, refactor, ... from the agent's name
# base = "main"                 # default: the branch you have checked out
# With riftri installed (https://riftri.dev), unchanged files in agent
# worktrees share copy-on-write storage, so each new agent costs almost no
# disk. "auto" uses riftri when it can and git otherwise; "git" turns it off.
backend = "auto"

# --- Keys (also live: :nmap, :imap, :cmap, :unmap; list them with :help) ---
# Left side: vim notation, e.g. j  gg  <C-d>  <S-Tab>  <M-x>  <CR>  <leader>t
# Right side:
#   "session.next"                       an action (all of them: :help)
#   ":colorscheme nord<CR>"              run an ex command
#   ":new "                              open the command line with that text
#   "gg"                                 other keys, with their built-in meaning
#   ["fold.open_all", "scroll.bottom"]   several, in order
#   false                                unbind a built-in key

[keys.normal]
"<leader>n" = ":new "              # type a name, then Enter
"<leader>x" = ":kill<CR>"
"<leader>t" = "theme.picker"
"<leader>h" = "app.help"
"<Tab>" = "session.next"
"<S-Tab>" = "session.prev"
# "J" = "scroll.half_down"
# "K" = "scroll.half_up"
# "q" = false                       # stop q from showing the quit hint

[keys.insert]
# "jk" = "<Esc>"                    # leave INSERT by typing jk quickly
# "<C-s>" = "edit.submit"

[keys.command]
# "<C-p>" = "edit.clear"
`;
