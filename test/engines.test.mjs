import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { CLI_ADAPTERS, CliSession } from "../dist/cli-engines.js";
import { defaultEngine, detectEngines, engineEnv, onPath } from "../dist/engines.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-engines-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fixture = (name) => path.join(import.meta.dirname, "fixtures", name);
const events = (engine, name) => {
	const parse = CLI_ADAPTERS[engine].parser();
	return fs
		.readFileSync(fixture(name), "utf8")
		.trim()
		.split("\n")
		.flatMap((l) => parse(JSON.parse(l)));
};

/** A fake CLI: a node script on PATH. */
function fakeBin(dir, name, body) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

/** Wait until the session settles (idle or error) after a send. */
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

test("Claude Code: stream-json from a real run becomes the transcript", () => {
	const evs = events("claude", "claude-tool.jsonl");
	assert.deepEqual(evs[0], { type: "session", id: "3b248a3e-43fd-4fd1-98b5-f36e06e02d85" });
	assert.deepEqual(evs[1], { type: "model", model: "claude-fable-5" });
	const [started, finished, ...others] = evs.filter((e) => e.type === "tool");
	assert.equal(others.length, 0);
	assert.equal(started.name, "Write");
	assert.equal(started.summary, "", "shown when it starts, before its input is written");
	assert.equal(finished.id, started.id);
	assert.equal(finished.name, "Write");
	assert.equal(finished.summary, "/work/hello.txt");
	assert.match(evs.find((e) => e.type === "tool_result").output, /File created successfully/);
	assert.deepEqual(evs.filter((e) => e.type === "text_delta").map((e) => e.text), ["done"]);
	assert.deepEqual(evs.filter((e) => e.type === "text").map((e) => e.text), ["done"]);
	assert.deepEqual(evs.at(-1), { type: "done", ok: true });
	assert.ok(evs.find((e) => e.type === "usage").tokens > 0);

	// a subagent's messages stay out of the transcript
	const parse = CLI_ADAPTERS.claude.parser();
	assert.deepEqual(parse({ type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "inner" }] } }), []);
	assert.deepEqual(parse({ type: "result", subtype: "error_max_turns", is_error: true, result: "hit the turn limit" }).at(-1), {
		type: "done",
		ok: false,
		error: "hit the turn limit",
	});
});

test("Codex: exec --json items become tools and replies; retries are not errors", () => {
	const evs = events("codex", "codex-tool.jsonl");
	assert.deepEqual(
		evs.map((e) => (e.type === "tool" ? `tool:${e.name}:${e.summary}` : e.type === "text" ? `text:${e.text}` : e.type)),
		["session", "tool:bash:npm test", "tool_result", "tool:edit:src/cart.js", "tool_result", "text:Fixed the off-by-one in `cart.js`.", "usage", "done"],
	);
	assert.equal(evs[2].output, "1 failing\n(exit 1)");

	const failed = events("codex", "codex-unauthorized.jsonl");
	assert.equal(failed.length, 2, "the Reconnecting... retries are skipped");
	assert.equal(failed[1].ok, false);
	assert.match(failed[1].error, /^unexpected status 401 Unauthorized/);
});

test("OpenCode: run --format json", () => {
	const evs = events("opencode", "opencode-tool.jsonl");
	assert.deepEqual(evs[0], { type: "session", id: "ses_e4b13245fffeWLL1J14R855Rfg" });
	assert.deepEqual(evs[1], { type: "tool", id: "call_1", name: "bash", summary: "npm test" });
	assert.equal(evs[2].output, "1 failing\n");
	assert.deepEqual(evs[3], { type: "text", text: "The cart test fails on an empty cart." });
	assert.deepEqual(evs[4], { type: "usage", tokens: 1240, cost: 0 });
	const err = events("opencode", "opencode-error.jsonl");
	assert.equal(err[1].type, "error");
	assert.match(err[1].message, /security token included in the request is invalid/);
});

test("each CLI's command line: fresh, resumed, with a model; the prompt always comes last", () => {
	const cwd = "/repo-worktrees/fix-race";
	assert.deepEqual(CLI_ADAPTERS.claude.args("-fix it", { cwd }), [
		"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--permission-mode", "acceptEdits", "--", "-fix it",
	]);
	assert.deepEqual(CLI_ADAPTERS.claude.args("go", { cwd, model: "opus", resumeId: "abc", extraArgs: ["--permission-mode", "plan"] }).slice(5), [
		"--permission-mode", "plan", "--model", "opus", "--resume", "abc", "--", "go",
	]);
	assert.deepEqual(CLI_ADAPTERS.codex.args("go", { cwd }), ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "--", "go"]);
	assert.deepEqual(CLI_ADAPTERS.codex.args("go", { cwd, resumeId: "t1", model: "gpt-5" }), [
		"exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-m", "gpt-5", "t1", "--", "go",
	]);
	assert.deepEqual(CLI_ADAPTERS.opencode.args("go", { cwd, resumeId: "ses_1", model: "anthropic/claude-sonnet-4-5" }), [
		"run", "--format", "json", "--dir", cwd, "-m", "anthropic/claude-sonnet-4-5", "--session", "ses_1", "--", "go",
	]);
});

