import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { completeCommandLine } from "../dist/completion.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { parseRaceArgs, racerLabels } from "../dist/race.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { createWorktree } from "../dist/worktree.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-race-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

class Racer extends Session {
	sent = [];
	aborted = false;
	send(t) {
		this.sent.push(t);
		this.pushUser(t);
		this.setState("running");
	}
	abort() {
		this.aborted = true;
	}
	finish(reply, state = "idle") {
		this.items.push({ kind: "agent", text: reply });
		this.setState(state);
	}
}

const engine = (id, name, connected = true) => ({ id, name, installed: true, connected, detail: "" });

function makeApp({ engines = [engine("claude", "Claude Code"), engine("codex", "Codex"), engine("gemini", "Gemini CLI", false)], worktreeFor } = {}) {
	const overlays = [];
	const alerts = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide: () => overlays.splice(overlays.indexOf(c), 1) }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.engines = engines;
	app.defaultEngine = () => "claude";
	app.alert = (bytes) => alerts.push(bytes);
	let clock = 1_000;
	app.now = () => clock;
	const made = [];
	app.newSession = (name, opts) => {
		made.push({ name, ...opts });
		const s = new Racer(name, opts.model ?? "default", worktreeFor?.(name));
		s.engine = opts.engine;
		return s;
	};
	const type = (...keys) => keys.forEach((k) => app.handleInput(k));
	const ex = (cmd) => type(":", ...cmd, "\r");
	return { app, made, ex, type, overlays, alerts, tick: (ms) => (clock += ms) };
}

test(":race arguments: the task, --engines with engine:model, a template, and what's wrong with them", () => {
	assert.deepEqual(parseRaceArgs("fix the flaky test"), { task: "fix the flaky test" });
	assert.deepEqual(parseRaceArgs("fix it --engines claude,codex"), { task: "fix it", racers: [{ engine: "claude" }, { engine: "codex" }] });
	assert.deepEqual(parseRaceArgs("-e claude:opus,claude:sonnet tidy the readme -t fix"), {
		task: "tidy the readme",
		template: "fix",
		racers: [{ engine: "claude", model: "opus" }, { engine: "claude", model: "sonnet" }],
	});
	assert.deepEqual(parseRaceArgs("x --engines=opencode:anthropic/claude:1,pi").racers, [{ engine: "opencode", model: "anthropic/claude:1" }, { engine: "pi" }]);
	assert.match(parseRaceArgs("x --engines claude").error, /at least two/);
	assert.match(parseRaceArgs("x --engines :opus,codex").error, /no engine/);
});

test("racers are told apart by engine, then by model, then by a number", () => {
	const label = (...parts) => racerLabels(parts.map((p) => ({ engine: p.split(":")[0], ...(p.includes(":") ? { model: p.split(":")[1] } : {}) })));
	assert.deepEqual(label("claude", "codex"), ["claude", "codex"]);
	assert.deepEqual(label("claude:opus", "codex"), ["claude", "codex"]);
	assert.deepEqual(label("claude:opus", "claude:sonnet", "codex"), ["claude opus", "claude sonnet", "codex"]);
	assert.deepEqual(label("claude", "claude", "codex"), ["claude 1", "claude 2", "codex"]);
	assert.deepEqual(label("claude:opus", "claude:opus", "claude"), ["claude opus 1", "claude opus 2", "claude"]);
});

test(":race <task> starts an agent per signed-in engine, each with the same prompt", () => {
	const { app, made, ex } = makeApp();
	ex("race fix the flaky checkout test");
	assert.deepEqual(made.map((m) => [m.name, m.engine, m.worktree]), [
		["fix flaky checkout test claude", "claude", true],
		["fix flaky checkout test codex", "codex", true],
	], "gemini isn't signed in, so it doesn't race");
	assert.deepEqual(app.sessions.map((s) => s.sent), [["fix the flaky checkout test"], ["fix the flaky checkout test"]]);
	assert.equal(app.focusIdx, 0, "you watch the first racer");
	assert.match(app.message, /^race: claude, codex on 'fix flaky checkout test' · :race compares them$/);
	assert.equal(app.races.length, 1);
});

