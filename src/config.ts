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
 *   icons = "unicode"        # or "nerd" (a Nerd Font), "ascii"
 *
 *   [highlights]             # applied on top of whichever theme is active
 *   Normal = { bg = "NONE" } # transparent background
 *   CursorLine = "guibg=#2a2f3a"
 *   VigentSidebar = { link = "NormalFloat" }
 */
import { NOTIFY_MODES, type NotifyMode } from "./notify.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { EFFORTS } from "./choices.js";
import { parseTemplates, type Template } from "./templates.js";
import { parseCommands, type UserCommands } from "./commands.js";
import { HOOK_NAMES, type HookName, type Hooks } from "./hooks.js";
import { defaultLayout, type Layout, parseSections, STATUSLINE_PARTS, WINBAR_PARTS } from "./layout.js";
import { ICON_SETS, type IconSet } from "./icons.js";
import { CUSTOM_ENGINES, type CustomEngine, ENGINE_IDS, type EngineId, isEngineId, registerCustomEngine } from "./engines.js";
import { WORKTREE_BACKENDS, type WorktreeBackend } from "./riftri.js";
import { KEY_MODES, type KeyMode } from "./keys.js";
import { type Attr, configDir, normalizeGroups } from "./theme.js";
import { DEFAULT_WORKTREE, type WorktreeConfig } from "./worktree.js";

export interface UiOptions {
	sidebar: boolean;
	sidebar_width: number;
	/** which side the sidebar is on */
	sidebar_position: "left" | "right";
	number: boolean;
	tilde: boolean;
	icons: IconSet;
	/** ms to wait for the rest of a multi-key mapping, like vim's 'timeoutlen' */
	timeoutlen: number;
	/** 24-bit color (vim's 'termguicolors'); off maps colors to the nearest of 256 */
	termguicolors: boolean;
	/** use the terminal's background: true, false, or "auto" (what the theme says) */
	transparent: boolean | "auto";
	/** after <leader> (or any key that starts mappings), show what can follow, like which-key.nvim */
	whichkey: boolean;
	/** when an agent finishes while you look elsewhere: "auto" (bell, plus a desktop notification where the terminal shows one), "bell", "desktop", "off" */
	notify: NotifyMode;
}

/** [engines.claude] / [engines.codex] / [engines.opencode] */
export interface EngineOptions {
	/** replaces vigent's default extra arguments for that CLI */
	args?: string[];
	/** model for new agents on that engine (default: the CLI's own) */
	model?: string;
	/** reasoning effort for new agents on that engine (pi: thinking level) */
	effort?: string;
	/** Claude Code permission rules every run may use, e.g. "Bash(gh:*)" (--allowedTools) */
	allow?: string[];
	/** Claude Code: when a tool is refused, ask to allow it and retry (off unless set) */
	ask?: boolean;
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
	/** [templates.<name>]: prompts to start agents with (:new -t <name>) */
	templates: Record<string, Template>;
	/** [hooks]: commands at points in an agent's life */
	hooks: Hooks;
	/** [statusline] and [winbar]: what they show, left and right */
	layout: Layout;
	/** [commands]: your own ex commands */
	commands: UserCommands;
}

export interface LoadOptions {
	/** layer this file over an existing config (a project's .vigent.toml over yours) */
	base?: Config;
	/**
	 * false: leave out what runs programs (hooks, engine args, Claude Code
	 * permission rules) and name it in `gated`. A project file counts only once trusted.
	 */
	trusted?: boolean;
	/** how warnings name the file ("config" or ".vigent.toml") */
	label?: string;
}

/** The project's own config, at the repository root. */
export const PROJECT_CONFIG = ".vigent.toml";


export const DEFAULT_UI: UiOptions = {
	sidebar: true,
	sidebar_width: 30,
	sidebar_position: "left",
	number: true,
	tilde: true,
	icons: "unicode",
	timeoutlen: 1000,
	// macOS Terminal.app can't show 24-bit color
	termguicolors: process.env.TERM_PROGRAM !== "Apple_Terminal",
	transparent: "auto",
	whichkey: true,
	notify: "auto",
};

export function configPath(): string {
	return path.join(configDir(), "config.toml");
}

