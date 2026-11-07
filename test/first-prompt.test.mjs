import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { agentNameFrom, App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { quickEngines } from "../dist/engines.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function makeApp() {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const made = [];
	app.defaultEngine = () => "claude";
	app.newSession = (name, opts) => {
		made.push({ name, ...opts });
		const s = new (class extends Session {
			sent = [];
			send(t) {
				this.sent.push(t);
				this.pushUser(t);
			}
			abort() {}
		})(name, "Claude Code");
		s.engine = opts.engine;
		return s;
	};
	const type = (keys) => [...keys].forEach((k) => app.handleInput(k));
	return { app, made, type };
}

test("with no agent yet, i + a prompt + Enter starts one on the default engine and sends the prompt", () => {
	const { app, made, type } = makeApp();
	assert.match(plain(app.render(120)), /type {2}i +type a task, Enter: an agent starts on it/, "the intro says how");

	app.handleInput("i");
	assert.equal(app.mode, "INSERT");
	assert.match(plain(app.render(120)), /-- INSERT -- .*type what you want done; Enter starts an agent on Claude Code/);
	type("Fix the flaky checkout test, please");
	app.handleInput("\r");

	assert.equal(app.sessions.length, 1);
	assert.deepEqual(made, [{ name: "fix flaky checkout test", worktree: true, model: undefined, engine: "claude" }]);
	assert.deepEqual(app.sessions[0].sent, ["Fix the flaky checkout test, please"]);
	assert.match(app.message, /'fix flaky checkout test' · Claude Code/);

	// with an agent focused, a prompt goes to it as before
	app.handleInput("i");
	type("now add a retry");
	app.handleInput("\r");
	assert.equal(app.sessions.length, 1);
	assert.deepEqual(app.sessions[0].sent.at(-1), "now add a retry");
});

test("a first prompt that can't start an agent says why and starts nothing", () => {
	const { app, type } = makeApp();
	app.engines = [{ id: "claude", name: "Claude Code", installed: false, connected: false, detail: "not installed", install: "npm install -g @anthropic-ai/claude-code" }];
	app.handleInput("i");
	type("hello");
	app.handleInput("\r");
	assert.equal(app.sessions.length, 0);
	assert.match(app.message, /Claude Code isn't installed: npm install -g @anthropic-ai\/claude-code/);
	app.handleInput("i");
	app.handleInput("\r");
	assert.equal(app.sessions.length, 0, "an empty prompt does nothing");
});

test("agent names from prompts", () => {
	assert.equal(agentNameFrom("Fix the flaky checkout test, please"), "fix flaky checkout test");
	assert.equal(agentNameFrom("can you add dark mode to the settings page and the header"), "add dark mode to settings");
	assert.equal(agentNameFrom("refactor/auth: split the middleware"), "refactor/auth split middleware");
	assert.equal(agentNameFrom("???"), "agent");
});

test("engines show at once as 'checking…' while their sign-in checks run", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-quick-"));
	try {
		const bin = path.join(dir, "claude");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(bin, 0o755);
		const engines = quickEngines({ PATH: dir, HOME: dir });
		assert.deepEqual(
			engines.map((e) => [e.id, e.installed, e.connected, Boolean(e.checking), e.detail]),
			[
				["pi", true, false, false, "built in · no API key found"],
				["claude", true, false, true, "checking sign-in…"],
				["codex", false, false, false, "not installed"],
				["opencode", false, false, false, "not installed"],
			],
		);
		const { app } = makeApp();
		app.setEngines(engines);
		const screen = plain(app.render(120));
		assert.match(screen, /◐ Claude Code +checking…/);
		assert.match(screen, /○ Codex +not installed/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
