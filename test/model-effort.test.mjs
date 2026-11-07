import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { EFFORTS, effortChoices, effortChoicesFor, modelChoices, parseCodexModels } from "../dist/choices.js";
import { CLI_ADAPTERS, CliSession } from "../dist/cli-engines.js";
import { DEFAULT_UI, loadConfig } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { piModel } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-model-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const tick = () => new Promise((r) => setTimeout(r, 10));

test("each CLI gets the effort its own way", () => {
	const cwd = "/w";
	assert.deepEqual(CLI_ADAPTERS.claude.args("go", { cwd, model: "opus", effort: "high" }).slice(-6), ["--model", "opus", "--effort", "high", "--", "go"]);
	assert.deepEqual(CLI_ADAPTERS.codex.args("go", { cwd, effort: "xhigh" }).slice(-4), ["-c", 'model_reasoning_effort="xhigh"', "--", "go"]);
	assert.deepEqual(CLI_ADAPTERS.opencode.args("go", { cwd, effort: "max" }).slice(-4), ["--variant", "max", "--", "go"]);
	assert.ok(!CLI_ADAPTERS.claude.args("go", { cwd }).includes("--effort"), "no effort: the CLI decides");
	assert.deepEqual(EFFORTS.claude, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(effortChoices("pi")[0].value, "default");
});

test("model lists per engine; pi models as provider/model", async () => {
	assert.deepEqual((await modelChoices("claude")).map((c) => c.value), ["default", "fable", "opus", "sonnet", "haiku"]);
	assert.deepEqual((await modelChoices("codex", { PATH: "" })).map((c) => c.value), ["default"], "no Codex installed: its default, and any name can be typed");
	const pi = await modelChoices("pi", { OPENAI_API_KEY: "x" });
	assert.ok(pi.length > 0 && pi.every((c) => c.value.startsWith("openai/")), "the providers you have a key for");
	assert.ok(await piModel("claude-sonnet-4-5"), "a bare name is Anthropic's");
	assert.ok(await piModel(pi[0].value));
	assert.equal(await piModel("nope/nothing"), undefined);
});

test(":model and :effort pick for the focused agent; the next prompt uses them, and they're saved", async () => {
	const log = path.join(tmp, "argv.log");
	const bin = path.join(tmp, "claude");
	fs.writeFileSync(bin, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	fs.chmodSync(bin, 0o755);

	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const persisted = [];
	app.persist = (s) => persisted.push({ model: s.chosenModel, effort: s.effort });
	const s = new CliSession("racer", "claude", undefined, { cwd: tmp, bin });
	app.addSession(s, true);
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	ex("model");
	await tick();
	const picker = overlays.at(-1);
	let screen = plain(picker.render(70));
	assert.match(screen, /Model · 'racer' \(Claude Code\)/);
	assert.match(screen, /● default +Claude Code's own choice/);
	assert.match(screen, /opus +latest Opus/);
	for (const k of "opu") picker.handleInput(k);
	assert.match(plain(picker.render(70)), /j\/k move/, "letters don't search until /");
	picker.handleInput("j");
	picker.handleInput("j");
	assert.match(plain(picker.render(70)), / 3\/5 /, "j moves down (o, p and u did nothing)");
	picker.handleInput("k");
	assert.match(plain(picker.render(70)), / 2\/5 /, "k moves up");
	for (const k of "/opu") picker.handleInput(k);
	assert.match(plain(picker.render(70)), /type to filter · Esc done/);
	picker.handleInput("\r");
	await tick();
	assert.equal(s.chosenModel, "opus");
	assert.match(app.message, /model for 'racer' \(Claude Code\): opus \(from the next prompt\)/);

	[" ", "e"].forEach((k) => app.handleInput(k)); // <leader>e
	await tick();
	const efforts = overlays.at(-1);
	screen = plain(efforts.render(70));
	assert.match(screen, /Effort · 'racer'/);
	for (const v of ["low", "medium", "high", "xhigh", "max"]) assert.match(screen, new RegExp(`\\b${v}\\b`));
	for (const k of "/hig") efforts.handleInput(k);
	efforts.handleInput("\r");
	await tick();
	assert.equal(s.effort, "high");
	assert.deepEqual(persisted.at(-1), { model: "opus", effort: "high" });
	assert.match(plain(app.render(120)), /opus · high/, "the winbar shows both");

	s.send("go");
	await new Promise((r) => setTimeout(r, 400));
	const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1));
	assert.deepEqual(argv.slice(-6), ["--model", "opus", "--effort", "high", "--", "go"]);

	// direct forms, a level the engine doesn't take, back to default
	ex("effort off");
	assert.match(app.message, /Claude Code takes: default, low, medium, high, xhigh, max/);
	ex("effort default");
	await tick();
	assert.equal(s.effort, undefined);
	ex("model claude-opus-4-1");
	await tick();
	assert.equal(s.chosenModel, "claude-opus-4-1");

	// a name the list doesn't have: typed, then Enter uses it as is
	ex("model");
	await tick();
	const custom = overlays.at(-1);
	assert.match(plain(custom.render(70)), /\/ to search or type any name/);
	for (const k of "/my-own-model") custom.handleInput(k);
	assert.match(plain(custom.render(70)), /Enter uses 'my-own-model'/);
	custom.handleInput("\r");
	await tick();
	assert.equal(s.chosenModel, "my-own-model");
	s.dispose();
});

test("with no agent open, :model and :effort set them for new agents", async () => {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.defaultEngine = () => "codex";
	const made = [];
	app.newSession = (name, opts) => {
		made.push(opts);
		const s = new (class extends (Object.getPrototypeOf(CliSession)) {
			send() {}
			abort() {}
		})(name, "Codex");
		s.engine = "codex";
		return s;
	};
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	ex("model gpt-5-codex");
	ex("effort xhigh");
	assert.match(app.message, /effort for new Codex agents: xhigh/);
	app.startAgent("fix it");
	assert.equal(made[0].model, "gpt-5-codex");
	assert.equal(made[0].effort, "xhigh");
});

test("config: [engines.<id>] effort, and pi's own", () => {
	const file = path.join(tmp, "config.toml");
	fs.writeFileSync(file, `[engines.claude]\neffort = "max"\n[engines.pi]\nmodel = "openai/gpt-5"\neffort = "high"\n[engines.codex]\neffort = "turbo"\n`);
	const { config, warnings } = loadConfig(file);
	assert.equal(config.engines.claude.effort, "max");
	assert.deepEqual(config.engines.pi, { model: "openai/gpt-5", effort: "high" });
	assert.deepEqual(warnings, ["config [engines.codex]: 'effort' should be one of minimal, low, medium, high, xhigh, max, ultra"]);
});

const CODEX_CATALOG = JSON.stringify({
	models: [
		{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence.", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] },
		{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
		{ slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", supported_reasoning_levels: [] },
	],
});

test("Codex's models and efforts come from `codex debug models`", async () => {
	const models = parseCodexModels(CODEX_CATALOG);
	assert.deepEqual(models.map((m) => m.slug), ["gpt-6-astra", "gpt-5.5"], "hidden models are left out");
	assert.deepEqual(models[0].efforts, ["low", "high", "ultra"]);
	assert.deepEqual(parseCodexModels("not json"), []);

	// a fake codex on PATH that prints the catalog
	const dir = path.join(tmp, "codex-bin");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "codex"), `#!${process.execPath}\nif (process.argv.slice(2).join(" ") === "debug models") process.stdout.write(${JSON.stringify(CODEX_CATALOG)});\n`);
	fs.chmodSync(path.join(dir, "codex"), 0o755);
	const env = { PATH: dir };
	const list = await modelChoices("codex", env);
	assert.deepEqual(list.map((c) => c.value), ["default", "gpt-6-astra", "gpt-5.5"]);
	assert.equal(list[1].note, "GPT-6-Astra · Frontier intelligence.");
	assert.deepEqual((await effortChoicesFor("codex", "gpt-6-astra", env)).map((c) => c.value), ["default", "low", "high", "ultra"], "the model's own levels");
	assert.deepEqual((await effortChoicesFor("codex", undefined, env)).map((c) => c.value), ["default", "low", "medium", "high", "ultra"], "Codex's default model: all its levels");
	assert.deepEqual((await effortChoicesFor("codex", undefined, { PATH: "" })).map((c) => c.value), effortChoices("codex").map((c) => c.value), "no Codex: the usual list");
});

test("the picker: Esc ends a search, then drops the filter, then closes", async () => {
	const tui = { requestRender() {}, showOverlay: (c) => (shown.push(c), { hide: () => hidden.push(c) }) };
	const shown = [];
	const hidden = [];
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.defaultEngine = () => "claude";
	[":", ..."model", "\r"].forEach((k) => app.handleInput(k));
	await tick();
	const p = shown.at(-1);
	for (const k of "/hai") p.handleInput(k);
	assert.match(plain(p.render(70)), /haiku/);
	assert.doesNotMatch(plain(p.render(70)), /opus/);
	p.handleInput("\x1b");
	assert.match(plain(p.render(70)), /\/hai/, "out of the search, the filter stays");
	assert.match(plain(p.render(70)), /j\/k move/);
	p.handleInput("\x1b");
	assert.match(plain(p.render(70)), /opus/, "the filter is gone");
	assert.equal(hidden.length, 0);
	p.handleInput("q");
	assert.equal(hidden.length, 1, "q closes");
});

test(":engine picks the engine new agents run on, shows what's ready, and leaves open agents alone", async () => {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.defaultEngine = () => (app.preferredEngine === "auto" ? "pi" : app.preferredEngine);
	app.setEngines([
		{ id: "pi", name: "pi", installed: true, connected: true, detail: "" },
		{ id: "claude", name: "Claude Code", installed: true, connected: true, detail: "" },
		{ id: "codex", name: "Codex", installed: true, connected: false, detail: "", connect: "codex login" },
		{ id: "opencode", name: "OpenCode", installed: false, connected: false, detail: "" },
	]);
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	ex("engine");
	await tick();
	const picker = overlays.at(-1);
	const screen = plain(picker.render(80));
	assert.match(screen, /Engine for new agents/);
	assert.match(screen, /● auto +pick for me \(now pi\)/);
	assert.match(screen, /claude +Claude Code · ready/);
	assert.match(screen, /codex +Codex · not signed in: codex login/);
	assert.match(screen, /opencode +OpenCode · not installed/);
	picker.handleInput("j");
	picker.handleInput("j");
	picker.handleInput("\r");
	assert.equal(app.preferredEngine, "claude");
	assert.match(app.message, /new agents run on Claude Code/);

	// an open pi agent keeps pi; the message says how to get one on the new engine
	const s = new CliSession("old", "claude", undefined, { cwd: tmp, bin: "/nonexistent" });
	s.engine = "pi";
	app.addSession(s, true);
	ex("engine codex");
	assert.equal(app.preferredEngine, "codex");
	assert.match(app.message, /new agents run on Codex \(not signed in: run codex login\)/);
	assert.match(app.message, /'old' stays on pi; :new <task> starts one on Codex/);
	ex("engine gpt");
	assert.match(app.message, /engines: auto, pi, claude, codex, opencode/);
	assert.equal(app.preferredEngine, "codex");
	s.dispose();
});
