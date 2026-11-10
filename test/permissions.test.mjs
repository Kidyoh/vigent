import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { allowRule, allowRules, CLI_ADAPTERS, CliSession, commandPrograms, describeDenial } from "../dist/cli-engines.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-permissions-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const init = { type: "system", subtype: "init", session_id: "s-1", model: "claude-fable-5" };
const blocked = {
	type: "result",
	subtype: "success",
	is_error: false,
	result: "I couldn't run gh.",
	session_id: "s-1",
	permission_denials: [
		{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "gh pr view 12 --json title" } },
		{ tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "GH_PAGER= gh pr checks 12" } },
		{ tool_name: "WebFetch", tool_use_id: "t3", tool_input: { url: "https://example.com" } },
	],
};
const done = { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-1" };

/**
 * A fake Claude Code: refused until it's run with --allowedTools, then fine.
 * Every command line goes to a log.
 */
function fakeClaude(name) {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	const log = path.join(dir, "argv.log");
	const file = path.join(dir, "claude");
	fs.writeFileSync(
		file,
		`#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const allowed = argv.includes("--allowedTools");
for (const e of [${JSON.stringify(init)}, allowed ? ${JSON.stringify(done)} : ${JSON.stringify(blocked)}]) console.log(JSON.stringify(e));
`,
	);
	fs.chmodSync(file, 0o755);
	return { bin: file, calls: () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) };
}

function settle(s) {
	return new Promise((resolve) => {
		const off = s.onChange(() => {
			if (s.state === "idle" || s.state === "error") {
				off();
				resolve();
			}
		});
	});
}

test("a refused call becomes a permission rule: the program for a command, the tool's name otherwise", () => {
	assert.equal(allowRule({ name: "Bash", input: { command: "gh pr view 12" } }), "Bash(gh:*)");
	assert.equal(allowRule({ name: "Bash", input: { command: "  FOO=1 BAR=2 cargo test --all" } }), "Bash(cargo:*)");
	assert.equal(allowRule({ name: "Bash", input: { command: "$(evil)" } }), "Bash(evil:*)", "what $(...) runs is a program too");
	assert.equal(allowRule({ name: "Bash", input: { command: "   " } }), "Bash");
	assert.equal(allowRule({ name: "WebFetch", input: { url: "https://x.dev" } }), "WebFetch");
	assert.equal(describeDenial({ name: "Bash", input: { command: "gh  pr\nview 12" } }), "gh pr view 12");
	assert.equal(describeDenial({ name: "WebFetch", input: { url: "https://x.dev" } }), "WebFetch https://x.dev");
});

test("Claude Code's permission_denials are read from its result", () => {
	const evs = CLI_ADAPTERS.claude.parser()(blocked);
	const denied = evs.find((e) => e.type === "denied");
	assert.equal(denied.tools.length, 3);
	assert.deepEqual(denied.tools[0], { name: "Bash", input: { command: "gh pr view 12 --json title" } });
	assert.ok(evs.at(-1).type === "done" && evs.at(-1).ok);
	assert.equal(CLI_ADAPTERS.claude.parser()(done).find((e) => e.type === "denied"), undefined);
});

test("allow rules from config go to every run as --allowedTools", async () => {
	const fake = fakeClaude("allow");
	const s = new CliSession("a", "claude", undefined, { cwd: tmp, bin: fake.bin, allow: () => ["Bash(gh:*)"] });
	s.send("check the PR");
	await settle(s);
	const argv = fake.calls()[0];
	assert.deepEqual(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 2), ["--allowedTools", "Bash(gh:*)"]);
	assert.ok(argv.indexOf("--allowedTools") < argv.indexOf("--"), "before the prompt");
	s.dispose();
});

