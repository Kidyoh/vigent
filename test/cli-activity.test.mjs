import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, test } from "node:test";
import { App } from "../dist/app.js";
import { CLI_ADAPTERS, CliSession } from "../dist/cli-engines.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-activity-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fixture = (name) => path.join(import.meta.dirname, "fixtures", name);
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const unique = () => Math.random().toString(36).slice(2);

const stream = (event) => ({ type: "stream_event", event });
const started = (index, content_block) => stream({ type: "content_block_start", index, content_block });
const stopped = (index) => stream({ type: "content_block_stop", index });
const delta = (index, d) => stream({ type: "content_block_delta", index, delta: d });
const assistant = (...content) => ({ type: "assistant", message: { content } });
const result = { type: "result", subtype: "success", is_error: false, usage: {}, session_id: "s1" };

async function until(what, ok) {
	for (let i = 0; i < 1000; i++) {
		if (ok()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.fail(`timed out waiting for ${what}`);
}

/** A stand-in CLI that prints `first`, then `then` only once the test releases it, so the moment between them can be inspected. */
function stagedCli(first, then) {
	const gate = path.join(tmp, `gate-${unique()}`);
	const bin = path.join(tmp, `claude-${unique()}`);
	fs.writeFileSync(
		bin,
		`#!${process.execPath}
const fs = require("fs");
const out = (events) => process.stdout.write(events.map((e) => JSON.stringify(e) + "\\n").join(""));
out(${JSON.stringify(first)});
const wait = setInterval(() => {
	if (!fs.existsSync(${JSON.stringify(gate)})) return;
	clearInterval(wait);
	out(${JSON.stringify(then)});
}, 5);
`,
	);
	fs.chmodSync(bin, 0o755);
	return { bin, release: () => fs.writeFileSync(gate, "") };
}

// A test that fails before releasing its CLI must not leave that process keeping the runner alive.
const sessions = [];
afterEach(() => {
	for (const s of sessions.splice(0)) if (s.state === "running") s.abort();
});
function session(bin) {
	const s = new CliSession("agent", "claude", undefined, { cwd: tmp, bin });
	sessions.push(s);
	return s;
}
const tools = (s) => s.items.filter((i) => i.kind === "tool");

function screen(s) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.addSession(s, true);
	return () => plain(app.render(120));
}

test("a Claude Code tool call shows when it starts, and fills in its details when they arrive", async () => {
	const input = { file_path: "note.txt" };
	const { bin, release } = stagedCli(
		[started(0, { type: "tool_use", id: "toolu_1", name: "Read", input: {} })],
		[
			assistant({ type: "tool_use", id: "toolu_1", name: "Read", input }),
			stopped(0),
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "banana" }] } },
			result,
		],
	);
	const s = session(bin);
	s.send("read it");

	await until("the tool line", () => tools(s).length === 1);
	assert.equal(tools(s)[0].tool.name, "Read");
	assert.equal(tools(s)[0].tool.summary, "", "the input hasn't been written yet");

	release();
	await until("the run to finish", () => s.state !== "running");
	assert.equal(tools(s).length, 1, "the finished call updates the line it started");
	assert.match(tools(s)[0].tool.summary, /note\.txt/);
	assert.equal(tools(s)[0].tool.output, "banana");
});

test("a captured Claude Code run has one line per tool call and doesn't repeat its text", async () => {
	const file = fixture("claude-tool.jsonl");
	const events = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const ids = new Set(events.filter((e) => e.type === "assistant").flatMap((e) => e.message.content.filter((b) => b.type === "tool_use").map((b) => b.id)));
	const texts = events.filter((e) => e.type === "assistant").flatMap((e) => e.message.content.filter((b) => b.type === "text").map((b) => b.text));
	assert.ok(ids.size > 0, "the fixture calls a tool");

	const bin = path.join(tmp, `claude-${unique()}`);
	fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"));\n`);
	fs.chmodSync(bin, 0o755);
	const s = session(bin);
	s.send("go");
	await until("the run to finish", () => s.state !== "running");

	assert.equal(tools(s).length, ids.size);
	assert.ok(tools(s).every((t) => t.tool.summary), "every line ends with its details");
	assert.deepEqual(s.items.filter((i) => i.kind === "agent").map((i) => i.text), texts);
});

test("the pane says thinking while Claude Code has a thinking block open", async () => {
	const { bin, release } = stagedCli(
		[started(0, { type: "thinking", thinking: "" }), delta(0, { type: "thinking_delta", thinking: "hm" })],
		[
			assistant({ type: "thinking", thinking: "hm" }),
			stopped(0),
			started(1, { type: "text", text: "" }),
			delta(1, { type: "text_delta", text: "done" }),
			assistant({ type: "text", text: "done" }),
			stopped(1),
			result,
		],
	);
	const s = session(bin);
	const view = screen(s);
	s.send("think");

	await until("thinking", () => s.thinking);
	assert.match(view(), /thinking…/);

	release();
	await until("the run to finish", () => s.state !== "running");
	assert.equal(s.thinking, false);
	assert.doesNotMatch(view(), /thinking…/);
	assert.match(view(), /done/);
});

test("the pane says thinking as soon as a prompt goes out, before the CLI says anything", async () => {
	const { bin, release } = stagedCli([], [started(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "done" }), assistant({ type: "text", text: "done" }), stopped(0), result]);
	const s = session(bin);
	const view = screen(s);
	s.send("hi");

	await until("running", () => s.state === "running");
	assert.equal(s.thinking, false, "no thinking block yet");
	assert.match(view(), /thinking…/);

	release();
	await until("the run to finish", () => s.state !== "running");
	assert.doesNotMatch(view(), /thinking…/);
	assert.match(view(), /done/);
});

test("thinking clears when the CLI exits without closing the block", async () => {
	const { bin, release } = stagedCli([started(0, { type: "thinking", thinking: "" })], []);
	const s = session(bin);
	s.send("think");
	await until("thinking", () => s.thinking);
	release();
	await until("the run to end", () => s.state !== "running");
	assert.equal(s.thinking, false);
});

test("only the main agent's thinking and tools count, and other blocks closing changes nothing", () => {
	const parse = CLI_ADAPTERS.claude.parser();
	assert.deepEqual(parse({ ...started(0, { type: "thinking" }), parent_tool_use_id: "toolu_9" }), []);
	assert.deepEqual(parse({ ...started(0, { type: "tool_use", id: "t", name: "Read", input: {} }), parent_tool_use_id: "toolu_9" }), []);
	assert.deepEqual(parse(stopped(0)), [], "no thinking block was open");
	assert.deepEqual(parse(started(1, { type: "thinking" })), [{ type: "thinking", active: true }]);
	assert.deepEqual(parse(stopped(0)), [], "a different block closing doesn't end the thinking");
	assert.deepEqual(parse(stopped(1)), [{ type: "thinking", active: false }]);
});
