#!/usr/bin/env node
/** vigent — vim-native agent orchestrator on the pi engine. */
import * as fs from "node:fs";
import * as path from "node:path";
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { App } from "./app.js";
import { CONFIG_TEMPLATE, configPath, loadConfig } from "./config.js";
import { createDemoSessions } from "./demo.js";
import { DemoSession, PiSession, type Session } from "./session.js";
import { BUILTIN_THEMES, listThemes, loadTheme, Painter, themesDir } from "./theme.js";

const HELP = `vigent — vim-native agent orchestrator (pi engine)

usage:
  vigent [--demo] [--theme <name>] [--model <id>]

themes:
  vigent theme list                          built-in and installed themes
  vigent theme import                        import the colorscheme your nvim/vim uses now
  vigent theme import <name> [--as <name>]   import any colorscheme nvim/vim can load
  vigent theme import ./theme.vim            import a colorscheme file (no editor needed)
      --vim | --nvim      use this editor     --light | --dark   set 'background' first
      --clean             skip your editor config
  vigent theme new <name> [--from <theme>]   create a theme file to customize
  vigent theme path                          show where themes and config live
  vigent config init                         write a commented config.toml

keys (NORMAL mode):
  i            prompt the focused agent        :new <name>     spawn an agent
  j/k gg G     scroll transcript               :kill           kill focused agent
  ctrl+d/u     half-page scroll                :colorscheme    pick a theme (live preview)
  ]s [s 1-9    switch sessions                 :hi Group ...   change a highlight group
  za zM zR     fold/unfold tool output         :set nonumber   toggle ui options
  /pattern n N search transcript               :q              quit

Runs in demo mode (scripted sessions, no network) when --demo is passed
or no provider API key is found (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
Config: ~/.config/vigent/config.toml   Themes: ~/.config/vigent/themes/
`;

function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function themeNewTemplate(name: string, from: string): string {
	return `# ${name} — a vigent theme. Edit and reload with :colorscheme ${name}
# Docs: https://github.com/farming-labs/vigent/blob/main/docs/themes.md
name = "${name}"

# Start from any built-in or installed theme, then change what you like.
extends = "${from}"

# Or describe the theme with a palette instead (remove 'extends' above).
# Only bg, fg and the six accents are required; the rest is derived.
# [palette]
# bg = "#1a1b26"
# fg = "#c0caf5"
# red = "#f7768e"
# yellow = "#e0af68"
# green = "#9ece6a"
# cyan = "#7dcfff"
# blue = "#7aa2f7"
# magenta = "#bb9af7"
# bg_dark = "#16161e"     # sidebar / floats
# bg_alt = "#292e42"      # cursorline, statusline
# selection = "#283457"
# muted = "#565f89"       # comments
# subtle = "#3b4261"      # line numbers, separators
# orange = "#ff9e64"
# accent = "#ff9e64"      # current line number

# Any highlight group, by its nvim name. A table, a :hi string, or a group to link to.
[groups]
# Normal = { fg = "#c0caf5", bg = "#1a1b26" }
# Comment = "guifg=#565f89 gui=italic"
# VigentSidebar = { bg = "#16161e" }
# VigentModeNormal = { fg = "#1a1b26", bg = "#7aa2f7", bold = true }
# VigentModeInsert = { fg = "#1a1b26", bg = "#9ece6a", bold = true }
# CursorLineNr = "Title"
`;
}

async function themeCommand(argv: string[]): Promise<number> {
	const sub = argv[0];
	if (sub === "list") {
		const builtins = new Set(Object.keys(BUILTIN_THEMES));
		for (const t of listThemes()) console.log(builtins.has(t) ? `${t}  (built-in)` : t);
		return 0;
	}
	if (sub === "path") {
		console.log(`themes: ${themesDir()}`);
		console.log(`config: ${configPath()}`);
		return 0;
	}
	if (sub === "new") {
		const name = argv[1];
		if (!name || name.startsWith("-")) {
			console.error("usage: vigent theme new <name> [--from <theme>]");
			return 1;
		}
		const from = flag(argv, "--from") ?? "default";
		loadTheme(from); // fail early on a typo
		const file = path.join(themesDir(), `${name}.toml`);
		if (fs.existsSync(file)) {
			console.error(`${file} already exists`);
			return 1;
		}
		fs.mkdirSync(themesDir(), { recursive: true });
		fs.writeFileSync(file, themeNewTemplate(name, from));
		console.log(`created ${file}`);
		console.log(`use it with: vigent --theme ${name}  (or :colorscheme ${name})`);
		return 0;
	}
	if (sub === "import") {
		const { importTheme } = await import("./import.js");
		const rest = argv.slice(1);
		const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--as" && a !== "as");
		const legacyAs = rest.indexOf("as");
		const result = importTheme({
			source: positional[0],
			as: flag(rest, "--as") ?? (legacyAs >= 0 ? rest[legacyAs + 1] : undefined),
			editor: rest.includes("--vim") ? "vim" : rest.includes("--nvim") ? "nvim" : undefined,
			background: rest.includes("--light") ? "light" : rest.includes("--dark") ? "dark" : undefined,
			clean: rest.includes("--clean"),
		});
		console.log(`imported '${result.name}' (${result.groups} highlight groups, via ${result.via})`);
		console.log(`  -> ${result.file}`);
		console.log(`use it with: vigent --theme ${result.name}  (or :colorscheme ${result.name})`);
		return 0;
	}
	console.error("usage: vigent theme list | import [name|file] | new <name> | path");
	return 1;
}

async function main(): Promise<number | undefined> {
	const argv = process.argv.slice(2);

	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	if (argv[0] === "theme" || argv[0] === "themes") return themeCommand(argv.slice(1));
	if (argv[0] === "config" && argv[1] === "init") {
		const file = configPath();
		if (fs.existsSync(file)) {
			console.error(`${file} already exists`);
			return 1;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, CONFIG_TEMPLATE);
		console.log(`created ${file}`);
		return 0;
	}

	const { config, warnings } = loadConfig();

	const hasKey = Boolean(
		process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
	);
	const demo = argv.includes("--demo") || !hasKey;
	const model = flag(argv, "--model") ?? config.model ?? "claude-sonnet-4-5";

	const themeName = flag(argv, "--theme") ?? config.theme ?? "default";
	let theme = BUILTIN_THEMES.default;
	try {
		theme = loadTheme(themeName);
	} catch (err) {
		if (flag(argv, "--theme")) {
			console.error(`vigent: ${(err as Error).message}`);
			return 1;
		}
		warnings.push(`${(err as Error).message} (from config); using default`);
	}

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, false);
	const app = new App(tui, terminal, new Painter(theme, config.highlights), config.ui);
	app.newSession = (name: string): Session => (demo ? new DemoSession(name, model) : new PiSession(name, model));

	app.onQuit = () => {
		app.stopTimers();
		for (const s of app.sessions) s.abort();
		tui.stop();
		process.exit(0);
	};

	if (demo) {
		for (const s of createDemoSessions()) app.addSession(s, false);
		app.focusIdx = 0;
	} else {
		app.addSession(app.newSession("main"));
	}

	tui.addChild(app);
	tui.setFocus(app);
	terminal.setTitle("vigent");
	tui.start();
	if (warnings.length > 0) app.notify(warnings.join(" · "));
	tui.requestRender(true);
	return undefined;
}

main()
	.then((code) => {
		if (code !== undefined) process.exitCode = code;
	})
	.catch((err) => {
		console.error(`vigent: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
