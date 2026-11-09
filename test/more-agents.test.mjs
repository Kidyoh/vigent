/**
 * Gemini CLI and Cursor CLI as built-in engines: their headless JSON
 * (fixtures follow each CLI's documented stream-json events), resuming,
 * detection, and the arguments vigent passes.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { modelChoices } from "../dist/choices.js";
import { CLI_ADAPTERS, CliSession } from "../dist/cli-engines.js";
import { defaultEngine, detectEngines, quickEngines } from "../dist/engines.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-agents-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fixture = (name) => path.join(import.meta.dirname, "fixtures", name);
const fakeBin = (dir, name, body) => {
	fs.mkdirSync(dir, { recursive: true });
	const f = path.join(dir, name);
	fs.writeFileSync(f, `#!${process.execPath}\n${body}\n`);
	fs.chmodSync(f, 0o755);
	return f;
};
/** a CLI that logs how it was called and prints a fixture */
const recorder = (name, fixtureName, extra = "") => {
	const log = path.join(tmp, `${name}.log`);
	const bin = fakeBin(path.join(tmp, `${name}-bin`), name, `
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
${extra}
process.stdout.write(fs.readFileSync(${JSON.stringify(fixture(fixtureName))}, "utf8"));`);
	const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	return { bin, calls };
};
const settle = async (s) => {
	for (let i = 0; i < 300 && s.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
};

test("Gemini CLI: stream-json becomes the transcript; the session id resumes the conversation", async () => {
	const { bin, calls } = recorder("gemini", "gemini-stream.jsonl");
	const cwd = fs.mkdtempSync(path.join(tmp, "wt-"));
	const ids = [];
	const s = new CliSession("badge", "gemini", undefined, { cwd, bin, onResumeId: (id) => ids.push(id) });
	assert.equal(s.model, "Gemini CLI");
	s.send("why is the badge wrong?");
	await settle(s);
	assert.equal(s.state, "idle");
	assert.equal(s.model, "gemini-2.5-pro", "init names the model");
	assert.deepEqual(
		s.items.map((i) => [i.kind, i.kind === "tool" ? `${i.tool.name}: ${i.tool.summary} → ${i.tool.output}` : i.text]),
		[
			["user", "why is the badge wrong?"],
			["agent", "Let me look at the cart."],
			["tool", "read_file: cart.js → export const total = (items) => items.length;"],
			["tool", "run_shell_command: npm test → 1 failing"],
			["agent", "The badge counts lines; it should sum quantities."],
		],
	);
	assert.equal(s.tokens, 1234);
	assert.deepEqual(ids, ["c0ffee00-1111-2222-3333-444455556666"]);
	assert.deepEqual(calls()[0].argv, ["--output-format", "stream-json", "--approval-mode", "auto_edit", "--prompt", "why is the badge wrong?"]);
	assert.equal(calls()[0].cwd, cwd, "it runs in the agent's worktree");

	s.send("and the fix?");
	await settle(s);
	assert.deepEqual(calls()[1].argv.slice(4, 6), ["--resume", "c0ffee00-1111-2222-3333-444455556666"], "the follow-up continues the session");
});

test("Gemini CLI: a failed run says why", async () => {
	const failing = path.join(tmp, "gemini-fail.jsonl");
	fs.writeFileSync(
		failing,
		[
			{ type: "init", timestamp: "t", session_id: "s1", model: "gemini-2.5-flash" },
			{ type: "error", timestamp: "t", severity: "warning", message: "slow network" },
			{ type: "result", timestamp: "t", status: "error", error: { type: "quota", message: "Quota exceeded for gemini-2.5-pro" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n"),
	);
	const bin = fakeBin(path.join(tmp, "gemini-fail-bin"), "gemini", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(failing)}, "utf8")); process.exit(1);`);
	const s = new CliSession("q", "gemini", undefined, { cwd: tmp, bin });
	s.send("go");
	await settle(s);
	assert.equal(s.state, "error");
	assert.ok(s.items.some((i) => /Quota exceeded/.test(i.text)));
	assert.ok(!s.items.some((i) => /slow network/.test(i.text)), "warnings aren't errors");
});

test("Cursor CLI: stream-json becomes the transcript; --resume continues the chat", async () => {
	const { bin, calls } = recorder("cursor-agent", "cursor-stream.jsonl");
	const cwd = fs.mkdtempSync(path.join(tmp, "wt-"));
	const s = new CliSession("badge", "cursor", "gpt-5", { cwd, bin });
	s.send("why is the badge wrong?");
	await settle(s);
	assert.equal(s.state, "idle");
	assert.deepEqual(
		s.items.map((i) => [i.kind, i.kind === "tool" ? `${i.tool.name}: ${i.tool.summary} → ${i.tool.output}` : i.text]),
		[
			["user", "why is the badge wrong?"],
			["agent", "Reading the cart first."],
			["tool", "read: cart.js → export const total = (items) => items.length;"],
			["tool", "run_terminal_cmd: npm test → 1 passing"],
			["agent", "The badge counts lines; it should sum quantities."],
		],
	);
	assert.deepEqual(calls()[0].argv, ["--print", "--output-format", "stream-json", "--force", "--model", "gpt-5", "why is the badge wrong?"]);
	s.send("and the fix?");
	await settle(s);
	assert.deepEqual(calls()[1].argv.slice(6, 8), ["--resume", "cur-5e55-10n"]);
});

test("[engines.gemini] args replace the default approval mode; Cursor's --force too", () => {
	assert.deepEqual(CLI_ADAPTERS.gemini.args("hi", { cwd: tmp, extraArgs: ["--approval-mode", "yolo"], model: "flash" }), ["--output-format", "stream-json", "--approval-mode", "yolo", "--model", "flash", "--prompt", "hi"]);
	assert.deepEqual(CLI_ADAPTERS.cursor.args("hi", { cwd: tmp, extraArgs: [] }), ["--print", "--output-format", "stream-json", "hi"], "no --force when you say so");
});

test("detection: installed and signed in; auto picks them after Claude Code, Codex and OpenCode", async () => {
	const bin = path.join(tmp, "detect");
	fakeBin(bin, "gemini", `if (process.argv[2] === "--version") console.log("0.12.0");`);
	fakeBin(bin, "cursor-agent", `const a = process.argv.slice(2).join(" ");
if (a === "--version") console.log("2026.11.01-abc");
else if (a === "status") console.log("✓ Logged in as dev@example.com");`);
	const home = path.join(tmp, "home");
	fs.mkdirSync(home, { recursive: true });
	const env = { PATH: bin, HOME: home }; // only these two CLIs (the fakes run node by its full path)

	let by = Object.fromEntries((await detectEngines(env, 5000)).map((e) => [e.id, e]));
	assert.deepEqual([by.gemini.installed, by.gemini.connected, by.gemini.version, by.gemini.detail], [true, false, "0.12.0", "not signed in"]);
	assert.deepEqual([by.cursor.installed, by.cursor.connected, by.cursor.detail], [true, true, "signed in as dev@example.com"]);
	assert.equal(defaultEngine(Object.values(by)), "cursor", "the first signed-in one");

	fs.mkdirSync(path.join(home, ".gemini"));
	fs.writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), "{}");
	by = Object.fromEntries((await detectEngines(env, 5000)).map((e) => [e.id, e]));
	assert.deepEqual([by.gemini.connected, by.gemini.detail], [true, "signed in (Google account)"]);
	assert.equal(defaultEngine(Object.values(by)), "gemini", "Gemini CLI comes before Cursor CLI");
	by = Object.fromEntries((await detectEngines({ ...env, HOME: tmp, GEMINI_API_KEY: "x" }, 5000)).map((e) => [e.id, e]));
	assert.equal(by.gemini.detail, "using GEMINI_API_KEY");

	assert.deepEqual(
		quickEngines(env)
			.filter((e) => e.id === "gemini" || e.id === "cursor")
			.map((e) => [e.id, e.installed, e.checking]),
		[
			["gemini", true, true],
			["cursor", true, true],
		],
	);
	assert.deepEqual((await modelChoices("gemini")).map((c) => c.value), ["default", "pro", "flash", "flash-lite"]);
});
