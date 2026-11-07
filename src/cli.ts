#!/usr/bin/env node
/** vigent — vim-native agent orchestrator on the pi engine. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { type AgentMeta, loadAgentMeta, restorableAgents, saveAgentMeta, sessionDir } from "./agents.js";
import { App } from "./app.js";
import { CliSession } from "./cli-engines.js";
import { defaultEngine, detectEngines, ENGINE_BINS, type EngineId, isEngineId, onPath, piConnected, quickEngines } from "./engines.js";
import { CONFIG_TEMPLATE, configPath, loadConfig } from "./config.js";
import { createDemoSessions } from "./demo.js";
import { buildKeymap, KEY_MODES } from "./keys.js";
import { formatBytes, prepareViews, riftriBackends, riftriGc, riftriHealth, riftriStateDir } from "./riftri.js";
import { DemoSession, PiSession, type Session } from "./session.js";
import { BUILTIN_THEMES, listThemes, loadTheme, Painter, themesDir } from "./theme.js";
import { themeNewTemplate } from "./theme-new.js";
import {
	branchName,
	createWorktree,
	findWorktree,
	listWorktrees,
	removeWorktree,
	repoRoot,
	type WorktreeInfo,
	worktreesDir,
} from "./worktree.js";

const HELP = `vigent — vim-native agent orchestrator (pi engine)

usage:
  vigent [--demo] [--theme <name>] [--model <id>] [--engine pi|claude|codex|opencode]

engines (what runs new agents; :checkhealth shows which are signed in):
  pi        built in, uses ANTHROPIC_API_KEY / OPENAI_API_KEY / ... or pi's login
  claude    your installed Claude Code CLI, with its own login
  codex     your installed Codex CLI, with its own login
  opencode  your installed OpenCode CLI, with its own login

themes:
  vigent theme list                          built-in and installed themes
  vigent theme import                        import the colorscheme your nvim/vim uses now
  vigent theme import <name> [--as <name>]   import any colorscheme nvim/vim can load
  vigent theme import ./theme.vim            import a colorscheme file (no editor needed)
      --vim | --nvim      use this editor     --light | --dark   set 'background' first
      --clean             skip your editor config
  vigent theme new <name> [--from <theme>]   create a theme file to customize, pre-filled with that theme's colors
      --palette           build it from a palette only     --transparent   use the terminal's background
  vigent theme path                          show where themes and config live
  vigent worktree list                       agent worktrees in this repo
  vigent worktree remove <branch> [--force]  delete one (safe unless --force)
  vigent worktree prune                      forget worktrees whose folder is gone
  vigent worktree gc                         free riftri storage no worktree uses
  vigent config init                         write a commented config.toml
  vigent config check                        validate config.toml (theme, options, keys)

keys (NORMAL mode):
  i            prompt the focused agent        :new <task>     agent in its own worktree
  j/k gg G     scroll transcript               :kill[!]        stop it (! removes worktree)
  ctrl+d/u     half-page scroll                :colorscheme    pick a theme (live preview)
  ]s [s 1-9    switch sessions                 :hi Group ...   change a highlight group
  za zM zR     fold/unfold tool output         :set nonumber   toggle ui options
  /pattern ?   search transcript               :diff           what the agent changed
  V y  yy yib  select and copy, last reply     :merge  :pr     land the agent's work
  {  }         previous / next message         :dash           all agents at a glance
  dd           kill agent (asks first)         :queue <text>   follow-up after this run
  :worktrees   list agent worktrees            :attach <branch> reopen a kept agent
  :diff split  side-by-side diff               :tree           go back to any point and branch
  <Space>u     the conversation tree           :nmap <lhs> <rhs> map keys (see :help)
  :help        every key, including yours      :q              quit
  :checkhealth engines: installed? signed in?  :new <task> --engine codex

Runs in demo mode (scripted sessions, no network) when --demo is passed,
or when pi has no API key and none of claude / codex / opencode is installed.
Config: ~/.config/vigent/config.toml   Themes: ~/.config/vigent/themes/
`;

function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
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
			console.error("usage: vigent theme new <name> [--from <theme>] [--palette] [--transparent | --no-transparent]");
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
		fs.writeFileSync(
			file,
			themeNewTemplate(name, from, {
				palette: argv.includes("--palette"),
				transparent: argv.includes("--transparent") ? true : argv.includes("--no-transparent") ? false : undefined,
			}),
		);
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

function worktreeCommand(argv: string[]): number {
	const root = repoRoot(process.cwd());
	if (!root) {
		console.error("vigent: not inside a git repository");
		return 1;
	}
	const { config } = loadConfig();
	const sub = argv[0];
	if (sub === "list" || sub === undefined) {
		const all = listWorktrees(root, config.worktree);
		if (all.length === 0) console.log(`no agent worktrees (they go in ${worktreesDir(root, config.worktree)})`);
		const backends = riftriBackends(root, all.map((w) => w.path));
		for (const w of all) {
			const b = backends.get(w.path);
			console.log(`${(w.branch ?? `(detached ${w.head})`).padEnd(36)} ${(b ? `riftri ${b}` : "git").padEnd(16)} ${w.path}`);
		}
		return 0;
	}
	if (sub === "remove" || sub === "rm") {
		const query = argv[1];
		if (!query) {
			console.error("usage: vigent worktree remove <branch> [--force]");
			return 1;
		}
		const w = findWorktree(root, query, config.worktree);
		if (!w) {
			console.error(`vigent: no agent worktree '${query}' (see: vigent worktree list)`);
			return 1;
		}
		const r = removeWorktree(root, w, argv.includes("--force"));
		console.log(r.message);
		return r.removed ? 0 : 1;
	}
	if (sub === "prune") {
		execFileSync("git", ["worktree", "prune", "-v"], { cwd: root, stdio: "inherit" });
		return 0;
	}
	if (sub === "gc") {
		if (!riftriStateDir(root)) {
			console.log("no riftri storage in this repository");
			return 0;
		}
		const r = riftriGc(root);
		if (!r.ok) {
			console.error(`vigent: riftri gc failed: ${r.message}`);
			return 1;
		}
		console.log(`freed ${formatBytes(r.report?.removed_allocated_bytes ?? 0)}`);
		return 0;
	}
	console.error("usage: vigent worktree list | remove <branch> [--force] | prune | gc");
	return 1;
}

async function main(): Promise<number | undefined> {
	const argv = process.argv.slice(2);

	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	if (argv[0] === "theme" || argv[0] === "themes") return themeCommand(argv.slice(1));
	if (argv[0] === "worktree" || argv[0] === "worktrees" || argv[0] === "wt") return worktreeCommand(argv.slice(1));
	if (argv[0] === "config" && argv[1] === "check") {
		const file = configPath();
		if (!fs.existsSync(file)) {
			console.log(`no config at ${file} (defaults in use). Create one with: vigent config init`);
			return 0;
		}
		const { config, warnings } = loadConfig(file);
		const keys = buildKeymap(config.leader, config.keys);
		warnings.push(...keys.warnings);
		try {
			if (config.theme) loadTheme(config.theme);
		} catch (err) {
			warnings.push((err as Error).message);
		}
		const mappings = KEY_MODES.reduce((n, m) => n + keys.keymap.bindings(m).filter((b) => b.user).length, 0);
		for (const w of warnings) console.log(`warning: ${w}`);
		console.log(
			`${file}: ${warnings.length === 0 ? "ok" : `${warnings.length} problem(s)`} · theme ${config.theme ?? "default"} · leader ${config.leader ?? "\\"} · ${mappings} mapping(s) · ${Object.keys(config.highlights).length} highlight override(s)`,
		);
		return warnings.length === 0 ? 0 : 1;
	}
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
	const { keymap, warnings: keyWarnings } = buildKeymap(config.leader, config.keys);
	warnings.push(...keyWarnings);

	const engineArg = flag(argv, "--engine");
	if (engineArg && !isEngineId(engineArg)) {
		console.error(`vigent: unknown engine '${engineArg}' (pi, claude, codex or opencode)`);
		return 1;
	}
	const chosenEngine = (engineArg ?? (config.engine === "auto" ? undefined : config.engine)) as EngineId | undefined;
	const anyCli = (["claude", "codex", "opencode"] as const).some((id) => onPath(ENGINE_BINS[id]));
	const demo = argv.includes("--demo") || (!chosenEngine && !piConnected() && !anyCli);
	const modelArg = flag(argv, "--model");
	const model = modelArg ?? config.model ?? "claude-sonnet-4-5";

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
	const root = repoRoot(process.cwd());
	const app = new App(tui, terminal, new Painter(theme, config.highlights), config.ui, keymap, {
		root,
		config: config.worktree,
	});
	// can agent worktrees be copy-on-write here? (riftri; runs in the background)
	app.checkStorage = () => riftriHealth(root, root ? worktreesDir(root, config.worktree) : undefined, config.worktree.backend);
	if (!demo && root && config.worktree.enabled) {
		app
			.checkStorage()
			.then((h) => {
				app.storage = h;
			})
			.catch(() => {});
	}
	app.defaultEngine = () => chosenEngine ?? defaultEngine(app.engines);
	app.detectEngines = () => detectEngines();
	// installed? signed in? What's on PATH shows at once; the CLIs' sign-in checks take a moment
	app.setEngines(quickEngines());
	detectEngines()
		.then((engines) => app.setEngines(engines))
		.catch(() => {});

	/** A Claude Code / Codex / OpenCode agent; its conversation id is saved so it survives a restart. */
	const cliSession = (name: string, engine: Exclude<EngineId, "pi">, requested: string | undefined, cwd: string, wt?: WorktreeInfo, resumeId?: string) =>
		new CliSession(name, engine, requested, {
			cwd,
			worktree: wt,
			resumeId,
			extraArgs: config.engines[engine]?.args,
			onResumeId: (id) => {
				if (!wt?.path) return;
				const meta = loadAgentMeta(wt.path);
				if (meta) saveAgentMeta(wt.path, { ...meta, resumeId: id });
			},
		});

	app.newSession = (name, { worktree, model: perAgent, engine = app.defaultEngine() }): Session => {
		if (demo) {
			// demo mode never touches your repo: the worktree is only shown, not created
			const shown = worktree ? { branch: branchName(name, config.worktree.branch) } : undefined;
			return new DemoSession(name, perAgent ?? model, shown);
		}
		// a CLI uses its own default model unless one is asked for
		const requested = engine === "pi" ? undefined : (perAgent ?? config.engines[engine]?.model ?? (modelArg && engineArg === engine ? modelArg : undefined));
		const m = engine === "pi" ? (perAgent ?? model) : (requested ?? "");
		const wt = worktree && root ? createWorktree(root, name, config.worktree) : undefined;
		if (wt?.path) {
			saveAgentMeta(wt.path, {
				name,
				model: m,
				base: wt.base,
				createdAt: new Date().toISOString(),
				...(engine === "pi" ? {} : { engine, ...(requested ? { requestedModel: requested } : {}) }),
			});
		}
		const cwd = wt?.path ?? process.cwd();
		if (engine !== "pi") return cliSession(name, engine, requested, cwd, wt?.path ? wt : undefined);
		if (!wt?.path) return new PiSession(name, m, { cwd });
		return new PiSession(name, m, { cwd, worktree: wt, sessionDir: sessionDir(wt.path) });
	};
	/** Reopen a saved agent with the engine it was started with. */
	const reopen = (meta: AgentMeta, worktree: WorktreeInfo): Session => {
		const engine = meta.engine && isEngineId(meta.engine) ? meta.engine : "pi";
		if (engine !== "pi") return cliSession(meta.name, engine, meta.requestedModel, worktree.path!, worktree, meta.resumeId);
		return new PiSession(meta.name, meta.model, { cwd: worktree.path!, worktree, sessionDir: sessionDir(worktree.path!) });
	};
	app.attachSession = (wt) => {
		if (demo || !wt.path) throw new Error("attaching needs a real agent (not --demo)");
		const meta = loadAgentMeta(wt.path) ?? {
			name: wt.branch.split("/").pop()?.replace(/-/g, " ") ?? wt.branch,
			model,
			createdAt: new Date().toISOString(),
		};
		const view = root ? prepareViews(root, [wt.path]).get(wt.path) : undefined;
		if (view && !view.ready) throw new Error(`can't reopen ${wt.branch}: ${view.reason}`);
		saveAgentMeta(wt.path, { ...meta, detached: undefined }); // reopened at the next start again
		return reopen(meta, { ...wt, base: wt.base ?? meta.base, riftri: view?.backend });
	};

	app.onQuit = () => {
		app.stopTimers();
		for (const s of app.sessions) {
			s.abort();
			s.dispose();
		}
		tui.stop();
		process.exit(0);
	};

	if (demo) {
		for (const s of createDemoSessions()) app.addSession(s, false);
		app.focusIdx = 0;
	} else if (root && config.worktree.enabled) {
		// reopen the agents that were running when vigent last quit
		const agents = restorableAgents(root, config.worktree);
		// riftri views on OverlayFS lose their mount on reboot: repair them before an agent runs there
		const views = prepareViews(root, agents.map((a) => a.worktree.path!));
		for (const { meta, worktree } of agents) {
			const view = views.get(worktree.path!);
			if (view && !view.ready) {
				warnings.push(`couldn't reopen '${meta.name}': ${view.reason}`);
				continue;
			}
			try {
				app.addSession(reopen(meta, { ...worktree, riftri: view?.backend }), false);
			} catch (err) {
				warnings.push(`couldn't reopen '${meta.name}': ${(err as Error).message}`);
			}
		}
		if (app.sessions.length > 0) {
			app.focusIdx = 0;
			app.notify(`reopened ${app.sessions.length} agent${app.sessions.length === 1 ? "" : "s"} from last time`, "Comment");
		}
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
