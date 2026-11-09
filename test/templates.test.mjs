import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { agentNameFrom, App } from "../dist/app.js";
import { CONFIG_TEMPLATE, DEFAULT_UI, loadConfig } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { allTemplates, BUILTIN_TEMPLATES, fillTemplate } from "../dist/templates.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-templates-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const tick = () => new Promise((r) => setTimeout(r, 10));

function configFrom(toml) {
	const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.toml`);
	fs.writeFileSync(file, toml);
	return loadConfig(file);
}

function makeApp(templates = {}) {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide: () => overlays.splice(overlays.indexOf(c), 1) }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const made = [];
	app.defaultEngine = () => "claude";
	app.templates = templates;
	app.newSession = (name, opts) => {
		made.push({ name, ...opts });
		const s = new (class extends Session {
			sent = [];
			send(t) {
				this.sent.push(t);
				this.pushUser(t);
			}
			abort() {}
		})(name, opts.model ?? "default");
		s.engine = opts.engine;
		s.effort = opts.effort;
		return s;
	};
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	return { app, made, ex, overlays };
}

test("filling a template: {task} takes the task; without one the task goes after it; review's focus is optional", () => {
	const fix = { name: "fix", prompt: "Fix: {task}. Then rerun {task}'s tests." };
	assert.equal(fillTemplate(fix, " the cart total "), "Fix: the cart total. Then rerun the cart total's tests.");
	assert.equal(fillTemplate({ name: "x", prompt: "Tidy the README." }, "keep it short"), "Tidy the README.\n\nkeep it short");
	assert.equal(fillTemplate({ name: "x", prompt: "Tidy the README." }, ""), "Tidy the README.");
	const review = allTemplates({}).find((t) => t.name === "review");
	assert.doesNotMatch(fillTemplate(review, ""), /\{task\}|Focus on/);
	assert.match(fillTemplate(review, "the retry logic"), /hard to follow\. Focus on: the retry logic\.\n\nList what you find/);
	assert.deepEqual(BUILTIN_TEMPLATES.map((t) => t.name), ["fix", "test", "review", "explain"]);
});

test("[templates] in config.toml: yours are added, a built-in name replaces it, mistakes are warnings", () => {
	const { config, warnings } = configFrom(`
[templates.migrate]
description = "a migration with a rollback"
prompt = "Write a migration that {task}. Include the rollback."
engine = "claude"
model = "opus"
effort = "high"
worktree = true

[templates.fix]
prompt = "Fix {task} our way: failing test first."

[templates.nothing]
engine = "codex"

[templates.loud]
prompt = "x"
engine = "claude"
effort = "ultra"
color = "red"

[templates.weird]
prompt = "y"
engine = "gemini"
`);
	assert.deepEqual(config.templates.migrate, {
		name: "migrate",
		description: "a migration with a rollback",
		prompt: "Write a migration that {task}. Include the rollback.",
		engine: "claude",
		model: "opus",
		effort: "high",
		worktree: true,
	});
	assert.equal(config.templates.nothing, undefined);
	assert.equal(config.templates.loud.effort, undefined, "an effort the engine doesn't have is dropped");
	assert.deepEqual(warnings, [
		"config [templates.nothing]: 'prompt' is required",
		"config [templates.loud]: unknown option 'color'",
		"config [templates.loud]: 'effort' should be one of low, medium, high, xhigh, max",
		'config [templates.weird]: \'engine\' should be "pi", "claude", "codex", "opencode" or an engine from [engines]',
	]);
	const all = allTemplates(config.templates);
	assert.deepEqual(all.map((t) => t.name), ["fix", "test", "review", "explain", "migrate", "loud", "weird"]);
	assert.equal(all[0].prompt, "Fix {task} our way: failing test first.", "yours replaces the built-in fix");
	assert.ok(!all[0].builtin && all[1].builtin);

	// the commented example in the config template is valid once uncommented
	const example = CONFIG_TEMPLATE.split("\n").filter((l) => /^# (\[templates\.migrate\]|description|prompt|engine|effort) /.test(l) || l === "# [templates.migrate]").map((l) => l.slice(2));
	const parsed = configFrom(example.join("\n"));
	assert.deepEqual(parsed.warnings, []);
	assert.equal(parsed.config.templates.migrate.engine, "claude");
});

test(":new -t <template> <task> starts an agent on the template's engine, model and effort, and sends the prompt", () => {
	const { app, made, ex } = makeApp({
		migrate: { name: "migrate", prompt: "Write a migration that {task}.", engine: "codex", model: "gpt-5.5", effort: "high", worktree: false },
	});
	ex("new -t fix the cart total is off by one");
	assert.deepEqual(made.at(-1), { name: agentNameFrom("the cart total is off by one"), worktree: true, model: undefined, engine: "claude" });
	assert.match(app.focusedSession.sent[0], /^Find and fix this bug: the cart total is off by one\n\nFirst reproduce it with a failing test/);
	assert.match(app.message, /'cart total is off by' · Claude Code .* · template fix/);

	ex("new --template migrate adds an index on orders.user_id");
	assert.deepEqual(made.at(-1), { name: agentNameFrom("adds an index on orders.user_id"), worktree: false, model: "gpt-5.5", engine: "codex", effort: "high" });
	assert.equal(app.focusedSession.sent[0], "Write a migration that adds an index on orders.user_id.");

	// what you type wins: another engine drops the template's model and effort
	ex("new -t migrate --engine claude drops the legacy table");
	assert.deepEqual(made.at(-1), { name: agentNameFrom("drops the legacy table"), worktree: false, model: undefined, engine: "claude" });

	// review's task is optional
	ex("new -t review");
	assert.equal(made.at(-1).name, "review");
	assert.match(app.focusedSession.sent[0], /^Review the work on this branch/);
	assert.equal(app.sessions.length, 4);
});

test("a template that needs a task asks for one; an unknown name suggests the right one", () => {
	const { app, made, ex } = makeApp();
	ex("new -t fix");
	assert.equal(made.length, 0);
	assert.match(app.message, /template 'fix' needs a task: :new -t fix <what>/);
	assert.equal(app.mode, "COMMAND");
	assert.equal(app.cmdBuf, "new -t fix ", "the command line is ready for the task");
	app.handleInput("\x1b");

	ex("new -t tset the parser");
	assert.equal(made.length, 0);
	assert.match(app.message, /no template 'tset' \(did you mean 'test'\?\) · :templates lists them/);
});

test(":templates (Space T, or T on the start screen) picks one; the command line takes the task", async () => {
	const { app, made, overlays } = makeApp({ standup: { name: "standup", prompt: "Summarize what changed in this repo since yesterday.", description: "yesterday's changes", engine: "claude" } });
	app.handleInput("T"); // the start screen's key
	await tick();
	assert.equal(overlays.length, 1);
	const screen = plain(overlays[0].render(100));
	assert.match(screen, /Start an agent from a template/);
	assert.match(screen, /fix +reproduce a bug with a failing test, then fix it/);
	assert.match(screen, /review +review this branch's work; changes nothing/);
	assert.match(screen, /standup +yesterday's changes \(Claude Code\) · yours/);
	assert.match(plain(app.render(120)), /New agent from a template +T/, "listed on the start screen");

	overlays[0].handleInput("\r"); // fix
	assert.equal(app.mode, "COMMAND");
	assert.equal(app.cmdBuf, "new -t fix ");
	[..."login loops forever", "\r"].forEach((k) => app.handleInput(k));
	assert.equal(made.at(-1).name, agentNameFrom("login loops forever"));

	// a template with no {task} starts right away
	[" ", "T"].forEach((k) => app.handleInput(k)); // <leader>T
	await tick();
	const picker = overlays.at(-1);
	picker.handleInput("G");
	picker.handleInput("\r");
	assert.equal(made.at(-1).name, "standup");
	assert.equal(app.focusedSession.sent[0], "Summarize what changed in this repo since yesterday.");
});