test("without ask (the default): a refused tool is said, with how to allow it; nothing is asked", async () => {
	const fake = fakeClaude("off");
	const s = new CliSession("b", "claude", undefined, { cwd: tmp, bin: fake.bin });
	let asked = 0;
	s.approver = async () => {
		asked++;
		return "once";
	};
	assert.equal(s.asksToAllow, false);
	s.send("check the PR");
	await settle(s);
	assert.equal(asked, 0);
	assert.equal(fake.calls().length, 1);
	const info = s.items.filter((i) => i.kind === "info").map((i) => i.text);
	assert.ok(info.some((t) => /blocked by Claude Code's permissions: gh pr view 12 --json title · GH_PAGER= gh pr checks 12 · WebFetch https:\/\/example.com/.test(t)), info.join("\n"));
	assert.ok(info.some((t) => t.includes(":permissions allow Bash(gh:*) WebFetch, then ask it to try again") && t.includes("next prompt")), info.join("\n"));
	s.dispose();
});

test("with ask: allow once retries with the rules for that run only, and resumes the conversation", async () => {
	const fake = fakeClaude("once");
	const s = new CliSession("c", "claude", undefined, { cwd: tmp, bin: fake.bin, ask: true });
	const seen = [];
	s.approver = async (denied, rules) => {
		seen.push({ state: s.state, n: denied.length, rules });
		return "once";
	};
	s.send("check the PR");
	await settle(s);
	assert.deepEqual(seen, [{ state: "waiting", n: 3, rules: ["Bash(gh:*)", "WebFetch"] }]);
	const calls = fake.calls();
	assert.equal(calls.length, 2);
	assert.ok(!calls[0].includes("--allowedTools"));
	const retry = calls[1];
	assert.deepEqual(retry.slice(retry.indexOf("--allowedTools"), retry.indexOf("--allowedTools") + 3), ["--allowedTools", "Bash(gh:*)", "WebFetch"]);
	assert.deepEqual(retry.slice(-4, -1), ["--resume", "s-1", "--"]);
	assert.match(retry.at(-1), /permission to use Bash\(gh:\*\), WebFetch/);
	assert.deepEqual(s.items.filter((i) => i.kind === "user").map((i) => i.text), ["check the PR"], "the retry isn't shown as your prompt");
	assert.ok(s.items.some((i) => i.kind === "info" && i.text === "allowed once: Bash(gh:*), WebFetch · retrying"));
	assert.equal(s.state, "idle");

	// once means once: the next prompt runs without them
	s.send("now merge it");
	await settle(s);
	assert.equal(fake.calls().length, 4, "refused again, asked again, retried");
	s.dispose();
});

test("with ask: always allow keeps the rules; no leaves it blocked", async () => {
	const fake = fakeClaude("always");
	const kept = [];
	const s = new CliSession("d", "claude", undefined, { cwd: tmp, bin: fake.bin, ask: true, onAlwaysAllow: (r) => kept.push(...r) });
	s.approver = async () => "always";
	s.send("check the PR");
	await settle(s);
	assert.deepEqual(kept, ["Bash(gh:*)", "WebFetch"]);
	assert.ok(s.items.some((i) => i.kind === "info" && i.text.startsWith("always allowed: ")));

	const no = fakeClaude("no");
	const n = new CliSession("e", "claude", undefined, { cwd: tmp, bin: no.bin, ask: true });
	n.approver = async () => undefined;
	n.send("check the PR");
	await settle(n);
	assert.equal(no.calls().length, 1);
	assert.equal(n.items.at(-1).text, "left blocked");
	assert.equal(n.state, "idle");
	s.dispose();
	n.dispose();
});

test("config: [engines.claude] allow and ask; they're Claude Code's only", async () => {
	const { loadConfig } = await import("../dist/config.js");
	const file = path.join(tmp, "config.toml");
	fs.writeFileSync(
		file,
		`[engines.claude]
allow = ["Bash(gh:*)", "Bash(cargo:*)"]
ask = true
[engines.codex]
ask = true
`,
	);
	const { config, warnings } = loadConfig(file);
	assert.deepEqual(config.engines.claude, { allow: ["Bash(gh:*)", "Bash(cargo:*)"], ask: true });
	assert.deepEqual(warnings, ["config [engines.codex]: 'ask' is for [engines.claude] (Claude Code's permission rules)"]);
	fs.writeFileSync(file, `[engines.claude]\nask = "yes"\nallow = "gh"\n`);
	assert.deepEqual(loadConfig(file).warnings, [
		"config [engines.claude]: 'ask' should be true or false",
		`config [engines.claude]: 'allow' should be a list of permission rules, e.g. ["Bash(gh:*)"]`,
	]);
});

test("the app asks in a picker: allow once / always allow / no, naming the agent and what was blocked", async () => {
	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const fake = fakeClaude("app");
	const s = new CliSession("pr", "claude", undefined, { cwd: tmp, bin: fake.bin, ask: true });
	app.addSession(s);
	assert.equal(typeof s.approver, "function", "the app answers for Claude Code agents");

	s.send("check the PR");
	while (!overlays.length) await new Promise((r) => setTimeout(r, 10));
	const plain = overlays[0].render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plain, /'pr' was blocked · gh pr view 12/);
	assert.match(plain, /allow once/);
	assert.match(plain, /always allow/);
	assert.match(plain, /saved to \[engines\.claude\] allow/);
	assert.equal(s.state, "waiting");
	overlays[0].handleInput("\r"); // the first choice: allow once
	await settle(s);
	assert.equal(fake.calls().length, 2);
	assert.ok(fake.calls()[1].includes("--allowedTools"));
	s.dispose();
});

test("chained commands: a rule for every program a pipeline, list, loop or $(...) runs", () => {
	const cases = [
		["gh run list --limit 200 --json databaseId,headSha | jq -r '.[] | select(.x)'", ["gh", "jq"]],
		['for id in 42727 409956; do gh run view $id --log-failed | grep -n "ETIMEDOUT"; done', ["gh", "grep"]],
		['echo "--- per job; still text"; gh api "repos/{owner}/{repo}/actions/jobs/129"', ["echo", "gh"]],
		["GH_PAGER= gh pr checks 12", ["gh"]],
		["cd crates && cargo test -p riftri-git 2>&1 | tail -20", ["cd", "cargo", "tail"]],
		["x=$(git rev-parse HEAD) && echo $x", ["git", "echo"]],
		["if [ -f a ]; then rm a; fi", ["rm"]],
		["while [[ -n $x ]]; do sleep 1; done", ["sleep"]],
		["npm test > out.log 2>&1 &", ["npm"]],
	];
	for (const [cmd, progs] of cases) assert.deepEqual(commandPrograms(cmd), progs, cmd);
	assert.deepEqual(allowRules({ name: "Bash", input: { command: "for id in 1 2; do gh run view $id | jq .x; done" } }), ["Bash(gh:*)", "Bash(jq:*)"], "never Bash(for:*)");
});

/** A fake Claude Code that refuses one command whatever it's run with. */
function refusingClaude(name, command) {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "claude");
	const result = { type: "result", subtype: "success", is_error: false, result: "couldn't", session_id: "s-9", permission_denials: [{ tool_name: "Bash", tool_use_id: "t", tool_input: { command } }] };
	fs.writeFileSync(file, `#!/usr/bin/env node\nfor (const e of [${JSON.stringify(init)}, ${JSON.stringify(result)}]) console.log(JSON.stringify(e));\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

test("the refused-tool message: what to allow (only what isn't yet), from the next prompt; and when it's all allowed already", async () => {
	const loop = "for id in 1 2; do gh run view $id | jq .x; done";
	let allow = ["Bash(gh:*)"];
	const s = new CliSession("loop", "claude", undefined, { cwd: tmp, bin: refusingClaude("loop", loop), allow: () => allow });
	s.send("look at the runs");
	await settle(s);
	let info = s.items.filter((i) => i.kind === "info").map((i) => i.text);
	assert.ok(info.some((t) => t.startsWith(`blocked by Claude Code's permissions: ${loop}`)), info.join("\n"));
	assert.ok(info.some((t) => /^to allow it: :permissions allow Bash\(jq:\*\), then ask it to try again \(allowing applies from its next prompt/.test(t)), `only jq is missing: ${info.join("\n")}`);

	// everything is allowed and Claude Code still refused: say so, and what does work
	allow = ["Bash(gh:*)", "Bash(jq:*)"];
	s.send("again");
	await settle(s);
	info = s.items.filter((i) => i.kind === "info").map((i) => i.text);
	assert.ok(info.some((t) => /^Bash\(gh:\*\) Bash\(jq:\*\) are allowed, and Claude Code still refused: .*bypassPermissions.*asking/.test(t)), info.join("\n"));
	s.dispose();
});