test("detection: installed? signed in? (runs only the CLIs' version and status commands)", async () => {
	const bin = path.join(tmp, "detect-bin");
	fakeBin(bin, "claude", `
const a = process.argv.slice(2).join(" ");
if (a === "--version") console.log("2.1.319 (Claude Code)");
else if (a === "auth status --json") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));`);
	fakeBin(bin, "codex", `
const a = process.argv.slice(2).join(" ");
if (a === "--version") console.log("codex-cli 0.167.0");
else if (a === "login status") { console.error("Not logged in"); process.exit(1); }`);
	const home = path.join(tmp, "home");
	fs.mkdirSync(home, { recursive: true });
	const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, HOME: home };

	const engines = await detectEngines(env, 5000);
	const by = Object.fromEntries(engines.map((e) => [e.id, e]));
	assert.deepEqual(engines.map((e) => e.id), ["pi", "claude", "codex", "opencode", "gemini", "cursor"]);
	assert.deepEqual([by.gemini.installed, by.gemini.install], [false, "npm install -g @google/gemini-cli"]);
	assert.deepEqual([by.cursor.installed, by.cursor.connect], [false, "cursor-agent login"]);
	assert.deepEqual([by.pi.installed, by.pi.connected, by.pi.detail, by.pi.install], [false, false, "not installed", "npm install -g @mariozechner/pi-coding-agent"], "pi is your own install, like the others");
	assert.deepEqual(
		[by.claude.installed, by.claude.connected, by.claude.version, by.claude.detail],
		[true, true, "2.1.319", "signed in (Claude account)"],
	);
	assert.deepEqual([by.codex.installed, by.codex.connected, by.codex.connect], [true, false, "codex login"]);
	assert.deepEqual([by.opencode.installed, by.opencode.connected, by.opencode.detail], [false, false, "not installed"]);
	assert.equal(by.opencode.install, "npm install -g opencode-ai");

	assert.equal(defaultEngine(engines), "claude", "the first signed-in engine");
	assert.equal(defaultEngine(undefined, env), "claude", "before the checks finish: the first one installed");
	assert.equal(defaultEngine(undefined, { ...env, OPENAI_API_KEY: "x" }), "claude", "an installed CLI before pi, even when pi has a key");
	assert.equal(defaultEngine(undefined, { PATH: "", HOME: home, OPENAI_API_KEY: "x" }), "pi", "pi when no CLI is installed");
	assert.equal(onPath("codex", env), true);
	assert.equal(onPath("opencode", env), false);

	const piBin = path.join(tmp, "pi-bin");
	fakeBin(piBin, "pi", "");
	const pi = (await detectEngines({ PATH: piBin, HOME: home, GEMINI_API_KEY: "x" }, 5000))[0];
	assert.deepEqual([pi.installed, pi.connected, pi.detail], [true, true, "using GEMINI_API_KEY"]);
	const noKey = (await detectEngines({ PATH: piBin, HOME: home }, 5000))[0];
	assert.deepEqual([noKey.installed, noKey.connected], [true, false]);
	assert.match(noKey.connect, /ANTHROPIC_API_KEY.*\/login/);
});

test("auto: a signed-in CLI before pi, pi only when no CLI is ready", () => {
	const e = (id, over = {}) => ({ id, name: id, installed: true, connected: false, detail: "", ...over });
	const none = { installed: false };
	const pick = (pi, claude, codex, opencode = none) => defaultEngine([e("pi", pi), e("claude", claude), e("codex", codex), e("opencode", opencode)]);

	assert.equal(pick({ connected: true }, { connected: true }, {}), "claude", "ANTHROPIC_API_KEY set and Claude Code signed in: Claude Code");
	assert.equal(pick({ connected: true }, {}, { connected: true }), "codex", "Claude Code not signed in, Codex is: Codex");
	assert.equal(pick({ connected: true }, { checking: true }, none), "claude", "at startup, while sign-in checks run: the installed CLI, not pi");
	assert.equal(pick({ connected: true }, {}, {}), "pi", "no CLI signed in: pi with its key");
	assert.equal(pick({}, {}, {}), "claude", "nothing ready: the first installed CLI (starting an agent then says how to sign in)");
	assert.equal(pick({}, none, none), "pi", "nothing installed: pi");
});