test(":race --engines picks the racers, with a model each, the same engine twice, and a template's prompt", () => {
	const { app, made, ex } = makeApp();
	ex("race the cart total is off by one --engines claude:opus,claude:sonnet,gemini -t fix");
	assert.deepEqual(made.map((m) => [m.name, m.engine, m.model]), [
		["cart total is off by claude opus", "claude", "opus"],
		["cart total is off by claude sonnet", "claude", "sonnet"],
		["cart total is off by gemini", "gemini", undefined],
	], "an engine you name races even when it isn't signed in yet, like :new --engine");
	assert.match(app.sessions[0].sent[0], /failing test/i, "the fix template's prompt");
	assert.match(app.sessions[0].sent[0], /the cart total is off by one/);
	assert.equal(app.sessions[2].sent[0], app.sessions[0].sent[0]);
});

test(":race says what it can't do: one engine, an unknown engine, a missing template, no task", () => {
	const one = makeApp({ engines: [engine("claude", "Claude Code"), engine("codex", "Codex", false)] });
	one.ex("race fix it");
	assert.match(one.app.message, /only Claude Code is signed in.*--engines claude,claude/);
	assert.equal(one.app.sessions.length, 0);

	const { app, ex } = makeApp();
	ex("race fix it --engines claude,codx");
	assert.match(app.message, /unknown engine 'codx'/);
	ex("race fix it -t nope");
	assert.match(app.message, /no template 'nope'/);
	ex("race --engines claude,codex");
	assert.match(app.message, /usage: :race <task>/);
	ex("race");
	assert.match(app.message, /no race yet/);
	ex("race pick");
	assert.match(app.message, /no race to pick from/);
	assert.equal(app.sessions.length, 0);
});