/** Load the config file. Problems become warnings so a typo never stops vigent from starting. */
export function loadConfig(file = configPath(), opts: LoadOptions = {}): { config: Config; warnings: string[]; gated: string[] } {
	const config: Config = opts.base ?? { ui: { ...DEFAULT_UI }, highlights: {}, keys: {}, worktree: { ...DEFAULT_WORKTREE }, engines: {}, templates: {}, hooks: {}, layout: defaultLayout(), commands: {} };
	const warnings: string[] = [];
	const gated: string[] = [];
	const where = opts.label ?? "config";
	const mayRun = opts.trusted !== false;
	if (!fs.existsSync(file)) return { config, warnings, gated };

	let raw: Record<string, unknown>;
	try {
		raw = parseToml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (err) {
		warnings.push(`${path.basename(file)}: ${(err as Error).message.split("\n")[0]}`);
		return { config, warnings, gated };
	}

	// [engines] first: engine = "gemini" and templates may name an engine it defines
	const entries = Object.entries(raw).sort(([a], [b]) => Number(b === "engines") - Number(a === "engines"));
	for (const [key, value] of entries) {
		switch (key) {
			case "theme":
			case "colorscheme":
			case "model":
			case "leader":
			case "mapleader":
				if (typeof value === "string") {
					const field = key === "colorscheme" ? "theme" : key === "mapleader" ? "leader" : key;
					config[field as "theme" | "model" | "leader"] = value;
				} else warnings.push(`${where}: '${key}' should be a string`);
				break;
			case "engine":
				if (typeof value === "string" && (value === "auto" || isEngineId(value))) config.engine = value;
				else warnings.push(`${where}: 'engine' should be "auto", "pi", "claude", "codex", "opencode" or an engine from [engines]`);
				break;
			case "engines":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push(`${where}: [engines] should be a table`);
					break;
				}
				for (const [id, opts] of Object.entries(value)) {
					// a table with a command defines an engine of your own
					if (opts && typeof opts === "object" && !Array.isArray(opts) && "command" in opts && !(ENGINE_IDS as string[]).includes(id)) {
						if (!mayRun) {
							gated.push(`engines.${id}.command`);
							continue;
						}
						const custom = parseCustomEngine(id, opts as Record<string, unknown>, `${where} [engines.${id}]`, warnings);
						if (custom) registerCustomEngine(custom);
						continue;
					}
					if (!isEngineId(id)) {
						warnings.push(`${where}: unknown engine [engines.${id}] (pi, claude, codex, opencode, or give it a command = [...] to add your own)`);
						continue;
					}
					if (CUSTOM_ENGINES.has(id)) continue; // defined above (a later file may set its model)
					if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
						warnings.push(`${where}: [engines.${id}] should be a table`);
						continue;
					}
					const e: EngineOptions = {};
					for (const [k, v] of Object.entries(opts)) {
						if ((k === "args" || k === "allow") && !mayRun) {
							gated.push(`engines.${id}.${k}`);
							continue;
						}
						if (k === "args" && Array.isArray(v) && v.every((a) => typeof a === "string")) e.args = v;
						else if (k === "model" && typeof v === "string") e.model = v;
						else if (k === "effort" && typeof v === "string" && ((EFFORTS[id as EngineId] ?? []) as string[]).includes(v)) e.effort = v;
						else if ((k === "allow" || k === "ask") && id !== "claude") warnings.push(`${where} [engines.${id}]: '${k}' is for [engines.claude] (Claude Code's permission rules)`);
						else if (k === "allow" && Array.isArray(v) && v.every((a) => typeof a === "string")) e.allow = v;
						else if (k === "ask" && typeof v === "boolean") e.ask = v;
						else if (k === "allow") warnings.push(`${where} [engines.${id}]: 'allow' should be a list of permission rules, e.g. ["Bash(gh:*)"]`);
						else if (k === "ask") warnings.push(`${where} [engines.${id}]: 'ask' should be true or false`);
						else if (k === "effort") warnings.push(`${where} [engines.${id}]: 'effort' should be one of ${(EFFORTS[id as EngineId] ?? []).join(", ")}`);
						else warnings.push(`${where} [engines.${id}]: ${k === "args" ? "'args' should be a list of strings" : k === "model" ? "'model' should be a string" : `unknown option '${k}'`}`);
					}
					config.engines[id as EngineId] = { ...config.engines[id as EngineId], ...e };
				}
				break;
			case "templates":
				config.templates = { ...config.templates, ...parseTemplates(value, warnings) };
				break;
			case "commands":
				config.commands = { ...config.commands, ...parseCommands(value, where, warnings, gated, mayRun) };
				break;
			case "statusline":
				parseSections("statusline", value, STATUSLINE_PARTS, config.layout.statusline, where, warnings);
				break;
			case "winbar":
				parseSections("winbar", value, WINBAR_PARTS, config.layout.winbar, where, warnings);
				break;
			case "hooks":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push(`${where}: [hooks] should be a table`);
					break;
				}
				for (const [name, cmd] of Object.entries(value)) {
					if (!(HOOK_NAMES as readonly string[]).includes(name)) {
						warnings.push(`${where} [hooks]: unknown hook '${name}' (${HOOK_NAMES.join(", ")})`);
					} else if (typeof cmd !== "string" || !cmd.trim()) {
						warnings.push(`${where} [hooks]: '${name}' should be a command, e.g. "npm ci"`);
					} else if (!mayRun) {
						gated.push(`hooks.${name}`);
					} else {
						config.hooks[name as HookName] = cmd.trim();
					}
				}
				break;
			case "keys":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push(`${where}: [keys] should be a table`);
					break;
				}
				for (const [k, v] of Object.entries(value)) {
					if ((KEY_MODES as string[]).includes(k) && v && typeof v === "object" && !Array.isArray(v)) {
						config.keys[k as KeyMode] = { ...config.keys[k as KeyMode], ...(v as Record<string, unknown>) };
					} else if ((KEY_MODES as string[]).includes(k)) {
						warnings.push(`${where}: [keys.${k}] should be a table`);
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
						if (msg) warnings.push(`${where} [ui]: ${msg}`);
					}
				}
				break;
			case "highlights":
				config.highlights = { ...config.highlights, ...normalizeGroups(value as Record<string, unknown>) };
				break;
			case "worktree":
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnings.push(`${where}: [worktree] should be a table`);
					break;
				}
				for (const [opt, v] of Object.entries(value)) {
					const msg = setWorktreeOption(config.worktree, opt, v);
					if (msg) warnings.push(`${where} [worktree]: ${msg}`);
				}
				break;
			default:
				warnings.push(`${where}: unknown key '${key}'`);
		}
	}
	return { config, warnings, gated };
}