test("a CLI agent: streams the reply, keeps the conversation id, resumes with it", async () => {
	const log = path.join(tmp, "claude-argv.log");
	const claude = fakeBin(path.join(tmp, "run-bin"), "claude", `
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(fixture("claude-tool.jsonl"))}, "utf8"));`);
	const cwd = fs.mkdtempSync(path.join(tmp, "wt-"));
	const ids = [];
	const s = new CliSession("racer", "claude", undefined, { cwd, bin: claude, onResumeId: (id) => ids.push(id) });
	assert.equal(s.engine, "claude");
	assert.equal(s.model, "Claude Code", "until the CLI says which model it uses");

	s.send("write hello.txt");
	await settle(s);
	assert.equal(s.state, "idle");
	assert.equal(s.model, "claude-fable-5");
	assert.deepEqual(
		s.items.map((i) => `${i.kind}:${i.tool ? `${i.tool.name} ${i.tool.summary}` : i.text}`),
		["user:write hello.txt", "tool:Write /work/hello.txt", "agent:done"],
	);
	assert.match(s.items[1].tool.output, /File created/);
	assert.ok(s.tokens > 0);
	assert.deepEqual(ids, ["3b248a3e-43fd-4fd1-98b5-f36e06e02d85"]);

	s.send("again");
	await settle(s);
	const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(calls.length, 2);
	assert.equal(fs.realpathSync(calls[0].cwd), fs.realpathSync(cwd), "runs in the agent's worktree");
	assert.ok(!calls[0].argv.includes("--resume"));
	assert.deepEqual(calls[1].argv.slice(-4), ["--resume", "3b248a3e-43fd-4fd1-98b5-f36e06e02d85", "--", "again"]);
	assert.equal(s.tree(), undefined, "the CLI keeps the conversation; there's no :tree for it");
	s.dispose();
});