test("an engine that can't start is left out and named; the rest still race", () => {
	const { app, ex } = makeApp({ engines: [engine("claude", "Claude Code"), engine("codex", "Codex"), { id: "gemini", name: "Gemini CLI", installed: false, connected: false, detail: "", install: "npm i -g gemini" }] });
	ex("race fix it --engines claude,gemini,codex");
	assert.deepEqual(app.sessions.map((s) => s.engine), ["claude", "codex"]);
	assert.match(app.message, /^race: claude, codex on 'fix it' · not started: gemini: Gemini CLI isn't installed/);
});

test("the race is over when every racer has stopped: the message ranks them, and the bell rings for the ones you weren't watching", () => {
	const { app, ex, alerts, tick } = makeApp();
	ex("race fix the flaky test");
	const [claude, codex] = app.sessions;
	tick(41_200);
	codex.finish("Fixed it by awaiting the mock.");
	assert.doesNotMatch(app.message, /race over/, "claude still runs");
	const before = alerts.length;
	tick(24_000);
	claude.finish("The test raced the timer; it now uses fake timers.");
	assert.match(app.message, /^race over: codex 41\.2s · claude 1m 05s · :race compares them$/);
	assert.ok(alerts.length > before, "codex wasn't on screen");

	// a follow-up to a racer doesn't end the race a second time
	app.message = "";
	claude.submit("also update the docs");
	claude.finish("Done.");
	assert.doesNotMatch(app.message, /race over/);
});

test("a racer that fails counts as stopped, and is marked", () => {
	const { app, ex, tick } = makeApp();
	ex("race fix it");
	const [claude, codex] = app.sessions;
	tick(2_000);
	claude.setState("error");
	tick(3_000);
	codex.finish("ok");
	assert.match(app.message, /^race over: claude 2\.0s failed · codex 5\.0s/);
});

test(":race shows the racers, first to finish first, and Enter opens one", () => {
	const { app, ex, overlays, tick } = makeApp();
	ex("race fix the flaky test");
	const [claude, codex] = app.sessions;
	codex.worktree = { branch: "fix/flaky-test-codex", stat: { files: 2, added: 12, removed: 3 } };
	codex.tokens = 4_200;
	tick(41_200);
	codex.finish("Fixed it by awaiting the mock.");
	ex("race");
	const text = plain(overlays[0].render(110));
	assert.match(text, /Race · fix flaky test/);
	assert.match(text, /task\s+fix the flaky test/);
	const rows = text.split("\n").filter((l) => /\b(codex|claude)\b/.test(l) && !/task/.test(l));
	assert.match(rows[0], /1 .*codex\s+done\s+41\.2s\s+\+12 .3 2 files\s+4\.2k tok/);
	assert.match(rows[1], /claude\s+running\s+41\.2s\s+no changes/);
	assert.match(text, /Fixed it by awaiting the mock\./);
	assert.match(text, /1 of 2 still running/);
	assert.match(text, /:race pick keeps the one you're on/);

	// the focused racer (claude) is selected; k moves to codex, Enter opens it
	overlays[0].handleInput("k");
	overlays[0].handleInput("\r");
	assert.equal(app.focusedSession, codex);
	assert.equal(claude.aborted, false);
});

test(":race pick keeps the racer you're on and asks before removing the rest; :race! pick doesn't ask", () => {
	const { app, ex, type } = makeApp();
	ex("race fix it --engines claude,codex,claude");
	const [first, codex, second] = app.sessions;
	app.addSession(new Racer("bystander", "m"), false);
	type("]", "s"); // codex
	assert.equal(app.focusedSession, codex);
	ex("race pick");
	assert.match(app.confirm.question, /keep 'fix it codex' and remove the other 2 racers, with their worktrees and changes\? \(y\/n\)/);
	type("n");
	assert.equal(app.sessions.length, 4, "no: nothing changes");

	ex("race pick");
	type("y");
	assert.deepEqual(app.sessions.map((s) => s.name), ["fix it codex", "bystander"], "agents outside the race stay");
	assert.ok(first.aborted && second.aborted && !codex.aborted);
	assert.equal(app.focusedSession, codex);
	assert.match(app.message, /kept 'fix it codex' · removed the other 2 racers · :merge or :pr lands it/);
	assert.equal(app.races.length, 0);

	const again = makeApp();
	again.ex("race fix it");
	again.ex("race! pick");
	assert.deepEqual(again.app.sessions.map((s) => s.name), ["fix it claude"]);
});

test(":race pick only works from a racer, and a racer you :kill leaves the race", () => {
	const { app, ex, type } = makeApp();
	app.addSession(new Racer("bystander", "m"));
	ex("race fix it");
	type(" ", "1");
	assert.equal(app.focusedSession.name, "bystander");
	ex("race pick");
	assert.match(app.message, /this agent isn't in a race/);
	assert.equal(app.sessions.length, 3);

	type(" ", "2");
	ex("kill");
	assert.deepEqual(app.races[0].racers.length, 2, "pruned the next time the race is looked at");
	type(" ", "2");
	ex("race pick");
	assert.match(app.message, /is the only racer left/);
	assert.equal(app.races.length, 0);
});

test(":race pick removes the losers' worktrees and branches, uncommitted work included", () => {
	const root = path.join(tmp, "repo");
	fs.mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@example.com");
	git(root, "config", "user.name", "t");
	fs.writeFileSync(path.join(root, "a.txt"), "one\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "init");
	const config = { enabled: true, dir: "../{repo}-worktrees", branch: "{type}/{name}", backend: "git" };
	const { app, ex } = makeApp({ worktreeFor: (name) => createWorktree(root, name, config) });
	app.workspace = { root, config };

	ex("race fix it");
	const [claude, codex] = app.sessions;
	assert.equal(claude.worktree.branch, "fix/it-claude");
	assert.equal(codex.worktree.branch, "fix/it-codex");
	fs.writeFileSync(path.join(codex.worktree.path, "a.txt"), "codex's uncommitted try\n");
	fs.writeFileSync(path.join(claude.worktree.path, "a.txt"), "claude's fix\n");

	ex("race! pick");
	assert.equal(fs.existsSync(codex.worktree.path), false, "the loser's worktree is gone");
	assert.equal(fs.readFileSync(path.join(claude.worktree.path, "a.txt"), "utf8"), "claude's fix\n", "the winner's work is untouched");
	assert.deepEqual(git(root, "branch", "--format=%(refname:short)").split("\n").sort(), ["fix/it-claude", "main"]);
	assert.match(app.message, /kept 'fix it claude' · removed the other racer/);
});

test("--demo races three scripted agents, and :race completes on Tab", () => {
	const { app, made, ex } = makeApp({ engines: [] });
	app.demo = true;
	ex("race add dark mode");
	assert.deepEqual(made.map((m) => m.name), ["add dark mode claude", "add dark mode codex", "add dark mode gemini"]);
	assert.deepEqual(completeCommandLine("ra", { agents: [], themes: [] }).items, ["race"]);
});