const OUTPUTS = ["text", "claude", "codex", "opencode"] as const;

/** [engines.<id>] with a command: an agent CLI of your own. */
function parseCustomEngine(id: string, raw: Record<string, unknown>, where: string, warnings: string[]): CustomEngine | undefined {
	const strings = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string");
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
		warnings.push(`${where}: an engine name is letters, digits, - and _`);
		return undefined;
	}
	if (!strings(raw.command)) {
		warnings.push(`${where}: 'command' should be the program and its arguments, e.g. ["gemini", "-p", "{prompt}"]`);
		return undefined;
	}
	const e: CustomEngine = { id, name: id, command: raw.command as string[], output: "text" };
	for (const [k, v] of Object.entries(raw)) {
		if (k === "command") continue;
		if (k === "name" && typeof v === "string" && v.trim()) e.name = v.trim();
		else if (k === "output" && typeof v === "string" && (OUTPUTS as readonly string[]).includes(v)) e.output = v as CustomEngine["output"];
		else if (k === "model_args" && strings(v)) e.modelArgs = v as string[];
		else if (k === "models" && strings(v)) e.models = v as string[];
		else if (k === "resume_args" && strings(v)) e.resumeArgs = v as string[];
		else if (k === "output") warnings.push(`${where}: 'output' should be "text", "claude", "codex" or "opencode"`);
		else warnings.push(`${where}: ${k === "name" ? "'name' should be a string" : k === "model_args" || k === "models" || k === "resume_args" ? `'${k}' should be a list of strings` : `unknown option '${k}' (name, command, output, model_args, models, resume_args)`}`);
	}
	return e;
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
	sidebar_position: "sidebar_position",
	sbp: "sidebar_position",
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
	notify: "notify",
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
		case "sidebar_position":
			if (value !== "left" && value !== "right") return `'${name}' should be "left" or "right"`;
			ui.sidebar_position = value;
			return;
		case "notify":
			if (!NOTIFY_MODES.includes(value as NotifyMode)) return `'${name}' should be "auto", "bell", "desktop" or "off"`;
			ui.notify = value as NotifyMode;
			return;
		case "icons":
			if (!ICON_SETS.includes(value as IconSet)) return `'${name}' should be "unicode", "nerd" or "ascii"`;
			ui.icons = value as IconSet;
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
# "auto" picks the first signed-in CLI (your own login), else pi if it has an API key.
# Per agent: :new fix the race --engine codex.   Status: :checkhealth
engine = "auto"