/** A stand-in Claude Code that does what the real one does after a reply: summarizes the turn for a while, then reports the result and exits. */
function tailingClaude(name, { more = false } = {}) {
	const log = path.join(tmp, `${name}.log`);
	const bin = fakeBin(path.join(tmp, name), "claude", `
const fs = require("fs");
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, "start " + Date.now() + "\\n");
const say = (o) => console.log(JSON.stringify(o));
const reply = (text) => {
	say({ type: "stream_event", event: { type: "message_start", message: {} } });
	say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
	say({ type: "assistant", uuid: "m-" + text, message: { content: [{ type: "text", text }] } });
	say({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
};
say({ type: "system", subtype: "init", session_id: "s1", model: "m" });
reply("ok");
// a Stop hook can send the turn on after its reply
if (${more}) setTimeout(() => reply("one more thing"), 300);
setTimeout(() => {
	say({ type: "system", subtype: "post_turn_summary", status_category: "completed" });
	say({ type: "result", subtype: "success", is_error: false, session_id: "s1", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
	fs.appendFileSync(log, "exit " + Date.now() + "\\n");
}, ${more} ? 600 : 800);`);
	return { bin, events: () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")) };
}

const until = async (ok) => {
	while (!ok()) await new Promise((r) => setTimeout(r, 10));
};

test("Claude Code: the agent is done when its reply ends, not when the CLI exits after summarizing the turn", async () => {
	const { bin, events } = tailingClaude("tail-bin");
	const s = new CliSession("t", "claude", undefined, { cwd: tmp, bin });
	s.send("hi");
	await settle(s);
	assert.equal(s.state, "idle");
	assert.equal(s.items.at(-1).text, "ok");
	assert.deepEqual(events().map(([k]) => k), ["start"], "done while Claude Code is still summarizing");
	assert.equal(s.finishing, true);
	assert.equal(s.tokens, 0, "its usage comes with the result, at the end");

	// a prompt sent now waits for that run to exit, so two runs never share the conversation
	s.send("next");
	assert.equal(s.state, "running");
	await settle(s);
	const [first, exit, second] = events();
	assert.deepEqual([first[0], exit[0], second?.[0]], ["start", "exit", "start"]);
	assert.ok(Number(second[1]) >= Number(exit[1]), "the next run starts after the last one exited");
	assert.equal(s.tokens, 15, "the first run's usage counted when it exited");
	await until(() => !s.finishing);
	assert.equal(s.tokens, 30);
	assert.equal(s.state, "idle");
	s.dispose();
});

test("Claude Code: a turn that goes on after its reply (a Stop hook) is running again until it really ends", async () => {
	const { bin } = tailingClaude("more-bin", { more: true });
	const s = new CliSession("t", "claude", undefined, { cwd: tmp, bin });
	const states = [s.state];
	s.onChange(() => states.at(-1) !== s.state && states.push(s.state));
	s.send("hi");
	await until(() => s.items.some((i) => i.text === "one more thing"));
	await settle(s);
	await until(() => !s.finishing);
	assert.deepEqual(states, ["idle", "running", "idle", "running", "idle"]);
	assert.deepEqual(s.items.filter((i) => i.kind === "agent").map((i) => i.text), ["ok", "one more thing"]);
	s.dispose();
});

test("a CLI agent that fails says why; one that's stopped goes idle", async () => {
	const dir = path.join(tmp, "fail-bin");
	const codex = fakeBin(dir, "codex", `
process.stdout.write(require("fs").readFileSync(${JSON.stringify(fixture("codex-unauthorized.jsonl"))}, "utf8"));
process.exit(1);`);
	const s = new CliSession("c", "codex", "gpt-5", { cwd: tmp, bin: codex });
	s.send("hi");
	await settle(s);
	assert.equal(s.state, "error");
	assert.match(s.items.at(-1).text, /^error: Codex: unexpected status 401 Unauthorized/);
	assert.equal(s.model, "gpt-5");

	const crash = fakeBin(dir, "opencode", `console.error("Error: no provider configured"); process.exit(2);`);
	const o = new CliSession("o", "opencode", undefined, { cwd: tmp, bin: crash });
	o.send("hi");
	await settle(o);
	assert.equal(o.items.at(-1).text, "error: OpenCode: Error: no provider configured");

	const missing = new CliSession("m", "claude", undefined, { cwd: tmp, bin: path.join(dir, "nope") });
	missing.send("hi");
	await settle(missing);
	assert.match(missing.items.at(-1).text, /isn't installed .*:checkhealth/);

	const pidFile = path.join(dir, "slow.pid");
	const slow = fakeBin(dir, "claude", `
require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" }));
setTimeout(() => {}, 60000);`);
	const a = new CliSession("a", "claude", undefined, { cwd: tmp, bin: slow });
	a.send("long task");
	// the CLI is up once it has said which conversation it's in, however long it took to start
	await until(() => a.resumeId === "s1");
	assert.equal(a.state, "running");
	const pid = Number(fs.readFileSync(pidFile, "utf8"));
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	// the first change after the stopped CLI has exited is the session handling that exit
	const handledExit = new Promise((resolve) => {
		const off = a.onChange(() => {
			if (!alive()) {
				off();
				resolve();
			}
		});
	});
	a.abort();
	assert.equal(a.state, "idle");
	await handledExit;
	assert.equal(a.state, "idle", "the stopped run doesn't turn into an error");
});

test("the app: engines in the sidebar and intro, :checkhealth, :new --engine", async () => {
	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { Session } = await import("../dist/session.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const engines = [
		{ id: "pi", name: "pi", installed: true, connected: false, detail: "built in · no API key found", connect: "export ANTHROPIC_API_KEY=…" },
		{ id: "claude", name: "Claude Code", installed: true, connected: true, version: "2.1.319", detail: "signed in (Claude account)" },
		{ id: "codex", name: "Codex", installed: true, connected: false, version: "0.167.0", detail: "not signed in", connect: "codex login" },
		{ id: "opencode", name: "OpenCode", installed: false, connected: false, detail: "not installed", install: "npm install -g opencode-ai" },
	];
	app.defaultEngine = () => "claude";
	app.setEngines(engines);
	const made = [];
	app.newSession = (name, opts) => {
		made.push({ name, ...opts });
		const s = new (class extends Session {
			send() {}
			abort() {}
		})(name, "Claude Code");
		s.engine = opts.engine;
		return s;
	};
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	let screen = plain(app.render(120));
	assert.match(screen, /ENGINES +1\/4/);
	assert.match(screen, /● Claude Code +default/);
	assert.match(screen, /◐ Codex +codex login/);
	assert.match(screen, /○ OpenCode +not installed/);
	assert.match(screen, /◐ pi {3}● Claude Code {3}◐ Codex {3}○ OpenCode/, "the intro screen lists them too");
	assert.match(screen, /◐ pi +no API key/);

	ex("checkhealth");
	const health = plain(overlays.at(-1).render(100));
	assert.match(health, /● Claude Code {2}2\.1\.319 {2}\(default for :new\)/);
	assert.match(health, /OK signed in \(Claude account\)/);
	assert.match(health, /connect: codex login/);
	assert.match(health, /install: npm install -g opencode-ai/);
	assert.match(health, /never reads credentials/);

	ex("new fix the race --engine opencode");
	assert.match(app.message, /OpenCode isn't installed: npm install -g opencode-ai/);
	ex("new fix the race --engine nope");
	assert.match(app.message, /unknown engine 'nope'/);
	ex("new fix the race --engine codex --model gpt-5");
	assert.deepEqual(made.at(-1), { name: "fix the race", worktree: true, model: "gpt-5", engine: "codex" });
	assert.match(app.message, /'fix the race' · Codex in this checkout/);
	ex("new add retries");
	assert.equal(made.at(-1).engine, "claude", "the default engine");

	screen = plain(app.render(120));
	assert.match(screen, /▸ add retries {2}Claude Code/, "winbar names the engine");
});

test("config: engine and [engines.<cli>]", async () => {
	const { loadConfig } = await import("../dist/config.js");
	const file = path.join(tmp, "config.toml");
	fs.writeFileSync(
		file,
		`engine = "codex"
[engines.claude]
args = ["--permission-mode", "plan"]
model = "opus"
[engines.codex]
model = 5
[engines.nope]
`,
	);
	const { config, warnings } = loadConfig(file);
	assert.equal(config.engine, "codex");
	assert.deepEqual(config.engines.claude, { args: ["--permission-mode", "plan"], model: "opus" });
	assert.deepEqual(warnings, ["config [engines.codex]: 'model' should be a string", "config: unknown engine [engines.nope] (pi, claude, codex, opencode, gemini, cursor, or give it a command = [...] to add your own)"]);
	fs.writeFileSync(file, `engine = "gpt"\n`);
	assert.match(loadConfig(file).warnings[0], /'engine' should be "auto", "pi"/);
});

test("Claude Code with a Claude account and ANTHROPIC_API_KEY: vigent leaves the key out, so the account is used", async () => {
	const dir = path.join(tmp, "claude-key-bin");
	const log = path.join(tmp, "claude-key.log");
	// like the real one: the key in the environment wins over the account in auth status, and in runs
	const claude = fakeBin(dir, "claude", `
const a = process.argv.slice(2).join(" ");
const key = process.env.ANTHROPIC_API_KEY;
if (a === "--version") console.log("2.1.319 (Claude Code)");
else if (a === "auth status --json") console.log(JSON.stringify(key ? { loggedIn: true, authMethod: "oauth_token", apiKeySource: "ANTHROPIC_API_KEY" } : ${"process.env.NO_ACCOUNT ? { loggedIn: false } : { loggedIn: true, authMethod: \"oauth_token\" }"}));
else {
  require("fs").appendFileSync(${JSON.stringify(log)}, (key ? "with-key" : "no-key") + "\\n");
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: "system", subtype: "init", session_id: "s1", model: "m" });
  say({ type: "assistant", message: { content: [{ type: "text", text: key ? "API Error: 400 not scoped to a workspace" : "hello" }] } });
  say({ type: "result", subtype: "success", is_error: false, session_id: "s1", usage: {} });
}`);
	const base = { PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}`, HOME: path.join(tmp, "home") };

	const both = (await detectEngines({ ...base, ANTHROPIC_API_KEY: "sk-ant-unscoped" }, 5000)).find((e) => e.id === "claude");
	assert.equal(both.detail, "signed in (Claude account; ANTHROPIC_API_KEY left out)");
	assert.deepEqual(both.dropEnv, ["ANTHROPIC_API_KEY"]);
	const env = engineEnv(both, { ...base, ANTHROPIC_API_KEY: "sk-ant-unscoped" });
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.PATH, base.PATH, "everything else stays");

	// the agent's runs get that environment, asked at each run
	const s = new CliSession("hi", "claude", undefined, { cwd: tmp, bin: claude, env: () => env });
	s.send("hello");
	await settle(s);
	assert.equal(fs.readFileSync(log, "utf8").trim(), "no-key");
	assert.ok(s.items.some((i) => i.kind === "agent" && i.text === "hello"));
	s.dispose();

	// only a key, no account: the key is how it signs in, so it stays
	const keyOnly = (await detectEngines({ ...base, ANTHROPIC_API_KEY: "sk-ant-x", NO_ACCOUNT: "1" }, 5000)).find((e) => e.id === "claude");
	assert.equal(keyOnly.detail, "signed in (API key)");
	assert.equal(keyOnly.dropEnv, undefined);
	assert.equal(engineEnv(keyOnly, { ANTHROPIC_API_KEY: "sk-ant-x" }).ANTHROPIC_API_KEY, "sk-ant-x");
});
