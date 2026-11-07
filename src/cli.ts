#!/usr/bin/env node
/** vigent — vim-native agent orchestrator on the pi engine. */
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { App } from "./app.js";
import { createDemoSessions } from "./demo.js";
import { DemoSession, PiSession, type Session } from "./session.js";
import { loadTheme, NVIM_DEFAULT, Painter } from "./theme.js";

const HELP = `vigent — vim-native agent orchestrator (pi engine)

usage:
  vigent [--demo] [--theme <name>] [--model <id>]
  vigent theme import <colorscheme> [as <name>]   import a vim/nvim theme
  vigent theme list

keys (NORMAL mode):
  i            prompt the focused agent        :new <name>   spawn an agent
  j/k gg G     scroll transcript               :kill         kill focused agent
  ctrl+d/u     half-page scroll                :theme <t>    switch theme
  ]s [s 1-9    switch sessions                 :model <m>    switch model
  za zM zR     fold/unfold tool output         :q            quit
  /pattern n N search transcript

Runs in demo mode (scripted sessions, no network) when --demo is passed
or no provider API key is found (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
`;

async function main() {
	const argv = process.argv.slice(2);

	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return;
	}

	if (argv[0] === "theme") {
		const { importNvimTheme } = await import("./nvim-import.js");
		const { listThemes } = await import("./theme.js");
		if (argv[1] === "list") {
			console.log(listThemes().join("\n"));
			return;
		}
		if (argv[1] === "import" && argv[2]) {
			const asIdx = argv.indexOf("as");
			const outName = asIdx > 2 ? argv[asIdx + 1] : undefined;
			const file = importNvimTheme(argv[2], outName);
			console.log(`imported '${argv[2]}' -> ${file}`);
			console.log(`use it with: vigent --theme ${outName ?? argv[2]}  (or :theme ${outName ?? argv[2]})`);
			return;
		}
		console.log("usage: vigent theme import <colorscheme> [as <name>] | vigent theme list");
		process.exitCode = 1;
		return;
	}

	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};

	const hasKey = Boolean(
		process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
	);
	const demo = argv.includes("--demo") || !hasKey;
	const model = flag("--model") ?? "claude-sonnet-4-5";

	let theme = NVIM_DEFAULT;
	const themeName = flag("--theme");
	if (themeName) {
		try {
			theme = loadTheme(themeName);
		} catch {
			console.error(`vigent: cannot find color scheme '${themeName}'`);
			process.exit(1);
		}
	}

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, false);
	const app = new App(tui, terminal, new Painter(theme));
	app.newSession = (name: string): Session =>
		demo ? new DemoSession(name, model) : new PiSession(name, model);

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
	tui.requestRender(true);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