# Each CLI runs as it is, with its own login. Extra arguments and a model:
# [engines.claude]
# args = ["--permission-mode", "acceptEdits"]   # the default
# model = "sonnet"
# allow = ["Bash(gh:*)", "Bash(cargo:*)"]   # commands Claude Code may run without asking
# ask = true   # when it's refused a command: allow once / always / no, then retry
# [engines.codex]
# args = ["-c", 'sandbox_mode="workspace-write"']  # the default
# [engines.opencode]
# model = "anthropic/claude-sonnet-4-5"
# Any other agent CLI, with a command; {prompt} is the prompt:
# [engines.gemini]
# name = "Gemini CLI"
# command = ["gemini", "--yolo", "-p", "{prompt}"]
# model_args = ["-m", "{model}"]
# models = ["gemini-2.5-pro", "gemini-2.5-flash"]

# --- Hooks -----------------------------------------------------------------
# Commands at points in an agent's life, run in its worktree. They see
# VIGENT_AGENT, VIGENT_BRANCH, VIGENT_WORKTREE, VIGENT_REPO, VIGENT_ENGINE
# (and VIGENT_STATE for agent_finished). A project can set them in its own
# .vigent.toml too, once you :trust it.
# [hooks]
# worktree_created = "npm ci"     # before the agent's first prompt goes out
# before_merge = "npm test"       # :merge and :pr only if it passes
# agent_finished = "say done"     # whenever an agent stops

# --- Commands --------------------------------------------------------------
# Your own ex commands, like vim's :command. Names start with a capital letter;
# {args} is what you type after the name. "!" runs a shell command in the
# agent's worktree (from a project's .vigent.toml, once you :trust it).
# [commands]
# Review = "new -t review {args}"
# Test = "!npm test"
# Land = ["!npm test", "pr"]      # one after another; a failing shell step stops the rest

# --- Templates -------------------------------------------------------------
# Prompts you start agents with often. :new -t fix <task> starts an agent and
# sends the prompt, {task} replaced by what you typed; :templates picks one.
# Built in: fix, test, review, explain (one of yours with the same name
# replaces it). engine, model, effort and worktree are optional.
# [templates.migrate]
# description = "a database migration, with a rollback"
# prompt = "Write a migration that {task}. Include the rollback, and test both."
# engine = "claude"
# effort = "high"

# --- Leader ----------------------------------------------------------------
# What <leader> means in [keys]. Vim's default is "\\".
leader = "<Space>"

# --- Options (also live: :set nonumber, :set sidebar_width=40, ...) --------
[ui]
sidebar = true
sidebar_width = 30
sidebar_position = "left"   # or "right"
number = true          # session numbers in the sidebar
tilde = true           # ~ on empty sidebar rows
icons = "unicode"      # "nerd" for Nerd Font icons (like AstroNvim/LazyVim), "ascii" for fonts without box-drawing characters
timeoutlen = 1000      # ms to wait for the rest of a multi-key mapping
# termguicolors = false  # for terminals without 24-bit color: use the nearest of 256
# transparent = true    # use the terminal's background with any theme ("auto": the theme decides)
whichkey = true          # after <leader>, show what each next key does (like which-key.nvim)
notify = "auto"          # an agent finished while you looked elsewhere: "auto", "bell", "desktop", "off"

# --- Statusline and winbar -------------------------------------------------
# What each shows, in order. Statusline parts: mode, agent, branch, engine,
# model, effort, usage, agents, path, clock. Winbar parts: agent, model,
# engine, effort, status, path, branch, usage.
# [statusline]
# left = ["mode", "agent", "branch"]
# right = ["model", "usage", "agents"]
# [winbar]
# left = ["agent", "model", "status"]
# right = ["path"]

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
